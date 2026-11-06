#!/usr/bin/env node

import * as commander from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import hypc from './index';
import smtchecker from './smtchecker';
import smtsolver from './smtsolver';

// hold on to any exception handlers that existed prior to this script running, we'll be adding them back at the end
const originalUncaughtExceptionListeners = process.listeners('uncaughtException');
// FIXME: remove annoying exception catcher of Emscripten
//        see https://github.com/chriseth/browser-solidity/issues/167
process.removeAllListeners('uncaughtException');

const program: any = new commander.Command();
const commanderParseInt = function (value) {
  if (!/^\d+$/.test(value)) {
    throw new commander.InvalidArgumentError('Not a valid integer.');
  }
  return parseInt(value, 10);
};

program.name('hypcjs');
program.version(hypc.version(), '-V, --version', 'Show version and exit.');
program
  .argument('[files...]', 'Source files to compile.')
  .option('--optimize', 'Enable bytecode optimizer.', false)
  .option(
    '--optimize-runs <optimize-runs>',
    'The number of runs specifies roughly how often each opcode of the deployed code will be executed across the lifetime of the contract. ' +
    'Lower values will optimize more for initial deployment cost, higher values will optimize more for high-frequency usage.',
    commanderParseInt
  )
  .option('--bin', 'Binary of the contracts in hex.')
  .option('--abi', 'ABI of the contracts.')
  .option('--standard-json', 'Turn on Standard JSON Input / Output mode.')
  .option('--base-path <path>', 'Root of the project source tree. ' +
    'The import callback will attempt to interpret all import paths as relative to this directory.'
  )
  .option('--include-path <path...>', 'Extra source directories available to the import callback. ' +
    'When using a package manager to install libraries, use this option to specify directories where packages are installed. ' +
    'Can be used multiple times to provide multiple locations.'
  )
  .option('-o, --output-dir <output-directory>', 'Output directory for the contracts.')
  .option('-p, --pretty-json', 'Pretty-print all JSON output.', false)
  .option('-v, --verbose', 'More detailed console output.', false);

program.parse(process.argv);
const options = program.opts();

const files = program.args;
const destination = options.outputDir || '.';

function abort (msg) {
  console.error(msg || 'Error occurred');
  process.exit(1);
}

function realPathIfExists (filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch (e) {
    return path.resolve(filePath);
  }
}

// As in hypc, imports may only be read from the base path (the working directory by default),
// the include paths and the directories of the files given on the command line. Symlinks are
// resolved before the check, so a link cannot point outside these directories.
// Without a base path the working directory is not allowed when it is the root of the filesystem
// (or of a drive on Windows), since that would make every readable file importable.
function defaultAllowedDirectories () {
  if (options.basePath) { return [options.basePath]; }
  const workingDirectory = realPathIfExists('.');
  return path.parse(workingDirectory).root === workingDirectory ? [] : [workingDirectory];
}

const allowedDirectories = defaultAllowedDirectories()
  .concat(options.includePath || [], files.map((file) => path.dirname(file)))
  .map(realPathIfExists);

function isInsideAllowedDirectory (filePath) {
  return allowedDirectories.some((directory) => {
    const relativePath = path.relative(directory, filePath);
    return relativePath === '' || (relativePath.split(path.sep)[0] !== '..' && !path.isAbsolute(relativePath));
  });
}

function readFileCallback (sourcePath) {
  const prefixes = [options.basePath ? options.basePath : ''].concat(
    options.includePath ? options.includePath : []
  );
  for (const prefix of prefixes) {
    const prefixedSourcePath = (prefix ? prefix + '/' : '') + sourcePath;

    if (fs.existsSync(prefixedSourcePath)) {
      if (!isInsideAllowedDirectory(fs.realpathSync(prefixedSourcePath))) {
        return { error: 'File outside of allowed directories.' };
      }
      try {
        return { contents: fs.readFileSync(prefixedSourcePath).toString('utf8') };
      } catch (e) {
        return { error: 'Error reading ' + prefixedSourcePath + ': ' + e };
      }
    }
  }
  return { error: 'File not found inside the base path or any of the include paths.' };
}

function withUnixPathSeparators (filePath) {
  // On UNIX-like systems forward slashes in paths are just a part of the file name.
  if (os.platform() !== 'win32') {
    return filePath;
  }

  return filePath.replace(/\\/g, '/');
}

function makeSourcePathRelativeIfPossible (sourcePath) {
  const absoluteBasePath = (options.basePath ? path.resolve(options.basePath) : path.resolve('.'));
  const absoluteIncludePaths = (
    options.includePath
      ? options.includePath.map((prefix) => { return path.resolve(prefix); })
      : []
  );

  // Compared to base path stripping logic in hypc this is much simpler because path.resolve()
  // handles symlinks correctly (does not resolve them except in work dir) and strips .. segments
  // from paths going beyond root (e.g. `/../../a/b/c` -> `/a/b/c/`). It's simpler also because it
  // ignores less important corner cases: drive letters are not stripped from absolute paths on
  // Windows and UNC paths are not handled in a special way (at least on Linux). Finally, it has
  // very little test coverage so there might be more differences that we are just not aware of.
  const absoluteSourcePath = path.resolve(sourcePath);

  for (const absolutePrefix of [absoluteBasePath].concat(absoluteIncludePaths)) {
    const relativeSourcePath = path.relative(absolutePrefix, absoluteSourcePath);

    if (!relativeSourcePath.startsWith('../')) { return withUnixPathSeparators(relativeSourcePath); }
  }

  // File is not located inside base path or include paths so use its absolute path.
  return withUnixPathSeparators(absoluteSourcePath);
}

function toFormattedJson (input) {
  return JSON.stringify(input, null, options.prettyJson ? 4 : 0);
}

// Input that is not valid JSON is returned as it is, so that the compiler reports it.
function reformatJsonIfRequested (inputJson) {
  if (!options.prettyJson) { return inputJson; }
  try {
    return toFormattedJson(JSON.parse(inputJson));
  } catch (e) {
    return inputJson;
  }
}

// Diagnostics go to stderr, so that stdout carries only the compiler output.
function verbose (message) {
  if (options.verbose) { console.error(message); }
}

let callbacks;
if (options.basePath || !options.standardJson) { callbacks = { import: readFileCallback }; }

if (options.standardJson) {
  const input = fs.readFileSync(process.stdin.fd).toString('utf8');
  verbose('>>> Compiling:\n' + reformatJsonIfRequested(input) + '\n');
  let output = reformatJsonIfRequested(hypc.compile(input, callbacks));

  try {
    if (smtsolver.availableSolvers.length === 0) {
      verbose('>>> Cannot retry compilation with SMT because there are no SMT solvers available.');
    } else {
      const inputJSON = smtchecker.handleSMTQueries(JSON.parse(input), JSON.parse(output), smtsolver.smtSolver, smtsolver.availableSolvers[0]);
      if (inputJSON) {
        verbose('>>> Retrying compilation with SMT:\n' + toFormattedJson(inputJSON) + '\n');
        output = reformatJsonIfRequested(hypc.compile(JSON.stringify(inputJSON), callbacks));
      }
    }
  } catch (e) {
    const addError = {
      component: 'general',
      formattedMessage: e.toString(),
      message: e.toString(),
      type: 'Warning'
    };

    const outputJSON = JSON.parse(output);
    if (!outputJSON.errors) {
      outputJSON.errors = [];
    }
    outputJSON.errors.push(addError);
    output = toFormattedJson(outputJSON);
  }

  verbose('>>> Compilation result:');
  console.log(output);
  process.exit(0);
} else if (files.length === 0) {
  console.error('Must provide a file');
  process.exit(1);
}

if (!(options.bin || options.abi)) {
  abort('Invalid option selected, must specify either --bin or --abi');
}

if (!options.basePath && options.includePath && options.includePath.length > 0) {
  abort('--include-path option requires a non-empty base path.');
}

if (options.includePath) {
  for (const includePath of options.includePath) {
    if (!includePath) { abort('Empty values are not allowed in --include-path.'); }
  }
}

const sources = {};

for (let i = 0; i < files.length; i++) {
  try {
    sources[makeSourcePathRelativeIfPossible(files[i])] = {
      content: fs.readFileSync(files[i]).toString()
    };
  } catch (e) {
    abort('Error reading ' + files[i] + ': ' + e);
  }
}

const cliInput = {
  language: 'Hyperion',
  settings: {
    optimizer: {
      enabled: options.optimize,
      runs: options.optimizeRuns
    },
    outputSelection: {
      '*': {
        '*': ['abi', 'qrvm.bytecode']
      }
    }
  },
  sources
};
verbose('>>> Compiling:\n' + toFormattedJson(cliInput) + '\n');
const output = JSON.parse(hypc.compile(JSON.stringify(cliInput), callbacks));

let hasError = false;

if (!output) {
  abort('No output from compiler');
} else if (output.errors) {
  for (const error in output.errors) {
    const message = output.errors[error];
    if (message.severity === 'warning') {
      console.log(message.formattedMessage);
    } else {
      console.error(message.formattedMessage);
      hasError = true;
    }
  }
}

fs.mkdirSync(destination, { recursive: true });

function writeFile (file, content) {
  file = path.join(destination, file);
  try {
    fs.writeFileSync(file, content);
  } catch (err) {
    console.error('Failed to write ' + file + ': ' + err);
  }
}

// Output names replace ':', '.', '/' and '\' with '_', so different contracts can map to one name.
const outputNames = new Map();

for (const fileName in output.contracts) {
  for (const contractName in output.contracts[fileName]) {
    let contractFileName = fileName + ':' + contractName;
    contractFileName = contractFileName.replace(/[:./\\]/g, '_');
    const previous = outputNames.get(contractFileName);
    if (previous) {
      console.error(`Warning: ${previous} and ${fileName}:${contractName} both write ${contractFileName}; the output of ${fileName}:${contractName} replaces the other.`);
    }
    outputNames.set(contractFileName, `${fileName}:${contractName}`);

    if (options.bin) {
      writeFile(contractFileName + '.bin', output.contracts[fileName][contractName].qrvm.bytecode.object);
    }

    if (options.abi) {
      writeFile(contractFileName + '.abi', toFormattedJson(output.contracts[fileName][contractName].abi));
    }
  }
}

// Put back original exception handlers.
originalUncaughtExceptionListeners.forEach(function (listener) {
  process.addListener('uncaughtException', listener);
});

if (hasError) {
  process.exit(1);
}

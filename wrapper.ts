import { createHash } from 'crypto';
import { https } from 'follow-redirects';
import * as fs from 'fs';
import { keccak256 } from 'js-sha3';
import * as path from 'path';

import { formatFatalError } from './formatters';
import { describeException, isNil } from './common/helpers';
import setupBindings from './bindings';
import translate from './translate';

const Module = module.constructor as any;

/**
 * Wraps an Emscripten compiler module in the hypc-js API.
 *
 * A JavaScript exception that unwinds through the compiler's wasm frames, such as the RangeError
 * of a stack overflow inside the compiler, leaves that module instance unable to compile (see
 * `guarded` in bindings/compile.ts). `compile` throws the exception, and the next compilation
 * runs on a fresh instance of the module, which `reload` returns. By default a module that
 * `require` loaded is reloaded from its file, and `loadRemoteVersion` reloads from the downloaded
 * source. Where neither applies, as in a browser or a bundle, pass a function that returns a fresh
 * module. Without one, the same instance goes on once the compiler has discarded the abandoned
 * compilation, which compilers from 0.3.0 on do in hyperion_reset(); with an older compiler, or
 * after a WebAssembly trap, the next compilation returns an error that says the module cannot be
 * used again.
 *
 * @param hypjson The Emscripten compiled Hyperion object.
 * @param reload Returns a fresh instance of the same module.
 */
function wrapper (hypjson, reload = reloaderFor(hypjson)) {
  let bindings = setupBindings(hypjson);
  const { methodFlags } = bindings;
  // Why no compilation can run any more, once that is certain: the instance cannot compile, and no
  // fresh one can be loaded.
  let unusable: string | undefined;
  // Set while the instance goes on after discarding an abandoned compilation and its next output
  // has not yet shown whether the compiler supports that; holds why it was needed.
  let recoveringInPlace: string | undefined;

  const withoutReplacement = (why) =>
    `The compiler module cannot be used again: ${why}. Load a fresh module, or pass a function that does so as the second argument of setupMethods.`;

  // The bindings of the current module instance, after an exception unwound through the previous
  // one: of a fresh instance where one can be loaded, otherwise of the same instance after asking
  // it to discard the abandoned compilation. Throws when neither is possible.
  function usableBindings () {
    if (unusable !== undefined) {
      throw new Error(unusable);
    }
    if (!bindings.poisoned) {
      return bindings;
    }
    const why = `an exception unwound through the compiler during an earlier compilation (${describeException(bindings.poisonedBy)})`;
    if (reload !== undefined) {
      try {
        bindings = setupBindings(reload());
      } catch (e) {
        throw new Error(`The compiler module cannot be used again: ${why}, and reloading it failed: ${describeException(e)}`);
      }
      return bindings;
    }
    // No fresh instance can be loaded here, as in a browser or a bundle. A JavaScript exception
    // leaves the instance's memory intact, and hyperion_reset() of compilers from 0.3.0 on
    // discards the abandoned compilation's state, so the same instance can go on; whether this
    // compiler does that shows in its next output (see compileMethod). After a trap (a
    // WebAssembly.RuntimeError, which is also what an Emscripten abort throws) the memory cannot
    // be trusted.
    if (typeof WebAssembly !== 'undefined' && bindings.poisonedBy instanceof WebAssembly.RuntimeError) {
      unusable = withoutReplacement(`${why}, and the instance cannot be reused after a WebAssembly trap`);
      throw new Error(unusable);
    }
    if (isNil(bindings.coreBindings.reset)) {
      unusable = withoutReplacement(`${why}, and this compiler has no hyperion_reset() to discard it with`);
      throw new Error(unusable);
    }
    try {
      bindings.coreBindings.reset();
    } catch (e) {
      unusable = withoutReplacement(`${why}, and hyperion_reset() failed afterwards: ${describeException(e)}`);
      throw new Error(unusable);
    }
    bindings.poisoned = false;
    bindings.poisonedBy = undefined;
    recoveringInPlace = why;
    return bindings;
  }

  // The compile method of that name, run on the current module instance, or null if the compiler
  // lacks the method.
  function compileMethod (name) {
    if (isNil(bindings.compileBindings[name])) {
      return null;
    }
    return function (...args) {
      let current;
      try {
        current = usableBindings();
      } catch (e) {
        return formatFatalError(e.message);
      }
      const output = current.compileBindings[name](...args);
      if (recoveringInPlace !== undefined) {
        const why = recoveringInPlace;
        recoveringInPlace = undefined;
        if (reportsStaleCompilerStack(output)) {
          unusable = withoutReplacement(`${why}, and this compiler's hyperion_reset() does not discard the abandoned compilation (compilers from 0.3.0 on do)`);
          return formatFatalError(unusable);
        }
      }
      return output;
    };
  }

  const compileBindings = {
    compileJson: compileMethod('compileJson'),
    compileJsonCallback: compileMethod('compileJsonCallback'),
    compileJsonMulti: compileMethod('compileJsonMulti'),
    compileStandard: compileMethod('compileStandard')
  };

  return {
    version: () => bindings.coreBindings.version(),
    semver: () => bindings.coreBindings.versionToSemver(),
    license: () => bindings.coreBindings.license(),
    lowlevel: {
      compileSingle: compileBindings.compileJson,
      compileMulti: compileBindings.compileJsonMulti,
      compileCallback: compileBindings.compileJsonCallback,
      compileStandard: compileBindings.compileStandard
    },
    features: {
      legacySingleInput: methodFlags.compileJsonStandardSupported,
      multipleInputs: methodFlags.compileJsonMultiSupported || methodFlags.compileJsonStandardSupported,
      importCallback: methodFlags.compileJsonCallbackSuppported || methodFlags.compileJsonStandardSupported,
      nativeStandardJSON: methodFlags.compileJsonStandardSupported
    },
    compile: compileStandardWrapper.bind(this, compileBindings),
    // Loads the compiler of the given version from binaries.theqrl.org instead of from the
    // local filesystem, after checking it against list.json.
    loadRemoteVersion,
    // Use this if you want to add wrapper functions around the pure module.
    setupMethods: wrapper
  };
}

// Loads the source of a compiler module as require() does, in a Module of its own that is in
// neither require.cache nor module.children, so that an instance can be dropped once it is no
// longer usable. Emscripten's Node support adds a process-wide `unhandledRejection` listener on
// every load, which would accumulate and keep every instance alive; the listeners a load adds are
// removed again.
function loadModuleSource (source: string, filename: string) {
  const events: any[] = ['uncaughtException', 'unhandledRejection'];
  const listenersBefore = events.map(event => process.listeners(event));
  try {
    const hypjson = new Module(filename);
    hypjson.filename = filename;
    hypjson.paths = Module._nodeModulePaths(path.dirname(filename));
    hypjson._compile(source, filename);
    hypjson.loaded = true;
    return hypjson.exports;
  } finally {
    events.forEach((event, i) => {
      for (const listener of process.listeners(event)) {
        if (!listenersBefore[i].includes(listener)) {
          process.removeListener(event, listener);
        }
      }
    });
  }
}

// A function that loads a fresh instance of a module that require() loaded, found through
// require.cache; undefined where there is no such record, as in a browser or a bundle.
function reloaderFor (hypjson) {
  const cache = typeof require === 'function' ? require.cache : undefined;
  if (!cache) {
    return undefined;
  }
  const record = Object.keys(cache)
    .map(key => cache[key])
    .find(entry => entry && entry.exports === hypjson && typeof entry.filename === 'string');
  if (!record) {
    return undefined;
  }
  return () => loadModuleSource(fs.readFileSync(record.filename, 'utf8'), record.filename);
}

// True if the compiler's output reports the CompilerStack of an abandoned compilation, which is
// what an instance whose hyperion_reset() did not discard it answers to every compilation.
function reportsStaleCompilerStack (output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (e) {
    return false;
  }
  const errors = parsed && parsed.errors;
  return Array.isArray(errors) && errors.some(error => {
    // Compilers before 0.4.x reported errors as strings.
    const message = typeof error === 'string' ? error : error && error.message;
    const internal = typeof error === 'string' || (error && error.type === 'InternalCompilerError');
    return internal && typeof message === 'string' && message.includes('You shall not have another CompilerStack aside me.');
  });
}

const BINARIES_HOST = 'binaries.theqrl.org';
const BINARIES_URL = `https://${BINARIES_HOST}/bin/`;
// list.json is a few kilobytes and a compiler build about 9 MB.
const MAX_LIST_BYTES = 1024 * 1024;
const MAX_BUILD_BYTES = 64 * 1024 * 1024;

// Follow redirects only to https URLs on the binaries host.
function beforeRedirect (options) {
  if (options.protocol !== 'https:' || options.hostname !== BINARIES_HOST) {
    throw new Error(`Refusing to follow a redirect to ${options.protocol}//${options.hostname}.`);
  }
}

// Calls back once, with an error or the complete body of a 200 response.
function download (url, maxBytes, callback) {
  let done = false;
  const finish = (error, body?) => {
    if (!done) {
      done = true;
      callback(error, body);
    }
  };

  https.get(url, { beforeRedirect, maxRedirects: 5 }, response => {
    if (response.statusCode !== 200) {
      response.resume();
      finish(new Error(`Error retrieving ${url}: ${response.statusCode} ${response.statusMessage}`));
      return;
    }
    const chunks = [];
    let length = 0;
    response.on('data', chunk => {
      length += chunk.length;
      if (length > maxBytes) {
        response.destroy();
        finish(new Error(`${url} is larger than ${maxBytes} bytes.`));
      } else {
        chunks.push(chunk);
      }
    });
    response.on('end', () => finish(null, Buffer.concat(chunks)));
    response.on('error', finish);
  }).on('error', finish);
}

// The list.json entry for "latest", a release such as "0.2.0", or a build such as
// "v0.2.0+commit.e36a0aea".
function findBuild (list, versionString) {
  const releases = list.releases || {};
  const buildPath = versionString === 'latest'
    ? releases[list.latestRelease]
    : releases[versionString] || `hypjson-${versionString}.js`;
  const build = (list.builds || []).find(entry => entry.path === buildPath);
  if (
    !build ||
    !/^hypjson-v[0-9A-Za-z.+-]+\.js$/.test(build.path) ||
    typeof build.keccak256 !== 'string' ||
    typeof build.sha256 !== 'string'
  ) {
    throw new Error(`Version ${versionString} is not in ${BINARIES_URL}list.json.`);
  }
  return build;
}

// Downloads a compiler build and runs it only if its keccak256 and sha256 match list.json.
function loadRemoteVersion (versionString, callback) {
  download(BINARIES_URL + 'list.json', MAX_LIST_BYTES, (listError, listBody) => {
    if (listError) {
      callback(listError);
      return;
    }
    let build;
    try {
      build = findBuild(JSON.parse(listBody.toString('utf8')), versionString);
    } catch (e) {
      callback(e);
      return;
    }

    download(BINARIES_URL + build.path, MAX_BUILD_BYTES, (error, body) => {
      if (error) {
        callback(error);
        return;
      }
      const keccak = '0x' + keccak256(body);
      const sha256 = '0x' + createHash('sha256').update(body).digest('hex');
      if (keccak !== build.keccak256.toLowerCase() || sha256 !== build.sha256.toLowerCase()) {
        callback(new Error(`${build.path} does not match the keccak256 and sha256 in list.json, so it was not run.`));
        return;
      }

      let hypc;
      try {
        // The source stays referenced so that a fresh instance can be loaded if an exception
        // unwinds through this one (see wrapper).
        const source = body.toString('utf8');
        const load = () => loadModuleSource(source, build.path);
        hypc = wrapper(load(), load);
      } catch (e) {
        callback(e);
        return;
      }
      callback(null, hypc);
    });
  });
}

// Expects a Standard JSON I/O but supports old compilers
function compileStandardWrapper (compile, inputRaw, readCallback) {
  if (!isNil(compile.compileStandard)) {
    return compile.compileStandard(inputRaw, readCallback);
  }

  let input: { language: string, sources: any[], settings: any };

  try {
    input = JSON.parse(inputRaw);
  } catch (e) {
    return formatFatalError(`Invalid JSON supplied: ${e.message}`);
  }

  if (input.language !== 'Hyperion') {
    return formatFatalError('Only "Hyperion" is supported as a language.');
  }

  // NOTE: this is deliberately `== null`
  if (isNil(input.sources) || input.sources.length === 0) {
    return formatFatalError('No input sources specified.');
  }

  const sources = translateSources(input);
  const optimize = isOptimizerEnabled(input);
  const libraries = librariesSupplied(input);

  if (isNil(sources) || Object.keys(sources).length === 0) {
    return formatFatalError('Failed to process sources.');
  }

  // Try to wrap around old versions
  if (!isNil(compile.compileJsonCallback)) {
    const inputJson = JSON.stringify({ sources });
    const output = compile.compileJsonCallback(inputJson, optimize, readCallback);
    return translateOutput(output, libraries);
  }

  if (!isNil(compile.compileJsonMulti)) {
    const output = compile.compileJsonMulti(JSON.stringify({ sources }), optimize);
    return translateOutput(output, libraries);
  }

  // Try our luck with an ancient compiler
  if (!isNil(compile.compileJson)) {
    if (Object.keys(sources).length > 1) {
      return formatFatalError('Multiple sources provided, but compiler only supports single input.');
    }

    const input = sources[Object.keys(sources)[0]];
    const output = compile.compileJson(input, optimize);
    return translateOutput(output, libraries);
  }

  return formatFatalError('Compiler does not support any known interface.');
}

function isOptimizerEnabled (input) {
  return input.settings && input.settings.optimizer && input.settings.optimizer.enabled;
}

function translateSources (input) {
  const sources = {};

  for (const source in input.sources) {
    if (input.sources[source].content !== null) {
      sources[source] = input.sources[source].content;
    } else {
      // force failure
      return null;
    }
  }

  return sources;
}

function librariesSupplied (input) {
  if (!isNil(input.settings)) return input.settings.libraries;
}

function translateOutput (outputRaw, libraries) {
  let parsedOutput;

  try {
    parsedOutput = JSON.parse(outputRaw);
  } catch (e) {
    return formatFatalError(`Compiler returned invalid JSON: ${e.message}`);
  }

  const output = translate.translateJsonCompilerOutput(parsedOutput, libraries);

  if (isNil(output)) {
    return formatFatalError('Failed to process output.');
  }

  return JSON.stringify(output);
}

export = wrapper;

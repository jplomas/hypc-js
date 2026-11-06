import tape from 'tape';
import spawn from 'tape-spawn';
import * as fs from 'fs';
import * as path from 'path';
import * as tmp from 'tmp';
import hypc from '../';

tape('CLI', function (t) {
  t.test('--version', function (st) {
    const spt = spawn(st, './hypc.js --version');
    spt.stdout.match(hypc.version() + '\n');
    spt.stdout.match(/^\s*[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?\+commit\.[0-9a-f]+([a-zA-Z0-9.-]+)?\s*$/);
    spt.stderr.empty();
    spt.end();
  });

  t.test('no parameters', function (st) {
    const spt = spawn(st, './hypc.js');
    spt.stderr.match(/^Must provide a file/);
    spt.end();
  });

  t.test('no mode specified', function (st) {
    const spt = spawn(st, './hypc.js test/resources/fixtureSmoke.hyp');
    spt.stderr.match(/^Invalid option selected/);
    spt.end();
  });

  t.test('--bin', function (st) {
    const spt = spawn(st, './hypc.js --bin test/resources/fixtureSmoke.hyp');
    spt.stderr.empty();
    spt.succeeds();
    spt.end();
  });

  t.test('--bin --optimize', function (st) {
    const spt = spawn(st, './hypc.js --bin --optimize test/resources/fixtureSmoke.hyp');
    spt.stderr.empty();
    spt.succeeds();
    spt.end();
  });

  t.test('--bin --optimize-runs 666', function (st) {
    const spt = spawn(st, './hypc.js --bin --optimize-runs 666 test/resources/fixtureSmoke.hyp');
    spt.stderr.empty();
    spt.succeeds();
    spt.end();
  });

  t.test('--bin --optimize-runs not-a-number', function (st) {
    const spt = spawn(st, './hypc.js --bin --optimize-runs not-a-number test/resources/fixtureSmoke.hyp');
    spt.stderr.match(/^error: option '--optimize-runs <optimize-runs>' argument 'not-a-number' is invalid/);
    spt.end();
  });

  t.test('--bin --optimize-runs with trailing characters', function (st) {
    const spt = spawn(st, './hypc.js --bin --optimize-runs 12abc test/resources/fixtureSmoke.hyp');
    spt.stderr.match(/^error: option '--optimize-runs <optimize-runs>' argument '12abc' is invalid/);
    spt.fails();
    spt.end();
  });

  t.test('--abi --pretty-json', function (st) {
    const outputDir = tmp.dirSync({ unsafeCleanup: true }).name;
    const spt = spawn(st, `./hypc.js --abi --pretty-json -o ${outputDir} test/resources/fixtureSmoke.hyp`, { end: false });
    spt.stderr.empty();
    spt.succeeds();
    spt.end(function () {
      const abi = fs.readFileSync(path.join(outputDir, 'test_resources_fixtureSmoke_hyp_C.abi'), 'utf8');
      st.ok(abi.split('\n').length > 1, 'ABI is pretty-printed');
      st.end();
    });
  });

  t.test('--bin --verbose writes diagnostics to stderr', function (st) {
    const outputDir = tmp.dirSync({ unsafeCleanup: true }).name;
    const spt = spawn(st, `./hypc.js --bin --verbose -o ${outputDir} test/resources/fixtureSmoke.hyp`);
    spt.stderr.match(/^>>> Compiling:/);
    spt.succeeds();
    spt.end();
  });

  t.test('output name collision', function (st) {
    const outputDir = tmp.dirSync({ unsafeCleanup: true }).name;
    const sourceDir = tmp.dirSync({ unsafeCleanup: true }).name;
    fs.writeFileSync(path.join(sourceDir, 'a.b.hyp'), 'contract C {}');
    fs.writeFileSync(path.join(sourceDir, 'a_b.hyp'), 'contract C {}');
    const spt = spawn(st, `./hypc.js --bin -o ${outputDir} ${sourceDir}/a.b.hyp ${sourceDir}/a_b.hyp`);
    spt.stderr.match(/^Warning: .*a\.b\.hyp:C and .*a_b\.hyp:C both write .*a_b_hyp_C; /);
    spt.succeeds();
    spt.end();
  });

  // A project directory and, next to it, a file outside it that imports must not reach.
  function importEscapeFixture () {
    const root = fs.realpathSync(tmp.dirSync({ unsafeCleanup: true }).name);
    fs.mkdirSync(path.join(root, 'proj'));
    fs.mkdirSync(path.join(root, 'outside'));
    fs.writeFileSync(path.join(root, 'outside', 'leak.txt'), 'OUTSIDE-SECRET line1\n');
    return root;
  }

  t.test('import escaping the base path is rejected', function (st) {
    const root = importEscapeFixture();
    fs.writeFileSync(path.join(root, 'proj', 'evil.hyp'), 'import "/../outside/leak.txt";\ncontract X {}\n');
    const spt = spawn(st, `${path.resolve('hypc.js')} --bin --base-path proj proj/evil.hyp`, { cwd: root });
    spt.stderr.match(/Source "\/\.\.\/outside\/leak\.txt" not found: File outside of allowed directories\./);
    spt.stderr.match(/^(?![\s\S]*OUTSIDE-SECRET)/);
    spt.fails();
    spt.end();
  });

  t.test('absolute import outside the allowed directories is rejected', function (st) {
    const root = importEscapeFixture();
    const elsewhere = fs.realpathSync(tmp.dirSync({ unsafeCleanup: true }).name);
    fs.writeFileSync(path.join(root, 'proj', 'evil.hyp'), `import "${root}/outside/leak.txt";\ncontract X {}\n`);
    const spt = spawn(st, `${path.resolve('hypc.js')} --bin ${root}/proj/evil.hyp`, { cwd: elsewhere });
    spt.stderr.match(/File outside of allowed directories\./);
    spt.stderr.match(/^(?![\s\S]*OUTSIDE-SECRET)/);
    spt.fails();
    spt.end();
  });

  t.test('symlink out of the base path is rejected', function (st) {
    const root = importEscapeFixture();
    fs.symlinkSync(path.join(root, 'outside', 'leak.txt'), path.join(root, 'proj', 'link.hyp'));
    fs.writeFileSync(path.join(root, 'proj', 'evil.hyp'), 'import "link.hyp";\ncontract X {}\n');
    const spt = spawn(st, `${path.resolve('hypc.js')} --bin --base-path proj proj/evil.hyp`, { cwd: root });
    spt.stderr.match(/Source "link\.hyp" not found: File outside of allowed directories\./);
    spt.fails();
    spt.end();
  });

  // As in hypc, the working directory is not allowed by default when it is the filesystem root,
  // since every readable file would then be importable.
  t.test('filesystem root as working directory is not allowed', function (st) {
    const root = importEscapeFixture();
    fs.writeFileSync(path.join(root, 'proj', 'evil.hyp'), `import "${root}/outside/leak.txt";\ncontract X {}\n`);
    const outputDir = tmp.dirSync({ unsafeCleanup: true }).name;
    const spt = spawn(st, `${path.resolve('hypc.js')} --bin -o ${outputDir} ${root}/proj/evil.hyp`, { cwd: path.parse(root).root });
    spt.stderr.match(/File outside of allowed directories\./);
    spt.stderr.match(/^(?![\s\S]*OUTSIDE-SECRET)/);
    spt.fails();
    spt.end();
  });

  t.test('filesystem root as working directory still allows the input file directory', function (st) {
    const root = importEscapeFixture();
    fs.writeFileSync(path.join(root, 'proj', 'lib.hyp'), 'contract L {}\n');
    fs.writeFileSync(path.join(root, 'proj', 'main.hyp'), 'import "./lib.hyp";\ncontract M {}\n');
    const outputDir = tmp.dirSync({ unsafeCleanup: true }).name;
    const spt = spawn(st, `${path.resolve('hypc.js')} --bin -o ${outputDir} ${root}/proj/main.hyp`, { cwd: path.parse(root).root });
    spt.stderr.empty();
    spt.succeeds();
    spt.end();
  });

  t.test('filesystem root as explicit base path is allowed', function (st) {
    const root = importEscapeFixture();
    const fsRoot = path.parse(root).root;
    fs.writeFileSync(path.join(root, 'outside', 'ext.hyp'), 'contract E {}\n');
    fs.writeFileSync(path.join(root, 'proj', 'main.hyp'), `import "${root}/outside/ext.hyp";\ncontract M {}\n`);
    const outputDir = tmp.dirSync({ unsafeCleanup: true }).name;
    const spt = spawn(st, `${path.resolve('hypc.js')} --bin --base-path ${fsRoot} -o ${outputDir} ${root}/proj/main.hyp`, { cwd: fsRoot });
    spt.stderr.empty();
    spt.succeeds();
    spt.end();
  });

  t.test('invalid file specified', function (st) {
    const spt = spawn(st, './hypc.js --bin test/fileNotFound.hyp');
    spt.stderr.match(/^Error reading /);
    spt.end();
  });

  t.test('incorrect source source', function (st) {
    const spt = spawn(st, './hypc.js --bin test/resources/fixtureIncorrectSource.hyp');
    spt.stderr.match(/SyntaxError: Invalid pragma "contract"/);
    spt.end();
  });

  t.test('--abi', function (st) {
    const spt = spawn(st, './hypc.js --abi test/resources/fixtureSmoke.hyp');
    spt.stderr.empty();
    spt.succeeds();
    spt.end();
  });

  t.test('--bin --abi', function (st) {
    const spt = spawn(st, './hypc.js --bin --abi test/resources/fixtureSmoke.hyp');
    spt.stderr.empty();
    spt.succeeds();
    spt.end();
  });

  t.test('no base path', function (st) {
    const spt = spawn(
      st,
      './hypc.js --bin ' +
        'test/resources/importA.hyp ' +
        './test/resources//importA.hyp ' +
        path.resolve('test/resources/importA.hyp')
    );
    spt.stderr.empty();
    spt.succeeds();
    spt.end();
  });

  t.test('relative base path', function (st) {
    // NOTE: This and other base path tests rely on the relative ./importB.hyp import in importA.hyp.
    // If base path is not stripped correctly from all source paths below, they will not be found
    // by the import callback when it appends the base path back.
    const spt = spawn(
      st,
      './hypc.js --bin --base-path test/resources ' +
        'test/resources/importA.hyp ' +
        './test/resources//importA.hyp ' +
        path.resolve('test/resources/importA.hyp')
    );
    spt.stderr.empty();
    spt.succeeds();
    spt.end();
  });

  t.test('relative non canonical base path', function (st) {
    const spt = spawn(
      st,
      './hypc.js --bin --base-path ./test/resources ' +
        'test/resources/importA.hyp ' +
        './test/resources//importA.hyp ' +
        path.resolve('test/resources/importA.hyp')
    );
    spt.stderr.empty();
    spt.succeeds();
    spt.end();
  });

  t.test('absolute base path', function (st) {
    const spt = spawn(
      st,
      './hypc.js --bin --base-path ' + path.resolve('test/resources') + ' ' +
        'test/resources/importA.hyp ' +
        './test/resources//importA.hyp ' +
        path.resolve('test/resources/importA.hyp')
    );
    spt.stderr.empty();
    spt.succeeds();
    spt.end();
  });

  t.test('include paths', function (st) {
    const spt = spawn(
      st,
      './hypc.js --bin ' +
        'test/resources/importCallback/base/contractB.hyp ' +
        'test/resources/importCallback/includeA/libY.hyp ' +
        './test/resources/importCallback/includeA//libY.hyp ' +
        path.resolve('test/resources/importCallback/includeA/libY.hyp') + ' ' +
        '--base-path test/resources/importCallback/base ' +
        '--include-path test/resources/importCallback/includeA ' +
        '--include-path ' + path.resolve('test/resources/importCallback/includeB/')
    );
    spt.stderr.empty();
    spt.succeeds();
    spt.end();
  });

  t.test('include paths without base path', function (st) {
    const spt = spawn(
      st,
      './hypc.js --bin ' +
        'test/resources/importCallback/contractC.hyp ' +
        '--include-path test/resources/importCallback/includeA'
    );
    spt.stderr.match(/--include-path option requires a non-empty base path\./);
    spt.fails();
    spt.end();
  });

  t.test('empty include paths', function (st) {
    const spt = spawn(
      st,
      './hypc.js --bin ' +
        'test/resources/importCallback/contractC.hyp ' +
        '--base-path test/resources/importCallback/base ' +
        '--include-path='
    );
    spt.stderr.match(/Empty values are not allowed in --include-path\./);
    spt.fails();
    spt.end();
  });

  t.test('standard json', function (st) {
    const input = {
      language: 'Hyperion',
      settings: {
        outputSelection: {
          '*': {
            '*': ['qrvm.bytecode', 'userdoc']
          }
        }
      },
      sources: {
        'Contract.hyp': {
          content: 'pragma hyperion >=0.0.1; contract Contract { function f() pure public {} }'
        }
      }
    };
    const spt = spawn(st, './hypc.js --standard-json');
    spt.stdin.setEncoding('utf-8');
    spt.stdin.write(JSON.stringify(input));
    spt.stdin.end();
    spt.stdin.on('finish', function () {
      spt.stderr.empty();
      spt.stdout.match(/Contract.hyp/);
      spt.stdout.match(/userdoc/);
      spt.succeeds();
      spt.end();
    });
  });

  t.test('standard json --pretty-json with input that is not JSON', function (st) {
    const spt = spawn(st, './hypc.js --standard-json --pretty-json');
    spt.stdin.setEncoding('utf-8');
    spt.stdin.write('{not json');
    spt.stdin.end();
    spt.stdin.on('finish', function () {
      spt.stderr.empty();
      spt.stdout.match(/"type": "JSONError"/);
      spt.succeeds();
      spt.end();
    });
  });

  t.test('standard json base path', function (st) {
    const input = {
      language: 'Hyperion',
      settings: {
        outputSelection: {
          '*': {
            '*': ['metadata']
          }
        }
      },
      sources: {
        'importA.hyp': {
          content: 'import "./importB.hyp";'
        }
      }
    };
    const spt = spawn(st, './hypc.js --standard-json --base-path test/resources');
    spt.stdin.setEncoding('utf-8');
    spt.stdin.write(JSON.stringify(input));
    spt.stdin.end();
    spt.stdin.on('finish', function () {
      spt.stderr.empty();
      spt.stdout.match(/{"contracts":{"importB.hyp":{"D":{"metadata":/);
      spt.succeeds();
      spt.end();
    });
  });

  t.test('standard json include paths', function (st) {
    const input = {
      language: 'Hyperion',
      sources: {
        'contractB.hyp': {
          content:
            '// SPDX-License-Identifier: GPL-3.0\n' +
            'pragma hyperion >=0.0.1;\n' +
            'import "./contractA.hyp";\n'
        }
      }
    };
    const spt = spawn(
      st,
      './hypc.js --standard-json ' +
        '--base-path test/resources/importCallback/base ' +
        '--include-path test/resources/importCallback/includeA ' +
        '--include-path ' + path.resolve('test/resources/importCallback/includeB/')
    );
    spt.stdin.setEncoding('utf-8');
    spt.stdin.write(JSON.stringify(input));
    spt.stdin.end();
    spt.stdin.on('finish', function () {
      spt.stderr.empty();
      spt.stdout.match(/"sources":{"contractA.hyp":{"id":0},"contractB.hyp":{"id":1},"libX.hyp":{"id":2},"libY.hyp":{"id":3},"libZ.hyp":{"id":4},"utils.hyp":{"id":5}}}/);
      spt.succeeds();
      spt.end();
    });
  });
});

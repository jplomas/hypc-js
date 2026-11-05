import tape from 'tape';
import * as fs from 'fs';
import * as path from 'path';
import * as semver from 'semver';
import hypc from '../';

// CIPH-HYPERION-16. A JavaScript exception that unwinds through the compiler's wasm frames skips
// the compiler's C++ cleanup, and the module instance it unwound through cannot compile again:
// every later compilation fails with "You shall not have another CompilerStack aside me." The
// wrapper loads a fresh instance for the next compilation; these tests cover that, and what
// happens where no fresh instance can be loaded.

const Module = module.constructor as any;
const hypjsonPath = path.resolve(__dirname, '..', 'hypjson.js');
// The module instance that index.js wrapped.
const hypjson = require(hypjsonPath);

function standardInput (content: string) {
  return JSON.stringify({
    language: 'Hyperion',
    sources: { 'a.hyp': { content } },
    settings: { outputSelection: { '*': { '*': ['abi'] } } }
  });
}

const GOOD = standardInput('contract C { function f() public pure returns (uint) { return 1; } }');
const WITH_IMPORT = standardInput('import "b.hyp"; contract C is B {}');
const importB = () => ({ contents: 'contract B {}' });

function errors (outputJSON: string) {
  const output = JSON.parse(outputJSON);
  return (output.errors || []).filter((error) => error.severity === 'error').map((error) => error.message);
}

// A fresh instance of the compiler module outside require.cache, as a consumer who loads the
// module themselves has one.
function freshModule () {
  const loaded = new Module(hypjsonPath);
  loaded.filename = hypjsonPath;
  loaded.paths = Module._nodeModulePaths(path.dirname(hypjsonPath));
  loaded._compile(fs.readFileSync(hypjsonPath, 'utf8'), hypjsonPath);
  return loaded.exports;
}

// Compilers from 0.3.0 on discard an abandoned compilation in hyperion_reset(), so an instance that
// cannot be replaced can go on; 0.2.0 cannot.
const compilerRecoversInPlace = semver.gte(semver.coerce(hypc.version()), '0.3.0');

// Makes compile() throw from inside the compiler's wasm frames: the import callback answers, but
// storing the address of its answer for the compiler fails, which leaves hypc-js nothing to answer
// the compiler with. (setValue is used for that alone; the input is also copied into the
// compiler's memory, but before the compiler runs.) Returns what compile() threw.
function poison (compiler, instance, exception = () => new Error('injected failure')) {
  const realSetValue = instance.setValue;
  instance.setValue = () => { throw exception(); };
  try {
    compiler.compile(WITH_IMPORT, { import: importB });
  } catch (e) {
    return e;
  } finally {
    instance.setValue = realSetValue;
  }
  return undefined;
}

tape('Recovery after an exception unwinds through the compiler', function (t) {
  t.test('compile() throws the exception, and the next compile() works', function (st) {
    const listeners = process.listenerCount('unhandledRejection');
    st.match(String(poison(hypc, hypjson)), /^Error: injected failure$/);
    st.deepEqual(errors(hypc.compile(GOOD)), [], 'a fresh instance compiles');
    st.deepEqual(errors(hypc.compile(WITH_IMPORT, { import: importB })), [], 'with callbacks');
    st.equal(process.listenerCount('unhandledRejection'), listeners, 'loading it added no process listener');
    st.equal(hypc.version(), hypjson.cwrap('hyperion_version', 'string', [])(), 'version() is unchanged');
    st.end();
  });

  t.test('setupMethods with a loader loads a fresh instance on every occasion', function (st) {
    const instances = [freshModule()];
    const loader = () => {
      instances.push(freshModule());
      return instances[instances.length - 1];
    };
    const compiler = hypc.setupMethods(instances[0], loader);
    for (let round = 1; round <= 2; round++) {
      st.match(String(poison(compiler, instances[instances.length - 1])), /injected failure/, `round ${round}: compile() threw`);
      st.equal(instances.length, round, `round ${round}: nothing is loaded until the next compilation`);
      st.deepEqual(errors(compiler.compile(GOOD)), [], `round ${round}: the next compilation works`);
      st.equal(instances.length, round + 1, `round ${round}: on a fresh instance`);
    }
    st.deepEqual(errors(compiler.lowlevel.compileStandard(GOOD)), [], 'the low-level API uses the same instance');
    st.end();
  });

  t.test('setupMethods without a loader goes on with the same instance where the compiler allows', function (st) {
    const instance = freshModule();
    // Not in require.cache, so the wrapper has no way to load a fresh instance.
    const compiler = hypc.setupMethods(instance);
    st.match(String(poison(compiler, instance)), /injected failure/);
    const outputs = [JSON.parse(compiler.compile(GOOD)), JSON.parse(compiler.compile(GOOD))];
    if (compilerRecoversInPlace) {
      for (const output of outputs) {
        st.deepEqual((output.errors || []).filter((error) => error.severity === 'error'), [], 'the instance compiles again after hyperion_reset()');
      }
    } else {
      for (const output of outputs) {
        st.equal(output.errors.length, 1);
        st.equal(output.errors[0].severity, 'error');
        st.match(
          output.errors[0].message,
          /^The compiler module cannot be used again: an exception unwound through the compiler during an earlier compilation \(Error: injected failure\), and this compiler's hyperion_reset\(\) does not discard the abandoned compilation \(compilers from 0\.3\.0 on do\)\. Load a fresh module, or pass a function that does so as the second argument of setupMethods\.$/
        );
      }
    }
    st.equal(compiler.version(), hypc.version(), 'version() still answers');
    st.end();
  });

  t.test('an instance is not reused in place after a WebAssembly trap', function (st) {
    const trap = () => new WebAssembly.RuntimeError('injected trap');
    const instance = freshModule();
    const compiler = hypc.setupMethods(instance);
    st.match(String(poison(compiler, instance, trap)), /^RuntimeError: injected trap$/);
    for (let round = 1; round <= 2; round++) {
      const output = JSON.parse(compiler.compile(GOOD));
      st.equal(output.errors.length, 1);
      st.match(
        output.errors[0].message,
        /^The compiler module cannot be used again: an exception unwound through the compiler during an earlier compilation \(RuntimeError: injected trap\), and the instance cannot be reused after a WebAssembly trap\. Load a fresh module/
      );
    }

    // With a loader, a trap is answered with a fresh instance like any other exception.
    const instances = [freshModule()];
    const replaced = hypc.setupMethods(instances[0], () => {
      instances.push(freshModule());
      return instances[instances.length - 1];
    });
    st.match(String(poison(replaced, instances[0], trap)), /injected trap/);
    st.deepEqual(errors(replaced.compile(GOOD)), []);
    st.equal(instances.length, 2);
    st.end();
  });

  t.test('the wasm stack pointer is put back after an exception', function (st) {
    const instance = freshModule();
    if (typeof instance.stackSave !== 'function') {
      st.skip('this build does not expose stackSave');
      st.end();
      return;
    }
    const compiler = hypc.setupMethods(instance);
    const before = instance.stackSave();
    st.match(String(poison(compiler, instance)), /injected failure/);
    st.equal(instance.stackSave(), before);
    st.end();
  });

  t.test('a loader that fails is reported, and tried again next time', function (st) {
    const instance = freshModule();
    let attempts = 0;
    const compiler = hypc.setupMethods(instance, () => {
      attempts++;
      throw new Error('disk gone');
    });
    poison(compiler, instance);
    st.match(JSON.parse(compiler.compile(GOOD)).errors[0].message, /^The compiler module cannot be used again: .* and reloading it failed: Error: disk gone$/);
    st.match(JSON.parse(compiler.compile(GOOD)).errors[0].message, /reloading it failed: Error: disk gone$/);
    st.equal(attempts, 2);
    st.end();
  });

  t.test('deeply nested parentheses do not disable later compilations', function (st) {
    // The finding's input: a few hundred nested parentheses run V8's stack out inside the parser
    // before the parser's own limit of 1200 levels is reached, and the RangeError unwinds through
    // the compiler. Whether the stack runs out depends on how V8 has compiled the parser's code at
    // that point (optimised code uses smaller frames), so either the RangeError or the parser's
    // own error is accepted here. What matters is the compilation after it.
    const depth = 1000;
    const input = standardInput(`contract C { function f() public pure returns (uint) { return ${'('.repeat(depth)}1${')'.repeat(depth)}; } }`);
    let outcome;
    try {
      outcome = errors(hypc.compile(input));
    } catch (e) {
      outcome = e;
    }
    if (outcome instanceof Error) {
      st.match(String(outcome), /^RangeError: Maximum call stack size exceeded/, 'the RangeError reached the caller');
    } else {
      st.ok(outcome.some((message) => /Maximum recursion depth reached during parsing/.test(message)), 'the parser rejected the input');
    }
    st.deepEqual(errors(hypc.compile(GOOD)), [], 'the next compilation works');
    st.end();
  });
});

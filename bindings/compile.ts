import assert from 'assert';

import { describeException, isNil } from '../common/helpers';
import { bindHypcMethod } from './helpers';

/**
 * @param hypJson The Emscripten compiled Hyperion object.
 * @param core The core bound Hyperion methods.
 * @param onEscapedException Called with the exception when a JavaScript exception has unwound
 *   through the compiler's wasm frames; see `guarded` below.
 */
export function setupCompile (hypJson, core, onEscapedException: (e: any) => void = () => {}) {
  const guard = (method) => guarded(method, hypJson, onEscapedException);
  return {
    compileJson: bindCompileJson(hypJson, guard),
    compileJsonCallback: bindCompileJsonCallback(hypJson, core, guard),
    compileJsonMulti: bindCompileJsonMulti(hypJson, guard),
    compileStandard: bindCompileStandard(hypJson, core, guard)
  };
}

/**
 * Wraps a bound compiler method so that an exception which unwinds through the compiler's wasm
 * frames is reported before it propagates.
 *
 * The compiler is built with Emscripten's JavaScript exception handling: a C++ throw is a
 * JavaScript throw of a number, which the `invoke_*` trampolines catch at every C++ try block so
 * that landing pads (destructors, catch clauses) run. Any other JavaScript exception, such as the
 * RangeError V8 raises when deeply recursive compiler code runs out of stack, or an exception
 * thrown by an import callback, is rethrown by those trampolines without running the landing
 * pads. The compiler's globals then stay as they were mid-compilation (the CompilerStack
 * singleton guard is still taken, TypeProvider is not reset), and every later compilation on this
 * module instance fails with "You shall not have another CompilerStack aside me." The wrapper
 * (wrapper.ts) loads a fresh instance of the module in that case, or asks the compiler to discard
 * the abandoned compilation where it cannot.
 *
 * Emscripten also restores the wasm stack pointer at every C++ try block such an exception passes,
 * but not at the entry point, so the pointer is left below where the call started with nothing but
 * dead frames above it. It is put back where it was, when the build exposes stackSave/stackRestore.
 */
function guarded (method, hypJson, onEscapedException) {
  if (isNil(method)) return method;

  return function (...args) {
    const stackPointer = typeof hypJson.stackSave === 'function' ? hypJson.stackSave() : undefined;
    try {
      return method(...args);
    } catch (e) {
      if (stackPointer !== undefined && typeof hypJson.stackRestore === 'function') {
        try {
          hypJson.stackRestore(stackPointer);
        } catch (restoreError) {
          // Then the instance is beyond help; the wrapper will not go on with it.
        }
      }
      onEscapedException(e);
      throw e;
    }
  };
}

/**********************
 * COMPILE
 **********************/

/**
 * Returns a binding to the hyperion compileJSON method.
 * input (text), optimize (bool) -> output (jsontext)
 *
 * @param hypJson The Emscripten compiled Hyperion object.
 * @param guard See `guarded`.
 */
function bindCompileJson (hypJson, guard) {
  return guard(bindHypcMethod(
    hypJson,
    'compileJSON',
    'string',
    ['string', 'number'],
    null
  ));
}

/**
 * Returns a binding to the hyperion compileJSONMulti method.
 * input (jsontext), optimize (bool) -> output (jsontext)
 *
 * @param hypJson The Emscripten compiled Hyperion object.
 * @param guard See `guarded`.
 */
function bindCompileJsonMulti (hypJson, guard) {
  return guard(bindHypcMethod(
    hypJson,
    'compileJSONMulti',
    'string',
    ['string', 'number'],
    null
  ));
}

/**
 * Returns a binding to the hyperion compileJSONCallback method.
 * input (jsontext), optimize (bool), callback (ptr) -> output (jsontext)
 *
 * @param hypJson The Emscripten compiled Hyperion object.
 * @param coreBindings The core bound Hyperion methods.
 * @param guard See `guarded`.
 */
function bindCompileJsonCallback (hypJson, coreBindings, guard) {
  const compileInternal = guard(bindHypcMethod(
    hypJson,
    'compileJSONCallback',
    'string',
    ['string', 'number', 'number'],
    null
  ));

  if (isNil(compileInternal)) return null;

  return function (input, optimize, readCallback) {
    return runWithCallbacks(hypJson, coreBindings, readCallback, compileInternal, [input, optimize]);
  };
}

/**
 * Returns a binding to the hyperion hyperion_compile method with a fallback to
 * compileStandard.
 * input (jsontext), callback (optional >= v6 only - ptr) -> output (jsontext)
 *
 * @param hypJson The Emscripten compiled Hyperion object.
 * @param coreBindings The core bound Hyperion methods.
 * @param guard See `guarded`.
 */
function bindCompileStandard (hypJson, coreBindings, guard) {
  let boundFunctionStandard: any = null;
  let boundFunctionHyperion: any = null;

  // input (jsontext), callback (ptr) -> output (jsontext)
  const compileInternal = guard(bindHypcMethod(
    hypJson,
    'compileStandard',
    'string',
    ['string', 'number'],
    null
  ));

  // input (ptr to text), callback (ptr), callback_context (ptr) -> output (jsontext)
  //
  // The input is passed as a pointer to a copy made with hyperion_alloc(), not as a 'string'
  // argument: Emscripten's ccall copies a 'string' argument onto the wasm stack, whose size is
  // fixed when the compiler is built (5 MB), so an input of more than about 1.3 million
  // characters overflows it and the compilation crashes instead of running. The copy is freed by
  // the reset() that runWithCallbacks makes after each compilation, like every other allocation
  // made for the compiler. The output stays a 'string': it is read from the compiler's memory and
  // freed by the same reset().
  boundFunctionHyperion = guard(bindHypcMethod(
    hypJson,
    'hyperion_compile',
    'string',
    ['number', 'number', 'number'],
    null
  ));

  if (!isNil(compileInternal)) {
    boundFunctionStandard = function (input, readCallback) {
      return runWithCallbacks(hypJson, coreBindings, readCallback, compileInternal, [input]);
    };
  }

  if (!isNil(boundFunctionHyperion)) {
    boundFunctionStandard = function (input, callbacks) {
      // Copied before the guarded call: a failed allocation leaves nothing behind in the
      // compiler, so it must not mark the instance poisoned.
      const inputPointer = coreBindings.allocCString(input);
      return runWithCallbacks(hypJson, coreBindings, callbacks, boundFunctionHyperion, [inputPointer]);
    };
  }

  return boundFunctionStandard;
}

/**********************
 * CALL BACKS
 **********************/

function wrapCallbackWithKind (coreBindings, callback) {
  assert(typeof callback === 'function', 'Invalid callback specified.');

  return function (context, kind, data, contents, error) {
    // Must be a null pointer.
    assert(context === 0, 'Callback context must be null.');

    // The compiler calls this from inside its wasm frames. An exception thrown here would unwind
    // through them without running the compiler's cleanup and leave the module instance unusable
    // (see `guarded`), so a callback that throws, or returns no object, is answered with an error
    // instead, which the compiler reports like any other failed import or query.
    let contentsString;
    let errorString;
    try {
      const result = callback(coreBindings.copyFromCString(kind), coreBindings.copyFromCString(data));
      if (isNil(result)) {
        errorString = `Callback returned ${result} instead of an object with contents or error.`;
      } else {
        if (typeof result.contents === 'string') {
          contentsString = result.contents;
        }
        if (typeof result.error === 'string') {
          errorString = result.error;
        }
      }
    } catch (e) {
      contentsString = undefined;
      errorString = `Callback threw ${describeException(e)}`;
    }

    if (contentsString !== undefined) {
      coreBindings.copyToCString(contentsString, contents);
    }
    if (errorString !== undefined) {
      coreBindings.copyToCString(errorString, error);
    }
  };
}

// calls compile() with args || cb
function runWithCallbacks (hypJson, coreBindings, callbacks, compile, args) {
  if (callbacks) {
    assert(typeof callbacks === 'object', 'Invalid callback object specified.');
  } else {
    callbacks = {};
  }

  let readCallback = callbacks.import;
  if (readCallback === undefined) {
    readCallback = function (data) {
      return {
        error: 'File import callback not supported'
      };
    };
  }

  let singleCallback;
  // After 0.6.x multiple kind of callbacks are supported.
  let smtSolverCallback = callbacks.smtSolver;
  if (smtSolverCallback === undefined) {
    smtSolverCallback = function (data) {
      return {
        error: 'SMT solver callback not supported'
      };
    };
  }

  singleCallback = function (kind, data) {
    if (kind === 'source') {
      return readCallback(data);
    } else if (kind === 'smt-query') {
      return smtSolverCallback(data);
    } else {
      assert(false, 'Invalid callback kind specified.');
    }
  };

  singleCallback = wrapCallbackWithKind(coreBindings, singleCallback);

  const cb = coreBindings.addFunction(singleCallback, 'viiiii');
  let output;
  try {
    args.push(cb);
    // Callback context.
    args.push(null);

    output = compile(...args);
  } finally {
    coreBindings.removeFunction(cb);
  }

  if (coreBindings.reset) {
    // Explicitly free memory.
    //
    // NOTE: cwrap() of "compile" will copy the returned pointer into a
    //       Javascript string and it is not possible to call free() on it.
    //       reset() however will clear up all allocations.
    coreBindings.reset();
  }
  return output;
}

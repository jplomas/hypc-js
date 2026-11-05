import { setupCore } from './core';
import { getSupportedMethods } from './helpers';
import { setupCompile } from './compile';

export default function setupBindings (hypJson) {
  const coreBindings = setupCore(hypJson);
  const bindings = {
    methodFlags: getSupportedMethods(hypJson),
    coreBindings,
    compileBindings: null,
    // Set, with the exception, once a JavaScript exception has unwound through the compiler's wasm
    // frames. This module instance cannot compile after that; see `guarded` in ./compile.ts.
    poisoned: false,
    poisonedBy: undefined
  };
  bindings.compileBindings = setupCompile(hypJson, coreBindings, (e) => {
    bindings.poisoned = true;
    bindings.poisonedBy = e;
  });

  return bindings;
}

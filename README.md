# hypc-js

JavaScript bindings for the [Hyperion compiler](https://github.com/theQRL/hyperion).

Uses the Emscripten compiled Hyperion found in the [hypc-bin repository](https://github.com/theQRL/hypc-bin).

## Node.js Usage

To use the latest stable version of the Hyperion compiler via Node.js you can install it via npm:

```bash
npm install @theqrl/hypc
```

It needs Node.js 22.12 or later.

### Usage on the Command-Line

If this package is installed globally (`npm install -g @theqrl/hypc`), a command-line tool called `hypcjs` will be available.

To see all the supported features, execute:

```bash
hypcjs --help
```

To compile a contract that imports other contracts via relative paths:
```bash
hypcjs --bin --include-path node_modules/ --base-path . MainContract.hyp
```
Use the ``--base-path`` and ``--include-path`` options to describe the layout of your project.
``--base-path`` represents the root of your own source tree while ``--include-path`` allows you to
specify extra locations containing external code (e.g. libraries installed with a package manager).

As in `hypc`, the import callback only reads files inside the base path (the working directory
when ``--base-path`` is not given), the include paths and the directories of the files given on
the command line. Symbolic links are resolved first. Any other import fails with
`File outside of allowed directories.`
If the working directory is the root of the filesystem (or of a drive on Windows) and
``--base-path`` is not given, the working directory is not allowed, since every readable file
would then be importable. Pass ``--base-path`` explicitly if you really need it.

Note: ensure that all the files you specify on the command line are located inside the base path or
one of the include paths.
The compiler refers to files from outside of these directories using absolute paths.
Having absolute paths in contract metadata will result in your bytecode being reproducible only
when it's placed in these exact absolute locations.

Note: this commandline interface is not compatible with `hypc` provided by the Hyperion compiler package and thus cannot be
used in combination with a QRL client via the `qrl.compile.hyperion()` RPC method. Please refer to the
[Hyperion compiler documentation](https://theqrl.org/) for instructions to install `hypc`.
Furthermore, the commandline interface to hypc-js provides fewer features than the binary release.

### Usage in Projects

There are two ways to use `hypc`:

1. Through a high-level API giving a uniform interface to all compiler versions
2. Through a low-level API giving access to all the compiler interfaces, which depend on the version of the compiler

#### High-level API

The high-level API consists of a single method, `compile`, which expects the [Compiler Standard Input and Output JSON](https://theqrl.org/).

It also accepts an optional set of callback functions, which include the ``import`` and the ``smtSolver`` callbacks.
Starting 0.6.0 it only accepts an object in place of the callback to supply the callbacks.

The ``import`` callback function is used to resolve unmet dependencies.
This callback receives a path and must synchronously return either an error or the content of the dependency
as a string.  It cannot be used together with callback-based, asynchronous,
filesystem access. A workaround is to collect the names of dependencies, return
an error, and keep re-running the compiler until all of them are resolved.

A callback that throws, or that returns anything but an object with a string ``contents`` or a
string ``error``, does not abort the compilation: the compiler reports it as the import error, for
example ``Source "a.hyp" not found: Callback threw Error: ENOENT: no such file or directory``. An
``error`` that is not a string, such as an ``Error`` object, is reported as the error it describes.

#### Example usage without the import callback

Example:

```javascript
var hypc = require('@theqrl/hypc');

var input = {
  language: 'Hyperion',
  sources: {
    'test.hyp': {
      content: 'contract C { function f() public { } }'
    }
  },
  settings: {
    outputSelection: {
      '*': {
        '*': ['*']
      }
    }
  }
};

var output = JSON.parse(hypc.compile(JSON.stringify(input)));

// `output` here contains the JSON output as specified in the documentation
for (var contractName in output.contracts['test.hyp']) {
  console.log(
    contractName +
      ': ' +
      output.contracts['test.hyp'][contractName].qrvm.bytecode.object
  );
}
```

#### Example usage with import callback

```javascript
var hypc = require('@theqrl/hypc');

var input = {
  language: 'Hyperion',
  sources: {
    'test.hyp': {
      content: 'import "lib.hyp"; contract C { function f() public { L.f(); } }'
    }
  },
  settings: {
    outputSelection: {
      '*': {
        '*': ['*']
      }
    }
  }
};

function findImports(path) {
  if (path === 'lib.hyp')
    return {
      contents:
        'library L { function f() internal returns (uint) { return 7; } }'
    };
  else return { error: 'File not found' };
}

// New syntax (supported from 0.5.12, mandatory from 0.6.0)
var output = JSON.parse(
  hypc.compile(JSON.stringify(input), { import: findImports })
);

// `output` here contains the JSON output as specified in the documentation
for (var contractName in output.contracts['test.hyp']) {
  console.log(
    contractName +
      ': ' +
      output.contracts['test.hyp'][contractName].qrvm.bytecode.object
  );
}
```

Since version 0.5.1, the ``smtSolver`` callback function is used to solve SMT queries generated by
Hyperion's SMTChecker.  If you have an SMT solver installed locally, it can
be used to solve the given queries, where the callback must synchronously
return either an error or the result from the solver.  A default
``smtSolver`` callback is included in this package via the module
``smtchecker.js`` which exports the ``smtCallback`` function that takes 1) a
function that takes queries and returns the solving result, and 2) a solver
configuration object. The module ``smtsolver.js`` has a few predefined solver
configurations, and relies on Z3, Eldarica, cvc5 or cvc4 being installed locally.  It
exports the list of locally found solvers and a function that invokes a given
solver.

The API of the SMT callback is **experimental** and can change at any time.
The last change was in version 0.8.11.

#### Example usage with smtSolver callback

```javascript
var hypc = require('@theqrl/hypc');
const smtchecker = require('@theqrl/hypc/smtchecker');
const smtsolver = require('@theqrl/hypc/smtsolver');
// Note that this example only works via node and not in the browser.

var input = {
  language: 'Hyperion',
  sources: {
    'test.hyp': {
      content: 'contract C { function f(uint x) public { assert(x > 0); } }'
    }
  },
  settings: {
    modelChecker: {
      engine: "chc",
      solvers: [ "smtlib2" ]
    }
  }
};

var output = JSON.parse(
  hypc.compile(
    JSON.stringify(input),
    { smtSolver: smtchecker.smtCallback(smtsolver.smtSolver, smtsolver.availableSolvers[0]) }
  )
);

```
The assertion is clearly false, and an ``assertion failure`` warning
should be returned, together with a counterexample.

#### When an exception unwinds through the compiler

`compile` throws when a JavaScript exception unwinds through the compiler itself, for example the
`RangeError` of a stack overflow on deeply nested source. The compiler's cleanup does not run then,
so the module instance the exception unwound through cannot compile again, and the next call to
`compile` loads a fresh instance of the module, or, where none can be loaded, goes on with the same
instance once the compiler has discarded the abandoned compilation. This needs nothing from the
caller for the bundled compiler and for one from `loadRemoteVersion`; for a module given to
`setupMethods`, see [Using a Legacy Version](#using-a-legacy-version). Going on with the same
instance keeps the memory of the abandoned compilation allocated, since the compiler cannot free
what the exception interrupted; a fresh instance does not.

#### Low-level API

The low-level API is as follows:

- `hypc.lowlevel.compileSingle`: the original entry point, supports only a single file
- `hypc.lowlevel.compileMulti`: this supports multiple files, introduced in 0.1.6
- `hypc.lowlevel.compileCallback`: this supports callbacks, introduced in 0.2.1
- `hypc.lowlevel.compileStandard`: this works just like `compile` above, but is only present in compilers after (and including) 0.4.11

For examples how to use them, please refer to the README of the above mentioned hypc-js releases.

**Note**: These low-level functions remain available for compatibility reasons.
However, they were superseded by the `compile()` function and are no longer required.
Starting from version `0.5.0+commit.1d4f565a`, the functions `compileSingle`, `compileMulti`, and `compileCallback` are always `null` when using newer hypc binary versions.
It is recommended to use the latest release of hypc-js, but it should also handle all the older hypc binaries down to `0.1.x`.

### Using with Electron

**Note:**
If you are using Electron, `nodeIntegration` is on for `BrowserWindow` by default. If it is on, Electron will provide a `require` method which will not behave as expected and this may cause calls, such as `require('@theqrl/hypc')`, to fail.

To turn off `nodeIntegration`, use the following:

```javascript
new BrowserWindow({
  webPreferences: {
    nodeIntegration: false
  }
});
```

### Using a Legacy Version

In order to compile contracts using a specific version of Hyperion, the `hypc.loadRemoteVersion(version, callback)` method is available. This returns a new `hypc` object that uses a version of the compiler specified.

You can also load the "binary" manually and use `setupMethods` to create the familiar wrapper functions described above:
`var hypc = hypc.setupMethods(require("/my/local/hypjson.js"))`.

When an exception unwinds through such a module (see above), `setupMethods` loads a fresh instance
from the module's file if `require` loaded it. Otherwise pass a function that returns a fresh
module as the second argument, `hypc.setupMethods(hypjson, loadHypjson)`. Without one, as in a
browser, the same instance goes on after `hyperion_reset()` has discarded the abandoned
compilation, which compilers from 0.3.0 on support; with an older compiler, or after a WebAssembly
trap, the next `compile` returns an error that says the module cannot be used again. Each
compilation the same instance goes on from leaves its memory allocated in the instance, so a
long-lived page that sees `compile` throw more than rarely should load a fresh module itself.

### Using the Latest Release

`loadRemoteVersion('latest', …)` loads the latest release in the
[release list](https://binaries.theqrl.org/bin/list.json), which can be newer than the compiler that
your installed copy of this package bundles.

```javascript
var hypc = require('@theqrl/hypc');

// getting the latest release
hypc.loadRemoteVersion('latest', function(err, hypcLatest) {
  if (err) {
    // An error was encountered, display and quit
  } else {
    // NOTE: Use `hypcLatest` here with the same interface `hypc` has
    // For example:
    const output = hypcLatest.compile(/* ... */)
  }
});
```

The version is `latest`, a release such as `0.2.0`, or a build in the long format, which includes
the commit hash, such as `v0.2.0+commit.e36a0aea`. The [publicly available release list](https://binaries.theqrl.org/bin/list.json)
has every version.

```javascript
hypc.loadRemoteVersion('v0.2.0+commit.e36a0aea', function(err, hypcRemote) { /* ... */ });
```

`loadRemoteVersion` looks the version up in that list and downloads the build from
`binaries.theqrl.org`. It runs the build only if its keccak256 and sha256 match the list, and
otherwise passes an error to the callback. It follows redirects only to `https` URLs on the same
host, and stops reading a build larger than 64 MiB. A build that fails to load also reaches the
callback as an error.

### Linking Bytecode

When using libraries, the resulting bytecode will contain placeholders for the real addresses of the referenced libraries. These have to be updated, via a process called linking, before deploying the contract.

The `linker` module (`require('@theqrl/hypc/linker')`) offers helpers to accomplish this.

The `linkBytecode` method provides a simple helper for linking:

```javascript
var linker = require('@theqrl/hypc/linker');

bytecode = linker.linkBytecode(bytecode, { MyLibrary: 'Q123456...' });
```

An address is `Q` followed by 128 hex digits. As in the compiler's `settings.libraries`, an address
in mixed case must carry the address checksum; one in all lower case or all upper case does not.

As of Hyperion 0.4.11 the compiler supports [standard JSON input and output](https://theqrl.org) which outputs a _link references_ map. This gives a map of library names to offsets in the bytecode to replace the addresses at. It also doesn't have the limitation on library file and contract name lengths.

There is a method available in the `linker` module called `findLinkReferences` which can find such link references in bytecode produced by an older compiler:

```javascript
var linker = require('@theqrl/hypc/linker');

var linkReferences = linker.findLinkReferences(bytecode);
```

### Updating the ABI

The ABI generated by Hyperion versions can differ slightly, due to new features introduced. There is a tool included which aims to translate the ABI generated by an older Hyperion version to conform to the latest standard.

It can be used as:

```javascript
var abi = require('@theqrl/hypc/abi');

var inputABI = [
  {
    constant: false,
    inputs: [],
    name: 'hello',
    outputs: [{ name: '', type: 'string' }],
    payable: false,
    type: 'function'
  }
];
var outputABI = abi.update('0.3.6', inputABI);
// Output contains: [{"constant":false,"inputs":[],"name":"hello","outputs":[{"name":"","type":"string"}],"payable":true,"type":"function"},{"type":"fallback","payable":true}]
```

### Formatting old JSON assembly output

There is a helper available to format old JSON assembly output into a text familiar to earlier users of Remix IDE.

```
var translate = require('@theqrl/hypc/translate')

// assemblyJSON refers to the JSON of the given assembly and sourceCode is the source of which the assembly was generated from
var output = translate.prettyPrintLegacyAssemblyJSON(assemblyJSON, sourceCode)
```

## Browser Usage

Compilation is generally a long-running and resource intensive task that cannot reasonably be performed in the main thread of the browser.
Some browsers even disallow synchronous compilation on the main thread if the module is larger than 4KB.
Thus, the only supported way to use `hypc` in a web browser is through a [web worker](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers).

### Loading hypc with web workers

Web Workers allow you to run javascript in the background in the browser, letting the browser's main thread free to do whatever it needs to do.
Please, see the minimal example of how to use `hypc` with web workers below or check out this [repository](https://theqrl.org) for a full demo.

* index.html
```html
<!DOCTYPE html>
<html>

<head>
	<meta charset="utf-8" />
</head>

<body>
	<script>
		var worker = new Worker('./dist/bundle.js');
		worker.addEventListener('message', function (e) {
			console.log(e.data.version)
		}, false);

		worker.postMessage({})
	</script>
</body>

</html>
```

* worker.js:
```javascript
importScripts('https://binaries.theqrl.org/bin/hypjson-v0.0.2+commit.3e18e55.js')
import wrapper from '@theqrl/hypc/wrapper';

self.addEventListener('message', () => {
	const compiler = wrapper(self.Module)
	self.postMessage({
		version: compiler.version()
	})
}, false)
```

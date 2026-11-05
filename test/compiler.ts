import assert from 'assert';
import tape from 'tape';
import * as semver from 'semver';
import * as tmp from 'tmp';
import hypc from '../';
import linker from '../linker';
import { execSync } from 'child_process';
import wrapper from '../wrapper';

const noRemoteVersions = (process.argv.indexOf('--no-remote-versions') >= 0);

function runTests (hypc, versionText) {
  console.log(`Running tests with ${versionText} ${hypc.version()}`);

  function resplitFileNameOnFirstColon (fileName, contractName) {
    assert(!contractName.includes(':'));

    const contractNameComponents = fileName.split(':');
    const truncatedFileName = contractNameComponents.shift();
    contractNameComponents.push(contractName);

    return [truncatedFileName, contractNameComponents.join(':')];
  }

  function getBytecode (output, fileName, contractName) {
    try {
      const outputContract = output.contracts[fileName + ':' + contractName];
      return outputContract.bytecode;
    } catch (e) {
      return '';
    }
  }

  function getBytecodeStandard (output, fileName, contractName) {
    try {
      const outputFile = output.contracts[fileName];
      return outputFile[contractName].qrvm.bytecode.object;
    } catch (e) {
      return '';
    }
  }

  function getGasEstimate (output, fileName, contractName) {
    try {
      // TODO (cyyber): Condition looks odd.
      if (semver.gt(hypc.semver(), '0.4.10') && semver.gt(hypc.semver(), '0.4.20')) {
        [fileName, contractName] = resplitFileNameOnFirstColon(fileName, contractName);
      }
      const outputFile = output.contracts[fileName];
      return outputFile[contractName].qrvm.gasEstimates;
    } catch (e) {
      return '';
    }
  }

  function expectError (output: any, errorType: any, message: any) {
    if (output.errors) {
      for (const errorIndex in output.errors) {
        const error = output.errors[errorIndex];
        if (error.type === errorType) {
          if (message) {
            if (error.message.match(message) !== null) {
              return true;
            }
          } else {
            return true;
          }
        }
      }
    }
    return false;
  }

  function expectNoError (output: any) {
    if (output.errors) {
      for (const errorIndex in output.errors) {
        const error = output.errors[errorIndex];
        if (error.severity === 'error') {
          return false;
        }
      }
    }
    return true;
  }

  tape(versionText, function (t) {
    const tape = t.test;

    tape('Version and license', function (t) {
      t.test('check version', function (st) {
        st.equal(typeof hypc.version(), 'string');
        st.end();
      });
      t.test('check semver', function (st) {
        st.equal(typeof hypc.semver(), 'string');
        st.end();
      });
      t.test('check license', function (st) {
        st.ok(typeof hypc.license() === 'undefined' || typeof hypc.license() === 'string');
        st.end();
      });
    });

    tape('Compilation', function (t) {
      t.test('single files can be compiled (using lowlevel API)', function (st) {
        if (typeof hypc.lowlevel.compileSingle !== 'function') {
          st.skip('Low-level compileSingle interface not implemented by this compiler version.');
          st.end();
          return;
        }

        const output = JSON.parse(hypc.lowlevel.compileSingle('contract A { function g() public {} }'));
        st.ok('contracts' in output);
        const bytecode = getBytecode(output, '', 'A');
        st.ok(typeof bytecode === 'string');
        st.ok(bytecode.length > 0);
        st.end();
      });

      t.test('invalid source code fails properly (using lowlevel API)', function (st) {
        if (typeof hypc.lowlevel.compileSingle !== 'function') {
          st.skip('Low-level compileSingle interface not implemented by this compiler version.');
          st.end();
          return;
        }

        const output = JSON.parse(hypc.lowlevel.compileSingle('contract x { this is an invalid contract }'));
        st.plan(3);
        st.ok('errors' in output);
        // Check if the ParserError exists, but allow others too
        st.ok(output.errors.length >= 1);
        for (const error in output.errors) {
          // Error should be something like:
          //   ParserError
          //   Error: Expected identifier
          //   Parser error: Expected identifier
          if (
            output.errors[error].indexOf('ParserError') !== -1 ||
        output.errors[error].indexOf('Error: Expected identifier') !== -1 ||
        output.errors[error].indexOf('Parser error: Expected identifier') !== -1 ||
        output.errors[error].indexOf(': Expected identifier') !== -1 // 0.4.12
          ) {
            st.ok(true);
          }
        }
        st.end();
      });

      t.test('multiple files can be compiled (using lowlevel API)', function (st) {
        // <0.1.6 doesn't have this
        if (typeof hypc.lowlevel.compileMulti !== 'function') {
          st.skip('Low-level compileMulti interface not implemented by this compiler version.');
          st.end();
          return;
        }

        const input = {
          'a.hyp': 'contract A { function f() public returns (uint) { return 7; } }',
          'b.hyp': 'import "a.hyp"; contract B is A { function g() public { f(); } }'
        };
        const output = JSON.parse(hypc.lowlevel.compileMulti(JSON.stringify({ sources: input })));
        const B = getBytecode(output, 'b.hyp', 'B');
        st.ok(typeof B === 'string');
        st.ok(B.length > 0);
        const A = getBytecode(output, 'a.hyp', 'A');
        st.ok(typeof A === 'string');
        st.ok(A.length > 0);
        st.end();
      });

      t.test('lazy-loading callback works (using lowlevel API)', function (st) {
        // <0.2.1 doesn't have this
        if (typeof hypc.lowlevel.compileCallback !== 'function') {
          st.skip('Low-level compileCallback interface not implemented by this compiler version.');
          st.end();
          return;
        }

        const input = {
          'b.hyp': 'import "a.hyp"; contract B is A { function g() public { f(); } }'
        };
        function findImports (path) {
          if (path === 'a.hyp') {
            return { contents: 'contract A { function f() public returns (uint) { return 7; } }' };
          } else {
            return { error: 'File not found' };
          }
        }
        const output = JSON.parse(hypc.lowlevel.compileCallback(JSON.stringify({ sources: input }), 0, { import: findImports }));
        const B = getBytecode(output, 'b.hyp', 'B');
        st.ok(typeof B === 'string');
        st.ok(B.length > 0);
        const A = getBytecode(output, 'a.hyp', 'A');
        st.ok(typeof A === 'string');
        st.ok(A.length > 0);
        st.end();
      });

      t.test('lazy-loading callback works (with file not found) (using lowlevel API)', function (st) {
        // <0.2.1 doesn't have this
        if (typeof hypc.lowlevel.compileCallback !== 'function') {
          st.skip('Low-level compileCallback interface not implemented by this compiler version.');
          st.end();
          return;
        }

        const input = {
          'b.hyp': 'import "a.hyp"; contract B { function g() public { f(); } }'
        };
        function findImports (path) {
          return { error: 'File not found' };
        }
        const output = JSON.parse(hypc.lowlevel.compileCallback(JSON.stringify({ sources: input }), 0, { import: findImports }));
        st.plan(3);
        st.ok('errors' in output);
        // Check if the ParserError exists, but allow others too
        st.ok(output.errors.length >= 1);
        for (const error in output.errors) {
          // Error should be something like:
          //   cont.hyp:1:1: ParserError: Source "lib.hyp" not found: File not found
          //   cont.hyp:1:1: Error: Source "lib.hyp" not found: File not found
          if (output.errors[error].indexOf('Error') !== -1 && output.errors[error].indexOf('File not found') !== -1) {
            st.ok(true);
          } else if (output.errors[error].indexOf('not found: File not found') !== -1) {
            // 0.4.12 had its own weird way:
            //   b.hyp:1:1: : Source "a.hyp" not found: File not found
            st.ok(true);
          }
        }
        st.end();
      });

      t.test('lazy-loading callback works (with exception) (using lowlevel API)', function (st) {
        // <0.2.1 doesn't have this
        if (typeof hypc.lowlevel.compileCallback !== 'function') {
          st.skip('Low-level compileCallback interface not implemented by this compiler version.');
          st.end();
          return;
        }

        const input = {
          'b.hyp': 'import "a.hyp"; contract B { function g() public { f(); } }'
        };
        function findImports (path) {
          throw new Error('Could not implement this interface properly...');
        }
        let output;
        st.doesNotThrow(function () {
          output = JSON.parse(hypc.lowlevel.compileCallback(JSON.stringify({ sources: input }), 0, { import: findImports }));
        });
        st.ok('errors' in output);
        // The exception is reported as the import error, so that it does not unwind through the
        // compiler (CIPH-HYPERION-16). Error should be something like:
        //   b.hyp:1:1: ParserError: Source "a.hyp" not found: Callback threw Error: Could not implement this interface properly...
        st.ok(output.errors.some((error) => error.indexOf('not found: Callback threw Error: Could not implement this interface properly...') !== -1));
        st.end();
      });

      t.test('lazy-loading callback fails properly (with invalid callback) (using lowlevel API)', function (st) {
        // <0.2.1 doesn't have this
        if (typeof hypc.lowlevel.compileCallback !== 'function') {
          st.skip('Low-level compileCallback interface not implemented by this compiler version.');
          st.end();
          return;
        }

        const input = {
          'cont.hyp': 'import "lib.hyp"; contract x { function g() public { L.f(); } }'
        };
        st.throws(function () {
          hypc.lowlevel.compileCallback(JSON.stringify({ sources: input }), 0, 'this isn\'t a callback');
        }, /Invalid callback object specified./);
        st.end();
      });

      t.test('file import without lazy-loading callback fails properly (using lowlevel API)', function (st) {
        // <0.2.1 doesn't have this
        if (typeof hypc.lowlevel.compileCallback !== 'function') {
          st.skip('Low-level compileCallback interface not implemented by this compiler version.');
          st.end();
          return;
        }

        const input = {
          'b.hyp': 'import "a.hyp"; contract B is A { function g() public { f(); } }'
        };
        const output = JSON.parse(hypc.lowlevel.compileCallback(JSON.stringify({ sources: input })));
        st.plan(3);
        st.ok('errors' in output);
        // Check if the ParserError exists, but allow others too
        st.ok(output.errors.length >= 1);
        for (const error in output.errors) {
          // Error should be something like:
          //   cont.hyp:1:1: ParserError: Source "lib.hyp" not found: File import callback not supported
          //   cont.hyp:1:1: Error: Source "lib.hyp" not found: File import callback not supported
          if (output.errors[error].indexOf('Error') !== -1 && output.errors[error].indexOf('File import callback not supported') !== -1) {
            st.ok(true);
          } else if (output.errors[error].indexOf('not found: File import callback not supported') !== -1) {
            // 0.4.12 had its own weird way:
            //   b.hyp:1:1: : Source "a.hyp" not found: File import callback not supported
            st.ok(true);
          }
        }
        st.end();
      });

      t.test('compiling standard JSON (using lowlevel API)', function (st) {
        if (typeof hypc.lowlevel.compileStandard !== 'function') {
          st.skip('Low-level compileStandard interface not implemented by this compiler version.');
          st.end();
          return;
        }

        const input = {
          language: 'Hyperion',
          settings: {
            outputSelection: {
              '*': {
                '*': ['qrvm.bytecode']
              }
            }
          },
          sources: {
            'a.hyp': {
              content: 'contract A { function f() public returns (uint) { return 7; } }'
            },
            'b.hyp': {
              content: 'import "a.hyp"; contract B is A { function g() public { f(); } }'
            }
          }
        };

        function bytecodeExists (output, fileName, contractName) {
          try {
            return output.contracts[fileName][contractName].qrvm.bytecode.object.length > 0;
          } catch (e) {
            return false;
          }
        }

        const output = JSON.parse(hypc.lowlevel.compileStandard(JSON.stringify(input)));
        st.ok(bytecodeExists(output, 'a.hyp', 'A'));
        st.ok(bytecodeExists(output, 'b.hyp', 'B'));
        st.end();
      });

      t.test('invalid source code fails properly with standard JSON (using lowlevel API)', function (st) {
        if (typeof hypc.lowlevel.compileStandard !== 'function') {
          st.skip('Low-level compileStandard interface not implemented by this compiler version.');
          st.end();
          return;
        }

        const input = {
          language: 'Hyperion',
          settings: {
            outputSelection: {
              '*': {
                '*': ['qrvm.bytecode']
              }
            }
          },
          sources: {
            'x.hyp': {
              content: 'contract x { this is an invalid contract }'
            }
          }
        };
        const output = JSON.parse(hypc.lowlevel.compileStandard(JSON.stringify(input)));
        st.plan(3);
        st.ok('errors' in output);
        st.ok(output.errors.length >= 1);
        // Check if the ParserError exists, but allow others too
        for (const error in output.errors) {
          if (output.errors[error].type === 'ParserError') {
            st.ok(true);
          }
        }
        st.end();
      });

      t.test('compiling standard JSON (with callback) (using lowlevel API)', function (st) {
        if (typeof hypc.lowlevel.compileStandard !== 'function') {
          st.skip('Low-level compileStandard interface not implemented by this compiler version.');
          st.end();
          return;
        }

        const input = {
          language: 'Hyperion',
          settings: {
            outputSelection: {
              '*': {
                '*': ['qrvm.bytecode']
              }
            }
          },
          sources: {
            'b.hyp': {
              content: 'import "a.hyp"; contract B is A { function g() public { f(); } }'
            }
          }
        };

        function findImports (path) {
          if (path === 'a.hyp') {
            return { contents: 'contract A { function f() public returns (uint) { return 7; } }' };
          } else {
            return { error: 'File not found' };
          }
        }

        function bytecodeExists (output, fileName, contractName) {
          try {
            return output.contracts[fileName][contractName].qrvm.bytecode.object.length > 0;
          } catch (e) {
            return false;
          }
        }

        const output = JSON.parse(hypc.lowlevel.compileStandard(JSON.stringify(input), { import: findImports }));
        st.ok(bytecodeExists(output, 'a.hyp', 'A'));
        st.ok(bytecodeExists(output, 'b.hyp', 'B'));
        st.end();
      });

      t.test('compiling standard JSON (single file)', function (st) {
        const input = {
          language: 'Hyperion',
          settings: {
            outputSelection: {
              '*': {
                '*': ['qrvm.bytecode', 'qrvm.gasEstimates']
              }
            }
          },
          sources: {
            'c.hyp': {
              content: 'contract C { function g() public { } function h() internal {} }'
            }
          }
        };

        const output = JSON.parse(hypc.compile(JSON.stringify(input)));
        st.ok(expectNoError(output));
        const C = getBytecodeStandard(output, 'c.hyp', 'C');
        st.ok(typeof C === 'string');
        st.ok(C.length > 0);
        const CGas = getGasEstimate(output, 'c.hyp', 'C');
        st.ok(typeof CGas === 'object');
        st.ok(typeof CGas.creation === 'object');
        st.ok(typeof CGas.creation.codeDepositCost === 'string');
        st.ok(typeof CGas.external === 'object');
        st.ok(typeof CGas.external['g()'] === 'string');
        st.ok(typeof CGas.internal === 'object');
        st.ok(typeof CGas.internal['h()'] === 'string');
        st.end();
      });

      t.test('compiling standard JSON (multiple files)', function (st) {
        // <0.1.6 doesn't have this
        if (!hypc.features.multipleInputs) {
          st.skip('Not supported by hypc');
          st.end();
          return;
        }

        const input = {
          language: 'Hyperion',
          settings: {
            outputSelection: {
              '*': {
                '*': ['qrvm.bytecode', 'qrvm.gasEstimates']
              }
            }
          },
          sources: {
            'a.hyp': {
              content: 'contract A { function f() public returns (uint) { return 7; } }'
            },
            'b.hyp': {
              content: 'import "a.hyp"; contract B is A { function g() public { f(); } function h() internal {} }'
            }
          }
        };

        const output = JSON.parse(hypc.compile(JSON.stringify(input)));
        st.ok(expectNoError(output));
        const B = getBytecodeStandard(output, 'b.hyp', 'B');
        st.ok(typeof B === 'string');
        st.ok(B.length > 0);
        st.ok(Object.keys(linker.findLinkReferences(B)).length === 0);
        const BGas = getGasEstimate(output, 'b.hyp', 'B');
        st.ok(typeof BGas === 'object');
        st.ok(typeof BGas.creation === 'object');
        st.ok(typeof BGas.creation.codeDepositCost === 'string');
        st.ok(typeof BGas.external === 'object');
        st.ok(typeof BGas.external['g()'] === 'string');
        st.ok(typeof BGas.internal === 'object');
        st.ok(typeof BGas.internal['h()'] === 'string');
        const A = getBytecodeStandard(output, 'a.hyp', 'A');
        st.ok(typeof A === 'string');
        st.ok(A.length > 0);
        st.end();
      });

      t.test('compiling standard JSON (abstract contract)', function (st) {
        // <0.1.6 doesn't have this
        if (!hypc.features.multipleInputs) {
          st.skip('Not supported by hypc');
          st.end();
          return;
        }

        const source = 'abstract contract C { function f() public virtual; }';

        const input = {
          language: 'Hyperion',
          settings: {
            outputSelection: {
              '*': {
                '*': ['qrvm.bytecode', 'qrvm.gasEstimates']
              }
            }
          },
          sources: {
            'c.hyp': {
              content: source
            }
          }
        };

        const output = JSON.parse(hypc.compile(JSON.stringify(input)));
        st.ok(expectNoError(output));
        const C = getBytecodeStandard(output, 'c.hyp', 'C');
        st.ok(typeof C === 'string');
        st.ok(C.length === 0);
        st.end();
      });

      t.test('compiling standard JSON (with imports)', function (st) {
        // <0.2.1 doesn't have this
        if (!hypc.features.importCallback) {
          st.skip('Not supported by hypc');
          st.end();
          return;
        }

        const input = {
          language: 'Hyperion',
          settings: {
            outputSelection: {
              '*': {
                '*': ['qrvm.bytecode']
              }
            }
          },
          sources: {
            'b.hyp': {
              content: 'import "a.hyp"; contract B is A { function g() public { f(); } }'
            }
          }
        };

        function findImports (path) {
          if (path === 'a.hyp') {
            return { contents: 'contract A { function f() public returns (uint) { return 7; } }' };
          } else {
            return { error: 'File not found' };
          }
        }

        const output = JSON.parse(hypc.compile(JSON.stringify(input), { import: findImports }));
        st.ok(expectNoError(output));
        const A = getBytecodeStandard(output, 'a.hyp', 'A');
        st.ok(typeof A === 'string');
        st.ok(A.length > 0);
        const B = getBytecodeStandard(output, 'b.hyp', 'B');
        st.ok(typeof B === 'string');
        st.ok(B.length > 0);
        st.ok(Object.keys(linker.findLinkReferences(B)).length === 0);
        st.end();
      });

      t.test('compiling standard JSON (import callback throws)', function (st) {
        // <0.2.1 doesn't have this
        if (!hypc.features.importCallback) {
          st.skip('Not supported by hypc');
          st.end();
          return;
        }

        const input = {
          language: 'Hyperion',
          settings: {
            outputSelection: {
              '*': {
                '*': ['qrvm.bytecode']
              }
            }
          },
          sources: {
            'b.hyp': {
              content: 'import "a.hyp"; contract B is A { function g() public { f(); } }'
            }
          }
        };

        function findImports (path) {
          throw new Error('Could not implement this interface properly...');
        }

        let output;
        st.doesNotThrow(function () {
          output = JSON.parse(hypc.compile(JSON.stringify(input), { import: findImports }));
        });
        // The exception is reported as the import error, so that it does not unwind through the
        // compiler and leave it unusable (CIPH-HYPERION-16).
        st.ok(expectError(output, 'ParserError', /^Source "a\.hyp" not found: Callback threw Error: Could not implement this interface properly\.\.\.$/));
        st.end();
      });

      t.test('compiling standard JSON (import callback returns no object)', function (st) {
        // <0.2.1 doesn't have this
        if (!hypc.features.importCallback) {
          st.skip('Not supported by hypc');
          st.end();
          return;
        }

        const input = {
          language: 'Hyperion',
          settings: {
            outputSelection: {
              '*': {
                '*': ['qrvm.bytecode']
              }
            }
          },
          sources: {
            'b.hyp': {
              content: 'import "a.hyp"; contract B is A { function g() public { f(); } }'
            }
          }
        };

        function findImports (path) {
          return undefined;
        }

        let output;
        st.doesNotThrow(function () {
          output = JSON.parse(hypc.compile(JSON.stringify(input), { import: findImports }));
        });
        st.ok(expectError(output, 'ParserError', /^Source "a\.hyp" not found: Callback returned undefined instead of an object with contents or error\.$/));
        st.end();
      });

      t.test('compiling standard JSON (import callback returns no usable object)', function (st) {
        // <0.2.1 doesn't have this
        if (!hypc.features.importCallback) {
          st.skip('Not supported by hypc');
          st.end();
          return;
        }

        const input = {
          language: 'Hyperion',
          settings: {
            outputSelection: {
              '*': {
                '*': ['qrvm.bytecode']
              }
            }
          },
          sources: {
            'b.hyp': {
              content: 'import "a.hyp"; contract B is A { function g() public { f(); } }'
            }
          }
        };

        // Each result is reported as the import error, instead of leaving the compiler to say
        // "Callback not supported." about a callback that was there.
        const cases = [
          { result: null, message: 'Callback returned null instead of an object with contents or error.' },
          { result: 'contract A { }', message: 'Callback returned a string instead of an object with contents or error.' },
          { result: ['contract A { }'], message: 'Callback returned an array instead of an object with contents or error.' },
          { result: {}, message: 'Callback returned an object with neither contents nor error.' },
          { result: { contents: Buffer.from('contract A { }') }, message: 'Callback returned an object as contents instead of a string.' },
          { result: { contents: 42 }, message: 'Callback returned a number as contents instead of a string.' },
          { result: { error: new Error('disk on fire') }, message: 'Error: disk on fire' }
        ];
        for (const { result, message } of cases) {
          let output;
          st.doesNotThrow(function () {
            output = JSON.parse(hypc.compile(JSON.stringify(input), { import: () => result }));
          });
          st.ok(
            expectError(output, 'ParserError', `^Source "a\\.hyp" not found: ${message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
            `reports: ${message}`
          );
        }
        st.end();
      });

      t.test('compiling standard JSON (using libraries)', function (st) {
        // <0.1.6 doesn't have this
        if (!hypc.features.multipleInputs) {
          st.skip('Not supported by hypc');
          st.end();
          return;
        }

        const input = {
          language: 'Hyperion',
          settings: {
            libraries: {
              'lib.hyp': {
                L: 'Q42424242424242424242424242424242424242424242424242424242424242424242424242424242424242424242424242424242424242424242424242424242'
              }
            },
            outputSelection: {
              '*': {
                '*': ['qrvm.bytecode']
              }
            }
          },
          sources: {
            'lib.hyp': {
              content: 'library L { function f() public returns (uint) { return 7; } }'
            },
            'a.hyp': {
              content: 'import "lib.hyp"; contract A { function g() public { L.f(); } }'
            }
          }
        };

        const output = JSON.parse(hypc.compile(JSON.stringify(input)));
        st.ok(expectNoError(output));
        const A = getBytecodeStandard(output, 'a.hyp', 'A');
        st.ok(typeof A === 'string');
        st.ok(A.length > 0);
        st.ok(Object.keys(linker.findLinkReferences(A)).length === 0);
        const L = getBytecodeStandard(output, 'lib.hyp', 'L');
        st.ok(typeof L === 'string');
        st.ok(L.length > 0);
        st.end();
      });

      t.test('compiling standard JSON (with warning >=0.0.1)', function (st) {
        const input = {
          language: 'Hyperion',
          settings: {
            outputSelection: {
              '*': {
                '*': ['qrvm.bytecode']
              }
            }
          },
          sources: {
            'c.hyp': {
              content: 'contract C { function f() public { } }'
            }
          }
        };

        const output = JSON.parse(hypc.compile(JSON.stringify(input)));
        st.ok(expectError(output, 'Warning', 'Source file does not specify required compiler version!'));
        st.end();
      });

      t.test('compiling standard JSON (using libraries) (using lowlevel API)', function (st) {
        if (typeof hypc.lowlevel.compileStandard !== 'function') {
          st.skip('Low-level compileStandard interface not implemented by this compiler version.');
          st.end();
          return;
        }

        const input = {
          language: 'Hyperion',
          settings: {
            libraries: {
              'lib.hyp': {
                L: 'Q42424242424242424242424242424242424242424242424242424242424242424242424242424242424242424242424242424242424242424242424242424242'
              }
            },
            outputSelection: {
              '*': {
                '*': ['qrvm.bytecode']
              }
            }
          },
          sources: {
            'lib.hyp': {
              content: 'library L { function f() public returns (uint) { return 7; } }'
            },
            'a.hyp': {
              content: 'import "lib.hyp"; contract A { function g() public { L.f(); } }'
            }
          }
        };

        const output = JSON.parse(hypc.lowlevel.compileStandard(JSON.stringify(input)));
        st.ok(expectNoError(output));
        const A = getBytecodeStandard(output, 'a.hyp', 'A');
        st.ok(typeof A === 'string');
        st.ok(A.length > 0);
        st.ok(Object.keys(linker.findLinkReferences(A)).length === 0);
        const L = getBytecodeStandard(output, 'lib.hyp', 'L');
        st.ok(typeof L === 'string');
        st.ok(L.length > 0);
        st.end();
      });

      t.test('compiling standard JSON (invalid JSON)', function (st) {
        const output = JSON.parse(hypc.compile('{invalid'));
        // TODO: change wrapper to output matching error
        st.ok(expectError(output, 'JSONError', 'Line 1, Column 2\n  Missing \'}\' or object member name') || expectError(output, 'JSONError', 'Invalid JSON supplied:'));
        st.end();
      });

      t.test('compiling standard JSON (invalid language)', function (st) {
        const output = JSON.parse(hypc.compile('{"language":"InvalidHyperion","sources":{"cont.hyp":{"content":""}}}'));
        st.ok(expectError(output, 'JSONError', 'supported as a language.') && expectError(output, 'JSONError', '"Hyperion"'));
        st.end();
      });

      t.test('compiling standard JSON (no sources)', function (st) {
        const output = JSON.parse(hypc.compile('{"language":"Hyperion"}'));
        st.ok(expectError(output, 'JSONError', 'No input sources specified.'));
        st.end();
      });

      t.test('compiling standard JSON (multiple sources on old compiler)', function (st) {
        const output = JSON.parse(hypc.compile('{"language":"Hyperion","sources":{"cont.hyp":{"content":"import \\"lib.hyp\\";"},"lib.hyp":{"content":""}}}'));
        if (hypc.features.multipleInputs) {
          st.ok(expectNoError(output));
        } else {
          st.ok(expectError(output, 'JSONError', 'Multiple sources provided, but compiler only supports single input.') || expectError(output, 'Parser error', 'Parser error: Source not found.'));
        }
        st.end();
      });

      t.test('compiling standard JSON (file names containing symbols)', function (st) {
        const input = {
          language: 'Hyperion',
          settings: {
            outputSelection: {
              '*': {
                '*': ['qrvm.bytecode']
              }
            }
          },
          sources: {
            '!@#$%^&*()_+-=[]{}\\|"\';:~`<>,.?/': {
              content: 'contract C {}'
            }
          }
        };

        const output = JSON.parse(hypc.compile(JSON.stringify(input)));
        st.ok(expectNoError(output));
        const C = getBytecodeStandard(output, '!@#$%^&*()_+-=[]{}\\|"\';:~`<>,.?/', 'C');
        st.ok(typeof C === 'string');
        st.ok(C.length > 0);
        st.end();
      });

      t.test('compiling standard JSON (file names containing multiple semicolons)', function (st) {
        const input = {
          language: 'Hyperion',
          settings: {
            outputSelection: {
              '*': {
                '*': ['qrvm.bytecode']
              }
            }
          },
          sources: {
            'a:b:c:d:e:f:G.hyp': {
              content: 'contract G {}'
            }
          }
        };

        const output = JSON.parse(hypc.compile(JSON.stringify(input)));
        st.ok(expectNoError(output));
        const G = getBytecodeStandard(output, 'a:b:c:d:e:f:G.hyp', 'G');
        st.ok(typeof G === 'string');
        st.ok(G.length > 0);
        st.end();
      });

      t.test('compiling standard JSON (input larger than the wasm stack)', function (st) {
        // The input is handed to the compiler as a pointer to a copy in its own memory (see
        // bindings/compile.ts). Passed as an Emscripten 'string' argument it was copied onto the
        // wasm stack, which overflowed from about 1.3 million characters: the compilation then
        // threw a RuntimeError, and the module instance had to be replaced.
        const padding = `\n// ${'x'.repeat(1500000)}\n`;
        const compileWith = (content) => JSON.parse(hypc.compile(JSON.stringify({
          language: 'Hyperion',
          settings: { outputSelection: { '*': { '*': ['qrvm.bytecode'] } } },
          sources: { 'big.hyp': { content: content + padding } }
        })));

        let output = compileWith('contract C { function f() public pure returns (uint) { return 1; } }');
        st.ok(expectNoError(output));
        const C = getBytecodeStandard(output, 'big.hyp', 'C');
        st.ok(typeof C === 'string');
        st.ok(C.length > 0);

        output = compileWith('contract C { this is an invalid contract }');
        st.ok(expectError(output, 'ParserError', /expected/i), 'a syntax error in a large input is reported, not thrown');
        st.end();
      });
    });
  });

  // Only run on the latest version.
  if (versionText === 'latest' && !noRemoteVersions) {
    tape('Loading Legacy Versions', function (t) {
      t.test('loading remote version - latest release', function (st) {
        // getting the latest release
        st.plan(2);
        hypc.loadRemoteVersion('latest', function (err, hypcSnapshot) {
          if (err) {
            st.plan(1);
            st.skip('Network error - skipping remote loading test');
            st.end();
            return;
          }
          const input = {
            language: 'Hyperion',
            settings: {
              outputSelection: {
                '*': {
                  '*': ['qrvm.bytecode']
                }
              }
            },
            sources: {
              'cont.hyp': {
                content: 'contract x { function g() public {} }'
              }
            }
          };
          const output = JSON.parse(hypcSnapshot.compile(JSON.stringify(input)));
          const x = getBytecodeStandard(output, 'cont.hyp', 'x');
          st.ok(typeof x === 'string');
          st.ok(x.length > 0);
        });
      });
    });
  }
}

runTests(hypc, 'latest');

if (!noRemoteVersions) {
  // New compiler interface features 0.0.1
  const versions = [
    'v0.0.1+commit.360d2d05',
    'v0.1.0+commit.4b493011'
  ];
  for (let version in versions) {
    version = versions[version];
    // NOTE: The temporary directory will be removed on process exit.
    const tempDir = tmp.dirSync({ unsafeCleanup: true, prefix: 'hypc-js-compiler-test-' }).name;
    execSync(`curl -L -o ${tempDir}/${version}.js https://binaries.theqrl.org/bin/hypjson-${version}.js`);
    const newHypc = wrapper(require(`${tempDir}/${version}.js`));
    runTests(newHypc, version);
  }
}

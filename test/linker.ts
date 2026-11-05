import tape from 'tape';
import { shake256 } from 'js-sha3';
import hypc from '../';
import linker from '../linker';

const LIB_HYP_L_64_BYTE_HASH = '7b407da2c9e54c64181b59f93be76d2e1be3a7a0dd4078c3bae5ca6125235fe45e6d0232229f7006f00e49901dd0bb51b52ac3ea8beef0422713a65cf0';
const LIB_HYP_L_64_BYTE_PLACEHOLDER = `__$${LIB_HYP_L_64_BYTE_HASH}$__`;
const ADDRESS_64_BYTES = '42'.repeat(64);
const PREFIXED_ADDRESS_64_BYTES = `Q${ADDRESS_64_BYTES}`;

function oldStylePlaceholder (libraryName) {
  return `__${libraryName.slice(0, 124).padEnd(124, '_')}__`;
}

tape('Link references', function (t) {
  t.test('Empty bytecode', function (st) {
    st.deepEqual(linker.findLinkReferences(''), {});
    st.end();
  });

  t.test('No references', function (st) {
    st.deepEqual(linker.findLinkReferences('6060604052341561000f57600080fd'), {});
    st.end();
  });

  t.test('One 64-byte hashed reference', function (st) {
    const bytecode = `6060${LIB_HYP_L_64_BYTE_PLACEHOLDER}6060`;
    st.deepEqual(
      linker.findLinkReferences(bytecode),
      { [`$${LIB_HYP_L_64_BYTE_HASH}$`]: [{ start: 2, length: 64 }] }
    );
    st.end();
  });

  t.test('One 64-byte old-style reference', function (st) {
    const bytecode = `6060${oldStylePlaceholder('lib.hyp:L')}6060`;
    st.deepEqual(
      linker.findLinkReferences(bytecode),
      { 'lib.hyp:L': [{ start: 2, length: 64 }] }
    );
    st.end();
  });

  t.test('Two references with same library name', function (st) {
    const bytecode = `6060${oldStylePlaceholder('lib.hyp:L')}6060${oldStylePlaceholder('lib.hyp:L')}6060`;
    st.deepEqual(
      linker.findLinkReferences(bytecode),
      { 'lib.hyp:L': [{ start: 2, length: 64 }, { start: 68, length: 64 }] }
    );
    st.end();
  });

  t.test('Invalid 20-byte reference is ignored', function (st) {
    const bytecode = '6060__$7484607a72fb0587588e5a1e608f0b16de$__6060';
    st.deepEqual(linker.findLinkReferences(bytecode), {});
    st.end();
  });
});

tape('Linking', function (t) {
  t.test('64-byte hashed placeholder', function (st) {
    let bytecode = `6060${LIB_HYP_L_64_BYTE_PLACEHOLDER}6060`;
    bytecode = linker.linkBytecode(bytecode, { 'lib.hyp:L': PREFIXED_ADDRESS_64_BYTES });
    st.equal(bytecode, `6060${ADDRESS_64_BYTES}6060`);
    st.end();
  });

  t.test('64-byte old-style placeholder', function (st) {
    let bytecode = `6060${oldStylePlaceholder('lib.hyp:L')}6060`;
    bytecode = linker.linkBytecode(bytecode, { 'lib.hyp:L': PREFIXED_ADDRESS_64_BYTES });
    st.equal(bytecode, `6060${ADDRESS_64_BYTES}6060`);
    st.end();
  });

  t.test('64-byte old-style placeholder with two-level configuration', function (st) {
    let bytecode = `6060${oldStylePlaceholder('lib.hyp:L')}6060`;
    bytecode = linker.linkBytecode(bytecode, { 'lib.hyp': { L: PREFIXED_ADDRESS_64_BYTES } });
    st.equal(bytecode, `6060${ADDRESS_64_BYTES}6060`);
    st.end();
  });

  t.test('missing library leaves placeholder unresolved', function (st) {
    const bytecode = `6060${oldStylePlaceholder('lib.hyp:L')}6060`;
    st.equal(linker.linkBytecode(bytecode, {}), bytecode);
    st.end();
  });

  t.test('short address is invalid', function (st) {
    const bytecode = `6060${oldStylePlaceholder('lib.hyp:L')}6060`;
    st.throws(function () {
      linker.linkBytecode(bytecode, { 'lib.hyp:L': 'Q123456' });
    });
    st.end();
  });

  t.test('non-hex address is invalid', function (st) {
    const bytecode = `6060${oldStylePlaceholder('lib.hyp:L')}6060`;
    st.throws(function () {
      linker.linkBytecode(bytecode, { 'lib.hyp:L': `Q${'z'.repeat(128)}` });
    });
    st.end();
  });

  t.test('address checksum matches the compiler', function (st) {
    // A mixed-case address must carry the checksum; the compiler enforces the same rule for
    // settings.libraries, so it is the reference here.
    const body = '0123456789abcdef'.repeat(8);
    const hash = shake256(body, 512);
    const checksummed = 'Q' + [...body].map((c, i) => (/[a-f]/.test(c) && parseInt(hash[i], 16) >= 8 ? c.toUpperCase() : c)).join('');
    const firstLetter = checksummed.search(/[a-fA-F]/);
    const flipped = checksummed[firstLetter] === checksummed[firstLetter].toLowerCase()
      ? checksummed[firstLetter].toUpperCase()
      : checksummed[firstLetter].toLowerCase();
    const wrongCase = checksummed.slice(0, firstLetter) + flipped + checksummed.slice(firstLetter + 1);
    st.ok(/[a-f]/.test(checksummed) && /[A-F]/.test(checksummed), 'test address is mixed case');

    const compileWithLibrary = (address) => JSON.parse(hypc.compile(JSON.stringify({
      language: 'Hyperion',
      sources: { 'lib.hyp': { content: 'library L { function f() external {} }' } },
      settings: { libraries: { 'lib.hyp': { L: address } } }
    })));
    st.notOk((compileWithLibrary(checksummed).errors || []).some((e) => e.severity === 'error'), 'compiler accepts the checksummed address');
    st.ok((compileWithLibrary(wrongCase).errors || []).some((e) => /Invalid library address/.test(e.message)), 'compiler rejects a wrong checksum');

    const bytecode = `6060${LIB_HYP_L_64_BYTE_PLACEHOLDER}6060`;
    st.equal(linker.linkBytecode(bytecode, { 'lib.hyp': { L: checksummed } }), `6060${checksummed.slice(1)}6060`);
    st.equal(linker.linkBytecode(bytecode, { 'lib.hyp': { L: `Q${body}` } }), `6060${body}6060`, 'all lower case needs no checksum');
    st.equal(linker.linkBytecode(bytecode, { 'lib.hyp': { L: `Q${body.toUpperCase()}` } }), `6060${body.toUpperCase()}6060`, 'all upper case needs no checksum');
    st.throws(function () {
      linker.linkBytecode(bytecode, { 'lib.hyp': { L: wrongCase } });
    }, /Invalid address checksum specified for (lib\.hyp:)?L$/);
    st.end();
  });

  t.test('20-byte placeholder is not linked', function (st) {
    const bytecode = '6060__$7484607a72fb0587588e5a1e608f0b16de$__6060';
    st.equal(linker.linkBytecode(bytecode, { 'lib2.hyp:L': PREFIXED_ADDRESS_64_BYTES }), bytecode);
    st.end();
  });
});

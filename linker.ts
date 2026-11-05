import assert from 'assert';
import { keccak256, shake256 } from 'js-sha3';
import { isNil, isObject } from './common/helpers';
import { LibraryAddresses, LinkReferences } from './common/types';

const ADDRESS_HEX_LENGTH = 128;
const ADDRESS_PREFIX = 'Q';
const PREFIXED_ADDRESS_LENGTH = ADDRESS_HEX_LENGTH + ADDRESS_PREFIX.length;
const PLACEHOLDER_MARKER_LENGTH = 4;
const HASH_PLACEHOLDER_MARKER_LENGTH = 6;
const PLACEHOLDER_BODY_LENGTH = ADDRESS_HEX_LENGTH - PLACEHOLDER_MARKER_LENGTH;
const HASH_PLACEHOLDER_BODY_LENGTH = ADDRESS_HEX_LENGTH - HASH_PLACEHOLDER_MARKER_LENGTH;

/**
 * Generates a new-style library placeholder from a fully-qualified library name.
 *
 * Newer versions of the compiler use hashed names instead of just truncating the name
 * before putting it in a placeholder.
 *
 * @param fullyQualifiedLibraryName Fully qualified library name.
 */
function libraryHash (fullyQualifiedLibraryName, length) {
  let hash = keccak256(fullyQualifiedLibraryName);

  while (hash.length < length) {
    hash += keccak256(hash);
  }

  return hash.slice(0, length);
}

function libraryHashPlaceholder (fullyQualifiedLibraryName) {
  return `$${libraryHash(fullyQualifiedLibraryName, HASH_PLACEHOLDER_BODY_LENGTH)}$`;
}

/**
 * Applies the compiler's address checksum to a hex address body: a letter is upper case when
 * the matching nibble of SHAKE-256 (64 bytes) of the lower-case body is 8 or more.
 * Mirrors `checksummedAddressBody` in hyperion's libhyputil/CommonData.cpp.
 */
function checksummedAddressBody (body: string): string {
  const lower = body.toLowerCase();
  const hash = shake256(lower, ADDRESS_HEX_LENGTH * 4);
  return [...lower].map((c, i) => (c >= 'a' && c <= 'f' && parseInt(hash[i], 16) >= 8 ? c.toUpperCase() : c)).join('');
}

/**
 * Accepts an all-lower-case or all-upper-case body, or a mixed-case body with a valid checksum,
 * as the compiler does for `settings.libraries`.
 */
function passesAddressChecksum (body: string): boolean {
  return body === body.toLowerCase() || body === body.toUpperCase() || body === checksummedAddressBody(body);
}

/**
 * Finds all placeholders corresponding to the specified library label and replaces them
 * with a concrete address. Works with both hex-encoded and binary bytecode as long as
 * the address is in the same format.
 *
 * @param bytecode Bytecode string.
 *
 * @param label Library label, either old- or new-style. Must exactly match the part between `__` markers in the
 *     placeholders. Will be padded with `_` characters if too short or truncated if too long.
 *
 * @param address Address to replace placeholders with. Must be the right length.
 *     It will **not** be padded with zeros if too short.
 */
function replacePlaceholder (bytecode, label, address) {
  const truncatedName = label.slice(0, PLACEHOLDER_BODY_LENGTH);
  const libLabel = `__${truncatedName.padEnd(PLACEHOLDER_BODY_LENGTH, '_')}__`;

  while (bytecode.indexOf(libLabel) >= 0) {
    bytecode = bytecode.replace(libLabel, address);
  }

  return bytecode;
}

/**
 * Finds and all library placeholders in the provided bytecode and replaces them with actual addresses.
 * Supports both old- and new-style placeholders (even both in the same file).
 * See [Library Linking](https://docs.soliditylang.org/en/latest/using-the-compiler.html#library-linking)
 * for a full explanation of the linking process.
 *
 * Example of an old-style placeholder: `__lib.hyp:L...__` padded to 64 bytes.
 * Example of a new-style placeholder: `__$<122 hex characters>$__`
 *
 * @param bytecode Hex-encoded bytecode string. All 64-byte substrings starting and ending with
 *     `__` will be interpreted as placeholders.
 *
 * @param libraries Mapping between fully qualified library names and the hex-encoded
 *     addresses they should be replaced with.
 *
 * @returns bytecode Hex-encoded bytecode string with placeholders replaced with addresses.
 *    Note that some placeholders may remain in the bytecode if `libraries` does not provide addresses for all of them.
 */
function linkBytecode (bytecode: string, libraries: LibraryAddresses): string {
  assert(typeof bytecode === 'string');
  assert(typeof libraries === 'object');

  // NOTE: for backwards compatibility support old compiler which didn't use file names
  const librariesComplete: { [fullyQualifiedLibraryName: string]: string } = {};

  for (const [fullyQualifiedLibraryName, libraryObjectOrAddress] of Object.entries(libraries)) {
    if (isNil(libraryObjectOrAddress)) {
      throw new Error(`No address provided for library ${fullyQualifiedLibraryName}`);
    }

    // API compatible with the standard JSON i/o
    // {"lib.hyp": {"L": "Q..."}}
    if (isObject(libraryObjectOrAddress)) {
      for (const [unqualifiedLibraryName, address] of Object.entries(libraryObjectOrAddress)) {
        librariesComplete[unqualifiedLibraryName] = address;
        librariesComplete[`${fullyQualifiedLibraryName}:${unqualifiedLibraryName}`] = address;
      }

      continue;
    }

    // backwards compatible API for early hypc-js versions
    const parsed = fullyQualifiedLibraryName.match(/^(?<sourceUnitName>[^:]+):(?<unqualifiedLibraryName>.+)$/);
    const libraryAddress = libraryObjectOrAddress as string;

    if (!isNil(parsed)) {
      const { unqualifiedLibraryName } = parsed.groups;
      librariesComplete[unqualifiedLibraryName] = libraryAddress;
    }

    librariesComplete[fullyQualifiedLibraryName] = libraryAddress;
  }

  for (const libraryName in librariesComplete) {
    let hexAddress = librariesComplete[libraryName];

    if (
      !hexAddress.startsWith(ADDRESS_PREFIX) ||
      hexAddress.length !== PREFIXED_ADDRESS_LENGTH ||
      !/^[0-9a-fA-F]+$/.test(hexAddress.slice(ADDRESS_PREFIX.length))
    ) {
      throw new Error(`Invalid address specified for ${libraryName}`);
    }

    // remove address prefix
    hexAddress = hexAddress.slice(ADDRESS_PREFIX.length);

    if (!passesAddressChecksum(hexAddress)) {
      throw new Error(`Invalid address checksum specified for ${libraryName}`);
    }

    bytecode = replacePlaceholder(bytecode, libraryName, hexAddress);
    bytecode = replacePlaceholder(bytecode, libraryHashPlaceholder(libraryName), hexAddress);
  }

  return bytecode;
}

/**
 * Finds locations of all library address placeholders in the hex-encoded bytecode.
 * Returns information in a format matching `qrvm.bytecode.linkReferences` output
 * in Standard JSON.
 *
 * See [Library Linking](https://docs.soliditylang.org/en/latest/using-the-compiler.html#library-linking)
 * for a full explanation of library placeholders and linking process.
 *
 * WARNING: The output matches `qrvm.bytecode.linkReferences` exactly only in
 * case of old-style placeholders created from fully qualified library names
 * of no more than 36 characters, and even then only if the name does not start
 * or end with an underscore. This is different from
 * `qrvm.bytecode.linkReferences`, which uses fully qualified library names.
 * This is a limitation of the placeholder format - the fully qualified names
 * are not preserved in the compiled bytecode and cannot be reconstructed
 * without external information.
 *
 * @param bytecode Hex-encoded bytecode string.
 *
 * @returns linkReferences A mapping between library labels and their locations
 * in the bytecode. In case of old-style placeholders the label is a fully
 * qualified library name truncated to 124 characters. For new-style placeholders
 * it's the address-width hash label of the fully qualified library name, with a leading
 * and trailing $ character added. Note that the
 * offsets and lengths refer to the *binary* (not hex-encoded) bytecode, just
 * like in `qrvm.bytecode.linkReferences`.
 */
function findLinkReferences (bytecode: string): LinkReferences {
  assert(typeof bytecode === 'string');

  // find 64-byte placeholders in the pattern of __...__
  // e.g. __Lib.hyp:L_____________________________ or __$<122 hex digits>$__
  const linkReferences: LinkReferences = {};

  const placeholderPattern = /__(.{124})__/g;
  let found;

  while ((found = placeholderPattern.exec(bytecode)) !== null) {
    const start = found.index;
    const placeholder = found[1];

    // trim trailing underscores
    // NOTE: this has no way of knowing if the trailing underscore was part of the name
    const libraryName = placeholder.replace(/_+$/gm, '');

    if (!linkReferences[libraryName]) {
      linkReferences[libraryName] = [];
    }

    // offsets are in bytes in binary representation (and not hex)
    linkReferences[libraryName].push({
      start: start / 2,
      length: ADDRESS_HEX_LENGTH / 2
    });
  }

  return linkReferences;
}

export = {
  linkBytecode,
  findLinkReferences
};

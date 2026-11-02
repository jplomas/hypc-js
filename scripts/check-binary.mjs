#!/usr/bin/env node
// Release gate: the committed hypjson.js must be the compiler that theQRL/hyperion released for this
// package's version.
//   1. the compiler reports <package.json version>+commit.<hash>
//   2. keccak256 and sha256 equal the hypc-bin list.json entry for that version
//   3. sha256 equals the hypjson.js line of the theQRL/hyperion v<version> release SHA256SUMS
//   4. its build provenance attestation verifies (releases after 0.2.0, which predates attestations)
// Usage: node scripts/check-binary.mjs [--list path/to/hypc-bin/bin/list.json]
//   Without --list the live https://binaries.theqrl.org/bin/list.json is used.
//   Needs the GitHub CLI (`gh`); in CI set GH_TOKEN.
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const { keccak256 } = require('js-sha3');
const HYPERION = 'theQRL/hyperion';
// The only workflow that signs hyperion release assets; an attestation from any other workflow in
// the repository is rejected.
const HYPERION_RELEASE_WORKFLOW = `${HYPERION}/.github/workflows/ci.yml`;
const LAST_UNATTESTED = '0.2.0';

const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
let failed = false;
const fail = (m) => { console.error(`::error::${m}`); failed = true; };
const ok = (m) => console.log(`ok   ${m}`);

const version = require('./package.json').version;
const file = join(root, 'hypjson.js');
const bytes = readFileSync(file);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const keccak = keccak256(bytes);

// 1. reported version (load in a child so a broken binary cannot take this process down)
const r = spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(file)}).cwrap('hyperion_version','string',[])())`], { encoding: 'utf8' });
const reported = r.status === 0 ? r.stdout.trim() : '';
const m = /^(\d+\.\d+\.\d+)\+(commit\.[0-9a-f]{8})\./.exec(reported);
if (!m) fail(`hypjson.js did not report a release version (${reported || r.stderr.trim().split('\n').pop()})`);
else if (m[1] !== version) fail(`hypjson.js reports ${reported}, package.json is ${version}`);
else ok(`hypjson.js reports ${reported}`);

// 2. hypc-bin list.json
const listArg = process.argv.indexOf('--list');
const list = listArg > 0
  ? JSON.parse(readFileSync(process.argv[listArg + 1], 'utf8'))
  : await (await fetch('https://binaries.theqrl.org/bin/list.json')).json();
const path = list.releases?.[version];
const entry = list.builds?.find((b) => b.path === path);
if (!entry) fail(`hypc-bin list.json has no release ${version}; add the binary to hypc-bin first`);
else {
  if (m && entry.build !== m[2]) fail(`list.json ${version} is ${entry.longVersion}, hypjson.js is ${m[1]}+${m[2]}`);
  if (entry.keccak256 !== '0x' + keccak) fail(`keccak256 0x${keccak} != list.json ${entry.keccak256}`);
  else ok(`keccak256 matches hypc-bin list.json (${path})`);
  if (entry.sha256 !== '0x' + sha256) fail(`sha256 0x${sha256} != list.json ${entry.sha256}`);
  else ok('sha256 matches hypc-bin list.json');
}

// 3. hyperion release SHA256SUMS, 4. attestation
const work = mkdtempSync(join(tmpdir(), 'hypc-js-binary-'));
try {
  const dl = spawnSync('gh', ['release', 'download', `v${version}`, '--repo', HYPERION, '--pattern', 'SHA256SUMS', '--dir', work], { encoding: 'utf8' });
  if (dl.status !== 0) fail(`cannot download SHA256SUMS of ${HYPERION} v${version}: ${dl.stderr.trim()}`);
  else {
    const line = readFileSync(join(work, 'SHA256SUMS'), 'utf8').split('\n').find((l) => /\shypjson\.js$/.test(l));
    if (!line) fail(`${HYPERION} v${version} SHA256SUMS has no hypjson.js line`);
    else if (line.split(/\s+/)[0] !== sha256) fail(`sha256 ${sha256} != ${HYPERION} v${version} SHA256SUMS ${line.split(/\s+/)[0]}`);
    else ok(`sha256 matches ${HYPERION} v${version} SHA256SUMS`);
  }
  if (cmp(version, LAST_UNATTESTED) <= 0) console.log(`skip build provenance: ${version} predates attested hyperion releases`);
  else {
    const att = spawnSync('gh', ['attestation', 'verify', file, '--repo', HYPERION, '--signer-workflow', HYPERION_RELEASE_WORKFLOW], { encoding: 'utf8' });
    if (att.status !== 0) fail(`build provenance attestation does not verify: ${(att.stderr || att.stdout).trim()}`);
    else ok(`build provenance attestation verifies against ${HYPERION_RELEASE_WORKFLOW}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

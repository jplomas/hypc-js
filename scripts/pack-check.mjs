#!/usr/bin/env node
// Build from a clean dist/, pack it once, and check the tarball:
//   - its hypjson.js is byte-identical to the committed compiler (no re-emission by tsc)
//   - its file list equals scripts/tarball-manifest.txt (run with --update-manifest to accept a change)
// The tarball is left in --out (default: out/); the release job publishes exactly that file.
// Usage: node scripts/pack-check.mjs [--out out] [--update-manifest]
import { readFileSync, writeFileSync, rmSync, mkdirSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outArg = process.argv.indexOf('--out');
const out = resolve(root, outArg > 0 ? process.argv[outArg + 1] : 'out');
const manifestPath = join(root, 'scripts', 'tarball-manifest.txt');
const sh = (cmd, args, env = {}) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });

rmSync(join(root, 'dist'), { recursive: true, force: true });
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
sh('npm', ['run', '--silent', 'build']);
const [packed] = JSON.parse(sh('npm', ['pack', './dist', '--json', '--pack-destination', out], { BYPASS_SAFETY_CHECK: 'true' }));
const tgz = join(out, packed.filename);
const files = packed.files.map((f) => f.path).sort();

let failed = false;
const tmp = mkdtempSync(join(tmpdir(), 'hypc-pack-'));
execFileSync('tar', ['-xzf', tgz, '-C', tmp, 'package/hypjson.js']);
if (!readFileSync(join(tmp, 'package/hypjson.js')).equals(readFileSync(join(root, 'hypjson.js')))) {
  console.error('::error::the packed hypjson.js differs from the committed compiler');
  failed = true;
} else console.log('ok   packed hypjson.js is byte-identical to the committed compiler');
rmSync(tmp, { recursive: true, force: true });

if (process.argv.includes('--update-manifest')) {
  writeFileSync(manifestPath, files.join('\n') + '\n');
  console.log(`wrote ${manifestPath} (${files.length} files)`);
} else {
  const want = readFileSync(manifestPath, 'utf8').trim().split('\n');
  const extra = files.filter((f) => !want.includes(f)); const missing = want.filter((f) => !files.includes(f));
  if (extra.length || missing.length) {
    console.error(`::error::tarball contents changed: +[${extra.join(', ')}] -[${missing.join(', ')}]; review, then run with --update-manifest`);
    failed = true;
  } else console.log(`ok   tarball contents match scripts/tarball-manifest.txt (${files.length} files)`);
}
console.log(`tarball: ${tgz}  sha256 ${createHash('sha256').update(readFileSync(tgz)).digest('hex')}`);
process.exit(failed ? 1 : 0);

# Release Process

`@theqrl/hypc` is published only by the `Release` workflow (`.github/workflows/release.yml`), from a
`v<version>` tag, through npm trusted publishing. There is no long-lived npm token and no manual
publish step.

The package version always equals the version of the bundled compiler (`hypjson.js`), so releases
are tag-driven rather than derived from commit messages.

## One-time setup (admins)

1. **npm trusted publisher.** On npmjs.com, open `@theqrl/hypc` → Settings → Trusted publishing and
   add a GitHub Actions publisher: organization `theQRL`, repository `hypc-js`, workflow
   `release.yml`, environment `npm-publish`. Then set Publishing access to *Require two-factor
   authentication and disallow tokens*, and revoke any existing automation or publish tokens.
2. **GitHub environment.** In this repository's Settings → Environments, create `npm-publish` with
   at least one required reviewer other than the person who pushes the tag, and restrict
   deployments to tags matching `v*`.
3. **Tag protection.** Add a tag ruleset for `v*` that blocks updates and deletions (see
   CIPH-HYPERION-28 and -29 in theQRL/audit-remediation).
4. Both npm maintainers keep two-factor authentication enabled.

## Releasing version X.Y.Z

The compiler must be released first; every later step verifies against it.

1. **hyperion.** Tag `vX.Y.Z` in theQRL/hyperion. CI builds the binaries, attests their build
   provenance and publishes the GitHub release with `hypjson.js` and `SHA256SUMS`.
2. **hypc-bin.** Run `node scripts/add-release.mjs X.Y.Z` in theQRL/hypc-bin, open a pull request
   and merge it. Its CI checks the binary against the hyperion release and its attestation.
3. **hypc-js pull request.** Set `"version": "X.Y.Z"` in `package.json` and run
   `npm run updateBinary` (downloads `hypjson.js` from binaries.theqrl.org and checks its keccak256
   against `list.json`). Commit the new `hypjson.js`, `package.json` and `package-lock.json`. The
   `binary` CI job must pass: it checks the reported version, the hypc-bin `list.json` hashes, the
   hyperion release `SHA256SUMS` and the build provenance attestation.
4. **Tag.** After the pull request is merged, tag the merge commit and push the tag:

   ```bash
   git tag -s vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z
   ```

5. **Approve.** The `Release` workflow runs CI again, then waits for approval of the `npm-publish`
   environment. Once approved it checks that the tagged commit is on `main` and stops the release if
   it is not. It then re-checks the binary, builds and packs once, smoke-tests that
   tarball, publishes those exact bytes with provenance, attests them, and creates the GitHub
   release with the tarball and `SHA256SUMS`.
6. **Registry check.** The `registry-verify` job downloads the version from npm and confirms it
   carries a provenance attestation, matches the GitHub release `SHA256SUMS`, and contains the
   hyperion `vX.Y.Z` `hypjson.js` byte for byte.

## Rules

- **Supersede, never backfill.** If a publish fails after the tag exists, fix forward with the next
  version. Never move or delete a tag, and never republish a version.
- **Package contents are reviewed.** `scripts/tarball-manifest.txt` lists every file in the
  tarball. If a change alters the contents on purpose, run
  `node scripts/pack-check.mjs --update-manifest` and include the manifest diff in the pull request.
- **No manual publishing.** `npm run build:tarball` and `npm run publish:tarball` remain only for
  local inspection; publishing from a workstation bypasses every check above.

## Verifying a release

```bash
npm audit signatures                                                    # in a project that depends on @theqrl/hypc
# tarball from the GitHub release
gh attestation verify theqrl-hypc-X.Y.Z.tgz --repo theQRL/hypc-js \
  --signer-workflow theQRL/hypc-js/.github/workflows/release.yml
# compiler (hyperion releases after 0.2.0)
gh attestation verify node_modules/@theqrl/hypc/hypjson.js --repo theQRL/hyperion \
  --signer-workflow theQRL/hyperion/.github/workflows/ci.yml
```

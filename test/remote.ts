import tape from 'tape';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PassThrough } from 'stream';
import { https } from 'follow-redirects';
import { keccak256 } from 'js-sha3';
import hypc from '../';

// loadRemoteVersion without the network: https.get is replaced by a stub that answers from a map
// of URL to body. A body is a string or Buffer, an array of Buffers sent as separate chunks, or a
// status code.
const BINARIES_URL = 'https://binaries.theqrl.org/bin/';
const BUILD_PATH = 'hypjson-v0.2.0+commit.e36a0aea.js';
const realGet = https.get;
const realBuild = fs.readFileSync(path.resolve(__dirname, '..', 'hypjson.js'));

function entry (buildPath, body) {
  return {
    path: buildPath,
    keccak256: '0x' + keccak256(body),
    sha256: '0x' + createHash('sha256').update(body).digest('hex')
  };
}

function listFor (build) {
  return JSON.stringify({ builds: [build], releases: { '0.2.0': build.path }, latestRelease: '0.2.0' });
}

function stub (responses) {
  const requests = [];
  https.get = function (url, options, callback) {
    requests.push({ url, options });
    const answer = responses[url];
    const response: any = new PassThrough();
    response.statusCode = answer === undefined ? 404 : typeof answer === 'number' ? answer : 200;
    response.statusMessage = response.statusCode === 200 ? 'OK' : 'Not Found';
    setImmediate(() => {
      callback(response);
      for (const chunk of (response.statusCode === 200 ? [].concat(answer) : [])) {
        response.write(chunk);
      }
      response.end();
    });
    return { on () { return this; } };
  };
  return requests;
}

function restore () {
  https.get = realGet;
}

function standardInput (content) {
  return JSON.stringify({
    language: 'Hyperion',
    sources: { 'a.hyp': { content } },
    settings: { outputSelection: { '*': { '*': ['abi'] } } }
  });
}

tape('Remote compiler versions', function (t) {
  t.test('loads a build that matches list.json', function (st) {
    stub({ [BINARIES_URL + 'list.json']: listFor(entry(BUILD_PATH, realBuild)), [BINARIES_URL + BUILD_PATH]: realBuild });
    hypc.loadRemoteVersion('v0.2.0+commit.e36a0aea', function (err, remote) {
      restore();
      st.error(err);
      st.equal(remote.version(), hypc.version());
      st.end();
    });
  });

  t.test('loads a fresh instance after an exception unwinds through the compiler', function (st) {
    // The served build publishes its module instance, so that the test can reach the one the
    // wrapper is using.
    const build = Buffer.concat([realBuild, Buffer.from('\nglobalThis.__hypcRemoteInstance = module.exports;\n')]);
    stub({ [BINARIES_URL + 'list.json']: listFor(entry(BUILD_PATH, build)), [BINARIES_URL + BUILD_PATH]: build });
    hypc.loadRemoteVersion('v0.2.0+commit.e36a0aea', function (err, remote) {
      restore();
      st.error(err);
      const first = (globalThis as any).__hypcRemoteInstance;
      const listeners = process.listenerCount('unhandledRejection');
      // The import callback answers, but storing the address of its answer for the compiler
      // fails inside the compiler's wasm frames (CIPH-HYPERION-16).
      first.setValue = () => { throw new Error('injected failure'); };
      st.throws(() => remote.compile(standardInput('import "b.hyp"; contract C is B {}'), { import: () => ({ contents: 'contract B {}' }) }), /injected failure/);
      const output = JSON.parse(remote.compile(standardInput('contract C {}')));
      st.notOk((output.errors || []).some((error) => error.severity === 'error'), 'the next compilation works');
      st.notEqual((globalThis as any).__hypcRemoteInstance, first, 'on a fresh instance from the downloaded source');
      st.equal(process.listenerCount('unhandledRejection'), listeners, 'which added no process listener');
      delete (globalThis as any).__hypcRemoteInstance;
      st.end();
    });
  });

  t.test('does not run a build that does not match list.json', function (st) {
    const tampered = 'globalThis.__hypcRemoteCodeRan = true; module.exports = {};';
    stub({ [BINARIES_URL + 'list.json']: listFor(entry(BUILD_PATH, realBuild)), [BINARIES_URL + BUILD_PATH]: tampered });
    hypc.loadRemoteVersion('v0.2.0+commit.e36a0aea', function (err) {
      restore();
      st.match(err && err.message, /does not match the keccak256 and sha256 in list\.json/);
      st.equal((globalThis as any).__hypcRemoteCodeRan, undefined, 'the tampered body did not run');
      st.end();
    });
  });

  t.test('reports a build that fails to load instead of throwing', function (st) {
    const html = '<!doctype html><html><body>captive portal</body></html>';
    stub({ [BINARIES_URL + 'list.json']: listFor(entry(BUILD_PATH, html)), [BINARIES_URL + BUILD_PATH]: html });
    hypc.loadRemoteVersion('v0.2.0+commit.e36a0aea', function (err) {
      restore();
      st.ok(err instanceof SyntaxError, 'callback receives the SyntaxError');
      st.end();
    });
  });

  t.test('resolves "latest" and release versions through list.json', function (st) {
    const requests = stub({ [BINARIES_URL + 'list.json']: listFor(entry(BUILD_PATH, realBuild)), [BINARIES_URL + BUILD_PATH]: 'tampered' });
    hypc.loadRemoteVersion('latest', function (err) {
      st.match(err && err.message, /does not match/);
      st.equal(requests[1].url, BINARIES_URL + BUILD_PATH);
      hypc.loadRemoteVersion('0.2.0', function (err) {
        restore();
        st.match(err && err.message, /does not match/);
        st.equal(requests[3].url, BINARIES_URL + BUILD_PATH);
        st.end();
      });
    });
  });

  t.test('rejects a version that is not in list.json', function (st) {
    const requests = stub({ [BINARIES_URL + 'list.json']: listFor(entry(BUILD_PATH, realBuild)) });
    hypc.loadRemoteVersion('v9.9.9+commit.00000000', function (err) {
      restore();
      st.match(err && err.message, /Version v9\.9\.9\+commit\.00000000 is not in/);
      st.equal(requests.length, 1, 'no build was requested');
      st.end();
    });
  });

  t.test('rejects a path that list.json does not list', function (st) {
    const requests = stub({ [BINARIES_URL + 'list.json']: listFor(entry(BUILD_PATH, realBuild)) });
    hypc.loadRemoteVersion('../../other/file', function (err) {
      restore();
      st.match(err && err.message, /is not in/);
      st.equal(requests.length, 1, 'no build was requested');
      st.end();
    });
  });

  t.test('reports an HTTP error', function (st) {
    stub({ [BINARIES_URL + 'list.json']: 503 });
    hypc.loadRemoteVersion('latest', function (err) {
      restore();
      st.match(err && err.message, /Error retrieving .*list\.json: 503/);
      st.end();
    });
  });

  t.test('stops reading a build larger than 64 MiB', function (st) {
    const chunks = Array.from({ length: 65 }, () => Buffer.alloc(1024 * 1024));
    stub({ [BINARIES_URL + 'list.json']: listFor(entry(BUILD_PATH, realBuild)), [BINARIES_URL + BUILD_PATH]: chunks });
    hypc.loadRemoteVersion('v0.2.0+commit.e36a0aea', function (err) {
      restore();
      st.match(err && err.message, /is larger than 67108864 bytes/);
      st.end();
    });
  });

  t.test('follows redirects only to https on the binaries host', function (st) {
    const requests = stub({ [BINARIES_URL + 'list.json']: 404 });
    hypc.loadRemoteVersion('latest', function () {
      restore();
      const { beforeRedirect, maxRedirects } = requests[0].options;
      st.equal(maxRedirects, 5);
      st.doesNotThrow(() => beforeRedirect({ protocol: 'https:', hostname: 'binaries.theqrl.org' }));
      st.throws(() => beforeRedirect({ protocol: 'http:', hostname: 'binaries.theqrl.org' }), /Refusing to follow a redirect to http:\/\/binaries\.theqrl\.org/);
      st.throws(() => beforeRedirect({ protocol: 'https:', hostname: 'example.com' }), /Refusing to follow a redirect/);
      st.end();
    });
  });
});

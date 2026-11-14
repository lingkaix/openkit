// openkit-test-platform: posix
// No real network: pinned Linux/x64 clients and a private POSIX helper alias.
// Includes the pre-change canonical-helper setup/stdout oracle; the six-client body stays unchanged.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { downloadNativeClientTools } from '../scripts/download-native-client-tools.mjs';
import { verifyToolDownload } from '../scripts/install-security-tools.mjs';
import { prepareNativeCredentialHelper } from './support/native-credential-helper.mjs';

const pins = {
  aws: {
    version: '2.40.0',
    url: 'https://awscli.amazonaws.com/awscli-exe-linux-x86_64-2.40.0.zip',
    sha256: '4a6d34150060a6bc30160ef1f66e536db64674797bbb582044f93bb9c6e299e7',
    filename: 'aws.zip',
    publishedAt: '2026-11-10T19:04:44Z',
  },
  docker: {
    version: '5:29.7.2-1~debian.12~bookworm',
    url: 'https://download.docker.com/linux/debian/dists/bookworm/pool/stable/amd64/docker-ce-cli_29.7.2-1~debian.12~bookworm_amd64.deb',
    sha256: '9048b959cfe8ffc329a24145b4d06f189623c43b0bba64454009adc02cb1362c',
    filename: 'docker-cli.deb',
    publishedAt: '2026-08-10T16:01:56Z',
  },
  kubectl: {
    version: 'v1.37.2',
    url: 'https://dl.k8s.io/release/v1.37.2/bin/linux/amd64/kubectl',
    sha256: 'c04487523e7aa7d1493f7808174c899db93d7a9cf57531420cd76b9bd415f8f4',
    filename: 'kubectl',
    publishedAt: '2026-10-28T04:37:53Z',
  },
  openssh: {
    version: '1:9.2p1-2+deb12u9',
    url: 'https://deb.debian.org/debian-security/pool/updates/main/o/openssh/openssh-client_9.2p1-2+deb12u9_amd64.deb',
    sha256: '3159b10a9416169926edcdf4daddf16ac71fb56bc4a952d2a73754cc6741c053',
    filename: 'openssh-client.deb',
    publishedAt: '2026-04-05T00:08:44Z',
  },
};

test('four official suppliers are literal, version-bound and linux/amd64-only', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../scripts/native-client-tools.json', import.meta.url), 'utf8')
  );
  assert.equal(manifest.platform, 'linux');
  assert.equal(manifest.architecture, 'amd64');
  assert.deepEqual(Object.keys(manifest.tools).sort(), Object.keys(pins).sort());
  // Selection-time cutoff, not a fake installer mode or a newly eligible version mid-batch.
  const selectedAt = Date.parse('2026-11-14T16:05:00Z');
  for (const [name, pin] of Object.entries(manifest.tools)) {
    assert.deepEqual(pin, pins[name]);
    const { publishedAt } = pin;
    assert.ok(
      Number.isFinite(Date.parse(publishedAt)),
      `${name} needs recorded publication/asset date`
    );
    assert.ok(
      Date.parse(publishedAt) <= selectedAt - 72 * 60 * 60 * 1000,
      `${name} violates the three-day selection rule`
    );
    assert.equal(new URL(pin.url).protocol, 'https:');
    assert.match(pin.sha256, /^[a-f0-9]{64}$/u);
    assert.doesNotMatch(pin.url, /(?:latest|nightly|canary|\{[^}]*\})/iu);
    assert.doesNotMatch(pin.filename, /[/\\]|^\.{1,2}$/u);
  }
});

test('the existing byte verifier accepts exact bytes and refuses corrupt or malformed checksums', () => {
  const bytes = Buffer.from('bounded synthetic verifier input, not an official archive');
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert.doesNotThrow(() => verifyToolDownload(bytes, digest));
  assert.throws(
    () => verifyToolDownload(Buffer.concat([bytes, Buffer.from('changed')]), digest),
    /checksum/iu
  );
  for (const invalid of [
    undefined,
    '',
    'sha256:' + digest,
    digest.toUpperCase(),
    '0'.repeat(63),
    'z'.repeat(64),
  ])
    assert.throws(() => verifyToolDownload(bytes, invalid), /checksum/iu);
});

test('corrupt supplier bytes fail closed before any archive/binary file is written', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'openkit-native-supply-corrupt-'));
  let fetched = 0;
  const timeoutDurations = [];
  const actualTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
    timeoutDurations.push(milliseconds);
    return actualTimeout(milliseconds);
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    fetched++;
    assert.ok(Object.values(pins).some((pin) => pin.url === String(url)));
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        Uint8Array.from(Buffer.from('not any pinned official archive')).buffer,
    };
  });
  try {
    await assert.rejects(
      downloadNativeClientTools({ directory, architecture: 'x64' }),
      /checksum/iu
    );
    assert.equal(fetched, 1, 'do not continue supply or retry a checksum failure');
    assert.deepEqual(timeoutDurations, [60000]);
    assert.deepEqual(
      readdirSync(directory),
      [],
      'unverified bytes must not reach a later CLI/extraction phase'
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('bad HTTP status refuses without consuming a body or writing files', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'openkit-native-supply-http-'));
  let bodies = 0;
  let fetched = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetched++;
    return {
      ok: false,
      status: 503,
      arrayBuffer: async () => {
        bodies++;
        throw Error('error response is not an archive');
      },
    };
  });
  try {
    await assert.rejects(downloadNativeClientTools({ directory, architecture: 'x64' }));
    assert.equal(fetched, 1);
    assert.equal(bodies, 0);
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('unsupported architecture is refused before fetch or content write', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'openkit-native-supply-arch-'));
  let fetched = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetched++;
    throw Error('must not fetch');
  });
  try {
    for (const architecture of ['arm64', 'ia32', 'amd64', 'unknown'])
      await assert.rejects(
        downloadNativeClientTools({ directory, architecture }),
        /unsupported|architecture|platform/iu
      );
    assert.equal(fetched, 0);
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('default architecture follows the real current Node architecture, never a host fallback', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'openkit-native-supply-current-'));
  let fetched = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetched++;
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  });
  try {
    await assert.rejects(downloadNativeClientTools({ directory }));
    assert.equal(fetched, process.platform === 'linux' && process.arch === 'x64' ? 1 : 0);
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('normal worker setup exposes only the repo-built canonical helper before worker clocks without stdout pollution', () => {
  const setup = readFileSync(
    new URL('../apps/nanocore/vitest-worker-setup.mjs', import.meta.url),
    'utf8'
  );
  assert.match(
    setup,
    /\['exec', 'turbo', 'run', 'build', '--filter=@openkit\/worker-shim', '--output-logs=errors-only'\]/u
  );
  assert.match(setup, /stdio:\s*\['ignore',\s*2,\s*2\]/u);
  assert.doesNotMatch(setup, /(?:console\.log|process\.stdout\.write)\s*\(/u);
  assert.match(
    setup,
    /cli:\s*join\(appRoot,\s*['"]\.\.\/\.\.\/packages\/worker-shim\/dist\/credential-helper-cli\.js['"]\)/u
  );
  const buildAt = setup.indexOf("'--filter=@openkit/worker-shim'");
  const aliasAt = setup.indexOf('  prepareNativeCredentialHelper(');
  const workersAt = setup.indexOf('await Promise.all(');
  assert.ok(buildAt >= 0 && aliasAt > buildAt && workersAt > aliasAt);
  const root = mkdtempSync(join(tmpdir(), 'native-canonical-helper-'));
  const previous = process.env.PATH;
  const cli = fileURLToPath(
    new URL('../packages/worker-shim/dist/credential-helper-cli.js', import.meta.url)
  );
  try {
    prepareNativeCredentialHelper({ root, cli });
    const bin = join(root, 'bin');
    assert.equal(readlinkSync(join(bin, 'docker-credential-openkit')), cli);
    assert.equal(process.env.PATH, `${bin}${delimiter}${previous ?? ''}`);
    const fixture = readFileSync(
      new URL('./support/native-credential-helper.mjs', import.meta.url),
      'utf8'
    );
    assert.doesNotMatch(fixture, /(?:console\.log|process\.stdout\.write)\s*\(/u);
    assert.doesNotMatch(fixture, /['"]\/usr\/(?:local\/)?bin\/docker-credential-openkit['"]/u);
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('downloader reuses the original verifier and contains no extraction/execution or mutable pin overrides', () => {
  const source = readFileSync(
    new URL('../scripts/download-native-client-tools.mjs', import.meta.url),
    'utf8'
  );
  assert.match(
    source,
    /import\s*\{\s*verifyToolDownload\s*\}\s*from\s*['"]\.\/install-security-tools\.mjs['"]/u
  );
  assert.doesNotMatch(
    source,
    /node:child_process|\b(?:execFileSync|execSync|spawnSync|spawn|chmodSync)\s*\(/u
  );
  assert.doesNotMatch(source, /['"](?:--manifest|--url|--sha256|--skip-verify)['"]/u);
});

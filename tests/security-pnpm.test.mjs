import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

const root = process.cwd();
const require = createRequire(join(root, 'package.json'));
const { parse, stringify } = require('yaml');
const source = parse(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'));
const policy = Object.fromEntries(
  [
    'minimumReleaseAge',
    'minimumReleaseAgeExclude',
    'strictDepBuilds',
    'blockExoticSubdeps',
    'allowBuilds',
  ]
    .filter((key) => Object.hasOwn(source, key))
    .map((key) => [key, source[key]])
);
const shim = process.env.PATH.split(delimiter)
  .map((dir) => join(dir, 'pnpm'))
  .find(existsSync);
// A run script exposes public CLI metadata; exec does not set npm_execpath.
function resolvePnpm() {
  const cwd = mkdtempSync(join(tmpdir(), 'security-pnpm-entry-'));
  try {
    writeFileSync(
      join(cwd, 'package.json'),
      JSON.stringify({
        private: true,
        packageManager: 'pnpm@10.33.3',
        scripts: { entry: 'node -p process.env.npm_execpath' },
      })
    );
    const resolved =
      shim &&
      spawnSync(shim, ['run', '--silent', 'entry'], {
        cwd,
        env: { ...process.env, COREPACK_ENABLE_NETWORK: '0' },
        encoding: 'utf8',
        timeout: 30_000,
      });
    const path = resolved?.status === 0 ? resolved.stdout.trim() : undefined;
    return path && existsSync(path) ? path : undefined;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
const pnpm = resolvePnpm();
const name = 'openkit-security-marker-fixture';
const marker = 'native-script-marker';
const now = Date.now(); // One fixed publication reference for this invocation.

/** Build a deterministic npm tarball without a package-manager packing hook. */
function archive(base, version) {
  const cwd = join(base, `pack-${version}`);
  mkdirSync(join(cwd, 'package'), { recursive: true });
  const files = {
    'package/package.json': JSON.stringify({
      name,
      version,
      scripts: { install: 'node install.cjs' },
    }),
    'package/install.cjs': `require('node:fs').writeFileSync(require('node:path').join(process.env.HOME, '${marker}'), 'executed');`,
  };
  for (const [path, text] of Object.entries(files)) writeFileSync(join(cwd, path), text);
  const packed = spawnSync(
    'tar',
    [
      '--format=ustar',
      '--sort=name',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '--mtime=@0',
      '--mode=0755',
      '-cf',
      '-',
      'package/',
    ],
    { cwd, env: { PATH: process.env.PATH, LC_ALL: 'C' }, timeout: 10_000 }
  );
  if (packed.status !== 0) throw new Error('Fixture packing failed');
  return gzipSync(packed.stdout);
}

/** Keep the registry event loop alive while the actual pinned pnpm runs. */
function run(args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [pnpm, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.stdout.on('data', (data) => {
      output += data;
    });
    child.stderr.on('data', (data) => {
      output += data;
    });
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('Native process start failed'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

test('native pnpm enforces release age and explicit build review', async () => {
  assert.equal(process.version, 'v26.13.0', 'Pinned Node required');
  assert.ok(pnpm, 'Pinned package manager required');
  const base = mkdtempSync(join(tmpdir(), 'security-pnpm-'));
  const tarballs = Object.fromEntries(['1.0.0', '1.0.1'].map((v) => [v, archive(base, v)]));
  let origin;
  const server = createServer((request, response) => {
    const version = request.url?.match(/^\/archive\/(1\.0\.[01])\.tgz$/u)?.[1];
    if (version) {
      response.end(tarballs[version]);
      return;
    }
    if (request.url !== `/${name}`) {
      response.writeHead(404).end();
      return;
    }
    const versions = Object.fromEntries(
      Object.entries(tarballs).map(([v, bytes]) => [
        v,
        {
          name,
          version: v,
          scripts: { install: 'node install.cjs' },
          dist: {
            tarball: `${origin}/archive/${v}.tgz`,
            integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
          },
        },
      ])
    );
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        name,
        'dist-tags': { latest: '1.0.1' },
        versions,
        time: {
          created: new Date(now - 864_000_000).toISOString(),
          modified: new Date(now - 3_600_000).toISOString(),
          '1.0.0': new Date(now - 864_000_000).toISOString(),
          '1.0.1': new Date(now - 3_600_000).toISOString(),
        },
      })
    );
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    /** Each outcome gets a fresh project, store, HOME and empty config. */
    async function outcome(label, version, change, frozen) {
      const cwd = join(base, label);
      const home = join(cwd, 'home');
      mkdirSync(home, { recursive: true });
      const config = join(home, 'empty.npmrc');
      writeFileSync(config, '');
      const env = {
        PATH: process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: home,
        XDG_CACHE_HOME: join(home, 'cache'),
        XDG_DATA_HOME: join(home, 'data'),
        CI: 'true',
        npm_config_userconfig: config,
        npm_config_globalconfig: config,
        COREPACK_ENABLE_NETWORK: '0',
      };
      const identity = await run(['--version'], cwd, env);
      assert.ok(
        identity.code === 0 && identity.output.trim() === '10.33.3',
        'Pinned pnpm required'
      );
      writeFileSync(
        join(cwd, 'package.json'),
        JSON.stringify({ private: true, dependencies: { [name]: version } })
      );
      writeFileSync(
        join(cwd, '.npmrc'),
        `registry=${origin}/\nstore-dir=${join(cwd, 'store')}\nverify-store-integrity=true\n`
      );
      writeFileSync(
        join(cwd, 'pnpm-workspace.yaml'),
        stringify({ packages: [], ...structuredClone(policy), ...change })
      );
      if (frozen) {
        const setup = await run(['install', '--lockfile-only', '--ignore-scripts'], cwd, env);
        assert.equal(setup.code, 0, 'Lock preparation must succeed');
      }
      const result = await run(
        ['install', frozen ? '--frozen-lockfile' : '--lockfile-only'],
        cwd,
        env
      );
      assert.equal(existsSync(join(home, marker)), false, 'Dependency script must not execute');
      return result;
    }
    // Expected OLD failure: native age refusal is absent, not a setup error.
    const young = await outcome('young', '1.0.1', {}, false);
    assert.ok(
      young.code !== 0 && /ERR_PNPM_NO_MATURE_MATCHING_VERSION/u.test(young.output),
      'Young release must be refused natively'
    );
    const exempt = await outcome(
      'exempt',
      '1.0.1',
      { minimumReleaseAgeExclude: [`${name}@1.0.1`] },
      false
    );
    assert.equal(exempt.code, 0, 'Exact-version exemption must admit resolution');
    const unknown = await outcome('unknown', '1.0.0', {}, true);
    assert.ok(
      unknown.code !== 0 && /ERR_PNPM_IGNORED_BUILDS/u.test(unknown.output),
      'Unreviewed build must fail natively'
    );
    const denied = await outcome(
      'denied',
      '1.0.0',
      { allowBuilds: { ...policy.allowBuilds, [name]: false } },
      true
    );
    assert.equal(denied.code, 0, 'Explicit false review must admit frozen install');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(base, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(repoRoot, 'apps/nanohost/deploy/host-manifest.json');
const expectedRootScripts = {
  'host:assert': 'bash tests/support/host/assert.sh',
  'host:nanohost:bring-up': 'bash tests/support/host/nanohost-bring-up.sh',
  'host:provision': 'bash tests/support/host/provision.sh',
  'host:teardown': 'bash tests/support/host/teardown.sh',
};
const trackedPaths = [
  'CONTRIBUTING.md',
  'README.md',
  'docs/cookbooks/README.md',
  'docs/cookbooks/nanohost-real-use-host.md',
  'package.json',
  'apps/nanohost/deploy/host-manifest.json',
  'tests/host-manifest-projection.test.mjs',
  'tests/host-manifest-runtime.test.mjs',
  'tests/host-manifest.test.mjs',
  'tests/support/host/README.md',
  'tests/support/host/assert.sh',
  'tests/support/host/fixture-runner.mjs',
  'tests/support/host/nanohost-bring-up.sh',
  'tests/support/host/provision.sh',
  'tests/support/host/ssh-alias.sh',
  'tests/support/host/teardown.sh',
];

/** Returns the lowercase SHA-256 digest of the supplied bytes. */
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Returns one SHA-256 over sorted repository-relative path and content pairs. */
function artifactDigest(root, paths) {
  const hash = createHash('sha256');
  for (const path of [...paths].sort()) {
    hash.update(path);
    hash.update('\0');
    hash.update(readFileSync(join(root, path)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

test('root exposes exactly the host-manifest commands', () => {
  const rootPackage = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const hostScripts = Object.fromEntries(
    Object.entries(rootPackage.scripts)
      .filter(([name]) => name.startsWith('host:'))
      .sort(([left], [right]) => left.localeCompare(right))
  );
  assert.deepEqual(hostScripts, expectedRootScripts);
});

test('the host artifacts use the sole promoted manifest identity', () => {
  assert.ok(
    existsSync(manifestPath),
    'missing promoted product artifact apps/nanohost/deploy/host-manifest.json'
  );
  const manifestBytes = readFileSync(manifestPath);

  assert.equal(trackedPaths.length, 16);
  for (const path of trackedPaths) {
    assert.ok(existsSync(join(repoRoot, path)), `missing H1-A tracked artifact ${path}`);
  }
  assert.match(sha256(manifestBytes), /^[0-9a-f]{64}$/u);
  assert.equal(
    artifactDigest(repoRoot, trackedPaths),
    artifactDigest(repoRoot, [...trackedPaths].reverse())
  );

  const fixtureRoot = mkdtempSync(join(tmpdir(), 'openkit-host-artifact-'));
  try {
    for (const path of trackedPaths) {
      mkdirSync(dirname(join(fixtureRoot, path)), { recursive: true });
      cpSync(join(repoRoot, path), join(fixtureRoot, path), { recursive: true });
    }
    const before = artifactDigest(fixtureRoot, trackedPaths);
    const mutatedPath = trackedPaths[0];
    writeFileSync(
      join(fixtureRoot, mutatedPath),
      Buffer.concat([readFileSync(join(fixtureRoot, mutatedPath)), Buffer.from('\n')])
    );
    assert.notEqual(artifactDigest(fixtureRoot, trackedPaths), before);
    assert.notEqual(
      sha256(Buffer.concat([manifestBytes, Buffer.from('\n')])),
      sha256(manifestBytes)
    );
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

test('active repository paths do not retain the retired host-manifest owner', () => {
  const retiredPath = ['tests', 'support', 'host', 'manifest.json'].join('/');
  assert.equal(existsSync(join(repoRoot, retiredPath)), false, `${retiredPath} still exists`);
  const result = spawnSync(
    'git',
    [
      'grep',
      '-n',
      retiredPath,
      '--',
      ':!docs/changes/**',
      ':!temp/**',
      ':!tests/host-manifest-projection.test.mjs',
    ],
    { cwd: repoRoot, encoding: 'utf8' }
  );
  assert.equal(result.status, 1, result.stdout || result.stderr);
});

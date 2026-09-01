import assert from 'node:assert/strict';
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
const manifestPath = join(repoRoot, 'tests/support/host/manifest.json');
const expectedRootScripts = {
  'host:assert': 'bash tests/support/host/assert.sh',
  'host:nanohost:bring-up': 'bash tests/support/host/nanohost-bring-up.sh',
  'host:nanohost:unit-f': 'node tests/support/host/nanohost-unit-f-runner.mjs',
  'host:provision': 'bash tests/support/host/provision.sh',
  'host:teardown': 'bash tests/support/host/teardown.sh',
};
const trackedPaths = [
  'CONTRIBUTING.md',
  'README.md',
  'docs/cookbooks/README.md',
  'docs/cookbooks/nanohost-real-use-host.md',
  'package.json',
  'tests/host-manifest-projection.test.mjs',
  'tests/host-manifest-runtime.test.mjs',
  'tests/host-manifest.test.mjs',
  'tests/support/host/README.md',
  'tests/support/host/assert.sh',
  'tests/support/host/fixture-runner.mjs',
  'tests/support/host/manifest.json',
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

test('root exposes exactly the five host-manifest commands', () => {
  const rootPackage = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(rootPackage.scripts)
        .filter(([name]) => name.startsWith('host:'))
        .sort(([left], [right]) => left.localeCompare(right))
    ),
    expectedRootScripts
  );
});

test('the host artifacts have the exact sixteen-file identity', () => {
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

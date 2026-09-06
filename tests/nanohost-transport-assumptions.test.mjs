import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../apps/nanohost/openshell/', import.meta.url));

/** Validates retained object identity before Git interprets a commit/tree/blob. */
function objectType(id, bytes) {
  const type = ['commit', 'tree', 'blob'].find(
    (candidate) =>
      createHash('sha1').update(`${candidate} ${bytes.length}\0`).update(bytes).digest('hex') === id
  );
  assert.ok(type, `transport-assumptions: corrupt Git object ${id}`);
  return type;
}

/** Checks identity, arithmetic, and citations, not the semantic memory proof. */
function verifyAssumptions(evidence, release, readSource) {
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(
    evidence.sourceCommit,
    release.source.commit,
    'transport-assumptions: candidate commit changed; review and rebind the retained source slice'
  );
  assert.deepEqual(
    evidence.assumptions.map((entry) => entry.name),
    ['forward-response-queue', 'relay-queues', 'gateway-pairing-buffer']
  );
  const sources = new Map();
  for (const source of evidence.sources) {
    assert.match(source.path, /^crates\/[a-z0-9_./-]+\.rs$/u);
    assert.ok(!source.path.split('/').includes('..'));
    assert.ok(!sources.has(source.path), 'duplicate source identity');
    const bytes = readSource(evidence.sourceCommit, source.path);
    assert.equal(
      `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      source.sha256,
      `transport-assumptions: source identity mismatch at ${source.path}`
    );
    sources.set(source.path, bytes.toString('utf8').split('\n').length);
  }
  const used = new Set();
  for (const entry of evidence.assumptions) {
    assert.ok(entry.reason.length > 0);
    assert.ok(entry.sourceLocations.length > 0);
    for (const location of entry.sourceLocations) {
      const match = /^([^:]+):(\d+)(?:-(\d+))?$/u.exec(location);
      assert.ok(match, 'invalid source citation');
      const [, path, first, last = first] = match;
      assert.ok(
        Number(first) >= 1 && Number(last) >= Number(first) && Number(last) <= sources.get(path),
        `transport-assumptions: stale citation ${location}`
      );
      used.add(path);
    }
    for (const value of Object.values(entry).filter((value) => typeof value === 'number')) {
      assert.ok(Number.isSafeInteger(value) && value > 0, 'invalid finite contribution');
    }
  }
  assert.equal(used.size, sources.size, 'unused source evidence');
  const [forward, relay, pairing] = evidence.assumptions;
  assert.equal(forward.queuedBytes, forward.chunkBytes * forward.queueFrames);
  assert.equal(relay.queuedBytesPerEndpoint, relay.chunkBytes * relay.queueFramesPerEndpoint);
  assert.equal(relay.endpoints, 2);
  assert.equal(relay.totalQueuedBytes, relay.queuedBytesPerEndpoint * relay.endpoints);
  assert.equal(pairing.directions, 2);
  assert.equal(pairing.totalBytes, pairing.bytesPerDirection * pairing.directions);
}

test('OpenShell transport source evidence detects stale or corrupt release assumptions', () => {
  const release = JSON.parse(readFileSync(join(root, 'release.json'), 'utf8'));
  const evidence = JSON.parse(readFileSync(join(root, 'transport-assumptions.json'), 'utf8'));
  const gitDir = mkdtempSync(join(tmpdir(), 'openkit-transport-source-'));
  // A fresh object database prevents local Git caches or replacement refs masking missing evidence.
  const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1' };
  const git = (args, input) =>
    execFileSync('git', ['--git-dir', gitDir, ...args], {
      env,
      input,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  try {
    git(['init', '--bare', '--template=']);
    for (const id of readdirSync(join(root, 'git-objects'))) {
      assert.match(id, /^[0-9a-f]{40}$/u);
      const bytes = readFileSync(join(root, 'git-objects', id));
      const type = objectType(id, bytes);
      assert.equal(git(['hash-object', '-w', '-t', type, '--stdin'], bytes).toString().trim(), id);
    }
    const readSource = (commit, path) => git(['cat-file', 'blob', `${commit}:${path}`]);
    verifyAssumptions(evidence, release, readSource);
    const stale = structuredClone(evidence);
    stale.sourceCommit = '0'.repeat(40);
    assert.throws(() => verifyAssumptions(stale, release, readSource), /candidate commit changed/u);
    const corrupt = structuredClone(evidence);
    corrupt.sources[0].sha256 = `sha256:${'0'.repeat(64)}`;
    assert.throws(
      () => verifyAssumptions(corrupt, release, readSource),
      /source identity mismatch/u
    );
    const wrongCount = structuredClone(evidence);
    wrongCount.assumptions[0].queueFrames += 1;
    assert.throws(() => verifyAssumptions(wrongCount, release, readSource), assert.AssertionError);
    assert.throws(
      () => objectType(evidence.sourceCommit, Buffer.from('corrupt')),
      /corrupt Git object/u
    );
  } finally {
    rmSync(gitDir, { recursive: true, force: true });
  }
});

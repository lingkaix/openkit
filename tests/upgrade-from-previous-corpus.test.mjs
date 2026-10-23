import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  FILE_CORPUS_FAMILIES,
  NATIVE_METADATA_FAMILIES,
  readFileCorpus,
  seedFileCorpus,
} from '../scripts/upgrade-from-previous-corpus.mjs';

const appRoot = resolve('apps/nanocore');

/** Loads only the compiled product owner selected by this test checkout. */
function owner(path) {
  return import(pathToFileURL(join(appRoot, 'dist', path)).href);
}

/** Builds ordinary synthetic User authority without starting a service or using a credential. */
async function fixture(t, serverUser = false) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-previous-corpus-'));
  t.after(async () => {
    const { shutdownControlStoreWorkerClient } = await owner(
      'storage/control-store-worker-client.js'
    );
    await shutdownControlStoreWorkerClient();
    rmSync(root, { recursive: true, force: true });
  });
  const dataRoot = join(root, 'data');
  const retainedRoot = join(root, 'retained');
  const { ensureLayout } = await owner('storage/fs-layout.js');
  const { openCoreDb } = await owner('storage/db.js');
  const { applyMigrations } = await owner('storage/migrate.js');
  const { ensureLocalUser } = await owner('test-support/local-user.js');
  ensureLayout(dataRoot);
  const coreDb = openCoreDb(dataRoot);
  let userId;
  try {
    applyMigrations(coreDb);
    userId = ensureLocalUser(coreDb);
    if (serverUser) {
      coreDb.sqlite.prepare("UPDATE users SET kind = 'human' WHERE id = ?").run(userId);
      const { createOpenKitAccessTokenRecord } = await owner('auth/access-token-store.js');
      createOpenKitAccessTokenRecord(coreDb, {
        ownerUserId: userId,
        scope: 'server-admin',
        workspaceIds: [],
        expiresAt: '2999-01-01T00:00:00.000Z',
      });
    }
  } finally {
    coreDb.sqlite.close();
  }
  return { appRoot, dataRoot, retainedRoot, userId };
}

test('old producers seed a nonempty B01 file corpus that old readers reopen exactly', async (t) => {
  const input = await fixture(t, true);
  const selectors = await seedFileCorpus(input);
  assert.match(selectors.workspaceId, /^ws_/);
  assert.match(selectors.threadId, /^th_/);
  assert.match(selectors.turnId, /^tu_/);
  const first = await readFileCorpus({ ...input, selectors });
  const second = await readFileCorpus({ ...input, selectors });
  assert.deepEqual(first, second);
  assert.deepEqual(first, JSON.parse(JSON.stringify(first)));
  const report = JSON.stringify({ selectors, first });
  const vaultKey = readFileSync(join(input.retainedRoot, 'file-corpus', 'vault-key.bin'));
  assert.ok(!report.includes(vaultKey.toString('hex')));
  assert.ok(!report.includes(vaultKey.toString('base64')));
  assert.ok(!report.includes(input.dataRoot));
  assert.ok(!report.includes(input.retainedRoot));
  assert.deepEqual(Object.keys(first).sort(), [...FILE_CORPUS_FAMILIES].sort());
  assert.ok(first['Conversation original file inputs'].values[0].length > 0);
  assert.equal(first['Immutable Artifact versions']?.values.length, 2);
  assert.equal(first['Artifact original payload']?.bytes.length, 2);
  const capture = first['Unaccepted Workspace capture source'];
  const sourceRoot = `workspaces/${selectors.workspaceId}/evidence/backend/workspace-capture/${selectors.rawCaptureIdentity.collectionId}`;
  const candidate = Buffer.from('00ffc328800a', 'hex');
  const { createHash } = await import('node:crypto');
  const candidateDigest = createHash('sha256').update(candidate).digest('hex');
  assert.deepEqual(capture.values[0].identity, selectors.rawCaptureIdentity);
  const { collectedAt, ...captureResult } = capture.values[0].result;
  assert.match(collectedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(captureResult, {
    outcome: 'candidate',
    sha256: `sha256:${candidateDigest}`,
    byteLength: candidate.length,
    head: { tree: '3'.repeat(40), manifest: '4'.repeat(40) },
    previousHead: { tree: '1'.repeat(40), manifest: '2'.repeat(40) },
    acceptedBase: { tree: '1'.repeat(40), manifest: '2'.repeat(40) },
    unstable: false,
  });
  assert.deepEqual(capture.bytes.map((entry) => entry.path).sort(), [
    `data/${sourceRoot}/collection.json`,
    `data/${sourceRoot}/complete`,
  ]);
  assert.deepEqual(readFileSync(join(input.dataRoot, sourceRoot, 'complete')), candidate);
  assert.equal(
    capture.bytes.find((entry) => entry.path.endsWith('/complete')).sha256,
    candidateDigest
  );
  for (const entry of capture.bytes) {
    assert.ok(
      first['Data Root backup'].bytes.some(
        (saved) =>
          saved.path.endsWith('/' + entry.path.slice('data/'.length)) &&
          saved.sha256 === entry.sha256
      ),
      'Cold backup retains the original capture source bytes'
    );
  }
  for (const [family, observed] of Object.entries(first)) {
    assert.ok(observed.values.length > 0, `${family}: no native reader result`);
    if (NATIVE_METADATA_FAMILIES.includes(family)) {
      for (const snapshot of observed.values) {
        assert.deepEqual(snapshot.owner, { kind: 'workspace', workspaceId: selectors.workspaceId });
        assert.ok(Number.isSafeInteger(snapshot.revision) && snapshot.revision > 0);
        const expected = {
          'Workspace record': [selectors.workspaceId, 'active'],
          'Thread record': [selectors.threadId, 'active'],
          'Turn record': [selectors.turnId, 'completed'],
          AgentSession: [selectors.agentSessionId, 'closed'],
        }[family];
        assert.equal(snapshot.record.id, expected[0]);
        assert.equal(snapshot.record.status, expected[1]);
        if (family === 'Turn record') {
          assert.ok(snapshot.record.startedAt);
          assert.ok(snapshot.record.completedAt);
        } else {
          assert.ok(snapshot.record.createdAt);
          assert.ok(snapshot.record.updatedAt);
        }
      }
    } else {
      assert.ok(observed.bytes.length > 0, `${family}: no retained bytes`);
    }
    for (const entry of observed.bytes) {
      assert.ok(!entry.path.startsWith('/'), `${family}: absolute path leaked`);
      assert.ok(entry.byteLength >= 0, `${family}: invalid byte length`);
      assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    }
    if (!NATIVE_METADATA_FAMILIES.includes(family))
      assert.ok(
        observed.bytes.some((entry) => entry.byteLength > 0),
        `${family}: no nonempty retained sample`
      );
  }
  // Register and Synchronization: descriptive additions are ignored, not rewritten as known truth.
  const metadataPath = join(input.dataRoot, sourceRoot, 'collection.json');
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  assert.equal(metadata.schemaVersion, 1);
  for (const value of [
    metadata,
    metadata.identity,
    metadata.result,
    metadata.result.head,
    metadata.result.previousHead,
    metadata.result.acceptedBase,
  ]) {
    value.futureNote = 'Public synthetic descriptive extension';
  }
  const annotated = JSON.stringify(metadata);
  writeFileSync(metadataPath, annotated);
  const extended = await readFileCorpus({ ...input, selectors });
  assert.deepEqual(extended['Unaccepted Workspace capture source'].values, capture.values);
  assert.equal(readFileSync(metadataPath, 'utf8'), annotated);
  assert.deepEqual(readFileSync(join(input.dataRoot, sourceRoot, 'complete')), candidate);
});

test('file reader fails on retained history corruption instead of accepting a boot-only result', async (t) => {
  const input = await fixture(t);
  const selectors = await seedFileCorpus(input);
  const before = await readFileCorpus({ ...input, selectors });
  const { readRawWorkspaceCapture } = await owner('runtime/workspace-snapshot-chain.js');
  const source = await readRawWorkspaceCapture(input.dataRoot, selectors.rawCaptureIdentity);
  assert.ok(source, 'The native capture source exists before corruption');
  const captureFile = before['Unaccepted Workspace capture source'].bytes.find((entry) =>
    entry.path.endsWith('/complete')
  );
  const capturePath = join(input.dataRoot, captureFile.path.slice('data/'.length));
  const candidate = readFileSync(capturePath);
  assert.deepEqual(source.candidate, candidate);
  const corrupt = Buffer.from(candidate);
  corrupt[0] ^= 1;
  writeFileSync(capturePath, corrupt);
  assert.equal(readFileSync(capturePath).length, candidate.length);
  try {
    await assert.rejects(readRawWorkspaceCapture(input.dataRoot, selectors.rawCaptureIdentity));
  } finally {
    writeFileSync(capturePath, candidate);
  }
  assert.deepEqual(
    (await readRawWorkspaceCapture(input.dataRoot, selectors.rawCaptureIdentity)).candidate,
    candidate
  );
  const selected = before['Item revision log'].bytes[0];
  const path = join(input.dataRoot, selected.path.slice('data/'.length));
  chmodSync(path, 0o644);
  const bytes = readFileSync(path);
  writeFileSync(path, '{"invalid":"retained-history"}\n');
  await assert.rejects(readFileCorpus({ ...input, selectors }));
  writeFileSync(path, bytes);
  chmodSync(path, 0o444);
  assert.deepEqual(readFileSync(path), bytes);
  await assert.rejects(readFileCorpus({ ...input, selectors }), { code: 'recovery_required' });

  // Restoring bytes does not clear process-local refusal; a new process revalidates the same root.
  const { spawnSync } = await import('node:child_process');
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { readFileSync } from 'node:fs';
const { readFileCorpus } = await import(process.argv[1]);
const input = JSON.parse(readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(await readFileCorpus(input)));`,
      new URL('../scripts/upgrade-from-previous-corpus.mjs', import.meta.url).href,
    ],
    { encoding: 'utf8', input: JSON.stringify({ ...input, selectors }) }
  );
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  const recovered = JSON.parse(child.stdout);
  assert.deepEqual(Object.keys(recovered).sort(), [...FILE_CORPUS_FAMILIES].sort());
  assert.deepEqual(recovered, before);
  assert.ok(recovered['Item revision log'].values.length);
});

test('seeding refuses a second corpus instead of changing an existing baseline', async (t) => {
  const input = await fixture(t);
  const selectors = await seedFileCorpus(input);
  const before = await readFileCorpus({ ...input, selectors });
  await assert.rejects(seedFileCorpus(input), /already|exists|empty/i);
  assert.deepEqual(await readFileCorpus({ ...input, selectors }), before);
});

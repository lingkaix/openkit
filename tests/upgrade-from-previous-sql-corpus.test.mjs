import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  readSqlCorpus,
  SQL_CORPUS_FAMILIES,
  seedSqlCorpus,
} from '../scripts/upgrade-from-previous-sql-corpus.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = process.env.UPGRADE_CORPUS_APP_ROOT ?? join(repositoryRoot, 'apps/nanocore');

/** Creates real owned prerequisites without an App, provider, Worker, or Host effect. */
async function fixture(t, existingRuntimeTarget = false) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-upgrade-sql-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const load = (name) => import(pathToFileURL(join(appRoot, 'dist', `${name}.js`)).href);
  const { openCoreDb } = await load('storage/db');
  const { applyMigrations } = await load('storage/migrate');
  const { ensureLocalUser } = await load('auth/identity');
  const { FsStore } = await load('lib/store');
  const { recordWorkspaceOwnerMembership } = await load('workspace-membership');
  const coreDb = openCoreDb(join(root, 'data'));
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  if (existingRuntimeTarget) {
    const targets = await load('runtime/nanohost-runtime-target');
    const target = targets.allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      targetId: 'synthetic-existing-target',
      identityId: 'synthetic-existing-identity',
      deploymentId: 'synthetic-existing-deployment',
      observedAt: '2026-10-17T00:00:00.000Z',
    });
    targets.upsertNanoHostRuntimeTarget(coreDb, {
      ...target,
      physicalEpoch: 'f'.repeat(64),
      freshEmpty: true,
      ready: true,
      predecessorFenced: true,
      observedAt: '2026-10-17T00:00:00.000Z',
    });
  }

  const store = new FsStore({ dataRoot: coreDb.dataRoot });
  const workspace = store.createWorkspace('B01 upgrade continuity');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const thread = store.createThread(workspace.id, 'Upgrade corpus');
  const turn = store.createTurn(workspace.id, thread.id, 'Keep the synthetic corpus readable.', {
    kind: 'user',
    id: userId,
  });
  store.createItem({
    id: 'it_00000000-0000-7000-8000-000000000901',
    workspaceId: workspace.id,
    threadId: thread.id,
    turnId: turn.id,
    type: 'user-message',
    text: 'Keep the synthetic corpus readable.',
    actor: { kind: 'user', id: userId },
    status: 'completed',
    createdAt: turn.startedAt,
    completedAt: turn.startedAt,
  });
  const inlineArtifactId = 'ar_00000000-0000-7000-8000-000000000901';
  const artifactBody = '# Synthetic retained inline Artifact\n';
  const artifactDigest = `sha256:${createHash('sha256').update(artifactBody).digest('hex')}`;
  store.createArtifact({
    id: inlineArtifactId,
    workspaceId: workspace.id,
    threadId: null,
    turnId: null,
    kind: 'file',
    title: 'Synthetic retained inline Artifact',
    status: 'ready',
    summary: null,
    version: 1,
    content: { format: 'markdown', body: artifactBody },
    contentDigest: artifactDigest,
    lastMutationRequestId: 'fixture-inline-artifact',
    origin: {
      kind: 'imported',
      sourceKind: 'direct-import',
      sourceId: 'fixture-inline-artifact',
      sourceDigest: artifactDigest,
      actor: { kind: 'user', id: userId },
      requestId: 'fixture-inline-artifact',
      recordedAt: turn.startedAt,
    },
    createdAt: turn.startedAt,
    updatedAt: turn.startedAt,
  });
  store.updateTurn(turn.id, { status: 'completed', completedAt: turn.startedAt, durationMs: 0 });
  coreDb.sqlite.close();
  const input = {
    appRoot,
    dataRoot: join(root, 'data'),
    retainedRoot: join(root, 'retained'),
    userId,
    selectors: {
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      inlineArtifactId,
    },
  };
  const additional = await seedSqlCorpus(input);
  return { ...input, selectors: { ...input.selectors, ...additional }, load };
}

test('reopens every SQL family and its linked file owners with exact readback', async (t) => {
  const input = await fixture(t, true);
  const original = await readSqlCorpus(input);
  assert.deepEqual(Object.keys(original).sort(), [...SQL_CORPUS_FAMILIES].sort());
  for (const [family, observed] of Object.entries(original)) {
    assert.ok(observed.values.length > 0, `${family} has actual retained records`);
    for (const bytes of observed.bytes) {
      assert.ok(!bytes.path.startsWith('/'), 'byte evidence uses a domain-relative path');
      assert.ok(bytes.byteLength > 0);
      assert.match(bytes.sha256, /^[a-f0-9]{64}$/);
    }
  }
  const { openCoreDb: openRuntimeDb } = await input.load('storage/db');
  const runtimeDb = openRuntimeDb(input.dataRoot);
  try {
    const targets = await input.load('runtime/nanohost-runtime-target');
    const target = targets.getNanoHostRuntimeTarget(runtimeDb, input.selectors.sql.runtimeTargetId);
    assert.equal(target.targetId, 'synthetic-existing-target');
    targets.fenceNanoHostRuntimeTargetAfterRestart(runtimeDb, '2026-10-19T00:00:00.000Z');
    const reconnected = targets.allocateNanoHostRuntimeTargetConnectionGeneration(runtimeDb, {
      targetId: target.targetId,
      identityId: target.identityId,
      deploymentId: target.deploymentId,
      observedAt: '2026-10-19T00:00:01.000Z',
    });
    targets.upsertNanoHostRuntimeTarget(runtimeDb, {
      ...reconnected,
      physicalEpoch: 'c'.repeat(64),
      freshEmpty: true,
      ready: true,
      predecessorFenced: true,
      observedAt: '2026-10-19T00:00:02.000Z',
    });
    runtimeDb.sqlite
      .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
      .run('synthetic-candidate-additive-migration', 9999999999999);
  } finally {
    runtimeDb.sqlite.close();
  }
  const { FsStore } = await input.load('lib/store');
  const pendingFlow = await input.load('runtime/pending-request-flow');
  const { openWorkspaceDb } = await input.load('storage/db');
  pendingFlow.recoverPendingRequestsAtBoot(new FsStore({ dataRoot: input.dataRoot }), {
    openWorkspace: (workspaceId) => openWorkspaceDb(input.dataRoot, workspaceId),
  });
  assert.deepEqual(await readSqlCorpus(input), original);
  assert.equal(
    original['Goals, cards, immutable Plans and Task facts'].values[0].goal.disposition.kind,
    'cancelled'
  );
  assert.equal(
    original['Pending Requests, Workspace receipts and Worker checkpoints'].values[0].delivery,
    'closed-out'
  );
  assert.equal(
    original['Scheduler queue, attempts and recurring history'].values[1].phase,
    'closed'
  );
  assert.equal(
    original['Scheduler queue, attempts and recurring history'].values[2].status,
    'paused'
  );
  assert.equal(
    original['Material content, revisions and Thread bindings'].values[1].content,
    'Synthetic upgrade continuity material.\n'
  );
  assert.equal(
    original['Light App metadata, business data, Audit and receipts'].values[1].data.note,
    'Synthetic retained business record.'
  );
  const { openCoreDb } = await input.load('storage/db');
  const db = openCoreDb(input.dataRoot);
  try {
    db.sqlite
      .prepare('DELETE FROM permission_decisions WHERE decision_id = ?')
      .run(input.selectors.sql.serverDecisionId);
  } finally {
    db.sqlite.close();
  }
  await assert.rejects(readSqlCorpus(input), /Core permission decisions.*missing/i);
});

test('verifies original recovery, Context Package and raw provenance bytes', async (t) => {
  const input = await fixture(t);
  const path = join(input.dataRoot, input.selectors.sql.lightAppSnapshotPath);
  const bytes = readFileSync(path);
  bytes[bytes.length - 1] ^= 1;
  writeFileSync(path, bytes);
  await assert.rejects(readSqlCorpus(input), /snapshot digest does not match/i);
  bytes[bytes.length - 1] ^= 1;
  writeFileSync(path, bytes);
  const contextPath = join(
    input.dataRoot,
    input.selectors.sql.contextFilePaths.find((file) => file.endsWith('/instructions.md'))
  );
  const instructions = readFileSync(contextPath);
  writeFileSync(contextPath, Buffer.concat([instructions, Buffer.from('changed')]));
  await assert.rejects(readSqlCorpus(input), /Context Package.*(mismatch|digest|inventory)/i);
  writeFileSync(contextPath, instructions);
  const rawPath = join(input.dataRoot, input.selectors.sql.provenancePaths[0]);
  writeFileSync(rawPath, `${readFileSync(rawPath, 'utf8')} `);
  await assert.rejects(readSqlCorpus(input), /Runtime provenance original digest/i);
});

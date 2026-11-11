import { deepStrictEqual } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, expect, it, vi } from 'vitest';
import { listStoredWorkspaceEvidenceBundles } from '../evidence-bundles.js';
import { nanoHostSandboxIdFromBackendSessionId } from '../runtime/nanohost-effect-identity.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  upsertNanoHostRuntimeTarget,
} from '../runtime/nanohost-runtime-target.js';
import { recordWorkerBackendSessionMaterializing } from '../runtime/worker-backend-sessions.js';
import { createAndReserveWorkerStorageAttachment } from '../runtime/worker-storage-bindings.js';
import { publishWorkspaceCapture as acceptWorkspaceCapture } from '../runtime/workspace-capture-publication.js';
import {
  hasPendingWorkspaceCapture,
  listWorkspaceReconciliationRecords,
} from '../runtime/workspace-reconciliation-records.js';
import {
  acceptWorkspaceBaseline,
  authorizeWorkspaceBaselineInitialization,
  PreservedWorkspaceCaptureRefusal,
  preserveRawWorkspaceCapture,
  readRawWorkspaceCapture,
  readWorkspaceCollection,
  readWorkspaceSnapshotCursor,
  type WorkspaceCollectionIdentity,
} from '../runtime/workspace-snapshot-chain.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { recordTestAgentEnvironmentPackage } from '../test-support/agent-environment.js';
import { heldCommit, releaseCommit } from '../test-support/control-native-transport.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { resolveWorkspaceMembershipRelation } from '../workspace-sharing.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import {
  type CoreDb,
  openCoreDb,
  openWorkspaceDb,
  openWorkspaceReadDb,
  type WorkspaceDb,
} from './db.js';
import { readDataRootLayoutMarker } from './fs-layout.js';
import { applyMigrations } from './migrate.js';
import { nativeProductScope } from './workspace-file-records.js';

// Existing instrument wraps the real Worker and observes its actual SQLite FULL COMMIT.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  const { nativeCommitWorker } = await import('../test-support/control-native-transport.js');
  return { ...actual, Worker: nativeCommitWorker(actual.Worker) };
});

const roots: string[] = [];
const handles: (CoreDb | WorkspaceDb)[] = [];
const base = {
  tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  manifest: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
};
const head = { tree: '3'.repeat(40), manifest: '4'.repeat(40) };
const timestamp = '2026-07-08T00:00:00.000Z';

afterEach(async () => {
  for (const db of handles) if (db.sqlite.open && db.sqlite.readonly) db.sqlite.close();
  await shutdownControlStoreWorkerClient();
  for (const db of handles.splice(0)) if (db.sqlite.open) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Builds original attachment, package, Turn and backend provenance through their actual owners. */
async function fixture(bytes = Buffer.from('original captured work\n')) {
  const root = mkdtempSync(join(tmpdir(), 'capture-recovery-owner-'));
  roots.push(root);
  const coreDb = openCoreDb(root);
  handles.push(coreDb);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot: root, knowledge: [] });
  await shutdownControlStoreWorkerClient();
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: DEMO_WORKSPACE_ID, ownerUserId: userId });
  // The existing AEP fixture's scalar image/snapshot preparation owns this stopped-writer phase.
  await shutdownControlStoreWorkerClient();
  const db = openWorkspaceDb(root, DEMO_WORKSPACE_ID);
  handles.push(db);
  const pkg = await recordTestAgentEnvironmentPackage(db, {
    coreDb,
    suffix: 'capture_recovery_owner',
    threadId: DEMO_THREAD_ID,
    triggerActor: { kind: 'user', id: userId },
    workspaceInputIds: [],
  });
  await store.createAgentSession({
    id: pkg.scope.agentSessionId,
    agentId: pkg.agent.agentId,
    workspaceId: db.workspaceId,
    threadId: pkg.scope.threadId,
    status: 'busy',
    message: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await store.createTurn(
    db.workspaceId,
    pkg.scope.threadId,
    'Capture original work',
    pkg.scope.triggerActor,
    null,
    {
      turnId: pkg.scope.turnId,
      agentId: pkg.agent.agentId,
      agentSessionId: pkg.scope.agentSessionId,
      startedAt: timestamp,
    }
  );
  const target = await allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
    deploymentId: readDataRootLayoutMarker(root).deploymentId,
    identityId: 'capture-owner',
    targetId: 'capture-owner',
    observedAt: timestamp,
  });
  await upsertNanoHostRuntimeTarget(coreDb, {
    ...target,
    ready: true,
    freshEmpty: true,
    predecessorFenced: true,
    physicalEpoch: 'a'.repeat(64),
    observedAt: timestamp,
  });
  const binding = await createAndReserveWorkerStorageAttachment(coreDb, {
    deploymentId: target.deploymentId,
    runtimeTargetId: target.targetId,
    agentSessionId: pkg.scope.agentSessionId,
    workspaceId: db.workspaceId,
    threadId: pkg.scope.threadId,
    responsibleUserId: userId,
    purpose: 'work',
    now: timestamp,
    layout: {
      family: null,
      version: null,
      uid: 1000,
      gid: 1000,
      workingDirectory: '/workspace',
      platform: { architecture: 'arm64', os: 'linux' },
      targets: [{ target: '/workspace' }],
    },
    authorizeContributor: (contributor) =>
      resolveWorkspaceMembershipRelation(
        coreDb,
        contributor.workspaceId,
        contributor.responsibleUserId
      ) !== null,
  });
  const workSlot = (pkg.extensions.openkit as { workerStorage: { workSlotRef: string } })
    .workerStorage.workSlotRef;
  expect(binding.currentWorkSlotRef).toBe(workSlot);
  await store.updateAgentSession(pkg.scope.agentSessionId, {
    retainedStorage: {
      storageRef: binding.storageRef,
      workSlotRef: workSlot,
      attachmentGeneration: binding.attachmentGeneration,
    },
  });
  // Original scalar admission and baseline setup must not compete with either native owner.
  await shutdownControlStoreWorkerClient();
  const entry = createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    triggerActor: pkg.scope.triggerActor,
    profileRef: pkg.agent.profileId,
    queueEntryId: 'capture-owner',
    requestedAgentId: pkg.agent.agentId,
    workspaceId: db.workspaceId,
    threadId: pkg.scope.threadId,
    turnId: pkg.scope.turnId,
    turnInput: 'Capture original work',
    now: () => timestamp,
  });
  const attempt = recordTestExecutionAttempt(coreDb, {
    entry,
    attemptId: testEntityId('attempt', 'capture-recovery-owner'),
    agentSessionId: pkg.scope.agentSessionId,
    inputRef: pkg.snapshotId,
    bindingRef: 'capture-owner-binding',
    sessionCompatibilityKey: 'fixture',
    now: () => timestamp,
  });
  const packageHash = createHash('sha256').update(pkg.snapshotId).digest('hex');
  const backendSessionId = `nh-${'1'.repeat(16)}-${packageHash.slice(0, 16)}`;
  const anchor = await recordWorkerBackendSessionMaterializing(coreDb, {
    backendVersion: null,
    backendLineage: { kind: 'reference', imageRef: 'worker:test' },
    identity: {
      agentSessionId: pkg.scope.agentSessionId,
      packageSnapshotId: pkg.snapshotId,
      backendKind: pkg.backend.preferred,
      backendSessionId,
      deploymentId: target.deploymentId,
      runtimeTargetId: target.targetId,
      stagingDirectoryRef: 'server/runtime/worker-backend-sessions/capture-owner',
      transientProviderInstanceId: null,
    },
    lineage: {
      workspaceId: db.workspaceId,
      threadId: pkg.scope.threadId,
      turnId: pkg.scope.turnId,
    },
    sandboxBindingRef: attempt.bindingRef!,
    now: () => timestamp,
  });
  const identity: WorkspaceCollectionIdentity = {
    workspaceId: db.workspaceId,
    threadId: pkg.scope.threadId,
    turnId: pkg.scope.turnId,
    agentSessionId: pkg.scope.agentSessionId,
    packageSnapshotId: pkg.snapshotId,
    storageRef: binding.storageRef,
    scopeDigest: binding.scopeDigest,
    workSlot,
    attachmentGeneration: binding.attachmentGeneration,
    sandboxId: nanoHostSandboxIdFromBackendSessionId(anchor.backendSessionId),
    collectionId: `turn-end-${packageHash}`,
  };
  const baselineIdentity = { ...identity, collectionId: 'baseline' };
  authorizeWorkspaceBaselineInitialization(db, baselineIdentity);
  acceptWorkspaceBaseline(db, baselineIdentity, base, base.tree);
  const staging = join(root, 'server', 'runtime', 'capture-staging');
  mkdirSync(staging, { recursive: true });
  const stagedPath = join(staging, 'complete');
  writeFileSync(stagedPath, bytes);
  const source = await preserveRawWorkspaceCapture({
    dataRoot: root,
    identity,
    staged: { path: stagedPath, bytes },
    admission: new FileStorageAdmission(root, () => 1_000_000n),
    result: {
      outcome: 'candidate',
      head,
      previousHead: base,
      acceptedBase: base,
      unstable: false,
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      byteLength: bytes.length,
    },
  });
  return { root, coreDb, db, store, pkg, anchor, identity, bytes, source };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Opens the exact native physical owner before making Main query-only. */
async function openNative(f: Fixture) {
  const scope = nativeProductScope(f.root, { kind: 'workspace', workspaceId: f.db.workspaceId });
  await getControlStoreWorkerClient().open({
    database: `workspace:${scope.path}`,
    path: scope.path,
    dataRoot: f.root,
    create: false,
    initialize: 'workspace',
    productOwner: scope.owner,
    contentMount: scope.contentMount,
  });
  f.db.sqlite.pragma('query_only = ON');
  expect(f.db.sqlite.pragma('query_only', { simple: true })).toBe(1);
}

/** Observes the original immutable files without producing source or acceptance authority. */
function rawBytes(f: Fixture) {
  const root = join(
    f.root,
    'workspaces',
    f.db.workspaceId,
    'evidence',
    'backend',
    'workspace-capture',
    f.identity.collectionId
  );
  return ['complete', 'collection.json'].map((name) => readFileSync(join(root, name)));
}

/** Observes all members of the existing Workspace capture and recovery SQL families. */
function rows(db: WorkspaceDb) {
  return Object.fromEntries(
    [
      'workspace_snapshot_cursors',
      'workspace_snapshot_collections',
      'workspace_reconciliation_records',
      'evidence_bundles',
    ].map((table) => [table, db.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])
  );
}

/** Stops the actual writer before opening a cold query-only reader without migration. */
async function cold(f: Fixture) {
  await shutdownControlStoreWorkerClient();
  f.db.sqlite.close();
  const db = openWorkspaceReadDb(f.root, f.db.workspaceId);
  handles.push(db);
  return db;
}

it('accepts original raw capture with Main query-only, exact replay and cold receipt bytes', async () => {
  const f = await fixture();
  const raw = rawBytes(f);
  await openNative(f);
  // Core Storage / SQLite Layers: pre-move RED is actual Main INSERT READONLY, wrapped as proved body refusal.
  const receipt = await acceptWorkspaceCapture(
    f.db,
    f.identity,
    f.source.result,
    f.source.candidate,
    f.source
  );
  expect(receipt.candidate).toEqual(f.bytes);
  expect(receipt.identity).toEqual(f.identity);
  expect(readWorkspaceCollection(f.db, f.identity)).toEqual(receipt);
  expect(readWorkspaceSnapshotCursor(f.db, f.identity)).toEqual({
    acceptedBase: base,
    head,
    acceptedCommit: null,
  });
  const committed = rows(f.db);
  expect(
    await acceptWorkspaceCapture(f.db, f.identity, f.source.result, f.source.candidate, f.source)
  ).toEqual(receipt);
  expect(rows(f.db)).toEqual(committed);
  // A proved body refusal keeps its original class; it does not claim an unknown transport result.
  await expect(async () =>
    acceptWorkspaceCapture(
      f.db,
      f.identity,
      { ...f.source.result, unstable: true },
      f.source.candidate,
      f.source
    )
  ).rejects.toBeInstanceOf(PreservedWorkspaceCaptureRefusal);
  expect(rows(f.db)).toEqual(committed);
  expect(await readRawWorkspaceCapture(f.root, f.identity)).toEqual(f.source);
  expect(rawBytes(f)).toEqual(raw);
  const reader = await cold(f);
  expect(rows(reader)).toEqual(committed);
  expect(readWorkspaceCollection(reader, f.identity)).toEqual(receipt);
});

it('normalizes original recovery from actual attachment proof and resolves only the exact accepted receipt', async () => {
  const f = await fixture();
  const raw = rawBytes(f);
  await openNative(f);
  // Pre-move RED must be Main evidence/reconciliation INSERT READONLY after real original-attachment proof.
  expect(await hasPendingWorkspaceCapture(f.coreDb, f.db, f.anchor)).toBe(true);
  const records = listWorkspaceReconciliationRecords(f.db, f.db.workspaceId);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    stateAfter: 'requires-human',
    retentionDecision: 'retain-backend',
    backendHandleSummary: { identity: f.identity, candidateDigest: f.source.result.sha256 },
  });
  const bundles = listStoredWorkspaceEvidenceBundles(f.db, f.db.workspaceId);
  expect(bundles).toHaveLength(1);
  expect(records[0]!.evidenceBundleIds).toEqual([bundles[0]!.id]);
  expect(bundles[0]).toMatchObject({
    sourceKind: 'workspace-capture-raw',
    retentionClass: 'restricted-raw',
    sensitivityClass: 'restricted',
    contentDigests: [f.source.result.sha256],
  });
  const recovery = rows(f.db);
  expect(await hasPendingWorkspaceCapture(f.coreDb, f.db, f.anchor)).toBe(true);
  expect(rows(f.db)).toEqual(recovery);
  const receipt = await acceptWorkspaceCapture(
    f.db,
    f.identity,
    f.source.result,
    f.source.candidate,
    f.source
  );
  expect(await hasPendingWorkspaceCapture(f.coreDb, f.db, f.anchor)).toBe(false);
  const resolved = listWorkspaceReconciliationRecords(f.db, f.db.workspaceId);
  expect(resolved).toHaveLength(1);
  expect(resolved[0]).toMatchObject({
    id: records[0]!.id,
    stateAfter: 'recovered',
    requiredHumanDecision: null,
    retentionDecision: 'teardown-backend',
    finishedAt: receipt.result.collectedAt,
  });
  const committed = rows(f.db);
  expect(await hasPendingWorkspaceCapture(f.coreDb, f.db, f.anchor)).toBe(false);
  expect(rows(f.db)).toEqual(committed);
  expect(rawBytes(f)).toEqual(raw);
  const reader = await cold(f);
  expect(rows(reader)).toEqual(committed);
  expect(readWorkspaceCollection(reader, f.identity)).toEqual(receipt);
});

it('rolls back the complete recovery index on late native refusal while retaining original raw evidence', async () => {
  const f = await fixture();
  await shutdownControlStoreWorkerClient();
  f.db.sqlite.exec(`CREATE TRIGGER reject_capture_recovery BEFORE INSERT ON workspace_reconciliation_records
    BEGIN SELECT RAISE(ABORT, 'capture recovery publication fault'); END`);
  const before = rows(f.db);
  const raw = rawBytes(f);
  await openNative(f);
  // Definite native constraint is redacted; original Main READONLY is the intended pre-move RED.
  await expect(hasPendingWorkspaceCapture(f.coreDb, f.db, f.anchor)).rejects.toMatchObject({
    code: 'constraint',
    commit: 'not-committed',
    message: 'Control database writer operation failed.',
  });
  expect(rows(f.db)).toEqual(before);
  expect(listWorkspaceReconciliationRecords(f.db, f.db.workspaceId)).toEqual([]);
  expect(listStoredWorkspaceEvidenceBundles(f.db, f.db.workspaceId)).toEqual([]);
  expect(readWorkspaceCollection(f.db, f.identity)).toBeNull();
  expect(readWorkspaceSnapshotCursor(f.db, f.identity)).toEqual({
    acceptedBase: base,
    head: base,
    acceptedCommit: null,
  });
  expect(await readRawWorkspaceCapture(f.root, f.identity)).toEqual(f.source);
  expect(rawBytes(f)).toEqual(raw);
  const reader = await cold(f);
  expect(rows(reader)).toEqual(before);
});

it('accepts preserved source larger than one MiB with exact bytes, replay and cold receipt', async () => {
  // RawWorkspaceCapture permits 256 MiB; moving publication cannot reduce that admitted byte range.
  const bytes = Buffer.alloc(1024 * 1024 + 1, 0x61);
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const f = await fixture(bytes);
  expect(f.source.identity).toEqual(f.identity);
  expect(f.source.result).toMatchObject({ byteLength: bytes.length, sha256: digest });
  deepStrictEqual(f.source.candidate, bytes);
  deepStrictEqual(await readRawWorkspaceCapture(f.root, f.identity), f.source);
  const raw = rawBytes(f);
  deepStrictEqual(raw[0], bytes);
  await openNative(f);
  // Pre-move RED is the actual Main collection INSERT READONLY after admitted raw publication.
  const receipt = await acceptWorkspaceCapture(
    f.db,
    f.identity,
    f.source.result,
    f.source.candidate,
    f.source
  );
  expect(receipt.identity).toEqual(f.identity);
  expect(receipt.result).toMatchObject({ byteLength: bytes.length, sha256: digest });
  deepStrictEqual(receipt.candidate, bytes);
  expect(readWorkspaceSnapshotCursor(f.db, f.identity)).toEqual({
    acceptedBase: base,
    head,
    acceptedCommit: null,
  });
  const committed = rows(f.db);
  deepStrictEqual(
    await acceptWorkspaceCapture(f.db, f.identity, f.source.result, f.source.candidate, f.source),
    receipt
  );
  deepStrictEqual(rows(f.db), committed);
  deepStrictEqual(await readRawWorkspaceCapture(f.root, f.identity), f.source);
  deepStrictEqual(rawBytes(f), raw);
  const reader = await cold(f);
  deepStrictEqual(rows(reader), committed);
  const retained = readWorkspaceCollection(reader, f.identity);
  deepStrictEqual(retained, receipt);
  deepStrictEqual(retained?.candidate, bytes);
  expect(retained?.result).toMatchObject({ byteLength: bytes.length, sha256: digest });
});

it('retains the exact large source through native admission BUSY and discovers recovery after cold reopen', async () => {
  const bytes = Buffer.alloc(1024 * 1024 + 1, 0xa7);
  const f = await fixture(bytes);
  const before = rows(f.db);
  const raw = rawBytes(f);
  deepStrictEqual(raw[0], bytes);
  await openNative(f);
  const blocker = openWorkspaceDb(f.root, f.db.workspaceId);
  handles.push(blocker);
  const posted = vi.spyOn(Worker.prototype, 'postMessage');
  try {
    // The physical owner begins with IMMEDIATE. This real competing writer
    // therefore proves admission BUSY before the capture SQL body, not INSERT BUSY.
    blocker.sqlite.exec('BEGIN IMMEDIATE');
    const refused = acceptWorkspaceCapture(
      f.db,
      f.identity,
      f.source.result,
      f.source.candidate,
      f.source
    );
    await expect(refused).rejects.toMatchObject({ code: 'busy', commit: 'not-committed' });
    await expect(refused).rejects.not.toBeInstanceOf(PreservedWorkspaceCaptureRefusal);
    expect(
      posted.mock.calls.filter(
        ([request]) =>
          request.operation === 'workspace-capture' && request.input.action === 'accept'
      )
    ).toHaveLength(1);
    expect(f.db.sqlite.pragma('query_only', { simple: true })).toBe(1);
    deepStrictEqual(rows(f.db), before);
    deepStrictEqual(await readRawWorkspaceCapture(f.root, f.identity), f.source);
    deepStrictEqual(rawBytes(f), raw);
  } finally {
    if (blocker.sqlite.inTransaction) blocker.sqlite.exec('ROLLBACK');
    blocker.sqlite.close();
    posted.mockRestore();
  }

  const reader = await cold(f);
  deepStrictEqual(rows(reader), before);
  expect(readWorkspaceCollection(reader, f.identity)).toBeNull();
  expect(readWorkspaceSnapshotCursor(reader, f.identity)).toEqual({
    acceptedBase: base,
    head: base,
    acceptedCommit: null,
  });
  deepStrictEqual(await readRawWorkspaceCapture(f.root, f.identity), f.source);
  deepStrictEqual(rawBytes(f), raw);

  // Workspace Synchronization recovers the preserved original source. It does
  // not recollect bytes, accept the failed publication or advance its cursor.
  expect(await hasPendingWorkspaceCapture(f.coreDb, reader, f.anchor)).toBe(true);
  const records = listWorkspaceReconciliationRecords(reader, reader.workspaceId);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    stateAfter: 'requires-human',
    retentionDecision: 'retain-backend',
    backendHandleSummary: { identity: f.identity, candidateDigest: f.source.result.sha256 },
  });
  const bundles = listStoredWorkspaceEvidenceBundles(reader, reader.workspaceId);
  expect(bundles).toHaveLength(1);
  expect(records[0]!.evidenceBundleIds).toEqual([bundles[0]!.id]);
  expect(bundles[0]).toMatchObject({ contentDigests: [f.source.result.sha256] });
  expect(readWorkspaceCollection(reader, f.identity)).toBeNull();
  expect(readWorkspaceSnapshotCursor(reader, f.identity)).toEqual({
    acceptedBase: base,
    head: base,
    acceptedCommit: null,
  });
  deepStrictEqual(await readRawWorkspaceCapture(f.root, f.identity), f.source);
  deepStrictEqual(rawBytes(f), raw);
  reader.sqlite.close();
  await shutdownControlStoreWorkerClient();
  const recovered = openWorkspaceReadDb(f.root, reader.workspaceId);
  handles.push(recovered);
  expect(listWorkspaceReconciliationRecords(recovered, recovered.workspaceId)).toEqual(records);
  expect(listStoredWorkspaceEvidenceBundles(recovered, recovered.workspaceId)).toEqual(bundles);
  expect(readWorkspaceCollection(recovered, f.identity)).toBeNull();
});

it('retains unknown delivery after actual capture FULL commit loses its real Worker reply', async () => {
  const f = await fixture();
  const raw = rawBytes(f);
  await openNative(f);
  const database = `workspace:${
    nativeProductScope(f.root, {
      kind: 'workspace',
      workspaceId: f.db.workspaceId,
    }).path
  }`;
  const posted = vi.spyOn(Worker.prototype, 'postMessage');
  let reachedFull = false;
  let beforeFullFailure: unknown;
  try {
    const held = await heldCommit(2, async () => {
      try {
        return await acceptWorkspaceCapture(
          f.db,
          f.identity,
          f.source.result,
          f.source.candidate,
          f.source
        );
      } catch (error) {
        beforeFullFailure = error;
        throw error;
      }
    });
    reachedFull = true;
    // The real owner has committed this exact tuple, but its public caller has no reply.
    const receipt = readWorkspaceCollection(f.db, f.identity);
    expect(receipt?.identity).toEqual(f.identity);
    expect(receipt?.candidate).toEqual(f.bytes);
    expect(receipt?.result).toMatchObject({
      sha256: f.source.result.sha256,
      byteLength: f.bytes.length,
    });
    expect(readWorkspaceSnapshotCursor(f.db, f.identity)).toEqual({
      acceptedBase: base,
      head,
      acceptedCommit: null,
    });
    const committed = rows(f.db);
    expect(rawBytes(f)).toEqual(raw);
    // Existing worker-client test method: each real postMessage call records its actual host.
    // Opening finished before the spy; this scope has only this capture's in-flight operation.
    const capturePosts = posted.mock.calls.flatMap(([request], index) =>
      request.database === database && request.operation !== 'physical-forecast'
        ? [posted.mock.contexts[index]]
        : []
    );
    expect(capturePosts.length).toBeGreaterThan(0);
    expect(new Set(capturePosts).size).toBe(1);
    const failedHost = capturePosts[0] as Worker;
    await failedHost.terminate();
    const failure = await held.result.catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'unavailable', commit: 'unknown' });
    expect(failure).not.toBeInstanceOf(PreservedWorkspaceCaptureRefusal);
    expect(
      posted.mock.calls.filter(
        ([request]) => request.database === database && request.operation !== 'physical-forecast'
      )
    ).toHaveLength(capturePosts.length);
    expect(rows(f.db)).toEqual(committed);
    expect(await readRawWorkspaceCapture(f.root, f.identity)).toEqual(f.source);
    expect(rawBytes(f)).toEqual(raw);
    const reader = await cold(f);
    expect(rows(reader)).toEqual(committed);
    expect(readWorkspaceCollection(reader, f.identity)).toEqual(receipt);
  } catch (error) {
    if (!reachedFull && beforeFullFailure)
      throw new AggregateError(
        [beforeFullFailure, error],
        'Original capture did not reach its native FULL reply boundary.',
        { cause: beforeFullFailure }
      );
    throw error;
  } finally {
    releaseCommit();
    posted.mockRestore();
  }
});

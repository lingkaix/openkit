import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { closeSchedulerExecutionAttemptWithoutEffects } from '../runtime/execution-attempts.js';
import {
  claimNanoHostIdleCaptureDrain,
  claimNanoHostIdleSandboxDrain,
  createNanoHostHarnessRuntime,
  drainNanoHostHarnessAdmission,
  openNanoHostAgentSessionBinding,
  restoreNanoHostSandboxAdmissionIfSafe,
} from '../runtime/nanohost-harness.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  upsertNanoHostRuntimeTarget,
} from '../runtime/nanohost-runtime-target.js';
import { recordWorkerBackendSessionMaterializing } from '../runtime/worker-backend-sessions.js';
import { createAndReserveWorkerStorageAttachment } from '../runtime/worker-storage-bindings.js';
import { recordWorkspaceCaptureRecovery } from '../runtime/workspace-reconciliation-records.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from './db.js';
import { workspaceDbPath } from './fs-layout.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';

const roots: string[] = [];
const handles: (CoreDb | WorkspaceDb)[] = [];
const timestamp = '2098-08-21T00:00:00.000Z';
const physicalEpoch = 'e'.repeat(64);
const sandboxRuntimeId = 'restore-sandbox';
const sandboxBindingRef = 'restore-sandbox-binding';
const compatibility = 'a'.repeat(64);

afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const db of handles.splice(0)) if (db.sqlite.open) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Creates real Core anchors and Workspace dispositions before the native restoration owner opens. */
async function fixture(capture = false, drain = true, idle = false) {
  const root = mkdtempSync(join(tmpdir(), 'sandbox-restore-native-'));
  roots.push(root);
  const db = openCoreDb(root);
  handles.push(db);
  applyMigrations(db);
  const ownerUserId = ensureLocalUser(db);
  const workspaceId = testEntityId('ws', 'restore-workspace');
  const threadId = testEntityId('th', 'restore-thread');
  const turnId = testEntityId('tu', 'restore-turn');
  const agentSessionId = testEntityId('as', 'restore-session');
  const attemptId = testEntityId('attempt', 'restore-attempt');
  recordWorkspaceOwnerMembership({ coreDb: db, workspaceId, ownerUserId });
  const target = await allocateNanoHostRuntimeTargetConnectionGeneration(db, {
    deploymentId: 'restore-deployment',
    identityId: 'restore-target',
    targetId: 'restore-target',
    observedAt: timestamp,
  });
  await upsertNanoHostRuntimeTarget(db, {
    ...target,
    freshEmpty: true,
    predecessorFenced: true,
    ready: true,
    physicalEpoch,
    observedAt: timestamp,
  });
  const entry = createSchedulerAdmissionEntry(db, {
    backendId: 'nanohost',
    queueEntryId: 'restore-queue',
    requestId: 'restore-request',
    requestedAgentId: 'restore-agent',
    workspaceId,
    threadId,
    turnId,
    turnInput: 'Exercise admission restoration without a physical effect.',
    triggerActor: { id: ownerUserId, kind: 'user' },
    now: () => timestamp,
  });
  const packageSnapshotId = 'restore-package';
  recordTestExecutionAttempt(db, {
    entry,
    attemptId,
    agentSessionId,
    inputRef: packageSnapshotId,
    bindingRef: sandboxBindingRef,
    sessionCompatibilityKey: 'b'.repeat(64),
    now: () => timestamp,
  });
  // This is the existing Factory backend identity encoding; the real anchor owner checks its lineage.
  const sandboxId = `nh-${compatibility.slice(0, 16)}`;
  const backendSessionId = `${sandboxId}-${createHash('sha256').update(packageSnapshotId).digest('hex').slice(0, 16)}`;
  const anchor = await recordWorkerBackendSessionMaterializing(db, {
    identity: {
      agentSessionId,
      backendKind: 'nanohost',
      backendSessionId,
      deploymentId: target.deploymentId,
      packageSnapshotId,
      runtimeTargetId: target.targetId,
      stagingDirectoryRef: 'worker-staging/restore',
      transientProviderInstanceId: null,
    },
    backendVersion: null,
    backendLineage: {
      kind: 'reference',
      imageRef: `ghcr.io/openkit/worker@sha256:${'f'.repeat(64)}`,
    },
    lineage: { workspaceId, threadId, turnId },
    sandboxBindingRef,
    now: () => timestamp,
  });
  const workspace = openWorkspaceDb(root, workspaceId);
  handles.push(workspace);
  applyScopedMigrations(workspace, undefined, 'pre-knowledge');
  if (capture) {
    const layout = {
      family: null,
      version: null,
      uid: 1000,
      gid: 1000,
      workingDirectory: '/workspace',
      platform: { architecture: 'arm64', os: 'linux' },
      targets: [{ target: '/workspace' }],
    };
    const reserved = await createAndReserveWorkerStorageAttachment(db, {
      deploymentId: target.deploymentId,
      runtimeTargetId: target.targetId,
      agentSessionId,
      workspaceId,
      threadId,
      responsibleUserId: ownerUserId,
      purpose: 'work',
      layout,
      now: timestamp,
      authorizeContributor: (contributor) =>
        contributor.workspaceId === workspaceId && contributor.responsibleUserId === ownerUserId,
    });
    recordWorkspaceCaptureRecovery(
      workspace,
      anchor,
      {
        workspaceId,
        threadId,
        turnId,
        agentSessionId,
        packageSnapshotId,
        sandboxId,
        collectionId: `release-${createHash('sha256').update(packageSnapshotId).digest('hex')}`,
        storageRef: reserved.storageRef,
        scopeDigest: reserved.scopeDigest,
        workSlot: reserved.currentWorkSlotRef!,
        attachmentGeneration: reserved.attachmentGeneration,
      },
      null
    );
  }
  workspace.sqlite.close();
  await createNanoHostHarnessRuntime(db, {
    adapterId: 'codex',
    adapterVersion: '0.153.4',
    maxActiveTurns: 1,
    harnessBindingRef: 'restore-harness-binding',
    harnessCompatibilityKey: 'd'.repeat(64),
    harnessInstanceId: 'restore-harness',
    imageDigest: `sha256:${'f'.repeat(64)}`,
    originPhysicalEpoch: physicalEpoch,
    runtimeTargetId: target.targetId,
    sandboxBindingRef,
    sandboxCompatibilityKey: compatibility,
    sandboxIntegrationBindingRef: 'restore-integration',
    sandboxRuntimeId,
    timestamp,
  });
  // No Harness operation or physical effect was submitted by this fixture. Close the real
  // prepared attempt before asking the idle claim owner to establish a reversible drain.
  const closed = await closeSchedulerExecutionAttemptWithoutEffects(db, {
    attemptId,
    cause: 'restore-fixture-pre-submission-refusal',
    noOutstandingEffects: true,
    now: () => timestamp,
  });
  expect(closed).toMatchObject({ phase: 'closed', operationId: null, disposition: 'not_accepted' });
  const claim = {
    sandboxRuntimeId,
    sandboxBindingRef,
    sandboxCompatibilityKey: compatibility,
    runtimeTargetId: target.targetId,
    originPhysicalEpoch: physicalEpoch,
    physicalAbsent: false,
    timestamp,
    incoming: { workspaceId, threadId, turnId, packageSnapshotId, backendId: 'nanohost' },
    // An empty healthy Harness needs no AgentSession proof handoff. The original backend
    // anchor still identifies the Workspace whose capture disposition restoration must read.
    bindings: [],
  };
  if (idle)
    await openNanoHostAgentSessionBinding(db, {
      agentSessionCompatibilityKey: 'b'.repeat(64),
      agentSessionId,
      agentSessionRuntimeBindingId: 'restore-session-binding',
      effectiveSetupGeneration: 1,
      harnessInstanceId: 'restore-harness',
      threadId,
      workspaceId,
      timestamp,
    });
  const idleClaim = {
    harnessInstanceId: 'restore-harness',
    harnessBindingRef: 'restore-harness-binding',
    agentSessionId,
    agentSessionRuntimeBindingId: 'restore-session-binding',
    attemptId,
    sandboxBindingRef,
    originPhysicalEpoch: physicalEpoch,
  };
  if (drain) await claimNanoHostIdleSandboxDrain(db, claim);
  expect(
    db.sqlite.prepare('SELECT lifecycle_state, drain_state FROM harness_instance_records').all()
  ).toEqual([{ lifecycle_state: 'open', drain_state: drain ? 'draining' : 'accepting' }]);
  expect(
    db.sqlite
      .prepare(
        'SELECT lifecycle_state, health_state, cleanup_state, drain_state FROM sandbox_runtime_records'
      )
      .all()
  ).toEqual([
    {
      lifecycle_state: 'open',
      health_state: 'ready',
      cleanup_state: 'clean',
      drain_state: drain ? 'draining' : 'accepting',
    },
  ]);
  db.sqlite.pragma('query_only = ON');
  return { db, root, workspaceId, claim, idleClaim };
}

/** Reads all persisted columns, so an unintended state change cannot hide behind the admission projection. */
function tuple(db: CoreDb) {
  return {
    sandbox: db.sqlite
      .prepare('SELECT * FROM sandbox_runtime_records ORDER BY sandbox_runtime_id')
      .all(),
    harness: db.sqlite
      .prepare('SELECT * FROM harness_instance_records ORDER BY harness_instance_id')
      .all(),
  };
}

/** Stops the actual writer before reopening the same physical Core database. */
async function coldTuple(f: Awaited<ReturnType<typeof fixture>>) {
  await shutdownControlStoreWorkerClient();
  f.db.sqlite.close();
  const reopened = openCoreDb(f.root);
  handles.push(reopened);
  return tuple(reopened);
}

it('publishes only both admission fields through native Core and preserves them across reopen', async () => {
  const f = await fixture();
  // A corrupt unrelated Workspace must not participate in this Sandbox's deciding read set.
  const sibling = testEntityId('ws', 'restore-unanchored-sibling');
  const siblingDb = openWorkspaceDb(f.root, sibling);
  applyScopedMigrations(siblingDb, undefined, 'pre-knowledge');
  siblingDb.sqlite.close();
  const siblingPath = workspaceDbPath(f.root, sibling);
  const damaged = Buffer.from('unreadable unanchored Workspace');
  writeFileSync(siblingPath, damaged);
  const before = tuple(f.db);
  const expected = {
    sandbox: before.sandbox.map((row) => ({ ...(row as object), drain_state: 'accepting' })),
    harness: before.harness.map((row) => ({ ...(row as object), drain_state: 'accepting' })),
  };
  await expect(
    restoreNanoHostSandboxAdmissionIfSafe(f.db, { sandboxRuntimeId })
  ).resolves.toBeUndefined();
  expect(tuple(f.db)).toEqual(expected);
  expect(await coldTuple(f)).toEqual(expected);
  expect(readFileSync(siblingPath)).toEqual(damaged);
});

it('keeps both drains when the anchored Workspace has an unrecovered capture', async () => {
  const f = await fixture(true);
  const before = tuple(f.db);
  const path = workspaceDbPath(f.root, f.workspaceId);
  const workspaceBytes = readFileSync(path);
  await expect(
    restoreNanoHostSandboxAdmissionIfSafe(f.db, { sandboxRuntimeId })
  ).resolves.toBeUndefined();
  expect(tuple(f.db)).toEqual(before);
  expect(await coldTuple(f)).toEqual(before);
  expect(readFileSync(path)).toEqual(workspaceBytes);
});

it('refuses a missing anchored Workspace without creating a replacement', async () => {
  const f = await fixture();
  const before = tuple(f.db);
  const path = workspaceDbPath(f.root, f.workspaceId);
  rmSync(path);
  await expect(
    restoreNanoHostSandboxAdmissionIfSafe(f.db, { sandboxRuntimeId })
  ).resolves.toBeUndefined();
  expect(tuple(f.db)).toEqual(before);
  expect(await coldTuple(f)).toEqual(before);
  expect(existsSync(path)).toBe(false);
});

it('refuses an unreadable anchored Workspace without changing either drain', async () => {
  const f = await fixture();
  const before = tuple(f.db);
  const path = workspaceDbPath(f.root, f.workspaceId);
  const damaged = Buffer.from('unreadable anchored Workspace');
  writeFileSync(path, damaged);
  await expect(
    restoreNanoHostSandboxAdmissionIfSafe(f.db, { sandboxRuntimeId })
  ).resolves.toBeUndefined();
  expect(tuple(f.db)).toEqual(before);
  expect(await coldTuple(f)).toEqual(before);
  expect(readFileSync(path)).toEqual(damaged);
});

it('rolls back the Sandbox update when the Harness update fails in the actual worker', async () => {
  const f = await fixture();
  const before = tuple(f.db);
  // Exclude the writer before installing a persistent SQL fault that its own connection must encounter.
  await shutdownControlStoreWorkerClient();
  f.db.sqlite.pragma('query_only = OFF');
  f.db.sqlite.exec(`CREATE TRIGGER fail_restore_harness BEFORE UPDATE OF drain_state
    ON harness_instance_records WHEN NEW.drain_state = 'accepting'
    BEGIN SELECT RAISE(ABORT, 'restore harness update fault'); END`);
  f.db.sqlite.pragma('query_only = ON');
  await expect(
    restoreNanoHostSandboxAdmissionIfSafe(f.db, { sandboxRuntimeId })
  ).rejects.toMatchObject({ code: 'constraint', commit: 'not-committed' });
  expect(tuple(f.db)).toEqual(before);
  expect(await coldTuple(f)).toEqual(before);
});

it.each(['sandbox', 'sessions'] as const)(
  'refuses stale whole-Sandbox %s bindings without changing durable admission',
  async (changed) => {
    const f = await fixture(false, false);
    const before = tuple(f.db);
    await expect(
      claimNanoHostIdleSandboxDrain(f.db, {
        ...f.claim,
        sandboxBindingRef: changed === 'sandbox' ? 'different-sandbox-binding' : sandboxBindingRef,
        bindings:
          changed === 'sessions'
            ? [
                {
                  agentSessionId: testEntityId('as', 'stale-drain-session'),
                  agentSessionRuntimeBindingId: 'stale-drain-binding',
                  harnessInstanceId: 'restore-harness',
                  harnessBindingRef: 'restore-harness-binding',
                  harnessCompatibilityKey: 'd'.repeat(64),
                  lifecycleState: 'open',
                  nativeHandleDigest: null,
                },
              ]
            : [],
      })
    ).rejects.toThrow('NanoHost idle Sandbox eviction changed before drain claim.');
    expect(tuple(f.db)).toEqual(before);
    expect(await coldTuple(f)).toEqual(before);
  }
);

it('rolls back the whole-Sandbox drain when the actual native Harness update fails', async () => {
  const f = await fixture(false, false);
  const before = tuple(f.db);
  await shutdownControlStoreWorkerClient();
  f.db.sqlite.pragma('query_only = OFF');
  f.db.sqlite.exec(`CREATE TRIGGER fail_claim_harness BEFORE UPDATE OF drain_state
    ON harness_instance_records WHEN NEW.drain_state = 'draining'
    BEGIN SELECT RAISE(ABORT, 'claim harness update fault'); END`);
  f.db.sqlite.pragma('query_only = ON');
  await expect(claimNanoHostIdleSandboxDrain(f.db, f.claim)).rejects.toMatchObject({
    code: 'constraint',
    commit: 'not-committed',
  });
  expect(tuple(f.db)).toEqual(before);
  expect(await coldTuple(f)).toEqual(before);
});

it.each(['harness', 'sandbox', 'epoch', 'state'] as const)(
  'refuses an idle-capture drain with a changed %s and preserves the tuple',
  async (changed) => {
    const f = await fixture(false, false, true);
    if (changed === 'state')
      await drainNanoHostHarnessAdmission(f.db, {
        harnessBindingRef: 'restore-harness-binding',
        timestamp,
      });
    const before = tuple(f.db);
    await expect(
      claimNanoHostIdleCaptureDrain(f.db, {
        ...f.idleClaim,
        harnessBindingRef:
          changed === 'harness' ? 'other-harness-binding' : 'restore-harness-binding',
        sandboxBindingRef: changed === 'sandbox' ? 'other-sandbox-binding' : sandboxBindingRef,
        originPhysicalEpoch: changed === 'epoch' ? 'c'.repeat(64) : physicalEpoch,
      })
    ).rejects.toThrow('Idle capture drain ownership changed.');
    expect(tuple(f.db)).toEqual(before);
    expect(await coldTuple(f)).toEqual(before);
  }
);

it('claims only the exact idle-capture Harness and persists its drain after reopen', async () => {
  const f = await fixture(false, false, true);
  const before = tuple(f.db);
  await claimNanoHostIdleCaptureDrain(f.db, {
    ...f.idleClaim,
    harnessBindingRef: 'restore-harness-binding',
    sandboxBindingRef,
    originPhysicalEpoch: physicalEpoch,
  });
  const expected = {
    sandbox: before.sandbox,
    harness: before.harness.map((row) => ({ ...(row as object), drain_state: 'draining' })),
  };
  expect(tuple(f.db)).toEqual(expected);
  expect(await coldTuple(f)).toEqual(expected);
});

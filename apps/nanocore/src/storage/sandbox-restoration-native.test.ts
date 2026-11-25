import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { requireSchedulerExecutionAttempt } from '../runtime/execution-attempt-records.js';
import { closeSchedulerExecutionAttemptWithoutEffects } from '../runtime/execution-attempts.js';
import {
  claimNanoHostIdleCaptureDrain,
  claimNanoHostIdleSandboxDrain,
  createNanoHostHarnessRuntime,
  drainNanoHostHarnessAdmission,
  drainNanoHostSandboxAdmission,
  fenceNanoHostSandboxRuntime,
  openNanoHostAgentSessionBinding,
  removeNanoHostSandboxRuntimeByBinding,
  restoreNanoHostSandboxAdmissionIfSafe,
} from '../runtime/nanohost-harness.js';
import { recordWorkerBackendSessionMaterializing } from '../runtime/worker-backend-sessions.js';
import { createAndReserveWorkerStorageAttachment } from '../runtime/worker-storage-bindings.js';
import { recordWorkspaceCaptureRecovery } from '../runtime/workspace-reconciliation-records.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import {
  currentAdmittedTestNanoHostOwner,
  mutateAdmittedTestNanoHost,
  readAdmittedTestNanoHost,
  reopenAdmittedTestNanoHost,
} from '../test-support/admitted-nanohost.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordTestNativeRuntimeTarget } from '../test-support/native-environment.js';
import { schedulerFixtureInput } from '../test-support/scheduler-admissions.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from './db.js';
import { workspaceDbPath } from './fs-layout.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';
import { nativeProductScope } from './workspace-file-records.js';

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
  const target = await recordTestNativeRuntimeTarget(db, 'restore-target', {
    identityId: 'restore-target',
    allocationAt: timestamp,
    readyAt: timestamp,
    physicalEpoch,
  });
  const owner = currentAdmittedTestNanoHostOwner(db)!;
  const authorityTarget = {
    targetId: target.targetId,
    identityId: target.identityId,
    deploymentId: target.deploymentId,
    connectionGeneration: target.connectionGeneration,
    physicalEpoch: target.physicalEpoch,
  };
  const drainJoin = { write: owner.writeIdleHarnessDrain, authority: { target: authorityTarget } };
  const restoreJoin = {
    write: owner.writeIdleHarnessDrain,
    authority: { target: authorityTarget, rollback: { sandboxBindingRef, claimedAt: timestamp } },
  };
  const entry = createSchedulerAdmissionEntry(db, {
    backendId: 'nanohost',
    queueEntryId: 'restore-queue',
    requestId: 'restore-request',
    requestedAgentId: 'restore-agent',
    workspaceId,
    threadId,
    turnId,
    inputRef: schedulerFixtureInput(
      workspaceId,
      turnId,
      'Exercise admission restoration without a physical effect.'
    ),
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
  applyScopedMigrations(workspace);
  if (capture) {
    const scope = nativeProductScope(root, { kind: 'workspace', workspaceId });
    await getControlStoreWorkerClient().open({
      database: `workspace:${scope.path}`,
      path: scope.path,
      dataRoot: root,
      create: false,
      initialize: 'workspace',
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
    const layout = {
      family: null,
      version: null,
      uid: 1000,
      gid: 1000,
      workingDirectory: '/workspace',
      platform: { architecture: 'arm64', os: 'linux' },
      targets: [{ target: '/workspace' }],
    };
    const authorizeContributor: NonNullable<
      Parameters<typeof createAndReserveWorkerStorageAttachment>[2]
    >['authorizeContributor'] = (contributor) =>
      contributor.workspaceId === workspaceId && contributor.responsibleUserId === ownerUserId;
    const reserved = await createAndReserveWorkerStorageAttachment(
      db,
      {
        deploymentId: target.deploymentId,
        runtimeTargetId: target.targetId,
        agentSessionId,
        workspaceId,
        threadId,
        responsibleUserId: ownerUserId,
        purpose: 'work',
        layout,
        now: timestamp,
        authorizeContributor,
      },
      {
        attemptId,
        target,
        read: owner.read,
        write: owner.writeStorageAttachment,
        authorizeContributor,
        isCurrentAttempt: () => requireSchedulerExecutionAttempt(db, attemptId).phase !== 'closed',
      }
    );
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
  if (capture) workspace.sqlite.pragma('wal_checkpoint(TRUNCATE)');
  workspace.sqlite.close();
  await createNanoHostHarnessRuntime(owner, {
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
    await openNanoHostAgentSessionBinding(owner, {
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
    // The claim's own clock, strictly later than the Harness row's last write, as the factory picks.
    claimedAt: '2098-08-21T00:00:01.000Z',
    // G3: the fresh generation of this acquisition.
    claimGeneration: 'cg_restore_claim',
  };
  if (drain) await claimNanoHostIdleSandboxDrain(db, claim, drainJoin);
  expect(
    readAdmittedTestNanoHost(db, (sqlite) =>
      sqlite.prepare('SELECT lifecycle_state, drain_state FROM harness_instance_records').all()
    )
  ).toEqual([{ lifecycle_state: 'open', drain_state: drain ? 'draining' : 'accepting' }]);
  expect(
    readAdmittedTestNanoHost(db, (sqlite) =>
      sqlite
        .prepare(
          'SELECT lifecycle_state, health_state, cleanup_state, drain_state FROM sandbox_runtime_records'
        )
        .all()
    )
  ).toEqual([
    {
      lifecycle_state: 'open',
      health_state: 'ready',
      cleanup_state: 'clean',
      drain_state: drain ? 'draining' : 'accepting',
    },
  ]);
  db.sqlite.pragma('query_only = ON');
  return { db, root, workspaceId, claim, idleClaim, owner, drainJoin, restoreJoin };
}

/** Reads all persisted columns, so an unintended state change cannot hide behind the admission projection. */
function tuple(db: CoreDb) {
  return readAdmittedTestNanoHost(db, (sqlite) => ({
    sandbox: sqlite
      .prepare('SELECT * FROM sandbox_runtime_records ORDER BY sandbox_runtime_id')
      .all(),
    harness: sqlite
      .prepare('SELECT * FROM harness_instance_records ORDER BY harness_instance_id')
      .all(),
  }));
}

/** Stops the actual writers and rejoins the same physical NanoHost database. */
async function coldTuple(f: Awaited<ReturnType<typeof fixture>>) {
  await shutdownControlStoreWorkerClient();
  f.db.sqlite.close();
  const reopened = openCoreDb(f.root);
  handles.push(reopened);
  await reopenAdmittedTestNanoHost(reopened);
  return tuple(reopened);
}

it('publishes only both admission fields through native Core and preserves them across reopen', async () => {
  const f = await fixture();
  // A corrupt unrelated Workspace must not participate in this Sandbox's deciding read set.
  const sibling = testEntityId('ws', 'restore-unanchored-sibling');
  const siblingDb = openWorkspaceDb(f.root, sibling);
  applyScopedMigrations(siblingDb);
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
    restoreNanoHostSandboxAdmissionIfSafe(f.db, { sandboxRuntimeId }, f.restoreJoin)
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
    restoreNanoHostSandboxAdmissionIfSafe(f.db, { sandboxRuntimeId }, f.restoreJoin)
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
    restoreNanoHostSandboxAdmissionIfSafe(f.db, { sandboxRuntimeId }, f.restoreJoin)
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
    restoreNanoHostSandboxAdmissionIfSafe(f.db, { sandboxRuntimeId }, f.restoreJoin)
  ).resolves.toBeUndefined();
  expect(tuple(f.db)).toEqual(before);
  expect(await coldTuple(f)).toEqual(before);
  expect(readFileSync(path)).toEqual(damaged);
});

it('rolls back the Sandbox update when the Harness update fails in the actual worker', async () => {
  const f = await fixture();
  const before = tuple(f.db);
  // No writer is in flight; install a persistent fault on the Native side of the held pair.
  mutateAdmittedTestNanoHost(f.db, (sqlite) =>
    sqlite.exec(`CREATE TRIGGER fail_restore_harness BEFORE UPDATE OF drain_state
      ON harness_instance_records WHEN NEW.drain_state = 'accepting'
      BEGIN SELECT RAISE(ABORT, 'restore harness update fault'); END`)
  );
  await expect(
    restoreNanoHostSandboxAdmissionIfSafe(f.db, { sandboxRuntimeId }, f.restoreJoin)
  ).rejects.toMatchObject({ code: 'constraint', commit: 'not-committed' });
  expect(tuple(f.db)).toEqual(before);
  // The schema admission on reopen must see the shipped schema, not the injected fault.
  mutateAdmittedTestNanoHost(f.db, (sqlite) => sqlite.exec('DROP TRIGGER fail_restore_harness'));
  expect(await coldTuple(f)).toEqual(before);
});

it.each(['sandbox', 'sessions'] as const)(
  'refuses stale whole-Sandbox %s bindings without changing durable admission',
  async (changed) => {
    const f = await fixture(false, false);
    const before = tuple(f.db);
    await expect(
      claimNanoHostIdleSandboxDrain(
        f.db,
        {
          ...f.claim,
          sandboxBindingRef:
            changed === 'sandbox' ? 'different-sandbox-binding' : sandboxBindingRef,
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
        },
        f.drainJoin
      )
    ).rejects.toThrow('NanoHost idle Sandbox eviction changed before drain claim.');
    expect(tuple(f.db)).toEqual(before);
    expect(await coldTuple(f)).toEqual(before);
  }
);

it('rolls back the whole-Sandbox drain when the actual native Harness update fails', async () => {
  const f = await fixture(false, false);
  const before = tuple(f.db);
  mutateAdmittedTestNanoHost(f.db, (sqlite) =>
    sqlite.exec(`CREATE TRIGGER fail_claim_harness BEFORE UPDATE OF drain_state
      ON harness_instance_records WHEN NEW.drain_state = 'draining'
      BEGIN SELECT RAISE(ABORT, 'claim harness update fault'); END`)
  );
  await expect(claimNanoHostIdleSandboxDrain(f.db, f.claim, f.drainJoin)).rejects.toMatchObject({
    code: 'constraint',
    commit: 'not-committed',
  });
  expect(tuple(f.db)).toEqual(before);
  mutateAdmittedTestNanoHost(f.db, (sqlite) => sqlite.exec('DROP TRIGGER fail_claim_harness'));
  expect(await coldTuple(f)).toEqual(before);
});

it.each(['harness', 'sandbox', 'epoch', 'state'] as const)(
  'refuses an idle-capture drain with a changed %s and preserves the tuple',
  async (changed) => {
    const f = await fixture(false, false, true);
    if (changed === 'state')
      await drainNanoHostHarnessAdmission(f.owner, {
        harnessBindingRef: 'restore-harness-binding',
        timestamp,
      });
    const before = tuple(f.db);
    await expect(
      claimNanoHostIdleCaptureDrain(
        f.db,
        {
          ...f.idleClaim,
          harnessBindingRef:
            changed === 'harness' ? 'other-harness-binding' : 'restore-harness-binding',
          sandboxBindingRef: changed === 'sandbox' ? 'other-sandbox-binding' : sandboxBindingRef,
          originPhysicalEpoch: changed === 'epoch' ? 'c'.repeat(64) : physicalEpoch,
        },
        f.owner.harnessTurnLifecycle
      )
    ).rejects.toThrow('Idle capture drain ownership changed.');
    expect(tuple(f.db)).toEqual(before);
    expect(await coldTuple(f)).toEqual(before);
  }
);

it('claims only the exact idle-capture Harness and persists its drain after reopen', async () => {
  const f = await fixture(false, false, true);
  const before = tuple(f.db);
  await claimNanoHostIdleCaptureDrain(
    f.db,
    {
      ...f.idleClaim,
      harnessBindingRef: 'restore-harness-binding',
      sandboxBindingRef,
      originPhysicalEpoch: physicalEpoch,
    },
    f.owner.harnessTurnLifecycle
  );
  const expected = {
    sandbox: before.sandbox,
    harness: before.harness.map((row) => ({
      ...(row as object),
      drain_state: 'draining',
      updated_at: f.idleClaim.claimedAt,
      claim_generation: f.idleClaim.claimGeneration,
    })),
  };
  expect(tuple(f.db)).toEqual(expected);
  expect(await coldTuple(f)).toEqual(expected);
});

it('refuses a later idle-capture claim on a Harness that an earlier claim already drains (CL3)', async () => {
  const f = await fixture(false, false, true);
  const claim = {
    ...f.idleClaim,
    harnessBindingRef: 'restore-harness-binding',
    sandboxBindingRef,
    originPhysicalEpoch: physicalEpoch,
  };
  await claimNanoHostIdleCaptureDrain(f.db, claim, f.owner.harnessTurnLifecycle);
  const latched = tuple(f.db);
  // A strictly later clock is not enough: the Harness is no longer accepting, so the earlier
  // claim keeps the latch, its revision and its generation.
  await expect(
    claimNanoHostIdleCaptureDrain(
      f.db,
      { ...claim, claimedAt: '2098-08-21T00:00:02.000Z', claimGeneration: 'cg_later_claim' },
      f.owner.harnessTurnLifecycle
    )
  ).rejects.toThrow('Idle capture drain ownership changed.');
  expect(tuple(f.db)).toEqual(latched);
  expect(await coldTuple(f)).toEqual(latched);
});

it('refuses an idle-capture claim whose clock is not later than the Harness revision', async () => {
  const f = await fixture(false, false, true);
  const before = tuple(f.db);
  // An equal clock would give two writes one revision, so an exact latch restore could not
  // tell the later claim from the earlier write.
  await expect(
    claimNanoHostIdleCaptureDrain(
      f.db,
      { ...f.idleClaim, claimedAt: timestamp },
      f.owner.harnessTurnLifecycle
    )
  ).rejects.toThrow('Idle capture drain ownership changed.');
  expect(tuple(f.db)).toEqual(before);
  expect(await coldTuple(f)).toEqual(before);
});

// CLOSE-LC S3b (G3): the claim generation through the file-backed Native writer.

/** A's idle-capture claim clock (the fixture's `idleClaim.claimedAt`) and offsets from it. */
const claimedAtA = '2098-08-21T00:00:01.000Z';
const at = (ms: number) => new Date(Date.parse(claimedAtA) + ms).toISOString();

/** The claim-arm frame of one claim: its own revision and generation (Q6 rollback, cold P2/P3). */
function claimFrame(revision: string, generation: string) {
  return {
    sandboxRuntimeId,
    harness: {
      harnessInstanceId: 'restore-harness',
      harnessBindingRef: 'restore-harness-binding',
      claim: { revision },
      generation,
    },
  };
}

/** The Harness admission, clock, generation and occupancy that a restore compares or keeps. */
function harnessRow(db: CoreDb) {
  return readAdmittedTestNanoHost(db, (sqlite) =>
    sqlite
      .prepare(`SELECT lifecycle_state AS life, drain_state AS drain, updated_at AS revision,
      claim_generation AS generation, open_session_count AS open, active_turn_count AS active
      FROM harness_instance_records`)
      .get()
  ) as {
    life: string;
    drain: string;
    revision: string;
    generation: string | null;
    open: number;
    active: number;
  };
}

/** Stops the actual writers and returns the reopened Core, its admitted owner and its restore join. */
async function reopen(f: Awaited<ReturnType<typeof fixture>>) {
  await shutdownControlStoreWorkerClient();
  f.db.sqlite.close();
  const db = openCoreDb(f.root);
  handles.push(db);
  // The restarted process opens the Core writer before it rejoins NanoHost, as boot does.
  const core = nativeProductScope(f.root, { kind: 'server' });
  await getControlStoreWorkerClient().open({
    database: `core:${core.path}`,
    path: core.path,
    dataRoot: f.root,
    create: false,
    initialize: 'core',
    productOwner: { kind: 'server' },
    contentMount: core.contentMount,
  });
  await reopenAdmittedTestNanoHost(db);
  const owner = currentAdmittedTestNanoHostOwner(db)!;
  return {
    db,
    owner,
    join: { write: owner.writeIdleHarnessDrain, authority: f.drainJoin.authority },
  };
}

/**
 * V1-P's no-sequence schedule: one more idle binding opens at `timestamp`. The binding writer sets
 * the Harness clock to it and queues no operation, so the clock can step back below a released claim.
 */
async function openBindingAt(
  writer: Parameters<typeof openNanoHostAgentSessionBinding>[0],
  f: Awaited<ReturnType<typeof fixture>>,
  timestamp: string
) {
  await openNanoHostAgentSessionBinding(writer, {
    agentSessionCompatibilityKey: 'c'.repeat(64),
    agentSessionId: testEntityId('as', 'restore-open-session'),
    agentSessionRuntimeBindingId: 'restore-open-binding',
    effectiveSetupGeneration: 1,
    harnessInstanceId: 'restore-harness',
    // A Thread has at most one current AgentSession on a Harness.
    threadId: testEntityId('th', 'restore-open-thread'),
    workspaceId: f.workspaceId,
    timestamp,
  });
}

it('restores its own idle-capture claim through the claim arm and keeps the cleared generation after reopen (S3b G3)', async () => {
  const f = await fixture(false, false, true);
  const before = tuple(f.db);
  await claimNanoHostIdleCaptureDrain(f.db, f.idleClaim, f.owner.harnessTurnLifecycle);
  expect(harnessRow(f.db)).toMatchObject({ drain: 'draining', generation: 'cg_restore_claim' });
  await restoreNanoHostSandboxAdmissionIfSafe(
    f.db,
    claimFrame(f.idleClaim.claimedAt, f.idleClaim.claimGeneration),
    f.drainJoin
  );
  // The written row: accepting, the claim's revision, and the generation column cleared.
  const expected = {
    sandbox: before.sandbox,
    harness: before.harness.map((row) => ({
      ...(row as object),
      updated_at: f.idleClaim.claimedAt,
      claim_generation: null,
    })),
  };
  expect(tuple(f.db)).toEqual(expected);
  expect(await coldTuple(f)).toEqual(expected);
});

it.each([
  ['99', -1, 0],
  ['101', 1, 2],
] as const)(
  'keeps a later claim when a released claim frame arrives again after reopen and a binding opens at %s (S3b G3)',
  async (_stamp, openOffset, claimOffset) => {
    const f = await fixture(false, false, true);
    await claimNanoHostIdleCaptureDrain(f.db, f.idleClaim, f.owner.harnessTurnLifecycle);
    const frame = claimFrame(f.idleClaim.claimedAt, f.idleClaim.claimGeneration);
    await restoreNanoHostSandboxAdmissionIfSafe(f.db, frame, f.drainJoin);
    expect(harnessRow(f.db)).toMatchObject({ drain: 'accepting', generation: null });
    // A's restore ACK is lost after its commit; the process stops and keeps the frame.
    const r = await reopen(f);
    // At 99 the binding steps the clock back 1 ms below A's revision, so B claims at exactly A's
    // revision. At 101 (the control) B claims at its own later stamp.
    await openBindingAt(r.owner, f, at(openOffset));
    await claimNanoHostIdleCaptureDrain(
      r.db,
      { ...f.idleClaim, claimedAt: at(claimOffset), claimGeneration: 'cg_restore_later' },
      r.owner.harnessTurnLifecycle
    );
    const claimed = tuple(r.db);
    expect(harnessRow(r.db)).toMatchObject({
      life: 'open',
      drain: 'draining',
      revision: at(claimOffset),
      generation: 'cg_restore_later',
    });
    // A's original frame arrives: zero rows change, and B keeps its drain and its generation.
    await restoreNanoHostSandboxAdmissionIfSafe(r.db, frame, r.join);
    expect(tuple(r.db)).toEqual(claimed);
    expect(await coldTuple({ ...f, db: r.db })).toEqual(claimed);
  }
);

it('keeps a claim on a same-name recreated Harness when the retired claim frame arrives (S3b G3)', async () => {
  const f = await fixture(false, false, true);
  await claimNanoHostIdleCaptureDrain(f.db, f.idleClaim, f.owner.harnessTurnLifecycle);
  const frame = claimFrame(f.idleClaim.claimedAt, f.idleClaim.claimGeneration);
  // Retirement deletes the Sandbox projection with its Harness and bindings. The same names are
  // created again below A's revision, so B's claim recurs at exactly A's revision.
  await removeNanoHostSandboxRuntimeByBinding(f.owner, sandboxBindingRef);
  await createNanoHostHarnessRuntime(f.owner, {
    adapterId: 'codex',
    adapterVersion: '0.153.4',
    maxActiveTurns: 1,
    harnessBindingRef: 'restore-harness-binding',
    harnessCompatibilityKey: 'd'.repeat(64),
    harnessInstanceId: 'restore-harness',
    imageDigest: `sha256:${'f'.repeat(64)}`,
    originPhysicalEpoch: physicalEpoch,
    runtimeTargetId: f.drainJoin.authority.target.targetId,
    sandboxBindingRef,
    sandboxCompatibilityKey: compatibility,
    sandboxIntegrationBindingRef: 'restore-integration',
    sandboxRuntimeId,
    timestamp: at(-2),
  });
  // The recreated row starts with no generation.
  expect(harnessRow(f.db)).toMatchObject({ drain: 'accepting', generation: null });
  await openNanoHostAgentSessionBinding(f.owner, {
    agentSessionCompatibilityKey: 'b'.repeat(64),
    agentSessionId: f.idleClaim.agentSessionId,
    agentSessionRuntimeBindingId: f.idleClaim.agentSessionRuntimeBindingId,
    effectiveSetupGeneration: 1,
    harnessInstanceId: 'restore-harness',
    threadId: testEntityId('th', 'restore-thread'),
    workspaceId: f.workspaceId,
    timestamp: at(-1),
  });
  await claimNanoHostIdleCaptureDrain(
    f.db,
    { ...f.idleClaim, claimGeneration: 'cg_restore_recreated' },
    f.owner.harnessTurnLifecycle
  );
  const claimed = tuple(f.db);
  expect(harnessRow(f.db)).toMatchObject({
    drain: 'draining',
    revision: f.idleClaim.claimedAt,
    generation: 'cg_restore_recreated',
  });
  await restoreNanoHostSandboxAdmissionIfSafe(f.db, frame, f.drainJoin);
  expect(tuple(f.db)).toEqual(claimed);
  expect(await coldTuple(f)).toEqual(claimed);
});

it.each(['harness-drain', 'sandbox-drain', 'fence'] as const)(
  'invalidates the claim generation at an independent %s, and the claim frame changes no row (S3b G3)',
  async (writer) => {
    const f = await fixture(false, false, true);
    await claimNanoHostIdleCaptureDrain(f.db, f.idleClaim, f.owner.harnessTurnLifecycle);
    if (writer === 'harness-drain')
      // The equal-stamp drain: the independent owner writes A's own claim revision.
      await drainNanoHostHarnessAdmission(f.owner, {
        harnessBindingRef: 'restore-harness-binding',
        timestamp: f.idleClaim.claimedAt,
      });
    else if (writer === 'sandbox-drain')
      await drainNanoHostSandboxAdmission(f.owner, {
        sandboxBindingRef,
        originPhysicalEpoch: physicalEpoch,
      });
    else await fenceNanoHostSandboxRuntime(f.owner, { sandboxBindingRef, timestamp: at(1) });
    // The written row: the independent owner's drain, with A's generation invalidated.
    expect(harnessRow(f.db)).toMatchObject({ life: 'failed', drain: 'draining', generation: null });
    const drained = tuple(f.db);
    await restoreNanoHostSandboxAdmissionIfSafe(
      f.db,
      claimFrame(f.idleClaim.claimedAt, f.idleClaim.claimGeneration),
      f.drainJoin
    );
    expect(tuple(f.db)).toEqual(drained);
    expect(await coldTuple(f)).toEqual(drained);
  }
);

it('releases a claim once in the opposite order, its duplicate changes no row, and a later claim then takes the Harness (S3b G3)', async () => {
  const f = await fixture(false, false, true);
  await claimNanoHostIdleCaptureDrain(f.db, f.idleClaim, f.owner.harnessTurnLifecycle);
  const later = { ...f.idleClaim, claimedAt: at(1), claimGeneration: 'cg_restore_later' };
  // CL3: B cannot claim while A's latch holds.
  await expect(
    claimNanoHostIdleCaptureDrain(f.db, later, f.owner.harnessTurnLifecycle)
  ).rejects.toThrow('Idle capture drain ownership changed.');
  const frame = claimFrame(f.idleClaim.claimedAt, f.idleClaim.claimGeneration);
  await restoreNanoHostSandboxAdmissionIfSafe(f.db, frame, f.drainJoin);
  const released = tuple(f.db);
  expect(harnessRow(f.db)).toMatchObject({
    drain: 'accepting',
    revision: f.idleClaim.claimedAt,
    generation: null,
  });
  await restoreNanoHostSandboxAdmissionIfSafe(f.db, frame, f.drainJoin);
  expect(tuple(f.db)).toEqual(released);
  await claimNanoHostIdleCaptureDrain(f.db, later, f.owner.harnessTurnLifecycle);
  expect(harnessRow(f.db)).toMatchObject({
    drain: 'draining',
    revision: at(1),
    generation: 'cg_restore_later',
  });
});

it('restores nothing for a Harness frame that carries Sandbox rollback authority (S3b G3)', async () => {
  // The whole-Sandbox claim drains the Sandbox and the Harness at `timestamp`, the rollback clock.
  const f = await fixture(false, true);
  const before = tuple(f.db);
  await restoreNanoHostSandboxAdmissionIfSafe(
    f.db,
    claimFrame(timestamp, 'cg_restore_claim'),
    f.restoreJoin
  );
  expect(tuple(f.db)).toEqual(before);
  expect(await coldTuple(f)).toEqual(before);
});

it('keeps a legacy claim without a generation fenced against every claim frame (S3b G3)', async () => {
  const f = await fixture(false, false, true);
  await claimNanoHostIdleCaptureDrain(f.db, f.idleClaim, f.owner.harnessTurnLifecycle);
  // A claim from before the migration: the upgrade leaves its generation null.
  mutateAdmittedTestNanoHost(f.db, (sqlite) =>
    sqlite.exec('UPDATE harness_instance_records SET claim_generation = NULL')
  );
  const legacy = tuple(f.db);
  expect(harnessRow(f.db)).toMatchObject({ drain: 'draining', generation: null });
  await restoreNanoHostSandboxAdmissionIfSafe(
    f.db,
    claimFrame(f.idleClaim.claimedAt, f.idleClaim.claimGeneration),
    f.drainJoin
  );
  expect(tuple(f.db)).toEqual(legacy);
  expect(await coldTuple(f)).toEqual(legacy);
});

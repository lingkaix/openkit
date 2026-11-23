import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindBootNanoHostAttemptRecovery } from '../bootstrap/nanohost-recovery.js';
import { runBootPhases } from '../bootstrap/phases.js';
import { refuseScope } from '../bootstrap/readiness.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import type { CoreDb } from '../storage/db.js';
import {
  openAdmittedTestNanoHost,
  readAdmittedTestNanoHost,
} from '../test-support/admitted-nanohost.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import {
  readTestNanoHostWorkerLease,
  submitTestNanoHostWorkerLease,
} from '../test-support/nanohost-worker-lease.js';
import { transitionTestNativeRuntimeTargetFields } from '../test-support/native-environment.js';
import { schedulerFixtureInput } from '../test-support/scheduler-admissions.js';
import {
  createTestCoreDb,
  disposeTestStore,
  setTestBackendSessionTurn,
  setTestExecutionAttemptBackend,
} from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import * as attempts from './execution-attempt-records.js';
import { closeSchedulerExecutionAttemptWithoutEffects } from './execution-attempts.js';
import {
  classifyNanoHostAttemptsAfterRestart,
  type RunNanoHostAttemptRecoveryInput,
} from './nanohost-attempt-recovery.js';
import { getNanoHostRuntimeTarget } from './nanohost-runtime-target.js';
import {
  type PreAnchorRecoveryContext,
  runSchedulerRecoveryMaintenance,
  runSchedulerRestartRecovery,
} from './scheduler-restart-recovery.js';
import {
  getWorkerBackendSession,
  recordWorkerBackendSessionMaterializing,
} from './worker-backend-sessions.js';

const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const now = () => '2026-07-05T00:01:00.000Z';
const databases: CoreDb[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) await disposeTestStore(db.dataRoot, db);
});

/** Creates genuine admitted attempt owners, with no external runtime or launch. */
async function fixture() {
  const db = createTestCoreDb(mkdtempSync(join(tmpdir(), 'openkit-boot-isolation-')));
  databases.push(db);
  ensureLocalUser(db);
  const store = await createDemoStore({ dataRoot: db.dataRoot });
  recordWorkspaceOwnerMembership({ coreDb: db, ownerUserId: FIXTURE_LOCAL_USER_ID, workspaceId });
  const input: RunNanoHostAttemptRecoveryInput = {
    executionBackend: new SimulatedTurnExecutor({ coreDb: db }),
    now,
    projectRecoveredTurn: vi.fn(async () => ({ status: 'failed' as const })),
    reconcileExecutions: vi.fn(async () => {}),
    cleanupBackendSession: vi.fn(async () => {}),
    prepareBackendCleanup: vi.fn(() => false),
    restoreBackendSession: vi.fn(async () => {}),
    reconcileAcceptedFinalStatus: vi.fn(async () => {}),
  };
  return { db, store, input };
}

/** Uses the admission and attempt owners; native preparation adds no accepted effect. */
function isolationAdmission(
  db: CoreDb,
  suffix: string,
  backendId = 'nanohost',
  workspace = workspaceId
) {
  return createSchedulerAdmissionEntry(db, {
    backendId,
    triggerActor: { kind: 'user', id: FIXTURE_LOCAL_USER_ID },
    queueEntryId: `queue_${suffix}`,
    requestId: `request_${suffix}`,
    requestedAgentId: 'agent_codex_host',
    threadId: testEntityId('th', suffix),
    turnId: testEntityId('tu', suffix),
    inputRef: schedulerFixtureInput(
      workspace,
      testEntityId('tu', suffix),
      'Recover original attempt'
    ),
    workspaceId: workspace,
    now: () => '2026-07-05T00:00:01.000Z',
  });
}

function attempt(
  db: CoreDb,
  suffix: string,
  submitted = false,
  backendId = 'nanohost',
  workspace = workspaceId
) {
  const entry = isolationAdmission(db, suffix, backendId, workspace);
  return recordTestExecutionAttempt(db, {
    entry,
    attemptId: testEntityId('attempt', suffix),
    agentSessionId: testEntityId('as', suffix),
    inputRef: `aepsnap_${entry.turnId}_${testEntityId('as', suffix)}`,
    bindingRef: `binding_${suffix}`,
    sessionCompatibilityKey: 'sha256:boot-isolation',
    now: () => '2026-07-05T00:00:02.000Z',
    ...(submitted ? { operationId: `operation_${suffix}` } : {}),
  });
}

/**
 * A claim that has not submitted holds its Workspace. A live pre-effect sibling therefore claims
 * in a second Workspace with the same owner.
 */
async function siblingWorkspace(db: CoreDb, store: Awaited<ReturnType<typeof fixture>>['store']) {
  const workspace = await store.createWorkspace('Recovery sibling');
  recordWorkspaceOwnerMembership({
    coreDb: db,
    ownerUserId: FIXTURE_LOCAL_USER_ID,
    workspaceId: workspace.id,
  });
  return workspace.id;
}

/** Records the physical identity through its owner before introducing a retained-state fault. */
async function anchored(db: CoreDb, suffix: string) {
  const row = attempt(db, suffix, true);
  if (!getNanoHostRuntimeTarget(db, 'runtime-target-isolation')) {
    const allocated = await transitionTestNativeRuntimeTargetFields('allocate', db, {
      deploymentId: 'deployment-isolation',
      identityId: 'identity-isolation',
      observedAt: '2026-07-05T00:00:00.000Z',
      targetId: 'runtime-target-isolation',
    });
    await transitionTestNativeRuntimeTargetFields('ready', db, {
      ...allocated,
      freshEmpty: true,
      observedAt: '2026-07-05T00:00:01.000Z',
      physicalEpoch: 'a'.repeat(64),
      predecessorFenced: true,
      ready: true,
    });
  }
  await recordWorkerBackendSessionMaterializing(db, {
    identity: {
      agentSessionId: row.agentSessionId!,
      backendKind: 'openshell',
      backendSessionId: `nh-${suffix}`,
      deploymentId: 'deployment-isolation',
      packageSnapshotId: row.inputRef!,
      runtimeTargetId: 'runtime-target-isolation',
      stagingDirectoryRef: `server/runtime/worker-backend-sessions/${suffix}`,
      transientProviderInstanceId: null,
    },
    backendVersion: '0.0.99',
    backendLineage: { kind: 'reference', imageRef: 'openkit/worker-codex:dev' },
    lineage: row,
    sandboxBindingRef: row.bindingRef!,
    now: () => '2026-07-05T00:00:03.000Z',
  });
  return row;
}

describe('restart classification fault isolation (T4)', () => {
  it('continues after failed Turn publication and retries the original no-effect proof after listen', async () => {
    const { db, store, input } = await fixture();
    const bad = attempt(db, 'projection-fault');
    const healthy = attempt(
      db,
      'projection-healthy',
      false,
      'nanohost',
      await siblingWorkspace(db, store)
    );
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const project = vi.fn(async (subject: PreAnchorRecoveryContext) => {
      if (subject.attemptId === bad.attemptId) throw new Error('private injected fault');
      return { status: 'failed' as const };
    });
    let recovery: Awaited<ReturnType<typeof runSchedulerRestartRecovery>> | undefined;
    const listenAdmission = vi.fn();
    const boot = await runBootPhases({
      bootId: 'boot-attempt-isolation',
      phases: [
        {
          name: 'scheduler-restart-recovery',
          subsystem: 'scheduler',
          critical: true,
          run: async () => {
            recovery = await runSchedulerRestartRecovery(db, {
              ...input,
              projectRecoveredTurn: project,
            });
            // Import after classification so baseline injection reaches boot refusal before this new export.
            const { schedulerRestartRecoveryOutcome } = await import(
              './scheduler-restart-recovery.js'
            );
            return schedulerRestartRecoveryOutcome(recovery.failedAttemptIds, 0);
          },
        },
        {
          name: 'listen-admission',
          subsystem: 'config',
          critical: true,
          run: () => {
            listenAdmission();
            return { status: 'ok' };
          },
        },
      ],
    });
    expect(boot.readiness.acceptingProductWork).toBe(true);
    expect(boot.readiness.subsystems.scheduler).toMatchObject({
      state: 'degraded',
      reasons: [{ code: 'scheduler.attempt_recovery_failed', blocks: [] }],
    });
    expect(listenAdmission).toHaveBeenCalledOnce();
    expect(recovery).toMatchObject({
      preparationFailedAttemptIds: [healthy.attemptId],
      failedAttemptIds: [bad.attemptId],
    });
    expect(project).toHaveBeenCalledTimes(2);
    expect(attempts.requireSchedulerExecutionAttempt(db, bad.attemptId)).toMatchObject({
      phase: 'closed',
      disposition: 'not_accepted',
      operationId: null,
    });
    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain('private injected fault');
    const retry = vi.fn(async () => ({ status: 'failed' as const }));
    await runSchedulerRecoveryMaintenance(db, { ...input, projectRecoveredTurn: retry });
    expect(retry).toHaveBeenCalledWith(expect.objectContaining({ attemptId: bad.attemptId }));
    const healthyWorkspace = await store.ensureQuickChatWorkspace(FIXTURE_LOCAL_USER_ID);
    expect(healthyWorkspace.id).not.toBe(workspaceId);
    const thread = await store.createThread(
      healthyWorkspace.id,
      'Healthy sibling work',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: FIXTURE_LOCAL_USER_ID }
    );
    const turn = await store.createTurn(healthyWorkspace.id, thread.id, 'New authorized work', {
      kind: 'user',
      id: FIXTURE_LOCAL_USER_ID,
    });
    expect(store.getTurnById(turn.id)).toMatchObject({ status: 'running', threadId: thread.id });
  });

  it('skips a changed backend without changing its attempt and still classifies its sibling', async () => {
    const { db, store, input } = await fixture();
    // Boot has only the new backend; the foreign attempt keeps its original admitted backend.
    const foreign = attempt(db, 'foreign-backend', false, 'unavailable-backend');
    const healthy = attempt(
      db,
      'backend-healthy',
      false,
      'nanohost',
      await siblingWorkspace(db, store)
    );
    const before = attempts.requireSchedulerExecutionAttempt(db, foreign.attemptId);
    const recovery = await runSchedulerRestartRecovery(db, input);
    expect(recovery).toMatchObject({ failedAttemptIds: [foreign.attemptId] });
    expect(attempts.requireSchedulerExecutionAttempt(db, foreign.attemptId)).toEqual(before);
    expect(attempts.requireSchedulerExecutionAttempt(db, healthy.attemptId).phase).toBe('closed');
    expect(input.projectRecoveredTurn).toHaveBeenCalledTimes(1);
  });

  it('keeps possible effects and quarantined Workspace authority excluded during generic classification', async () => {
    const { db, input } = await fixture();
    const effect = attempt(db, 'unknown-effect', true);
    await runSchedulerRestartRecovery(db, input);
    expect(attempts.requireSchedulerExecutionAttempt(db, effect.attemptId)).toEqual(effect);
    const preEffect = attempt(db, 'quarantined');
    refuseScope(db.dataRoot, { scope: 'workspace', id: workspaceId, check: 'records' });
    await runSchedulerRestartRecovery(db, input);
    expect(attempts.requireSchedulerExecutionAttempt(db, preEffect.attemptId)).toEqual(preEffect);
    expect(input.projectRecoveredTurn).not.toHaveBeenCalled();
  });

  it('skips product publication for a closed no-effect attempt belonging to a different backend', async () => {
    const { db, input } = await fixture();
    const foreign = attempt(db, 'closed-foreign-backend', false, 'unavailable-backend');
    await closeSchedulerExecutionAttemptWithoutEffects(db, {
      attemptId: foreign.attemptId,
      noOutstandingEffects: true,
      cause: 'restart-before-effects',
      now,
    });
    const before = attempts.requireSchedulerExecutionAttempt(db, foreign.attemptId);
    await runSchedulerRecoveryMaintenance(db, input);
    expect(input.projectRecoveredTurn).not.toHaveBeenCalled();
    expect(attempts.requireSchedulerExecutionAttempt(db, foreign.attemptId)).toEqual(before);
  });

  it('holds corrupt native lineage and continues preparing exact cleanup for a healthy sibling', async () => {
    const { db, store, input } = await fixture();
    const storage = await openAdmittedTestNanoHost(db);
    const goodWorkspace = await store.createWorkspace('Independent healthy recovery');
    recordWorkspaceOwnerMembership({
      coreDb: db,
      ownerUserId: FIXTURE_LOCAL_USER_ID,
      workspaceId: goodWorkspace.id,
    });
    const retain = (suffix: string, workspace: string) => {
      const admission = isolationAdmission(db, suffix, 'nanohost', workspace);
      const agentSessionId = testEntityId('as', suffix);
      return submitTestNanoHostWorkerLease(
        db,
        admission,
        `binding_${suffix}`,
        {
          agentSessionId,
          packageSnapshotId: `aepsnap_${admission.turnId}_${agentSessionId}`,
          workerControlTokenHash: 'a'.repeat(64),
          workerInferenceTokenHash: 'b'.repeat(64),
          workerCapabilityTokenHash: 'c'.repeat(64),
        },
        {
          attemptId: testEntityId('attempt', suffix),
          observedAt: '2026-07-05T00:00:02.000Z',
        }
      );
    };
    const bad = retain('native-fault', workspaceId);
    const healthy = retain('native-healthy', goodWorkspace.id);
    await setTestBackendSessionTurn(db, bad.attemptId, testEntityId('tu', 'wrong-lineage'));
    const session = (attemptId: string) =>
      readAdmittedTestNanoHost(db, (sqlite) => getWorkerBackendSession({ sqlite }, attemptId));
    const before = session(bad.attemptId);
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      classifyNanoHostAttemptsAfterRestart(db, {
        ...input,
        admittedNanoHostRecovery: {
          state: 'ready',
          value: bindBootNanoHostAttemptRecovery(storage.value.owner),
        },
      })
    ).resolves.toMatchObject({
      failedAttemptIds: [bad.attemptId],
    });
    expect(attempts.requireSchedulerExecutionAttempt(db, bad.attemptId)).toEqual(bad);
    expect(session(bad.attemptId)).toEqual(before);
    expect(attempts.requireSchedulerExecutionAttempt(db, healthy.attemptId).phase).toBe('closing');
    // Boot now records the exact Native recovery requirement, leaving physical cleanup to maintenance.
    expect(readTestNanoHostWorkerLease(db, healthy.attemptId)).toMatchObject({
      attemptId: healthy.attemptId,
      phase: 'closing',
      recoveryState: 'needs-evidence',
      fenceRef: null,
    });
    expect(input.prepareBackendCleanup).not.toHaveBeenCalled();
    expect(input.cleanupBackendSession).not.toHaveBeenCalled();
    expect(input.projectRecoveredTurn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });

  it('skips a native backend mismatch without arming reconnect or cleanup', async () => {
    const { db, input } = await fixture();
    const foreign = await anchored(db, 'native-foreign');
    await setTestExecutionAttemptBackend(db, foreign.attemptId, 'unavailable-backend');
    const before = attempts.requireSchedulerExecutionAttempt(db, foreign.attemptId);
    const session = getWorkerBackendSession(db, foreign.attemptId);
    const recovery = await classifyNanoHostAttemptsAfterRestart(db, input);
    expect(attempts.requireSchedulerExecutionAttempt(db, foreign.attemptId)).toEqual(before);
    expect(getWorkerBackendSession(db, foreign.attemptId)).toEqual(session);
    expect(input.restoreBackendSession).not.toHaveBeenCalled();
    expect(input.prepareBackendCleanup).not.toHaveBeenCalled();
    expect(recovery).toMatchObject({ failedAttemptIds: [foreign.attemptId] });
  });
});

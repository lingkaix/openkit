import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultWorkerControlGateway } from '../app.js';
import { bindBootNanoHostAttemptRecovery } from '../bootstrap/nanohost-recovery.js';
import { runBootPhases } from '../bootstrap/phases.js';
import { refuseScope } from '../bootstrap/readiness.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import type { CoreDb } from '../storage/db.js';
import { createNanoHostCoreReads } from '../storage/nanohost-core-reads.js';
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
import { schedulerFixtureInput } from '../test-support/scheduler-admissions.js';
import {
  createTestCoreDb,
  disposeTestStore,
  setTestBackendSessionTurn,
} from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import * as attempts from './execution-attempt-records.js';
import { closeSchedulerExecutionAttemptWithoutEffects } from './execution-attempts.js';
import { ExecutionReconciler } from './execution-reconciler.js';
import {
  classifyNanoHostAttemptsAfterRestart,
  type RunNanoHostAttemptRecoveryInput,
} from './nanohost-attempt-recovery.js';
import {
  type PreAnchorRecoveryContext,
  runSchedulerRecoveryMaintenance,
  runSchedulerRestartRecovery,
} from './scheduler-restart-recovery.js';
import { getWorkerBackendSession } from './worker-backend-sessions.js';
import { hashWorkerRouteToken, type WorkerControlGateway } from './worker-control-gateway.js';

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

function attempt(db: CoreDb, suffix: string, submitted = false, backendId = 'nanohost') {
  const entry = isolationAdmission(db, suffix, backendId);
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

/** Retains the original submitted Native lease used by isolation's recovery censuses. */
function retainedLease(
  db: CoreDb,
  suffix: string,
  workspace: string,
  backendId = 'nanohost',
  workerControlTokenHash = 'a'.repeat(64)
) {
  const admission = isolationAdmission(db, suffix, backendId, workspace);
  const agentSessionId = testEntityId('as', suffix);
  return submitTestNanoHostWorkerLease(
    db,
    admission,
    `binding_${suffix}`,
    {
      agentSessionId,
      packageSnapshotId: `aepsnap_${admission.turnId}_${agentSessionId}`,
      workerControlTokenHash,
      workerInferenceTokenHash: 'b'.repeat(64),
      workerCapabilityTokenHash: 'c'.repeat(64),
    },
    { attemptId: testEntityId('attempt', suffix), observedAt: '2026-07-05T00:00:02.000Z' }
  );
}

describe('restart classification fault isolation (T4)', () => {
  it('continues after failed Turn publication and retries the original no-effect proof after listen', async () => {
    const { db, store, input } = await fixture();
    const bad = attempt(db, 'projection-fault');
    const healthy = attempt(db, 'projection-healthy');
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
    const { db, input } = await fixture();
    // Boot has only the new backend; the foreign attempt keeps its original admitted backend.
    const foreign = attempt(db, 'foreign-backend', false, 'unavailable-backend');
    const healthy = attempt(db, 'backend-healthy');
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

  it('boots past an open lease in a quarantined Workspace through a Worker Control hold (#987)', async () => {
    const { db, input } = await fixture();
    const storage = await openAdmittedTestNanoHost(db);
    const token = 'G'.repeat(43);
    const lease = retainedLease(
      db,
      'held-open',
      workspaceId,
      'nanohost',
      hashWorkerRouteToken(token)
    );
    refuseScope(db.dataRoot, { scope: 'workspace', id: workspaceId, check: 'database' });
    let gateway: WorkerControlGateway | undefined;
    const listenAdmission = vi.fn();
    const boot = await runBootPhases({
      bootId: 'boot-held-open-lease',
      phases: [
        {
          name: 'scheduler-restart-recovery',
          subsystem: 'scheduler',
          critical: true,
          run: async () => {
            gateway = createDefaultWorkerControlGateway(db, undefined, storage);
            await runSchedulerRestartRecovery(db, input);
            // The reconciler pass of the same boot reads idle-cleanup residents, not Worker Control sessions.
            await new ExecutionReconciler({
              coreDb: db,
              nanoHost: createNanoHostCoreReads(storage.value.owner),
              advanceIdleCleanup: vi.fn(async () => {}),
            }).runOnce();
            return { status: 'ok' };
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
    expect(boot.outcomes.map(({ name, outcome }) => [name, outcome.status])).toEqual([
      ['scheduler-restart-recovery', 'ok'],
      ['listen-admission', 'ok'],
    ]);
    expect(listenAdmission).toHaveBeenCalledOnce();
    expect(gateway!.restoreHeld()).toBe(true);
    expect(() => gateway!.registerSession({} as never)).toThrow(
      expect.objectContaining({ code: 'worker_observation_storage_unavailable', status: 503 })
    );
    expect(() => gateway!.authenticatePackageToken(`Bearer ${token}`)).toThrow(
      expect.objectContaining({ code: 'worker_control_unauthorized', status: 401 })
    );
    expect(attempts.requireSchedulerExecutionAttempt(db, lease.attemptId)).toMatchObject({
      phase: 'open',
    });
    expect(readTestNanoHostWorkerLease(db, lease.attemptId)).toMatchObject({
      phase: 'open',
      fenceRef: null,
    });
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
    const bad = retainedLease(db, 'native-fault', workspaceId);
    const healthy = retainedLease(db, 'native-healthy', goodWorkspace.id);
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
    const storage = await openAdmittedTestNanoHost(db);
    // Seed the foreign admission before its preparation claim is hashed, not by corrupting either row.
    const foreign = retainedLease(db, 'native-foreign', workspaceId, 'unavailable-backend');
    const session = () =>
      readAdmittedTestNanoHost(db, (sqlite) =>
        getWorkerBackendSession({ sqlite }, foreign.attemptId)
      );
    const originalSession = session();
    expect(originalSession).toMatchObject({ state: 'launching', attemptId: foreign.attemptId });
    const before = attempts.requireSchedulerExecutionAttempt(db, foreign.attemptId);
    expect(before).toMatchObject({
      phase: 'open',
      operationId: expect.any(String),
      backendId: 'unavailable-backend',
    });
    const binding = bindBootNanoHostAttemptRecovery(storage.value.owner);
    const read = vi.spyOn(storage.value.owner, 'read');
    const arm = vi.spyOn(binding, 'commit');
    const close = vi.spyOn(binding, 'close');
    const recovery = await classifyNanoHostAttemptsAfterRestart(db, {
      ...input,
      admittedNanoHostRecovery: { state: 'ready', value: binding },
    });
    expect(read).not.toHaveBeenCalled();
    expect(arm).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(attempts.requireSchedulerExecutionAttempt(db, foreign.attemptId)).toEqual(before);
    expect(session()).toEqual(originalSession);
    expect(input.restoreBackendSession).not.toHaveBeenCalled();
    expect(input.prepareBackendCleanup).not.toHaveBeenCalled();
    expect(input.cleanupBackendSession).not.toHaveBeenCalled();
    expect(recovery).toMatchObject({ failedAttemptIds: [] });
  });
});

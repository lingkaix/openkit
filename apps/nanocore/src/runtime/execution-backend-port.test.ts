import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApp, createDefaultWorkerControlGateway } from '../app.js';
import { ensureLocalUser } from '../auth/identity.js';
import { ProviderRegistry } from '../providers/registry.js';
import {
  cancelSchedulerAdmissionEntry,
  createSchedulerAdmissionEntry,
  listQueuedSchedulerAdmissionEntries,
  requireSchedulerAdmissionEntry,
} from '../scheduler-records.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createAppWithWorkspaceAuthority } from '../test-support/app.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { admitTestNativeEnvironment } from '../test-support/native-environment.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import * as attemptRecords from './execution-attempt-records.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  upsertNanoHostRuntimeTarget,
} from './nanohost-runtime-target.js';
import { startSchedulerAttemptMaintenanceService } from './scheduler-attempt-maintenance-service.js';
import {
  type RunSchedulerDispatchLoopInput,
  runSchedulerDispatchLoop,
} from './scheduler-dispatch-loop.js';
import {
  type RunSchedulerRestartRecoveryInput,
  runSchedulerRecoveryMaintenance,
  runSchedulerRestartRecovery,
} from './scheduler-restart-recovery.js';
import type { WorkerGovernanceBackend } from './worker-governance-backend.js';
import { WorkerGovernanceTurnExecutor } from './worker-governance-turn-executor.js';

/** Semantic correlation at the four-operation port; physical proof is deliberately opaque. */
interface Correlation {
  readonly attemptId: string;
  readonly backendId: string;
  readonly bindingRef: string | null;
  readonly inputRef: string;
  readonly operationId: string;
}

/** A test-only backend observation; no NanoHost proof fields or process keys exist here. */
interface Observation extends Correlation {
  readonly disposition: 'not_accepted' | 'accepted' | 'unknown';
  readonly execution: 'pending' | 'running' | 'terminal' | 'unknown';
  readonly fenceRef: string | null;
  readonly outcomeRef: string | null;
}

/** Observes the attempt at actual backend call time, including the before-call uncertainty commit. */
function attempts(db: ReturnType<typeof openCoreDb>): Record<string, unknown>[] {
  const exists = db.sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduler_execution_attempts'"
    )
    .get();
  return exists
    ? (db.sqlite
        .prepare('SELECT * FROM scheduler_execution_attempts ORDER BY rowid')
        .all() as Record<string, unknown>[])
    : [];
}

/** Composes the real queue, dispatch, Store and maintenance with an external-effect double. */
function fixture(
  disposition: Observation['disposition'] = 'accepted',
  _placement: 'local' | 'remote' = 'local',
  holdSubmitResponse = false
) {
  const db = openCoreDb(mkdtempSync(join(tmpdir(), 'route-b-port-')));
  applyMigrations(db);
  ensureLocalUser(db);
  const store = createDemoStore({ dataRoot: db.dataRoot });
  recordWorkspaceOwnerMembership({ coreDb: db, workspaceId: 'ws_demo', ownerUserId: 'user_local' });

  const setup = createTestAgentSetup();
  admitTestNativeEnvironment(db, setup.manifest);
  const snapshots: Record<string, unknown>[][] = [];
  const effectCalls: Correlation[] = [];
  const nativeStarts: Correlation[] = [];
  let physicalCapacityAvailable = true;
  let observed: Observation | null = null;
  let submitted = Promise.withResolvers<void>();
  const submitResponse = Promise.withResolvers<void>();
  const dispatchErrors: unknown[] = [];
  const observations = new Map<string, Observation | null>();
  const port = {
    id: 'fixture-backend',
    submit: vi.fn(async (input: Correlation & { readonly deadline: string }) => {
      snapshots.push(attempts(db));
      effectCalls.push(input);
      const result = physicalCapacityAvailable ? disposition : 'not_accepted';
      if (result !== 'not_accepted') nativeStarts.push(input);
      observed = {
        ...input,
        disposition: result,
        execution: result === 'accepted' ? 'pending' : 'unknown',
        fenceRef: null,
        outcomeRef: null,
      };
      observations.set(input.attemptId, observed);
      // A held external response leaves the real before-call unknown intent open.
      submitted.resolve();
      if (holdSubmitResponse) await submitResponse.promise;
      return observed;
    }),
    inspect: vi.fn(
      async (input: Correlation): Promise<Observation | null> =>
        observations.get(input.attemptId) ?? null
    ),
    cancel: vi.fn(
      async (input: Correlation): Promise<Observation> => ({
        ...input,
        disposition: 'accepted',
        execution: 'unknown',
        fenceRef: null,
        outcomeRef: null,
      })
    ),
    release: vi.fn(async (input: Correlation) => ({
      ...input,
      state: 'pending' as const,
      fenceRef: null,
    })),
  };
  // Production owns the preparation, effect-capable operation record, and submission crossing.
  // The double owns only external backend behavior; it never grants Core authority.
  const target = allocateNanoHostRuntimeTargetConnectionGeneration(db, {
    deploymentId: 'fixture-deployment',
    identityId: 'fixture-identity',
    targetId: 'fixture-target',
    observedAt: '2026-10-06T00:00:00.000Z',
  });
  upsertNanoHostRuntimeTarget(db, {
    ...target,
    freshEmpty: true,
    ready: true,
    predecessorFenced: true,
    physicalEpoch: 'a'.repeat(64),
    observedAt: '2026-10-06T00:00:00.000Z',
  });
  const controlGateway = createDefaultWorkerControlGateway(db);
  const backend: WorkerGovernanceBackend = {
    ...port,
    describeCapabilities: async () => ({
      kind: 'openshell',
      capabilities: ['container', 'transcript-sink', 'worker-control'],
      dynamicCapabilities: [],
      version: '0.0.63',
    }),
    validatePackage: async () => [],
    prepareAgentSessionContinuity: async () => 'absent',
    inspectMaterializationCapacity: () =>
      physicalCapacityAvailable ? 'available' : 'capacity-saturated',
    planSession: (aep) => ({
      agentSessionId: aep.scope.agentSessionId,
      packageSnapshotId: aep.snapshotId,
      backendKind: 'openshell',
      backendSessionId: `fixture-${aep.scope.agentSessionId}`,
      deploymentId: 'fixture-deployment',
      runtimeTargetId: 'fixture-target',
      stagingDirectoryRef: `server/runtime/worker-backend-sessions/${aep.snapshotId}`,
      transientProviderInstanceId: null,
    }),
    materialize: async (aep) => {
      // The external materialization fixture publishes its exact live control registration.
      controlGateway.registerSession(aep);
      return {
        backendKind: 'openshell',
        packageId: aep.packageId,
        packageSnapshotId: aep.snapshotId,
        controlMode: aep.control.mode,
        command: { ...aep.runtime.command },
        workspaceInputs: [],
        requiredCapabilities: aep.backend.requiredCapabilities,
      };
    },
    prepareLaunch: async () => undefined,
    cleanupSession: async () => undefined,
    interruptTurn: async () => undefined,
    update: async () => [],
    collectEvidence: async () => [],
    collectProviderRefreshStatuses: async () => [],
    collectWorkspaceChanges: async () => [],
    collectTranscript: async () => ({}),
  };
  const executor = new WorkerGovernanceTurnExecutor({
    coreDb: db,
    backend,
    workerControlGateway: controlGateway,
    now: () => '2026-10-06T00:00:00.000Z',
    awaitWorkerCompletion: () => new Promise(() => {}),
  });
  vi.spyOn(executor, 'prepareAgentSessionForTurn');
  vi.spyOn(executor, 'startTurn');
  const providerRegistry = new ProviderRegistry([
    {
      id: 'agent-openrouter',
      displayName: 'Port fixture',
      kind: 'local',
      models: ['openai/gpt-5.2'],
    },
  ]);
  const dispatchInput: RunSchedulerDispatchLoopInput = {
    coreDb: db,
    store,
    turnExecutor: executor,
    agentManifests: [setup.manifest],
    providerRegistry,
    gatewayConfig: createTestGatewayConfig(),
    executionBackend: port,
    maxDispatches: 1,
    now: () => '2026-10-06T00:00:00.000Z',
  };
  const recoveryInput: RunSchedulerRestartRecoveryInput = {
    store,
    executionBackend: port,
    now: dispatchInput.now!,
    projectRecoveredTurn: async (subject) => ({
      status: store.getTurnById(subject.turnId).status as 'failed',
    }),
  };
  const queue = (suffix: string, threadId = 'th_demo') => {
    const turnId = `turn_port_${suffix}`;
    if (threadId !== 'th_demo') store.createThread('ws_demo', suffix, threadId);
    store.createTurn(
      'ws_demo',
      threadId,
      'Execute exactly once.',
      { kind: 'user', id: 'user_local' },
      null,
      {
        turnId,
        agentId: setup.manifest.id,
        status: 'pending',
        executorKind: 'worker',
      }
    );
    const admissionInput: Parameters<typeof createSchedulerAdmissionEntry>[1] & {
      backendId: string;
    } = {
      backendId: port.id,
      queueEntryId: `queue_port_${suffix}`,
      requestId: `request_port_${suffix}`,
      turnId,
      workspaceId: 'ws_demo',
      threadId,
      turnInput: 'Execute exactly once.',
      requestedAgentId: setup.manifest.id,
      triggerActor: { kind: 'user', id: 'user_local' },
      now: dispatchInput.now!,
    };
    store.recordCommandRequest({
      command: 'turn.start',
      requestId: admissionInput.requestId!,
      scope: { workspaceId: 'ws_demo', threadId },
      inputHash: 'fixture',
      response: { kind: 'turn', id: turnId },
    });
    return createSchedulerAdmissionEntry(db, admissionInput);
  };
  return {
    db,
    store,
    executor,
    port,
    queue,
    snapshots,
    effectCalls,
    nativeStarts,
    setPhysicalCapacityAvailable(available: boolean) {
      physicalCapacityAvailable = available;
    },
    dispatchInput,
    recoveryInput,
    observe(value: Observation | null) {
      observed = value;
      const subject = value?.attemptId ?? effectCalls[0]?.attemptId;
      if (subject) observations.set(subject, value);
    },
    dispatchErrors,
    settleSubmitResponse: () => submitResponse.resolve(),
    dispatch: async () => {
      submitted = Promise.withResolvers<void>();
      const dispatched = runSchedulerDispatchLoop(dispatchInput);
      // The real executor waits for detached completion. Observe the production submit without
      // claiming that its still-running invocation or closeout has completed.
      await Promise.race([dispatched.then(() => undefined), submitted.promise]);
      void dispatched.catch((error: unknown) => dispatchErrors.push(error));
    },
    maintain: () => runSchedulerRecoveryMaintenance(db, recoveryInput),
  };
}

describe('execution backend port through real Core coordination', () => {
  it.each([
    'local',
    'remote',
  ] as const)('uses the same configured backend id for %s with adapter-specific proof kept opaque', async (placement) => {
    const f = fixture('accepted', placement);
    try {
      f.queue('configured');
      await f.dispatch();
      expect(f.port.submit).toHaveBeenCalledOnce();
      expect(f.effectCalls[0]).toMatchObject({ backendId: 'fixture-backend' });
      const atCall = f.snapshots[0]![0]!;
      expect(atCall).toMatchObject({
        phase: 'open',
        disposition: 'unknown',
        backend_id: 'fixture-backend',
      });
      expect(atCall.operation_id).toBe(f.effectCalls[0]!.operationId);
      expect(atCall.attempt_id).toBe(f.effectCalls[0]!.attemptId);
      expect(f.effectCalls[0]!.inputRef).toEqual(expect.any(String));
      expect(f.effectCalls[0]!.bindingRef).toEqual(expect.any(String));
    } finally {
      f.db.sqlite.close();
    }
  });

  it('closes definite busy only after no reservation, keeping the same queued admission and Turn for a new attempt', async () => {
    const f = fixture('accepted');
    try {
      f.setPhysicalCapacityAvailable(false);
      const entry = f.queue('busy');
      await f.dispatch();
      expect(f.port.submit).not.toHaveBeenCalled();
      const first = attempts(f.db)[0]!;
      expect(first).toMatchObject({
        phase: 'closed',
        disposition: 'not_accepted',
        operation_id: null,
      });
      expect(requireSchedulerAdmissionEntry(f.db, entry.queueEntryId).status).toBe('queued');
      expect(f.store.getTurnById(entry.turnId)).toMatchObject({
        id: entry.turnId,
        status: 'pending',
      });
      await f.dispatch();
      expect(f.port.submit).not.toHaveBeenCalled();
      expect(attempts(f.db)).toHaveLength(2);
      expect(attempts(f.db)[1]!.attempt_id).not.toBe(first.attempt_id);
      f.setPhysicalCapacityAvailable(true);
      await f.dispatch();
      expect(f.port.submit).toHaveBeenCalledOnce();
      expect(f.effectCalls[0]!.attemptId).not.toBe(first.attempt_id);
      expect(f.store.listThreadTurns('ws_demo', 'th_demo').map((turn) => turn.id)).toContain(
        entry.turnId
      );
      expect(
        f.db.sqlite.prepare('SELECT COUNT(*) AS count FROM scheduler_admission_entries').get()
      ).toEqual({ count: 1 });
    } finally {
      f.db.sqlite.close();
    }
  });

  it.each([
    'accepted',
    'unknown',
  ] as const)('inspects %s pending work across maintenance and restart without another native start', async (disposition) => {
    const f = fixture(disposition);
    try {
      const entry = f.queue('pending');
      await f.dispatch();
      expect(f.port.submit).toHaveBeenCalledOnce();
      const original = f.effectCalls[0]!;
      await f.dispatch();
      await f.maintain();
      const _boot = await runSchedulerRestartRecovery(f.db, f.recoveryInput);
      expect(f.port.submit).toHaveBeenCalledOnce();
      expect(f.port.cancel).not.toHaveBeenCalled();
      await runSchedulerRecoveryMaintenance(f.db, f.recoveryInput);
      expect(f.port.inspect).toHaveBeenCalled();
      for (const [inspection] of f.port.inspect.mock.calls)
        expect(inspection).toMatchObject({
          attemptId: original.attemptId,
          operationId: original.operationId,
          backendId: original.backendId,
        });
      expect(f.port.submit).toHaveBeenCalledOnce();
      expect(attempts(f.db).filter((attempt) => attempt.phase !== 'closed')).toEqual([
        expect.objectContaining({ attempt_id: original.attemptId, turn_id: entry.turnId }),
      ]);
    } finally {
      f.db.sqlite.close();
    }
  });

  it.each([
    'open',
    'closing',
  ] as const)('keeps %s exclusion local while an independent Thread gets a durable queued receipt', async (phase) => {
    const f = fixture('unknown', 'local', true);
    f.port.cancel.mockImplementation(async (correlation) => ({
      ...correlation,
      disposition: 'unknown',
      execution: 'unknown',
      fenceRef: null,
      outcomeRef: null,
    }));
    try {
      const a = f.queue('exclusive');
      await f.dispatch();
      expect(f.port.submit).toHaveBeenCalledOnce();
      const original = f.effectCalls[0]!;
      if (phase === 'closing') {
        // Exclusion belongs to the attempt owner even while the external submit response is absent.
        attemptRecords.markSchedulerExecutionAttemptClosing(f.db, {
          attemptId: original.attemptId,
          cause: 'turn-cancelled',
          now: f.dispatchInput.now,
        });
        await f.maintain();
      }
      const held = attempts(f.db).find((row) => row.attempt_id === original.attemptId)!;
      expect(held.phase).toBe(phase);
      expect(held.disposition).toBe('unknown');
      // This coordination seam constructs collisions that public one-Turn-per-Thread validation forbids.
      const acquire = (
        db: typeof f.db,
        candidate: {
          entry: ReturnType<typeof createSchedulerAdmissionEntry>;
          attemptId: string;
          agentSessionId: string;
        }
      ) =>
        db.sqlite
          .transaction(() => {
            const acquired = attemptRecords.createSchedulerExecutionAttempt(db, {
              entry: candidate.entry,
              attemptId: candidate.attemptId,
              preparationInput: { admission: candidate.entry },
            });
            return attemptRecords.bindSchedulerExecutionAttemptSession(db, {
              attemptId: acquired.attemptId,
              agentSessionId: candidate.agentSessionId,
            });
          })
          .immediate();
      expect(acquire, 'The record owner must expose conditional attempt acquisition.').toBeTypeOf(
        'function'
      );
      // Positive control prevents a missing prerequisite or unconditional refusal from proving exclusion.
      const control = f.queue('control', 'th_control');
      const candidateFor = (entry: typeof control, attemptId: string, sessionId: string) => ({
        entry,
        attemptId,
        agentSessionId: sessionId,
      });
      await acquire(f.db, candidateFor(control, 'control-attempt', 'control-session'));
      expect(attempts(f.db)).toContainEqual(
        expect.objectContaining({
          attempt_id: 'control-attempt',
          phase: 'open',
          turn_id: control.turnId,
        })
      );
      for (const collision of ['turn', 'thread', 'session'] as const) {
        // Reuse A's admission for the same Turn; otherwise create actual matching product/admission lineage.
        const entry =
          collision === 'turn'
            ? a
            : f.queue(
                `collision-${collision}`,
                collision === 'thread' ? a.threadId : 'th_collision_session'
              );
        const candidate = candidateFor(
          entry,
          `competing-${collision}`,
          collision === 'session' ? String(held.agent_session_id) : `other-session-${collision}`
        );
        const before = attempts(f.db);
        expect(() => acquire(f.db, candidate)).toThrow(
          collision === 'turn' ? /queued admission/ : /UNIQUE constraint/
        );
        expect(
          attempts(f.db),
          `A competing ${collision} cannot acquire execution authority.`
        ).toEqual(before);
        expect(f.port.submit).toHaveBeenCalledOnce();
        if (collision !== 'turn')
          cancelSchedulerAdmissionEntry(f.db, {
            queueEntryId: entry.queueEntryId,
            workspaceId: entry.workspaceId,
          });
      }
      // The positive control opened no external operation. Its local no-effect release removes only that control.
      const close = attemptRecords.closeSchedulerExecutionAttemptWithoutEffects;
      expect(close).toBeTypeOf('function');
      await close(f.db, {
        attemptId: 'control-attempt',
        cause: 'turn-start-failed',
        noOutstandingEffects: true,
      });
      expect(attempts(f.db).find((row) => row.attempt_id === 'control-attempt')?.phase).toBe(
        'closed'
      );
      // Acquisition made this control admitted; retain that history after its no-effect close.
      expect(requireSchedulerAdmissionEntry(f.db, control.queueEntryId).status).toBe('admitted');
      const setup = createTestAgentSetup();
      f.store.createThread('ws_demo', 'Independent', 'th_independent');
      const appInput: Parameters<typeof createAppWithWorkspaceAuthority>[0] = {
        coreDb: f.db,
        store: f.store,
        turnExecutor: f.executor,
        agentManifests: [setup.manifest],
        providerRegistry: f.dispatchInput.providerRegistry,
        gatewayConfig: f.dispatchInput.gatewayConfig,
      };
      // Delay B only to observe its receipt; the external backend separately proves occupied capacity.
      f.setPhysicalCapacityAvailable(false);
      const gate = Promise.withResolvers<void>();
      const prepare = WorkerGovernanceTurnExecutor.prototype.prepareAgentSessionForTurn.bind(
        f.executor
      );
      const delayed = vi
        .spyOn(f.executor, 'prepareAgentSessionForTurn')
        .mockImplementation(async (store, input) => {
          if (input.turn.threadId === 'th_independent') await gate.promise;
          return prepare(store, input);
        });
      const post = (app: ReturnType<typeof createAppWithWorkspaceAuthority>) =>
        app.request(
          ...operationRequest(
            'turn.start',
            {},
            {
              body: JSON.stringify({
                workspaceId: 'ws_demo',
                threadId: 'th_independent',
                agentId: setup.manifest.id,
                input: 'Independent bounded work.',
                requestId: '00000000-0000-4000-8000-00000000c303',
              }),
            }
          )
        );
      try {
        const app = createAppWithWorkspaceAuthority(appInput);
        const response = await post(app);
        expect(response.status).toBe(202);
        const b = await response.json();
        expect(b.status).toBe('pending');
        expect(listQueuedSchedulerAdmissionEntries(f.db)).toContainEqual(
          expect.objectContaining({ turnId: b.id })
        );
        expect((await (await post(app)).json()).id).toBe(b.id);
        expect(f.effectCalls).toHaveLength(1);
        gate.resolve();
        // D85 holds the data-root preparation claim until the unknown submit response settles.
        await f.dispatch();
        expect(f.port.submit).toHaveBeenCalledOnce();
        expect(attempts(f.db).find((row) => row.attempt_id === original.attemptId)?.phase).toBe(
          phase
        );
        f.settleSubmitResponse();
        await vi.waitFor(() =>
          expect(attempts(f.db).find((row) => row.attempt_id === original.attemptId)?.phase).toBe(
            'closing'
          )
        );
        await f.dispatch();
        await vi.waitFor(() =>
          expect(attempts(f.db)).toContainEqual(
            expect.objectContaining({
              turn_id: b.id,
              phase: 'closed',
              terminal_cause: 'backend-busy',
              disposition: 'not_accepted',
              operation_id: null,
            })
          )
        );
        expect(f.port.submit).toHaveBeenCalledOnce();
        expect(f.nativeStarts).toHaveLength(1);
        expect(listQueuedSchedulerAdmissionEntries(f.db)).toContainEqual(
          expect.objectContaining({ turnId: b.id })
        );
        const busy = attempts(f.db).find(
          (row) => row.turn_id === b.id && row.terminal_cause === 'backend-busy'
        )!;
        expect(busy.phase).toBe('closed');
        // Only this backend's capacity proof changes; A's original unresolved execution stays fenced.
        f.setPhysicalCapacityAvailable(true);
        await f.dispatch();
        await vi.waitFor(() => expect(f.nativeStarts).toHaveLength(2));
        expect(f.port.submit).toHaveBeenCalledTimes(2);
        expect(f.effectCalls[1]!.attemptId).not.toBe(original.attemptId);
        expect(f.effectCalls[1]!.attemptId).not.toBe(busy.attempt_id);
        expect(attempts(f.db).find((row) => row.attempt_id === original.attemptId)?.phase).toBe(
          'closing'
        );
        const reloaded = openCoreDb(f.db.dataRoot);
        try {
          const recovery = {
            ...f.recoveryInput,
            store: createDemoStore({ dataRoot: f.db.dataRoot }),
          };
          const _boot = await runSchedulerRestartRecovery(reloaded, recovery);
          await runSchedulerRecoveryMaintenance(reloaded, recovery);
          await runSchedulerDispatchLoop({
            ...f.dispatchInput,
            coreDb: reloaded,
            store: recovery.store,
          });
          expect(
            attempts(reloaded).find((row) => row.attempt_id === original.attemptId)?.phase
          ).toBe('closing');
          expect(f.port.submit).toHaveBeenCalledTimes(2);
          expect(f.nativeStarts).toHaveLength(2);
        } finally {
          reloaded.sqlite.close();
        }
      } finally {
        gate.resolve();
        delayed.mockRestore();
      }
    } finally {
      f.db.sqlite.close();
    }
  });

  it.each([
    'missing',
    'stale-attempt',
    'wrong-operation',
    'wrong-backend',
    'wrong-binding',
  ] as const)('keeps the exact fence on %s inspection evidence', async (kind) => {
    const f = fixture('unknown');
    try {
      f.queue('inspect');
      await f.dispatch();
      expect(f.port.submit).toHaveBeenCalledOnce();
      const original = f.effectCalls[0]!;
      const correlation = {
        ...original,
        ...(kind === 'stale-attempt' ? { attemptId: 'stale-attempt' } : {}),
        ...(kind === 'wrong-operation' ? { operationId: 'wrong-operation' } : {}),
        ...(kind === 'wrong-backend' ? { backendId: 'other-backend' } : {}),
        ...(kind === 'wrong-binding' ? { bindingRef: 'other-binding' } : {}),
      };
      f.observe(
        kind === 'missing'
          ? null
          : {
              ...correlation,
              disposition: 'not_accepted',
              execution: 'terminal',
              outcomeRef: null,
              fenceRef: 'opaque-other-proof',
            }
      );
      await f.maintain();
      expect(f.port.inspect).toHaveBeenCalled();
      const current = attempts(f.db).find((attempt) => attempt.attempt_id === original.attemptId)!;
      expect(['open', 'closing']).toContain(current.phase);
      expect(current.disposition).toBe('unknown');
      await f.dispatch();
      expect(f.port.submit).toHaveBeenCalledOnce();
    } finally {
      f.db.sqlite.close();
    }
  });

  it.each([
    'exact',
    'conflicting',
  ] as const)('keeps the first closed outcome immutable after a %s late result and storage reload', async (kind) => {
    const f = fixture('not_accepted');
    try {
      const entry = f.queue('late-closed');
      await f.dispatch();
      expect(f.port.submit).toHaveBeenCalledOnce();
      const correlation = f.effectCalls[0]!;
      await vi.waitFor(() => expect(f.dispatchErrors).toHaveLength(1));
      attemptRecords.closeSchedulerExecutionAttemptWithoutEffects(f.db, {
        attemptId: correlation.attemptId,
        noOutstandingEffects: true,
        cause: 'whole-fixture-refusal',
      });
      const closed = attempts(f.db).find((row) => row.attempt_id === correlation.attemptId)!;
      expect(closed.phase).toBe('closed');
      expect(closed.terminal_cause).toEqual(expect.any(String));
      expect(closed.outcome_ref).toBeDefined();
      /** Projects only closed-core facts; evidence, diagnostics and timestamps may refine. */
      const protectedFacts = (db: typeof f.db) => {
        const rows = attempts(db);
        const row = rows.find((candidate) => candidate.attempt_id === correlation.attemptId);
        expect(row).toBeDefined();
        expect(rows.filter((candidate) => candidate.phase !== 'closed')).toEqual([]);
        expect(rows.map((candidate) => candidate.attempt_id)).toEqual([correlation.attemptId]);
        return {
          attemptId: row!.attempt_id,
          phase: row!.phase,
          firstTerminalCause: row!.terminal_cause,
          outcome: row!.outcome_ref,
          disposition: row!.disposition,
          operationId: row!.operation_id,
          fenceRef: row!.fence_ref,
        };
      };
      const protectedFirst = protectedFacts(f.db);
      const observation: Observation = {
        ...correlation,
        disposition: kind === 'exact' ? 'not_accepted' : 'accepted',
        execution: kind === 'exact' ? 'unknown' : 'terminal',
        outcomeRef: kind === 'exact' ? null : 'conflicting-success',
        fenceRef: null,
      };
      // Deliver the candidate to the real result consumer, even when closed attempts are not polled.
      // This private action binding must move with its owner; a fake observation setter is no ingestion proof.
      const ingest = async (db: typeof f.db) => {
        const accepted = attemptRecords.acceptSchedulerExecutionObservation(db, observation);
        expect(accepted?.attemptId).toBe(correlation.attemptId);
        expect(accepted?.phase).toBe('closed');
        expect(protectedFacts(db)).toEqual(protectedFirst);
        expect(f.port.submit).toHaveBeenCalledOnce();
        expect(f.nativeStarts).toEqual([]);
      };
      await ingest(f.db);
      // Submitted refusal retains admitted history; it is no longer a queued cancellation target.
      expect(requireSchedulerAdmissionEntry(f.db, entry.queueEntryId).status).toBe('admitted');
      await f.maintain();
      await f.dispatch();
      expect(protectedFacts(f.db)).toEqual(protectedFirst);
      const root = f.db.dataRoot;
      const reloaded = openCoreDb(root);
      try {
        const recovery = { ...f.recoveryInput, store: createDemoStore({ dataRoot: root }) };
        const _boot = await runSchedulerRestartRecovery(reloaded, recovery);
        await runSchedulerRecoveryMaintenance(reloaded, recovery);
        await runSchedulerDispatchLoop({
          ...f.dispatchInput,
          coreDb: reloaded,
          store: recovery.store,
        });
        await ingest(reloaded);
        expect(protectedFacts(reloaded)).toEqual(protectedFirst);
        expect(f.port.submit).toHaveBeenCalledOnce();
      } finally {
        reloaded.sqlite.close();
      }
    } finally {
      f.db.sqlite.close();
    }
  });

  it('lets durable queued cancellation win without preparation or backend submission', async () => {
    const f = fixture();
    try {
      const entry = f.queue('cancelled');
      cancelSchedulerAdmissionEntry(f.db, {
        queueEntryId: entry.queueEntryId,
        workspaceId: entry.workspaceId,
      });
      await f.dispatch();
      expect(f.port.submit).not.toHaveBeenCalled();
      expect(f.executor.prepareAgentSessionForTurn).not.toHaveBeenCalled();
      expect(f.executor.startTurn).not.toHaveBeenCalled();
      expect(attempts(f.db)).toEqual([]);
      expect(listQueuedSchedulerAdmissionEntries(f.db)).toEqual([]);
      expect(requireSchedulerAdmissionEntry(f.db, entry.queueEntryId).status).toBe('cancelled');
    } finally {
      f.db.sqlite.close();
    }
  });

  it('revokes a possibly submitted attempt before exact cancellation and cannot reopen it from a late accepted result', async () => {
    const f = fixture('accepted');
    try {
      const entry = f.queue('cancel-after-submit');
      await f.dispatch();
      expect(f.port.submit).toHaveBeenCalledOnce();
      const original = f.effectCalls[0]!;
      const atCancel: Record<string, unknown>[][] = [];
      f.port.cancel.mockImplementation(async (correlation) => {
        atCancel.push(attempts(f.db));
        return {
          ...correlation,
          disposition: 'accepted',
          execution: 'unknown',
          fenceRef: null,
          outcomeRef: null,
        };
      });
      const appInput: Parameters<typeof createApp>[0] = {
        coreDb: f.db,
        store: f.store,
        turnExecutor: f.executor,
      };
      const response = await createApp(appInput).request(
        ...operationRequest(
          'turn.interrupt',
          {
            workspaceId: entry.workspaceId,
            threadId: entry.threadId,
            turnId: entry.turnId,
          },
          { body: JSON.stringify({ requestId: '00000000-0000-4000-8000-00000000c301' }) }
        )
      );
      expect(response.status).toBeLessThan(300);
      await f.maintain();
      expect(f.port.cancel).toHaveBeenCalledOnce();
      expect(f.port.cancel.mock.calls[0]![0]).toMatchObject({
        attemptId: original.attemptId,
        backendId: original.backendId,
        bindingRef: original.bindingRef,
      });
      expect(atCancel[0]).toEqual([
        expect.objectContaining({ phase: 'closing', turn_id: entry.turnId }),
      ]);
      expect(attempts(f.db)[0]!.phase).toBe('closing');
      f.observe({
        ...original,
        disposition: 'accepted',
        execution: 'running',
        fenceRef: null,
        outcomeRef: null,
      });
      await f.maintain();
      await f.dispatch();
      expect(attempts(f.db)[0]!.phase).toBe('closing');
      expect(f.port.submit).toHaveBeenCalledOnce();
      expect(f.port.release).not.toHaveBeenCalled();
      expect(f.port.cancel).toHaveBeenCalledOnce();
    } finally {
      f.db.sqlite.close();
    }
  });

  it('fixes the submit deadline at 7200 seconds and never extends it while inspecting unresolved work', async () => {
    const f = fixture('unknown');
    try {
      // This single case obtains the submit budget from production, not this legacy fixture option.
      f.queue('absolute-deadline');
      await f.dispatch();
      expect(f.port.submit).toHaveBeenCalledOnce();
      const submitted = f.port.submit.mock.calls[0]![0];
      expect(Date.parse(submitted.deadline) - Date.parse('2026-10-06T00:00:00.000Z')).toBe(
        7_200_000
      );
      const original = attempts(f.db)[0]!;
      expect(Number.isFinite(Date.parse(String(original.deadline)))).toBe(true);
      expect(original.deadline).toBe(submitted.deadline);
      for (const now of [
        '2026-10-06T00:00:10.000Z',
        '2026-10-06T01:59:59.999Z',
        '2026-10-06T02:00:00.000Z',
      ]) {
        await runSchedulerRecoveryMaintenance(f.db, {
          ...f.recoveryInput,
          now: () => now,
        });
        expect(attempts(f.db)[0]!.deadline).toBe(original.deadline);
      }
      expect(f.port.submit).toHaveBeenCalledOnce();
      expect(attempts(f.db)[0]!.phase).not.toBe('closed');
    } finally {
      f.db.sqlite.close();
    }
  });

  it('does no port effects during pre-listen classification and serializes original-operation inspection after listen', async () => {
    const f = fixture('unknown');
    try {
      f.queue('boot');
      await f.dispatch();
      expect(f.port.submit).toHaveBeenCalledOnce();
      const gate = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      let concurrent = 0;
      let peak = 0;
      f.port.inspect.mockImplementation(async () => {
        peak = Math.max(peak, ++concurrent);
        entered.resolve();
        await gate.promise;
        concurrent -= 1;
        return null;
      });
      const _boot = await runSchedulerRestartRecovery(f.db, f.recoveryInput);
      expect(f.port.inspect).not.toHaveBeenCalled();
      expect(f.port.cancel).not.toHaveBeenCalled();
      expect(f.port.release).not.toHaveBeenCalled();
      const service = startSchedulerAttemptMaintenanceService({
        intervalMs: 30_000,
        setInterval: () => 'fixture-timer',
        clearInterval: () => undefined,
        runRecoveryMaintenance: () => runSchedulerRecoveryMaintenance(f.db, f.recoveryInput),
      });
      try {
        const first = service.runOnce();
        await entered.promise;
        const overlap = service.runOnce();
        expect(overlap).toBe(first);
        gate.resolve();
        await Promise.all([first, overlap]);
      } finally {
        gate.resolve();
        service.stop();
      }
      expect(peak).toBe(1);
      expect(f.port.submit).toHaveBeenCalledOnce();
    } finally {
      f.db.sqlite.close();
    }
  });

  it('does not release on native terminal or stop acknowledgement without complete Core handoff barriers', async () => {
    const f = fixture('accepted');
    try {
      const entry = f.queue('terminal');
      await f.dispatch();
      expect(f.port.submit).toHaveBeenCalledOnce();
      const correlation = f.effectCalls[0]!;
      f.observe({
        ...correlation,
        disposition: 'accepted',
        execution: 'terminal',
        outcomeRef: 'opaque-native-terminal',
        fenceRef: null,
      });
      await f.maintain();
      expect(f.port.release).not.toHaveBeenCalled();
      expect(
        attempts(f.db).find((attempt) => attempt.attempt_id === correlation.attemptId)!.phase
      ).not.toBe('closed');
      expect(f.store.getTurnById(entry.turnId).status).not.toBe('completed');
    } finally {
      f.db.sqlite.close();
    }
  });
});

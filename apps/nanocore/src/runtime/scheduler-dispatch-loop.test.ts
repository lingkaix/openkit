import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceDataSourceCatalog } from '@openkit/config-schema';
import { responsibleUserIdForActor } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireResolvedAgentSetup } from '../agents/setup-ledger';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { ensureLocalUser } from '../auth/identity.js';
import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { ALREADY_DECIDED_PUBLICATION_ADMISSION, type FsStore } from '../lib/store';
import { ProviderRegistry } from '../providers/registry';
import {
  cancelSchedulerAdmissionEntry,
  createSchedulerAdmissionEntry,
  listQueuedSchedulerAdmissionEntries,
  listSchedulerAdmissionEntriesForWorkspace,
  requireSchedulerExecutionAttemptAdmissionContext,
} from '../scheduler-records';
import * as schedulerRecords from '../scheduler-records.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate';
import { isCurrentAgentSessionStatus } from '../storage/workspace-file-records.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import {
  admitTestNativeEnvironment,
  recordTestNativeRuntimeTarget,
} from '../test-support/native-environment.js';
import { resolveAgentSessionCompatibilityKey } from '../test-support/prepared-agent-environment.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { DeterministicAgentPreparationError } from './agent-preparation-error.js';
import * as attemptRecords from './execution-attempt-records.js';
import {
  bindNanoHostAttemptPreparation,
  resolveNanoHostAttemptTokenBinding,
} from './nanohost-attempt-records.js';
import { TurnStartValidationError } from './orchestrator';
import { startProductTurn as executeProductTurn } from './product-turn-start.js';
import { getSchedulerPreparationClaims, runSchedulerDispatchLoop } from './scheduler-dispatch-loop';
import { startSchedulerDispatchRetryService } from './scheduler-dispatch-service.js';
import type {
  CommitPreparedAgentSessionForTurnInput,
  PrepareAgentSessionForTurnInput,
  PreparedAgentSessionForTurn,
  PreparedCurrentAgentSession,
  TurnStartRuntimeContext,
} from './types';
import {
  recordWorkerBackendSessionMaterializing,
  transitionWorkerBackendSessionState,
} from './worker-backend-sessions';
import { WorkerGovernanceCapacityUnavailableError } from './worker-governance-backend.js';

const extraCoreHandles: ReturnType<typeof openCoreDb>[] = [];
afterEach(() => {
  for (const handle of extraCoreHandles.splice(0)) if (handle.sqlite.open) handle.sqlite.close();
});

class RecordingTurnExecutor extends SimulatedTurnExecutor {
  public readonly fixtureCore: ReturnType<typeof createMigratedCoreDb>;
  /** Binds the modeled port to the same durable authority, including separately opened handles. */
  public constructor(coreDb: ReturnType<typeof createMigratedCoreDb>, separateHandle = false) {
    const fixtureCore = separateHandle ? openCoreDb(coreDb.dataRoot) : coreDb;
    super({ coreDb: fixtureCore });
    this.fixtureCore = fixtureCore;
    if (separateHandle) extraCoreHandles.push(fixtureCore);
    admitTestNativeEnvironment(fixtureCore, agentManifest());
    recordTestNativeRuntimeTarget(fixtureCore);
  }
  public readonly capabilities = {
    approvals: false,
    artifacts: false,
    interrupts: true,
    questions: false,
    workspaceConfig: true,
    workspaceKnowledgeEditing: true,
  };
  public readonly eventFamilies = ['turn.started'] as const;
  public readonly calls: Array<{
    context: TurnStartRuntimeContext | undefined;
    input: string;
    turnId: string;
  }> = [];
  public readonly prepareCalls: Array<{
    threadId: string;
    turnId: string;
  }> = [];

  /**
   * Projects deterministic runtime preparation for scheduler-loop tests.
   *
   * @param store Store containing any current AgentSession.
   * @param input Exact future-Turn static AEP inputs.
   * @returns Reused or fresh AgentSession identity with its real compatibility key.
   */
  public async prepareAgentSessionForTurn(
    store: FsStore,
    input: PrepareAgentSessionForTurnInput
  ): Promise<PreparedAgentSessionForTurn> {
    this.prepareCalls.push({ threadId: input.turn.threadId, turnId: input.turn.id });
    const current = store
      .listThreadAgentSessions(input.turn.workspaceId, input.turn.threadId)
      .find((candidate) => isCurrentAgentSessionStatus(candidate.status));
    const resolveKey = (agentSessionId: string) =>
      resolveAgentSessionCompatibilityKey({
        agentSessionId,
        coreDb: this.fixtureCore,
        agentSetup: input.agentSetup,
        backend: { kind: 'openshell' },
        requestId: input.requestId,
        turn: input.turn,
        turnInput: input.turnInput,
        triggerActor: input.turn.triggerActor,
        workspaceCwd: input.workspaceCwd,
        workspaceRoots: input.workspaceRoots,
        ...(input.workspaceDataSourceCatalog
          ? { workspaceDataSourceCatalog: input.workspaceDataSourceCatalog }
          : {}),
        ...(input.workspaceMcpServerCatalog
          ? { workspaceMcpServerCatalog: input.workspaceMcpServerCatalog }
          : {}),
        ...(input.workspaceSourceRefs ? { workspaceSourceRefs: input.workspaceSourceRefs } : {}),
      });

    if (current) {
      const sessionCompatibilityKey = resolveKey(current.id);
      const currentAgentSession: PreparedCurrentAgentSession = {
        agentId: current.agentId,
        id: current.id,
        policySnapshotId: current.policySnapshotId,
        sessionCompatibilityKey: current.sessionCompatibilityKey,
        stale: current.stale,
        status: current.status,
        updatedAt: current.updatedAt,
      };
      const activeTurn = store
        .listThreadTurns(input.turn.workspaceId, input.turn.threadId)
        .some((turn) => turn.status === 'running');
      if (
        current.agentId === input.agentSetup.manifest.id &&
        current.status === 'idle' &&
        !current.stale &&
        !activeTurn &&
        current.sessionCompatibilityKey === sessionCompatibilityKey
      ) {
        return {
          agentSessionId: current.id,
          currentAgentSession,
          replacementRequired: false,
          sessionCompatibilityKey,
        };
      }
      return {
        agentSessionId: input.freshAgentSessionId,
        currentAgentSession,
        replacementRequired: true,
        sessionCompatibilityKey: resolveKey(input.freshAgentSessionId),
      };
    }

    return {
      agentSessionId: input.freshAgentSessionId,
      currentAgentSession: null,
      replacementRequired: false,
      sessionCompatibilityKey: resolveKey(input.freshAgentSessionId),
    };
  }

  /** Commits only an exact prepared replacement after scheduler dispatch. */
  public async commitPreparedAgentSessionForTurn(
    store: FsStore,
    input: CommitPreparedAgentSessionForTurnInput
  ): Promise<undefined> {
    if (input.prepared.replacementRequired) {
      const predecessor = input.prepared.currentAgentSession;
      if (!predecessor) throw new Error('Prepared replacement has no predecessor.');
      const current = store.getAgentSession(predecessor.id);
      if (current.status !== 'idle' || current.stale || current.updatedAt !== predecessor.updatedAt)
        throw new Error('Prepared predecessor changed before commit.');
      store.updateAgentSession(current.id, {
        status: 'closed',
        updatedAt: '2026-07-05T00:00:01.500Z',
      });
    }
    bindNanoHostAttemptPreparation(this.fixtureCore, {
      attemptId: input.attemptId,
      agentSessionId: input.prepared.agentSessionId,
      inputRef: `aepsnap_${input.preparation.turn.id}_${input.prepared.agentSessionId}`,
      bindingRef: `attempt-binding:${input.attemptId}`,
      sessionCompatibilityKey: input.prepared.sessionCompatibilityKey,
    });
    return undefined;
  }

  /**
   * Records one started turn.
   *
   * @param _store Store passed by the dispatch loop.
   * @param turnId Turn id selected by the scheduler queue entry.
   * @param input Turn input captured in the scheduler queue entry.
   * @param context Runtime context forwarded to the worker executor.
   */
  public async startTurn(
    _store: FsStore,
    turnId: string,
    input: string,
    context?: TurnStartRuntimeContext
  ): Promise<void> {
    this.calls.push({ context, input, turnId });
    if (!context?.attemptId) throw new Error('Recording submission needs its real Core attempt.');
    const submitted = attemptRecords.recordSchedulerExecutionOperation(this.fixtureCore, {
      attemptId: context.attemptId,
      operationId: `recording:${turnId}`,
      submission: true,
    });
    const observation = await this.submit({
      ...attemptRecords.schedulerExecutionCorrelation(submitted),
      deadline: submitted.deadline!,
    });
    attemptRecords.acceptSchedulerExecutionObservation(this.fixtureCore, observation);
    context.onSubmissionSettled?.();
  }

  /**
   * No-op interrupt implementation.
   */
  public async interruptTurn(): Promise<void> {}
}

/** Seeds the current physical Epoch required by backend-anchor fixtures. */
function seedBackendRuntimeTarget(coreDb: ReturnType<typeof createMigratedCoreDb>) {
  return recordTestNativeRuntimeTarget(coreDb);
}

class FailingTurnExecutor extends RecordingTurnExecutor {
  /** Models a lost response after the persisted original submission, without acceptance proof. */
  public override async submit(): Promise<never> {
    throw new Error('worker launch failed');
  }
}

/**
 * Creates an isolated migrated Core database for scheduler dispatch loop tests.
 *
 * @returns Open Core database handle.
 */
function createMigratedCoreDb() {
  const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-scheduler-loop-')));
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'user_local',
    workspaceId: 'ws_demo',
  });
  return coreDb;
}

/**
 * Seeds one active localhost scheduler target.
 *
 * @param coreDb Open Core database handle.
 */
function seedLocalSchedulerTarget(coreDb: ReturnType<typeof createMigratedCoreDb>): void {
  recordTestNativeRuntimeTarget(coreDb);
}

/**
 * Creates a strict agent manifest for scheduler setup resolution tests.
 *
 * @returns Strict agent manifest.
 */
function agentManifest() {
  return createTestAgentSetup().manifest;
}

/** Creates one credential-free provider registry for static AEP planning tests. */
function localProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry([
    {
      baseUrl: 'http://127.0.0.1:11434/v1',
      defaultModel: 'openai/gpt-5.2',
      displayName: 'Scheduler fixture provider',
      id: 'agent-openrouter',
      kind: 'local',
      models: ['openai/gpt-5.2'],
      modelMetadata: { 'openai/gpt-5.2': { temperature: false } },
    },
  ]);
}

/** Observes the private durable grant; an absent owner is an empty observation, not a setup error. */
function executionAttempts(
  coreDb: ReturnType<typeof createMigratedCoreDb>
): Record<string, unknown>[] {
  const table = coreDb.sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scheduler_execution_attempts'"
    )
    .get();
  return table
    ? (coreDb.sqlite
        .prepare('SELECT * FROM scheduler_execution_attempts ORDER BY rowid')
        .all() as Record<string, unknown>[])
    : [];
}

/** Publishes the ordinary source tuple for explicit queue-unit fixtures; grants no Workspace authority. */
function publishTestAdmission(
  store: FsStore,
  entry: ReturnType<typeof createSchedulerAdmissionEntry>
) {
  store.createTurn(
    entry.workspaceId,
    entry.threadId,
    entry.turnInput,
    entry.triggerActor,
    undefined,
    {
      turnId: entry.turnId,
      status: 'pending',
      agentId: entry.requestedAgentId,
      executorKind: 'worker',
    }
  );
  publishTestReceipt(store, entry);
}
/** Writes the current ordinary command receipt through its real Store owner. */
function publishTestReceipt(
  store: FsStore,
  entry: ReturnType<typeof createSchedulerAdmissionEntry>
) {
  store.recordCommandRequest({
    command: 'turn.start',
    requestId: entry.requestId,
    inputHash: `fixture:${entry.queueEntryId}`,
    scope: {
      actorId: responsibleUserIdForActor(entry.triggerActor)!,
      workspaceId: entry.workspaceId,
      threadId: entry.threadId,
    },
    response: { kind: 'turn', id: entry.turnId },
    createdAt: new Date().toISOString(),
  });
}
/** Observes durable acceptance independently of terminal completion, as an HTTP command owner does. */
async function admitTestProductTurn(input: Parameters<typeof executeProductTurn>[0]) {
  const accepted = Promise.withResolvers<ReturnType<FsStore['getTurnById']>>();
  const completion = executeProductTurn({
    ...input,
    onTurnCreated: (turn, sessionId) => {
      const entry = schedulerRecords.requireSchedulerAdmissionEntry(
        input.coreDb,
        (
          input.coreDb.sqlite
            .prepare(
              'SELECT queue_entry_id AS id FROM scheduler_admission_entries WHERE turn_id = ?'
            )
            .get(turn.id) as { id: string }
        ).id
      );
      publishTestReceipt(input.store, entry);
      input.onTurnCreated?.(turn, sessionId);
      accepted.resolve(turn);
    },
  });
  void completion.catch((error: unknown) => accepted.reject(error));
  const turn = await accepted.promise;
  // Let the actual admission-dispatch continuation enter its controlled boundary.
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  return { turn: input.store.getTurnById(turn.id), completion };
}

describe('route B durable intent before effects', () => {
  it('prepares the accepted immutable admission once without imposing static helper order', async () => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const executor = new RecordingTurnExecutor(coreDb);
    const snapshot = createInMemoryRuntimeConfigSnapshot({
      agentManifests: [agentManifest()],
      dataRoot: null,
      gatewayConfig: createTestGatewayConfig(),
      providerRegistry: localProviderRegistry(),
    });
    try {
      await admitTestProductTurn({
        coreDb,
        store,
        turnExecutor: executor,
        snapshot,

        requestedAgentId: agentManifest().id,

        providerCredentialResolver: () => null,
        triggerActor: { kind: 'user', id: 'user_local' },
        input: {
          requestId: '00000000-0000-4000-8000-00000000d301',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          input: 'Persist intent before preparation.',
        },
      });
      await vi.waitFor(() => expect(executor.calls).toHaveLength(1));
      const admission = listSchedulerAdmissionEntriesForWorkspace(coreDb, {
        workspaceId: 'ws_demo',
        statuses: ['queued', 'admitted', 'denied', 'cancelled'],
      });
      expect(admission).toHaveLength(1);
      expect(admission[0]).toMatchObject({
        requestId: '00000000-0000-4000-8000-00000000d301',
        turnInput: 'Persist intent before preparation.',
        threadId: 'th_demo',
      });
      expect(executor.prepareCalls).toEqual([
        { threadId: 'th_demo', turnId: admission[0]!.turnId },
      ]);
      expect(executor.calls[0]!.turnId).toBe(admission[0]!.turnId);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('retains unknown operation ownership after a lost native response instead of releasing a possibly accepted execution', async () => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const executor = new RecordingTurnExecutor(coreDb);
    executor.submit = async () => {
      throw new Error('Response lost after the native boundary was entered.');
    };
    const snapshot = createInMemoryRuntimeConfigSnapshot({
      agentManifests: [agentManifest()],
      dataRoot: null,
      gatewayConfig: createTestGatewayConfig(),
      providerRegistry: localProviderRegistry(),
    });
    try {
      await admitTestProductTurn({
        coreDb,
        store,
        turnExecutor: executor,
        snapshot,

        requestedAgentId: agentManifest().id,

        providerCredentialResolver: () => null,
        triggerActor: { kind: 'user', id: 'user_local' },
        input: {
          requestId: '00000000-0000-4000-8000-00000000d302',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          input: 'Observe lost acceptance without replay.',
        },
      }).catch(() => undefined);
      await vi.waitFor(() => expect(executor.calls).toHaveLength(1));
      const admission = listSchedulerAdmissionEntriesForWorkspace(coreDb, {
        workspaceId: 'ws_demo',
        statuses: ['queued', 'admitted', 'denied', 'cancelled'],
      });
      expect(admission).toHaveLength(1);
      const attempts = executionAttempts(coreDb);
      expect(attempts).toEqual([
        expect.objectContaining({ turn_id: admission[0]!.turnId, disposition: 'unknown' }),
      ]);
      expect(['open', 'closing']).toContain(attempts[0]!.phase);
      expect(attempts[0]!.operation_id).toEqual(expect.any(String));
      const reloaded = openCoreDb(coreDb.dataRoot);
      try {
        expect(executionAttempts(reloaded)).toEqual(attempts);
        expect(executor.calls).toHaveLength(1);
      } finally {
        reloaded.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });
});

describe('scheduler dispatch loop', () => {
  it.each(
    [true, false].flatMap((separateHandle) =>
      (
        ['leased', 'transient', 'deterministic', 'post-lease', 'denied', 'acquisition'] as const
      ).map((outcome) => ({ separateHandle, outcome }))
    )
  )('shares background preparation with its own caller: $outcome, separate Core handle $separateHandle', async ({
    separateHandle,
    outcome,
  }) => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const executor = new RecordingTurnExecutor(coreDb, separateHandle);
    const manifest = agentManifest();
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const errors: unknown[] = [];
    const failure =
      outcome === 'deterministic'
        ? new DeterministicAgentPreparationError(
            'Shared deterministic failure',
            'agent_not_ready',
            409
          )
        : new Error(`Shared ${outcome} failure`);
    const prepare = executor.prepareAgentSessionForTurn.bind(executor);
    let preparations = 0;
    executor.prepareAgentSessionForTurn = async (ownerStore, preparation) => {
      preparations += 1;
      entered.resolve();
      if (outcome !== 'acquisition') await gate.promise;
      if (outcome === 'transient' || outcome === 'deterministic') throw failure;
      const prepared = await prepare(ownerStore, preparation);
      if (outcome === 'denied') {
        coreDb.sqlite
          .prepare("UPDATE users SET status = 'disabled', disabled_at = ? WHERE id = 'user_local'")
          .run(Date.now());
      }
      return prepared;
    };
    if (outcome === 'post-lease')
      executor.submit = async () => {
        throw failure;
      };
    const snapshot = createInMemoryRuntimeConfigSnapshot({
      agentManifests: [manifest],
      dataRoot: null,
      gatewayConfig: createTestGatewayConfig(),
      providerRegistry: localProviderRegistry(),
    });
    seedLocalSchedulerTarget(coreDb);
    const service = startSchedulerDispatchRetryService({
      coreDb,
      store,
      turnExecutor: executor,
      executionBackend: executor.executionBackend,

      intervalMs: 60_000,
      runtimeConfigSnapshot: () => snapshot,
      onError: (error) => errors.push(error),
      setInterval: () => 'test-timer',
      clearInterval: () => {},
    });
    let background: ReturnType<typeof service.runOnce> | undefined;
    // This fault belongs to conditional attempt acquisition, before any preparation/native effect.
    // Static compatibility may run on either side; the fault cannot depend on entering that helper.
    const acquisitionFault = vi.fn(() => {
      throw failure;
    });
    let dispatchSpy: { mockRestore(): void } | undefined;
    if (outcome === 'acquisition') {
      try {
        expect(
          Reflect.get(attemptRecords, 'createSchedulerExecutionAttempt'),
          'The acquisition fault needs the current conditional attempt owner, not a legacy graph dispatcher.'
        ).toBeTypeOf('function');
        expect(
          coreDb.sqlite
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scheduler_execution_attempts'"
            )
            .get(),
          'Missing attempt storage cannot prove the absence of a reopened grant.'
        ).toBeDefined();
        dispatchSpy = vi
          .spyOn(
            attemptRecords as unknown as {
              createSchedulerExecutionAttempt: (...args: unknown[]) => unknown;
            },
            'createSchedulerExecutionAttempt'
          )
          .mockImplementation(acquisitionFault);
      } catch (error) {
        service.stop();

        coreDb.sqlite.close();
        throw error;
      }
    }
    const cancelSpy = vi.spyOn(schedulerRecords, 'cancelSchedulerAdmissionEntry');
    const onTurnCreated = vi.fn(() => {
      background = service.runOnce();
    });
    const caller = admitTestProductTurn({
      coreDb,
      store,
      turnExecutor: executor,
      snapshot,

      onTurnCreated,

      providerCredentialResolver: () => null,
      triggerActor: { kind: 'user', id: 'user_local' },
      input: {
        agentId: manifest.id,
        input: 'Shared admission',
        requestId: '00000000-0000-4000-8000-00000000f201',
        threadId: 'th_demo',
        workspaceId: 'ws_demo',
      },
    }).then(
      (handle) => ({ handle }),
      (error: unknown) => ({ error })
    );
    try {
      if (outcome === 'acquisition') {
        await vi.waitFor(() => expect(acquisitionFault).toHaveBeenCalledTimes(2));
        const [backgroundResult, callerResult] = await Promise.all([background, caller]);
        expect(backgroundResult).toBeNull();
        expect(errors).toEqual([failure]);
        expect(callerResult).toHaveProperty('handle');
        expect(JSON.stringify(callerResult)).not.toContain(failure.message);
        const [accepted] = listQueuedSchedulerAdmissionEntries(coreDb);
        expect(accepted).toMatchObject({
          requestId: '00000000-0000-4000-8000-00000000f201',
          status: 'queued',
        });
        if ('handle' in callerResult) expect(callerResult.handle.turn.id).toBe(accepted!.turnId);
        expect(executor.calls).toEqual([]);
        expect(preparations).toBeLessThanOrEqual(1);
        expect(executionAttempts(coreDb).filter((attempt) => attempt.phase !== 'closed')).toEqual(
          []
        );
        expect(cancelSpy).not.toHaveBeenCalled();
        expect(getSchedulerPreparationClaims(coreDb).size).toBe(0);
        return;
      }
      await vi.waitFor(() => expect(preparations).toBe(1), { timeout: 1000 });
      const [admission] = listSchedulerAdmissionEntriesForWorkspace(coreDb, {
        workspaceId: 'ws_demo',
        statuses: ['admitted'],
      });
      expect(admission).toBeDefined();
      expect(preparations).toBe(1);
      const before = coreDb.sqlite.prepare('SELECT total_changes() AS count').get();
      // A background overlap ends its pass; it cannot enter a second preparation or write claim state.
      const overlapPending = service.runOnce();
      expect(preparations).toBe(1);
      const overlap = await overlapPending;
      expect(overlap?.startedTurns).toEqual([]);
      expect(coreDb.sqlite.prepare('SELECT total_changes() AS count').get()).toEqual(before);

      gate.resolve();
      const [backgroundResult, callerResult] = await Promise.all([background, caller]);
      expect(preparations).toBe(1);
      expect(getSchedulerPreparationClaims(coreDb).size).toBe(0);
      if (outcome === 'leased') {
        expect(backgroundResult?.startedTurns).toHaveLength(1);
        expect(callerResult).toHaveProperty('handle');
        if ('handle' in callerResult)
          expect(callerResult.handle.turn.id).toBe(
            backgroundResult?.startedTurns[0]?.handle.turn.id
          );
        expect(onTurnCreated).toHaveBeenCalledTimes(1);
        expect(onTurnCreated.mock.calls[0]?.[0].id).toBe(admission?.turnId);
        expect(errors).toEqual([]);
      } else if (
        outcome === 'transient' ||
        outcome === 'deterministic' ||
        outcome === 'post-lease'
      ) {
        expect(callerResult).toHaveProperty('handle');
        const failed = store.getTurnById(admission!.turnId);
        expect(failed).toMatchObject({ status: 'failed', error: { message: failure.message } });
        const attempt = executionAttempts(coreDb)[0]!;
        expect(attempt).toMatchObject(
          outcome === 'post-lease'
            ? { phase: 'closing', disposition: 'unknown', fence_ref: null }
            : { phase: 'closed', disposition: 'not_accepted', operation_id: null }
        );
        expect(backgroundResult).toBeNull();
        expect(errors).toHaveLength(1);
        expect(errors[0]).toBe(failure);
        expect(
          schedulerRecords.requireSchedulerAdmissionEntry(coreDb, admission!.queueEntryId).status
        ).toBe('admitted');
        expect(cancelSpy).not.toHaveBeenCalled();
        if (outcome === 'post-lease') {
          expect(['open', 'closing']).toContain(executionAttempts(coreDb)[0]?.phase);
        }
        expect((await service.runOnce())?.startedTurns).toEqual([]);
        expect(preparations).toBe(1);
      } else {
        expect(callerResult).toHaveProperty('handle');
        expect(backgroundResult).toBeNull();
        expect(errors).toMatchObject([{ code: 'workspace_access_denied', status: 403 }]);
        expect(store.getTurnById(admission!.turnId).status).toBe('failed');
        expect(executionAttempts(coreDb)).toMatchObject([
          { phase: 'closed', disposition: 'not_accepted', operation_id: null },
        ]);
        expect(
          schedulerRecords.requireSchedulerAdmissionEntry(coreDb, admission!.queueEntryId).status
        ).toBe('admitted');
        expect(cancelSpy).not.toHaveBeenCalled();
      }
    } finally {
      gate.resolve();
      await Promise.all([background, caller]);
      service.stop();

      cancelSpy.mockRestore();
      dispatchSpy?.mockRestore();
      coreDb.sqlite.close();
    }
  });

  it.each([
    true,
    false,
  ])('does not wait for or disclose a foreign claimed admission, separate Core handle %s', async (separateHandle) => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const manifest = agentManifest();
    const executor = new RecordingTurnExecutor(coreDb, separateHandle);
    const gate = Promise.withResolvers<void>();
    const failure = new Error('FOREIGN-PRIVATE preparation diagnostics');
    let preparations = 0;
    executor.prepareAgentSessionForTurn = async () => {
      preparations += 1;
      await gate.promise;
      throw failure;
    };
    const foreignWorkspace = store.createWorkspace('Foreign Workspace');
    const foreignThread = store.createThread(foreignWorkspace.id, 'Foreign Thread');
    coreDb.sqlite
      .prepare(`INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind)
      VALUES ('user_claim_foreign', 'Foreign', 'claim-foreign@example.invalid', false, ?, ?, 'human')`)
      .run(Date.now(), Date.now());
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_claim_foreign',
      workspaceId: foreignWorkspace.id,
    });
    seedLocalSchedulerTarget(coreDb);
    publishTestAdmission(
      store,
      createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        queueEntryId: 'queue_claim_foreign',
        requestId: 'queue_claim_foreign',
        turnId: 'turn_claim_foreign',
        workspaceId: foreignWorkspace.id,
        threadId: foreignThread.id,
        turnInput: 'Private foreign work',
        requestedAgentId: manifest.id,
        triggerActor: { kind: 'user', id: 'user_claim_foreign' },
        now: () => '2026-07-05T00:00:00.000Z',
      })
    );
    const snapshot = createInMemoryRuntimeConfigSnapshot({
      agentManifests: [manifest],
      dataRoot: null,
      gatewayConfig: createTestGatewayConfig(),
      providerRegistry: localProviderRegistry(),
    });
    const background = runSchedulerDispatchLoop({
      coreDb,
      store,
      turnExecutor: executor,
      executionBackend: executor.executionBackend,
      agentManifests: [manifest],
      providerRegistry: snapshot.providerRegistry,
      gatewayConfig: snapshot.gatewayConfig,
    }).catch((error: unknown) => error);
    const caller = admitTestProductTurn({
      coreDb,
      store,
      turnExecutor: executor,
      snapshot,

      providerCredentialResolver: () => null,
      triggerActor: { kind: 'user', id: 'user_local' },
      input: {
        agentId: manifest.id,
        input: 'Own work',
        requestId: '00000000-0000-4000-8000-00000000f202',
        threadId: 'th_demo',
        workspaceId: 'ws_demo',
      },
    }).catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(preparations).toBe(1), { timeout: 1000 });
      const error = await caller;
      expect(error).not.toBeInstanceOf(Error);
      expect(JSON.stringify(error)).not.toContain('FOREIGN-PRIVATE');
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          workspaceId: 'ws_demo',
          statuses: ['queued', 'cancelled'],
        })
      ).toMatchObject([{ status: 'queued' }]);
      gate.resolve();
      expect(await background).toBe(failure);
      expect(
        schedulerRecords.requireSchedulerAdmissionEntry(coreDb, 'queue_claim_foreign').status
      ).toBe('admitted');
      expect(executionAttempts(coreDb)).toMatchObject([
        { phase: 'closed', disposition: 'not_accepted', operation_id: null },
      ]);
      expect(getSchedulerPreparationClaims(coreDb).size).toBe(0);
    } finally {
      gate.resolve();
      await Promise.all([background, caller]);
      coreDb.sqlite.close();
    }
  });

  it('keys preparation owners by data root, including separate handles for the same root', () => {
    const first = createMigratedCoreDb();
    const second = createMigratedCoreDb();
    const sameRoot = openCoreDb(first.dataRoot);
    try {
      expect(getSchedulerPreparationClaims(first)).not.toBe(getSchedulerPreparationClaims(second));
      expect(getSchedulerPreparationClaims(sameRoot)).toBe(getSchedulerPreparationClaims(first));
      expect(getSchedulerPreparationClaims(first).size).toBe(0);
    } finally {
      sameRoot.sqlite.close();
      second.sqlite.close();
      first.sqlite.close();
    }
  });

  it('excludes a second FIFO preparation after image operation intent until submission', async () => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const executor = new RecordingTurnExecutor(coreDb);
    const manifest = agentManifest();
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const prepare = executor.prepareAgentSessionForTurn.bind(executor);
    executor.prepareAgentSessionForTurn = async (owner, input) => {
      if (
        coreDb.sqlite
          .prepare(
            "SELECT 1 FROM scheduler_execution_attempts WHERE phase = 'open' AND deadline IS NOT NULL"
          )
          .get()
      )
        throw new WorkerGovernanceCapacityUnavailableError();
      return prepare(owner, input);
    };
    const start = executor.startTurn.bind(executor);
    executor.startTurn = async (owner, turnId, input, context) => {
      if (turnId === 'turn_image_first') {
        const intent = attemptRecords.recordSchedulerExecutionOperation(coreDb, {
          attemptId: context!.attemptId!,
          operationId: 'image:first',
        });
        entered.resolve();
        await gate.promise;
        attemptRecords.acceptSchedulerExecutionObservation(coreDb, {
          ...attemptRecords.schedulerExecutionCorrelation(intent),
          disposition: 'accepted',
          execution: 'pending',
          fenceRef: null,
          outcomeRef: null,
        });
      }
      await start(owner, turnId, input, context);
    };
    const dispatch = {
      coreDb,
      store,
      turnExecutor: executor,
      executionBackend: executor.executionBackend,
      agentManifests: [manifest],
      providerRegistry: localProviderRegistry(),
      gatewayConfig: createTestGatewayConfig(),
      maxDispatches: 1,
    };
    for (const suffix of ['first', 'second']) {
      const thread = store.createThread('ws_demo', suffix);
      publishTestAdmission(
        store,
        createSchedulerAdmissionEntry(coreDb, {
          backendId: 'nanohost',
          queueEntryId: `queue_image_${suffix}`,
          requestId: `request_image_${suffix}`,
          turnId: `turn_image_${suffix}`,
          workspaceId: 'ws_demo',
          threadId: thread.id,
          turnInput: suffix,
          requestedAgentId: manifest.id,
          triggerActor: { kind: 'user', id: 'user_local' },
        })
      );
    }
    const first = runSchedulerDispatchLoop(dispatch);
    try {
      await entered.promise;
      expect(executionAttempts(coreDb)).toMatchObject([
        { operation_id: 'image:first', deadline: null },
      ]);
      const overlap = await runSchedulerDispatchLoop(dispatch);
      expect(overlap.startedTurns).toEqual([]);
      expect(executor.prepareCalls).toHaveLength(1);
      expect(store.getTurnById('turn_image_second').status).toBe('pending');
      expect(store.getTurnById('turn_image_second').agentSessionId).toBeUndefined();
      expect(executionAttempts(coreDb)).toHaveLength(1);
      gate.resolve();
      const admitted = await first;
      expect((await runSchedulerDispatchLoop(dispatch)).startedTurns).toEqual([]);
      expect(store.getTurnById('turn_image_second').status).toBe('pending');
      expect(executor.prepareCalls).toHaveLength(1);
      await closeOwnedExecutionAttempt(coreDb, store, {
        attemptId: admitted.startedTurns[0]!.dispatch.attempt.attemptId,
        firstTerminalCause: 'turn-completed',
      });
      expect(
        (await runSchedulerDispatchLoop(dispatch)).startedTurns[0]?.dispatch.entry.queueEntryId
      ).toBe('queue_image_second');
      expect(executor.calls.map((call) => call.turnId)).toEqual([
        'turn_image_first',
        'turn_image_second',
      ]);
    } finally {
      gate.resolve();
      await first;
      await Promise.allSettled([...getSchedulerPreparationClaims(coreDb).values()]);
      coreDb.sqlite.close();
    }
  });

  it('ends overlapping background passes and later dispatches queued admissions in FIFO order', async () => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const executor = new RecordingTurnExecutor(coreDb);
    const manifest = agentManifest();
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const prepare = executor.prepareAgentSessionForTurn.bind(executor);
    let preparations = 0;
    executor.prepareAgentSessionForTurn = async (ownerStore, preparation) => {
      preparations += 1;
      if (preparation.turn.id === 'turn_claim_first') {
        entered.resolve();
        await gate.promise;
      }
      return prepare(ownerStore, preparation);
    };
    seedLocalSchedulerTarget(coreDb);
    const snapshot = createInMemoryRuntimeConfigSnapshot({
      agentManifests: [manifest],
      dataRoot: null,
      gatewayConfig: createTestGatewayConfig(),
      providerRegistry: localProviderRegistry(),
    });
    const errors: unknown[] = [];
    let timerTick: (() => void) | undefined;
    const service = startSchedulerDispatchRetryService({
      coreDb,
      store,
      turnExecutor: executor,
      executionBackend: executor.executionBackend,

      intervalMs: 60_000,
      runtimeConfigSnapshot: () => snapshot,
      onError: (error) => errors.push(error),
      setInterval: (callback) => {
        timerTick = callback;
        return 'test-timer';
      },
      clearInterval: () => {},
    });
    for (const [index, suffix] of ['first', 'second', 'third'].entries()) {
      const thread = store.createThread('ws_demo', suffix);
      publishTestAdmission(
        store,
        createSchedulerAdmissionEntry(coreDb, {
          backendId: 'nanohost',
          queueEntryId: `queue_claim_${suffix}`,
          requestId: `queue_claim_${suffix}`,
          turnId: `turn_claim_${suffix}`,
          workspaceId: 'ws_demo',
          threadId: thread.id,
          turnInput: suffix,
          requestedAgentId: manifest.id,
          triggerActor: { kind: 'user', id: 'user_local' },
          now: () => `2026-07-05T00:00:0${index}.000Z`,
        })
      );
    }
    const firstRun = service.runOnce();
    try {
      await vi.waitFor(() => expect(preparations).toBe(1), { timeout: 1000 });
      timerTick?.();
      const overlapPending = service.runOnce();
      expect(preparations).toBe(1);
      const overlap = await overlapPending;
      expect(overlap?.startedTurns).toEqual([]);
      expect(errors).toEqual([]);
      gate.resolve();
      await firstRun;
      const [firstLease] = coreDb.sqlite
        .prepare('SELECT attempt_id FROM scheduler_execution_attempts')
        .all() as { attempt_id: string }[];
      await closeOwnedExecutionAttempt(coreDb, store, {
        attemptId: firstLease!.attempt_id,
        firstTerminalCause: 'turn-completed',
      });
      for (const suffix of ['second', 'third']) {
        const result = await service.runOnce();
        expect(result?.startedTurns[0]?.dispatch.entry.queueEntryId).toBe(`queue_claim_${suffix}`);
        await closeOwnedExecutionAttempt(coreDb, store, {
          attemptId: result!.startedTurns[0]!.dispatch.attempt.attemptId,
          firstTerminalCause: 'turn-completed',
        });
      }
      expect(preparations).toBe(3);
      expect(executor.calls.map((call) => call.turnId)).toEqual([
        'turn_claim_first',
        'turn_claim_second',
        'turn_claim_third',
      ]);
      expect(errors).toEqual([]);
    } finally {
      gate.resolve();
      await firstRun;
      service.stop();
      coreDb.sqlite.close();
    }
  });

  it.each(
    [true, false].flatMap((separateHandle) =>
      (['queue-race', 'malformed-row'] as const).map((failureStage) => ({
        separateHandle,
        failureStage,
      }))
    )
  )('accepts its own queued work without disclosing foreign dispatch failures: $failureStage, separate Core handle $separateHandle', async ({
    separateHandle,
    failureStage,
  }) => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const workspace = store.createWorkspace('Foreign Workspace');
    const thread = store.createThread(workspace.id, 'Foreign Thread');
    const turnExecutor = new RecordingTurnExecutor(coreDb, separateHandle);
    const manifest = agentManifest();
    const privateText = 'FOREIGN-PRIVATE queue_foreign_race';
    const requestId = '00000000-0000-4000-8000-00000000f124';

    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO users
            (id, display_name, email, email_verified, created_at, updated_at, kind)
           VALUES ('user_foreign', 'Foreign', 'foreign@example.invalid', false, ?, ?, 'human')`
        )
        .run(Date.now(), Date.now());
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'user_foreign',
        workspaceId: workspace.id,
      });
      seedLocalSchedulerTarget(coreDb);
      publishTestAdmission(
        store,
        createSchedulerAdmissionEntry(coreDb, {
          backendId: 'nanohost',
          profileRef: null,
          queueEntryId: 'queue_foreign_race',
          requestId: 'req_foreign_race',
          requestedAgentId: manifest.id,
          threadId: thread.id,
          turnId: 'turn_foreign_race',
          turnInput: 'Foreign private work',
          triggerActor: { kind: 'user', id: 'user_foreign' },
          workspaceId: workspace.id,
          now: () => '2026-07-05T00:00:00.000Z',
        })
      );
      if (failureStage === 'queue-race') {
        const prepare = turnExecutor.prepareAgentSessionForTurn.bind(turnExecutor);
        turnExecutor.prepareAgentSessionForTurn = async (ownerStore, preparation) => {
          expect(preparation.turn.id).toBe('turn_foreign_race');
          const prepared = await prepare(ownerStore, preparation);
          cancelSchedulerAdmissionEntry(coreDb, {
            queueEntryId: 'queue_foreign_race',
            requestId: 'queue_foreign_race',
            workspaceId: workspace.id,
          });
          return prepared;
        };
      } else {
        coreDb.sqlite
          .prepare(
            'UPDATE scheduler_admission_entries SET trigger_actor_json = ? WHERE queue_entry_id = ?'
          )
          .run(privateText, 'queue_foreign_race');
      }
      const error = await admitTestProductTurn({
        coreDb,
        input: {
          agentId: manifest.id,
          input: 'Caller work',
          requestId,
          threadId: 'th_demo',
          workspaceId: 'ws_demo',
        },
        providerCredentialResolver: () => null,

        snapshot: createInMemoryRuntimeConfigSnapshot({
          agentManifests: [manifest],
          dataRoot: null,
          gatewayConfig: createTestGatewayConfig(),
          providerRegistry: localProviderRegistry(),
        }),
        store,
        triggerActor: { kind: 'user', id: 'user_local' },
        turnExecutor,
      }).catch((caught: unknown) => caught);

      expect(error).not.toBeInstanceOf(Error);
      const projection = error;
      for (const diagnostic of [String(error), JSON.stringify(projection)]) {
        expect(diagnostic).not.toContain('FOREIGN-PR');
        expect(diagnostic).not.toContain('queue_foreign_race');
      }
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT status, trigger_actor_json AS actor FROM scheduler_admission_entries WHERE queue_entry_id = ?'
          )
          .get('queue_foreign_race')
      ).toEqual({
        status: failureStage === 'queue-race' ? 'admitted' : 'queued',
        actor:
          failureStage === 'queue-race'
            ? JSON.stringify({ kind: 'user', id: 'user_foreign' })
            : privateText,
      });
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          statuses: ['queued', 'cancelled'],
          workspaceId: 'ws_demo',
        })
      ).toMatchObject([{ requestId, status: 'queued' }]);

      expect(turnExecutor.calls).toEqual([]);
      if (failureStage === 'malformed-row') {
        expect(turnExecutor.prepareCalls).toEqual([]);
        expect(() => listQueuedSchedulerAdmissionEntries(coreDb)).toThrow(SyntaxError);
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    true,
    false,
  ])('preserves original acceptance when cancellation after acquisition refuses and later work is queued, separate Core handle %s', async (separateHandle) => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turnExecutor = new RecordingTurnExecutor(coreDb, separateHandle);
    const manifest = agentManifest();
    const thread = store.createThread('ws_demo', 'Later Thread');
    const prepare = turnExecutor.prepareAgentSessionForTurn.bind(turnExecutor);
    let ownQueueEntryId = '';
    turnExecutor.prepareAgentSessionForTurn = async (ownerStore, preparation) => {
      const prepared = await prepare(ownerStore, preparation);
      const own = listSchedulerAdmissionEntriesForWorkspace(coreDb, {
        workspaceId: 'ws_demo',
        statuses: ['admitted'],
      })[0]!;
      expect(own.turnId).toBe(preparation.turn.id);
      ownQueueEntryId = own.queueEntryId;

      publishTestAdmission(
        store,
        createSchedulerAdmissionEntry(coreDb, {
          backendId: 'nanohost',
          queueEntryId: 'queue_later_race',
          requestId: 'queue_later_race',
          requestedAgentId: manifest.id,
          threadId: thread.id,
          turnId: 'turn_later_race',
          turnInput: 'Later work',
          triggerActor: { kind: 'user', id: 'user_local' },
          workspaceId: 'ws_demo',
        })
      );

      cancelSchedulerAdmissionEntry(coreDb, {
        queueEntryId: ownQueueEntryId,
        workspaceId: 'ws_demo',
      });
      return prepared;
    };
    try {
      seedLocalSchedulerTarget(coreDb);
      await admitTestProductTurn({
        coreDb,
        input: {
          agentId: manifest.id,
          input: 'Own work',
          requestId: '00000000-0000-4000-8000-00000000f125',
          threadId: 'th_demo',
          workspaceId: 'ws_demo',
        },
        providerCredentialResolver: () => null,

        snapshot: createInMemoryRuntimeConfigSnapshot({
          agentManifests: [manifest],
          dataRoot: null,
          gatewayConfig: createTestGatewayConfig(),
          providerRegistry: localProviderRegistry(),
        }),
        store,
        triggerActor: { kind: 'user', id: 'user_local' },
        turnExecutor,
      }).catch((caught: unknown) => caught);
      expect(ownQueueEntryId).not.toBe('');

      expect(listQueuedSchedulerAdmissionEntries(coreDb)).toMatchObject([
        { queueEntryId: 'queue_later_race' },
      ]);
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          statuses: ['admitted'],
          workspaceId: 'ws_demo',
        })
      ).toMatchObject([{ queueEntryId: ownQueueEntryId }]);
      expect(executionAttempts(coreDb)).toMatchObject([
        { phase: 'closed', disposition: 'not_accepted', operation_id: null },
      ]);

      expect(turnExecutor.calls).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each(
    [true, false].flatMap((separateHandle) =>
      (['deterministic-preparation', 'transient-preparation', 'turn-start'] as const).map(
        (failureStage) => ({ separateHandle, failureStage })
      )
    )
  )('isolates another admission failure: $failureStage, separate Core handle $separateHandle', async ({
    separateHandle,
    failureStage,
  }) => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const workspace = store.createWorkspace('Other User Workspace');
    const thread = store.createThread(workspace.id, 'Other User Thread');
    const turnExecutor = new RecordingTurnExecutor(coreDb, separateHandle);
    const manifest = agentManifest();
    const failureMessage = `Private diagnostics for ${workspace.id}, user_other: ${failureStage}`;
    const failure =
      failureStage === 'deterministic-preparation'
        ? new DeterministicAgentPreparationError(failureMessage, 'agent_not_ready', 409)
        : new TurnStartValidationError('recovery_required', failureMessage, 503);
    if (failureStage === 'turn-start') {
      turnExecutor.startTurn = async (_store, turnId) => {
        expect(turnId).toBe('turn_other_failure');
        throw failure;
      };
    } else {
      turnExecutor.prepareAgentSessionForTurn = async (_store, preparation) => {
        expect(preparation.turn.id).toBe('turn_other_failure');
        throw failure;
      };
    }
    const snapshot = createInMemoryRuntimeConfigSnapshot({
      agentManifests: [manifest],
      dataRoot: null,
      gatewayConfig: createTestGatewayConfig(),
      openKitConfig: { defaults: { defaultAgentId: manifest.id } },
      providerRegistry: localProviderRegistry(),
    });
    const requestId = '00000000-0000-4000-8000-00000000f120';

    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO users
            (id, display_name, email, email_verified, created_at, updated_at, kind)
           VALUES ('user_other', 'Other User', 'other@example.invalid', false, ?, ?, 'human')`
        )
        .run(Date.now(), Date.now());
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'user_other',
        workspaceId: workspace.id,
      });
      seedLocalSchedulerTarget(coreDb);
      publishTestAdmission(
        store,
        createSchedulerAdmissionEntry(coreDb, {
          backendId: 'nanohost',
          profileRef: null,
          queueEntryId: 'queue_other_failure',
          requestId: 'req_other_failure',
          requestedAgentId: manifest.id,
          threadId: thread.id,
          turnId: 'turn_other_failure',
          turnInput: 'Other user private work',
          triggerActor: { kind: 'user', id: 'user_other' },
          workspaceId: workspace.id,
          now: () => '2026-07-05T00:00:00.000Z',
        })
      );
      const error = await admitTestProductTurn({
        coreDb,
        input: {
          agentId: manifest.id,
          input: 'New caller work',
          requestId,
          threadId: 'th_demo',
          workspaceId: 'ws_demo',
        },
        providerCredentialResolver: () => null,

        snapshot,
        store,
        triggerActor: { kind: 'user', id: 'user_local' },
        turnExecutor,
      }).catch((caught: unknown) => caught);

      expect(error).not.toBeInstanceOf(Error);
      expect(String(error)).not.toContain(failureMessage);
      expect(String(error)).not.toContain(workspace.id);
      expect(String(error)).not.toContain('user_other');
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          statuses: ['queued', 'admitted', 'cancelled'],
          workspaceId: workspace.id,
        })
      ).toMatchObject([
        {
          queueEntryId: 'queue_other_failure',
          requestId: 'req_other_failure',
          status: 'admitted',
        },
      ]);
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          statuses: ['queued', 'cancelled'],
          workspaceId: 'ws_demo',
        })
      ).toMatchObject([{ requestId, status: 'queued' }]);

      expect(turnExecutor.calls).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    true,
    false,
  ])('keeps its accepted work after a later foreign row is corrupted, separate Core handle %s', async (separateHandle) => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turnExecutor = new RecordingTurnExecutor(coreDb, separateHandle);
    const manifest = agentManifest();
    const workspace = store.createWorkspace('Later Foreign Workspace');
    const thread = store.createThread(workspace.id, 'Later Foreign Thread');
    const requestId = '00000000-0000-4000-8000-00000000f126';
    const privateText = 'FOREIGN-PRIVATE queue_later_foreign';
    const prepare = turnExecutor.prepareAgentSessionForTurn.bind(turnExecutor);
    let ownPreparationRan = false;
    turnExecutor.prepareAgentSessionForTurn = async (ownerStore, preparation) => {
      expect(preparation.turn.workspaceId).toBe('ws_demo');
      expect(preparation.requestId).toBe(requestId);
      ownPreparationRan = true;
      const prepared = await prepare(ownerStore, preparation);
      coreDb.sqlite
        .prepare(
          'UPDATE scheduler_admission_entries SET trigger_actor_json = ? WHERE queue_entry_id = ?'
        )
        .run(privateText, 'queue_later_foreign');
      return prepared;
    };
    try {
      coreDb.sqlite
        .prepare(`INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind)
          VALUES ('user_later_foreign', 'Foreign', 'later-foreign@example.invalid', false, ?, ?, 'human')`)
        .run(Date.now(), Date.now());
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'user_later_foreign',
        workspaceId: workspace.id,
      });
      seedLocalSchedulerTarget(coreDb);

      const error = await admitTestProductTurn({
        onTurnCreated: () => {
          publishTestAdmission(
            store,
            createSchedulerAdmissionEntry(coreDb, {
              backendId: 'nanohost',
              queueEntryId: 'queue_later_foreign',
              requestId: 'req_later_foreign',
              requestedAgentId: manifest.id,
              threadId: thread.id,
              turnId: 'turn_later_foreign',
              turnInput: 'Private foreign work',
              triggerActor: { kind: 'user', id: 'user_later_foreign' },
              workspaceId: workspace.id,
              now: () => '2099-01-01T00:00:00.000Z',
            })
          );
        },
        coreDb,
        input: {
          agentId: manifest.id,
          input: 'Caller work',
          requestId,
          threadId: 'th_demo',
          workspaceId: 'ws_demo',
        },
        providerCredentialResolver: () => null,

        snapshot: createInMemoryRuntimeConfigSnapshot({
          agentManifests: [manifest],
          dataRoot: null,
          gatewayConfig: createTestGatewayConfig(),
          providerRegistry: localProviderRegistry(),
        }),
        store,
        triggerActor: { kind: 'user', id: 'user_local' },
        turnExecutor,
      }).catch((caught: unknown) => caught);
      expect(ownPreparationRan).toBe(true);
      expect(error).not.toBeInstanceOf(Error);
      expect(String(error)).not.toContain('FOREIGN-PR');
      expect(String(error)).not.toContain('queue_later_foreign');
      const projection = error;
      expect(JSON.stringify(projection)).not.toContain('FOREIGN-PR');
      expect(JSON.stringify(projection)).not.toContain('queue_later_foreign');
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          statuses: ['admitted'],
          workspaceId: 'ws_demo',
        })
      ).toMatchObject([{ requestId, status: 'admitted' }]);
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT status, trigger_actor_json AS actor FROM scheduler_admission_entries WHERE queue_entry_id = ?'
          )
          .get('queue_later_foreign')
      ).toEqual({ status: 'queued', actor: privateText });

      expect(turnExecutor.calls).toHaveLength(1);
      expect(executionAttempts(coreDb)).toMatchObject([
        { phase: 'open', disposition: 'accepted', operation_id: expect.any(String) },
      ]);
      expect(() => listQueuedSchedulerAdmissionEntries(coreDb)).toThrow(SyntaxError);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    true,
    false,
  ])('preserves an exact own commit failure after acquisition re-attribution, separate Core handle %s', async (separateHandle) => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turnExecutor = new RecordingTurnExecutor(coreDb, separateHandle);
    const manifest = agentManifest();
    const failure = new TurnStartValidationError('recovery_required', 'Own commit failed', 503);
    turnExecutor.commitPreparedAgentSessionForTurn = async (_store, input) => {
      expect(['open', 'closing']).toContain(
        executionAttempts(coreDb).find((attempt) => attempt.attempt_id === input.attemptId)?.phase
      );
      throw failure;
    };
    try {
      seedLocalSchedulerTarget(coreDb);
      await expect(
        admitTestProductTurn({
          coreDb,
          input: {
            agentId: manifest.id,
            input: 'Own caller work',
            requestId: '00000000-0000-4000-8000-00000000f127',
            threadId: 'th_demo',
            workspaceId: 'ws_demo',
          },
          providerCredentialResolver: () => null,

          snapshot: createInMemoryRuntimeConfigSnapshot({
            agentManifests: [manifest],
            dataRoot: null,
            gatewayConfig: createTestGatewayConfig(),
            providerRegistry: localProviderRegistry(),
          }),
          store,
          triggerActor: { kind: 'user', id: 'user_local' },
          turnExecutor,
        })
      ).resolves.toMatchObject({ turn: { status: 'failed', error: { message: failure.message } } });
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          statuses: ['admitted'],
          workspaceId: 'ws_demo',
        })
      ).toHaveLength(1);

      expect(turnExecutor.calls).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each(
    [true, false].flatMap((separateHandle) =>
      (['deterministic-preparation', 'turn-start'] as const).map((failureStage) => ({
        separateHandle,
        failureStage,
      }))
    )
  )('preserves the original accepted Turn failure and error provenance: $failureStage, separate Core handle $separateHandle', async ({
    separateHandle,
    failureStage,
  }) => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turnExecutor = new RecordingTurnExecutor(coreDb, separateHandle);
    const manifest = agentManifest();
    const cancel = vi.spyOn(schedulerRecords, 'cancelSchedulerAdmissionEntry');
    const failure =
      failureStage === 'deterministic-preparation'
        ? new DeterministicAgentPreparationError('Own preparation failed', 'agent_not_ready', 409)
        : new TurnStartValidationError('recovery_required', 'Own worker launch failed', 503);
    if (failureStage === 'turn-start') {
      turnExecutor.submit = async () => {
        throw failure;
      };
    } else {
      turnExecutor.prepareAgentSessionForTurn = async () => {
        throw failure;
      };
    }
    try {
      seedLocalSchedulerTarget(coreDb);
      await expect(
        admitTestProductTurn({
          coreDb,
          input: {
            agentId: manifest.id,
            input: 'Own caller work',
            requestId: '00000000-0000-4000-8000-00000000f121',
            threadId: 'th_demo',
            workspaceId: 'ws_demo',
          },
          providerCredentialResolver: () => null,

          snapshot: createInMemoryRuntimeConfigSnapshot({
            agentManifests: [manifest],
            dataRoot: null,
            gatewayConfig: createTestGatewayConfig(),
            openKitConfig: { defaults: { defaultAgentId: manifest.id } },
            providerRegistry: localProviderRegistry(),
          }),
          store,
          triggerActor: { kind: 'user', id: 'user_local' },
          turnExecutor,
        })
      ).resolves.toMatchObject({ turn: { status: 'failed', error: { message: failure.message } } });
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          statuses: ['admitted', 'cancelled'],
          workspaceId: 'ws_demo',
        })
      ).toMatchObject([{ status: 'admitted' }]);
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      cancel.mockRestore();
      coreDb.sqlite.close();
    }
  });

  it.each([
    {
      earlierDeniedQueue: false,
    },
    {
      earlierDeniedQueue: true,
    },
  ])('keeps valid admin work accepted behind another denial: $earlierDeniedQueue', async ({
    earlierDeniedQueue,
  }) => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const manifest = agentManifest();
    const requestId = earlierDeniedQueue
      ? '00000000-0000-4000-8000-00000000f112'
      : '00000000-0000-4000-8000-00000000f111';
    const now = Date.now();
    coreDb.sqlite
      .prepare(
        `INSERT INTO users (
          id, display_name, email, email_verified, created_at, updated_at, kind, status, disabled_at
        ) VALUES ('user_admin_dispatch', 'Admin', 'admin-dispatch@example.com', false, ?, ?, 'human', 'active', NULL)`
      )
      .run(now, now);
    createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: 'user_admin_dispatch',
      scope: 'server-admin',
      tokenId: 'token_admin_dispatch',
      workspaceIds: [],
    });
    if (earlierDeniedQueue) {
      createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        triggerActor: { kind: 'user', id: 'user_without_membership' },
        queueEntryId: 'queue_earlier_denied',
        requestId: 'req_earlier_denied',
        workspaceId: 'ws_demo',
        threadId: 'th_other',
        turnId: 'turn_other',
        turnInput: 'A prior request',
        requestedAgentId: manifest.id,
        profileRef: null,
      });
    }
    const snapshot = createInMemoryRuntimeConfigSnapshot({
      agentManifests: [manifest],
      dataRoot: null,
      gatewayConfig: createTestGatewayConfig(),
      openKitConfig: { defaults: { defaultAgentId: manifest.id } },
      providerRegistry: localProviderRegistry(),
    });

    try {
      const started = admitTestProductTurn({
        coreDb,
        input: {
          agentId: manifest.id,
          input: 'Attempt admin worker dispatch.',
          modelId: 'openai/gpt-5.2',
          profileId: 'default',
          requestId,
          threadId: 'th_demo',
          workspaceId: 'ws_demo',
        },
        providerCredentialResolver: () => null,
        requestActor: {
          kind: 'token',
          tokenId: 'token_admin_dispatch',
          tokenScope: 'server-admin',
          tokenWorkspaceIds: [],
          userId: 'user_admin_dispatch',
        },

        snapshot,
        store,
        triggerActor: { kind: 'user', id: 'user_admin_dispatch' },
        turnExecutor: new RecordingTurnExecutor(coreDb),
      });
      if (earlierDeniedQueue) {
        await expect(started).resolves.toBeDefined();
      } else {
        await expect(started).resolves.toMatchObject({ turn: { status: 'running' } });
      }
      const entries = listSchedulerAdmissionEntriesForWorkspace(coreDb, {
        statuses: ['queued', 'admitted', 'cancelled', 'denied'],
        workspaceId: 'ws_demo',
      });
      expect(entries.find((entry) => entry.requestId === requestId)).toMatchObject({
        serverAdminTokenId: 'token_admin_dispatch',
        status: earlierDeniedQueue ? 'queued' : 'admitted',
      });
      if (earlierDeniedQueue) {
        expect(
          entries.find((entry) => entry.queueEntryId === 'queue_earlier_denied')
        ).toMatchObject({
          status: 'denied',
          denialReason: 'authority-denied',
        });
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    true,
    false,
  ])('terminalizes its own transient preparation failure without later dispatch, separate Core handle %s', async (separateHandle) => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turnExecutor = new RecordingTurnExecutor(coreDb, separateHandle);
    const manifest = agentManifest();
    const requestId = separateHandle
      ? '00000000-0000-4000-8000-00000000f101'
      : '00000000-0000-4000-8000-00000000f102';
    const failure = new TurnStartValidationError(
      'recovery_required',
      'The active predecessor requires recovery before replacement.',
      409
    );
    turnExecutor.prepareAgentSessionForTurn = async () => {
      throw failure;
    };
    const snapshot = createInMemoryRuntimeConfigSnapshot({
      agentManifests: [manifest],
      dataRoot: null,
      gatewayConfig: createTestGatewayConfig(),
      openKitConfig: { defaults: { defaultAgentId: manifest.id } },
      providerRegistry: localProviderRegistry(),
    });

    try {
      seedLocalSchedulerTarget(coreDb);
      await expect(
        admitTestProductTurn({
          coreDb,
          input: {
            agentId: manifest.id,
            input: 'Replace the active Worker after recovery.',
            modelId: 'openai/gpt-5.2',
            profileId: 'default',
            requestId,
            threadId: 'th_demo',
            workspaceId: 'ws_demo',
          },
          providerCredentialResolver: () => null,

          snapshot,
          store,
          triggerActor: { kind: 'user', id: 'user_local' },
          turnExecutor,
        })
      ).resolves.toMatchObject({ turn: { status: 'failed', error: { message: failure.message } } });

      const admission = listSchedulerAdmissionEntriesForWorkspace(coreDb, {
        statuses: ['admitted'],
        workspaceId: 'ws_demo',
      }).find((entry) => entry.requestId === requestId);
      expect(admission).toMatchObject({ requestId, status: 'admitted' });
      expect(executionAttempts(coreDb)).toMatchObject([
        { phase: 'closed', disposition: 'not_accepted', operation_id: null },
      ]);

      const laterExecutor = new RecordingTurnExecutor(coreDb, separateHandle);
      await expect(
        runSchedulerDispatchLoop({
          agentManifests: [manifest],
          coreDb,
          createAgentSessionId: () => 'as_cancelled_followup',
          createAttemptId: () => 'lease_cancelled_followup',

          gatewayConfig: createTestGatewayConfig(),

          maxDispatches: 1,
          providerRegistry: localProviderRegistry(),

          store,
          turnExecutor: laterExecutor,
        })
      ).resolves.toEqual({
        startedTurns: [],
        terminalResult: { status: 'queued', reason: 'no-queued-entry' },
      });
      expect(laterExecutor.prepareCalls).toEqual([]);
      expect(laterExecutor.calls).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each(
    [true, false].flatMap((separateHandle) =>
      (['denied'] as const).map((outcome) => ({ separateHandle, outcome }))
    )
  )('preserves accepted work after its own authority revocation, separate Core handle $separateHandle', async ({
    separateHandle,
  }) => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turnExecutor = new RecordingTurnExecutor(coreDb, separateHandle);
    const manifest = agentManifest();
    const prepare = turnExecutor.prepareAgentSessionForTurn.bind(turnExecutor);
    turnExecutor.prepareAgentSessionForTurn = async (ownerStore, preparation) => {
      const prepared = await prepare(ownerStore, preparation);
      coreDb.sqlite
        .prepare("UPDATE users SET status = 'disabled', disabled_at = ? WHERE id = 'user_local'")
        .run(Date.now());
      return prepared;
    };
    try {
      seedLocalSchedulerTarget(coreDb);
      await expect(
        admitTestProductTurn({
          coreDb,
          input: {
            agentId: manifest.id,
            input: 'Own optional cancellation',
            requestId: '00000000-0000-4000-8000-00000000f128',
            threadId: 'th_demo',
            workspaceId: 'ws_demo',
          },
          providerCredentialResolver: () => null,

          snapshot: createInMemoryRuntimeConfigSnapshot({
            agentManifests: [manifest],
            dataRoot: null,
            gatewayConfig: createTestGatewayConfig(),
            providerRegistry: localProviderRegistry(),
          }),
          store,
          triggerActor: { kind: 'user', id: 'user_local' },
          turnExecutor,
        })
      ).resolves.toMatchObject({
        turn: { status: 'failed', error: { message: 'Workspace access denied.' } },
      });
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          statuses: ['admitted'],
          workspaceId: 'ws_demo',
        })
      ).toMatchObject([
        {
          status: 'admitted',
        },
      ]);

      expect(turnExecutor.calls).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('preserves its own transient failure when admission cancellation races', async () => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turnExecutor = new RecordingTurnExecutor(coreDb);
    const manifest = agentManifest();
    const failure = new Error('Own transient preparation failure');
    turnExecutor.prepareAgentSessionForTurn = async () => {
      throw failure;
    };
    const cancel = vi
      .spyOn(schedulerRecords, 'cancelSchedulerAdmissionEntry')
      .mockImplementation(() => {
        throw new Error('Concurrent cancellation conflict');
      });
    try {
      seedLocalSchedulerTarget(coreDb);
      await expect(
        admitTestProductTurn({
          coreDb,
          input: {
            agentId: manifest.id,
            input: 'Own cleanup race',
            requestId: '00000000-0000-4000-8000-00000000f129',
            threadId: 'th_demo',
            workspaceId: 'ws_demo',
          },
          providerCredentialResolver: () => null,

          snapshot: createInMemoryRuntimeConfigSnapshot({
            agentManifests: [manifest],
            dataRoot: null,
            gatewayConfig: createTestGatewayConfig(),
            providerRegistry: localProviderRegistry(),
          }),
          store,
          triggerActor: { kind: 'user', id: 'user_local' },
          turnExecutor,
        })
      ).resolves.toMatchObject({ turn: { status: 'failed', error: { message: failure.message } } });
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      cancel.mockRestore();
      coreDb.sqlite.close();
    }
  });

  it('selects the dequeued Workspace context instead of the initiating request context', async () => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const queuedWorkspace = store.createWorkspace('Queued Workspace');
    const queuedThread = store.createThread(queuedWorkspace.id, 'Queued Thread');
    const turnExecutor = new RecordingTurnExecutor(coreDb);
    const queuedCommit = '0123456789abcdef0123456789abcdef01234567';
    const initiatingCommit = '89abcdef0123456789abcdef0123456789abcdef';
    const queuedUrl = 'https://git.example.test/queued.git';
    const manifest = {
      ...createTestAgentSetup({ mcpIds: ['echo'] }).manifest,
      workspace: {
        inputs: [{ access: 'read-write' as const, id: 'repo_remote', sourceRef: 'main-repo' }],
      },
    };
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: queuedWorkspace.id,
    });
    seedLocalSchedulerTarget(coreDb);
    publishTestAdmission(
      store,
      createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        profileRef: null,
        queueEntryId: 'queue_older_workspace',
        requestId: 'queue_older_workspace',
        requestedAgentId: manifest.id,
        threadId: queuedThread.id,
        turnId: 'turn_older_workspace',
        turnInput: 'Use the queued Workspace catalog',
        triggerActor: { kind: 'user', id: 'user_local' },
        workspaceCwd: '/workspace/queued',
        workspaceId: queuedWorkspace.id,
        workspaceRoots: [
          {
            access: 'read-write',
            id: 'repo_remote',
            sourceCommit: queuedCommit,
            sourceKind: 'remote-git',
            workerPath: '/workspace/queued',
          },
        ],
        now: () => '2026-07-05T00:00:00.000Z',
      })
    );
    const snapshot = createInMemoryRuntimeConfigSnapshot({
      agentManifests: [manifest],
      dataRoot: null,
      gatewayConfig: createTestGatewayConfig(),
      openKitConfig: { defaults: { defaultAgentId: manifest.id } },
      providerRegistry: localProviderRegistry(),
      workspaceDataSourceCatalogs: [
        {
          catalog: dataSourceCatalog(queuedUrl, queuedCommit),
          path: `workspaces/${queuedWorkspace.id}/config/data-sources.jsonc`,
          workspaceId: queuedWorkspace.id,
        },
        {
          catalog: dataSourceCatalog('https://git.example.test/initiating.git', initiatingCommit),
          path: 'workspaces/ws_demo/config/data-sources.jsonc',
          workspaceId: 'ws_demo',
        },
      ],
      workspaceMcpServerCatalogs: [
        {
          catalog: mcpCatalog('queued-tool'),
          path: `workspaces/${queuedWorkspace.id}/catalog/catalog.json`,
          workspaceId: queuedWorkspace.id,
        },
        {
          catalog: mcpCatalog('initiating-tool'),
          path: 'workspaces/ws_demo/catalog/catalog.json',
          workspaceId: 'ws_demo',
        },
      ],
    });

    try {
      await expect(
        admitTestProductTurn({
          coreDb,
          input: {
            input: 'Initiate another Workspace turn',
            requestId: '0190f4c8-0000-7000-8000-000000000215',
            threadId: 'th_demo',
            workspaceId: 'ws_demo',
          },
          providerCredentialResolver: () => null,

          snapshot,
          store,
          triggerActor: { kind: 'user', id: 'user_local' },
          turnExecutor,
        })
      ).resolves.toBeDefined();

      expect(turnExecutor.calls[0]).toMatchObject({ turnId: 'turn_older_workspace' });
      expect(
        turnExecutor.calls[0]?.context?.workspaceMcpServerCatalog?.servers[0]?.allowedTools
      ).toEqual(['queued-tool']);
      expect(turnExecutor.calls[0]?.context).toMatchObject({
        workspaceCwd: '/workspace/queued',
        workspaceDataSourceCatalog: {
          sources: [{ locator: { commit: queuedCommit, url: queuedUrl } }],
        },
        workspaceRoots: [
          {
            id: 'repo_remote',
            sourceCommit: queuedCommit,
            sourceKind: 'remote-git',
            workerPath: '/workspace/queued',
          },
        ],
        workspaceSourceRefs: { repo_remote: 'main-repo' },
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    'membership',
    'server-admin-token',
  ] as const)('denies a queued admission after its %s authority is revoked', async (authorityKind) => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turnExecutor = new RecordingTurnExecutor(coreDb);
    const timestamp = '2026-07-19T00:00:00.000Z';
    const now = Date.parse(timestamp);

    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO users (
            id, display_name, email, email_verified, created_at, updated_at, kind
          ) VALUES ('user_revoked_dispatch', 'Revoked Dispatch', 'revoked-dispatch@example.com', false, ?, ?, 'human')`
        )
        .run(now, now);
      if (authorityKind === 'membership') {
        coreDb.sqlite
          .prepare(
            `INSERT INTO workspace_members (
              workspace_id, user_id, status, access_level, invitation_id,
              joined_at, removed_at, revision, created_at, updated_at
            ) VALUES ('ws_demo', 'user_revoked_dispatch', 'active', 'editor', NULL, ?, NULL, 1, ?, ?)`
          )
          .run(timestamp, timestamp, timestamp);
      } else {
        createOpenKitAccessTokenRecord(coreDb, {
          expiresAt: '2099-01-01T00:00:00.000Z',
          ownerUserId: 'user_revoked_dispatch',
          scope: 'server-admin',
          tokenId: 'token_revoked_dispatch',
          workspaceIds: [],
        });
      }
      seedLocalSchedulerTarget(coreDb);
      publishTestAdmission(
        store,
        createSchedulerAdmissionEntry(coreDb, {
          backendId: 'nanohost',
          triggerActor: { kind: 'user', id: 'user_revoked_dispatch' },
          queueEntryId: 'queue_revoked_dispatch',
          requestId: 'req_revoked_dispatch',
          serverAdminTokenId:
            authorityKind === 'server-admin-token' ? 'token_revoked_dispatch' : null,
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_revoked_dispatch',
          turnInput: 'Do not launch this stale admission',
          requestedAgentId: 'agent_codex_host',
          profileRef: null,
        })
      );
      if (authorityKind === 'membership') {
        coreDb.sqlite
          .prepare(
            `UPDATE workspace_members
             SET status = 'removed', removed_at = ?, revision = revision + 1, updated_at = ?
             WHERE workspace_id = 'ws_demo' AND user_id = 'user_revoked_dispatch'`
          )
          .run(timestamp, timestamp);
      } else {
        coreDb.sqlite
          .prepare(
            "UPDATE openkit_access_tokens SET status = 'revoked', revoked_at = ? WHERE token_id = ?"
          )
          .run(timestamp, 'token_revoked_dispatch');
      }

      const result = await runSchedulerDispatchLoop({
        gatewayConfig: createTestGatewayConfig(),
        agentManifests: [agentManifest()],
        coreDb,
        createAgentSessionId: () => 'as_revoked_dispatch',
        createAttemptId: () => 'lease_revoked_dispatch',

        maxDispatches: 1,
        providerRegistry: localProviderRegistry(),

        store,
        turnExecutor,
        executionBackend: turnExecutor.executionBackend,
      });

      expect(result.startedTurns).toEqual([]);
      expect(result.terminalResult).toMatchObject({
        status: 'denied',
        entry: { denialReason: 'authority-denied', queueEntryId: 'queue_revoked_dispatch' },
      });
      expect(turnExecutor.calls).toEqual([]);

      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          workspaceId: 'ws_demo',
          statuses: ['denied'],
        })
      ).toEqual([
        expect.objectContaining({
          denialReason: 'authority-denied',
          queueEntryId: 'queue_revoked_dispatch',
          requestId: 'req_revoked_dispatch',
          status: 'denied',
        }),
      ]);
      expect(store.getTurnById('turn_revoked_dispatch').status).toBe('pending');
      expect(executionAttempts(coreDb)).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    'prepare',
    'commit',
  ] as const)('rechecks a recorded admin token after asynchronous %s before Worker launch', async (revocationStage) => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turnExecutor = new RecordingTurnExecutor(coreDb);
    const now = Date.now();
    coreDb.sqlite
      .prepare(
        `INSERT INTO users (
            id, display_name, email, email_verified, created_at, updated_at, kind, status
          ) VALUES ('user_admin_race', 'Admin Race', 'admin-race@example.com', false, ?, ?, 'human', 'active')`
      )
      .run(now, now);
    createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: 'user_admin_race',
      scope: 'server-admin',
      tokenId: 'token_admin_race',
      workspaceIds: [],
    });
    seedLocalSchedulerTarget(coreDb);
    publishTestAdmission(
      store,
      createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        queueEntryId: 'queue_admin_race',
        requestId: 'req_admin_race',
        serverAdminTokenId: 'token_admin_race',
        triggerActor: { kind: 'user', id: 'user_admin_race' },
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_admin_race',
        turnInput: 'Do not launch after revocation',
        requestedAgentId: 'agent_codex_host',
      })
    );
    const revoke = () =>
      coreDb.sqlite
        .prepare(
          "UPDATE openkit_access_tokens SET status = 'revoked', revoked_at = ? WHERE token_id = ?"
        )
        .run(new Date().toISOString(), 'token_admin_race');
    if (revocationStage === 'prepare') {
      const original = turnExecutor.prepareAgentSessionForTurn.bind(turnExecutor);
      turnExecutor.prepareAgentSessionForTurn = async (...args) => {
        const prepared = await original(...args);
        revoke();
        return prepared;
      };
    } else {
      const original = turnExecutor.commitPreparedAgentSessionForTurn.bind(turnExecutor);
      turnExecutor.commitPreparedAgentSessionForTurn = async (...args) => {
        const committed = await original(...args);
        revoke();
        return committed;
      };
    }
    const dispatch = () =>
      runSchedulerDispatchLoop({
        gatewayConfig: createTestGatewayConfig(),
        agentManifests: [agentManifest()],
        coreDb,
        createAgentSessionId: () => 'as_admin_race',
        createAttemptId: () => 'lease_admin_race',

        maxDispatches: 1,
        providerRegistry: localProviderRegistry(),

        store,
        turnExecutor,
        executionBackend: turnExecutor.executionBackend,
      });

    try {
      await expect(dispatch()).rejects.toMatchObject({
        code: 'workspace_access_denied',
        status: 403,
      });
      expect(executionAttempts(coreDb)).toMatchObject([
        { phase: 'closed', disposition: 'not_accepted', operation_id: null },
      ]);
      expect(store.getTurnById('turn_admin_race').status).toBe('failed');
      expect(turnExecutor.calls).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    {
      expected: { status: 'queued', reason: 'thread-busy' },
      name: 'a busy Thread',
      setup: (coreDb: ReturnType<typeof createMigratedCoreDb>, store: FsStore) => {
        seedLocalSchedulerTarget(coreDb);
        publishTestAdmission(
          store,
          createSchedulerAdmissionEntry(coreDb, {
            backendId: 'nanohost',
            triggerActor: { kind: 'user', id: 'user_local' },
            queueEntryId: 'queue_replacement_blocker',
            requestId: 'req_replacement_blocker',
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            turnId: 'turn_replacement_blocker',
            turnInput: 'Hold the Thread scheduler lease',
            requestedAgentId: 'agent_codex_host',
            profileRef: null,
          })
        );
        const blocker = recordTestExecutionAttempt(coreDb, {
          entry: schedulerRecords.requireSchedulerAdmissionEntry(
            coreDb,
            'queue_replacement_blocker'
          ),
          attemptId: 'lease_replacement_blocker',
          agentSessionId: 'as_replacement_blocker',
          inputRef: 'aepsnap_lease_replacement_blocker',
          bindingRef: 'attempt-binding:lease_replacement_blocker',
          sessionCompatibilityKey: `sha256:${'b'.repeat(64)}`,
          now: () => '2026-07-05T00:00:01.000Z',
        });
        expect(blocker.phase).toBe('open');
      },
    },
  ])('keeps an incompatible current predecessor untouched before $name rejects dispatch', async ({
    expected,
    setup,
  }) => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turnExecutor = new RecordingTurnExecutor(coreDb);
    let replacementCloseEffects = 0;
    const prepareAgentSessionForTurn = turnExecutor.prepareAgentSessionForTurn.bind(turnExecutor);
    turnExecutor.prepareAgentSessionForTurn = async (ownerStore, input) => {
      const predecessorBefore = ownerStore.getAgentSession('as_replacement_predecessor');
      const prepared = await prepareAgentSessionForTurn(ownerStore, input);
      const predecessorAfter = ownerStore.getAgentSession('as_replacement_predecessor');
      if (
        isCurrentAgentSessionStatus(predecessorBefore.status) &&
        !isCurrentAgentSessionStatus(predecessorAfter.status)
      ) {
        replacementCloseEffects += 1;
      }
      return prepared;
    };

    try {
      store.createAgentSession({
        agentId: 'agent_codex_host',
        createdAt: '2026-07-05T00:00:00.000Z',
        id: 'as_replacement_predecessor',
        message: null,
        sessionCompatibilityKey: `sha256:${'a'.repeat(64)}`,
        status: 'idle',
        threadId: 'th_demo',
        updatedAt: '2026-07-05T00:00:00.000Z',
        workspaceId: 'ws_demo',
      });
      setup(coreDb, store);
      publishTestAdmission(
        store,
        createSchedulerAdmissionEntry(coreDb, {
          backendId: 'nanohost',
          triggerActor: { kind: 'user', id: 'user_local' },
          queueEntryId: 'queue_replacement_candidate',
          requestId: 'req_replacement_candidate',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_replacement_candidate',
          turnInput: 'Use incompatible future static inputs',
          requestedAgentId: 'agent_codex_host',
          profileRef: null,
        })
      );

      let observed: unknown;
      try {
        observed = await runSchedulerDispatchLoop({
          gatewayConfig: createTestGatewayConfig(),
          agentManifests: [agentManifest()],
          coreDb,
          createAgentSessionId: () => 'as_replacement_successor',
          createAttemptId: () => 'lease_replacement_candidate',

          maxDispatches: 1,
          now: () => '2026-07-05T00:00:02.000Z',
          providerRegistry: localProviderRegistry(),

          store,
          turnExecutor,
          executionBackend: turnExecutor.executionBackend,
        });
      } catch (error) {
        observed = error;
      }

      expect(observed).toMatchObject({ startedTurns: [], terminalResult: expected });
      expect(replacementCloseEffects).toBe(0);
      expect(store.getAgentSession('as_replacement_predecessor')).toMatchObject({
        stale: false,
        status: 'idle',
      });
      expect(
        store
          .listThreadAgentSessions('ws_demo', 'th_demo')
          .filter((candidate) => isCurrentAgentSessionStatus(candidate.status))
          .map((candidate) => candidate.id)
      ).toEqual(['as_replacement_predecessor']);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('starts one dispatched queued turn with scheduler-owned lineage', async () => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turnExecutor = new RecordingTurnExecutor(coreDb);

    try {
      seedLocalSchedulerTarget(coreDb);
      publishTestAdmission(
        store,
        createSchedulerAdmissionEntry(coreDb, {
          backendId: 'nanohost',
          triggerActor: { kind: 'user', id: 'user_local' },
          queueEntryId: 'queue_00000000-0000-4000-8000-00000000d201_loop_1',
          requestId: '00000000-0000-4000-8000-00000000d201',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_loop_1',
          turnInput: 'Run the scheduled worker',
          requestedAgentId: 'agent_codex_host',
          profileRef: null,
          now: () => '2026-07-05T00:00:01.000Z',
        })
      );

      const result = await runSchedulerDispatchLoop({
        gatewayConfig: createTestGatewayConfig(),
        coreDb,
        createAgentSessionId: () => 'as_loop_1',
        createAttemptId: () => 'lease_loop_1',

        maxDispatches: 1,
        now: () => '2026-07-05T00:00:02.000Z',
        providerRegistry: localProviderRegistry(),

        store,
        turnExecutor,
        executionBackend: turnExecutor.executionBackend,
        agentManifests: [agentManifest()],
      });

      expect(result.startedTurns).toHaveLength(1);
      expect(result.terminalResult).toEqual({ status: 'queued', reason: 'max-dispatches' });
      expect(result.startedTurns[0]?.handle.turn.id).toBe('turn_loop_1');
      expect(turnExecutor.calls[0]?.context?.sessionCompatibilityKey).toMatch(
        /^sha256:[a-f0-9]{64}$/
      );
      expect(store.getTurn('ws_demo', 'th_demo', 'turn_loop_1').status).toBe('running');
      const expectedSetup = createTestAgentSetup();
      // Dispatch resolves complete Provider metadata rather than forwarding an unresolved fixture.
      expectedSetup.logicalModels.allowed[0] = {
        ...expectedSetup.logicalModels.allowed[0]!,
        // This is the resolver's diagnostic contract; it is not projected into the setup ledger or the AEP.
        contract: {
          context: 400_000,
          output: 128_000,
          inputModalities: ['text', 'image'],
          reasoning: true,
        },
        modelParameters: {
          contextWindow: 400_000,
          inputModalities: ['text', 'image'],
          maxOutputTokens: 128_000,
          reasoning: true,
        },
        reasoningEffortLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
      };
      expect(turnExecutor.calls).toEqual([
        {
          context: {
            agentSessionId: 'as_loop_1',
            agentSetup: expectedSetup,
            requestId: '00000000-0000-4000-8000-00000000d201',
            attemptId: 'lease_loop_1',
            onSubmissionSettled: expect.any(Function),
            sessionCompatibilityKey: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
            triggerActor: { kind: 'user', id: 'user_local' },
            workspaceCwd: null,
            workspaceRoots: [],
          },
          input: 'Run the scheduled worker',
          turnId: 'turn_loop_1',
        },
      ]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('prepares and starts a later dispatchable queued entry when the first queued Thread is busy', async () => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turnExecutor = new RecordingTurnExecutor(coreDb);
    const laterThread = store.createThread('ws_demo', 'Later dispatchable thread');

    try {
      seedLocalSchedulerTarget(coreDb);
      publishTestAdmission(
        store,
        createSchedulerAdmissionEntry(coreDb, {
          backendId: 'nanohost',
          triggerActor: { kind: 'user', id: 'user_local' },
          queueEntryId: 'queue_busy_active',
          requestId: 'req_busy_active',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_busy_active',
          turnInput: 'Hold the first Thread lease',
          requestedAgentId: 'agent_codex_host',
          profileRef: null,
          now: () => '2026-07-05T00:00:00.000Z',
        })
      );
      const blocker = recordTestExecutionAttempt(coreDb, {
        entry: schedulerRecords.requireSchedulerAdmissionEntry(coreDb, 'queue_busy_active'),
        attemptId: 'lease_busy_active',
        agentSessionId: 'as_busy_active',
        inputRef: 'aepsnap_lease_busy_active',
        bindingRef: 'attempt-binding:lease_busy_active',
        sessionCompatibilityKey: `sha256:${'b'.repeat(64)}`,
        now: () => '2026-07-05T00:00:01.000Z',
      });
      expect(blocker.phase).toBe('open');
      publishTestAdmission(
        store,
        createSchedulerAdmissionEntry(coreDb, {
          backendId: 'nanohost',
          triggerActor: { kind: 'user', id: 'user_local' },
          queueEntryId: 'queue_busy_followup',
          requestId: 'req_busy_followup',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_busy_followup',
          turnInput: 'Stay queued while the Thread is busy',
          requestedAgentId: 'agent_codex_host',
          profileRef: null,
          now: () => '2026-07-05T00:00:02.000Z',
        })
      );
      publishTestAdmission(
        store,
        createSchedulerAdmissionEntry(coreDb, {
          backendId: 'nanohost',
          triggerActor: { kind: 'user', id: 'user_local' },
          queueEntryId: 'queue_later_dispatchable',
          requestId: 'req_later_dispatchable',
          workspaceId: 'ws_demo',
          threadId: laterThread.id,
          turnId: 'turn_later_dispatchable',
          turnInput: 'Start the later dispatchable Thread',
          requestedAgentId: 'agent_codex_host',
          profileRef: null,
          now: () => '2026-07-05T00:00:03.000Z',
        })
      );
      expect(
        listQueuedSchedulerAdmissionEntries(coreDb).map((entry) => entry.queueEntryId)
      ).toEqual(['queue_busy_followup', 'queue_later_dispatchable']);

      const result = await runSchedulerDispatchLoop({
        gatewayConfig: createTestGatewayConfig(),
        agentManifests: [agentManifest()],
        coreDb,
        createAgentSessionId: () => 'as_later_dispatchable',
        createAttemptId: () => 'lease_later_dispatchable',

        maxDispatches: 1,
        now: () => '2026-07-05T00:00:04.000Z',
        providerRegistry: localProviderRegistry(),

        store,
        turnExecutor,
        executionBackend: turnExecutor.executionBackend,
      });

      expect(result.startedTurns).toHaveLength(1);
      expect(result.startedTurns[0]?.handle.turn.id).toBe('turn_later_dispatchable');
      expect(result.startedTurns[0]?.dispatch.entry.queueEntryId).toBe('queue_later_dispatchable');
      expect(result.startedTurns[0]?.dispatch.entry.threadId).toBe(laterThread.id);
      expect(turnExecutor.prepareCalls).toEqual([
        { threadId: laterThread.id, turnId: 'turn_later_dispatchable' },
      ]);
      expect(turnExecutor.calls).toEqual([
        expect.objectContaining({
          input: 'Start the later dispatchable Thread',
          turnId: 'turn_later_dispatchable',
        }),
      ]);
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          statuses: ['queued'],
          workspaceId: 'ws_demo',
        }).map((entry) => entry.queueEntryId)
      ).toEqual(['queue_busy_followup']);
      expect(['open', 'closing']).toContain(
        executionAttempts(coreDb).find((attempt) => attempt.attempt_id === 'lease_busy_active')
          ?.phase
      );
      expect(['open', 'closing']).toContain(
        executionAttempts(coreDb).find(
          (attempt) => attempt.attempt_id === 'lease_later_dispatchable'
        )?.phase
      );
      expect(
        executionAttempts(coreDb).find(
          (attempt) => attempt.attempt_id === 'lease_later_dispatchable'
        )
      ).toMatchObject({ thread_id: laterThread.id, turn_id: 'turn_later_dispatchable' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('closes or revokes the acquired attempt when post-dispatch AgentSession commit rejects', async () => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turnExecutor = new RecordingTurnExecutor(coreDb);
    turnExecutor.commitPreparedAgentSessionForTurn = async () => {
      throw new Error('prepared AgentSession changed');
    };

    try {
      seedLocalSchedulerTarget(coreDb);
      publishTestAdmission(
        store,
        createSchedulerAdmissionEntry(coreDb, {
          backendId: 'nanohost',
          profileRef: null,
          queueEntryId: 'queue_commit_failed',
          requestId: 'req_commit_failed',
          requestedAgentId: 'agent_codex_host',
          threadId: 'th_demo',
          turnId: 'turn_commit_failed',
          turnInput: 'Reject after scheduler dispatch',
          triggerActor: { kind: 'user', id: 'user_local' },
          workspaceId: 'ws_demo',
        })
      );

      await expect(
        runSchedulerDispatchLoop({
          gatewayConfig: createTestGatewayConfig(),
          agentManifests: [agentManifest()],
          coreDb,
          createAgentSessionId: () => 'as_commit_failed',
          createAttemptId: () => 'lease_commit_failed',

          maxDispatches: 1,
          providerRegistry: localProviderRegistry(),

          store,
          turnExecutor,
          executionBackend: turnExecutor.executionBackend,
        })
      ).rejects.toThrow('prepared AgentSession changed');

      expect(
        executionAttempts(coreDb).find((attempt) => attempt.attempt_id === 'lease_commit_failed')
          ?.phase
      ).toBe('closed');
      expect(turnExecutor.calls).toEqual([]);
      expect(store.getTurnById('turn_commit_failed')).toMatchObject({
        status: 'failed',
        error: { message: 'prepared AgentSession changed' },
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('reuses the exact compatible current AgentSession selected by the runtime seam', async () => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turnExecutor = new RecordingTurnExecutor(coreDb);

    try {
      seedLocalSchedulerTarget(coreDb);
      publishTestAdmission(
        store,
        createSchedulerAdmissionEntry(coreDb, {
          backendId: 'nanohost',
          triggerActor: { kind: 'user', id: 'user_local' },
          queueEntryId: 'queue_continuity_live',
          requestId: 'req_continuity_live',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_continuity_live',
          turnInput: 'Run with continuity',
          requestedAgentId: 'agent_codex_host',
          profileRef: null,
          now: () => '2026-07-05T00:00:01.000Z',
        })
      );

      const setup = createTestAgentSetup();
      const sessionCompatibilityKey = resolveAgentSessionCompatibilityKey({
        agentSessionId: 'as_live_continuity',
        agentSetup: setup,
        backend: { kind: 'openshell' },
        requestId: 'req_continuity_live',
        turn: {
          completedAt: null,
          configVersion: null,
          durationMs: null,
          error: null,
          id: 'turn_continuity_live',
          items: [],
          startedAt: '2026-07-05T00:00:02.000Z',
          status: 'running',
          threadId: 'th_demo',
          triggerActor: { kind: 'user', id: 'user_local' },
          workspaceId: 'ws_demo',
        },
        turnInput: 'Run with continuity',
        triggerActor: { kind: 'user', id: 'user_local' },
        workspaceCwd: null,
        workspaceRoots: [],
      });
      store.createAgentSession({
        agentId: 'agent_codex_host',
        createdAt: '2026-07-05T00:00:00.000Z',
        id: 'as_live_continuity',
        message: null,
        sessionCompatibilityKey,
        status: 'idle',
        threadId: 'th_demo',
        updatedAt: '2026-07-05T00:00:00.000Z',
        workspaceId: 'ws_demo',
      });

      const result = await runSchedulerDispatchLoop({
        gatewayConfig: createTestGatewayConfig(),
        agentManifests: [setup.manifest],
        coreDb,
        createAgentSessionId: () => 'as_fresh_continuity',
        createAttemptId: () => 'lease_continuity_live',

        maxDispatches: 1,
        now: () => '2026-07-05T00:00:02.000Z',
        providerRegistry: localProviderRegistry(),

        store,
        turnExecutor,
        executionBackend: turnExecutor.executionBackend,
      });

      expect(result.startedTurns).toHaveLength(1);
      expect(
        executionAttempts(coreDb).find((attempt) => attempt.attempt_id === 'lease_continuity_live')
      ).toMatchObject({ agent_session_id: 'as_live_continuity' });
      expect(store.getAgentSession('as_live_continuity').sessionCompatibilityKey).toBe(
        sessionCompatibilityKey
      );
      expect(turnExecutor.calls[0]?.context).toMatchObject({
        agentSessionId: 'as_live_continuity',
        agentSetup: setup,
        attemptId: 'lease_continuity_live',
        sessionCompatibilityKey,
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('reuses the current compatible AgentSession across sequential product admissions', async () => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turnExecutor = new RecordingTurnExecutor(coreDb);
    const providerRegistry = localProviderRegistry();
    const snapshot = createInMemoryRuntimeConfigSnapshot({
      agentManifests: [agentManifest()],
      gatewayConfig: createTestGatewayConfig(),
      providerRegistry,
      version: 1,
    });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-product-continuity-repo-'));
    execFileSync('git', ['init'], { cwd: repositoryPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'openkit@example.invalid'], {
      cwd: repositoryPath,
    });
    execFileSync('git', ['config', 'user.name', 'OpenKit'], { cwd: repositoryPath });
    writeFileSync(join(repositoryPath, 'README.md'), '# Product continuity fixture\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repositoryPath });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repositoryPath, stdio: 'ignore' });
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    try {
      applyScopedMigrations(workspaceDb);
    } finally {
      workspaceDb.sqlite.close();
    }
    const recordingStartTurn = turnExecutor.startTurn.bind(turnExecutor);
    turnExecutor.startTurn = async (ownerStore, turnId, turnInput, context) => {
      await recordingStartTurn(ownerStore, turnId, turnInput, context);
      const agentSessionId = context?.agentSessionId;
      if (!agentSessionId) {
        throw new Error('Product admission did not assign an AgentSession.');
      }
      if (!context.sessionCompatibilityKey) {
        throw new Error('Product admission did not retain its SessionCompatibilityKey.');
      }
      const turn = ownerStore.getTurnById(turnId);
      const existing = ownerStore
        .listThreadAgentSessions(turn.workspaceId, turn.threadId)
        .find((candidate) => candidate.id === agentSessionId);
      if (!existing) {
        ownerStore.createAgentSession({
          agentId: 'agent_codex_host',
          createdAt: '2026-07-05T00:00:02.000Z',
          id: agentSessionId,
          message: null,
          sessionCompatibilityKey: context.sessionCompatibilityKey,
          status: 'idle',
          threadId: turn.threadId,
          updatedAt: '2026-07-05T00:00:02.000Z',
          workspaceId: turn.workspaceId,
        });
      }
      ownerStore.updateTurn(turnId, {
        agentSessionId,
        completedAt: '2026-07-05T00:00:03.000Z',
        status: 'completed',
      });
    };

    try {
      const first = await admitTestProductTurn({
        coreDb,
        input: {
          agentId: 'agent_codex_host',
          input: 'Run the first sequential Turn',
          modelId: 'openai/gpt-5.2',
          profileId: 'default',
          requestId: '00000000-0000-4000-8000-00000000d211',
          threadId: 'th_demo',
          workspaceId: 'ws_demo',
        },
        providerCredentialResolver: () => null,

        snapshot,
        store,
        triggerActor: { kind: 'user', id: 'user_local' },
        turnExecutor,
      });
      const firstLease = coreDb.sqlite
        .prepare('SELECT attempt_id AS leaseId FROM scheduler_execution_attempts WHERE turn_id = ?')
        .get(first.turn.id) as { leaseId: string };
      await closeOwnedExecutionAttempt(coreDb, store, {
        attemptId: firstLease.leaseId,
        firstTerminalCause: 'turn-completed',
      });

      const second = await admitTestProductTurn({
        coreDb,
        input: {
          agentId: 'agent_codex_host',
          input: 'Run the second sequential Turn',
          requestId: '00000000-0000-4000-8000-00000000d212',
          threadId: 'th_demo',
          workspaceId: 'ws_demo',
        },
        providerCredentialResolver: () => null,

        snapshot,
        store,
        triggerActor: { kind: 'user', id: 'user_local' },
        turnExecutor,
      });
      const attempts = executionAttempts(coreDb).filter((attempt) =>
        [first.turn.id, second.turn.id].includes(String(attempt.turn_id))
      );

      expect(second.turn.id).not.toBe(first.turn.id);
      expect(second.turn.agentSessionId).toBe(first.turn.agentSessionId);
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          workspaceId: 'ws_demo',
          statuses: ['queued', 'admitted', 'denied'],
        }).find((entry) => entry.requestId === '00000000-0000-4000-8000-00000000d211')
      ).toMatchObject({
        modelId: 'openai/gpt-5.2',
        profileRef: 'default',
        requestedAgentId: 'agent_codex_host',
      });
      expect(turnExecutor.calls[0]?.context?.agentSetup).toMatchObject({
        profileId: 'default',
        logicalModels: { preferredLogicalModelId: 'openai/gpt-5.2' },
      });
      expect(attempts).toHaveLength(2);
      expect(new Set(attempts.map((attempt) => attempt.attempt_id)).size).toBe(2);
      expect(new Set(attempts.map((attempt) => attempt.turn_id)).size).toBe(2);
      expect(new Set(attempts.map((attempt) => attempt.agent_session_id))).toEqual(
        new Set([first.turn.agentSessionId])
      );
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records resolved setup lineage for scheduler-dispatched authored agents', async () => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turnExecutor = new RecordingTurnExecutor(coreDb);

    try {
      seedLocalSchedulerTarget(coreDb);
      publishTestAdmission(
        store,
        createSchedulerAdmissionEntry(coreDb, {
          backendId: 'nanohost',
          triggerActor: { kind: 'user', id: 'user_local' },
          queueEntryId: 'queue_setup_ledger',
          requestId: 'req_setup_ledger',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_setup_ledger',
          turnInput: 'Run the scheduled worker',
          requestedAgentId: 'agent_codex_host',
          profileRef: null,
          now: () => '2026-07-05T00:00:01.000Z',
        })
      );

      const result = await runSchedulerDispatchLoop({
        gatewayConfig: createTestGatewayConfig(),
        coreDb,
        createAgentSessionId: () => 'as_setup_ledger',
        createAttemptId: () => 'lease_setup_ledger',

        dependencies: { providerCredentialResolver: () => 'test-key' },

        maxDispatches: 1,
        now: () => '2026-07-05T00:00:02.000Z',
        providerRegistry: localProviderRegistry(),

        store,
        turnExecutor,
        executionBackend: turnExecutor.executionBackend,
        agentManifests: [agentManifest()],
      });
      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');

      try {
        applyScopedMigrations(workspaceDb);
        expect(result.startedTurns[0]?.handle.agentSetupRecordId).toBe('ras_turn_setup_ledger');
        expect(
          requireResolvedAgentSetup(workspaceDb, 'ws_demo', 'ras_turn_setup_ledger')
        ).toMatchObject({
          turnId: 'turn_setup_ledger',
          requestId: 'req_setup_ledger',
          agentId: 'agent_codex_host',
          logicalModelId: 'openai/gpt-5.2',
        });
        expect(turnExecutor.calls[0]?.context?.agentSetup?.manifest).toEqual(agentManifest());
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('closes or revokes the acquired attempt when turn startup fails', async () => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turnExecutor = new FailingTurnExecutor(coreDb);

    try {
      seedLocalSchedulerTarget(coreDb);
      publishTestAdmission(
        store,
        createSchedulerAdmissionEntry(coreDb, {
          backendId: 'nanohost',
          triggerActor: { kind: 'user', id: 'user_local' },
          queueEntryId: 'queue_loop_failed',
          requestId: 'queue_loop_failed',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_loop_failed',
          turnInput: 'Fail the scheduled worker',
          requestedAgentId: 'agent_codex_host',
          profileRef: null,
          now: () => '2026-07-05T00:00:01.000Z',
        })
      );

      await expect(
        runSchedulerDispatchLoop({
          gatewayConfig: createTestGatewayConfig(),
          coreDb,
          createAgentSessionId: () => 'as_loop_failed',
          createAttemptId: () => 'lease_loop_failed',

          maxDispatches: 1,
          now: () => '2026-07-05T00:00:02.000Z',
          providerRegistry: localProviderRegistry(),

          store,
          turnExecutor,
          executionBackend: turnExecutor.executionBackend,
          agentManifests: [agentManifest()],
        })
      ).rejects.toThrow('worker launch failed');

      expect(
        resolveNanoHostAttemptTokenBinding(coreDb, {
          sandboxBindingRef: 'attempt-binding:lease_loop_failed',
          lineage: {
            agentSessionId: 'as_loop_failed',
            packageSnapshotId: 'aepsnap_turn_loop_failed_as_loop_failed',
            threadId: 'th_demo',
            turnId: 'turn_loop_failed',
            workspaceId: 'ws_demo',
          },
        })
      ).toEqual({ status: 'rejected', reason: 'attempt-not-live' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('preserves the worker failure while anchored backend cleanup remains pending', async () => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turnExecutor = new RecordingTurnExecutor(coreDb);
    turnExecutor.startTurn = async (ownerStore, turnId, _input, context) => {
      const lease = attemptRecords.recordSchedulerExecutionOperation(coreDb, {
        attemptId: 'lease_cleanup_pending',
        operationId: 'cleanup-pending:original',
        submission: true,
      });
      if (!context?.agentSessionId) {
        throw new Error('Expected scheduler-owned AgentSession lineage.');
      }
      const target = seedBackendRuntimeTarget(coreDb);
      recordWorkerBackendSessionMaterializing(coreDb, {
        backendLineage: { imageRef: 'openkit/worker-codex:dev', kind: 'reference' },
        backendVersion: '0.0.99',
        identity: {
          agentSessionId: context.agentSessionId,
          backendKind: 'openshell',
          backendSessionId: 'openkit-as_cleanup_pending',
          deploymentId: target.deploymentId,
          packageSnapshotId: lease.inputRef,
          runtimeTargetId: target.targetId,
          stagingDirectoryRef: 'server/runtime/worker-backend-sessions/cleanup-pending',
          transientProviderInstanceId: null,
        },
        lineage: { threadId: 'th_demo', turnId, workspaceId: 'ws_demo' },
        sandboxBindingRef: lease.bindingRef,
      });
      for (const [fromState, toState] of [
        ['materializing', 'materialized'],
        ['materialized', 'launching'],
        ['launching', 'cleanup-pending'],
      ] as const) {
        transitionWorkerBackendSessionState(coreDb, {
          fromState,
          attemptId: lease.attemptId,
          toState,
        });
      }
      ownerStore.updateTurn(turnId, {
        completedAt: '2026-07-05T00:00:03.000Z',
        error: { code: 'worker_governance_turn_failed', message: 'accepted effect is unknown' },
        status: 'failed',
      });
      throw new Error('accepted effect is unknown');
    };

    try {
      seedLocalSchedulerTarget(coreDb);
      publishTestAdmission(
        store,
        createSchedulerAdmissionEntry(coreDb, {
          backendId: 'nanohost',
          profileRef: null,
          queueEntryId: 'queue_cleanup_pending',
          requestId: 'req_cleanup_pending',
          requestedAgentId: 'agent_codex_host',
          threadId: 'th_demo',
          turnId: 'turn_cleanup_pending',
          turnInput: 'Fail with backend cleanup pending',
          triggerActor: { kind: 'user', id: 'user_local' },
          workspaceId: 'ws_demo',
        })
      );

      await expect(
        runSchedulerDispatchLoop({
          gatewayConfig: createTestGatewayConfig(),
          agentManifests: [agentManifest()],
          coreDb,
          createAgentSessionId: () => 'as_cleanup_pending',
          createAttemptId: () => 'lease_cleanup_pending',

          maxDispatches: 1,
          providerRegistry: localProviderRegistry(),

          store,
          turnExecutor,
          executionBackend: turnExecutor.executionBackend,
        })
      ).rejects.toThrow('accepted effect is unknown');

      expect(['open', 'closing']).toContain(
        executionAttempts(coreDb).find((attempt) => attempt.attempt_id === 'lease_cleanup_pending')
          ?.phase
      );
      expect(
        (
          coreDb.sqlite
            .prepare('SELECT state FROM worker_backend_sessions WHERE attempt_id = ?')
            .get('lease_cleanup_pending') as { state: string }
        ).state
      ).toBe('cleanup-pending');
    } finally {
      coreDb.sqlite.close();
    }
  });
});

/** Creates one enabled credential-free MCP catalog for scheduler ownership tests. */
function mcpCatalog(tool: string) {
  return {
    schemaVersion: 1 as const,
    servers: [
      {
        allowedTools: [tool],
        approvalRequiredTools: [],
        credentialBindings: [],
        deniedTools: [],
        enabled: true,
        id: 'echo',
        pinnedSchemaSnapshotId: null,
        schemaPolicy: 'tracking' as const,
        timeoutMs: 60_000,
        transport: { args: [], command: 'node', environment: {}, kind: 'stdio' as const },
      },
    ],
  };
}

/** Creates one credential-free remote Git catalog for scheduler ownership tests. */
function dataSourceCatalog(url: string, commit: string): WorkspaceDataSourceCatalog {
  return {
    extensions: {},
    requiredFeatures: [],
    schemaVersion: 1,
    sources: [
      {
        access: 'read-write',
        allowedSlotKinds: ['worktree'],
        displayName: 'Remote repository',
        extensions: {},
        id: 'main-repo',
        kind: 'git',
        locator: { commit, url },
        requiredFeatures: [],
        sensitivity: 'internal',
        status: 'active',
        syncHints: {},
      },
    ],
  };
}

/** Calls the current attempt owner at the deciding action; the private API spelling is an adaptable test seam. */
async function closeOwnedExecutionAttempt(
  db: ReturnType<typeof openCoreDb>,
  store: FsStore,
  input: {
    readonly attemptId: string;
    readonly firstTerminalCause: string;
    readonly now?: () => string;
  }
) {
  const held = attemptRecords.requireSchedulerExecutionAttempt(db, input.attemptId);
  const turn = store.getTurnById(held.turnId);
  const terminal =
    turn.status === 'completed'
      ? turn
      : store.updateTurn(turn.id, {
          status: 'completed',
          completedAt: input.now?.() ?? new Date().toISOString(),
        });
  store.emitTurnEvent(
    turn.id,
    {
      event: 'turn.completed',
      requestId: requireSchedulerExecutionAttemptAdmissionContext(db, held.attemptId).requestId,
      workspaceId: held.workspaceId,
      threadId: held.threadId,
      turnId: held.turnId,
      data: { type: 'turn-completed', stopReason: 'completed', turn: terminal },
    },
    ALREADY_DECIDED_PUBLICATION_ADMISSION
  );
  // This recording fixture has no physical resident, output stream, evidence producer or integration.
  // Its actual terminal product publication plus explicit modeled drains supplies the six-barrier proof.
  const current = attemptRecords.markSchedulerExecutionAttemptClosing(db, {
    attemptId: input.attemptId,
    cause: input.firstTerminalCause,
    ...(input.now ? { now: input.now } : {}),
  });
  const proof = {
    terminalHandoff: true,
    output: true,
    evidence: true,
    outsideWorkspaceCollection: true,
    integrationDrain: true,
    routesRevoked: true,
  } as const;
  const correlation = attemptRecords.schedulerExecutionCorrelation(current);
  const released = await new SimulatedTurnExecutor({ coreDb: db }).release({
    ...correlation,
    proof,
  });
  return attemptRecords.closeSchedulerExecutionAttemptWithFence(db, {
    correlation,
    proof,
    fenceRef: released.fenceRef!,
  });
}

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceDataSourceCatalog } from '@openkit/config-schema';
import { describe, expect, it, vi } from 'vitest';
import { requireResolvedAgentSetup } from '../agents/setup-ledger';
import { asCommandError } from '../api-errors.js';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { ensureLocalUser } from '../auth/identity.js';
import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import type { FsStore } from '../lib/store';
import { ProviderRegistry } from '../providers/registry';
import {
  cancelSchedulerAdmissionEntry,
  completeSchedulerSessionLease,
  createSchedulerAdmissionEntry,
  dispatchNextSchedulerEntry,
  listQueuedSchedulerAdmissionEntries,
  listSchedulerAdmissionEntriesForWorkspace,
  requireSchedulerSessionLease,
  resolveSchedulerLeaseTokenBinding,
  upsertSchedulerCapacityRecord,
  upsertSchedulerTargetHealthRecord,
  upsertSchedulerWorkerPool,
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
import { resolveAgentSessionCompatibilityKey } from '../test-support/prepared-agent-environment.js';
import { upsertWorkspaceRepositoryResource } from '../workspace/repository-store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { DeterministicAgentPreparationError } from './agent-preparation-error.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  getNanoHostRuntimeTarget,
  upsertNanoHostRuntimeTarget,
} from './nanohost-runtime-target.js';
import { TurnStartValidationError } from './orchestrator';
import { startProductTurn } from './product-turn-start.js';
import { getSchedulerPreparationClaims, runSchedulerDispatchLoop } from './scheduler-dispatch-loop';
import { startSchedulerDispatchRetryService } from './scheduler-dispatch-service.js';
import type {
  CommitPreparedAgentSessionForTurnInput,
  PrepareAgentSessionForTurnInput,
  PreparedAgentSessionForTurn,
  PreparedCurrentAgentSession,
  TurnExecutor,
  TurnStartRuntimeContext,
} from './types';
import {
  recordWorkerBackendSessionMaterializing,
  transitionWorkerBackendSessionState,
} from './worker-backend-sessions';
import { WorkerGovernanceCapacityUnavailableError } from './worker-governance-backend.js';

class RecordingTurnExecutor implements TurnExecutor {
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
  ): Promise<void> {
    if (!input.prepared.replacementRequired) {
      return;
    }
    const predecessor = input.prepared.currentAgentSession;
    if (!predecessor) {
      throw new Error('Prepared replacement has no predecessor.');
    }
    const current = store.getAgentSession(predecessor.id);
    if (current.status !== 'idle' || current.stale || current.updatedAt !== predecessor.updatedAt) {
      throw new Error('Prepared predecessor changed before commit.');
    }
    store.updateAgentSession(current.id, {
      status: 'closed',
      updatedAt: '2026-07-05T00:00:01.500Z',
    });
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
  }

  /**
   * No-op interrupt implementation.
   */
  public async interruptTurn(): Promise<void> {}
}

/** Seeds the current physical Epoch required by backend-anchor fixtures. */
function seedBackendRuntimeTarget(coreDb: ReturnType<typeof createMigratedCoreDb>): void {
  if (getNanoHostRuntimeTarget(coreDb, 'runtime-target-test')) return;
  const allocated = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
    deploymentId: 'deployment-test',
    identityId: 'identity-test',
    observedAt: '2026-07-05T00:00:00.000Z',
    targetId: 'runtime-target-test',
  });
  upsertNanoHostRuntimeTarget(coreDb, {
    ...allocated,
    freshEmpty: true,
    observedAt: '2026-07-05T00:00:01.000Z',
    physicalEpoch: 'a'.repeat(64),
    predecessorFenced: true,
    ready: true,
  });
}

class FailingTurnExecutor extends RecordingTurnExecutor {
  /**
   * Fails turn startup after recording the call.
   *
   * @param store Store passed by the dispatch loop.
   * @param turnId Turn id selected by the scheduler queue entry.
   * @param input Turn input captured in the scheduler queue entry.
   * @param context Runtime context forwarded to the worker executor.
   */
  public override async startTurn(
    store: FsStore,
    turnId: string,
    input: string,
    context?: TurnStartRuntimeContext
  ): Promise<void> {
    await super.startTurn(store, turnId, input, context);
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
  upsertSchedulerWorkerPool(coreDb, {
    poolId: 'pool_local',
    allowedBackendKinds: ['openshell'],
    allowedPlacements: ['local'],
    maxConcurrentSessions: 1,
    queueLimit: 20,
    defaultTimeoutMs: 900_000,
    allowedWorkspaceScopes: ['local'],
    budgetClass: 'interactive',
    healthSummary: 'ready',
    currentAdmittedSessionCount: 0,
    currentQueueDepth: 1,
    status: 'active',
  });
  upsertSchedulerCapacityRecord(coreDb, {
    targetId: 'target_local',
    poolId: 'pool_local',
    capacityClass: 'local',
    concurrencyCeiling: 1,
    inUseCount: 0,
    queueDepth: 0,
    observationSource: 'configured',
    observedAt: '2026-07-05T00:00:00.000Z',
  });
  upsertSchedulerTargetHealthRecord(coreDb, {
    targetId: 'target_local',
    healthState: 'healthy',
    checkResults: [],
    consecutiveFailureCount: 0,
    consecutiveSuccessCount: 1,
    lastProbeAt: '2026-07-05T00:00:00.000Z',
    nextProbeAt: '2026-07-05T00:01:00.000Z',
  });
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

describe('scheduler dispatch loop', () => {
  it.each(
    [true, false].flatMap((cancelDeferredAdmission) =>
      (
        [
          'leased',
          'transient',
          'deterministic',
          'post-lease',
          'deferred',
          'denied',
          'acquisition',
        ] as const
      ).map((outcome) => ({ cancelDeferredAdmission, outcome }))
    )
  )('shares background preparation with its own caller: $outcome, cancellation $cancelDeferredAdmission', async ({
    cancelDeferredAdmission,
    outcome,
  }) => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore();
    const executor = new RecordingTurnExecutor();
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
      await gate.promise;
      if (outcome === 'transient' || outcome === 'deterministic') throw failure;
      if (outcome === 'deferred') throw new WorkerGovernanceCapacityUnavailableError();
      const prepared = await prepare(ownerStore, preparation);
      if (outcome === 'denied') {
        coreDb.sqlite
          .prepare("UPDATE users SET status = 'disabled', disabled_at = ? WHERE id = 'user_local'")
          .run(Date.now());
      }
      return prepared;
    };
    if (outcome === 'post-lease')
      executor.startTurn = async () => {
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
      expectedControlMode: 'poll',
      expectedDataPlaneMode: 'openshell-files',
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 30_000,
      leaseDurationMs: 900_000,
      schedulerEpoch: 1,
      startupTimeoutMs: 120_000,
      intervalMs: 60_000,
      runtimeConfigSnapshot: () => snapshot,
      onError: (error) => errors.push(error),
      setInterval: () => 'test-timer',
      clearInterval: () => {},
    });
    const createAdmission = schedulerRecords.createSchedulerAdmissionEntry;
    let background: ReturnType<typeof service.runOnce> | undefined;
    // Dispatch immediately after the caller commits its own admission, before its loop selects.
    const admissionSpy = vi
      .spyOn(schedulerRecords, 'createSchedulerAdmissionEntry')
      .mockImplementation((db, input) => {
        const entry = createAdmission(db, input);
        background = service.runOnce();
        return entry;
      });
    const dispatchSpy =
      outcome === 'acquisition'
        ? vi.spyOn(schedulerRecords, 'dispatchNextSchedulerEntry').mockImplementation(() => {
            throw failure;
          })
        : undefined;
    const cancelSpy = vi.spyOn(schedulerRecords, 'cancelSchedulerAdmissionEntry');
    const onTurnCreated = vi.fn();
    const caller = startProductTurn({
      coreDb,
      store,
      turnExecutor: executor,
      snapshot,
      schedulerEpoch: 1,
      cancelDeferredAdmission,
      onTurnCreated,
      workerPlacement: 'local',
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
      await entered.promise;
      const [admission] = listQueuedSchedulerAdmissionEntries(coreDb);
      expect(admission).toBeDefined();
      expect(preparations).toBe(1);
      const before = coreDb.sqlite.prepare('SELECT total_changes() AS count').get();
      // A background overlap ends its pass; it cannot enter a second preparation or write claim state.
      const overlapPending = service.runOnce();
      expect(preparations).toBe(1);
      const overlap = await overlapPending;
      expect(overlap?.startedTurns).toEqual([]);
      expect(coreDb.sqlite.prepare('SELECT total_changes() AS count').get()).toEqual(before);
      expect(coreDb.sqlite.prepare('SELECT lease_id FROM scheduler_session_leases').all()).toEqual(
        []
      );
      gate.resolve();
      const [backgroundResult, callerResult] = await Promise.all([background, caller]);
      expect(preparations).toBe(1);
      expect(getSchedulerPreparationClaims(coreDb).size).toBe(0);
      if (outcome === 'leased') {
        expect(backgroundResult?.startedTurns).toHaveLength(1);
        expect(callerResult).toHaveProperty('handle');
        if ('handle' in callerResult)
          expect(callerResult.handle).toBe(backgroundResult?.startedTurns[0]?.handle);
        expect(onTurnCreated).toHaveBeenCalledTimes(1);
        expect(onTurnCreated.mock.calls[0]?.[0].id).toBe(admission?.turnId);
        expect(errors).toEqual([]);
      } else if (
        outcome === 'transient' ||
        outcome === 'deterministic' ||
        outcome === 'post-lease'
      ) {
        expect(callerResult).toHaveProperty('error');
        if ('error' in callerResult) expect(callerResult.error).toBe(failure);
        expect(backgroundResult).toBeNull();
        expect(errors).toHaveLength(1);
        expect(errors[0]).toBe(failure);
        expect(
          schedulerRecords.requireSchedulerAdmissionEntry(coreDb, admission!.queueEntryId).status
        ).toBe(outcome === 'post-lease' ? 'admitted' : 'cancelled');
        if (outcome === 'deterministic') expect(cancelSpy).toHaveBeenCalledTimes(1);
        if (outcome === 'post-lease') {
          expect(
            coreDb.sqlite
              .prepare('SELECT status, release_reason FROM scheduler_session_leases')
              .get()
          ).toEqual({ status: 'failed', release_reason: 'turn-start-failed' });
        }
        expect((await service.runOnce())?.startedTurns).toEqual([]);
        expect(preparations).toBe(1);
      } else {
        expect(callerResult).toMatchObject({
          error: { code: `scheduler_admission_${outcome === 'denied' ? 'denied' : 'deferred'}` },
        });
        if (outcome === 'acquisition') {
          expect(backgroundResult).toBeNull();
          expect(errors).toHaveLength(1);
          expect(errors[0]).toBe(failure);
          expect('error' in callerResult ? callerResult.error : undefined).not.toBe(failure);
        } else {
          expect(backgroundResult?.terminalResult.status).toBe(
            outcome === 'denied' ? 'denied' : 'queued'
          );
          expect(errors).toEqual([]);
        }
        expect(
          schedulerRecords.requireSchedulerAdmissionEntry(coreDb, admission!.queueEntryId).status
        ).toBe(cancelDeferredAdmission ? 'cancelled' : outcome === 'denied' ? 'denied' : 'queued');
        if (outcome === 'deferred' && !cancelDeferredAdmission) {
          expect((await service.runOnce())?.terminalResult).toMatchObject({
            reason: 'capacity-saturated',
          });
          expect(preparations).toBe(2);
        }
      }
    } finally {
      gate.resolve();
      await Promise.all([background, caller]);
      service.stop();
      admissionSpy.mockRestore();
      cancelSpy.mockRestore();
      dispatchSpy?.mockRestore();
      coreDb.sqlite.close();
    }
  });

  it.each([
    true,
    false,
  ])('does not wait for or disclose a foreign claimed admission, cancellation %s', async (cancelDeferredAdmission) => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore();
    const manifest = agentManifest();
    const executor = new RecordingTurnExecutor();
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
    createSchedulerAdmissionEntry(coreDb, {
      queueEntryId: 'queue_claim_foreign',
      turnId: 'turn_claim_foreign',
      workspaceId: foreignWorkspace.id,
      threadId: foreignThread.id,
      turnInput: 'Private foreign work',
      requestedAgentId: manifest.id,
      priorityClass: 'interactive',
      requiredPoolConstraints: ['openshell.local'],
      triggerActor: { kind: 'user', id: 'user_claim_foreign' },
      now: () => '2026-07-05T00:00:00.000Z',
    });
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
      agentManifests: [manifest],
      providerRegistry: snapshot.providerRegistry,
      gatewayConfig: snapshot.gatewayConfig,
      expectedControlMode: 'poll',
      expectedDataPlaneMode: 'openshell-files',
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 30_000,
      leaseDurationMs: 900_000,
      schedulerEpoch: 1,
      startupTimeoutMs: 120_000,
    }).catch((error: unknown) => error);
    const caller = startProductTurn({
      coreDb,
      store,
      turnExecutor: executor,
      snapshot,
      schedulerEpoch: 1,
      cancelDeferredAdmission,
      workerPlacement: 'local',
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
      expect(preparations).toBe(1);
      const error = await caller;
      expect(error).toMatchObject({ code: 'scheduler_admission_deferred', status: 409 });
      expect(JSON.stringify(error)).not.toContain('FOREIGN-PRIVATE');
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          workspaceId: 'ws_demo',
          statuses: ['queued', 'cancelled'],
        })
      ).toMatchObject([{ status: cancelDeferredAdmission ? 'cancelled' : 'queued' }]);
      gate.resolve();
      expect(await background).toBe(failure);
      expect(
        schedulerRecords.requireSchedulerAdmissionEntry(coreDb, 'queue_claim_foreign').status
      ).toBe('queued');
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

  it('ends overlapping background passes and later dispatches queued admissions in FIFO order', async () => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore();
    const executor = new RecordingTurnExecutor();
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
      expectedControlMode: 'poll',
      expectedDataPlaneMode: 'openshell-files',
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 30_000,
      leaseDurationMs: 900_000,
      schedulerEpoch: 1,
      startupTimeoutMs: 120_000,
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
      createSchedulerAdmissionEntry(coreDb, {
        queueEntryId: `queue_claim_${suffix}`,
        turnId: `turn_claim_${suffix}`,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        turnInput: suffix,
        requestedAgentId: manifest.id,
        priorityClass: 'interactive',
        requiredPoolConstraints: ['openshell.local'],
        triggerActor: { kind: 'user', id: 'user_local' },
        now: () => `2026-07-05T00:00:0${index}.000Z`,
      });
    }
    const firstRun = service.runOnce();
    try {
      await entered.promise;
      timerTick?.();
      const overlapPending = service.runOnce();
      expect(preparations).toBe(1);
      const overlap = await overlapPending;
      expect(overlap?.startedTurns).toEqual([]);
      expect(errors).toEqual([]);
      gate.resolve();
      await firstRun;
      const [firstLease] = coreDb.sqlite
        .prepare('SELECT lease_id FROM scheduler_session_leases')
        .all() as { lease_id: string }[];
      completeSchedulerSessionLease(coreDb, {
        leaseId: firstLease!.lease_id,
        releaseReason: 'turn-completed',
        terminalStatus: 'released',
      });
      for (const suffix of ['second', 'third']) {
        const result = await service.runOnce();
        expect(result?.startedTurns[0]?.dispatch.entry.queueEntryId).toBe(`queue_claim_${suffix}`);
        completeSchedulerSessionLease(coreDb, {
          leaseId: result!.startedTurns[0]!.dispatch.lease.leaseId,
          releaseReason: 'turn-completed',
          terminalStatus: 'released',
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
    [true, false].flatMap((cancelDeferredAdmission) =>
      (['queue-race', 'malformed-row'] as const).map((failureStage) => ({
        cancelDeferredAdmission,
        failureStage,
      }))
    )
  )('defers foreign failures outside the old catches: $failureStage, cancellation $cancelDeferredAdmission', async ({
    cancelDeferredAdmission,
    failureStage,
  }) => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore();
    const workspace = store.createWorkspace('Foreign Workspace');
    const thread = store.createThread(workspace.id, 'Foreign Thread');
    const turnExecutor = new RecordingTurnExecutor();
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
      createSchedulerAdmissionEntry(coreDb, {
        priorityClass: 'interactive',
        profileRef: null,
        queueEntryId: 'queue_foreign_race',
        requestId: 'req_foreign_race',
        requestedAgentId: manifest.id,
        requiredPoolConstraints: ['openshell.local'],
        threadId: thread.id,
        turnId: 'turn_foreign_race',
        turnInput: 'Foreign private work',
        triggerActor: { kind: 'user', id: 'user_foreign' },
        workspaceId: workspace.id,
        now: () => '2026-07-05T00:00:00.000Z',
      });
      if (failureStage === 'queue-race') {
        const prepare = turnExecutor.prepareAgentSessionForTurn.bind(turnExecutor);
        turnExecutor.prepareAgentSessionForTurn = async (ownerStore, preparation) => {
          expect(preparation.turn.id).toBe('turn_foreign_race');
          const prepared = await prepare(ownerStore, preparation);
          cancelSchedulerAdmissionEntry(coreDb, {
            queueEntryId: 'queue_foreign_race',
            workspaceId: workspace.id,
          });
          return prepared;
        };
      } else {
        coreDb.sqlite
          .prepare(
            'UPDATE scheduler_admission_entries SET required_pool_constraints_json = ? WHERE queue_entry_id = ?'
          )
          .run(privateText, 'queue_foreign_race');
      }
      const error = await startProductTurn({
        cancelDeferredAdmission,
        coreDb,
        input: {
          agentId: manifest.id,
          input: 'Caller work',
          requestId,
          threadId: 'th_demo',
          workspaceId: 'ws_demo',
        },
        providerCredentialResolver: () => null,
        schedulerEpoch: 1,
        snapshot: createInMemoryRuntimeConfigSnapshot({
          agentManifests: [manifest],
          dataRoot: null,
          gatewayConfig: createTestGatewayConfig(),
          providerRegistry: localProviderRegistry(),
        }),
        store,
        triggerActor: { kind: 'user', id: 'user_local' },
        turnExecutor,
        workerPlacement: 'local',
      }).catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: 'scheduler_admission_deferred',
        message: 'Turn was queued but not dispatched in this scheduler iteration.',
        status: 409,
      });
      const response = asCommandError(error, 'turn_start_failed');
      expect(response.status).toBe(409);
      const projection = await response.json();
      expect(projection).toMatchObject({
        code: 'scheduler_admission_deferred',
        message: 'Turn was queued but not dispatched in this scheduler iteration.',
      });
      for (const diagnostic of [String(error), JSON.stringify(projection)]) {
        expect(diagnostic).not.toContain('FOREIGN-PR');
        expect(diagnostic).not.toContain('queue_foreign_race');
      }
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT status, required_pool_constraints_json AS constraints FROM scheduler_admission_entries WHERE queue_entry_id = ?'
          )
          .get('queue_foreign_race')
      ).toEqual({
        status: failureStage === 'queue-race' ? 'cancelled' : 'queued',
        constraints: failureStage === 'queue-race' ? '["openshell.local"]' : privateText,
      });
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          statuses: ['queued', 'cancelled'],
          workspaceId: 'ws_demo',
        })
      ).toMatchObject([{ requestId, status: cancelDeferredAdmission ? 'cancelled' : 'queued' }]);
      expect(coreDb.sqlite.prepare('SELECT lease_id FROM scheduler_session_leases').all()).toEqual(
        []
      );
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
  ])('defers its own queue race during unattributed acquisition, cancellation %s', async (cancelDeferredAdmission) => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
    const manifest = agentManifest();
    const thread = store.createThread('ws_demo', 'Later Thread');
    const prepare = turnExecutor.prepareAgentSessionForTurn.bind(turnExecutor);
    let ownQueueEntryId = '';
    turnExecutor.prepareAgentSessionForTurn = async (ownerStore, preparation) => {
      const prepared = await prepare(ownerStore, preparation);
      const own = listQueuedSchedulerAdmissionEntries(coreDb)[0];
      expect(own.turnId).toBe(preparation.turn.id);
      ownQueueEntryId = own.queueEntryId;
      cancelSchedulerAdmissionEntry(coreDb, {
        queueEntryId: ownQueueEntryId,
        workspaceId: 'ws_demo',
      });
      createSchedulerAdmissionEntry(coreDb, {
        priorityClass: 'interactive',
        queueEntryId: 'queue_later_race',
        requestedAgentId: manifest.id,
        requiredPoolConstraints: ['openshell.local'],
        threadId: thread.id,
        turnId: 'turn_later_race',
        turnInput: 'Later work',
        triggerActor: { kind: 'user', id: 'user_local' },
        workspaceId: 'ws_demo',
      });
      return prepared;
    };
    try {
      seedLocalSchedulerTarget(coreDb);
      const error = await startProductTurn({
        cancelDeferredAdmission,
        coreDb,
        input: {
          agentId: manifest.id,
          input: 'Own work',
          requestId: '00000000-0000-4000-8000-00000000f125',
          threadId: 'th_demo',
          workspaceId: 'ws_demo',
        },
        providerCredentialResolver: () => null,
        schedulerEpoch: 1,
        snapshot: createInMemoryRuntimeConfigSnapshot({
          agentManifests: [manifest],
          dataRoot: null,
          gatewayConfig: createTestGatewayConfig(),
          providerRegistry: localProviderRegistry(),
        }),
        store,
        triggerActor: { kind: 'user', id: 'user_local' },
        turnExecutor,
        workerPlacement: 'local',
      }).catch((caught: unknown) => caught);
      expect(ownQueueEntryId).not.toBe('');
      const message = 'Turn was queued but not dispatched in this scheduler iteration.';
      expect(error).toMatchObject({ code: 'scheduler_admission_deferred', message, status: 409 });
      expect(await asCommandError(error, 'turn_start_failed').json()).toMatchObject({
        code: 'scheduler_admission_deferred',
        message,
      });
      expect(listQueuedSchedulerAdmissionEntries(coreDb)).toMatchObject([
        { queueEntryId: 'queue_later_race' },
      ]);
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          statuses: ['cancelled'],
          workspaceId: 'ws_demo',
        })
      ).toMatchObject([{ queueEntryId: ownQueueEntryId }]);
      expect(coreDb.sqlite.prepare('SELECT lease_id FROM scheduler_session_leases').all()).toEqual(
        []
      );
      expect(turnExecutor.calls).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each(
    [true, false].flatMap((cancelDeferredAdmission) =>
      (['deterministic-preparation', 'transient-preparation', 'turn-start'] as const).map(
        (failureStage) => ({ cancelDeferredAdmission, failureStage })
      )
    )
  )('isolates another admission failure: $failureStage, cancel deferred $cancelDeferredAdmission', async ({
    cancelDeferredAdmission,
    failureStage,
  }) => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore();
    const workspace = store.createWorkspace('Other User Workspace');
    const thread = store.createThread(workspace.id, 'Other User Thread');
    const turnExecutor = new RecordingTurnExecutor();
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
      createSchedulerAdmissionEntry(coreDb, {
        priorityClass: 'interactive',
        profileRef: null,
        queueEntryId: 'queue_other_failure',
        requestId: 'req_other_failure',
        requestedAgentId: manifest.id,
        requiredPoolConstraints: ['openshell.local'],
        threadId: thread.id,
        turnId: 'turn_other_failure',
        turnInput: 'Other user private work',
        triggerActor: { kind: 'user', id: 'user_other' },
        workspaceId: workspace.id,
        now: () => '2026-07-05T00:00:00.000Z',
      });
      const error = await startProductTurn({
        cancelDeferredAdmission,
        coreDb,
        input: {
          agentId: manifest.id,
          input: 'New caller work',
          requestId,
          threadId: 'th_demo',
          workspaceId: 'ws_demo',
        },
        providerCredentialResolver: () => null,
        schedulerEpoch: 1,
        snapshot,
        store,
        triggerActor: { kind: 'user', id: 'user_local' },
        turnExecutor,
        workerPlacement: 'local',
      }).catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: 'scheduler_admission_deferred',
        message: 'Turn was queued but not dispatched in this scheduler iteration.',
        status: 409,
      });
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
          status:
            failureStage === 'deterministic-preparation'
              ? 'cancelled'
              : failureStage === 'turn-start'
                ? 'admitted'
                : 'queued',
        },
      ]);
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          statuses: ['queued', 'cancelled'],
          workspaceId: 'ws_demo',
        })
      ).toMatchObject([{ requestId, status: cancelDeferredAdmission ? 'cancelled' : 'queued' }]);
      const leases = coreDb.sqlite
        .prepare(
          `SELECT status, release_reason AS releaseReason, recovery_state AS recoveryState,
                  workspace_id AS workspaceId, turn_id AS turnId
           FROM scheduler_session_leases`
        )
        .all();
      expect(leases).toEqual(
        failureStage === 'turn-start'
          ? [
              {
                status: 'failed',
                releaseReason: 'turn-start-failed',
                recoveryState: 'needs-evidence',
                workspaceId: workspace.id,
                turnId: 'turn_other_failure',
              },
            ]
          : []
      );
      expect(turnExecutor.calls).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    true,
    false,
  ])('defers a foreign row corrupted after own selection, cancellation %s', async (cancelDeferredAdmission) => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
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
          'UPDATE scheduler_admission_entries SET required_pool_constraints_json = ? WHERE queue_entry_id = ?'
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
      createSchedulerAdmissionEntry(coreDb, {
        priorityClass: 'interactive',
        queueEntryId: 'queue_later_foreign',
        requestId: 'req_later_foreign',
        requestedAgentId: manifest.id,
        requiredPoolConstraints: ['openshell.local'],
        threadId: thread.id,
        turnId: 'turn_later_foreign',
        turnInput: 'Private foreign work',
        triggerActor: { kind: 'user', id: 'user_later_foreign' },
        workspaceId: workspace.id,
        now: () => '2099-01-01T00:00:00.000Z',
      });
      const error = await startProductTurn({
        cancelDeferredAdmission,
        coreDb,
        input: {
          agentId: manifest.id,
          input: 'Caller work',
          requestId,
          threadId: 'th_demo',
          workspaceId: 'ws_demo',
        },
        providerCredentialResolver: () => null,
        schedulerEpoch: 1,
        snapshot: createInMemoryRuntimeConfigSnapshot({
          agentManifests: [manifest],
          dataRoot: null,
          gatewayConfig: createTestGatewayConfig(),
          providerRegistry: localProviderRegistry(),
        }),
        store,
        triggerActor: { kind: 'user', id: 'user_local' },
        turnExecutor,
        workerPlacement: 'local',
      }).catch((caught: unknown) => caught);
      expect(ownPreparationRan).toBe(true);
      const message = 'Turn was queued but not dispatched in this scheduler iteration.';
      expect(error).toMatchObject({ code: 'scheduler_admission_deferred', message, status: 409 });
      expect(String(error)).not.toContain('FOREIGN-PR');
      expect(String(error)).not.toContain('queue_later_foreign');
      const response = asCommandError(error, 'turn_start_failed');
      expect(response.status).toBe(409);
      const projection = await response.json();
      expect(projection).toMatchObject({ code: 'scheduler_admission_deferred', message });
      expect(JSON.stringify(projection)).not.toContain('FOREIGN-PR');
      expect(JSON.stringify(projection)).not.toContain('queue_later_foreign');
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          statuses: ['queued', 'cancelled'],
          workspaceId: 'ws_demo',
        })
      ).toMatchObject([{ requestId, status: cancelDeferredAdmission ? 'cancelled' : 'queued' }]);
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT status, required_pool_constraints_json AS constraints FROM scheduler_admission_entries WHERE queue_entry_id = ?'
          )
          .get('queue_later_foreign')
      ).toEqual({ status: 'queued', constraints: privateText });
      expect(coreDb.sqlite.prepare('SELECT lease_id FROM scheduler_session_leases').all()).toEqual(
        []
      );
      expect(turnExecutor.calls).toEqual([]);
      expect(() => listQueuedSchedulerAdmissionEntries(coreDb)).toThrow(SyntaxError);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    true,
    false,
  ])('preserves an exact own commit failure after acquisition re-attribution, cancellation %s', async (cancelDeferredAdmission) => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
    const manifest = agentManifest();
    const failure = new TurnStartValidationError('recovery_required', 'Own commit failed', 503);
    turnExecutor.commitPreparedAgentSessionForTurn = async (_store, input) => {
      expect(requireSchedulerSessionLease(coreDb, input.leaseId).status).toBe('acquired');
      throw failure;
    };
    try {
      seedLocalSchedulerTarget(coreDb);
      await expect(
        startProductTurn({
          cancelDeferredAdmission,
          coreDb,
          input: {
            agentId: manifest.id,
            input: 'Own caller work',
            requestId: '00000000-0000-4000-8000-00000000f127',
            threadId: 'th_demo',
            workspaceId: 'ws_demo',
          },
          providerCredentialResolver: () => null,
          schedulerEpoch: 1,
          snapshot: createInMemoryRuntimeConfigSnapshot({
            agentManifests: [manifest],
            dataRoot: null,
            gatewayConfig: createTestGatewayConfig(),
            providerRegistry: localProviderRegistry(),
          }),
          store,
          triggerActor: { kind: 'user', id: 'user_local' },
          turnExecutor,
          workerPlacement: 'local',
        })
      ).rejects.toBe(failure);
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          statuses: ['admitted'],
          workspaceId: 'ws_demo',
        })
      ).toHaveLength(1);
      expect(
        coreDb.sqlite
          .prepare('SELECT status, release_reason AS releaseReason FROM scheduler_session_leases')
          .all()
      ).toEqual([{ status: 'failed', releaseReason: 'turn-start-failed' }]);
      expect(turnExecutor.calls).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each(
    [true, false].flatMap((cancelDeferredAdmission) =>
      (['deterministic-preparation', 'turn-start'] as const).map((failureStage) => ({
        cancelDeferredAdmission,
        failureStage,
      }))
    )
  )('preserves the exact own-admission error and handling: $failureStage, cancellation $cancelDeferredAdmission', async ({
    cancelDeferredAdmission,
    failureStage,
  }) => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
    const manifest = agentManifest();
    const cancel = vi.spyOn(schedulerRecords, 'cancelSchedulerAdmissionEntry');
    const failure =
      failureStage === 'deterministic-preparation'
        ? new DeterministicAgentPreparationError('Own preparation failed', 'agent_not_ready', 409)
        : new TurnStartValidationError('recovery_required', 'Own worker launch failed', 503);
    if (failureStage === 'turn-start') {
      turnExecutor.startTurn = async () => {
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
        startProductTurn({
          cancelDeferredAdmission,
          coreDb,
          input: {
            agentId: manifest.id,
            input: 'Own caller work',
            requestId: '00000000-0000-4000-8000-00000000f121',
            threadId: 'th_demo',
            workspaceId: 'ws_demo',
          },
          providerCredentialResolver: () => null,
          schedulerEpoch: 1,
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
          workerPlacement: 'local',
        })
      ).rejects.toBe(failure);
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          statuses: ['admitted', 'cancelled'],
          workspaceId: 'ws_demo',
        })
      ).toMatchObject([{ status: failureStage === 'turn-start' ? 'admitted' : 'cancelled' }]);
      expect(cancel).toHaveBeenCalledTimes(failureStage === 'deterministic-preparation' ? 1 : 0);
      const leases = coreDb.sqlite
        .prepare('SELECT status, release_reason AS releaseReason FROM scheduler_session_leases')
        .all();
      expect(leases).toEqual(
        failureStage === 'turn-start'
          ? [{ status: 'failed', releaseReason: 'turn-start-failed' }]
          : []
      );
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
  ])('dispatches the valid admin queue or defers behind another denial: $earlierDeniedQueue', async ({
    earlierDeniedQueue,
  }) => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore();
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
        triggerActor: { kind: 'user', id: 'user_without_membership' },
        queueEntryId: 'queue_earlier_denied',
        requestId: 'req_earlier_denied',
        workspaceId: 'ws_demo',
        threadId: 'th_other',
        turnId: 'turn_other',
        turnInput: 'A prior request',
        requestedAgentId: manifest.id,
        profileRef: null,
        priorityClass: 'interactive',
        requiredPoolConstraints: ['openshell.local'],
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
      const started = startProductTurn({
        cancelDeferredAdmission: true,
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
        schedulerEpoch: 1,
        snapshot,
        store,
        triggerActor: { kind: 'user', id: 'user_admin_dispatch' },
        turnExecutor: new RecordingTurnExecutor(),
        workerPlacement: 'local',
      });
      if (earlierDeniedQueue) {
        await expect(started).rejects.toMatchObject({
          code: 'scheduler_admission_deferred',
          message: 'Turn was queued but not dispatched in this scheduler iteration.',
          status: 409,
        });
      } else {
        await expect(started).resolves.toMatchObject({ turn: { status: 'running' } });
      }
      const entries = listSchedulerAdmissionEntriesForWorkspace(coreDb, {
        statuses: ['admitted', 'cancelled', 'denied'],
        workspaceId: 'ws_demo',
      });
      expect(entries.find((entry) => entry.requestId === requestId)).toMatchObject({
        serverAdminTokenId: 'token_admin_dispatch',
        status: earlierDeniedQueue ? 'cancelled' : 'admitted',
      });
      if (earlierDeniedQueue) {
        expect(
          entries.find((entry) => entry.queueEntryId === 'queue_earlier_denied')
        ).toMatchObject({
          status: 'denied',
          denialReason: 'policy-cap',
        });
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    true,
    false,
  ])('cancels its own transient preparation failure and prevents later dispatch, cancellation %s', async (cancelDeferredAdmission) => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
    const manifest = agentManifest();
    const requestId = cancelDeferredAdmission
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
        startProductTurn({
          cancelDeferredAdmission,
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
          schedulerEpoch: 1,
          snapshot,
          store,
          triggerActor: { kind: 'user', id: 'user_local' },
          turnExecutor,
          workerPlacement: 'local',
        })
      ).rejects.toBe(failure);

      const admission = listSchedulerAdmissionEntriesForWorkspace(coreDb, {
        statuses: ['queued', 'cancelled'],
        workspaceId: 'ws_demo',
      }).find((entry) => entry.requestId === requestId);
      expect(admission).toMatchObject({ requestId, status: 'cancelled' });

      const laterExecutor = new RecordingTurnExecutor();
      await expect(
        runSchedulerDispatchLoop({
          agentManifests: [manifest],
          coreDb,
          createAgentSessionId: () => 'as_cancelled_followup',
          createLeaseId: () => 'lease_cancelled_followup',
          createPlanId: () => 'plan_cancelled_followup',
          expectedControlMode: 'poll',
          expectedDataPlaneMode: 'openshell-files',
          gatewayConfig: createTestGatewayConfig(),
          heartbeatIntervalMs: 10_000,
          heartbeatTimeoutMs: 30_000,
          leaseDurationMs: 900_000,
          maxDispatches: 1,
          providerRegistry: localProviderRegistry(),
          schedulerEpoch: 1,
          startupTimeoutMs: 120_000,
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
    [true, false].flatMap((cancelDeferredAdmission) =>
      (['deferred', 'denied'] as const).map((outcome) => ({ cancelDeferredAdmission, outcome }))
    )
  )('keeps cancellation optional for its own $outcome outcome, cancellation $cancelDeferredAdmission', async ({
    cancelDeferredAdmission,
    outcome,
  }) => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
    const manifest = agentManifest();
    const prepare = turnExecutor.prepareAgentSessionForTurn.bind(turnExecutor);
    turnExecutor.prepareAgentSessionForTurn = async (ownerStore, preparation) => {
      if (outcome === 'deferred') throw new WorkerGovernanceCapacityUnavailableError();
      const prepared = await prepare(ownerStore, preparation);
      coreDb.sqlite
        .prepare("UPDATE users SET status = 'disabled', disabled_at = ? WHERE id = 'user_local'")
        .run(Date.now());
      return prepared;
    };
    try {
      seedLocalSchedulerTarget(coreDb);
      await expect(
        startProductTurn({
          cancelDeferredAdmission,
          coreDb,
          input: {
            agentId: manifest.id,
            input: 'Own optional cancellation',
            requestId: '00000000-0000-4000-8000-00000000f128',
            threadId: 'th_demo',
            workspaceId: 'ws_demo',
          },
          providerCredentialResolver: () => null,
          schedulerEpoch: 1,
          snapshot: createInMemoryRuntimeConfigSnapshot({
            agentManifests: [manifest],
            dataRoot: null,
            gatewayConfig: createTestGatewayConfig(),
            providerRegistry: localProviderRegistry(),
          }),
          store,
          triggerActor: { kind: 'user', id: 'user_local' },
          turnExecutor,
          workerPlacement: 'local',
        })
      ).rejects.toMatchObject({ code: `scheduler_admission_${outcome}`, status: 409 });
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          statuses: ['queued', 'denied', 'cancelled'],
          workspaceId: 'ws_demo',
        })
      ).toMatchObject([
        {
          status: cancelDeferredAdmission
            ? 'cancelled'
            : outcome === 'denied'
              ? 'denied'
              : 'queued',
        },
      ]);
      expect(coreDb.sqlite.prepare('SELECT lease_id FROM scheduler_session_leases').all()).toEqual(
        []
      );
      expect(turnExecutor.calls).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('preserves its own transient failure when admission cancellation races', async () => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
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
        startProductTurn({
          cancelDeferredAdmission: false,
          coreDb,
          input: {
            agentId: manifest.id,
            input: 'Own cleanup race',
            requestId: '00000000-0000-4000-8000-00000000f129',
            threadId: 'th_demo',
            workspaceId: 'ws_demo',
          },
          providerCredentialResolver: () => null,
          schedulerEpoch: 1,
          snapshot: createInMemoryRuntimeConfigSnapshot({
            agentManifests: [manifest],
            dataRoot: null,
            gatewayConfig: createTestGatewayConfig(),
            providerRegistry: localProviderRegistry(),
          }),
          store,
          triggerActor: { kind: 'user', id: 'user_local' },
          turnExecutor,
          workerPlacement: 'local',
        })
      ).rejects.toBe(failure);
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      cancel.mockRestore();
      coreDb.sqlite.close();
    }
  });

  it('leaves admission queued when the runtime reports one-Sandbox capacity saturation', async () => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
    turnExecutor.prepareAgentSessionForTurn = async () => {
      throw new WorkerGovernanceCapacityUnavailableError();
    };
    try {
      seedLocalSchedulerTarget(coreDb);
      createSchedulerAdmissionEntry(coreDb, {
        priorityClass: 'interactive',
        profileRef: null,
        queueEntryId: 'queue_runtime_capacity',
        requestedAgentId: 'agent_codex_host',
        requiredPoolConstraints: ['openshell.local'],
        threadId: 'th_demo',
        turnId: 'turn_runtime_capacity',
        turnInput: 'Wait for the resident Sandbox',
        triggerActor: { kind: 'user', id: 'user_local' },
        workspaceId: 'ws_demo',
      });

      await expect(
        runSchedulerDispatchLoop({
          gatewayConfig: createTestGatewayConfig(),
          agentManifests: [agentManifest()],
          coreDb,
          createAgentSessionId: () => 'as_runtime_capacity',
          createLeaseId: () => 'lease_runtime_capacity',
          createPlanId: () => 'plan_runtime_capacity',
          expectedControlMode: 'poll',
          expectedDataPlaneMode: 'openshell-files',
          heartbeatIntervalMs: 10_000,
          heartbeatTimeoutMs: 30_000,
          leaseDurationMs: 900_000,
          maxDispatches: 1,
          providerRegistry: localProviderRegistry(),
          schedulerEpoch: 1,
          startupTimeoutMs: 120_000,
          store,
          turnExecutor,
        })
      ).resolves.toEqual({
        startedTurns: [],
        terminalResult: { status: 'queued', reason: 'capacity-saturated' },
      });
      expect(listQueuedSchedulerAdmissionEntries(coreDb)).toEqual([
        expect.objectContaining({
          queueEntryId: 'queue_runtime_capacity',
          status: 'queued',
        }),
      ]);
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM scheduler_placement_plans').get()
      ).toEqual({ count: 0 });
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM scheduler_session_leases').get()
      ).toEqual({ count: 0 });
      expect(() => store.getTurnById('turn_runtime_capacity')).toThrow('Turn not found');
      expect(turnExecutor.calls).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('selects the dequeued Workspace context instead of the initiating request context', async () => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore();
    const queuedWorkspace = store.createWorkspace('Queued Workspace');
    const queuedThread = store.createThread(queuedWorkspace.id, 'Queued Thread');
    const turnExecutor = new RecordingTurnExecutor();
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
    createSchedulerAdmissionEntry(coreDb, {
      priorityClass: 'interactive',
      profileRef: null,
      queueEntryId: 'queue_older_workspace',
      requestedAgentId: manifest.id,
      requiredPoolConstraints: ['openshell.local'],
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
    });
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
        startProductTurn({
          coreDb,
          input: {
            input: 'Initiate another Workspace turn',
            requestId: '0190f4c8-0000-7000-8000-000000000215',
            threadId: 'th_demo',
            workspaceId: 'ws_demo',
          },
          providerCredentialResolver: () => null,
          schedulerEpoch: 1,
          snapshot,
          store,
          triggerActor: { kind: 'user', id: 'user_local' },
          turnExecutor,
          workerPlacement: 'local',
        })
      ).rejects.toMatchObject({ code: 'scheduler_admission_deferred' });

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
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
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
      createSchedulerAdmissionEntry(coreDb, {
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
        priorityClass: 'interactive',
        requiredPoolConstraints: ['openshell.local'],
      });
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
        createLeaseId: () => 'lease_revoked_dispatch',
        createPlanId: () => 'plan_revoked_dispatch',
        expectedControlMode: 'poll',
        expectedDataPlaneMode: 'openshell-files',
        heartbeatIntervalMs: 10_000,
        heartbeatTimeoutMs: 30_000,
        leaseDurationMs: 900_000,
        maxDispatches: 1,
        providerRegistry: localProviderRegistry(),
        schedulerEpoch: 1,
        startupTimeoutMs: 120_000,
        store,
        turnExecutor,
      });

      expect(result.startedTurns).toEqual([]);
      expect(result.terminalResult).toMatchObject({
        status: 'denied',
        entry: { denialReason: 'policy-cap', queueEntryId: 'queue_revoked_dispatch' },
      });
      expect(turnExecutor.calls).toEqual([]);
      expect(
        coreDb.sqlite
          .prepare('SELECT plan_id FROM scheduler_placement_plans WHERE plan_id = ?')
          .get('plan_revoked_dispatch')
      ).toBeUndefined();
      expect(
        coreDb.sqlite
          .prepare('SELECT lease_id FROM scheduler_session_leases WHERE lease_id = ?')
          .get('lease_revoked_dispatch')
      ).toBeUndefined();
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          workspaceId: 'ws_demo',
          statuses: ['denied'],
        })
      ).toEqual([
        expect.objectContaining({
          denialReason: 'policy-cap',
          queueEntryId: 'queue_revoked_dispatch',
          status: 'denied',
        }),
      ]);
      expect(() => store.getTurnById('turn_revoked_dispatch')).toThrow('Turn not found');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    'prepare',
    'commit',
  ] as const)('rechecks a recorded admin token after asynchronous %s before Worker launch', async (revocationStage) => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
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
    createSchedulerAdmissionEntry(coreDb, {
      queueEntryId: 'queue_admin_race',
      requestId: 'req_admin_race',
      serverAdminTokenId: 'token_admin_race',
      triggerActor: { kind: 'user', id: 'user_admin_race' },
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'turn_admin_race',
      turnInput: 'Do not launch after revocation',
      requestedAgentId: 'agent_codex_host',
      priorityClass: 'interactive',
      requiredPoolConstraints: ['openshell.local'],
    });
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
        createLeaseId: () => 'lease_admin_race',
        createPlanId: () => 'plan_admin_race',
        expectedControlMode: 'poll',
        expectedDataPlaneMode: 'openshell-files',
        heartbeatIntervalMs: 10_000,
        heartbeatTimeoutMs: 30_000,
        leaseDurationMs: 900_000,
        maxDispatches: 1,
        providerRegistry: localProviderRegistry(),
        schedulerEpoch: 1,
        startupTimeoutMs: 120_000,
        store,
        turnExecutor,
      });

    try {
      if (revocationStage === 'prepare') {
        await expect(dispatch()).resolves.toMatchObject({
          startedTurns: [],
          terminalResult: {
            status: 'denied',
            entry: { queueEntryId: 'queue_admin_race', denialReason: 'policy-cap' },
          },
        });
      } else {
        await expect(dispatch()).rejects.toMatchObject({
          code: 'workspace_access_denied',
          status: 403,
        });
      }
      expect(turnExecutor.calls).toEqual([]);
      expect(coreDb.sqlite.prepare('SELECT status FROM scheduler_session_leases').all()).toEqual(
        revocationStage === 'prepare' ? [] : [{ status: 'failed' }]
      );
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    {
      expected: { status: 'denied', entry: { denialReason: 'no-compatible-pool' } },
      name: 'no compatible pool',
      setup: (_coreDb: ReturnType<typeof createMigratedCoreDb>) => {},
    },
    {
      expected: { status: 'queued', reason: 'capacity-saturated' },
      name: 'capacity saturation',
      setup: (coreDb: ReturnType<typeof createMigratedCoreDb>) => {
        seedLocalSchedulerTarget(coreDb);
        coreDb.sqlite
          .prepare(
            "UPDATE scheduler_capacity_records SET in_use_count = 1 WHERE target_id = 'target_local'"
          )
          .run();
      },
    },
    {
      expected: { status: 'queued', reason: 'thread-busy' },
      name: 'a busy Thread',
      setup: (coreDb: ReturnType<typeof createMigratedCoreDb>) => {
        seedLocalSchedulerTarget(coreDb);
        createSchedulerAdmissionEntry(coreDb, {
          triggerActor: { kind: 'user', id: 'user_local' },
          queueEntryId: 'queue_replacement_blocker',
          requestId: 'req_replacement_blocker',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_replacement_blocker',
          turnInput: 'Hold the Thread scheduler lease',
          requestedAgentId: 'agent_codex_host',
          profileRef: null,
          priorityClass: 'interactive',
          requiredPoolConstraints: ['openshell.local'],
        });
        const blocker = dispatchNextSchedulerEntry(coreDb, {
          agentSessionId: 'as_replacement_blocker',
          expectedControlMode: 'poll',
          expectedDataPlaneMode: 'openshell-files',
          heartbeatIntervalMs: 10_000,
          heartbeatTimeoutMs: 30_000,
          leaseDurationMs: 900_000,
          leaseId: 'lease_replacement_blocker',
          planId: 'plan_replacement_blocker',
          sandboxBindingRef: 'lease-binding:lease_replacement_blocker',
          schedulerEpoch: 1,
          sessionCompatibilityKey: `sha256:${'b'.repeat(64)}`,
          startupTimeoutMs: 120_000,
        });
        expect(blocker.status).toBe('dispatched');
      },
    },
    {
      expectedError: 'UNIQUE constraint failed: scheduler_placement_plans.plan_id',
      name: 'a dispatch transaction failure',
      setup: (coreDb: ReturnType<typeof createMigratedCoreDb>) => {
        seedLocalSchedulerTarget(coreDb);
        createSchedulerAdmissionEntry(coreDb, {
          triggerActor: { kind: 'user', id: 'user_local' },
          queueEntryId: 'queue_replacement_prior_plan',
          requestId: 'req_replacement_prior_plan',
          workspaceId: 'ws_demo',
          threadId: 'th_prior_plan',
          turnId: 'turn_replacement_prior_plan',
          turnInput: 'Create a prior placement plan',
          requestedAgentId: 'agent_codex_host',
          profileRef: null,
          priorityClass: 'interactive',
          requiredPoolConstraints: ['openshell.local'],
        });
        const prior = dispatchNextSchedulerEntry(coreDb, {
          agentSessionId: 'as_replacement_prior_plan',
          expectedControlMode: 'poll',
          expectedDataPlaneMode: 'openshell-files',
          heartbeatIntervalMs: 10_000,
          heartbeatTimeoutMs: 30_000,
          leaseDurationMs: 900_000,
          leaseId: 'lease_replacement_prior_plan',
          planId: 'plan_replacement_duplicate',
          sandboxBindingRef: 'lease-binding:lease_replacement_prior_plan',
          schedulerEpoch: 1,
          sessionCompatibilityKey: `sha256:${'c'.repeat(64)}`,
          startupTimeoutMs: 120_000,
        });
        expect(prior.status).toBe('dispatched');
        completeSchedulerSessionLease(coreDb, {
          leaseId: 'lease_replacement_prior_plan',
          releaseReason: 'turn-completed',
          terminalStatus: 'released',
        });
      },
    },
  ])('keeps an incompatible current predecessor untouched before $name rejects dispatch', async ({
    expected,
    expectedError,
    setup,
  }) => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
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
      setup(coreDb);
      createSchedulerAdmissionEntry(coreDb, {
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId: 'queue_replacement_candidate',
        requestId: 'req_replacement_candidate',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_replacement_candidate',
        turnInput: 'Use incompatible future static inputs',
        requestedAgentId: 'agent_codex_host',
        profileRef: null,
        priorityClass: 'interactive',
        requiredPoolConstraints: ['openshell.local'],
      });

      let observed: unknown;
      try {
        observed = await runSchedulerDispatchLoop({
          gatewayConfig: createTestGatewayConfig(),
          agentManifests: [agentManifest()],
          coreDb,
          createAgentSessionId: () => 'as_replacement_successor',
          createLeaseId: () => 'lease_replacement_candidate',
          createPlanId: () =>
            expectedError ? 'plan_replacement_duplicate' : 'plan_replacement_candidate',
          expectedControlMode: 'poll',
          expectedDataPlaneMode: 'openshell-files',
          heartbeatIntervalMs: 10_000,
          heartbeatTimeoutMs: 30_000,
          leaseDurationMs: 900_000,
          maxDispatches: 1,
          now: () => '2026-07-05T00:00:02.000Z',
          providerRegistry: localProviderRegistry(),
          schedulerEpoch: 1,
          startupTimeoutMs: 120_000,
          store,
          turnExecutor,
        });
      } catch (error) {
        observed = error;
      }

      if (expectedError) {
        expect(observed).toBeInstanceOf(Error);
        expect((observed as Error).message).toContain(expectedError);
      } else {
        expect(observed).toMatchObject({ startedTurns: [], terminalResult: expected });
      }
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
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();

    try {
      seedLocalSchedulerTarget(coreDb);
      createSchedulerAdmissionEntry(coreDb, {
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId: 'queue_00000000-0000-4000-8000-00000000d201_loop_1',
        requestId: '00000000-0000-4000-8000-00000000d201',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_loop_1',
        turnInput: 'Run the scheduled worker',
        requestedAgentId: 'agent_codex_host',
        profileRef: null,
        priorityClass: 'interactive',
        requiredPoolConstraints: ['openshell.local'],
        now: () => '2026-07-05T00:00:01.000Z',
      });

      const result = await runSchedulerDispatchLoop({
        gatewayConfig: createTestGatewayConfig(),
        coreDb,
        createAgentSessionId: () => 'as_loop_1',
        createLeaseId: () => 'lease_loop_1',
        createPlanId: () => 'plan_loop_1',
        expectedControlMode: 'poll',
        expectedDataPlaneMode: 'openshell-files',
        heartbeatIntervalMs: 10_000,
        heartbeatTimeoutMs: 30_000,
        leaseDurationMs: 900_000,
        maxDispatches: 1,
        now: () => '2026-07-05T00:00:02.000Z',
        providerRegistry: localProviderRegistry(),
        schedulerEpoch: 1,
        startupTimeoutMs: 120_000,
        store,
        turnExecutor,
        agentManifests: [agentManifest()],
      });

      expect(result.startedTurns).toHaveLength(1);
      expect(result.terminalResult).toEqual({ status: 'queued', reason: 'max-dispatches' });
      expect(result.startedTurns[0]?.handle.turn.id).toBe('turn_loop_1');
      const lease = requireSchedulerSessionLease(coreDb, 'lease_loop_1');
      expect(lease.sessionCompatibilityKey).toMatch(/^sha256:[a-f0-9]{64}$/);
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
            sandboxBindingRef: 'lease-binding:lease_loop_1',
            sessionCompatibilityKey: lease.sessionCompatibilityKey,
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
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
    const laterThread = store.createThread('ws_demo', 'Later dispatchable thread');

    try {
      seedLocalSchedulerTarget(coreDb);
      coreDb.sqlite
        .prepare(
          `UPDATE scheduler_capacity_records SET concurrency_ceiling = 2 WHERE target_id = 'target_local'`
        )
        .run();
      coreDb.sqlite
        .prepare(
          `UPDATE scheduler_worker_pools SET max_concurrent_sessions = 2 WHERE pool_id = 'pool_local'`
        )
        .run();
      createSchedulerAdmissionEntry(coreDb, {
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId: 'queue_busy_active',
        requestId: 'req_busy_active',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_busy_active',
        turnInput: 'Hold the first Thread lease',
        requestedAgentId: 'agent_codex_host',
        profileRef: null,
        priorityClass: 'interactive',
        requiredPoolConstraints: ['openshell.local'],
        now: () => '2026-07-05T00:00:00.000Z',
      });
      const blocker = dispatchNextSchedulerEntry(coreDb, {
        agentSessionId: 'as_busy_active',
        expectedControlMode: 'poll',
        expectedDataPlaneMode: 'openshell-files',
        heartbeatIntervalMs: 10_000,
        heartbeatTimeoutMs: 30_000,
        leaseDurationMs: 900_000,
        leaseId: 'lease_busy_active',
        planId: 'plan_busy_active',
        sandboxBindingRef: 'lease-binding:lease_busy_active',
        schedulerEpoch: 1,
        sessionCompatibilityKey: `sha256:${'b'.repeat(64)}`,
        startupTimeoutMs: 120_000,
        now: () => '2026-07-05T00:00:01.000Z',
      });
      expect(blocker.status).toBe('dispatched');
      createSchedulerAdmissionEntry(coreDb, {
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId: 'queue_busy_followup',
        requestId: 'req_busy_followup',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_busy_followup',
        turnInput: 'Stay queued while the Thread is busy',
        requestedAgentId: 'agent_codex_host',
        profileRef: null,
        priorityClass: 'interactive',
        requiredPoolConstraints: ['openshell.local'],
        now: () => '2026-07-05T00:00:02.000Z',
      });
      createSchedulerAdmissionEntry(coreDb, {
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId: 'queue_later_dispatchable',
        requestId: 'req_later_dispatchable',
        workspaceId: 'ws_demo',
        threadId: laterThread.id,
        turnId: 'turn_later_dispatchable',
        turnInput: 'Start the later dispatchable Thread',
        requestedAgentId: 'agent_codex_host',
        profileRef: null,
        priorityClass: 'interactive',
        requiredPoolConstraints: ['openshell.local'],
        now: () => '2026-07-05T00:00:03.000Z',
      });
      expect(
        listQueuedSchedulerAdmissionEntries(coreDb).map((entry) => entry.queueEntryId)
      ).toEqual(['queue_busy_followup', 'queue_later_dispatchable']);

      const result = await runSchedulerDispatchLoop({
        gatewayConfig: createTestGatewayConfig(),
        agentManifests: [agentManifest()],
        coreDb,
        createAgentSessionId: () => 'as_later_dispatchable',
        createLeaseId: () => 'lease_later_dispatchable',
        createPlanId: () => 'plan_later_dispatchable',
        expectedControlMode: 'poll',
        expectedDataPlaneMode: 'openshell-files',
        heartbeatIntervalMs: 10_000,
        heartbeatTimeoutMs: 30_000,
        leaseDurationMs: 900_000,
        maxDispatches: 1,
        now: () => '2026-07-05T00:00:04.000Z',
        providerRegistry: localProviderRegistry(),
        schedulerEpoch: 1,
        startupTimeoutMs: 120_000,
        store,
        turnExecutor,
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
      expect(requireSchedulerSessionLease(coreDb, 'lease_busy_active').status).not.toBe('failed');
      expect(requireSchedulerSessionLease(coreDb, 'lease_later_dispatchable')).toMatchObject({
        status: 'acquired',
        threadId: laterThread.id,
        turnId: 'turn_later_dispatchable',
      });
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT lease_id FROM scheduler_session_leases WHERE status = 'failed' ORDER BY lease_id`
          )
          .all()
      ).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('fails the acquired lease when post-dispatch AgentSession commit rejects', async () => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
    turnExecutor.commitPreparedAgentSessionForTurn = async () => {
      throw new Error('prepared AgentSession changed');
    };

    try {
      seedLocalSchedulerTarget(coreDb);
      createSchedulerAdmissionEntry(coreDb, {
        priorityClass: 'interactive',
        profileRef: null,
        queueEntryId: 'queue_commit_failed',
        requestId: 'req_commit_failed',
        requestedAgentId: 'agent_codex_host',
        requiredPoolConstraints: ['openshell.local'],
        threadId: 'th_demo',
        turnId: 'turn_commit_failed',
        turnInput: 'Reject after scheduler dispatch',
        triggerActor: { kind: 'user', id: 'user_local' },
        workspaceId: 'ws_demo',
      });

      await expect(
        runSchedulerDispatchLoop({
          gatewayConfig: createTestGatewayConfig(),
          agentManifests: [agentManifest()],
          coreDb,
          createAgentSessionId: () => 'as_commit_failed',
          createLeaseId: () => 'lease_commit_failed',
          createPlanId: () => 'plan_commit_failed',
          expectedControlMode: 'poll',
          expectedDataPlaneMode: 'openshell-files',
          heartbeatIntervalMs: 10_000,
          heartbeatTimeoutMs: 30_000,
          leaseDurationMs: 900_000,
          maxDispatches: 1,
          providerRegistry: localProviderRegistry(),
          schedulerEpoch: 1,
          startupTimeoutMs: 120_000,
          store,
          turnExecutor,
        })
      ).rejects.toThrow('prepared AgentSession changed');

      expect(requireSchedulerSessionLease(coreDb, 'lease_commit_failed')).toMatchObject({
        releaseReason: 'turn-start-failed',
        status: 'failed',
      });
      expect(turnExecutor.calls).toEqual([]);
      expect(() => store.getTurnById('turn_commit_failed')).toThrow('Turn not found');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('reuses the exact compatible current AgentSession selected by the runtime seam', async () => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();

    try {
      seedLocalSchedulerTarget(coreDb);
      createSchedulerAdmissionEntry(coreDb, {
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId: 'queue_continuity_live',
        requestId: 'req_continuity_live',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_continuity_live',
        turnInput: 'Run with continuity',
        requestedAgentId: 'agent_codex_host',
        profileRef: null,
        priorityClass: 'interactive',
        requiredPoolConstraints: ['openshell.local'],
        now: () => '2026-07-05T00:00:01.000Z',
      });

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
        createLeaseId: () => 'lease_continuity_live',
        createPlanId: () => 'plan_continuity_live',
        expectedControlMode: 'poll',
        expectedDataPlaneMode: 'openshell-files',
        heartbeatIntervalMs: 10_000,
        heartbeatTimeoutMs: 30_000,
        leaseDurationMs: 900_000,
        maxDispatches: 1,
        now: () => '2026-07-05T00:00:02.000Z',
        providerRegistry: localProviderRegistry(),
        schedulerEpoch: 1,
        startupTimeoutMs: 120_000,
        store,
        turnExecutor,
      });

      expect(result.startedTurns).toHaveLength(1);
      expect(requireSchedulerSessionLease(coreDb, 'lease_continuity_live')).toMatchObject({
        agentSessionId: 'as_live_continuity',
        sessionCompatibilityKey,
      });
      expect(turnExecutor.calls[0]?.context).toMatchObject({
        agentSessionId: 'as_live_continuity',
        agentSetup: setup,
        sandboxBindingRef: 'lease-binding:lease_continuity_live',
        sessionCompatibilityKey,
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('reuses the current compatible AgentSession across sequential product admissions', async () => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
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
      upsertWorkspaceRepositoryResource(workspaceDb, {
        displayName: 'Product continuity repository',
        localPath: repositoryPath,
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        workspaceId: 'ws_demo',
      });
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
      const first = await startProductTurn({
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
        schedulerEpoch: 1,
        snapshot,
        store,
        triggerActor: { kind: 'user', id: 'user_local' },
        turnExecutor,
        workerPlacement: 'local',
      });
      const firstLease = coreDb.sqlite
        .prepare('SELECT lease_id AS leaseId FROM scheduler_session_leases WHERE turn_id = ?')
        .get(first.turn.id) as { leaseId: string };
      completeSchedulerSessionLease(coreDb, {
        leaseId: firstLease.leaseId,
        releaseReason: 'turn-completed',
        terminalStatus: 'released',
      });

      const second = await startProductTurn({
        coreDb,
        input: {
          agentId: 'agent_codex_host',
          input: 'Run the second sequential Turn',
          requestId: '00000000-0000-4000-8000-00000000d212',
          threadId: 'th_demo',
          workspaceId: 'ws_demo',
        },
        providerCredentialResolver: () => null,
        schedulerEpoch: 1,
        snapshot,
        store,
        triggerActor: { kind: 'user', id: 'user_local' },
        turnExecutor,
        workerPlacement: 'local',
      });
      const leases = coreDb.sqlite
        .prepare(
          `SELECT agent_session_id AS agentSessionId, lease_id AS leaseId, turn_id AS turnId
           FROM scheduler_session_leases
           WHERE turn_id IN (?, ?)
           ORDER BY turn_id`
        )
        .all(first.turn.id, second.turn.id) as Array<{
        agentSessionId: string;
        leaseId: string;
        turnId: string;
      }>;

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
      expect(leases).toHaveLength(2);
      expect(new Set(leases.map((lease) => lease.leaseId)).size).toBe(2);
      expect(new Set(leases.map((lease) => lease.turnId)).size).toBe(2);
      expect(new Set(leases.map((lease) => lease.agentSessionId))).toEqual(
        new Set([first.turn.agentSessionId])
      );
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records resolved setup lineage for scheduler-dispatched authored agents', async () => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();

    try {
      seedLocalSchedulerTarget(coreDb);
      createSchedulerAdmissionEntry(coreDb, {
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId: 'queue_setup_ledger',
        requestId: 'req_setup_ledger',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_setup_ledger',
        turnInput: 'Run the scheduled worker',
        requestedAgentId: 'agent_codex_host',
        profileRef: null,
        priorityClass: 'interactive',
        requiredPoolConstraints: ['openshell.local'],
        now: () => '2026-07-05T00:00:01.000Z',
      });

      const result = await runSchedulerDispatchLoop({
        gatewayConfig: createTestGatewayConfig(),
        coreDb,
        createAgentSessionId: () => 'as_setup_ledger',
        createLeaseId: () => 'lease_setup_ledger',
        createPlanId: () => 'plan_setup_ledger',
        dependencies: { providerCredentialResolver: () => 'test-key' },
        expectedControlMode: 'poll',
        expectedDataPlaneMode: 'openshell-files',
        heartbeatIntervalMs: 10_000,
        heartbeatTimeoutMs: 30_000,
        leaseDurationMs: 900_000,
        maxDispatches: 1,
        now: () => '2026-07-05T00:00:02.000Z',
        providerRegistry: localProviderRegistry(),
        schedulerEpoch: 1,
        startupTimeoutMs: 120_000,
        store,
        turnExecutor,
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

  it('fails the acquired lease when turn startup fails', async () => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore();
    const turnExecutor = new FailingTurnExecutor();

    try {
      seedLocalSchedulerTarget(coreDb);
      createSchedulerAdmissionEntry(coreDb, {
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId: 'queue_loop_failed',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_loop_failed',
        turnInput: 'Fail the scheduled worker',
        requestedAgentId: 'agent_codex_host',
        profileRef: null,
        priorityClass: 'interactive',
        requiredPoolConstraints: ['openshell.local'],
        now: () => '2026-07-05T00:00:01.000Z',
      });

      await expect(
        runSchedulerDispatchLoop({
          gatewayConfig: createTestGatewayConfig(),
          coreDb,
          createAgentSessionId: () => 'as_loop_failed',
          createLeaseId: () => 'lease_loop_failed',
          createPlanId: () => 'plan_loop_failed',
          expectedControlMode: 'poll',
          expectedDataPlaneMode: 'openshell-files',
          heartbeatIntervalMs: 10_000,
          heartbeatTimeoutMs: 30_000,
          leaseDurationMs: 900_000,
          maxDispatches: 1,
          now: () => '2026-07-05T00:00:02.000Z',
          providerRegistry: localProviderRegistry(),
          schedulerEpoch: 1,
          startupTimeoutMs: 120_000,
          store,
          turnExecutor,
          agentManifests: [agentManifest()],
        })
      ).rejects.toThrow('worker launch failed');

      expect(
        resolveSchedulerLeaseTokenBinding(coreDb, {
          sandboxBindingRef: 'lease-binding:lease_loop_failed',
          lineage: {
            agentSessionId: 'as_loop_failed',
            packageSnapshotId: 'aepsnap_turn_loop_failed_as_loop_failed',
            threadId: 'th_demo',
            turnId: 'turn_loop_failed',
            workspaceId: 'ws_demo',
          },
        })
      ).toEqual({ status: 'rejected', reason: 'lease-not-live' });
      expect(
        (
          coreDb.sqlite
            .prepare('SELECT in_use_count FROM scheduler_capacity_records WHERE target_id = ?')
            .get('target_local') as { in_use_count: number }
        ).in_use_count
      ).toBe(0);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('preserves the worker failure while anchored backend cleanup remains pending', async () => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
    turnExecutor.startTurn = async (ownerStore, turnId, _input, context) => {
      const lease = requireSchedulerSessionLease(coreDb, 'lease_cleanup_pending');
      if (!context?.agentSessionId) {
        throw new Error('Expected scheduler-owned AgentSession lineage.');
      }
      seedBackendRuntimeTarget(coreDb);
      recordWorkerBackendSessionMaterializing(coreDb, {
        backendLineage: { imageRef: 'openkit/worker-codex:dev', kind: 'reference' },
        backendVersion: '0.0.99',
        identity: {
          agentSessionId: context.agentSessionId,
          backendKind: 'openshell',
          backendSessionId: 'openkit-as_cleanup_pending',
          deploymentId: 'deployment-test',
          packageSnapshotId: lease.packageSnapshotId,
          runtimeTargetId: 'runtime-target-test',
          stagingDirectoryRef: 'server/runtime/worker-backend-sessions/cleanup-pending',
          transientProviderInstanceId: null,
        },
        lineage: { threadId: 'th_demo', turnId, workspaceId: 'ws_demo' },
        sandboxBindingRef: lease.sandboxBindingRef,
      });
      for (const [fromState, toState] of [
        ['materializing', 'materialized'],
        ['materialized', 'launching'],
        ['launching', 'cleanup-pending'],
      ] as const) {
        transitionWorkerBackendSessionState(coreDb, {
          fromState,
          leaseId: lease.leaseId,
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
      createSchedulerAdmissionEntry(coreDb, {
        priorityClass: 'interactive',
        profileRef: null,
        queueEntryId: 'queue_cleanup_pending',
        requestId: 'req_cleanup_pending',
        requestedAgentId: 'agent_codex_host',
        requiredPoolConstraints: ['openshell.local'],
        threadId: 'th_demo',
        turnId: 'turn_cleanup_pending',
        turnInput: 'Fail with backend cleanup pending',
        triggerActor: { kind: 'user', id: 'user_local' },
        workspaceId: 'ws_demo',
      });

      await expect(
        runSchedulerDispatchLoop({
          gatewayConfig: createTestGatewayConfig(),
          agentManifests: [agentManifest()],
          coreDb,
          createAgentSessionId: () => 'as_cleanup_pending',
          createLeaseId: () => 'lease_cleanup_pending',
          createPlanId: () => 'plan_cleanup_pending',
          expectedControlMode: 'poll',
          expectedDataPlaneMode: 'openshell-files',
          heartbeatIntervalMs: 10_000,
          heartbeatTimeoutMs: 30_000,
          leaseDurationMs: 900_000,
          maxDispatches: 1,
          providerRegistry: localProviderRegistry(),
          schedulerEpoch: 1,
          startupTimeoutMs: 120_000,
          store,
          turnExecutor,
        })
      ).rejects.toThrow('accepted effect is unknown');

      expect(requireSchedulerSessionLease(coreDb, 'lease_cleanup_pending')).toMatchObject({
        releaseReason: null,
        status: 'acquired',
      });
      expect(
        (
          coreDb.sqlite
            .prepare('SELECT state FROM worker_backend_sessions WHERE lease_id = ?')
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

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceDataSourceCatalog } from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';
import { requireResolvedAgentSetup } from '../agents/setup-ledger';
import { ensureLocalUser } from '../auth/identity.js';
import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import type { FsStore } from '../lib/store';
import { ProviderRegistry } from '../providers/registry';
import {
  completeSchedulerSessionLease,
  createSchedulerAdmissionEntry,
  dispatchNextSchedulerEntry,
  listQueuedSchedulerAdmissionEntries,
  listSchedulerAdmissionEntriesForWorkspace,
  markSchedulerSessionLeaseReleasing,
  requireSchedulerSessionLease,
  resolveSchedulerLeaseTokenBinding,
  upsertSchedulerCapacityRecord,
  upsertSchedulerTargetHealthRecord,
  upsertSchedulerWorkerPool,
} from '../scheduler-records';
import { openCoreDb, openWorkspaceDb } from '../storage/db';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate';
import { isCurrentAgentSessionStatus } from '../storage/workspace-file-records.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { upsertWorkspaceRepositoryResource } from '../workspace/repository-store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { resolveAgentSessionCompatibilityKey } from './agent-environment.js';
import { TurnStartValidationError } from './orchestrator';
import { startProductTurn } from './product-turn-start.js';
import { runSchedulerDispatchLoop } from './scheduler-dispatch-loop';
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
import { recordWorkerControlAcceptedRecord } from './worker-control-records';
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
    },
  ]);
}

describe('scheduler dispatch loop', () => {
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
          path: `workspaces/${queuedWorkspace.id}/config/mcp-servers.jsonc`,
          workspaceId: queuedWorkspace.id,
        },
        {
          catalog: mcpCatalog('initiating-tool'),
          path: 'workspaces/ws_demo/config/mcp-servers.jsonc',
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

  it('denies a queued admission whose actor lost current Workspace authority', async () => {
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
      coreDb.sqlite
        .prepare(
          `INSERT INTO workspace_members (
            workspace_id, user_id, status, access_level, invitation_id,
            joined_at, removed_at, revision, created_at, updated_at
          ) VALUES ('ws_demo', 'user_revoked_dispatch', 'active', 'editor', NULL, ?, NULL, 1, ?, ?)`
        )
        .run(timestamp, timestamp, timestamp);
      seedLocalSchedulerTarget(coreDb);
      createSchedulerAdmissionEntry(coreDb, {
        triggerActor: { kind: 'user', id: 'user_revoked_dispatch' },
        queueEntryId: 'queue_revoked_dispatch',
        requestId: 'req_revoked_dispatch',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_revoked_dispatch',
        turnInput: 'Do not launch this stale admission',
        requestedAgentId: 'agent_codex_host',
        profileRef: null,
        priorityClass: 'interactive',
        requiredPoolConstraints: ['openshell.local'],
      });
      coreDb.sqlite
        .prepare(
          `UPDATE workspace_members
           SET status = 'removed', removed_at = ?, revision = revision + 1, updated_at = ?
           WHERE workspace_id = 'ws_demo' AND user_id = 'user_revoked_dispatch'`
        )
        .run(timestamp, timestamp);

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
      expect(turnExecutor.calls).toEqual([
        {
          context: {
            agentSessionId: 'as_loop_1',
            agentSetup: createTestAgentSetup(),
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
          humanGate: null,
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

  it('releases an exact interrupted human-gate fallback lease with recovery evidence required', async () => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
    turnExecutor.startTurn = async (ownerStore, turnId, _input, context) => {
      if (!context?.agentSessionId) {
        throw new Error('Expected scheduler-owned AgentSession lineage.');
      }
      const lease = requireSchedulerSessionLease(coreDb, 'lease_human_gate_fallback');
      recordWorkerBackendSessionMaterializing(coreDb, {
        backendLineage: { imageRef: 'openkit/worker-codex:dev', kind: 'reference' },
        backendVersion: '0.0.99',
        identity: {
          agentSessionId: context.agentSessionId,
          backendKind: 'openshell',
          backendSessionId: 'openkit-as_human_gate_fallback',
          deploymentId: 'deployment-test',
          packageSnapshotId: lease.packageSnapshotId,
          runtimeTargetId: 'runtime-target-test',
          stagingDirectoryRef: 'server/runtime/worker-backend-sessions/human-gate-fallback',
          transientProviderInstanceId: null,
        },
        lineage: { threadId: 'th_demo', turnId, workspaceId: 'ws_demo' },
        now: () => '2026-07-05T00:00:03.000Z',
        sandboxBindingRef: lease.sandboxBindingRef,
      });
      for (const [fromState, toState] of [
        ['materializing', 'materialized'],
        ['materialized', 'launching'],
        ['launching', 'cleanup-pending'],
        ['cleanup-pending', 'physical-cleaned'],
        ['physical-cleaned', 'cleaned'],
      ] as const) {
        transitionWorkerBackendSessionState(coreDb, {
          fromState,
          leaseId: lease.leaseId,
          toState,
        });
      }
      recordWorkerControlAcceptedRecord(coreDb, {
        acceptedAt: '2026-07-05T00:00:03.000Z',
        lineage: {
          agentSessionId: context.agentSessionId,
          packageSnapshotId: lease.packageSnapshotId,
          requestId: 'req_human_gate_fallback',
          threadId: 'th_demo',
          turnId,
          workspaceId: 'ws_demo',
        },
        operation: 'final_status',
        record: { sequence: 1, status: 'blocked', stopReason: 'ask_user' },
        recordKey: '1',
        sandboxBindingRef: lease.sandboxBindingRef,
        sequence: 1,
      });
      markSchedulerSessionLeaseReleasing(coreDb, {
        leaseId: lease.leaseId,
        releaseReason: 'worker-final-status',
      });
      const message = 'Worker requested human input without an exact product Gate.';
      ownerStore.createAgentSession({
        agentId: 'agent_codex_host',
        createdAt: '2026-07-05T00:00:02.000Z',
        id: context.agentSessionId,
        message: null,
        status: 'busy',
        threadId: 'th_demo',
        updatedAt: '2026-07-05T00:00:02.000Z',
        workspaceId: 'ws_demo',
      });
      ownerStore.updateTurn(turnId, {
        agentSessionId: context.agentSessionId,
        completedAt: '2026-07-05T00:00:03.000Z',
        error: { code: 'worker_human_gate_unavailable', message },
        status: 'interrupted',
      });
      ownerStore.updateAgentSession(context.agentSessionId, {
        message,
        status: 'interrupted',
        updatedAt: '2026-07-05T00:00:03.000Z',
      });
      throw new TurnStartValidationError('recovery_required', message, 409);
    };

    try {
      seedLocalSchedulerTarget(coreDb);
      createSchedulerAdmissionEntry(coreDb, {
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId: 'queue_human_gate_fallback',
        requestId: 'req_human_gate_fallback',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_human_gate_fallback',
        turnInput: 'Ask for unavailable input',
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
          createAgentSessionId: () => 'as_human_gate_fallback',
          createLeaseId: () => 'lease_human_gate_fallback',
          createPlanId: () => 'plan_human_gate_fallback',
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
      ).rejects.toMatchObject({ code: 'recovery_required', status: 409 });

      expect(requireSchedulerSessionLease(coreDb, 'lease_human_gate_fallback')).toMatchObject({
        recoveryState: 'needs-evidence',
        status: 'released',
      });
      expect(store.getTurnById('turn_human_gate_fallback')).toMatchObject({
        error: { code: 'worker_human_gate_unavailable' },
        status: 'interrupted',
      });
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

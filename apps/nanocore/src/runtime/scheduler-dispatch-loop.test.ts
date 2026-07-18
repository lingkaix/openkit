import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuthoredAgentConfig } from '../agents/manifest';
import { requireResolvedAgentSetup } from '../agents/setup-ledger';
import type { FsStore } from '../lib/store';
import { ProviderRegistry } from '../providers/registry';
import {
  createSchedulerAdmissionEntry,
  markSchedulerSessionLeaseReleasing,
  requireSchedulerSessionLease,
  resolveSchedulerLeaseTokenBinding,
  upsertSchedulerCapacityRecord,
  upsertSchedulerTargetHealthRecord,
  upsertSchedulerWorkerPool,
} from '../scheduler-records';
import { openCoreDb, openWorkspaceDb } from '../storage/db';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate';
import { createDemoStore } from '../test-support/demo-store.js';
import { TurnStartValidationError } from './orchestrator';
import { runSchedulerDispatchLoop } from './scheduler-dispatch-loop';
import type { TurnExecutor, TurnStartRuntimeContext } from './types';
import {
  recordWorkerBackendSessionMaterializing,
  transitionWorkerBackendSessionState,
} from './worker-backend-sessions';
import { recordWorkerControlAcceptedRecord } from './worker-control-records';

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
 * Creates an authored agent config for scheduler setup resolution tests.
 *
 * @returns Authored agent config.
 */
function agentConfig(): AuthoredAgentConfig {
  return {
    schemaVersion: 1,
    id: 'agent_codex_host',
    displayName: 'Codex Agent',
    runtime: {
      kind: 'codex',
      adapter: 'codex-app-server',
      version: '0.130.0',
    },
    mode: 'local',
    transport: { kind: 'stdio' },
    provider: {
      ref: 'agent-openrouter',
      model: 'openai/gpt-5.2',
    },
    deployment: {
      local: {
        command: 'codex',
        args: ['app-server', '--listen', 'stdio://'],
      },
    },
    extensions: {},
  };
}

describe('scheduler dispatch loop', () => {
  it('starts one dispatched queued turn with scheduler-owned lineage', async () => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();

    try {
      seedLocalSchedulerTarget(coreDb);
      createSchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'queue_00000000-0000-4000-8000-00000000d201_loop_1',
        requestId: '00000000-0000-4000-8000-00000000d201',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_loop_1',
        turnInput: 'Run the scheduled worker',
        requestedAgentId: 'agent_codex_host',
        profileRef: 'profile_worker',
        priorityClass: 'interactive',
        requiredPoolConstraints: ['openshell.local'],
        now: () => '2026-07-05T00:00:01.000Z',
      });

      const result = await runSchedulerDispatchLoop({
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
        providerRegistry: new ProviderRegistry([]),
        schedulerEpoch: 1,
        sessionCompatibilityKey: 'sha256:scheduler-session-compatible',
        startupTimeoutMs: 120_000,
        store,
        turnExecutor,
        agentManifests: [
          {
            adapter: 'custom-http',
            deployments: ['local'],
            displayName: 'Codex Agent',
            id: 'agent_codex_host',
            kind: 'custom',
            runtime: 'custom',
            version: '0.0.2',
          },
        ],
      });

      expect(result.startedTurns).toHaveLength(1);
      expect(result.terminalResult).toEqual({ status: 'queued', reason: 'max-dispatches' });
      expect(result.startedTurns[0]?.handle.turn.id).toBe('turn_loop_1');
      expect(requireSchedulerSessionLease(coreDb, 'lease_loop_1').sessionCompatibilityKey).toBe(
        'sha256:scheduler-session-compatible'
      );
      expect(store.getTurn('ws_demo', 'th_demo', 'turn_loop_1').status).toBe('running');
      expect(turnExecutor.calls).toEqual([
        {
          context: {
            agentSessionId: 'as_loop_1',
            requestId: '00000000-0000-4000-8000-00000000d201',
            sandboxBindingRef: 'lease-binding:lease_loop_1',
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

  it('reuses a compatible live session when scheduler continuity candidates are available', async () => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();

    try {
      seedLocalSchedulerTarget(coreDb);
      createSchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'queue_continuity_live',
        requestId: 'req_continuity_live',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_continuity_live',
        turnInput: 'Run with continuity',
        requestedAgentId: 'agent_codex_host',
        profileRef: 'profile_worker',
        priorityClass: 'interactive',
        requiredPoolConstraints: ['openshell.local'],
        now: () => '2026-07-05T00:00:01.000Z',
      });

      const result = await runSchedulerDispatchLoop({
        agentManifests: [
          {
            adapter: 'custom-http',
            deployments: ['local'],
            displayName: 'Codex Agent',
            id: 'agent_codex_host',
            kind: 'custom',
            runtime: 'custom',
            version: '0.0.2',
          },
        ],
        coreDb,
        createAgentSessionId: () => {
          throw new Error('fresh session id should not be requested');
        },
        createLeaseId: () => 'lease_continuity_live',
        createPlanId: () => 'plan_continuity_live',
        expectedControlMode: 'poll',
        expectedDataPlaneMode: 'openshell-files',
        heartbeatIntervalMs: 10_000,
        heartbeatTimeoutMs: 30_000,
        leaseDurationMs: 900_000,
        maxDispatches: 1,
        now: () => '2026-07-05T00:00:02.000Z',
        providerRegistry: new ProviderRegistry([]),
        schedulerEpoch: 1,
        sessionCompatibilityKey: 'sha256:scheduler-session-compatible',
        sessionContinuityCandidates: {
          liveSessions: [
            {
              agentSessionId: 'as_live_continuity',
              reusable: true,
              sessionCompatibilityKey: 'sha256:scheduler-session-compatible',
              status: 'idle',
            },
          ],
        },
        startupTimeoutMs: 120_000,
        store,
        turnExecutor,
      });

      expect(result.startedTurns[0]?.continuity.selected).toEqual({
        agentSessionId: 'as_live_continuity',
        kind: 'live-session',
      });
      expect(requireSchedulerSessionLease(coreDb, 'lease_continuity_live')).toMatchObject({
        agentSessionId: 'as_live_continuity',
        sessionCompatibilityKey: 'sha256:scheduler-session-compatible',
      });
      expect(turnExecutor.calls[0]?.context).toMatchObject({
        agentSessionId: 'as_live_continuity',
        sandboxBindingRef: 'lease-binding:lease_continuity_live',
      });
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
        queueEntryId: 'queue_setup_ledger',
        requestId: 'req_setup_ledger',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_setup_ledger',
        turnInput: 'Run the scheduled worker',
        requestedAgentId: 'agent_codex_host',
        profileRef: 'profile_worker',
        priorityClass: 'interactive',
        requiredPoolConstraints: ['openshell.local'],
        now: () => '2026-07-05T00:00:01.000Z',
      });

      const result = await runSchedulerDispatchLoop({
        coreDb,
        createAgentSessionId: () => 'as_setup_ledger',
        createLeaseId: () => 'lease_setup_ledger',
        createPlanId: () => 'plan_setup_ledger',
        expectedControlMode: 'poll',
        expectedDataPlaneMode: 'openshell-files',
        heartbeatIntervalMs: 10_000,
        heartbeatTimeoutMs: 30_000,
        leaseDurationMs: 900_000,
        maxDispatches: 1,
        now: () => '2026-07-05T00:00:02.000Z',
        providerRegistry: new ProviderRegistry([
          {
            id: 'agent-openrouter',
            vendor: 'openai-compatible',
            baseUrl: 'https://openrouter.ai/api/v1',
            defaultModel: 'openai/gpt-5.2',
            secretRef: 'env:OPENROUTER_API_KEY',
          },
        ]),
        schedulerEpoch: 1,
        startupTimeoutMs: 120_000,
        store,
        turnExecutor,
        agentConfigs: [agentConfig()],
        agentManifests: [
          {
            adapter: 'custom-http',
            deployments: ['local'],
            displayName: 'Codex Agent',
            id: 'agent_codex_host',
            kind: 'custom',
            runtime: 'custom',
            version: '0.0.2',
          },
        ],
      });
      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'user_local', 'ws_demo');

      try {
        applyScopedMigrations(workspaceDb);
        expect(result.startedTurns[0]?.handle.agentSetupRecordId).toBe('ras_turn_setup_ledger');
        expect(
          requireResolvedAgentSetup(workspaceDb, 'ws_demo', 'ras_turn_setup_ledger')
        ).toMatchObject({
          turnId: 'turn_setup_ledger',
          requestId: 'req_setup_ledger',
          agentId: 'agent_codex_host',
          providerId: 'agent-openrouter',
        });
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
        queueEntryId: 'queue_loop_failed',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_loop_failed',
        turnInput: 'Fail the scheduled worker',
        requestedAgentId: 'agent_codex_host',
        profileRef: 'profile_worker',
        priorityClass: 'interactive',
        requiredPoolConstraints: ['openshell.local'],
        now: () => '2026-07-05T00:00:01.000Z',
      });

      await expect(
        runSchedulerDispatchLoop({
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
          providerRegistry: new ProviderRegistry([]),
          schedulerEpoch: 1,
          startupTimeoutMs: 120_000,
          store,
          turnExecutor,
          agentManifests: [
            {
              adapter: 'custom-http',
              deployments: ['local'],
              displayName: 'Codex Agent',
              id: 'agent_codex_host',
              kind: 'custom',
              runtime: 'custom',
              version: '0.0.2',
            },
          ],
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

  it('releases an exact interrupted human-gate fallback lease with recovery evidence required', async () => {
    const coreDb = createMigratedCoreDb();
    const store = createDemoStore();
    const turnExecutor = new RecordingTurnExecutor();
    turnExecutor.startTurn = async (ownerStore, turnId, _input, context) => {
      if (!context?.agentSessionId) {
        throw new Error('Expected scheduler-owned Agent Session lineage.');
      }
      const lease = requireSchedulerSessionLease(coreDb, 'lease_human_gate_fallback');
      recordWorkerBackendSessionMaterializing(coreDb, {
        backendVersion: '0.0.80',
        identity: {
          agentSessionId: context.agentSessionId,
          backendKind: 'openshell',
          backendSessionId: 'openkit-as_human_gate_fallback',
          backendTarget: {
            cellTargetId: 'cell-test',
            gatewayEndpoint: null,
            gatewayName: 'openshell',
            placement: 'local',
          },
          deploymentId: 'deployment-test',
          packageSnapshotId: lease.packageSnapshotId,
          stagingDirectoryRef: 'server/runtime/worker-backend-sessions/human-gate-fallback',
          transientProviderInstanceId: null,
        },
        lineage: { threadId: 'th_demo', turnId, workspaceId: 'ws_demo' },
        now: () => '2026-07-05T00:00:03.000Z',
        sandboxBindingRef: lease.sandboxBindingRef,
        workerImage: 'openkit/worker-codex:dev',
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
        queueEntryId: 'queue_human_gate_fallback',
        requestId: 'req_human_gate_fallback',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_human_gate_fallback',
        turnInput: 'Ask for unavailable input',
        requestedAgentId: 'agent_codex_host',
        profileRef: 'profile_worker',
        priorityClass: 'interactive',
        requiredPoolConstraints: ['openshell.local'],
        now: () => '2026-07-05T00:00:01.000Z',
      });

      await expect(
        runSchedulerDispatchLoop({
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
          providerRegistry: new ProviderRegistry([]),
          schedulerEpoch: 1,
          startupTimeoutMs: 120_000,
          store,
          turnExecutor,
          agentManifests: [
            {
              adapter: 'custom-http',
              deployments: ['local'],
              displayName: 'Codex Agent',
              id: 'agent_codex_host',
              kind: 'custom',
              runtime: 'custom',
              version: '0.0.2',
            },
          ],
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

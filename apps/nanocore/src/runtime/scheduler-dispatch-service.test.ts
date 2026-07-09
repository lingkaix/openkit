import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FsStore } from '../lib/store';
import { ProviderRegistry } from '../providers/registry';
import {
  createSchedulerAdmissionEntry,
  upsertSchedulerCapacityRecord,
  upsertSchedulerTargetHealthRecord,
  upsertSchedulerWorkerPool,
} from '../scheduler-records';
import { openCoreDb } from '../storage/db';
import { applyMigrations } from '../storage/migrate';
import { runSchedulerDispatchRetryOnce } from './scheduler-dispatch-service';
import type { TurnExecutor, TurnStartRuntimeContext } from './types';

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
    storeUserId: string;
    turnId: string;
  }> = [];

  /**
   * Records the store selected by background dispatch.
   *
   * @param store User-scoped store selected for the queued admission.
   * @param turnId Turn id selected by the scheduler queue entry.
   * @param input Turn input captured in the scheduler queue entry.
   * @param context Runtime context forwarded to the worker executor.
   */
  public async startTurn(
    store: FsStore,
    turnId: string,
    input: string,
    context?: TurnStartRuntimeContext
  ): Promise<void> {
    this.calls.push({ context, input, storeUserId: store.getUserId(), turnId });
  }

  /** No-op interrupt implementation. */
  public async interruptTurn(): Promise<void> {}
}

/**
 * Creates an isolated migrated Core database for dispatch-service tests.
 *
 * @returns Open Core database handle.
 */
function createMigratedCoreDb() {
  const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-scheduler-dispatch-service-')));
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
    allowedBackendKinds: ['openshell'],
    allowedPlacements: ['local'],
    allowedWorkspaceScopes: ['local'],
    budgetClass: 'interactive',
    currentAdmittedSessionCount: 0,
    currentQueueDepth: 1,
    defaultTimeoutMs: 900_000,
    healthSummary: 'ready',
    maxConcurrentSessions: 1,
    poolId: 'pool_local',
    queueLimit: 20,
    status: 'active',
    warmSessionTarget: 0,
  });
  upsertSchedulerCapacityRecord(coreDb, {
    capacityClass: 'local',
    concurrencyCeiling: 1,
    inUseCount: 0,
    observedAt: '2026-07-05T00:00:00.000Z',
    observationSource: 'configured',
    poolId: 'pool_local',
    queueDepth: 0,
    targetId: 'target_local',
  });
  upsertSchedulerTargetHealthRecord(coreDb, {
    checkResults: [],
    consecutiveFailureCount: 0,
    consecutiveSuccessCount: 1,
    healthState: 'healthy',
    lastProbeAt: '2026-07-05T00:00:00.000Z',
    nextProbeAt: '2026-07-05T00:01:00.000Z',
    targetId: 'target_local',
  });
}

describe('scheduler dispatch service', () => {
  it('starts queued turns through the admission owner store', async () => {
    const coreDb = createMigratedCoreDb();
    const userStore = new FsStore({ userId: 'user_background' });
    const workspace = userStore.createWorkspace('Background dispatch workspace');
    const thread = userStore.createThread(workspace.id, 'Background dispatch thread');
    const stores = new Map<string, FsStore>([
      ['user_background', userStore],
      ['user_local', new FsStore()],
    ]);
    const turnExecutor = new RecordingTurnExecutor();

    try {
      seedLocalSchedulerTarget(coreDb);
      createSchedulerAdmissionEntry(coreDb, {
        priorityClass: 'interactive',
        profileRef: 'profile_worker',
        queueEntryId: 'queue_background',
        requestedAgentId: 'agent_codex_host',
        requiredPoolConstraints: ['openshell.local'],
        threadId: thread.id,
        turnId: 'turn_background',
        turnInput: 'Run from the owner store',
        userId: 'user_background',
        workspaceId: workspace.id,
        workspaceCwd: '/workspace/background',
        workspaceRoots: [
          {
            access: 'read-write',
            id: 'repo',
            sourceKind: 'host-dir',
            sourcePath: '/host/background',
            workerPath: '/workspace/background',
          },
        ],
        now: () => '2026-07-05T00:00:01.000Z',
      });

      const result = await runSchedulerDispatchRetryOnce({
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
        createAgentSessionId: () => 'as_background',
        createLeaseId: () => 'lease_background',
        createPlanId: () => 'plan_background',
        expectedControlMode: 'poll',
        expectedDataPlaneMode: 'openshell-files',
        heartbeatIntervalMs: 10_000,
        heartbeatTimeoutMs: 30_000,
        leaseDurationMs: 900_000,
        maxDispatches: 1,
        providerRegistry: new ProviderRegistry([]),
        schedulerEpoch: 1,
        startupTimeoutMs: 120_000,
        storeForUserId: (userId) => stores.get(userId) ?? new FsStore({ userId }),
        turnExecutor,
      });

      expect(result?.startedTurns).toHaveLength(1);
      expect(turnExecutor.calls).toMatchObject([
        {
          input: 'Run from the owner store',
          storeUserId: 'user_background',
          turnId: 'turn_background',
        },
      ]);
      expect(turnExecutor.calls[0]?.context).toMatchObject({
        workspaceCwd: '/workspace/background',
        workspaceRoots: [
          {
            access: 'read-write',
            id: 'repo',
            sourceKind: 'host-dir',
            sourcePath: '/host/background',
            workerPath: '/workspace/background',
          },
        ],
      });
    } finally {
      coreDb.sqlite.close();
    }
  });
});

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';
import { FsStore } from '../lib/store.js';
import { ProviderRegistry } from '../providers/registry.js';
import {
  acceptSchedulerLeaseHeartbeat,
  createSchedulerAdmissionEntry,
  dispatchNextSchedulerEntry,
  markSchedulerSessionLeaseReleasing,
  requireSchedulerSessionLeaseAdmissionContext,
  upsertSchedulerCapacityRecord,
  upsertSchedulerTargetHealthRecord,
  upsertSchedulerWorkerPool,
} from '../scheduler-records.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { LOCAL_USER_ID } from '../storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { recordTestAgentEnvironmentPackage } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { listExportableAgentEnvironmentPackageSnapshots } from './aep-snapshot-ledger.js';
import { listWorkspaceRuntimeEvidence } from './runtime-evidence.js';
import { runSchedulerDispatchRetryOnce } from './scheduler-dispatch-service.js';
import { runSchedulerRestartRecovery } from './scheduler-restart-recovery.js';
import type { TurnExecutor } from './types.js';
import {
  getWorkerBackendSession,
  markWorkerBackendWorkspaceHandoffComplete,
  recordWorkerBackendSessionMaterializing,
  transitionWorkerBackendSessionState,
  type WorkerBackendSessionState,
} from './worker-backend-sessions.js';
import { terminalizeGovernedWorkerTurnFailure } from './worker-turn-failure.js';
import {
  buildWorkspaceInputSnapshots,
  buildWorkspaceMaterializationRecords,
} from './workspace-materializer.js';
import {
  listBackendWorkspaceHandles,
  recordWorkspaceInputSnapshots,
  recordWorkspaceMaterializationRecords,
} from './workspace-sync-records.js';

/** Creates an isolated migrated Core database for restart recovery tests. */
function createMigratedCoreDb() {
  const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-scheduler-restart-')));
  applyMigrations(coreDb);
  return coreDb;
}

/** Seeds one dispatchable scheduler target. */
function seedTarget(coreDb: ReturnType<typeof createMigratedCoreDb>, suffix: string): void {
  upsertSchedulerWorkerPool(coreDb, {
    allowedBackendKinds: ['openshell'],
    allowedPlacements: ['local'],
    allowedWorkspaceScopes: ['local'],
    budgetClass: 'interactive',
    currentAdmittedSessionCount: 0,
    currentQueueDepth: 1,
    defaultTimeoutMs: 900_000,
    healthSummary: 'ready',
    maxConcurrentSessions: 3,
    poolId: `pool_${suffix}`,
    queueLimit: 20,
    status: 'active',
  });
  upsertSchedulerCapacityRecord(coreDb, {
    capacityClass: 'local',
    concurrencyCeiling: 3,
    inUseCount: 0,
    observationSource: 'configured',
    observedAt: '2026-07-05T00:00:00.000Z',
    poolId: `pool_${suffix}`,
    queueDepth: 0,
    targetId: `target_${suffix}`,
  });
  upsertSchedulerTargetHealthRecord(coreDb, {
    checkResults: [],
    consecutiveFailureCount: 0,
    consecutiveSuccessCount: 1,
    healthState: 'healthy',
    lastProbeAt: '2026-07-05T00:00:00.000Z',
    nextProbeAt: '2026-07-05T00:01:00.000Z',
    targetId: `target_${suffix}`,
  });
}

/** Dispatches one lease for restart recovery tests. */
function dispatchLease(
  coreDb: ReturnType<typeof createMigratedCoreDb>,
  suffix: string,
  userId = LOCAL_USER_ID
): void {
  seedTarget(coreDb, suffix);
  createSchedulerAdmissionEntry(coreDb, {
    priorityClass: 'interactive',
    profileRef: 'profile_worker',
    queueEntryId: `queue_${suffix}`,
    requestedAgentId: 'agent_codex_host',
    requiredPoolConstraints: ['openshell.local'],
    threadId: `thread_${suffix}`,
    turnId: `turn_${suffix}`,
    turnInput: `Run ${suffix}`,
    userId,
    workspaceId: 'ws_demo',
    now: () => '2026-07-05T00:00:01.000Z',
  });
  dispatchNextSchedulerEntry(coreDb, {
    agentSessionId: `as_${suffix}`,
    expectedControlMode: 'poll',
    expectedDataPlaneMode: 'openshell-files',
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 30_000,
    leaseDurationMs: 900_000,
    leaseId: `lease_${suffix}`,
    now: () => '2026-07-05T00:00:02.000Z',
    planId: `plan_${suffix}`,
    sandboxBindingRef: `lease-binding:lease_${suffix}`,
    schedulerEpoch: 7,
    startupTimeoutMs: 120_000,
  });
}

/** Records one durable backend anchor and advances it to the requested state. */
function recordBackendSession(
  coreDb: ReturnType<typeof createMigratedCoreDb>,
  suffix: string,
  state: WorkerBackendSessionState = 'materializing'
): void {
  const { userId } = requireSchedulerSessionLeaseAdmissionContext(coreDb, `lease_${suffix}`);
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, userId, 'ws_demo');
  try {
    applyScopedMigrations(workspaceDb);
    if (
      !listExportableAgentEnvironmentPackageSnapshots(workspaceDb, 'ws_demo').some(
        (record) => record.snapshotId === `aepsnap_turn_${suffix}_as_${suffix}`
      )
    ) {
      recordTestAgentEnvironmentPackage(workspaceDb, { suffix, workspaceInputIds: [] });
    }
  } finally {
    workspaceDb.sqlite.close();
  }
  recordWorkerBackendSessionMaterializing(coreDb, {
    backendVersion: '0.0.80',
    workerImage: 'openkit/worker-codex:dev',
    identity: {
      agentSessionId: `as_${suffix}`,
      backendKind: 'openshell',
      backendSessionId: `openkit-as_${suffix}`,
      backendTarget: {
        cellTargetId: 'cell-test',
        gatewayEndpoint: null,
        gatewayName: 'openshell',
        placement: 'local',
      },
      deploymentId: 'deployment-test',
      packageSnapshotId: `aepsnap_turn_${suffix}_as_${suffix}`,
      stagingDirectoryRef: `server/runtime/worker-backend-sessions/aepsnap_turn_${suffix}_as_${suffix}`,
      transientProviderInstanceId: null,
    },
    lineage: {
      threadId: `thread_${suffix}`,
      turnId: `turn_${suffix}`,
      workspaceId: 'ws_demo',
    },
    now: () => '2026-07-05T00:00:03.000Z',
    sandboxBindingRef: `lease-binding:lease_${suffix}`,
  });
  const path: WorkerBackendSessionState[] =
    state === 'materializing'
      ? []
      : state === 'materialized'
        ? ['materialized']
        : state === 'launching'
          ? ['materialized', 'launching']
          : state === 'cleanup-pending'
            ? ['cleanup-pending']
            : state === 'cleanup-failed'
              ? ['cleanup-pending', 'cleanup-failed']
              : state === 'physical-cleaned'
                ? ['cleanup-pending', 'physical-cleaned']
                : ['cleanup-pending', 'physical-cleaned', 'cleaned'];
  let fromState: WorkerBackendSessionState = 'materializing';
  for (const toState of path) {
    transitionWorkerBackendSessionState(coreDb, {
      fromState,
      leaseId: `lease_${suffix}`,
      toState,
    });
    fromState = toState;
  }
}

/** Records the production-shaped workspace handoff for one immutable package. */
function recordCanonicalWorkspaceHandoff(
  workspaceDb: ReturnType<typeof openWorkspaceDb>,
  environmentPackage: AgentEnvironmentPackage,
  createdAt: string
): void {
  const inputSnapshots = recordWorkspaceInputSnapshots(
    workspaceDb,
    buildWorkspaceInputSnapshots({
      backendCapabilities: ['trusted-worker-inference-relay'],
      backendKind: 'openshell',
      createdAt,
      environmentPackage,
    })
  );
  recordWorkspaceMaterializationRecords(
    workspaceDb,
    buildWorkspaceMaterializationRecords({
      createdAt,
      inputSnapshots,
      materialization: {
        backendKind: 'openshell',
        backendStatus: { health: 'ready', version: '0.0.80' },
        packageSnapshotId: environmentPackage.snapshotId,
        requiredCapabilities: environmentPackage.backend.requiredCapabilities,
        sandbox: {
          name: `openkit-${environmentPackage.scope.agentSessionId}`,
          state: 'created',
        },
        workspaceInputs: environmentPackage.workspace.inputs.map((input) => ({
          id: input.id,
          target: input.target,
        })),
      },
    })
  );
}

/** Executor that fails if a recovered admission is dispatched again. */
class RejectRecoveredTurnExecutor implements TurnExecutor {
  public readonly capabilities = {
    approvals: false,
    artifacts: false,
    interrupts: false,
    questions: false,
    workspaceConfig: false,
    workspaceKnowledgeEditing: false,
  };
  public readonly eventFamilies = ['turn.started'] as const;
  public readonly itemTypes = ['status'] as const;
  public readonly calls: string[] = [];

  /** Records the forbidden redispatch before failing the test. */
  public async startTurn(_store: FsStore, turnId: string): Promise<void> {
    this.calls.push(turnId);
    throw new Error(`Recovered turn was dispatched again: ${turnId}`);
  }

  /** No-op because restart recovery never invokes commands. */
  public async interruptTurn(): Promise<void> {}
}

describe('scheduler restart recovery', () => {
  it('fails pre-anchor acquired leases and cancels their admission entries', async () => {
    const coreDb = createMigratedCoreDb();

    try {
      dispatchLease(coreDb, 'prelaunch');

      const result = await runSchedulerRestartRecovery(coreDb, {
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      const rows = coreDb.sqlite
        .prepare(
          `SELECT
            leases.status AS leaseStatus,
            leases.release_reason AS releaseReason,
            leases.scheduler_epoch AS schedulerEpoch,
            plans.status AS planStatus,
            entries.status AS queueStatus,
            capacity.in_use_count AS inUseCount,
            pools.current_admitted_session_count AS admittedCount,
            pools.current_queue_depth AS queueDepth
          FROM scheduler_session_leases AS leases
          JOIN scheduler_placement_plans AS plans ON plans.plan_id = leases.plan_id
          JOIN scheduler_admission_entries AS entries ON entries.queue_entry_id = plans.queue_entry_id
          JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
          JOIN scheduler_worker_pools AS pools ON pools.pool_id = leases.pool_id
          WHERE leases.lease_id = 'lease_prelaunch'`
        )
        .get();

      expect(result).toEqual({
        adoptedLeaseIds: [],
        preLaunchFailedLeaseIds: ['lease_prelaunch'],
        schedulerEpoch: 8,
        staleLeaseIds: [],
      });
      expect(rows).toEqual({
        admittedCount: 0,
        inUseCount: 0,
        leaseStatus: 'failed',
        planStatus: 'abandoned',
        queueDepth: 0,
        queueStatus: 'cancelled',
        releaseReason: 'scheduler-restart-pre-anchor',
        schedulerEpoch: 8,
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('keeps a pre-anchor lease admitted until product projection succeeds', async () => {
    const coreDb = createMigratedCoreDb();
    const suffix = 'prelaunch_projection_retry';
    let projectionAttempts = 0;

    try {
      dispatchLease(coreDb, suffix);

      await expect(
        runSchedulerRestartRecovery(coreDb, {
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => {
            projectionAttempts += 1;
            throw new Error('pre-anchor product projection failed');
          },
        })
      ).rejects.toThrow('pre-anchor product projection failed');
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, entries.status AS queueStatus,
                    capacity.in_use_count AS inUseCount,
                    pools.current_admitted_session_count AS admittedCount
             FROM scheduler_session_leases AS leases
             JOIN scheduler_placement_plans AS plans ON plans.plan_id = leases.plan_id
             JOIN scheduler_admission_entries AS entries ON entries.queue_entry_id = plans.queue_entry_id
             JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
             JOIN scheduler_worker_pools AS pools ON pools.pool_id = leases.pool_id
             WHERE leases.lease_id = ?`
          )
          .get(`lease_${suffix}`)
      ).toEqual({ admittedCount: 1, inUseCount: 1, queueStatus: 'admitted', status: 'acquired' });

      await runSchedulerRestartRecovery(coreDb, {
        now: () => '2026-07-05T00:01:01.000Z',
        projectRecoveredTurn: async () => {
          projectionAttempts += 1;
          return { status: 'failed' as const };
        },
      });

      expect(projectionAttempts).toBe(2);
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, entries.status AS queueStatus,
                    capacity.in_use_count AS inUseCount,
                    pools.current_admitted_session_count AS admittedCount
             FROM scheduler_session_leases AS leases
             JOIN scheduler_placement_plans AS plans ON plans.plan_id = leases.plan_id
             JOIN scheduler_admission_entries AS entries ON entries.queue_entry_id = plans.queue_entry_id
             JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
             JOIN scheduler_worker_pools AS pools ON pools.pool_id = leases.pool_id
             WHERE leases.lease_id = ?`
          )
          .get(`lease_${suffix}`)
      ).toEqual({ admittedCount: 0, inUseCount: 0, queueStatus: 'cancelled', status: 'failed' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    ['restart_workspace', ['repo']],
    ['restart_zero_input', []],
  ] as const)('projects %s cleanup into one package-level teardown record', async (suffix, workspaceInputIds) => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, LOCAL_USER_ID, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, suffix);
      const environmentPackage = recordTestAgentEnvironmentPackage(workspaceDb, {
        suffix,
        workspaceInputIds,
      });
      if (workspaceInputIds.length > 0) {
        recordCanonicalWorkspaceHandoff(
          workspaceDb,
          environmentPackage,
          '2026-07-05T00:00:10.000Z'
        );
      }
      recordBackendSession(coreDb, suffix, 'launching');

      await runSchedulerRestartRecovery(coreDb, {
        cleanupBackendSession: async () => undefined,
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      await runSchedulerRestartRecovery(coreDb, {
        cleanupBackendSession: async () => {
          throw new Error('Terminal backend session must not be cleaned twice.');
        },
        now: () => '2026-07-05T00:02:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });

      expect(listBackendWorkspaceHandles(workspaceDb, 'ws_demo')).toEqual(
        workspaceInputIds.length > 0 ? [expect.objectContaining({ cleanupStatus: 'cleaned' })] : []
      );
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
          (record) => record.phase === 'teardown'
        )
      ).toEqual([
        expect.objectContaining({
          agentSessionId: `as_${suffix}`,
          outcome: 'succeeded',
          stopReason: 'completed',
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('repairs a pending exact handoff without changing physical cleanup evidence time', async () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, LOCAL_USER_ID, 'ws_demo');
    const suffix = 'restart_handoff_marker_repair';
    const clocks = [
      '2026-07-05T00:01:00.000Z',
      '2026-07-05T00:01:01.000Z',
      '2026-07-05T00:01:02.000Z',
    ];

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, suffix);
      const environmentPackage = recordTestAgentEnvironmentPackage(workspaceDb, {
        suffix,
        workspaceInputIds: ['repo'],
      });
      recordCanonicalWorkspaceHandoff(workspaceDb, environmentPackage, '2026-07-05T00:00:10.000Z');
      recordBackendSession(coreDb, suffix, 'launching');

      await expect(
        runSchedulerRestartRecovery(coreDb, {
          cleanupBackendSession: async () => undefined,
          now: () => clocks.shift() ?? '2026-07-05T00:01:03.000Z',
          projectRecoveredTurn: async () => {
            throw new Error('product projection crash after handoff repair');
          },
        })
      ).rejects.toThrow('product projection crash after handoff repair');
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        physicalCleanedAt: '2026-07-05T00:01:01.000Z',
        state: 'physical-cleaned',
        updatedAt: '2026-07-05T00:01:02.000Z',
        workspaceHandoffState: 'complete',
      });

      await runSchedulerRestartRecovery(coreDb, {
        cleanupBackendSession: async () => {
          throw new Error('Physical cleanup must not replay after marker repair.');
        },
        now: () => '2026-07-05T00:02:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
          (record) => record.phase === 'teardown'
        )
      ).toEqual([
        expect.objectContaining({
          completedAt: '2026-07-05T00:01:01.000Z',
          outcome: 'succeeded',
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('holds capacity when Core claims a complete handoff but its workspace rows are missing', async () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, LOCAL_USER_ID, 'ws_demo');
    const suffix = 'restart_missing_workspace_handle';
    let cleanupCalls = 0;

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, suffix);
      const environmentPackage = recordTestAgentEnvironmentPackage(workspaceDb, {
        suffix,
        workspaceInputIds: ['repo'],
      });
      recordBackendSession(coreDb, suffix, 'launching');
      markWorkerBackendWorkspaceHandoffComplete(coreDb, {
        leaseId: `lease_${suffix}`,
        now: () => '2026-07-05T00:00:11.000Z',
      });

      await expect(
        runSchedulerRestartRecovery(coreDb, {
          cleanupBackendSession: async () => {
            cleanupCalls += 1;
          },
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        })
      ).rejects.toThrow('backend handle handoff is incomplete');
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'physical-cleaned',
      });
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, capacity.in_use_count AS inUseCount
             FROM scheduler_session_leases AS leases
             JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
             WHERE leases.lease_id = ?`
          )
          .get(`lease_${suffix}`)
      ).toEqual({ inUseCount: 1, status: 'acquired' });

      recordCanonicalWorkspaceHandoff(workspaceDb, environmentPackage, '2026-07-05T00:01:01.000Z');
      await runSchedulerRestartRecovery(coreDb, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        now: () => '2026-07-05T00:01:02.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });

      expect(cleanupCalls).toBe(1);
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'cleaned',
      });
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM scheduler_session_leases WHERE lease_id = ?')
          .get(`lease_${suffix}`)
      ).toEqual({ status: 'failed' });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('rejects a workspace handle owned by a different physical backend session', async () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, LOCAL_USER_ID, 'ws_demo');
    const suffix = 'restart_mismatched_workspace_handle';

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, suffix);
      const environmentPackage = recordTestAgentEnvironmentPackage(workspaceDb, {
        suffix,
        workspaceInputIds: ['repo'],
      });
      recordCanonicalWorkspaceHandoff(workspaceDb, environmentPackage, '2026-07-05T00:00:10.000Z');
      const row = workspaceDb.sqlite
        .prepare(
          'SELECT backend_workspace_handle_id AS id, payload_json AS payloadJson FROM backend_workspace_handles LIMIT 1'
        )
        .get() as { id: string; payloadJson: string };
      workspaceDb.sqlite
        .prepare(
          'UPDATE backend_workspace_handles SET payload_json = ? WHERE backend_workspace_handle_id = ?'
        )
        .run(
          JSON.stringify({
            ...(JSON.parse(row.payloadJson) as Record<string, unknown>),
            workerSessionId: 'openkit-as_attacker',
          }),
          row.id
        );
      recordBackendSession(coreDb, suffix, 'physical-cleaned');

      await expect(
        runSchedulerRestartRecovery(coreDb, {
          cleanupBackendSession: async () => {
            throw new Error('Physical cleanup must not replay.');
          },
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        })
      ).rejects.toThrow('backend handle handoff is incomplete');
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'physical-cleaned',
      });
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
          (record) => record.phase === 'teardown'
        )
      ).toEqual([]);
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, capacity.in_use_count AS inUseCount
             FROM scheduler_session_leases AS leases
             JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
             WHERE leases.lease_id = ?`
          )
          .get(`lease_${suffix}`)
      ).toEqual({ inUseCount: 1, status: 'acquired' });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it.each([
    ['before heartbeat', false, 'materializing'],
    ['after heartbeat', true, 'launching'],
  ] as const)('cleans and terminalizes an anchored lease %s before releasing capacity', async (_description, heartbeat, anchorState) => {
    const coreDb = createMigratedCoreDb();
    const suffix = heartbeat ? 'restart_anchor_live' : 'restart_anchor_acquired';
    const cleanupObservations: unknown[] = [];

    try {
      dispatchLease(coreDb, suffix);
      if (heartbeat) {
        acceptSchedulerLeaseHeartbeat(coreDb, {
          heartbeatTimeoutMs: 900_000,
          leaseId: `lease_${suffix}`,
          now: () => '2026-07-05T00:00:10.000Z',
          workerSequence: 1,
        });
      }
      recordBackendSession(coreDb, suffix, anchorState);

      await runSchedulerRestartRecovery(coreDb, {
        cleanupBackendSession: async (session) => {
          cleanupObservations.push({
            anchor: getWorkerBackendSession(coreDb, session.leaseId),
            state: coreDb.sqlite
              .prepare(
                `SELECT leases.status, capacity.in_use_count AS inUseCount,
                          pools.current_admitted_session_count AS admittedCount
                   FROM scheduler_session_leases AS leases
                   JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
                   JOIN scheduler_worker_pools AS pools ON pools.pool_id = leases.pool_id
                   WHERE leases.lease_id = ?`
              )
              .get(session.leaseId),
          });
        },
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        now: () => '2026-07-05T00:01:00.000Z',
      });

      expect(cleanupObservations).toEqual([
        {
          anchor: expect.objectContaining({ state: 'cleanup-pending' }),
          state: {
            admittedCount: 1,
            inUseCount: 1,
            status: heartbeat ? 'active' : 'acquired',
          },
        },
      ]);
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'cleaned',
      });
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, leases.release_reason AS releaseReason,
                      plans.status AS planStatus, entries.status AS queueStatus,
                      capacity.in_use_count AS inUseCount,
                      pools.current_admitted_session_count AS admittedCount
               FROM scheduler_session_leases AS leases
               JOIN scheduler_placement_plans AS plans ON plans.plan_id = leases.plan_id
               JOIN scheduler_admission_entries AS entries ON entries.queue_entry_id = plans.queue_entry_id
               JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
               JOIN scheduler_worker_pools AS pools ON pools.pool_id = leases.pool_id
               WHERE leases.lease_id = ?`
          )
          .get(`lease_${suffix}`)
      ).toEqual({
        admittedCount: 0,
        inUseCount: 0,
        planStatus: 'completed',
        queueStatus: 'admitted',
        releaseReason: 'scheduler-restart-backend-cleanup',
        status: 'failed',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('fails critical restart without releasing admission when backend cleanup fails, then retries', async () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, LOCAL_USER_ID, 'ws_demo');
    const suffix = 'restart_cleanup_retry';
    let cleanupAttempts = 0;

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, suffix);
      acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 900_000,
        leaseId: `lease_${suffix}`,
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });
      recordBackendSession(coreDb, suffix, 'launching');

      await expect(
        runSchedulerRestartRecovery(coreDb, {
          cleanupBackendSession: async () => {
            cleanupAttempts += 1;
            throw new Error('Cell recycle failed');
          },
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        })
      ).rejects.toThrow('Cell recycle failed');
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'cleanup-failed',
      });
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
          (record) => record.phase === 'teardown'
        )
      ).toEqual([]);
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, entries.status AS queueStatus,
                    capacity.in_use_count AS inUseCount,
                    pools.current_admitted_session_count AS admittedCount
             FROM scheduler_session_leases AS leases
             JOIN scheduler_placement_plans AS plans ON plans.plan_id = leases.plan_id
             JOIN scheduler_admission_entries AS entries ON entries.queue_entry_id = plans.queue_entry_id
             JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
             JOIN scheduler_worker_pools AS pools ON pools.pool_id = leases.pool_id
             WHERE leases.lease_id = ?`
          )
          .get(`lease_${suffix}`)
      ).toEqual({ admittedCount: 1, inUseCount: 1, queueStatus: 'admitted', status: 'active' });

      await runSchedulerRestartRecovery(coreDb, {
        cleanupBackendSession: async () => {
          cleanupAttempts += 1;
        },
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        now: () => '2026-07-05T00:01:01.000Z',
      });
      expect(cleanupAttempts).toBe(2);
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'cleaned',
      });
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM scheduler_session_leases WHERE lease_id = ?')
          .get(`lease_${suffix}`)
      ).toEqual({ status: 'failed' });
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
          (record) => record.phase === 'teardown'
        )
      ).toEqual([expect.objectContaining({ outcome: 'succeeded' })]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('terminalizes a cleaned releasing anchor without cleanup, redispatch, or adoption', async () => {
    const coreDb = createMigratedCoreDb();
    const suffix = 'restart_already_cleaned';
    let cleanupCalls = 0;

    try {
      dispatchLease(coreDb, suffix);
      acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 900_000,
        leaseId: `lease_${suffix}`,
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });
      recordBackendSession(coreDb, suffix, 'cleaned');
      markSchedulerSessionLeaseReleasing(coreDb, {
        leaseId: `lease_${suffix}`,
        now: () => '2026-07-05T00:00:11.000Z',
        releaseReason: 'worker-final-status',
      });

      const result = await runSchedulerRestartRecovery(coreDb, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        now: () => '2026-07-05T00:01:00.000Z',
      });

      expect(cleanupCalls).toBe(0);
      expect(result.adoptedLeaseIds).not.toContain(`lease_${suffix}`);
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, entries.status AS queueStatus,
                    capacity.in_use_count AS inUseCount
             FROM scheduler_session_leases AS leases
             JOIN scheduler_placement_plans AS plans ON plans.plan_id = leases.plan_id
             JOIN scheduler_admission_entries AS entries ON entries.queue_entry_id = plans.queue_entry_id
             JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
             WHERE leases.lease_id = ?`
          )
          .get(`lease_${suffix}`)
      ).toEqual({ inUseCount: 0, queueStatus: 'admitted', status: 'failed' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('cleans a stale anchored lease instead of skipping it with capacity occupied', async () => {
    const coreDb = createMigratedCoreDb();
    const suffix = 'restart_stale_anchor';

    try {
      dispatchLease(coreDb, suffix);
      recordBackendSession(coreDb, suffix, 'launching');
      coreDb.sqlite
        .prepare(
          "UPDATE scheduler_session_leases SET status = 'stale', release_reason = 'heartbeat-timeout' WHERE lease_id = ?"
        )
        .run(`lease_${suffix}`);

      await runSchedulerRestartRecovery(coreDb, {
        cleanupBackendSession: async () => undefined,
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });

      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'cleaned',
      });
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, entries.status AS queueStatus,
                    capacity.in_use_count AS inUseCount
             FROM scheduler_session_leases AS leases
             JOIN scheduler_placement_plans AS plans ON plans.plan_id = leases.plan_id
             JOIN scheduler_admission_entries AS entries ON entries.queue_entry_id = plans.queue_entry_id
             JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
             WHERE leases.lease_id = ?`
          )
          .get(`lease_${suffix}`)
      ).toEqual({ inUseCount: 0, queueStatus: 'admitted', status: 'failed' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('projects an expired cleaned releasing lease before one unified terminal release', async () => {
    const coreDb = createMigratedCoreDb();
    const suffix = 'restart_cleaned_expired_release';
    const projectionStates: unknown[] = [];
    let cleanupCalls = 0;

    try {
      dispatchLease(coreDb, suffix);
      recordBackendSession(coreDb, suffix, 'cleaned');
      markSchedulerSessionLeaseReleasing(coreDb, {
        leaseId: `lease_${suffix}`,
        now: () => '2026-07-05T00:00:10.000Z',
        releaseReason: 'worker-final-status',
      });
      coreDb.sqlite
        .prepare('UPDATE scheduler_session_leases SET expires_at = ? WHERE lease_id = ?')
        .run('2026-07-05T00:00:30.000Z', `lease_${suffix}`);

      await runSchedulerRestartRecovery(coreDb, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => {
          projectionStates.push(
            coreDb.sqlite
              .prepare(
                `SELECT leases.status, capacity.in_use_count AS inUseCount
                 FROM scheduler_session_leases AS leases
                 JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
                 WHERE leases.lease_id = ?`
              )
              .get(`lease_${suffix}`)
          );
          return { status: 'failed' as const };
        },
      });

      expect(cleanupCalls).toBe(0);
      expect(projectionStates).toEqual([{ inUseCount: 1, status: 'releasing' }]);
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, entries.status AS queueStatus,
                    capacity.in_use_count AS inUseCount
             FROM scheduler_session_leases AS leases
             JOIN scheduler_placement_plans AS plans ON plans.plan_id = leases.plan_id
             JOIN scheduler_admission_entries AS entries ON entries.queue_entry_id = plans.queue_entry_id
             JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
             WHERE leases.lease_id = ?`
          )
          .get(`lease_${suffix}`)
      ).toEqual({ inUseCount: 0, queueStatus: 'admitted', status: 'failed' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('maps an already completed product turn to a released lease without failing it', async () => {
    const coreDb = createMigratedCoreDb();
    const suffix = 'restart_completed_product';

    try {
      dispatchLease(coreDb, suffix);
      recordBackendSession(coreDb, suffix, 'cleaned');

      await runSchedulerRestartRecovery(coreDb, {
        cleanupBackendSession: async () => {
          throw new Error('Cleaned session must not be cleaned twice.');
        },
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'completed' as const }),
      });

      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, leases.release_reason AS releaseReason,
                    entries.status AS queueStatus, capacity.in_use_count AS inUseCount
             FROM scheduler_session_leases AS leases
             JOIN scheduler_placement_plans AS plans ON plans.plan_id = leases.plan_id
             JOIN scheduler_admission_entries AS entries ON entries.queue_entry_id = plans.queue_entry_id
             JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
             WHERE leases.lease_id = ?`
          )
          .get(`lease_${suffix}`)
      ).toEqual({
        inUseCount: 0,
        queueStatus: 'admitted',
        releaseReason: 'scheduler-restart-turn-completed',
        status: 'released',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('keeps cleaned backend capacity occupied until product turn projection succeeds', async () => {
    const coreDb = createMigratedCoreDb();
    const suffix = 'restart_projection_retry';
    let projectionAttempts = 0;
    let cleanupCalls = 0;

    try {
      dispatchLease(coreDb, suffix);
      recordBackendSession(coreDb, suffix, 'launching');

      await expect(
        runSchedulerRestartRecovery(coreDb, {
          cleanupBackendSession: async () => {
            cleanupCalls += 1;
          },
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => {
            projectionAttempts += 1;
            throw new Error('product store write failed');
          },
        })
      ).rejects.toThrow('product store write failed');
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'physical-cleaned',
      });
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, capacity.in_use_count AS inUseCount
             FROM scheduler_session_leases AS leases
             JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
             WHERE leases.lease_id = ?`
          )
          .get(`lease_${suffix}`)
      ).toEqual({ inUseCount: 1, status: 'acquired' });

      await runSchedulerRestartRecovery(coreDb, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        now: () => '2026-07-05T00:01:01.000Z',
        projectRecoveredTurn: async () => {
          projectionAttempts += 1;
          return { status: 'failed' as const };
        },
      });
      expect(cleanupCalls).toBe(1);
      expect(projectionAttempts).toBe(2);
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'cleaned',
      });
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, capacity.in_use_count AS inUseCount
             FROM scheduler_session_leases AS leases
             JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
             WHERE leases.lease_id = ?`
          )
          .get(`lease_${suffix}`)
      ).toEqual({ inUseCount: 0, status: 'failed' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('replays a cleaned zero-input teardown at a later time without duplicating evidence', async () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, LOCAL_USER_ID, 'ws_demo');
    const suffix = 'restart_cleaned_evidence_replay';
    let cleanupCalls = 0;

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, suffix);
      recordTestAgentEnvironmentPackage(workspaceDb, { suffix, workspaceInputIds: [] });
      recordBackendSession(coreDb, suffix, 'launching');

      await expect(
        runSchedulerRestartRecovery(coreDb, {
          cleanupBackendSession: async () => {
            cleanupCalls += 1;
          },
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => {
            throw new Error('crash after cleanup projection');
          },
        })
      ).rejects.toThrow('crash after cleanup projection');
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'physical-cleaned',
        updatedAt: '2026-07-05T00:01:00.000Z',
      });
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
          (record) => record.phase === 'teardown'
        )
      ).toHaveLength(1);

      await runSchedulerRestartRecovery(coreDb, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        now: () => '2026-07-05T00:05:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });

      expect(cleanupCalls).toBe(1);
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'cleaned',
      });
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
          (record) => record.phase === 'teardown'
        )
      ).toHaveLength(1);
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM scheduler_session_leases WHERE lease_id = ?')
          .get(`lease_${suffix}`)
      ).toEqual({ status: 'failed' });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('projects a pre-anchor product turn once and prevents its durable admission from redispatch', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-restart-product-projection-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const turnId = 'turn_restart_product_projection';
    const agentSessionId = 'as_restart_product_projection';
    const turn = store.createTurn('ws_demo', 'th_demo', 'Recover this turn', null, { turnId });
    store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: turn.startedAt ?? '2026-07-05T00:00:01.000Z',
      id: agentSessionId,
      message: null,
      status: 'busy',
      threadId: turn.threadId,
      updatedAt: turn.startedAt ?? '2026-07-05T00:00:01.000Z',
      workspaceId: turn.workspaceId,
    });
    seedTarget(coreDb, 'product_projection');
    createSchedulerAdmissionEntry(coreDb, {
      priorityClass: 'interactive',
      profileRef: 'profile_worker',
      queueEntryId: 'queue_product_projection',
      requestedAgentId: 'agent_codex_host',
      requiredPoolConstraints: ['openshell.local'],
      threadId: turn.threadId,
      turnId,
      turnInput: 'Recover this turn',
      workspaceId: turn.workspaceId,
      now: () => '2026-07-05T00:00:01.000Z',
    });
    dispatchNextSchedulerEntry(coreDb, {
      agentSessionId,
      expectedControlMode: 'poll',
      expectedDataPlaneMode: 'openshell-files',
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 30_000,
      leaseDurationMs: 900_000,
      leaseId: 'lease_product_projection',
      now: () => '2026-07-05T00:00:02.000Z',
      packageSnapshotId: 'aepsnap_product_projection',
      planId: 'plan_product_projection',
      sandboxBindingRef: 'lease-binding:lease_product_projection',
      schedulerEpoch: 7,
      startupTimeoutMs: 120_000,
    });
    const project = async () => {
      const result = terminalizeGovernedWorkerTurnFailure({
        agentSessionId,
        completedAt: '2026-07-05T00:01:00.000Z',
        errorCode: 'worker_governance_restart_recovery',
        message: 'Worker execution stopped during NanoCore restart recovery.',
        requestId: null,
        store: new FsStore({ dataRoot }),
        turnId,
      });
      expect(result.status).toBe('failed');
      return { status: 'failed' as const };
    };

    try {
      await runSchedulerRestartRecovery(coreDb, {
        cleanupBackendSession: async () => {
          throw new Error('Pre-anchor recovery must not clean a backend session.');
        },
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: project,
      });
      await runSchedulerRestartRecovery(coreDb, {
        cleanupBackendSession: async () => {
          throw new Error('Terminal recovery must not clean a backend session.');
        },
        now: () => '2026-07-05T00:01:01.000Z',
        projectRecoveredTurn: project,
      });

      const restartedStore = new FsStore({ dataRoot });
      expect(restartedStore.getTurnById(turnId)).toMatchObject({
        error: {
          code: 'worker_governance_restart_recovery',
          message: 'Worker execution stopped during NanoCore restart recovery.',
        },
        status: 'failed',
      });
      expect(restartedStore.getAgentSession(agentSessionId)).toMatchObject({
        message: 'Worker execution stopped during NanoCore restart recovery.',
        status: 'failed',
      });
      expect(
        restartedStore
          .getTurnEvents(turnId)
          .filter(
            (event) =>
              event.event === 'turn.completed' &&
              event.data.type === 'turn-completed' &&
              event.data.stopReason === 'error'
          )
      ).toHaveLength(1);
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, entries.status AS queueStatus,
                    capacity.in_use_count AS inUseCount
             FROM scheduler_session_leases AS leases
             JOIN scheduler_placement_plans AS plans ON plans.plan_id = leases.plan_id
             JOIN scheduler_admission_entries AS entries ON entries.queue_entry_id = plans.queue_entry_id
             JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
             WHERE leases.lease_id = ?`
          )
          .get('lease_product_projection')
      ).toEqual({ inUseCount: 0, queueStatus: 'cancelled', status: 'failed' });

      const turnExecutor = new RejectRecoveredTurnExecutor();
      const retry = await runSchedulerDispatchRetryOnce({
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
        expectedControlMode: 'poll',
        expectedDataPlaneMode: 'openshell-files',
        heartbeatIntervalMs: 10_000,
        heartbeatTimeoutMs: 30_000,
        leaseDurationMs: 900_000,
        maxDispatches: 1,
        providerRegistry: new ProviderRegistry([]),
        schedulerEpoch: 9,
        startupTimeoutMs: 120_000,
        storeForUserId: () => restartedStore,
        turnExecutor,
      });
      expect(retry.startedTurns).toEqual([]);
      expect(retry.terminalResult).toEqual({ reason: 'no-queued-entry', status: 'queued' });
      expect(turnExecutor.calls).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    'starting',
    'active',
    'idle',
    'releasing',
  ] as const)('fails critical restart for %s lease without a durable backend anchor', async (status) => {
    const coreDb = createMigratedCoreDb();
    const suffix = `restart_missing_anchor_${status}`;

    try {
      dispatchLease(coreDb, suffix);
      coreDb.sqlite
        .prepare('UPDATE scheduler_session_leases SET status = ? WHERE lease_id = ?')
        .run(status, `lease_${suffix}`);

      await expect(
        runSchedulerRestartRecovery(coreDb, {
          cleanupBackendSession: async () => undefined,
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        })
      ).rejects.toThrow('has no durable backend session anchor');
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, capacity.in_use_count AS inUseCount
               FROM scheduler_session_leases AS leases
               JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
               WHERE leases.lease_id = ?`
          )
          .get(`lease_${suffix}`)
      ).toEqual({ inUseCount: 1, status });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('fails a stale pre-anchor lease that has no accepted launch heartbeat', async () => {
    const coreDb = createMigratedCoreDb();
    const suffix = 'restart_missing_anchor_stale_prelaunch';

    try {
      dispatchLease(coreDb, suffix);
      coreDb.sqlite
        .prepare(
          "UPDATE scheduler_session_leases SET status = 'stale', release_reason = 'startup-timeout' WHERE lease_id = ?"
        )
        .run(`lease_${suffix}`);

      await runSchedulerRestartRecovery(coreDb, {
        now: () => '2026-07-05T00:03:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });

      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, entries.status AS queueStatus,
                    capacity.in_use_count AS inUseCount
             FROM scheduler_session_leases AS leases
             JOIN scheduler_placement_plans AS plans ON plans.plan_id = leases.plan_id
             JOIN scheduler_admission_entries AS entries ON entries.queue_entry_id = plans.queue_entry_id
             JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
             WHERE leases.lease_id = ?`
          )
          .get(`lease_${suffix}`)
      ).toEqual({ inUseCount: 0, queueStatus: 'cancelled', status: 'failed' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('holds capacity for a stale post-launch lease that has no durable backend anchor', async () => {
    const coreDb = createMigratedCoreDb();
    const suffix = 'restart_missing_anchor_stale_launched';

    try {
      dispatchLease(coreDb, suffix);
      acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        leaseId: `lease_${suffix}`,
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });
      coreDb.sqlite
        .prepare(
          "UPDATE scheduler_session_leases SET status = 'stale', release_reason = 'heartbeat-timeout' WHERE lease_id = ?"
        )
        .run(`lease_${suffix}`);

      await expect(
        runSchedulerRestartRecovery(coreDb, {
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        })
      ).rejects.toThrow('has no durable backend session anchor');
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, capacity.in_use_count AS inUseCount
             FROM scheduler_session_leases AS leases
             JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
             WHERE leases.lease_id = ?`
          )
          .get(`lease_${suffix}`)
      ).toEqual({ inUseCount: 1, status: 'stale' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('does not treat a stale starting lease without a heartbeat as proven pre-anchor', async () => {
    const coreDb = createMigratedCoreDb();
    const suffix = 'restart_missing_anchor_stale_starting';

    try {
      dispatchLease(coreDb, suffix);
      coreDb.sqlite
        .prepare(
          "UPDATE scheduler_session_leases SET status = 'stale', release_reason = 'heartbeat-timeout' WHERE lease_id = ?"
        )
        .run(`lease_${suffix}`);

      await expect(
        runSchedulerRestartRecovery(coreDb, {
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        })
      ).rejects.toThrow('has no durable backend session anchor');
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM scheduler_session_leases WHERE lease_id = ?')
          .get(`lease_${suffix}`)
      ).toEqual({ status: 'stale' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('fails critical for an expired releasing lease without an anchor before grace release', async () => {
    const coreDb = createMigratedCoreDb();
    const suffix = 'restart_missing_anchor_expired_releasing';

    try {
      dispatchLease(coreDb, suffix);
      markSchedulerSessionLeaseReleasing(coreDb, {
        leaseId: `lease_${suffix}`,
        now: () => '2026-07-05T00:00:10.000Z',
        releaseReason: 'worker-final-status',
      });

      await expect(
        runSchedulerRestartRecovery(coreDb, {
          now: () => '2026-07-05T00:06:00.000Z',
          projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        })
      ).rejects.toThrow('has no durable backend session anchor');
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, capacity.in_use_count AS inUseCount
             FROM scheduler_session_leases AS leases
             JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
             WHERE leases.lease_id = ?`
          )
          .get(`lease_${suffix}`)
      ).toEqual({ inUseCount: 1, status: 'releasing' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('projects recovery into the admission owner workspace instead of the local user', async () => {
    const coreDb = createMigratedCoreDb();
    const userId = 'user_recovery_owner';
    const ownerWorkspaceDb = openWorkspaceDb(coreDb.dataRoot, userId, 'ws_demo');
    const localWorkspaceDb = openWorkspaceDb(coreDb.dataRoot, LOCAL_USER_ID, 'ws_demo');
    const suffix = 'restart_owner_workspace';

    try {
      applyScopedMigrations(ownerWorkspaceDb);
      applyScopedMigrations(localWorkspaceDb);
      dispatchLease(coreDb, suffix, userId);
      recordTestAgentEnvironmentPackage(ownerWorkspaceDb, { suffix, workspaceInputIds: [] });
      recordBackendSession(coreDb, suffix, 'launching');

      await runSchedulerRestartRecovery(coreDb, {
        cleanupBackendSession: async () => undefined,
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });

      expect(
        listWorkspaceRuntimeEvidence(ownerWorkspaceDb, 'ws_demo').filter(
          (record) => record.phase === 'teardown'
        )
      ).toHaveLength(1);
      expect(
        listWorkspaceRuntimeEvidence(localWorkspaceDb, 'ws_demo').filter(
          (record) => record.phase === 'teardown'
        )
      ).toEqual([]);
    } finally {
      localWorkspaceDb.sqlite.close();
      ownerWorkspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('attempts every anchored cleanup before reporting aggregated restart failure', async () => {
    const coreDb = createMigratedCoreDb();
    const cleanupCalls: string[] = [];

    try {
      dispatchLease(coreDb, 'aggregate_a');
      dispatchLease(coreDb, 'aggregate_b');
      recordBackendSession(coreDb, 'aggregate_a', 'launching');
      recordBackendSession(coreDb, 'aggregate_b', 'launching');

      await expect(
        runSchedulerRestartRecovery(coreDb, {
          cleanupBackendSession: async (session) => {
            cleanupCalls.push(session.leaseId);
            if (session.leaseId === 'lease_aggregate_a') {
              throw new Error('aggregate cleanup A failed');
            }
          },
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        })
      ).rejects.toThrow('aggregate cleanup A failed');

      expect(cleanupCalls).toEqual(['lease_aggregate_a', 'lease_aggregate_b']);
      expect(getWorkerBackendSession(coreDb, 'lease_aggregate_a')).toMatchObject({
        state: 'cleanup-failed',
      });
      expect(getWorkerBackendSession(coreDb, 'lease_aggregate_b')).toMatchObject({
        state: 'cleaned',
      });
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM scheduler_session_leases WHERE lease_id = ?')
          .get('lease_aggregate_b')
      ).toEqual({ status: 'failed' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('cleans the exact manifest before rejecting mismatched product lineage', async () => {
    const coreDb = createMigratedCoreDb();
    let cleanupCalls = 0;

    try {
      dispatchLease(coreDb, 'mismatched_package');
      recordBackendSession(coreDb, 'mismatched_package', 'launching');
      coreDb.sqlite
        .prepare('UPDATE worker_backend_sessions SET thread_id = ? WHERE lease_id = ?')
        .run('thread_attacker', 'lease_mismatched_package');

      await expect(
        runSchedulerRestartRecovery(coreDb, {
          cleanupBackendSession: async () => {
            cleanupCalls += 1;
          },
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        })
      ).rejects.toThrow('does not match scheduler lineage');

      expect(cleanupCalls).toBe(1);
      expect(getWorkerBackendSession(coreDb, 'lease_mismatched_package')).toMatchObject({
        state: 'physical-cleaned',
      });
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM scheduler_session_leases WHERE lease_id = ?')
          .get('lease_mismatched_package')
      ).toEqual({ status: 'acquired' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('fails critical restart when a backend anchor has no scheduler lease owner', async () => {
    const coreDb = createMigratedCoreDb();
    let cleanupCalls = 0;

    try {
      dispatchLease(coreDb, 'orphan_anchor');
      recordBackendSession(coreDb, 'orphan_anchor', 'launching');
      coreDb.sqlite
        .prepare('DELETE FROM scheduler_session_leases WHERE lease_id = ?')
        .run('lease_orphan_anchor');

      await expect(
        runSchedulerRestartRecovery(coreDb, {
          cleanupBackendSession: async () => {
            cleanupCalls += 1;
          },
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        })
      ).rejects.toThrow('has no non-terminal scheduler lease owner');
      expect(cleanupCalls).toBe(1);
      expect(getWorkerBackendSession(coreDb, 'lease_orphan_anchor')).toMatchObject({
        state: 'physical-cleaned',
      });
      expect(
        coreDb.sqlite
          .prepare('SELECT in_use_count AS inUseCount FROM scheduler_capacity_records')
          .get()
      ).toEqual({ inUseCount: 1 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('fails critical restart when a terminal lease still owns a non-clean backend anchor', async () => {
    const coreDb = createMigratedCoreDb();
    let cleanupCalls = 0;

    try {
      dispatchLease(coreDb, 'terminal_dirty_anchor');
      recordBackendSession(coreDb, 'terminal_dirty_anchor', 'launching');
      coreDb.sqlite
        .prepare(
          "UPDATE scheduler_session_leases SET status = 'failed', release_reason = 'corrupt-terminal' WHERE lease_id = ?"
        )
        .run('lease_terminal_dirty_anchor');

      await expect(
        runSchedulerRestartRecovery(coreDb, {
          cleanupBackendSession: async () => {
            cleanupCalls += 1;
          },
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        })
      ).rejects.toThrow('has no non-terminal scheduler lease owner');
      expect(cleanupCalls).toBe(1);
      expect(getWorkerBackendSession(coreDb, 'lease_terminal_dirty_anchor')).toMatchObject({
        state: 'physical-cleaned',
      });
      expect(
        coreDb.sqlite
          .prepare('SELECT in_use_count AS inUseCount FROM scheduler_capacity_records')
          .get()
      ).toEqual({ inUseCount: 1 });
    } finally {
      coreDb.sqlite.close();
    }
  });
});

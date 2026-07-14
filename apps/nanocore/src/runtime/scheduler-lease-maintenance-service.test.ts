import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acceptSchedulerLeaseHeartbeat,
  createSchedulerAdmissionEntry,
  dispatchNextSchedulerEntry,
  expireReleasingSchedulerLeases,
  markSchedulerSessionLeaseReleasing,
  upsertSchedulerCapacityRecord,
  upsertSchedulerTargetHealthRecord,
  upsertSchedulerWorkerPool,
} from '../scheduler-records';
import { openCoreDb, openWorkspaceDb } from '../storage/db';
import { LOCAL_USER_ID } from '../storage/fs-layout';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate';
import {
  runSchedulerLeaseMaintenanceOnce,
  startSchedulerLeaseMaintenanceService,
} from './scheduler-lease-maintenance-service';
import { listWorkspaceReconciliationRecords } from './workspace-reconciliation-records';
import {
  recordWorkspaceMaterializationRecords,
  updateBackendWorkspaceHandleCleanupStatus,
} from './workspace-sync-records';

/** Creates an isolated migrated Core database for scheduler maintenance tests. */
function createMigratedCoreDb() {
  const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-scheduler-maintenance-')));
  applyMigrations(coreDb);
  return coreDb;
}

/** Seeds one active local scheduler target. */
function seedLocalTarget(coreDb: ReturnType<typeof createMigratedCoreDb>, suffix: string): void {
  upsertSchedulerWorkerPool(coreDb, {
    allowedBackendKinds: ['openshell'],
    allowedPlacements: ['local'],
    allowedWorkspaceScopes: ['local'],
    budgetClass: 'interactive',
    currentAdmittedSessionCount: 0,
    currentQueueDepth: 1,
    defaultTimeoutMs: 900_000,
    healthSummary: 'ready',
    maxConcurrentSessions: 2,
    poolId: `pool_${suffix}`,
    queueLimit: 20,
    status: 'active',
  });
  upsertSchedulerCapacityRecord(coreDb, {
    capacityClass: 'local',
    concurrencyCeiling: 2,
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

/** Dispatches one queued lease for scheduler maintenance tests. */
function dispatchLease(
  coreDb: ReturnType<typeof createMigratedCoreDb>,
  suffix: string,
  userId = LOCAL_USER_ID
): void {
  seedLocalTarget(coreDb, suffix);
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
    schedulerEpoch: 1,
    startupTimeoutMs: 120_000,
  });
}

describe('scheduler lease maintenance service', () => {
  it('wires bounded production renewal without requiring a same-snapshot refresh ack', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const maintenanceStart = source.indexOf(
      'schedulerLeaseMaintenance = startSchedulerLeaseMaintenanceService(coreDb, {'
    );
    const maintenanceEnd = source.indexOf('schedulerHealthProbe =', maintenanceStart);
    const wiring = source.slice(maintenanceStart, maintenanceEnd);

    expect(maintenanceStart).toBeGreaterThan(-1);
    expect(maintenanceEnd).toBeGreaterThan(maintenanceStart);
    expect(wiring).toContain('maxTotalLeaseMs: SCHEDULER_LEASE_MAX_TOTAL_MS');
    expect(wiring).toContain('renewalDurationMs: SCHEDULER_LEASE_RENEWAL_DURATION_MS');
    expect(wiring).not.toContain('canRenewPackageSnapshot');
  });

  it('runs lease watch before renewal in one maintenance iteration', () => {
    const coreDb = createMigratedCoreDb();

    try {
      dispatchLease(coreDb, 'startup');
      dispatchLease(coreDb, 'renew');
      acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 900_000,
        leaseId: 'lease_renew',
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });

      const result = runSchedulerLeaseMaintenanceOnce(coreDb, {
        maxTotalLeaseMs: 7_200_000,
        now: () => '2026-07-05T00:10:30.000Z',
        renewalDurationMs: 1_800_000,
        renewalLeadMs: 300_000,
      });
      const rows = coreDb.sqlite
        .prepare(
          "SELECT lease_id AS leaseId, status, renewal_count AS renewalCount FROM scheduler_session_leases WHERE lease_id IN ('lease_startup', 'lease_renew') ORDER BY lease_id"
        )
        .all();

      expect(result.leaseWatch.startupTimedOut.map((lease) => lease.leaseId)).toEqual([
        'lease_startup',
      ]);
      expect(result.renewal.renewed.map((lease) => lease.leaseId)).toEqual(['lease_renew']);
      expect(rows).toEqual([
        { leaseId: 'lease_renew', renewalCount: 1, status: 'active' },
        { leaseId: 'lease_startup', renewalCount: 0, status: 'failed' },
      ]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records workspace reconciliation triggers for stale leases with pending backend handles', () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, LOCAL_USER_ID, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, 'heartbeat');
      acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        leaseId: 'lease_heartbeat',
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });
      recordWorkspaceMaterializationRecords(workspaceDb, [
        {
          backendKind: 'openshell',
          base: { commit: 'abc123', contentDigest: null },
          createdAt: '2026-07-05T00:00:10.000Z',
          id: 'wmr_heartbeat',
          inputSnapshotId: 'wis_heartbeat',
          materializedRootRef: 'workspace://ws_demo/repo_default',
          packageSnapshotId: 'aepsnap_turn_heartbeat_as_heartbeat',
          policyDigest: 'sha256:policy',
          readinessEvidence: [{ kind: 'backend.ready', ref: 'version:0.0.63' }],
          sourceId: 'repo_default',
          strategy: 'git',
          workerSessionId: 'sandbox_heartbeat',
          workspaceId: 'ws_demo',
        },
      ]);

      runSchedulerLeaseMaintenanceOnce(coreDb, {
        maxTotalLeaseMs: 7_200_000,
        now: () => '2026-07-05T00:03:00.000Z',
        renewalDurationMs: 1_800_000,
        renewalLeadMs: 300_000,
      });

      expect(listWorkspaceReconciliationRecords(workspaceDb, 'ws_demo')).toEqual([
        expect.objectContaining({
          affectedRecordIds: ['wmr_heartbeat', 'bwh_wmr_heartbeat'],
          backendHandleSummary: expect.objectContaining({
            handleId: 'bwh_wmr_heartbeat',
            workerSessionId: 'sandbox_heartbeat',
          }),
          requiredHumanDecision: 'inspect_recovery',
          stateAfter: 'requires-human',
          triggerReason: 'backend_takeover',
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('opens the workspace database owned by the scheduler admission user', () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'user_server', 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, 'server_user', 'user_server');
      acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        leaseId: 'lease_server_user',
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });
      recordWorkspaceMaterializationRecords(workspaceDb, [
        {
          backendKind: 'openshell',
          base: { commit: 'abc123', contentDigest: null },
          createdAt: '2026-07-05T00:00:10.000Z',
          id: 'wmr_server_user',
          inputSnapshotId: 'wis_server_user',
          materializedRootRef: 'workspace://ws_demo/repo_default',
          packageSnapshotId: 'aepsnap_turn_server_user_as_server_user',
          policyDigest: 'sha256:policy',
          readinessEvidence: [{ kind: 'backend.ready', ref: 'version:0.0.80' }],
          sourceId: 'repo_default',
          strategy: 'git',
          workerSessionId: 'sandbox_server_user',
          workspaceId: 'ws_demo',
        },
      ]);

      runSchedulerLeaseMaintenanceOnce(coreDb, {
        maxTotalLeaseMs: 7_200_000,
        now: () => '2026-07-05T00:03:00.000Z',
        renewalDurationMs: 1_800_000,
        renewalLeadMs: 300_000,
      });

      expect(listWorkspaceReconciliationRecords(workspaceDb, 'ws_demo')).toEqual([
        expect.objectContaining({
          stateBefore: 'lease-stale',
          triggerReason: 'backend_takeover',
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('retries a release-timeout workspace projection after the Core transition committed', () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, LOCAL_USER_ID, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, 'release_retry');
      recordWorkspaceMaterializationRecords(workspaceDb, [
        {
          backendKind: 'openshell',
          base: { commit: 'abc123', contentDigest: null },
          createdAt: '2026-07-05T00:00:10.000Z',
          id: 'wmr_release_retry',
          inputSnapshotId: 'wis_release_retry',
          materializedRootRef: 'workspace://ws_demo/repo_default',
          packageSnapshotId: 'aepsnap_turn_release_retry_as_release_retry',
          policyDigest: 'sha256:policy',
          readinessEvidence: [{ kind: 'backend.ready', ref: 'version:0.0.80' }],
          sourceId: 'repo_default',
          strategy: 'git',
          workerSessionId: 'sandbox_release_retry',
          workspaceId: 'ws_demo',
        },
      ]);
      markSchedulerSessionLeaseReleasing(coreDb, {
        leaseId: 'lease_release_retry',
        now: () => '2026-07-05T00:00:10.000Z',
        releaseReason: 'worker-final-status',
      });
      expireReleasingSchedulerLeases(coreDb, {
        now: () => '2026-07-05T00:05:11.000Z',
      });

      for (let index = 0; index < 2; index += 1) {
        runSchedulerLeaseMaintenanceOnce(coreDb, {
          maxTotalLeaseMs: 7_200_000,
          now: () => '2026-07-05T00:05:12.000Z',
          renewalDurationMs: 1_800_000,
          renewalLeadMs: 300_000,
        });
      }

      expect(listWorkspaceReconciliationRecords(workspaceDb, 'ws_demo')).toEqual([
        expect.objectContaining({
          stateBefore: 'lease-releasing',
          triggerReason: 'backend_takeover',
        }),
      ]);
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT capacity.in_use_count AS inUseCount,
                    capacity.version,
                    pools.current_admitted_session_count AS admittedCount
             FROM scheduler_session_leases AS leases
             JOIN scheduler_capacity_records AS capacity
               ON capacity.target_id = leases.target_id AND capacity.pool_id = leases.pool_id
             JOIN scheduler_worker_pools AS pools ON pools.pool_id = leases.pool_id
             WHERE leases.lease_id = 'lease_release_retry'`
          )
          .get()
      ).toEqual({ admittedCount: 0, inUseCount: 0, version: 3 });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('recovers retained handles only for a release-grace timeout', () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, LOCAL_USER_ID, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, 'stale_retained');
      dispatchLease(coreDb, 'release_retained');
      recordWorkspaceMaterializationRecords(workspaceDb, [
        {
          backendKind: 'openshell',
          base: { commit: 'abc123', contentDigest: null },
          createdAt: '2026-07-05T00:00:10.000Z',
          id: 'wmr_stale_retained',
          inputSnapshotId: 'wis_stale_retained',
          materializedRootRef: 'workspace://ws_demo/repo_default',
          packageSnapshotId: 'aepsnap_turn_stale_retained_as_stale_retained',
          policyDigest: 'sha256:policy',
          readinessEvidence: [{ kind: 'backend.ready', ref: 'version:0.0.80' }],
          sourceId: 'repo_default',
          strategy: 'git',
          workerSessionId: 'sandbox_stale_retained',
          workspaceId: 'ws_demo',
        },
        {
          backendKind: 'openshell',
          base: { commit: 'abc123', contentDigest: null },
          createdAt: '2026-07-05T00:00:10.000Z',
          id: 'wmr_release_retained',
          inputSnapshotId: 'wis_release_retained',
          materializedRootRef: 'workspace://ws_demo/repo_default',
          packageSnapshotId: 'aepsnap_turn_release_retained_as_release_retained',
          policyDigest: 'sha256:policy',
          readinessEvidence: [{ kind: 'backend.ready', ref: 'version:0.0.80' }],
          sourceId: 'repo_default',
          strategy: 'git',
          workerSessionId: 'sandbox_release_retained',
          workspaceId: 'ws_demo',
        },
      ]);
      updateBackendWorkspaceHandleCleanupStatus(
        workspaceDb,
        'ws_demo',
        'aepsnap_turn_stale_retained_as_stale_retained',
        'retained',
        '2026-07-05T00:00:20.000Z'
      );
      updateBackendWorkspaceHandleCleanupStatus(
        workspaceDb,
        'ws_demo',
        'aepsnap_turn_release_retained_as_release_retained',
        'retained',
        '2026-07-05T00:00:20.000Z'
      );
      acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        leaseId: 'lease_stale_retained',
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });
      markSchedulerSessionLeaseReleasing(coreDb, {
        leaseId: 'lease_release_retained',
        now: () => '2026-07-05T00:00:10.000Z',
        releaseReason: 'worker-final-status',
      });

      runSchedulerLeaseMaintenanceOnce(coreDb, {
        maxTotalLeaseMs: 7_200_000,
        now: () => '2026-07-05T00:05:11.000Z',
        renewalDurationMs: 1_800_000,
        renewalLeadMs: 300_000,
      });

      expect(listWorkspaceReconciliationRecords(workspaceDb, 'ws_demo')).toEqual([
        expect.objectContaining({
          backendHandleSummary: expect.objectContaining({ cleanupStatus: 'retained' }),
          backendReachability: expect.objectContaining({ detail: 'release-grace-timeout' }),
          stateBefore: 'lease-releasing',
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('releases capacity when evidence finalization exceeds the lease bound', () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, LOCAL_USER_ID, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, 'release_timeout');
      recordWorkspaceMaterializationRecords(workspaceDb, [
        {
          backendKind: 'openshell',
          base: { commit: 'abc123', contentDigest: null },
          createdAt: '2026-07-05T00:00:10.000Z',
          id: 'wmr_release_timeout',
          inputSnapshotId: 'wis_release_timeout',
          materializedRootRef: 'workspace://ws_demo/repo_default',
          packageSnapshotId: 'aepsnap_turn_release_timeout_as_release_timeout',
          policyDigest: 'sha256:policy',
          readinessEvidence: [{ kind: 'backend.ready', ref: 'version:0.0.80' }],
          sourceId: 'repo_default',
          strategy: 'git',
          workerSessionId: 'sandbox_release_timeout',
          workspaceId: 'ws_demo',
        },
      ]);
      acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        leaseId: 'lease_release_timeout',
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });
      markSchedulerSessionLeaseReleasing(coreDb, {
        leaseId: 'lease_release_timeout',
        now: () => '2026-07-05T00:00:10.000Z',
        releaseReason: 'worker-final-status',
      });

      runSchedulerLeaseMaintenanceOnce(coreDb, {
        maxTotalLeaseMs: 7_200_000,
        now: () => '2026-07-05T00:01:00.000Z',
        renewalDurationMs: 1_800_000,
        renewalLeadMs: 300_000,
      });
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT
              leases.status AS leaseStatus,
              leases.release_reason AS releaseReason,
              capacity.in_use_count AS inUseCount
            FROM scheduler_session_leases AS leases
            JOIN scheduler_capacity_records AS capacity
              ON capacity.target_id = leases.target_id AND capacity.pool_id = leases.pool_id
            WHERE leases.lease_id = 'lease_release_timeout'`
          )
          .get()
      ).toEqual({
        inUseCount: 1,
        leaseStatus: 'releasing',
        releaseReason: 'worker-final-status',
      });

      runSchedulerLeaseMaintenanceOnce(coreDb, {
        maxTotalLeaseMs: 7_200_000,
        now: () => '2026-07-05T00:05:11.000Z',
        renewalDurationMs: 1_800_000,
        renewalLeadMs: 300_000,
      });
      runSchedulerLeaseMaintenanceOnce(coreDb, {
        maxTotalLeaseMs: 7_200_000,
        now: () => '2026-07-05T00:05:11.000Z',
        renewalDurationMs: 1_800_000,
        renewalLeadMs: 300_000,
      });
      expect(listWorkspaceReconciliationRecords(workspaceDb, 'ws_demo')).toEqual([
        expect.objectContaining({
          backendReachability: expect.objectContaining({
            detail: 'release-grace-timeout',
            status: 'unavailable',
          }),
          requiredHumanDecision: 'inspect_recovery',
          stateAfter: 'requires-human',
          stateBefore: 'lease-releasing',
          triggerReason: 'backend_takeover',
        }),
      ]);
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT
              leases.status AS leaseStatus,
              leases.expires_at AS expiresAt,
              leases.release_reason AS releaseReason,
              leases.recovery_state AS recoveryState,
              plans.status AS planStatus,
              capacity.in_use_count AS inUseCount,
              capacity.version,
              pools.current_admitted_session_count AS admittedCount
            FROM scheduler_session_leases AS leases
            JOIN scheduler_placement_plans AS plans ON plans.plan_id = leases.plan_id
            JOIN scheduler_capacity_records AS capacity
              ON capacity.target_id = leases.target_id AND capacity.pool_id = leases.pool_id
            JOIN scheduler_worker_pools AS pools ON pools.pool_id = leases.pool_id
            WHERE leases.lease_id = 'lease_release_timeout'`
          )
          .get()
      ).toEqual({
        admittedCount: 0,
        expiresAt: '2026-07-05T00:05:10.000Z',
        inUseCount: 0,
        leaseStatus: 'lost',
        planStatus: 'completed',
        recoveryState: 'needs-evidence',
        releaseReason: 'release-grace-timeout',
        version: 3,
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('starts immediately, schedules future maintenance, and stops cleanly', () => {
    const coreDb = createMigratedCoreDb();
    const callbacks: Array<() => void> = [];
    const cleared: unknown[] = [];

    try {
      const service = startSchedulerLeaseMaintenanceService(coreDb, {
        intervalMs: 30_000,
        maxTotalLeaseMs: 7_200_000,
        now: () => '2026-07-05T00:10:30.000Z',
        renewalDurationMs: 1_800_000,
        renewalLeadMs: 300_000,
        clearInterval: (handle) => {
          cleared.push(handle);
        },
        setInterval: (callback, intervalMs) => {
          callbacks.push(callback);
          return { intervalMs };
        },
      });

      callbacks[0]?.();
      service.stop();

      expect(callbacks).toHaveLength(1);
      expect(cleared).toEqual([{ intervalMs: 30_000 }]);
    } finally {
      coreDb.sqlite.close();
    }
  });
});

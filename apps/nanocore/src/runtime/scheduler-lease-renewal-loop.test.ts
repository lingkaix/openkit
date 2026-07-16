import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acceptSchedulerLeaseHeartbeat,
  createSchedulerAdmissionEntry,
  dispatchNextSchedulerEntry,
  upsertSchedulerCapacityRecord,
  upsertSchedulerTargetHealthRecord,
  upsertSchedulerWorkerPool,
} from '../scheduler-records';
import { openCoreDb } from '../storage/db';
import { applyMigrations } from '../storage/migrate';
import { runSchedulerLeaseRenewalLoop } from './scheduler-lease-renewal-loop';

/**
 * Creates an isolated migrated Core database for scheduler renewal tests.
 *
 * @returns Open Core database handle.
 */
function createMigratedCoreDb() {
  const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-scheduler-renewal-')));
  applyMigrations(coreDb);
  return coreDb;
}

/**
 * Creates one active local scheduler target.
 *
 * @param coreDb Open Core database handle.
 * @param suffix Stable id suffix.
 */
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

/**
 * Dispatches one queued lease for renewal tests.
 *
 * @param coreDb Open Core database handle.
 * @param suffix Stable id suffix.
 */
function dispatchLease(
  coreDb: ReturnType<typeof createMigratedCoreDb>,
  suffix: string,
  packageSnapshotId?: string
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
    ...(packageSnapshotId ? { packageSnapshotId } : {}),
    planId: `plan_${suffix}`,
    sandboxBindingRef: `lease-binding:lease_${suffix}`,
    schedulerEpoch: 1,
    startupTimeoutMs: 120_000,
  });
}

describe('scheduler lease renewal loop', () => {
  it('renews live leases that are close to expiry', () => {
    const coreDb = createMigratedCoreDb();

    try {
      dispatchLease(coreDb, 'renew');
      acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 900_000,
        leaseId: 'lease_renew',
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });

      const result = runSchedulerLeaseRenewalLoop(coreDb, {
        maxTotalLeaseMs: 7_200_000,
        now: () => '2026-07-05T00:10:30.000Z',
        renewalDurationMs: 1_800_000,
        renewalLeadMs: 300_000,
      });
      const lease = coreDb.sqlite
        .prepare(
          'SELECT expires_at AS expiresAt, heartbeat_deadline AS heartbeatDeadline, renewal_count AS renewalCount FROM scheduler_session_leases WHERE lease_id = ?'
        )
        .get('lease_renew');

      expect(result.renewed.map((renewed) => renewed.leaseId)).toEqual(['lease_renew']);
      expect(lease).toEqual({
        expiresAt: '2026-07-05T00:40:30.000Z',
        heartbeatDeadline: '2026-07-05T00:15:10.000Z',
        renewalCount: 1,
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('does not renew leases when the package snapshot needs an unsupported refresh', () => {
    const coreDb = createMigratedCoreDb();

    try {
      dispatchLease(coreDb, 'current_snapshot', 'pkg_current');
      dispatchLease(coreDb, 'stale_snapshot', 'pkg_stale');
      for (const leaseId of ['lease_current_snapshot', 'lease_stale_snapshot']) {
        acceptSchedulerLeaseHeartbeat(coreDb, {
          heartbeatTimeoutMs: 900_000,
          leaseId,
          now: () => '2026-07-05T00:00:10.000Z',
          workerSequence: 1,
        });
      }

      const result = runSchedulerLeaseRenewalLoop(coreDb, {
        maxTotalLeaseMs: 7_200_000,
        now: () => '2026-07-05T00:10:30.000Z',
        renewalDurationMs: 1_800_000,
        renewalLeadMs: 300_000,
        canRenewPackageSnapshot: (lease) => lease.packageSnapshotId === 'pkg_current',
      });
      const leases = coreDb.sqlite
        .prepare(
          "SELECT lease_id AS leaseId, renewal_count AS renewalCount FROM scheduler_session_leases WHERE lease_id IN ('lease_current_snapshot', 'lease_stale_snapshot') ORDER BY lease_id"
        )
        .all();

      expect(result.renewed.map((lease) => lease.leaseId)).toEqual(['lease_current_snapshot']);
      expect(result.packageRefreshBlocked.map((lease) => lease.leaseId)).toEqual([
        'lease_stale_snapshot',
      ]);
      expect(leases).toEqual([
        { leaseId: 'lease_current_snapshot', renewalCount: 1 },
        { leaseId: 'lease_stale_snapshot', renewalCount: 0 },
      ]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('does not renew leases with stale heartbeats', () => {
    const coreDb = createMigratedCoreDb();

    try {
      dispatchLease(coreDb, 'stale_heartbeat');

      const result = runSchedulerLeaseRenewalLoop(coreDb, {
        maxTotalLeaseMs: 7_200_000,
        now: () => '2026-07-05T00:10:30.000Z',
        renewalDurationMs: 1_800_000,
        renewalLeadMs: 300_000,
      });
      const lease = coreDb.sqlite
        .prepare(
          'SELECT renewal_count AS renewalCount FROM scheduler_session_leases WHERE lease_id = ?'
        )
        .get('lease_stale_heartbeat');

      expect(result.renewed).toEqual([]);
      expect(lease).toEqual({ renewalCount: 0 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('renews a live lease on a quarantined target when its heartbeat is fresh', () => {
    const coreDb = createMigratedCoreDb();

    try {
      dispatchLease(coreDb, 'quarantined');
      acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 900_000,
        leaseId: 'lease_quarantined',
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });
      upsertSchedulerTargetHealthRecord(coreDb, {
        checkResults: [{ status: 'failed', surface: 'worker-control' }],
        consecutiveFailureCount: 3,
        consecutiveSuccessCount: 0,
        healthState: 'quarantined',
        lastProbeAt: '2026-07-05T00:10:00.000Z',
        nextProbeAt: '2026-07-05T00:11:00.000Z',
        targetId: 'target_quarantined',
      });

      const result = runSchedulerLeaseRenewalLoop(coreDb, {
        maxTotalLeaseMs: 7_200_000,
        now: () => '2026-07-05T00:10:30.000Z',
        renewalDurationMs: 1_800_000,
        renewalLeadMs: 300_000,
      });
      const lease = coreDb.sqlite
        .prepare(
          'SELECT renewal_count AS renewalCount FROM scheduler_session_leases WHERE lease_id = ?'
        )
        .get('lease_quarantined');

      expect(result.renewed.map((renewed) => renewed.leaseId)).toEqual(['lease_quarantined']);
      expect(lease).toEqual({ renewalCount: 1 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('renews a live lease while its worker pool is draining', () => {
    const coreDb = createMigratedCoreDb();

    try {
      dispatchLease(coreDb, 'draining');
      acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 900_000,
        leaseId: 'lease_draining',
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });
      coreDb.sqlite
        .prepare("UPDATE scheduler_worker_pools SET status = 'draining' WHERE pool_id = ?")
        .run('pool_draining');

      const result = runSchedulerLeaseRenewalLoop(coreDb, {
        maxTotalLeaseMs: 7_200_000,
        now: () => '2026-07-05T00:10:30.000Z',
        renewalDurationMs: 1_800_000,
        renewalLeadMs: 300_000,
      });
      const lease = coreDb.sqlite
        .prepare(
          'SELECT renewal_count AS renewalCount FROM scheduler_session_leases WHERE lease_id = ?'
        )
        .get('lease_draining');

      expect(result.renewed.map((renewed) => renewed.leaseId)).toEqual(['lease_draining']);
      expect(lease).toEqual({ renewalCount: 1 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('does not renew leases on unavailable targets', () => {
    const coreDb = createMigratedCoreDb();

    try {
      dispatchLease(coreDb, 'unavailable');
      acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 900_000,
        leaseId: 'lease_unavailable',
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });
      upsertSchedulerTargetHealthRecord(coreDb, {
        checkResults: [{ status: 'failed', surface: 'worker-control' }],
        consecutiveFailureCount: 3,
        consecutiveSuccessCount: 0,
        healthState: 'unavailable',
        lastProbeAt: '2026-07-05T00:10:00.000Z',
        nextProbeAt: '2026-07-05T00:11:00.000Z',
        targetId: 'target_unavailable',
      });

      const result = runSchedulerLeaseRenewalLoop(coreDb, {
        maxTotalLeaseMs: 7_200_000,
        now: () => '2026-07-05T00:10:30.000Z',
        renewalDurationMs: 1_800_000,
        renewalLeadMs: 300_000,
      });
      const lease = coreDb.sqlite
        .prepare(
          'SELECT renewal_count AS renewalCount FROM scheduler_session_leases WHERE lease_id = ?'
        )
        .get('lease_unavailable');

      expect(result.renewed).toEqual([]);
      expect(lease).toEqual({ renewalCount: 0 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('does not renew a lease while it awaits restart reconnect', () => {
    const coreDb = createMigratedCoreDb();

    try {
      dispatchLease(coreDb, 'awaiting_reconnect');
      acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 900_000,
        leaseId: 'lease_awaiting_reconnect',
        now: () => '2026-07-05T00:00:10.000Z',
        workerProcessKeyHash: 'a'.repeat(43),
        workerSequence: 0,
      });
      coreDb.sqlite
        .prepare(
          "UPDATE scheduler_session_leases SET recovery_state = 'awaiting-reconnect' WHERE lease_id = ?"
        )
        .run('lease_awaiting_reconnect');

      const result = runSchedulerLeaseRenewalLoop(coreDb, {
        maxTotalLeaseMs: 7_200_000,
        now: () => '2026-07-05T00:10:30.000Z',
        renewalDurationMs: 1_800_000,
        renewalLeadMs: 300_000,
      });

      expect(result.renewed).toEqual([]);
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT renewal_count AS renewalCount FROM scheduler_session_leases WHERE lease_id = ?'
          )
          .get('lease_awaiting_reconnect')
      ).toEqual({ renewalCount: 0 });
    } finally {
      coreDb.sqlite.close();
    }
  });
});

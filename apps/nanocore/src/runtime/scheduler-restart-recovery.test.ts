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
import { runSchedulerRestartRecovery } from './scheduler-restart-recovery';

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
function dispatchLease(coreDb: ReturnType<typeof createMigratedCoreDb>, suffix: string): void {
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

describe('scheduler restart recovery', () => {
  it('fails pre-launch acquired leases and returns their admission entries to queued', () => {
    const coreDb = createMigratedCoreDb();

    try {
      dispatchLease(coreDb, 'prelaunch');

      const result = runSchedulerRestartRecovery(coreDb, {
        now: () => '2026-07-05T00:01:00.000Z',
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
        queueDepth: 1,
        queueStatus: 'queued',
        releaseReason: 'scheduler-restart-pre-launch',
        schedulerEpoch: 8,
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('adopts live leases into the new epoch and marks downtime-expired leases stale', () => {
    const coreDb = createMigratedCoreDb();

    try {
      dispatchLease(coreDb, 'live');
      dispatchLease(coreDb, 'expired');
      acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 900_000,
        leaseId: 'lease_live',
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });
      acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 20_000,
        leaseId: 'lease_expired',
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });

      const result = runSchedulerRestartRecovery(coreDb, {
        now: () => '2026-07-05T00:01:00.000Z',
      });
      const rows = coreDb.sqlite
        .prepare(
          `SELECT
            lease_id AS leaseId,
            status,
            release_reason AS releaseReason,
            recovery_state AS recoveryState,
            scheduler_epoch AS schedulerEpoch
          FROM scheduler_session_leases
          WHERE lease_id IN ('lease_live', 'lease_expired')
          ORDER BY lease_id`
        )
        .all();
      const evidenceRows = coreDb.sqlite
        .prepare(
          `SELECT
            lease_id AS leaseId,
            reason,
            scheduler_epoch AS schedulerEpoch,
            heartbeat_deadline AS heartbeatDeadline,
            last_accepted_heartbeat_at AS lastAcceptedHeartbeatAt
          FROM scheduler_orphan_worker_evidence
          ORDER BY lease_id`
        )
        .all();

      expect(result).toEqual({
        adoptedLeaseIds: ['lease_live'],
        preLaunchFailedLeaseIds: [],
        schedulerEpoch: 8,
        staleLeaseIds: ['lease_expired'],
      });
      expect(rows).toEqual([
        {
          leaseId: 'lease_expired',
          recoveryState: 'needs-evidence',
          releaseReason: 'heartbeat-timeout',
          schedulerEpoch: 8,
          status: 'stale',
        },
        {
          leaseId: 'lease_live',
          recoveryState: null,
          releaseReason: null,
          schedulerEpoch: 8,
          status: 'active',
        },
      ]);
      expect(evidenceRows).toEqual([
        {
          heartbeatDeadline: '2026-07-05T00:00:30.000Z',
          lastAcceptedHeartbeatAt: '2026-07-05T00:00:10.000Z',
          leaseId: 'lease_expired',
          reason: 'restart-heartbeat-timeout',
          schedulerEpoch: 8,
        },
      ]);
    } finally {
      coreDb.sqlite.close();
    }
  });
});

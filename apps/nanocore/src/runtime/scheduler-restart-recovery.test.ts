import { mkdtempSync } from 'node:fs';
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
import { runSchedulerLeaseMaintenanceOnce } from './scheduler-lease-maintenance-service';
import { runSchedulerRestartRecovery } from './scheduler-restart-recovery';
import {
  listWorkspaceReconciliationRecords,
  resolveWorkspaceReconciliationRecord,
} from './workspace-reconciliation-records';
import { recordWorkspaceMaterializationRecords } from './workspace-sync-records';

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

  it('records workspace reconciliation when restart marks a live backend lease stale', () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, LOCAL_USER_ID, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, 'restart_workspace');
      acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 20_000,
        leaseId: 'lease_restart_workspace',
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });
      recordWorkspaceMaterializationRecords(workspaceDb, [
        {
          backendKind: 'openshell',
          base: { commit: 'abc123', contentDigest: null },
          createdAt: '2026-07-05T00:00:10.000Z',
          id: 'wmr_restart_workspace',
          inputSnapshotId: 'wis_restart_workspace',
          materializedRootRef: 'workspace://ws_demo/repo_default',
          packageSnapshotId: 'aepsnap_turn_restart_workspace_as_restart_workspace',
          policyDigest: 'sha256:policy',
          readinessEvidence: [{ kind: 'backend.ready', ref: 'version:0.0.80' }],
          sourceId: 'repo_default',
          strategy: 'git',
          workerSessionId: 'sandbox_restart_workspace',
          workspaceId: 'ws_demo',
        },
      ]);

      runSchedulerRestartRecovery(coreDb, {
        now: () => '2026-07-05T00:01:00.000Z',
      });

      expect(listWorkspaceReconciliationRecords(workspaceDb, 'ws_demo')).toEqual([
        expect.objectContaining({
          backendHandleSummary: expect.objectContaining({
            workerSessionId: 'sandbox_restart_workspace',
          }),
          requiredHumanDecision: 'inspect_recovery',
          stateAfter: 'requires-human',
          triggerReason: 'backend_takeover',
        }),
      ]);

      resolveWorkspaceReconciliationRecord({
        decidedAt: '2026-07-05T00:02:00.000Z',
        decision: 'abandon',
        reconciliationRecordId: 'wrr_lease_restart_workspace_bwh_wmr_restart_workspace',
        workspaceDb,
        workspaceId: 'ws_demo',
      });
      runSchedulerRestartRecovery(coreDb, {
        now: () => '2026-07-05T00:03:00.000Z',
      });
      expect(listWorkspaceReconciliationRecords(workspaceDb, 'ws_demo')).toEqual([
        expect.objectContaining({
          requiredHumanDecision: null,
          stateAfter: 'unrecoverable',
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('terminalizes an expired releasing lease without claiming successful completion', () => {
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

      const result = runSchedulerRestartRecovery(coreDb, {
        now: () => '2026-07-05T00:05:11.000Z',
      });
      const row = coreDb.sqlite
        .prepare(
          `SELECT
            leases.status AS leaseStatus,
            leases.expires_at AS expiresAt,
            leases.release_reason AS releaseReason,
            leases.recovery_state AS recoveryState,
            leases.scheduler_epoch AS schedulerEpoch,
            plans.status AS planStatus,
            capacity.in_use_count AS inUseCount,
            pools.current_admitted_session_count AS admittedCount
          FROM scheduler_session_leases AS leases
          JOIN scheduler_placement_plans AS plans ON plans.plan_id = leases.plan_id
          JOIN scheduler_capacity_records AS capacity
            ON capacity.target_id = leases.target_id AND capacity.pool_id = leases.pool_id
          JOIN scheduler_worker_pools AS pools ON pools.pool_id = leases.pool_id
          WHERE leases.lease_id = 'lease_release_timeout'`
        )
        .get();
      const orphanEvidenceCount = coreDb.sqlite
        .prepare(
          'SELECT COUNT(*) AS count FROM scheduler_orphan_worker_evidence WHERE lease_id = ?'
        )
        .get('lease_release_timeout');

      expect(result).toEqual({
        adoptedLeaseIds: [],
        preLaunchFailedLeaseIds: [],
        schedulerEpoch: 8,
        staleLeaseIds: [],
      });
      expect(row).toEqual({
        admittedCount: 0,
        expiresAt: '2026-07-05T00:05:10.000Z',
        inUseCount: 0,
        leaseStatus: 'lost',
        planStatus: 'completed',
        recoveryState: 'needs-evidence',
        releaseReason: 'release-grace-timeout',
        schedulerEpoch: 8,
      });
      expect(orphanEvidenceCount).toEqual({ count: 0 });
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
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('adopts a releasing lease before grace expiry and leaves timeout to maintenance', () => {
    const coreDb = createMigratedCoreDb();

    try {
      dispatchLease(coreDb, 'release_grace');
      acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        leaseId: 'lease_release_grace',
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });
      markSchedulerSessionLeaseReleasing(coreDb, {
        leaseId: 'lease_release_grace',
        now: () => '2026-07-05T00:00:10.000Z',
        releaseReason: 'worker-final-status',
      });

      const result = runSchedulerRestartRecovery(coreDb, {
        now: () => '2026-07-05T00:01:00.000Z',
      });
      const stateStatement = coreDb.sqlite.prepare(
        `SELECT
          leases.status AS leaseStatus,
          leases.expires_at AS expiresAt,
          leases.release_reason AS releaseReason,
          leases.recovery_state AS recoveryState,
          leases.scheduler_epoch AS schedulerEpoch,
          plans.status AS planStatus,
          capacity.in_use_count AS inUseCount,
          pools.current_admitted_session_count AS admittedCount
        FROM scheduler_session_leases AS leases
        JOIN scheduler_placement_plans AS plans ON plans.plan_id = leases.plan_id
        JOIN scheduler_capacity_records AS capacity
          ON capacity.target_id = leases.target_id AND capacity.pool_id = leases.pool_id
        JOIN scheduler_worker_pools AS pools ON pools.pool_id = leases.pool_id
        WHERE leases.lease_id = 'lease_release_grace'`
      );
      const restartState = stateStatement.get();
      const orphanEvidenceCount = coreDb.sqlite
        .prepare(
          'SELECT COUNT(*) AS count FROM scheduler_orphan_worker_evidence WHERE lease_id = ?'
        )
        .get('lease_release_grace');

      expect(result).toEqual({
        adoptedLeaseIds: ['lease_release_grace'],
        preLaunchFailedLeaseIds: [],
        schedulerEpoch: 8,
        staleLeaseIds: [],
      });
      expect(restartState).toEqual({
        admittedCount: 1,
        expiresAt: '2026-07-05T00:05:10.000Z',
        inUseCount: 1,
        leaseStatus: 'releasing',
        planStatus: 'executing',
        recoveryState: 'needs-evidence',
        releaseReason: 'worker-final-status',
        schedulerEpoch: 8,
      });
      expect(orphanEvidenceCount).toEqual({ count: 0 });

      runSchedulerLeaseMaintenanceOnce(coreDb, {
        maxTotalLeaseMs: 7_200_000,
        now: () => '2026-07-05T00:05:11.000Z',
        renewalDurationMs: 1_800_000,
        renewalLeadMs: 300_000,
      });
      expect(stateStatement.get()).toEqual({
        admittedCount: 0,
        expiresAt: '2026-07-05T00:05:10.000Z',
        inUseCount: 0,
        leaseStatus: 'lost',
        planStatus: 'completed',
        recoveryState: 'needs-evidence',
        releaseReason: 'release-grace-timeout',
        schedulerEpoch: 8,
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('retries a previously committed release timeout during restart recovery', () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, LOCAL_USER_ID, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, 'restart_release_retry');
      recordWorkspaceMaterializationRecords(workspaceDb, [
        {
          backendKind: 'openshell',
          base: { commit: 'abc123', contentDigest: null },
          createdAt: '2026-07-05T00:00:10.000Z',
          id: 'wmr_restart_release_retry',
          inputSnapshotId: 'wis_restart_release_retry',
          materializedRootRef: 'workspace://ws_demo/repo_default',
          packageSnapshotId: 'aepsnap_turn_restart_release_retry_as_restart_release_retry',
          policyDigest: 'sha256:policy',
          readinessEvidence: [{ kind: 'backend.ready', ref: 'version:0.0.80' }],
          sourceId: 'repo_default',
          strategy: 'git',
          workerSessionId: 'sandbox_restart_release_retry',
          workspaceId: 'ws_demo',
        },
      ]);
      markSchedulerSessionLeaseReleasing(coreDb, {
        leaseId: 'lease_restart_release_retry',
        now: () => '2026-07-05T00:00:10.000Z',
        releaseReason: 'worker-final-status',
      });
      expireReleasingSchedulerLeases(coreDb, {
        now: () => '2026-07-05T00:05:11.000Z',
      });

      runSchedulerRestartRecovery(coreDb, {
        now: () => '2026-07-05T00:05:12.000Z',
      });
      runSchedulerRestartRecovery(coreDb, {
        now: () => '2026-07-05T00:05:13.000Z',
      });

      expect(listWorkspaceReconciliationRecords(workspaceDb, 'ws_demo')).toEqual([
        expect.objectContaining({
          stateBefore: 'lease-releasing',
          triggerReason: 'backend_takeover',
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });
});

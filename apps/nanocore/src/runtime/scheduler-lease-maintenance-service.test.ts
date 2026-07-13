import { mkdtempSync, readFileSync } from 'node:fs';
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
import { openCoreDb, openWorkspaceDb } from '../storage/db';
import { LOCAL_USER_ID } from '../storage/fs-layout';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate';
import {
  runSchedulerLeaseMaintenanceOnce,
  startSchedulerLeaseMaintenanceService,
} from './scheduler-lease-maintenance-service';
import { listWorkspaceReconciliationRecords } from './workspace-reconciliation-records';
import { recordWorkspaceMaterializationRecords } from './workspace-sync-records';

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
function dispatchLease(coreDb: ReturnType<typeof createMigratedCoreDb>, suffix: string): void {
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
          policyDigest: 'sha256:policy',
          readinessEvidence: [{ kind: 'backend.ready', ref: 'version:0.0.63' }],
          sourceId: 'repo_default',
          strategy: 'git',
          workerSessionId: 'aepsnap_turn_heartbeat_as_heartbeat',
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
            workerSessionId: 'aepsnap_turn_heartbeat_as_heartbeat',
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

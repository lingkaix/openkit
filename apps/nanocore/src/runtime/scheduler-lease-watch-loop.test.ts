import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acceptSchedulerLeaseHeartbeat,
  createSchedulerAdmissionEntry,
  dispatchNextSchedulerEntry,
  resolveSchedulerLeaseTokenBinding,
  upsertSchedulerCapacityRecord,
  upsertSchedulerTargetHealthRecord,
  upsertSchedulerWorkerPool,
} from '../scheduler-records';
import { openCoreDb } from '../storage/db';
import { applyMigrations } from '../storage/migrate';
import { runSchedulerLeaseWatchLoop } from './scheduler-lease-watch-loop';
import { recordWorkerBackendSessionMaterializing } from './worker-backend-sessions';

/**
 * Creates an isolated migrated Core database for scheduler lease-watch tests.
 *
 * @returns Open Core database handle.
 */
function createMigratedCoreDb() {
  const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-scheduler-watch-')));
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
    poolId: `pool_${suffix}`,
    allowedBackendKinds: ['openshell'],
    allowedPlacements: ['local'],
    maxConcurrentSessions: 2,
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
    targetId: `target_${suffix}`,
    poolId: `pool_${suffix}`,
    capacityClass: 'local',
    concurrencyCeiling: 2,
    inUseCount: 0,
    queueDepth: 0,
    observationSource: 'configured',
    observedAt: '2026-07-05T00:00:00.000Z',
  });
  upsertSchedulerTargetHealthRecord(coreDb, {
    targetId: `target_${suffix}`,
    healthState: 'healthy',
    checkResults: [],
    consecutiveFailureCount: 0,
    consecutiveSuccessCount: 1,
    lastProbeAt: '2026-07-05T00:00:00.000Z',
    nextProbeAt: '2026-07-05T00:01:00.000Z',
  });
}

/**
 * Dispatches one queued lease for lease-watch tests.
 *
 * @param coreDb Open Core database handle.
 * @param suffix Stable id suffix.
 */
function dispatchLease(coreDb: ReturnType<typeof createMigratedCoreDb>, suffix: string): void {
  seedLocalTarget(coreDb, suffix);
  createSchedulerAdmissionEntry(coreDb, {
    triggerActor: { kind: 'user', id: 'user_local' },
    queueEntryId: `queue_${suffix}`,
    workspaceId: 'ws_demo',
    threadId: `thread_${suffix}`,
    turnId: `turn_${suffix}`,
    turnInput: `Run ${suffix}`,
    requestedAgentId: 'agent_codex_host',
    profileRef: null,
    priorityClass: 'interactive',
    requiredPoolConstraints: ['openshell.local'],
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

describe('scheduler lease watch loop', () => {
  it('keeps a pre-heartbeat lease live until its startup deadline', () => {
    const coreDb = createMigratedCoreDb();

    try {
      dispatchLease(coreDb, 'materializing');

      const result = runSchedulerLeaseWatchLoop(coreDb, {
        now: () => '2026-07-05T00:00:40.000Z',
      });

      expect(result.startupTimedOut).toEqual([]);
      expect(result.stale).toEqual([]);
      expect(
        resolveSchedulerLeaseTokenBinding(coreDb, {
          now: () => '2026-07-05T00:00:40.000Z',
          sandboxBindingRef: 'lease-binding:lease_materializing',
          lineage: {
            agentSessionId: 'as_materializing',
            packageSnapshotId: 'aepsnap_turn_materializing_as_materializing',
            threadId: 'thread_materializing',
            turnId: 'turn_materializing',
            workspaceId: 'ws_demo',
          },
        })
      ).toMatchObject({ status: 'accepted' });
      expect(
        acceptSchedulerLeaseHeartbeat(coreDb, {
          heartbeatTimeoutMs: 30_000,
          leaseId: 'lease_materializing',
          now: () => '2026-07-05T00:00:40.000Z',
          workerSequence: 1,
        })
      ).toMatchObject({
        lastAcceptedHeartbeatAt: '2026-07-05T00:00:40.000Z',
        status: 'active',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('fails startup-timed-out leases before marking expired live leases stale', () => {
    const coreDb = createMigratedCoreDb();

    try {
      dispatchLease(coreDb, 'startup');
      dispatchLease(coreDb, 'heartbeat');
      acceptSchedulerLeaseHeartbeat(coreDb, {
        leaseId: 'lease_heartbeat',
        workerSequence: 1,
        heartbeatTimeoutMs: 30_000,
        now: () => '2026-07-05T00:00:10.000Z',
      });

      const result = runSchedulerLeaseWatchLoop(coreDb, {
        now: () => '2026-07-05T00:03:00.000Z',
      });

      expect(result.startupTimedOut.map((lease) => lease.leaseId)).toEqual(['lease_startup']);
      expect(result.stale.map((lease) => lease.leaseId)).toEqual(['lease_heartbeat']);
      expect(
        coreDb.sqlite
          .prepare('SELECT status, release_reason FROM scheduler_session_leases WHERE lease_id = ?')
          .get('lease_startup')
      ).toEqual({ status: 'failed', release_reason: 'startup-timeout' });
      expect(
        coreDb.sqlite
          .prepare('SELECT status, release_reason FROM scheduler_session_leases WHERE lease_id = ?')
          .get('lease_heartbeat')
      ).toEqual({ status: 'stale', release_reason: 'heartbeat-timeout' });
      expect(
        coreDb.sqlite
          .prepare('SELECT in_use_count FROM scheduler_capacity_records WHERE target_id = ?')
          .get('target_startup')
      ).toEqual({ in_use_count: 0 });
      expect(
        resolveSchedulerLeaseTokenBinding(coreDb, {
          sandboxBindingRef: 'lease-binding:lease_heartbeat',
          lineage: {
            agentSessionId: 'as_heartbeat',
            packageSnapshotId: 'aepsnap_turn_heartbeat_as_heartbeat',
            threadId: 'thread_heartbeat',
            turnId: 'turn_heartbeat',
            workspaceId: 'ws_demo',
          },
        })
      ).toEqual({ status: 'rejected', reason: 'lease-not-live' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('routes anchored startup timeouts to recovery without releasing capacity', () => {
    const coreDb = createMigratedCoreDb();

    try {
      dispatchLease(coreDb, 'anchored_startup');
      recordWorkerBackendSessionMaterializing(coreDb, {
        backendLineage: { imageRef: 'openkit/worker-codex:dev', kind: 'reference' },
        backendVersion: '0.0.99',
        identity: {
          agentSessionId: 'as_anchored_startup',
          backendKind: 'openshell',
          backendSessionId: 'openkit-as_anchored_startup',
          deploymentId: 'deployment-test',
          packageSnapshotId: 'aepsnap_turn_anchored_startup_as_anchored_startup',
          runtimeTargetId: 'runtime-target-test',
          stagingDirectoryRef:
            'server/runtime/worker-backend-sessions/aepsnap_turn_anchored_startup_as_anchored_startup',
          transientProviderInstanceId: null,
        },
        lineage: {
          threadId: 'thread_anchored_startup',
          turnId: 'turn_anchored_startup',
          workspaceId: 'ws_demo',
        },
        now: () => '2026-07-05T00:00:03.000Z',
        sandboxBindingRef: 'lease-binding:lease_anchored_startup',
      });

      const result = runSchedulerLeaseWatchLoop(coreDb, {
        now: () => '2026-07-05T00:03:00.000Z',
      });

      expect(result.startupTimedOut).toEqual([
        expect.objectContaining({
          leaseId: 'lease_anchored_startup',
          recoveryState: 'needs-evidence',
          releaseReason: 'startup-timeout',
          status: 'stale',
        }),
      ]);
      expect(result.stale).toEqual([]);
      expect(
        coreDb.sqlite
          .prepare('SELECT in_use_count FROM scheduler_capacity_records WHERE target_id = ?')
          .get('target_anchored_startup')
      ).toEqual({ in_use_count: 1 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('leaves an awaiting reconnect lease live until its recovery deadline', () => {
    const coreDb = createMigratedCoreDb();

    try {
      dispatchLease(coreDb, 'awaiting_reconnect');
      acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        leaseId: 'lease_awaiting_reconnect',
        now: () => '2026-07-05T00:00:10.000Z',
        workerProcessKeyHash: 'a'.repeat(43),
        workerSequence: 0,
      });
      coreDb.sqlite
        .prepare(
          `UPDATE scheduler_session_leases
           SET recovery_state = 'awaiting-reconnect',
               recovery_deadline = '2026-07-05T00:02:00.000Z'
           WHERE lease_id = ?`
        )
        .run('lease_awaiting_reconnect');

      const result = runSchedulerLeaseWatchLoop(coreDb, {
        now: () => '2026-07-05T00:01:00.000Z',
      });

      expect(result.stale).toEqual([]);
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM scheduler_session_leases WHERE lease_id = ?')
          .get('lease_awaiting_reconnect')
      ).toEqual({ status: 'active' });
    } finally {
      coreDb.sqlite.close();
    }
  });
});

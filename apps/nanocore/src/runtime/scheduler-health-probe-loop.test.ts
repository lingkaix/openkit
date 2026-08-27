import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createSchedulerAdmissionEntry,
  dispatchNextSchedulerEntry,
  ensureConfiguredSchedulerBaseline,
  upsertSchedulerCapacityRecord,
  upsertSchedulerTargetHealthRecord,
  upsertSchedulerWorkerPool,
} from '../scheduler-records';
import { openCoreDb } from '../storage/db';
import { applyMigrations } from '../storage/migrate';
import {
  runSchedulerHealthProbeLoop,
  startSchedulerHealthProbeService,
} from './scheduler-health-probe-loop';

/** Creates an isolated migrated Core database for scheduler health tests. */
function createMigratedCoreDb() {
  const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-scheduler-health-')));
  applyMigrations(coreDb);
  return coreDb;
}

/** Seeds one active local scheduler target for health probe tests. */
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
    maxConcurrentSessions: 1,
    poolId: `pool_${suffix}`,
    queueLimit: 20,
    status: 'active',
  });
  upsertSchedulerCapacityRecord(coreDb, {
    capacityClass: 'local',
    concurrencyCeiling: 1,
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

describe('scheduler health probe loop', () => {
  it('keeps the configured remote scheduler target healthy with the default probe', () => {
    const coreDb = createMigratedCoreDb();

    try {
      ensureConfiguredSchedulerBaseline(coreDb, {
        now: () => '2026-07-05T00:01:00.000Z',
        placement: 'remote',
      });

      const result = runSchedulerHealthProbeLoop(coreDb, {
        failureThreshold: 1,
        idleIntervalMs: 300_000,
        liveIntervalMs: 60_000,
        now: () => '2026-07-05T00:02:00.000Z',
        successThreshold: 1,
      });

      expect(result.probed[0]).toMatchObject({
        healthState: 'healthy',
        targetId: 'target_remote',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('probes due idle targets and schedules the idle cadence', () => {
    const coreDb = createMigratedCoreDb();

    try {
      seedLocalTarget(coreDb, 'idle');

      const result = runSchedulerHealthProbeLoop(coreDb, {
        failureThreshold: 3,
        idleIntervalMs: 300_000,
        liveIntervalMs: 60_000,
        now: () => '2026-07-05T00:02:00.000Z',
        successThreshold: 2,
        probeTarget: (target) => ({
          checks: [{ status: 'ok', surface: `probe:${target.targetId}` }],
          status: 'ok',
        }),
      });

      expect(result.probed.map((record) => record.targetId)).toEqual(['target_idle']);
      expect(result.probed[0]).toMatchObject({
        consecutiveFailureCount: 0,
        consecutiveSuccessCount: 2,
        healthState: 'healthy',
        lastProbeAt: '2026-07-05T00:02:00.000Z',
        nextProbeAt: '2026-07-05T00:07:00.000Z',
      });
      expect(result.probed[0]?.checkResults).toEqual([
        { status: 'ok', surface: 'probe:target_idle' },
      ]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('quarantines a due target after required-check failures and blocks placement', () => {
    const coreDb = createMigratedCoreDb();

    try {
      seedLocalTarget(coreDb, 'failed');

      const result = runSchedulerHealthProbeLoop(coreDb, {
        failureThreshold: 1,
        idleIntervalMs: 300_000,
        liveIntervalMs: 60_000,
        now: () => '2026-07-05T00:02:00.000Z',
        successThreshold: 2,
        probeTarget: () => ({
          checks: [
            { message: 'worker control refused', status: 'failed', surface: 'worker-control' },
          ],
          status: 'failed',
        }),
      });

      createSchedulerAdmissionEntry(coreDb, {
        triggerActor: { kind: 'user', id: 'user_local' },
        priorityClass: 'interactive',
        profileRef: 'profile_worker',
        queueEntryId: 'queue_quarantined',
        requestedAgentId: 'agent_codex_host',
        requiredPoolConstraints: ['openshell.local'],
        threadId: 'thread_failed',
        turnId: 'turn_failed',
        turnInput: 'Run after quarantine',
        workspaceId: 'ws_demo',
        now: () => '2026-07-05T00:02:01.000Z',
      });

      const dispatch = dispatchNextSchedulerEntry(coreDb, {
        agentSessionId: 'as_failed',
        expectedControlMode: 'poll',
        expectedDataPlaneMode: 'openshell-files',
        heartbeatIntervalMs: 10_000,
        heartbeatTimeoutMs: 30_000,
        leaseDurationMs: 900_000,
        leaseId: 'lease_failed',
        now: () => '2026-07-05T00:02:02.000Z',
        planId: 'plan_failed',
        sandboxBindingRef: 'lease-binding:lease_failed',
        schedulerEpoch: 1,
        startupTimeoutMs: 120_000,
      });

      expect(result.probed[0]).toMatchObject({
        consecutiveFailureCount: 1,
        consecutiveSuccessCount: 0,
        healthState: 'quarantined',
        nextProbeAt: '2026-07-05T00:07:00.000Z',
        quarantineEnteredAt: '2026-07-05T00:02:00.000Z',
      });
      expect(dispatch.status).toBe('denied');
      if (dispatch.status !== 'denied') {
        throw new Error('Expected scheduler denial.');
      }
      expect(dispatch.entry.denialReason).toBe('no-healthy-target');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('starts immediately, schedules future probes, and stops cleanly', () => {
    const coreDb = createMigratedCoreDb();
    const callbacks: Array<() => void> = [];
    const cleared: unknown[] = [];

    try {
      const service = startSchedulerHealthProbeService(coreDb, {
        failureThreshold: 3,
        idleIntervalMs: 300_000,
        intervalMs: 30_000,
        liveIntervalMs: 60_000,
        now: () => '2026-07-05T00:02:00.000Z',
        successThreshold: 2,
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

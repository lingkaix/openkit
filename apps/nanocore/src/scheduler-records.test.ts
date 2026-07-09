import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acceptSchedulerLeaseHeartbeat,
  cancelSchedulerAdmissionEntry,
  completeSchedulerSessionLease,
  createSchedulerAdmissionEntry,
  createSchedulerPlacementPlan,
  createSchedulerSessionLease,
  denySchedulerAdmissionEntry,
  dispatchNextSchedulerEntry,
  ensureLocalhostSchedulerBaseline,
  listQueuedSchedulerAdmissionEntries,
  markExpiredSchedulerLeasesStale,
  markSchedulerSessionLeaseReleasing,
  markStartupTimedOutSchedulerLeasesFailed,
  recordSchedulerSupplyRefreshAck,
  renewSchedulerSessionLease,
  resolveSchedulerLeaseTokenBinding,
  retryDeniedSchedulerAdmissionEntry,
  schedulerLeaseHasAppliedSupplyRefreshAck,
  upsertSchedulerCapacityRecord,
  upsertSchedulerTargetHealthRecord,
  upsertSchedulerWorkerPool,
} from './scheduler-records';
import { openCoreDb } from './storage/db';
import { applyMigrations } from './storage/migrate';

/**
 * Creates an isolated migrated Core database for scheduler tests.
 *
 * @returns Open Core database handle.
 */
function createMigratedCoreDb() {
  const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-scheduler-')));
  applyMigrations(coreDb);
  return coreDb;
}

/**
 * Creates a queued entry, planned placement, and acquired lease for lease lifecycle tests.
 *
 * @param coreDb Open Core database handle.
 * @param leaseId Stable lease id.
 * @returns Stored acquired lease.
 */
function createAcquiredLease(coreDb: ReturnType<typeof createMigratedCoreDb>, leaseId: string) {
  const suffix = leaseId.replace('lease_', '');

  createSchedulerAdmissionEntry(coreDb, {
    queueEntryId: `queue_${suffix}`,
    workspaceId: 'ws_demo',
    threadId: `thread_${suffix}`,
    turnId: `turn_${suffix}`,
    turnInput: `Run lease ${suffix}`,
    requestedAgentId: 'agent_worker',
    profileRef: 'profile_worker',
    priorityClass: 'interactive',
    requiredPoolConstraints: ['openshell.local'],
    now: () => '2026-07-05T00:00:00.000Z',
  });
  createSchedulerPlacementPlan(coreDb, {
    planId: `plan_${suffix}`,
    queueEntryId: `queue_${suffix}`,
    selectedPoolId: 'pool_local',
    selectedTargetId: 'target_local',
    plannedLeaseDurationMs: 900_000,
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 30_000,
    expectedControlMode: 'poll',
    expectedDataPlaneMode: 'openshell-files',
    degradedOptionalFeatures: [],
    failoverTargetId: null,
    policyDecisionIds: [],
    capacitySnapshotRef: 'target_local:1',
    schedulerEpoch: 7,
    now: () => '2026-07-05T00:00:01.000Z',
  });

  return createSchedulerSessionLease(coreDb, {
    leaseId,
    planId: `plan_${suffix}`,
    agentSessionId: `session_${suffix}`,
    packageSnapshotId: 'pkg_demo',
    sessionCompatibilityKey: `sha256:${suffix}`,
    expiresAt: '2026-07-05T00:15:01.000Z',
    heartbeatDeadline: '2026-07-05T00:00:31.000Z',
    startupDeadline: '2026-07-05T00:02:01.000Z',
    sandboxTokenBindingRef: `lease-token:${leaseId}`,
    now: () => '2026-07-05T00:00:02.000Z',
  });
}

/**
 * Creates one dispatched scheduler lease with claimed capacity.
 *
 * @param coreDb Open Core database handle.
 * @param leaseId Stable lease id.
 */
function createDispatchedLease(coreDb: ReturnType<typeof createMigratedCoreDb>, leaseId: string) {
  const suffix = leaseId.replace('lease_', '');

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
  createSchedulerAdmissionEntry(coreDb, {
    queueEntryId: `queue_${suffix}`,
    workspaceId: 'ws_demo',
    threadId: `thread_${suffix}`,
    turnId: `turn_${suffix}`,
    turnInput: `Run dispatched lease ${suffix}`,
    requestedAgentId: 'agent_worker',
    profileRef: 'profile_worker',
    priorityClass: 'interactive',
    requiredPoolConstraints: ['openshell.local'],
    now: () => '2026-07-05T00:00:01.000Z',
  });

  dispatchNextSchedulerEntry(coreDb, {
    planId: `plan_${suffix}`,
    leaseId,
    agentSessionId: `session_${suffix}`,
    packageSnapshotId: 'pkg_demo',
    schedulerEpoch: 8,
    leaseDurationMs: 900_000,
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 30_000,
    startupTimeoutMs: 120_000,
    expectedControlMode: 'poll',
    expectedDataPlaneMode: 'openshell-files',
    sandboxBindingRef: `lease-binding:${leaseId}`,
    now: () => '2026-07-05T00:00:02.000Z',
  });
}

describe('scheduler records', () => {
  it('records supply refresh acknowledgements as durable renewal declarations', () => {
    const coreDb = createMigratedCoreDb();

    try {
      const unsupported = recordSchedulerSupplyRefreshAck(coreDb, {
        agentSessionId: 'as_refresh',
        acknowledgedAt: '2026-07-05T00:00:00.000Z',
        message: 'Sidecar cannot refresh this package.',
        packageSnapshotId: 'pkg_refresh',
        refreshId: 'refresh_1',
        sequence: 1,
        status: 'unsupported',
        threadId: 'thread_refresh',
        turnId: 'turn_refresh',
        workspaceId: 'ws_demo',
      });

      expect(unsupported.status).toBe('unsupported');
      expect(
        schedulerLeaseHasAppliedSupplyRefreshAck(coreDb, {
          agentSessionId: 'as_refresh',
          packageSnapshotId: 'pkg_refresh',
        })
      ).toBe(false);

      recordSchedulerSupplyRefreshAck(coreDb, {
        agentSessionId: 'as_refresh',
        acknowledgedAt: '2026-07-05T00:00:01.000Z',
        message: null,
        packageSnapshotId: 'pkg_refresh',
        refreshId: 'refresh_1',
        sequence: 2,
        status: 'applied',
        threadId: 'thread_refresh',
        turnId: 'turn_refresh',
        workspaceId: 'ws_demo',
      });

      expect(
        schedulerLeaseHasAppliedSupplyRefreshAck(coreDb, {
          agentSessionId: 'as_refresh',
          packageSnapshotId: 'pkg_refresh',
        })
      ).toBe(true);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('persists admission queue entries in priority and FIFO order', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createSchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'queue_automation',
        workspaceId: 'ws_b',
        threadId: 'thread_b',
        turnId: 'turn_b',
        turnInput: 'Run automation work',
        requestedAgentId: 'agent_worker',
        profileRef: 'profile_worker',
        priorityClass: 'automation',
        requiredPoolConstraints: ['openshell.local'],
        now: () => '2026-07-05T00:00:02.000Z',
      });
      createSchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'queue_interactive',
        userId: 'user_interactive',
        workspaceId: 'ws_a',
        threadId: 'thread_a',
        turnId: 'turn_a',
        turnInput: 'Run interactive work',
        requestedAgentId: 'agent_worker',
        profileRef: 'profile_worker',
        priorityClass: 'interactive',
        requiredPoolConstraints: ['openshell.local'],
        workspaceCwd: '/workspace/project',
        workspaceRoots: [
          {
            access: 'read-write',
            id: 'repo',
            sourceKind: 'host-dir',
            sourcePath: '/host/project',
            workerPath: '/workspace/project',
          },
        ],
        now: () => '2026-07-05T00:00:03.000Z',
      });
      createSchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'queue_maintenance',
        workspaceId: 'ws_c',
        threadId: 'thread_c',
        turnId: 'turn_c',
        turnInput: 'Run maintenance work',
        requestedAgentId: 'agent_worker',
        profileRef: 'profile_worker',
        priorityClass: 'maintenance',
        requiredPoolConstraints: ['openshell.local'],
        now: () => '2026-07-05T00:00:01.000Z',
      });

      expect(
        listQueuedSchedulerAdmissionEntries(coreDb).map((entry) => entry.queueEntryId)
      ).toEqual(['queue_interactive', 'queue_automation', 'queue_maintenance']);
      expect(listQueuedSchedulerAdmissionEntries(coreDb)[0]?.turnInput).toBe(
        'Run interactive work'
      );
      expect(listQueuedSchedulerAdmissionEntries(coreDb)[0]?.userId).toBe('user_interactive');
      expect(listQueuedSchedulerAdmissionEntries(coreDb)[0]?.workspaceCwd).toBe(
        '/workspace/project'
      );
      expect(listQueuedSchedulerAdmissionEntries(coreDb)[0]?.workspaceRoots).toEqual([
        {
          access: 'read-write',
          id: 'repo',
          sourceKind: 'host-dir',
          sourcePath: '/host/project',
          workerPath: '/workspace/project',
        },
      ]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects a second non-terminal admission entry for the same turn', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createSchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'queue_one',
        workspaceId: 'ws_demo',
        threadId: 'thread_demo',
        turnId: 'turn_demo',
        turnInput: 'Run first queued turn',
        requestedAgentId: 'agent_worker',
        profileRef: 'profile_worker',
        priorityClass: 'interactive',
        requiredPoolConstraints: [],
        now: () => '2026-07-05T00:00:00.000Z',
      });

      expect(() =>
        createSchedulerAdmissionEntry(coreDb, {
          queueEntryId: 'queue_two',
          workspaceId: 'ws_demo',
          threadId: 'thread_demo',
          turnId: 'turn_demo',
          turnInput: 'Run duplicate queued turn',
          requestedAgentId: 'agent_worker',
          profileRef: 'profile_worker',
          priorityClass: 'interactive',
          requiredPoolConstraints: [],
          now: () => '2026-07-05T00:00:01.000Z',
        })
      ).toThrow('already has a non-terminal scheduler admission entry');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records typed denials without leaving the entry queued', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createSchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'queue_denied',
        workspaceId: 'ws_demo',
        threadId: 'thread_demo',
        turnId: 'turn_demo',
        turnInput: 'Run denied turn',
        requestedAgentId: 'agent_worker',
        profileRef: 'profile_worker',
        priorityClass: 'interactive',
        requiredPoolConstraints: [],
        now: () => '2026-07-05T00:00:00.000Z',
      });

      const denied = denySchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'queue_denied',
        denialReason: 'queue-full',
      });

      expect(denied.status).toBe('denied');
      expect(denied.denialReason).toBe('queue-full');
      expect(listQueuedSchedulerAdmissionEntries(coreDb)).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('requeues denied scheduler admissions for explicit retry', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createSchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'queue_retry_denied',
        workspaceId: 'ws_demo',
        threadId: 'thread_demo',
        turnId: 'turn_demo',
        turnInput: 'Run denied turn again',
        requestedAgentId: 'agent_worker',
        profileRef: 'profile_worker',
        priorityClass: 'interactive',
        requiredPoolConstraints: [],
        now: () => '2026-07-05T00:00:00.000Z',
      });
      denySchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'queue_retry_denied',
        denialReason: 'no-healthy-target',
      });

      const retried = retryDeniedSchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'queue_retry_denied',
      });

      expect(retried.status).toBe('queued');
      expect(retried.denialReason).toBeNull();
      expect(
        listQueuedSchedulerAdmissionEntries(coreDb).map((entry) => entry.queueEntryId)
      ).toEqual(['queue_retry_denied']);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('cancels human-actionable scheduler admissions', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createSchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'queue_cancel',
        workspaceId: 'ws_demo',
        threadId: 'thread_demo',
        turnId: 'turn_demo',
        turnInput: 'Cancel this turn',
        requestedAgentId: 'agent_worker',
        profileRef: 'profile_worker',
        priorityClass: 'interactive',
        requiredPoolConstraints: [],
        now: () => '2026-07-05T00:00:00.000Z',
      });

      const cancelled = cancelSchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'queue_cancel',
      });

      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.denialReason).toBeNull();
      expect(listQueuedSchedulerAdmissionEntries(coreDb)).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('creates placement plans from queued admission entries', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createSchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'queue_plan',
        workspaceId: 'ws_demo',
        threadId: 'thread_demo',
        turnId: 'turn_demo',
        turnInput: 'Run planned turn',
        requestedAgentId: 'agent_worker',
        profileRef: 'profile_worker',
        priorityClass: 'interactive',
        requiredPoolConstraints: ['openshell.local'],
        now: () => '2026-07-05T00:00:00.000Z',
      });

      const plan = createSchedulerPlacementPlan(coreDb, {
        planId: 'plan_demo',
        queueEntryId: 'queue_plan',
        selectedPoolId: 'pool_local',
        selectedTargetId: 'target_local',
        plannedLeaseDurationMs: 900_000,
        heartbeatIntervalMs: 10_000,
        heartbeatTimeoutMs: 30_000,
        expectedControlMode: 'poll',
        expectedDataPlaneMode: 'openshell-files',
        degradedOptionalFeatures: ['gpu'],
        failoverTargetId: null,
        policyDecisionIds: ['decision_1'],
        capacitySnapshotRef: 'target_local:1',
        schedulerEpoch: 7,
        now: () => '2026-07-05T00:00:01.000Z',
      });

      expect(plan).toMatchObject({
        planId: 'plan_demo',
        queueEntryId: 'queue_plan',
        workspaceId: 'ws_demo',
        threadId: 'thread_demo',
        turnId: 'turn_demo',
        selectedPoolId: 'pool_local',
        selectedTargetId: 'target_local',
        status: 'planned',
        schedulerEpoch: 7,
      });
      expect(plan.degradedOptionalFeatures).toEqual(['gpu']);
      expect(plan.policyDecisionIds).toEqual(['decision_1']);
      expect(listQueuedSchedulerAdmissionEntries(coreDb)).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects placement plans for terminal admission entries', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createSchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'queue_denied_plan',
        workspaceId: 'ws_demo',
        threadId: 'thread_demo',
        turnId: 'turn_demo',
        turnInput: 'Run denied placement turn',
        requestedAgentId: 'agent_worker',
        profileRef: 'profile_worker',
        priorityClass: 'interactive',
        requiredPoolConstraints: [],
        now: () => '2026-07-05T00:00:00.000Z',
      });
      denySchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'queue_denied_plan',
        denialReason: 'no-compatible-pool',
      });

      expect(() =>
        createSchedulerPlacementPlan(coreDb, {
          planId: 'plan_denied',
          queueEntryId: 'queue_denied_plan',
          selectedPoolId: 'pool_local',
          selectedTargetId: 'target_local',
          plannedLeaseDurationMs: 900_000,
          heartbeatIntervalMs: 10_000,
          heartbeatTimeoutMs: 30_000,
          expectedControlMode: 'poll',
          expectedDataPlaneMode: 'openshell-files',
          degradedOptionalFeatures: [],
          failoverTargetId: null,
          policyDecisionIds: [],
          capacitySnapshotRef: null,
          schedulerEpoch: 7,
          now: () => '2026-07-05T00:00:01.000Z',
        })
      ).toThrow('is not queued');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('acquires session leases from planned placement plans', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createSchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'queue_lease',
        workspaceId: 'ws_demo',
        threadId: 'thread_demo',
        turnId: 'turn_demo',
        turnInput: 'Run lease turn',
        requestedAgentId: 'agent_worker',
        profileRef: 'profile_worker',
        priorityClass: 'interactive',
        requiredPoolConstraints: ['openshell.local'],
        now: () => '2026-07-05T00:00:00.000Z',
      });
      createSchedulerPlacementPlan(coreDb, {
        planId: 'plan_lease',
        queueEntryId: 'queue_lease',
        selectedPoolId: 'pool_local',
        selectedTargetId: 'target_local',
        plannedLeaseDurationMs: 900_000,
        heartbeatIntervalMs: 10_000,
        heartbeatTimeoutMs: 30_000,
        expectedControlMode: 'poll',
        expectedDataPlaneMode: 'openshell-files',
        degradedOptionalFeatures: [],
        failoverTargetId: null,
        policyDecisionIds: [],
        capacitySnapshotRef: 'target_local:1',
        schedulerEpoch: 7,
        now: () => '2026-07-05T00:00:01.000Z',
      });

      const lease = createSchedulerSessionLease(coreDb, {
        leaseId: 'lease_demo',
        planId: 'plan_lease',
        agentSessionId: 'session_demo',
        packageSnapshotId: 'pkg_demo',
        sessionCompatibilityKey: 'sha256:planned-lease-compatible',
        expiresAt: '2026-07-05T00:15:01.000Z',
        heartbeatDeadline: '2026-07-05T00:00:31.000Z',
        startupDeadline: '2026-07-05T00:02:01.000Z',
        sandboxTokenBindingRef: 'lease-token:lease_demo',
        now: () => '2026-07-05T00:00:02.000Z',
      });
      const planRow = coreDb.sqlite
        .prepare('SELECT status FROM scheduler_placement_plans WHERE plan_id = ?')
        .get('plan_lease') as { status: string };

      expect(lease).toMatchObject({
        leaseId: 'lease_demo',
        planId: 'plan_lease',
        workspaceId: 'ws_demo',
        threadId: 'thread_demo',
        turnId: 'turn_demo',
        agentSessionId: 'session_demo',
        packageSnapshotId: 'pkg_demo',
        sessionCompatibilityKey: 'sha256:planned-lease-compatible',
        poolId: 'pool_local',
        targetId: 'target_local',
        status: 'acquired',
        schedulerEpoch: 7,
        renewalCount: 0,
      });
      expect(planRow.status).toBe('executing');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects session leases for non-planned placement plans', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createSchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'queue_double_lease',
        workspaceId: 'ws_demo',
        threadId: 'thread_demo',
        turnId: 'turn_demo',
        turnInput: 'Run double lease turn',
        requestedAgentId: 'agent_worker',
        profileRef: 'profile_worker',
        priorityClass: 'interactive',
        requiredPoolConstraints: ['openshell.local'],
        now: () => '2026-07-05T00:00:00.000Z',
      });
      createSchedulerPlacementPlan(coreDb, {
        planId: 'plan_double_lease',
        queueEntryId: 'queue_double_lease',
        selectedPoolId: 'pool_local',
        selectedTargetId: 'target_local',
        plannedLeaseDurationMs: 900_000,
        heartbeatIntervalMs: 10_000,
        heartbeatTimeoutMs: 30_000,
        expectedControlMode: 'poll',
        expectedDataPlaneMode: 'openshell-files',
        degradedOptionalFeatures: [],
        failoverTargetId: null,
        policyDecisionIds: [],
        capacitySnapshotRef: null,
        schedulerEpoch: 7,
        now: () => '2026-07-05T00:00:01.000Z',
      });
      createSchedulerSessionLease(coreDb, {
        leaseId: 'lease_one',
        planId: 'plan_double_lease',
        agentSessionId: 'session_demo',
        packageSnapshotId: 'pkg_demo',
        expiresAt: '2026-07-05T00:15:01.000Z',
        heartbeatDeadline: '2026-07-05T00:00:31.000Z',
        startupDeadline: '2026-07-05T00:02:01.000Z',
        sandboxTokenBindingRef: 'lease-token:lease_one',
        now: () => '2026-07-05T00:00:02.000Z',
      });

      expect(() =>
        createSchedulerSessionLease(coreDb, {
          leaseId: 'lease_two',
          planId: 'plan_double_lease',
          agentSessionId: 'session_demo',
          packageSnapshotId: 'pkg_demo',
          expiresAt: '2026-07-05T00:15:02.000Z',
          heartbeatDeadline: '2026-07-05T00:00:32.000Z',
          startupDeadline: '2026-07-05T00:02:02.000Z',
          sandboxTokenBindingRef: 'lease-token:lease_two',
          now: () => '2026-07-05T00:00:03.000Z',
        })
      ).toThrow('is not planned');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('accepts lease heartbeats and advances heartbeat deadlines', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createAcquiredLease(coreDb, 'lease_heartbeat');

      const lease = acceptSchedulerLeaseHeartbeat(coreDb, {
        leaseId: 'lease_heartbeat',
        workerSequence: 4,
        heartbeatTimeoutMs: 30_000,
        now: () => '2026-07-05T00:00:10.000Z',
      });

      expect(lease).toMatchObject({
        leaseId: 'lease_heartbeat',
        status: 'active',
        lastAcceptedHeartbeatAt: '2026-07-05T00:00:10.000Z',
        lastWorkerSequence: 4,
        heartbeatDeadline: '2026-07-05T00:00:40.000Z',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('marks expired live leases stale without reviving terminal leases', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createAcquiredLease(coreDb, 'lease_expired');
      createAcquiredLease(coreDb, 'lease_terminal');
      coreDb.sqlite
        .prepare(
          "UPDATE scheduler_session_leases SET status = 'released', release_reason = 'completed' WHERE lease_id = ?"
        )
        .run('lease_terminal');

      const stale = markExpiredSchedulerLeasesStale(coreDb, {
        now: () => '2026-07-05T00:01:00.000Z',
      });

      expect(stale.map((lease) => lease.leaseId)).toEqual(['lease_expired']);
      expect(stale[0]).toMatchObject({
        status: 'stale',
        releaseReason: 'heartbeat-timeout',
        recoveryState: 'needs-evidence',
      });
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM scheduler_session_leases WHERE lease_id = ?')
          .get('lease_terminal')
      ).toEqual({ status: 'released' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('completes leases and releases pool capacity in one terminal transition', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createDispatchedLease(coreDb, 'lease_terminal_release');

      const lease = completeSchedulerSessionLease(coreDb, {
        leaseId: 'lease_terminal_release',
        terminalStatus: 'released',
        releaseReason: 'final-status-collected',
        recoveryState: 'evidence-collected',
      });

      expect(lease).toMatchObject({
        status: 'released',
        releaseReason: 'final-status-collected',
        recoveryState: 'evidence-collected',
      });
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT in_use_count, version FROM scheduler_capacity_records WHERE target_id = ?'
          )
          .get('target_terminal_release')
      ).toEqual({ in_use_count: 0, version: 3 });
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT current_admitted_session_count FROM scheduler_worker_pools WHERE pool_id = ?'
          )
          .get('pool_terminal_release')
      ).toEqual({ current_admitted_session_count: 0 });
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM scheduler_placement_plans WHERE plan_id = ?')
          .get('plan_terminal_release')
      ).toEqual({ status: 'completed' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects repeated terminal transitions without double releasing capacity', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createDispatchedLease(coreDb, 'lease_double_terminal');
      completeSchedulerSessionLease(coreDb, {
        leaseId: 'lease_double_terminal',
        terminalStatus: 'failed',
        releaseReason: 'worker-failed',
        recoveryState: 'evidence-missing',
      });

      expect(() =>
        completeSchedulerSessionLease(coreDb, {
          leaseId: 'lease_double_terminal',
          terminalStatus: 'released',
          releaseReason: 'duplicate',
        })
      ).toThrow('already terminal');
      expect(
        coreDb.sqlite
          .prepare('SELECT in_use_count FROM scheduler_capacity_records WHERE target_id = ?')
          .get('target_double_terminal')
      ).toEqual({ in_use_count: 0 });
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT current_admitted_session_count FROM scheduler_worker_pools WHERE pool_id = ?'
          )
          .get('pool_double_terminal')
      ).toEqual({ current_admitted_session_count: 0 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('fails startup-timed-out leases and releases claimed capacity', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createDispatchedLease(coreDb, 'lease_startup_timeout');

      const failed = markStartupTimedOutSchedulerLeasesFailed(coreDb, {
        now: () => '2026-07-05T00:03:00.000Z',
      });

      expect(failed.map((lease) => lease.leaseId)).toEqual(['lease_startup_timeout']);
      expect(failed[0]).toMatchObject({
        status: 'failed',
        releaseReason: 'startup-timeout',
        recoveryState: 'needs-evidence',
      });
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT in_use_count, version FROM scheduler_capacity_records WHERE target_id = ?'
          )
          .get('target_startup_timeout')
      ).toEqual({ in_use_count: 0, version: 3 });
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT current_admitted_session_count FROM scheduler_worker_pools WHERE pool_id = ?'
          )
          .get('pool_startup_timeout')
      ).toEqual({ current_admitted_session_count: 0 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('does not fail startup deadlines after the first heartbeat is accepted', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createDispatchedLease(coreDb, 'lease_started');
      acceptSchedulerLeaseHeartbeat(coreDb, {
        leaseId: 'lease_started',
        workerSequence: 1,
        heartbeatTimeoutMs: 300_000,
        now: () => '2026-07-05T00:00:10.000Z',
      });

      expect(
        markStartupTimedOutSchedulerLeasesFailed(coreDb, {
          now: () => '2026-07-05T00:03:00.000Z',
        })
      ).toEqual([]);
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM scheduler_session_leases WHERE lease_id = ?')
          .get('lease_started')
      ).toEqual({ status: 'active' });
      expect(
        coreDb.sqlite
          .prepare('SELECT in_use_count FROM scheduler_capacity_records WHERE target_id = ?')
          .get('target_started')
      ).toEqual({ in_use_count: 1 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('renews live leases without changing heartbeat deadlines', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createDispatchedLease(coreDb, 'lease_renewal');
      acceptSchedulerLeaseHeartbeat(coreDb, {
        leaseId: 'lease_renewal',
        workerSequence: 2,
        heartbeatTimeoutMs: 300_000,
        now: () => '2026-07-05T00:00:10.000Z',
      });

      const renewed = renewSchedulerSessionLease(coreDb, {
        leaseId: 'lease_renewal',
        expiresAt: '2026-07-05T00:30:02.000Z',
        now: () => '2026-07-05T00:10:00.000Z',
      });

      expect(renewed).toMatchObject({
        status: 'active',
        expiresAt: '2026-07-05T00:30:02.000Z',
        heartbeatDeadline: '2026-07-05T00:05:10.000Z',
        renewalCount: 1,
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects renewal after lease expiry', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createDispatchedLease(coreDb, 'lease_expired_renewal');

      expect(() =>
        renewSchedulerSessionLease(coreDb, {
          leaseId: 'lease_expired_renewal',
          expiresAt: '2026-07-05T00:30:02.000Z',
          now: () => '2026-07-05T00:16:00.000Z',
        })
      ).toThrow('cannot be renewed after expiry');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('marks a live lease releasing without releasing capacity', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createDispatchedLease(coreDb, 'lease_releasing');

      const releasing = markSchedulerSessionLeaseReleasing(coreDb, {
        leaseId: 'lease_releasing',
        releaseReason: 'worker-final-status',
      });
      const capacity = coreDb.sqlite
        .prepare(
          "SELECT in_use_count AS inUseCount FROM scheduler_capacity_records WHERE pool_id = 'pool_releasing'"
        )
        .get() as { inUseCount: number };

      expect(releasing).toMatchObject({
        leaseId: 'lease_releasing',
        status: 'releasing',
        releaseReason: 'worker-final-status',
        recoveryState: 'needs-evidence',
      });
      expect(capacity.inUseCount).toBe(1);
      expect(
        resolveSchedulerLeaseTokenBinding(coreDb, {
          sandboxBindingRef: 'lease-binding:lease_releasing',
          lineage: {
            agentSessionId: 'session_releasing',
            packageSnapshotId: 'pkg_demo',
            threadId: 'thread_releasing',
            turnId: 'turn_releasing',
            workspaceId: 'ws_demo',
          },
        })
      ).toEqual({ status: 'rejected', reason: 'lease-not-live' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('resolves live lease token bindings through durable scheduler records', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createDispatchedLease(coreDb, 'lease_binding');

      const resolution = resolveSchedulerLeaseTokenBinding(coreDb, {
        sandboxBindingRef: 'lease-binding:lease_binding',
        lineage: {
          agentSessionId: 'session_binding',
          packageSnapshotId: 'pkg_demo',
          threadId: 'thread_binding',
          turnId: 'turn_binding',
          workspaceId: 'ws_demo',
        },
      });

      expect(resolution).toMatchObject({
        status: 'accepted',
        lease: {
          leaseId: 'lease_binding',
          status: 'acquired',
        },
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects missing, mismatched, and non-live lease token bindings', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createDispatchedLease(coreDb, 'lease_binding_rejected');
      const lineage = {
        agentSessionId: 'session_binding_rejected',
        packageSnapshotId: 'pkg_demo',
        threadId: 'thread_binding_rejected',
        turnId: 'turn_binding_rejected',
        workspaceId: 'ws_demo',
      };

      expect(
        resolveSchedulerLeaseTokenBinding(coreDb, {
          sandboxBindingRef: 'lease-binding:missing',
          lineage,
        })
      ).toEqual({ status: 'rejected', reason: 'binding-not-found' });
      expect(
        resolveSchedulerLeaseTokenBinding(coreDb, {
          sandboxBindingRef: 'lease-binding:lease_binding_rejected',
          lineage: { ...lineage, threadId: 'thread_other' },
        })
      ).toEqual({ status: 'rejected', reason: 'lineage-mismatch' });

      completeSchedulerSessionLease(coreDb, {
        leaseId: 'lease_binding_rejected',
        terminalStatus: 'released',
        releaseReason: 'completed',
      });

      expect(
        resolveSchedulerLeaseTokenBinding(coreDb, {
          sandboxBindingRef: 'lease-binding:lease_binding_rejected',
          lineage,
        })
      ).toEqual({ status: 'rejected', reason: 'lease-not-live' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('persists worker pool records', () => {
    const coreDb = createMigratedCoreDb();

    try {
      const pool = upsertSchedulerWorkerPool(coreDb, {
        poolId: 'pool_local',
        allowedBackendKinds: ['openshell'],
        allowedPlacements: ['local'],
        maxConcurrentSessions: 2,
        queueLimit: 20,
        defaultTimeoutMs: 900_000,
        allowedWorkspaceScopes: ['local'],
        budgetClass: 'interactive',
        healthSummary: 'ready',
        currentAdmittedSessionCount: 1,
        currentQueueDepth: 3,
        status: 'active',
      });

      expect(pool).toMatchObject({
        poolId: 'pool_local',
        maxConcurrentSessions: 2,
        queueLimit: 20,
        status: 'active',
        warmSessionTarget: null,
      });
      expect(pool.allowedBackendKinds).toEqual(['openshell']);
      expect(pool.allowedPlacements).toEqual(['local']);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('creates the localhost baseline with two local slots', () => {
    const coreDb = createMigratedCoreDb();

    try {
      ensureLocalhostSchedulerBaseline(coreDb, {
        now: () => '2026-07-05T00:00:00.000Z',
      });

      expect(
        coreDb.sqlite
          .prepare(
            'SELECT max_concurrent_sessions AS maxConcurrentSessions FROM scheduler_worker_pools WHERE pool_id = ?'
          )
          .get('pool_local')
      ).toEqual({ maxConcurrentSessions: 2 });
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT concurrency_ceiling AS concurrencyCeiling FROM scheduler_capacity_records WHERE target_id = ?'
          )
          .get('target_local')
      ).toEqual({ concurrencyCeiling: 2 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('increments capacity versions on each target capacity write', () => {
    const coreDb = createMigratedCoreDb();

    try {
      const first = upsertSchedulerCapacityRecord(coreDb, {
        targetId: 'target_local',
        poolId: 'pool_local',
        capacityClass: 'local',
        concurrencyCeiling: 2,
        inUseCount: 0,
        queueDepth: 0,
        observationSource: 'configured',
        observedAt: '2026-07-05T00:00:00.000Z',
      });
      const second = upsertSchedulerCapacityRecord(coreDb, {
        targetId: 'target_local',
        poolId: 'pool_local',
        capacityClass: 'local',
        concurrencyCeiling: 2,
        inUseCount: 1,
        queueDepth: 2,
        observationSource: 'probe',
        observedAt: '2026-07-05T00:00:10.000Z',
      });

      expect(first.version).toBe(1);
      expect(second).toMatchObject({
        targetId: 'target_local',
        poolId: 'pool_local',
        inUseCount: 1,
        queueDepth: 2,
        observationSource: 'probe',
        version: 2,
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('persists target health records', () => {
    const coreDb = createMigratedCoreDb();

    try {
      const health = upsertSchedulerTargetHealthRecord(coreDb, {
        targetId: 'target_local',
        healthState: 'probation',
        checkResults: [{ surface: 'control-relay', status: 'ok' }],
        consecutiveFailureCount: 0,
        consecutiveSuccessCount: 2,
        quarantineEnteredAt: null,
        probationDeadline: '2026-07-05T00:05:00.000Z',
        lastProbeAt: '2026-07-05T00:00:00.000Z',
        nextProbeAt: '2026-07-05T00:01:00.000Z',
      });

      expect(health).toMatchObject({
        targetId: 'target_local',
        healthState: 'probation',
        consecutiveFailureCount: 0,
        consecutiveSuccessCount: 2,
        probationDeadline: '2026-07-05T00:05:00.000Z',
      });
      expect(health.checkResults).toEqual([{ surface: 'control-relay', status: 'ok' }]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('dispatches the next queued entry to an acquired lease on the localhost baseline', () => {
    const coreDb = createMigratedCoreDb();

    try {
      upsertSchedulerWorkerPool(coreDb, {
        poolId: 'pool_local',
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
        targetId: 'target_local',
        poolId: 'pool_local',
        capacityClass: 'local',
        concurrencyCeiling: 2,
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
      createSchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'queue_dispatch',
        workspaceId: 'ws_demo',
        threadId: 'thread_demo',
        turnId: 'turn_demo',
        turnInput: 'Run dispatched turn',
        requestedAgentId: 'agent_worker',
        profileRef: 'profile_worker',
        priorityClass: 'interactive',
        requiredPoolConstraints: ['openshell.local'],
        now: () => '2026-07-05T00:00:01.000Z',
      });

      const result = dispatchNextSchedulerEntry(coreDb, {
        planId: 'plan_dispatch',
        leaseId: 'lease_dispatch',
        agentSessionId: 'session_dispatch',
        schedulerEpoch: 8,
        leaseDurationMs: 900_000,
        heartbeatIntervalMs: 10_000,
        heartbeatTimeoutMs: 30_000,
        startupTimeoutMs: 120_000,
        expectedControlMode: 'poll',
        expectedDataPlaneMode: 'openshell-files',
        sandboxBindingRef: 'lease-binding:lease_dispatch',
        now: () => '2026-07-05T00:00:02.000Z',
      });

      expect(result.status).toBe('dispatched');
      if (result.status !== 'dispatched') {
        throw new Error('Expected dispatch result.');
      }
      expect(result.plan).toMatchObject({
        planId: 'plan_dispatch',
        selectedPoolId: 'pool_local',
        selectedTargetId: 'target_local',
        status: 'executing',
      });
      expect(result.lease).toMatchObject({
        leaseId: 'lease_dispatch',
        poolId: 'pool_local',
        targetId: 'target_local',
        packageSnapshotId: 'aepsnap_turn_demo_session_dispatch',
        status: 'acquired',
        expiresAt: '2026-07-05T00:15:02.000Z',
        heartbeatDeadline: '2026-07-05T00:00:32.000Z',
        startupDeadline: '2026-07-05T00:02:02.000Z',
      });
      expect(listQueuedSchedulerAdmissionEntries(coreDb)).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('skips queued entries whose thread already has a live lease', () => {
    const coreDb = createMigratedCoreDb();

    try {
      upsertSchedulerWorkerPool(coreDb, {
        poolId: 'pool_local',
        allowedBackendKinds: ['openshell'],
        allowedPlacements: ['local'],
        maxConcurrentSessions: 2,
        queueLimit: 20,
        defaultTimeoutMs: 900_000,
        allowedWorkspaceScopes: ['local'],
        budgetClass: 'interactive',
        healthSummary: 'ready',
        currentAdmittedSessionCount: 0,
        currentQueueDepth: 3,
        status: 'active',
      });
      upsertSchedulerCapacityRecord(coreDb, {
        targetId: 'target_local',
        poolId: 'pool_local',
        capacityClass: 'local',
        concurrencyCeiling: 2,
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
      createSchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'queue_thread_first',
        workspaceId: 'ws_demo',
        threadId: 'thread_shared',
        turnId: 'turn_thread_first',
        turnInput: 'Run first shared-thread turn',
        requestedAgentId: 'agent_worker',
        profileRef: 'profile_worker',
        priorityClass: 'interactive',
        requiredPoolConstraints: ['openshell.local'],
        now: () => '2026-07-05T00:00:01.000Z',
      });

      const first = dispatchNextSchedulerEntry(coreDb, {
        planId: 'plan_thread_first',
        leaseId: 'lease_thread_first',
        agentSessionId: 'session_thread_first',
        schedulerEpoch: 8,
        leaseDurationMs: 900_000,
        heartbeatIntervalMs: 10_000,
        heartbeatTimeoutMs: 30_000,
        startupTimeoutMs: 120_000,
        expectedControlMode: 'poll',
        expectedDataPlaneMode: 'openshell-files',
        sandboxBindingRef: 'lease-binding:lease_thread_first',
        now: () => '2026-07-05T00:00:02.000Z',
      });

      expect(first.status).toBe('dispatched');
      createSchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'queue_thread_second',
        workspaceId: 'ws_demo',
        threadId: 'thread_shared',
        turnId: 'turn_thread_second',
        turnInput: 'Run second shared-thread turn',
        requestedAgentId: 'agent_worker',
        profileRef: 'profile_worker',
        priorityClass: 'interactive',
        requiredPoolConstraints: ['openshell.local'],
        now: () => '2026-07-05T00:00:03.000Z',
      });
      createSchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'queue_thread_other',
        workspaceId: 'ws_demo',
        threadId: 'thread_other',
        turnId: 'turn_thread_other',
        turnInput: 'Run other thread turn',
        requestedAgentId: 'agent_worker',
        profileRef: 'profile_worker',
        priorityClass: 'interactive',
        requiredPoolConstraints: ['openshell.local'],
        now: () => '2026-07-05T00:00:04.000Z',
      });

      const second = dispatchNextSchedulerEntry(coreDb, {
        planId: 'plan_thread_other',
        leaseId: 'lease_thread_other',
        agentSessionId: 'session_thread_other',
        schedulerEpoch: 8,
        leaseDurationMs: 900_000,
        heartbeatIntervalMs: 10_000,
        heartbeatTimeoutMs: 30_000,
        startupTimeoutMs: 120_000,
        expectedControlMode: 'poll',
        expectedDataPlaneMode: 'openshell-files',
        sandboxBindingRef: 'lease-binding:lease_thread_other',
        now: () => '2026-07-05T00:00:05.000Z',
      });

      expect(second.status).toBe('dispatched');
      if (second.status !== 'dispatched') {
        throw new Error('Expected dispatch result.');
      }
      expect(second.entry.queueEntryId).toBe('queue_thread_other');
      expect(
        listQueuedSchedulerAdmissionEntries(coreDb).map((entry) => entry.queueEntryId)
      ).toEqual(['queue_thread_second']);
      expect(
        dispatchNextSchedulerEntry(coreDb, {
          planId: 'plan_thread_busy',
          leaseId: 'lease_thread_busy',
          agentSessionId: 'session_thread_busy',
          schedulerEpoch: 8,
          leaseDurationMs: 900_000,
          heartbeatIntervalMs: 10_000,
          heartbeatTimeoutMs: 30_000,
          startupTimeoutMs: 120_000,
          expectedControlMode: 'poll',
          expectedDataPlaneMode: 'openshell-files',
          sandboxBindingRef: 'lease-binding:lease_thread_busy',
          now: () => '2026-07-05T00:00:06.000Z',
        })
      ).toEqual({ status: 'queued', reason: 'thread-busy' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('leaves queued entries waiting when compatible capacity is full', () => {
    const coreDb = createMigratedCoreDb();

    try {
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
        currentAdmittedSessionCount: 1,
        currentQueueDepth: 1,
        status: 'active',
      });
      upsertSchedulerCapacityRecord(coreDb, {
        targetId: 'target_local',
        poolId: 'pool_local',
        capacityClass: 'local',
        concurrencyCeiling: 1,
        inUseCount: 1,
        queueDepth: 1,
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
      createSchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'queue_wait',
        workspaceId: 'ws_demo',
        threadId: 'thread_demo',
        turnId: 'turn_demo',
        turnInput: 'Run waiting turn',
        requestedAgentId: 'agent_worker',
        profileRef: 'profile_worker',
        priorityClass: 'interactive',
        requiredPoolConstraints: ['openshell.local'],
        now: () => '2026-07-05T00:00:01.000Z',
      });

      expect(
        dispatchNextSchedulerEntry(coreDb, {
          planId: 'plan_wait',
          leaseId: 'lease_wait',
          agentSessionId: 'session_wait',
          packageSnapshotId: 'pkg_wait',
          schedulerEpoch: 8,
          leaseDurationMs: 900_000,
          heartbeatIntervalMs: 10_000,
          heartbeatTimeoutMs: 30_000,
          startupTimeoutMs: 120_000,
          expectedControlMode: 'poll',
          expectedDataPlaneMode: 'openshell-files',
          sandboxBindingRef: 'lease-binding:lease_wait',
          now: () => '2026-07-05T00:00:02.000Z',
        })
      ).toEqual({ status: 'queued', reason: 'capacity-saturated' });
      expect(
        listQueuedSchedulerAdmissionEntries(coreDb).map((entry) => entry.queueEntryId)
      ).toEqual(['queue_wait']);
    } finally {
      coreDb.sqlite.close();
    }
  });
});

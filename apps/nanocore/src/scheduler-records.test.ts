import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  recordWorkerBackendSessionMaterializing,
  transitionWorkerBackendSessionState,
} from './runtime/worker-backend-sessions.js';
import {
  acceptSchedulerLeaseHeartbeat,
  cancelSchedulerAdmissionEntry,
  completeSchedulerLeaseForTerminalTurn,
  completeSchedulerSessionLease,
  createSchedulerAdmissionEntry,
  createSchedulerPlacementPlan,
  createSchedulerSessionLease,
  denySchedulerAdmissionEntry,
  dispatchNextSchedulerEntry,
  ensureConfiguredSchedulerBaseline,
  expireReleasingSchedulerLeases,
  listQueuedSchedulerAdmissionEntries,
  listSchedulerAdmissionEntriesForWorkspace,
  listSchedulerLeasesNeedingWorkspaceRecovery,
  markExpiredSchedulerLeasesStale,
  markSchedulerSessionLeaseReleasing,
  recordSchedulerSupplyRefreshAck,
  renewSchedulerSessionLease,
  resolveSchedulerLeaseTokenBinding,
  retryDeniedSchedulerAdmissionEntry,
  schedulerLeaseHasAppliedSupplyRefreshAck,
  transitionStartupTimedOutSchedulerLeases,
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
    triggerActor: { kind: 'user', id: 'user_local' },
    queueEntryId: `queue_${suffix}`,
    workspaceId: 'ws_demo',
    threadId: `thread_${suffix}`,
    turnId: `turn_${suffix}`,
    turnInput: `Run lease ${suffix}`,
    requestedAgentId: 'agent_worker',
    profileRef: null,
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
    triggerActor: { kind: 'user', id: 'user_local' },
    queueEntryId: `queue_${suffix}`,
    workspaceId: 'ws_demo',
    threadId: `thread_${suffix}`,
    turnId: `turn_${suffix}`,
    turnInput: `Run dispatched lease ${suffix}`,
    requestedAgentId: 'agent_worker',
    profileRef: null,
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

/** Reads every row participating in one terminal scheduler accounting transaction. */
function terminalAccountingSnapshot(
  coreDb: ReturnType<typeof createMigratedCoreDb>,
  suffix: string
): Record<string, unknown> {
  return {
    admission: coreDb.sqlite
      .prepare('SELECT * FROM scheduler_admission_entries WHERE queue_entry_id = ?')
      .get(`queue_${suffix}`),
    capacity: coreDb.sqlite
      .prepare('SELECT * FROM scheduler_capacity_records WHERE target_id = ?')
      .get(`target_${suffix}`),
    lease: coreDb.sqlite
      .prepare('SELECT * FROM scheduler_session_leases WHERE lease_id = ?')
      .get(`lease_${suffix}`),
    plan: coreDb.sqlite
      .prepare('SELECT * FROM scheduler_placement_plans WHERE plan_id = ?')
      .get(`plan_${suffix}`),
    pool: coreDb.sqlite
      .prepare('SELECT * FROM scheduler_worker_pools WHERE pool_id = ?')
      .get(`pool_${suffix}`),
  };
}

const terminalAccountingCorruptions: ReadonlyArray<{
  readonly apply: (coreDb: ReturnType<typeof createMigratedCoreDb>, suffix: string) => void;
  readonly expectedError: RegExp;
  readonly name: string;
}> = [
  {
    apply: (coreDb, suffix) => {
      coreDb.sqlite
        .prepare('DELETE FROM scheduler_placement_plans WHERE plan_id = ?')
        .run(`plan_${suffix}`);
    },
    expectedError: /placement plan/i,
    name: 'missing placement plan',
  },
  {
    apply: (coreDb, suffix) => {
      coreDb.sqlite
        .prepare("UPDATE scheduler_placement_plans SET status = 'completed' WHERE plan_id = ?")
        .run(`plan_${suffix}`);
    },
    expectedError: /placement plan/i,
    name: 'changed placement plan state',
  },
  {
    apply: (coreDb, suffix) => {
      coreDb.sqlite
        .prepare('DELETE FROM scheduler_admission_entries WHERE queue_entry_id = ?')
        .run(`queue_${suffix}`);
    },
    expectedError: /admission/i,
    name: 'missing admission',
  },
  {
    apply: (coreDb, suffix) => {
      coreDb.sqlite
        .prepare('DELETE FROM scheduler_capacity_records WHERE target_id = ?')
        .run(`target_${suffix}`);
    },
    expectedError: /capacity/i,
    name: 'missing capacity row',
  },
  {
    apply: (coreDb, suffix) => {
      coreDb.sqlite
        .prepare('UPDATE scheduler_capacity_records SET in_use_count = 0 WHERE target_id = ?')
        .run(`target_${suffix}`);
    },
    expectedError: /capacity/i,
    name: 'zero capacity counter',
  },
  {
    apply: (coreDb, suffix) => {
      coreDb.sqlite
        .prepare('DELETE FROM scheduler_worker_pools WHERE pool_id = ?')
        .run(`pool_${suffix}`);
    },
    expectedError: /pool/i,
    name: 'missing worker pool',
  },
  {
    apply: (coreDb, suffix) => {
      coreDb.sqlite
        .prepare(
          'UPDATE scheduler_worker_pools SET current_admitted_session_count = 0 WHERE pool_id = ?'
        )
        .run(`pool_${suffix}`);
    },
    expectedError: /pool/i,
    name: 'zero pool counter',
  },
];

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
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId: 'queue_automation',
        workspaceId: 'ws_b',
        threadId: 'thread_b',
        turnId: 'turn_b',
        turnInput: 'Run automation work',
        requestedAgentId: 'agent_worker',
        profileRef: null,
        priorityClass: 'automation',
        requiredPoolConstraints: ['openshell.local'],
        now: () => '2026-07-05T00:00:02.000Z',
      });
      createSchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'queue_interactive',
        triggerActor: {
          kind: 'automation',
          id: 'automation_interactive',
          responsibleUserId: 'user_interactive',
        },
        workspaceId: 'ws_a',
        threadId: 'thread_a',
        turnId: 'turn_a',
        turnInput: 'Run interactive work',
        requestedAgentId: 'agent_worker',
        profileRef: null,
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
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId: 'queue_maintenance',
        workspaceId: 'ws_c',
        threadId: 'thread_c',
        turnId: 'turn_c',
        turnInput: 'Run maintenance work',
        requestedAgentId: 'agent_worker',
        profileRef: null,
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
      expect(listQueuedSchedulerAdmissionEntries(coreDb)[0]?.triggerActor).toEqual({
        kind: 'automation',
        id: 'automation_interactive',
        responsibleUserId: 'user_interactive',
      });
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
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId: 'queue_one',
        workspaceId: 'ws_demo',
        threadId: 'thread_demo',
        turnId: 'turn_demo',
        turnInput: 'Run first queued turn',
        requestedAgentId: 'agent_worker',
        profileRef: null,
        priorityClass: 'interactive',
        requiredPoolConstraints: [],
        now: () => '2026-07-05T00:00:00.000Z',
      });

      expect(() =>
        createSchedulerAdmissionEntry(coreDb, {
          triggerActor: { kind: 'user', id: 'user_local' },
          queueEntryId: 'queue_two',
          workspaceId: 'ws_demo',
          threadId: 'thread_demo',
          turnId: 'turn_demo',
          turnInput: 'Run duplicate queued turn',
          requestedAgentId: 'agent_worker',
          profileRef: null,
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
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId: 'queue_denied',
        workspaceId: 'ws_demo',
        threadId: 'thread_demo',
        turnId: 'turn_demo',
        turnInput: 'Run denied turn',
        requestedAgentId: 'agent_worker',
        profileRef: null,
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
        triggerActor: { kind: 'user', id: 'user_original_trigger' },
        workspaceId: 'ws_demo',
        threadId: 'thread_demo',
        turnId: 'turn_demo',
        turnInput: 'Run denied turn again',
        requestedAgentId: 'agent_worker',
        profileRef: null,
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
        workspaceId: 'ws_demo',
      });

      expect(retried.status).toBe('queued');
      expect(retried.denialReason).toBeNull();
      expect(
        listQueuedSchedulerAdmissionEntries(coreDb).map((entry) => entry.queueEntryId)
      ).toEqual(['queue_retry_denied']);
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          workspaceId: 'ws_demo',
          statuses: ['queued'],
        })
      ).toEqual([
        expect.objectContaining({
          triggerActor: { kind: 'user', id: 'user_original_trigger' },
        }),
      ]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('cancels human-actionable scheduler admissions', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createSchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'queue_cancel',
        triggerActor: { kind: 'user', id: 'user_original_trigger' },
        workspaceId: 'ws_demo',
        threadId: 'thread_demo',
        turnId: 'turn_demo',
        turnInput: 'Cancel this turn',
        requestedAgentId: 'agent_worker',
        profileRef: null,
        priorityClass: 'interactive',
        requiredPoolConstraints: [],
        now: () => '2026-07-05T00:00:00.000Z',
      });

      const cancelled = cancelSchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'queue_cancel',
        workspaceId: 'ws_demo',
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
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId: 'queue_plan',
        workspaceId: 'ws_demo',
        threadId: 'thread_demo',
        turnId: 'turn_demo',
        turnInput: 'Run planned turn',
        requestedAgentId: 'agent_worker',
        profileRef: null,
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
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId: 'queue_denied_plan',
        workspaceId: 'ws_demo',
        threadId: 'thread_demo',
        turnId: 'turn_demo',
        turnInput: 'Run denied placement turn',
        requestedAgentId: 'agent_worker',
        profileRef: null,
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
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId: 'queue_lease',
        workspaceId: 'ws_demo',
        threadId: 'thread_demo',
        turnId: 'turn_demo',
        turnInput: 'Run lease turn',
        requestedAgentId: 'agent_worker',
        profileRef: null,
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
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId: 'queue_double_lease',
        workspaceId: 'ws_demo',
        threadId: 'thread_demo',
        turnId: 'turn_demo',
        turnInput: 'Run double lease turn',
        requestedAgentId: 'agent_worker',
        profileRef: null,
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

  it('treats a repeated heartbeat sequence as an idempotent retry', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createAcquiredLease(coreDb, 'lease_heartbeat_retry');
      const first = acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        leaseId: 'lease_heartbeat_retry',
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 4,
      });
      const retry = acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        leaseId: 'lease_heartbeat_retry',
        now: () => '2026-07-05T00:00:20.000Z',
        workerSequence: 4,
      });

      expect(retry).toEqual(first);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('treats a concurrent same-sequence heartbeat winner as an idempotent retry', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createAcquiredLease(coreDb, 'lease_heartbeat_concurrent_retry');
      let winner: ReturnType<typeof acceptSchedulerLeaseHeartbeat> | null = null;
      const retry = acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        leaseId: 'lease_heartbeat_concurrent_retry',
        now: () => {
          winner = acceptSchedulerLeaseHeartbeat(coreDb, {
            heartbeatTimeoutMs: 30_000,
            leaseId: 'lease_heartbeat_concurrent_retry',
            now: () => '2026-07-05T00:00:10.000Z',
            workerSequence: 4,
          });
          return '2026-07-05T00:00:11.000Z';
        },
        workerSequence: 4,
      });

      expect(retry).toEqual(winner);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('classifies a concurrent newer heartbeat winner as a stale sequence', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createAcquiredLease(coreDb, 'lease_heartbeat_concurrent_newer');

      expect(() =>
        acceptSchedulerLeaseHeartbeat(coreDb, {
          heartbeatTimeoutMs: 30_000,
          leaseId: 'lease_heartbeat_concurrent_newer',
          now: () => {
            acceptSchedulerLeaseHeartbeat(coreDb, {
              heartbeatTimeoutMs: 30_000,
              leaseId: 'lease_heartbeat_concurrent_newer',
              now: () => '2026-07-05T00:00:10.000Z',
              workerSequence: 5,
            });
            return '2026-07-05T00:00:11.000Z';
          },
          workerSequence: 4,
        })
      ).toThrowError(expect.objectContaining({ reason: 'sequence-stale' }));
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects heartbeat sequences older than the last accepted sequence', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createAcquiredLease(coreDb, 'lease_heartbeat_stale_sequence');
      const accepted = acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        leaseId: 'lease_heartbeat_stale_sequence',
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 4,
      });

      expect(() =>
        acceptSchedulerLeaseHeartbeat(coreDb, {
          heartbeatTimeoutMs: 30_000,
          leaseId: 'lease_heartbeat_stale_sequence',
          now: () => '2026-07-05T00:00:20.000Z',
          workerSequence: 3,
        })
      ).toThrow();
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT heartbeat_deadline AS heartbeatDeadline,
                    last_accepted_heartbeat_at AS lastAcceptedHeartbeatAt,
                    last_worker_sequence AS lastWorkerSequence
             FROM scheduler_session_leases
             WHERE lease_id = ?`
          )
          .get('lease_heartbeat_stale_sequence')
      ).toEqual({
        heartbeatDeadline: accepted.heartbeatDeadline,
        lastAcceptedHeartbeatAt: accepted.lastAcceptedHeartbeatAt,
        lastWorkerSequence: accepted.lastWorkerSequence,
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('advances a lease only for a newer heartbeat sequence', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createAcquiredLease(coreDb, 'lease_heartbeat_newer_sequence');
      acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        leaseId: 'lease_heartbeat_newer_sequence',
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 4,
      });

      expect(
        acceptSchedulerLeaseHeartbeat(coreDb, {
          heartbeatTimeoutMs: 30_000,
          leaseId: 'lease_heartbeat_newer_sequence',
          now: () => '2026-07-05T00:00:20.000Z',
          workerSequence: 5,
        })
      ).toMatchObject({
        heartbeatDeadline: '2026-07-05T00:00:50.000Z',
        lastAcceptedHeartbeatAt: '2026-07-05T00:00:20.000Z',
        lastWorkerSequence: 5,
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('does not revive a lease that starts releasing before the heartbeat update', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createAcquiredLease(coreDb, 'lease_heartbeat_race');

      expect(() =>
        acceptSchedulerLeaseHeartbeat(coreDb, {
          heartbeatTimeoutMs: 30_000,
          leaseId: 'lease_heartbeat_race',
          now: () => {
            markSchedulerSessionLeaseReleasing(coreDb, {
              leaseId: 'lease_heartbeat_race',
              releaseReason: 'worker-final-status',
            });
            return '2026-07-05T00:00:10.000Z';
          },
          workerSequence: 4,
        })
      ).toThrow('cannot accept heartbeat');
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM scheduler_session_leases WHERE lease_id = ?')
          .get('lease_heartbeat_race')
      ).toEqual({ status: 'releasing' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('marks expired live leases stale without reviving terminal leases', () => {
    const coreDb = createMigratedCoreDb();
    const commandId = 'b'.repeat(64);

    try {
      createAcquiredLease(coreDb, 'lease_expired');
      createAcquiredLease(coreDb, 'lease_terminal');
      acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        leaseId: 'lease_expired',
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });
      coreDb.sqlite
        .prepare(
          `INSERT INTO worker_control_commands (
            workspace_id, thread_id, turn_id, agent_session_id, package_snapshot_id,
            request_id, command_id, command_kind, sequence, payload_json, status,
            queued_at, delivered_at, acknowledged_at
          ) VALUES (?, ?, ?, ?, ?, NULL, ?, 'interrupt', 1, ?, 'delivered', ?, ?, NULL)`
        )
        .run(
          'ws_demo',
          'thread_expired',
          'turn_expired',
          'session_expired',
          'pkg_demo',
          commandId,
          '{"reason":null}',
          '2026-07-05T00:00:03.000Z',
          '2026-07-05T00:00:04.000Z'
        );
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
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM worker_control_commands WHERE command_id = ?')
          .get(commandId)
      ).toEqual({ status: 'undeliverable' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('completes leases and releases pool capacity in one terminal transition', () => {
    const coreDb = createMigratedCoreDb();
    const commandId = 'c'.repeat(64);

    try {
      createDispatchedLease(coreDb, 'lease_terminal_release');
      coreDb.sqlite
        .prepare(
          `INSERT INTO worker_control_commands (
            workspace_id, thread_id, turn_id, agent_session_id, package_snapshot_id,
            request_id, command_id, command_kind, sequence, payload_json, status,
            queued_at, delivered_at, acknowledged_at
          ) VALUES (?, ?, ?, ?, ?, NULL, ?, 'interrupt', 1, ?, 'queued', ?, NULL, NULL)`
        )
        .run(
          'ws_demo',
          'thread_terminal_release',
          'turn_terminal_release',
          'session_terminal_release',
          'pkg_demo',
          commandId,
          '{"reason":null}',
          '2026-07-05T00:00:03.000Z'
        );

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
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM worker_control_commands WHERE command_id = ?')
          .get(commandId)
      ).toEqual({ status: 'undeliverable' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each(terminalAccountingCorruptions)('rolls back every terminal accounting write for $name', ({
    apply,
    expectedError,
    name,
  }) => {
    const coreDb = createMigratedCoreDb();
    const suffix = `terminal_corrupt_${name.replaceAll(' ', '_')}`;

    try {
      createDispatchedLease(coreDb, `lease_${suffix}`);
      apply(coreDb, suffix);
      const before = terminalAccountingSnapshot(coreDb, suffix);

      expect(() =>
        completeSchedulerSessionLease(coreDb, {
          leaseId: `lease_${suffix}`,
          releaseReason: 'terminal-corruption-test',
          schedulerEpoch: 9,
          terminalStatus: 'failed',
        })
      ).toThrow(expectedError);
      expect(terminalAccountingSnapshot(coreDb, suffix)).toEqual(before);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('blocks every terminal capacity release until the backend session is durably cleaned', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createDispatchedLease(coreDb, 'lease_cleanup_barrier');
      recordWorkerBackendSessionMaterializing(coreDb, {
        backendLineage: { imageRef: 'openkit/worker-codex:dev', kind: 'reference' },
        backendVersion: '0.0.99',
        identity: {
          agentSessionId: 'session_cleanup_barrier',
          backendKind: 'openshell',
          backendSessionId: 'openkit-session_cleanup_barrier',
          deploymentId: 'deployment-test',
          packageSnapshotId: 'pkg_demo',
          runtimeTargetId: 'runtime-target-test',
          stagingDirectoryRef: 'server/runtime/worker-backend-sessions/pkg_demo',
          transientProviderInstanceId: null,
        },
        lineage: {
          threadId: 'thread_cleanup_barrier',
          turnId: 'turn_cleanup_barrier',
          workspaceId: 'ws_demo',
        },
        now: () => '2026-07-05T00:00:03.000Z',
        sandboxBindingRef: 'lease-binding:lease_cleanup_barrier',
      });

      expect(() =>
        completeSchedulerSessionLease(coreDb, {
          leaseId: 'lease_cleanup_barrier',
          releaseReason: 'turn-failed',
          terminalStatus: 'failed',
        })
      ).toThrow('Worker backend session must be cleaned before scheduler lease completion.');
      completeSchedulerLeaseForTerminalTurn(coreDb, {
        id: 'turn_cleanup_barrier',
        status: 'failed',
        threadId: 'thread_cleanup_barrier',
        workspaceId: 'ws_demo',
      });
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, capacity.in_use_count AS inUseCount
             FROM scheduler_session_leases AS leases
             JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
             WHERE leases.lease_id = ?`
          )
          .get('lease_cleanup_barrier')
      ).toEqual({ inUseCount: 1, status: 'acquired' });

      transitionWorkerBackendSessionState(coreDb, {
        fromState: 'materializing',
        leaseId: 'lease_cleanup_barrier',
        toState: 'cleanup-pending',
      });
      transitionWorkerBackendSessionState(coreDb, {
        fromState: 'cleanup-pending',
        leaseId: 'lease_cleanup_barrier',
        toState: 'physical-cleaned',
      });
      completeSchedulerLeaseForTerminalTurn(coreDb, {
        id: 'turn_cleanup_barrier',
        status: 'failed',
        threadId: 'thread_cleanup_barrier',
        workspaceId: 'ws_demo',
      });
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, capacity.in_use_count AS inUseCount
             FROM scheduler_session_leases AS leases
             JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
             WHERE leases.lease_id = ?`
          )
          .get('lease_cleanup_barrier')
      ).toEqual({ inUseCount: 1, status: 'acquired' });
      transitionWorkerBackendSessionState(coreDb, {
        fromState: 'physical-cleaned',
        leaseId: 'lease_cleanup_barrier',
        toState: 'cleaned',
      });
      completeSchedulerLeaseForTerminalTurn(coreDb, {
        id: 'turn_cleanup_barrier',
        status: 'failed',
        threadId: 'thread_cleanup_barrier',
        workspaceId: 'ws_demo',
      });
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, capacity.in_use_count AS inUseCount
             FROM scheduler_session_leases AS leases
             JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
             WHERE leases.lease_id = ?`
          )
          .get('lease_cleanup_barrier')
      ).toEqual({ inUseCount: 0, status: 'failed' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    'active',
    'releasing',
  ] as const)('blocks terminal capacity release for %s leases that are missing their durable backend anchor', (status) => {
    const coreDb = createMigratedCoreDb();

    try {
      createDispatchedLease(coreDb, `lease_missing_anchor_${status}`);
      if (status === 'active') {
        acceptSchedulerLeaseHeartbeat(coreDb, {
          heartbeatTimeoutMs: 30_000,
          leaseId: `lease_missing_anchor_${status}`,
          now: () => '2026-07-05T00:00:10.000Z',
          workerSequence: 1,
        });
      } else {
        markSchedulerSessionLeaseReleasing(coreDb, {
          leaseId: `lease_missing_anchor_${status}`,
          now: () => '2026-07-05T00:00:10.000Z',
          releaseReason: 'worker-final-status',
        });
      }

      expect(() =>
        completeSchedulerSessionLease(coreDb, {
          leaseId: `lease_missing_anchor_${status}`,
          releaseReason: 'turn-failed',
          terminalStatus: 'failed',
        })
      ).toThrow('requires a durable backend session anchor before completion');
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, capacity.in_use_count AS inUseCount
               FROM scheduler_session_leases AS leases
               JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
               WHERE leases.lease_id = ?`
          )
          .get(`lease_missing_anchor_${status}`)
      ).toEqual({ inUseCount: 1, status });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('requires every scheduler lease to own a unique sandbox binding', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createDispatchedLease(coreDb, 'lease_binding_owner');
      createDispatchedLease(coreDb, 'lease_binding_conflict');

      expect(() =>
        coreDb.sqlite
          .prepare('UPDATE scheduler_session_leases SET sandbox_binding_ref = ? WHERE lease_id = ?')
          .run('lease-binding:lease_binding_owner', 'lease_binding_conflict')
      ).toThrow(/unique constraint failed/i);
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT sandbox_binding_ref AS sandboxBindingRef FROM scheduler_session_leases WHERE lease_id = ?'
          )
          .get('lease_binding_conflict')
      ).toEqual({ sandboxBindingRef: 'lease-binding:lease_binding_conflict' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('skips release-grace expiry while backend cleanup is incomplete', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createDispatchedLease(coreDb, 'lease_cleanup_grace');
      recordWorkerBackendSessionMaterializing(coreDb, {
        backendLineage: { imageRef: 'openkit/worker-codex:dev', kind: 'reference' },
        backendVersion: '0.0.99',
        identity: {
          agentSessionId: 'session_cleanup_grace',
          backendKind: 'openshell',
          backendSessionId: 'openkit-session_cleanup_grace',
          deploymentId: 'deployment-test',
          packageSnapshotId: 'pkg_demo',
          runtimeTargetId: 'runtime-target-test',
          stagingDirectoryRef: 'server/runtime/worker-backend-sessions/pkg_demo',
          transientProviderInstanceId: null,
        },
        lineage: {
          threadId: 'thread_cleanup_grace',
          turnId: 'turn_cleanup_grace',
          workspaceId: 'ws_demo',
        },
        now: () => '2026-07-05T00:00:03.000Z',
        sandboxBindingRef: 'lease-binding:lease_cleanup_grace',
      });
      markSchedulerSessionLeaseReleasing(coreDb, {
        leaseId: 'lease_cleanup_grace',
        now: () => '2026-07-05T00:00:10.000Z',
        releaseReason: 'worker-final-status',
      });

      expect(
        expireReleasingSchedulerLeases(coreDb, {
          now: () => '2026-07-05T00:05:11.000Z',
        })
      ).toEqual([]);
      transitionWorkerBackendSessionState(coreDb, {
        fromState: 'materializing',
        leaseId: 'lease_cleanup_grace',
        toState: 'cleanup-pending',
      });
      transitionWorkerBackendSessionState(coreDb, {
        fromState: 'cleanup-pending',
        leaseId: 'lease_cleanup_grace',
        toState: 'physical-cleaned',
      });
      transitionWorkerBackendSessionState(coreDb, {
        fromState: 'physical-cleaned',
        leaseId: 'lease_cleanup_grace',
        toState: 'cleaned',
      });
      expect(
        expireReleasingSchedulerLeases(coreDb, {
          now: () => '2026-07-05T00:05:12.000Z',
        })
      ).toEqual([]);
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, capacity.in_use_count AS inUseCount
             FROM scheduler_session_leases AS leases
             JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
             WHERE leases.lease_id = ?`
          )
          .get('lease_cleanup_grace')
      ).toEqual({ inUseCount: 1, status: 'releasing' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    ['completed', 'released', 'turn-completed', null],
    ['interrupted', 'released', 'turn-interrupted', null],
    ['cancelled', 'released', 'turn-cancelled', null],
    ['failed', 'failed', 'turn-failed', 'needs-evidence'],
  ] as const)('maps %s product turns to the terminal scheduler lease transition', (turnStatus, leaseStatus, releaseReason, recoveryState) => {
    const coreDb = createMigratedCoreDb();
    const suffix = `turn_${turnStatus}`;

    try {
      createDispatchedLease(coreDb, `lease_${suffix}`);
      completeSchedulerLeaseForTerminalTurn(coreDb, {
        id: `turn_${suffix}`,
        workspaceId: 'ws_demo',
        threadId: `thread_${suffix}`,
        status: turnStatus,
      });

      expect(
        coreDb.sqlite
          .prepare(
            `SELECT status, release_reason AS releaseReason, recovery_state AS recoveryState
               FROM scheduler_session_leases
               WHERE lease_id = ?`
          )
          .get(`lease_${suffix}`)
      ).toEqual({ status: leaseStatus, releaseReason, recoveryState });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('leaves scheduler leases live for non-terminal product turns', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createDispatchedLease(coreDb, 'lease_turn_running');
      completeSchedulerLeaseForTerminalTurn(coreDb, {
        id: 'turn_turn_running',
        workspaceId: 'ws_demo',
        threadId: 'thread_turn_running',
        status: 'running',
      });

      expect(
        coreDb.sqlite
          .prepare(
            `SELECT status, release_reason AS releaseReason
             FROM scheduler_session_leases
             WHERE lease_id = ?`
          )
          .get('lease_turn_running')
      ).toEqual({ status: 'acquired', releaseReason: null });
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

      const failed = transitionStartupTimedOutSchedulerLeases(coreDb, {
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

  it('retains capacity when an anchored startup times out', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createDispatchedLease(coreDb, 'lease_anchored_startup_timeout');
      recordWorkerBackendSessionMaterializing(coreDb, {
        backendLineage: { imageRef: 'openkit/worker-codex:dev', kind: 'reference' },
        backendVersion: '0.0.99',
        identity: {
          agentSessionId: 'session_anchored_startup_timeout',
          backendKind: 'openshell',
          backendSessionId: 'openkit-session_anchored_startup_timeout',
          deploymentId: 'deployment-test',
          packageSnapshotId: 'pkg_demo',
          runtimeTargetId: 'runtime-target-test',
          stagingDirectoryRef: 'server/runtime/worker-backend-sessions/pkg_demo',
          transientProviderInstanceId: null,
        },
        lineage: {
          threadId: 'thread_anchored_startup_timeout',
          turnId: 'turn_anchored_startup_timeout',
          workspaceId: 'ws_demo',
        },
        now: () => '2026-07-05T00:00:03.000Z',
        sandboxBindingRef: 'lease-binding:lease_anchored_startup_timeout',
      });

      const timedOut = transitionStartupTimedOutSchedulerLeases(coreDb, {
        now: () => '2026-07-05T00:03:00.000Z',
      });

      expect(timedOut).toEqual([
        expect.objectContaining({
          leaseId: 'lease_anchored_startup_timeout',
          recoveryState: 'needs-evidence',
          releaseReason: 'startup-timeout',
          status: 'stale',
        }),
      ]);
      expect(
        coreDb.sqlite
          .prepare('SELECT in_use_count FROM scheduler_capacity_records WHERE target_id = ?')
          .get('target_anchored_startup_timeout')
      ).toEqual({ in_use_count: 1 });
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT current_admitted_session_count FROM scheduler_worker_pools WHERE pool_id = ?'
          )
          .get('pool_anchored_startup_timeout')
      ).toEqual({ current_admitted_session_count: 1 });
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM scheduler_placement_plans WHERE plan_id = ?')
          .get('plan_anchored_startup_timeout')
      ).toEqual({ status: 'executing' });
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
        transitionStartupTimedOutSchedulerLeases(coreDb, {
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
        now: () => '2026-07-05T00:00:10.000Z',
        releaseReason: 'worker-final-status',
      });
      const capacity = coreDb.sqlite
        .prepare(
          "SELECT in_use_count AS inUseCount FROM scheduler_capacity_records WHERE pool_id = 'pool_releasing'"
        )
        .get() as { inUseCount: number };

      expect(releasing).toMatchObject({
        leaseId: 'lease_releasing',
        expiresAt: '2026-07-05T00:05:10.000Z',
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

  it('rolls back release and command drain when an outer caller catches drain failure', () => {
    const coreDb = createMigratedCoreDb();
    const commandId = 'a'.repeat(64);

    try {
      createDispatchedLease(coreDb, 'lease_atomic_release');
      coreDb.sqlite
        .prepare(
          `INSERT INTO worker_control_commands (
            workspace_id, thread_id, turn_id, agent_session_id, package_snapshot_id,
            request_id, command_id, command_kind, sequence, payload_json, status,
            queued_at, delivered_at, acknowledged_at
          ) VALUES (?, ?, ?, ?, ?, NULL, ?, 'interrupt', 1, ?, 'queued', ?, NULL, NULL)`
        )
        .run(
          'ws_demo',
          'thread_atomic_release',
          'turn_atomic_release',
          'session_atomic_release',
          'pkg_demo',
          commandId,
          '{"reason":null}',
          '2026-07-05T00:00:03.000Z'
        );
      const before = coreDb.sqlite
        .prepare('SELECT status FROM scheduler_session_leases WHERE lease_id = ?')
        .get('lease_atomic_release');
      coreDb.sqlite.exec(
        `CREATE TEMP TRIGGER reject_worker_command_drain
         BEFORE UPDATE OF status ON worker_control_commands
         WHEN OLD.command_id = '${commandId}'
         BEGIN
           SELECT RAISE(ABORT, 'injected command drain failure');
         END`
      );

      coreDb.sqlite.transaction(() => {
        expect(() =>
          markSchedulerSessionLeaseReleasing(coreDb, {
            leaseId: 'lease_atomic_release',
            releaseReason: 'worker-final-status',
          })
        ).toThrow('injected command drain failure');
      })();

      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM scheduler_session_leases WHERE lease_id = ?')
          .get('lease_atomic_release')
      ).toEqual(before);
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM worker_control_commands WHERE command_id = ?')
          .get(commandId)
      ).toEqual({ status: 'queued' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('preserves an earlier lease expiry when entering release grace', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createDispatchedLease(coreDb, 'lease_short_release');
      coreDb.sqlite
        .prepare('UPDATE scheduler_session_leases SET expires_at = ? WHERE lease_id = ?')
        .run('2026-07-05T00:03:00.000Z', 'lease_short_release');

      expect(
        markSchedulerSessionLeaseReleasing(coreDb, {
          leaseId: 'lease_short_release',
          now: () => '2026-07-05T00:00:10.000Z',
          releaseReason: 'worker-final-status',
        }).expiresAt
      ).toBe('2026-07-05T00:03:00.000Z');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('lists stale workspace recovery while refusing to expire an unanchored releasing lease', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createDispatchedLease(coreDb, 'lease_recovery_stale');
      createDispatchedLease(coreDb, 'lease_recovery_release');
      createDispatchedLease(coreDb, 'lease_recovery_startup');
      acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        leaseId: 'lease_recovery_stale',
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });
      markExpiredSchedulerLeasesStale(coreDb, {
        now: () => '2026-07-05T00:03:00.000Z',
      });
      markSchedulerSessionLeaseReleasing(coreDb, {
        leaseId: 'lease_recovery_release',
        now: () => '2026-07-05T00:00:10.000Z',
        releaseReason: 'worker-final-status',
      });
      expect(() =>
        expireReleasingSchedulerLeases(coreDb, {
          now: () => '2026-07-05T00:05:11.000Z',
        })
      ).toThrow('requires a durable backend session anchor before completion');
      transitionStartupTimedOutSchedulerLeases(coreDb, {
        now: () => '2026-07-05T00:03:00.000Z',
      });

      expect(
        listSchedulerLeasesNeedingWorkspaceRecovery(coreDb).map((lease) => ({
          leaseId: lease.leaseId,
          recoveryState: lease.recoveryState,
          releaseReason: lease.releaseReason,
          status: lease.status,
        }))
      ).toEqual([
        {
          leaseId: 'lease_recovery_stale',
          recoveryState: 'needs-evidence',
          releaseReason: 'heartbeat-timeout',
          status: 'stale',
        },
      ]);
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM scheduler_session_leases WHERE lease_id = ?')
          .get('lease_recovery_release')
      ).toEqual({ status: 'releasing' });
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
        now: () => '2026-07-05T00:00:10.000Z',
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

  it('rejects an expired lease token binding at request time', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createDispatchedLease(coreDb, 'lease_binding_expired');

      expect(
        resolveSchedulerLeaseTokenBinding(coreDb, {
          lineage: {
            agentSessionId: 'session_binding_expired',
            packageSnapshotId: 'pkg_demo',
            threadId: 'thread_binding_expired',
            turnId: 'turn_binding_expired',
            workspaceId: 'ws_demo',
          },
          now: () => '2026-07-05T00:16:00.000Z',
          sandboxBindingRef: 'lease-binding:lease_binding_expired',
        })
      ).toEqual({ status: 'rejected', reason: 'lease-not-live' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects a lease token binding after its startup deadline', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createDispatchedLease(coreDb, 'lease_binding_startup_timeout');

      expect(
        resolveSchedulerLeaseTokenBinding(coreDb, {
          lineage: {
            agentSessionId: 'session_binding_startup_timeout',
            packageSnapshotId: 'pkg_demo',
            threadId: 'thread_binding_startup_timeout',
            turnId: 'turn_binding_startup_timeout',
            workspaceId: 'ws_demo',
          },
          now: () => '2026-07-05T00:03:00.000Z',
          sandboxBindingRef: 'lease-binding:lease_binding_startup_timeout',
        })
      ).toEqual({ status: 'rejected', reason: 'lease-not-live' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects a started lease token binding after its heartbeat deadline', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createDispatchedLease(coreDb, 'lease_binding_heartbeat_timeout');
      acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        leaseId: 'lease_binding_heartbeat_timeout',
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });

      expect(
        resolveSchedulerLeaseTokenBinding(coreDb, {
          lineage: {
            agentSessionId: 'session_binding_heartbeat_timeout',
            packageSnapshotId: 'pkg_demo',
            threadId: 'thread_binding_heartbeat_timeout',
            turnId: 'turn_binding_heartbeat_timeout',
            workspaceId: 'ws_demo',
          },
          now: () => '2026-07-05T00:00:41.000Z',
          sandboxBindingRef: 'lease-binding:lease_binding_heartbeat_timeout',
        })
      ).toEqual({ status: 'rejected', reason: 'lease-not-live' });
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

  it.each([
    'local',
    'remote',
  ] as const)('creates the %s baseline with one scheduler slot', (placement) => {
    const coreDb = createMigratedCoreDb();

    try {
      ensureConfiguredSchedulerBaseline(coreDb, {
        now: () => '2026-07-05T00:00:00.000Z',
        placement,
      });

      expect(
        coreDb.sqlite
          .prepare(
            'SELECT default_timeout_ms AS defaultTimeoutMs, max_concurrent_sessions AS maxConcurrentSessions FROM scheduler_worker_pools WHERE pool_id = ?'
          )
          .get(`pool_${placement}`)
      ).toEqual({ defaultTimeoutMs: 2_400_000, maxConcurrentSessions: 1 });
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT concurrency_ceiling AS concurrencyCeiling FROM scheduler_capacity_records WHERE target_id = ?'
          )
          .get(`target_${placement}`)
      ).toEqual({ concurrencyCeiling: 1 });
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
        checkResults: [{ surface: 'worker-control', status: 'ok' }],
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
      expect(health.checkResults).toEqual([{ surface: 'worker-control', status: 'ok' }]);
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
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId: 'queue_dispatch',
        workspaceId: 'ws_demo',
        threadId: 'thread_demo',
        turnId: 'turn_demo',
        turnInput: 'Run dispatched turn',
        requestedAgentId: 'agent_worker',
        profileRef: null,
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
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId: 'queue_thread_first',
        workspaceId: 'ws_demo',
        threadId: 'thread_shared',
        turnId: 'turn_thread_first',
        turnInput: 'Run first shared-thread turn',
        requestedAgentId: 'agent_worker',
        profileRef: null,
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
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId: 'queue_thread_second',
        workspaceId: 'ws_demo',
        threadId: 'thread_shared',
        turnId: 'turn_thread_second',
        turnInput: 'Run second shared-thread turn',
        requestedAgentId: 'agent_worker',
        profileRef: null,
        priorityClass: 'interactive',
        requiredPoolConstraints: ['openshell.local'],
        now: () => '2026-07-05T00:00:03.000Z',
      });
      createSchedulerAdmissionEntry(coreDb, {
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId: 'queue_thread_other',
        workspaceId: 'ws_demo',
        threadId: 'thread_other',
        turnId: 'turn_thread_other',
        turnInput: 'Run other thread turn',
        requestedAgentId: 'agent_worker',
        profileRef: null,
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
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId: 'queue_wait',
        workspaceId: 'ws_demo',
        threadId: 'thread_demo',
        turnId: 'turn_demo',
        turnInput: 'Run waiting turn',
        requestedAgentId: 'agent_worker',
        profileRef: null,
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

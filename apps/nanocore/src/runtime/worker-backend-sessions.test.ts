import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  completeSchedulerSessionLease,
  createSchedulerAdmissionEntry,
  dispatchNextSchedulerEntry,
  upsertSchedulerCapacityRecord,
  upsertSchedulerTargetHealthRecord,
  upsertSchedulerWorkerPool,
} from '../scheduler-records.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  getWorkerBackendSession,
  markWorkerBackendSessionLaunching,
  markWorkerBackendWorkspaceHandoffComplete,
  recordWorkerBackendSessionMaterializing,
  transitionWorkerBackendSessionState,
} from './worker-backend-sessions.js';

/** Creates one dispatched lease in an isolated Core database. */
function createFixture() {
  const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-backend-session-')));
  applyMigrations(coreDb);
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
    poolId: 'pool_backend_session',
    queueLimit: 20,
    status: 'active',
  });
  upsertSchedulerCapacityRecord(coreDb, {
    capacityClass: 'local',
    concurrencyCeiling: 1,
    inUseCount: 0,
    observationSource: 'configured',
    observedAt: '2026-07-15T00:00:00.000Z',
    poolId: 'pool_backend_session',
    queueDepth: 0,
    targetId: 'target_backend_session',
  });
  upsertSchedulerTargetHealthRecord(coreDb, {
    checkResults: [],
    consecutiveFailureCount: 0,
    consecutiveSuccessCount: 1,
    healthState: 'healthy',
    lastProbeAt: '2026-07-15T00:00:00.000Z',
    nextProbeAt: '2026-07-15T00:01:00.000Z',
    targetId: 'target_backend_session',
  });
  createSchedulerAdmissionEntry(coreDb, {
    triggerActor: { kind: 'user', id: 'user_local' },
    priorityClass: 'interactive',
    profileRef: 'profile_worker',
    queueEntryId: 'queue_backend_session',
    requestedAgentId: 'agent_codex_host',
    requiredPoolConstraints: ['openshell.local'],
    threadId: 'thread_backend_session',
    turnId: 'turn_backend_session',
    turnInput: 'Run worker',
    workspaceId: 'ws_demo',
    now: () => '2026-07-15T00:00:01.000Z',
  });
  dispatchNextSchedulerEntry(coreDb, {
    agentSessionId: 'as_backend_session',
    expectedControlMode: 'poll',
    expectedDataPlaneMode: 'openshell-files',
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 30_000,
    leaseDurationMs: 900_000,
    leaseId: 'lease_backend_session',
    now: () => '2026-07-15T00:00:02.000Z',
    packageSnapshotId: 'aepsnap_backend_session',
    planId: 'plan_backend_session',
    sandboxBindingRef: 'lease-binding:lease_backend_session',
    schedulerEpoch: 1,
    startupTimeoutMs: 120_000,
  });
  return coreDb;
}

/** Returns the canonical materializing insert input. */
function materializingInput() {
  return {
    backendLineage: {
      buildArgumentsDigest: 'sha256:arguments',
      buildContextDigest: 'sha256:context',
      buildInputDigest: 'sha256:dockerfile',
      kind: 'build',
      resultingImageDigest: 'sha256:image',
    },
    backendVersion: '0.0.99',
    identity: {
      agentSessionId: 'as_backend_session',
      backendKind: 'openshell',
      backendSessionId: 'openkit-as_backend_session',
      deploymentId: 'deployment-test',
      packageSnapshotId: 'aepsnap_backend_session',
      runtimeTargetId: 'runtime-target-test',
      stagingDirectoryRef: 'server/runtime/worker-backend-sessions/aepsnap_backend_session',
      transientProviderInstanceId: 'okp-deployment-test-worker-inference-backend-session',
    },
    lineage: {
      threadId: 'thread_backend_session',
      turnId: 'turn_backend_session',
      workspaceId: 'ws_demo',
    },
    now: () => '2026-07-15T00:00:03.000Z',
    sandboxBindingRef: 'lease-binding:lease_backend_session',
  } as const;
}

describe('worker backend sessions', () => {
  it('persists the complete package-scoped identity before materialization and accepts exact replay', () => {
    const coreDb = createFixture();

    try {
      const first = recordWorkerBackendSessionMaterializing(coreDb, materializingInput());
      const replay = recordWorkerBackendSessionMaterializing(coreDb, materializingInput());

      expect(first).toEqual({
        agentSessionId: 'as_backend_session',
        backendKind: 'openshell',
        deploymentId: 'deployment-test',
        backendLineage: {
          buildArgumentsDigest: 'sha256:arguments',
          buildContextDigest: 'sha256:context',
          buildInputDigest: 'sha256:dockerfile',
          resultingImageDigest: 'sha256:image',
        },
        backendVersion: '0.0.99',
        backendSessionId: 'openkit-as_backend_session',
        createdAt: '2026-07-15T00:00:03.000Z',
        leaseId: 'lease_backend_session',
        packageSnapshotId: 'aepsnap_backend_session',
        physicalCleanedAt: null,
        runtimeTargetId: 'runtime-target-test',
        sandboxBindingRef: 'lease-binding:lease_backend_session',
        stagingDirectoryRef: 'server/runtime/worker-backend-sessions/aepsnap_backend_session',
        transientProviderInstanceId: 'okp-deployment-test-worker-inference-backend-session',
        workspaceHandoffState: 'pending',
        state: 'materializing',
        threadId: 'thread_backend_session',
        turnId: 'turn_backend_session',
        updatedAt: '2026-07-15T00:00:03.000Z',
        workspaceId: 'ws_demo',
      });
      expect(replay).toEqual(first);
      expect(getWorkerBackendSession(coreDb, first.leaseId)).toEqual(first);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects a conflicting identity or lease lineage', () => {
    const coreDb = createFixture();

    try {
      recordWorkerBackendSessionMaterializing(coreDb, materializingInput());

      expect(() =>
        recordWorkerBackendSessionMaterializing(coreDb, {
          ...materializingInput(),
          identity: { ...materializingInput().identity, backendSessionId: 'openkit-conflict' },
        })
      ).toThrow('Worker backend session identity conflicts with its durable lease.');
      expect(() =>
        recordWorkerBackendSessionMaterializing(coreDb, {
          ...materializingInput(),
          identity: {
            ...materializingInput().identity,
            runtimeTargetId: 'runtime-target-changed',
          },
        })
      ).toThrow('Worker backend session identity conflicts with its durable lease.');
      expect(() =>
        recordWorkerBackendSessionMaterializing(coreDb, {
          ...materializingInput(),
          backendLineage: {
            ...materializingInput().backendLineage,
            resultingImageDigest: 'sha256:changed-image',
          },
        })
      ).toThrow('Worker backend session identity conflicts with its durable lease.');
      expect(() =>
        recordWorkerBackendSessionMaterializing(coreDb, {
          ...materializingInput(),
          identity: {
            ...materializingInput().identity,
            transientProviderInstanceId: 'provider-conflict',
          },
        })
      ).toThrow('Worker backend session identity conflicts with its durable lease.');
      expect(() =>
        recordWorkerBackendSessionMaterializing(coreDb, {
          ...materializingInput(),
          lineage: { ...materializingInput().lineage, turnId: 'turn_other' },
        })
      ).toThrow('Scheduler lease binding does not match worker backend session lineage.');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects a physical plan from another lease lineage before anchoring either identity', () => {
    const coreDb = createFixture();

    try {
      expect(() =>
        recordWorkerBackendSessionMaterializing(coreDb, {
          ...materializingInput(),
          identity: {
            ...materializingInput().identity,
            agentSessionId: 'as_plan_from_another_lease',
            packageSnapshotId: 'aepsnap_plan_from_another_lease',
          },
        })
      ).toThrow('Scheduler lease binding does not match worker backend session lineage.');
      expect(getWorkerBackendSession(coreDb, 'lease_backend_session')).toBeNull();
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT backend_anchor_state AS backendAnchorState FROM scheduler_session_leases WHERE lease_id = ?'
          )
          .get('lease_backend_session')
      ).toEqual({ backendAnchorState: 'unanchored' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects terminal or deadline-expired leases before recording an external-effect identity', () => {
    const terminalDb = createFixture();
    const expiredDb = createFixture();

    try {
      completeSchedulerSessionLease(terminalDb, {
        leaseId: 'lease_backend_session',
        releaseReason: 'turn-failed-before-materialization',
        terminalStatus: 'failed',
      });
      expect(() =>
        recordWorkerBackendSessionMaterializing(terminalDb, materializingInput())
      ).toThrow('Scheduler lease is not live for worker backend materialization.');
      expect(() =>
        recordWorkerBackendSessionMaterializing(expiredDb, {
          ...materializingInput(),
          now: () => '2026-07-15T00:03:00.000Z',
        })
      ).toThrow('Scheduler lease is not live for worker backend materialization.');
      expect(getWorkerBackendSession(terminalDb, 'lease_backend_session')).toBeNull();
      expect(getWorkerBackendSession(expiredDb, 'lease_backend_session')).toBeNull();
    } finally {
      terminalDb.sqlite.close();
      expiredDb.sqlite.close();
    }
  });

  it.each([
    ['terminal', '2026-07-15T00:00:04.000Z'],
    ['deadline-expired', '2026-07-15T00:03:00.000Z'],
  ] as const)('rejects an exact anchor replay after its lease becomes %s', (condition, now) => {
    const coreDb = createFixture();

    try {
      recordWorkerBackendSessionMaterializing(coreDb, materializingInput());
      if (condition === 'terminal') {
        coreDb.sqlite
          .prepare("UPDATE scheduler_session_leases SET status = 'failed' WHERE lease_id = ?")
          .run('lease_backend_session');
      }

      expect(() =>
        recordWorkerBackendSessionMaterializing(coreDb, {
          ...materializingInput(),
          now: () => now,
        })
      ).toThrow('Scheduler lease is not live for worker backend materialization.');
      expect(getWorkerBackendSession(coreDb, 'lease_backend_session')).toMatchObject({
        state: 'materializing',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('gives one lease exclusive ownership of a sandbox binding', () => {
    const coreDb = createFixture();

    try {
      recordWorkerBackendSessionMaterializing(coreDb, materializingInput());

      expect(() =>
        coreDb.sqlite
          .prepare(
            `INSERT INTO worker_backend_sessions (
               lease_id, workspace_id, thread_id, turn_id, agent_session_id,
               package_snapshot_id, backend_kind, deployment_id, backend_version,
               runtime_target_id, backend_lineage_json, sandbox_binding_ref, backend_session_id,
               staging_directory_ref, transient_provider_instance_id, workspace_handoff_state,
               state, created_at, updated_at
             )
             SELECT 'lease_other', 'ws_other', 'thread_other', 'turn_other', 'as_other',
                    'aepsnap_other', backend_kind, deployment_id, backend_version,
                    runtime_target_id, backend_lineage_json, sandbox_binding_ref, 'openkit-as_other',
                    'server/runtime/worker-backend-sessions/aepsnap_other',
                    'provider-other', workspace_handoff_state,
                    state, created_at, updated_at
             FROM worker_backend_sessions
             WHERE lease_id = 'lease_backend_session'`
          )
          .run()
      ).toThrow(/UNIQUE constraint failed/);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('gives one lease exclusive ownership of a transient provider', () => {
    const coreDb = createFixture();

    try {
      recordWorkerBackendSessionMaterializing(coreDb, materializingInput());

      expect(() =>
        coreDb.sqlite
          .prepare(
            `INSERT INTO worker_backend_sessions (
               lease_id, workspace_id, thread_id, turn_id, agent_session_id,
               package_snapshot_id, backend_kind, deployment_id, backend_version,
               runtime_target_id, backend_lineage_json, sandbox_binding_ref,
               backend_session_id, staging_directory_ref, transient_provider_instance_id,
               workspace_handoff_state,
               state, created_at, updated_at
             )
             SELECT 'lease_provider_other', 'ws_other', 'thread_other', 'turn_other', 'as_other',
                    'aepsnap_provider_other', backend_kind, deployment_id, backend_version,
                    runtime_target_id, backend_lineage_json, 'lease-binding:lease-provider-other',
                    'openkit-as_other',
                    'server/runtime/worker-backend-sessions/aepsnap_provider_other',
                    transient_provider_instance_id, workspace_handoff_state,
                    state, created_at, updated_at
             FROM worker_backend_sessions
             WHERE lease_id = 'lease_backend_session'`
          )
          .run()
      ).toThrow(/UNIQUE constraint failed/);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects replay once the anchored lifecycle has advanced beyond materializing', () => {
    const coreDb = createFixture();

    try {
      recordWorkerBackendSessionMaterializing(coreDb, materializingInput());
      transitionWorkerBackendSessionState(coreDb, {
        fromState: 'materializing',
        leaseId: 'lease_backend_session',
        toState: 'materialized',
      });
      expect(
        markWorkerBackendWorkspaceHandoffComplete(coreDb, {
          leaseId: 'lease_backend_session',
          now: () => '2026-07-15T00:00:04.500Z',
        })
      ).toMatchObject({ workspaceHandoffState: 'complete' });

      expect(() => recordWorkerBackendSessionMaterializing(coreDb, materializingInput())).toThrow(
        'Worker backend session is not materializing.'
      );
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    ['package snapshot', 'package_snapshot_id', "'aepsnap_backend_session'"],
    ['physical backend locator', 'backend_session_id', "'openkit-as_backend_session'"],
    ['sandbox binding', 'sandbox_binding_ref', "'lease-binding:lease_backend_session'"],
    [
      'staging directory',
      'staging_directory_ref',
      "'server/runtime/worker-backend-sessions/aepsnap_backend_session'",
    ],
  ] as const)('enforces exclusive ownership of each %s', (_description, preservedColumn, value) => {
    const coreDb = createFixture();

    try {
      recordWorkerBackendSessionMaterializing(coreDb, materializingInput());
      const replacements: Record<string, string> = {
        package_snapshot_id: "'aepsnap_other'",
        backend_session_id: "'openkit-as_other'",
        sandbox_binding_ref: "'lease-binding:lease-other'",
        staging_directory_ref: "'server/runtime/worker-backend-sessions/aepsnap_other'",
      };
      replacements[preservedColumn] = value;

      expect(() =>
        coreDb.sqlite
          .prepare(
            `INSERT INTO worker_backend_sessions (
               lease_id, workspace_id, thread_id, turn_id, agent_session_id,
               package_snapshot_id, backend_kind, deployment_id, backend_version,
               runtime_target_id, backend_lineage_json, sandbox_binding_ref, backend_session_id,
               staging_directory_ref, transient_provider_instance_id, workspace_handoff_state,
               state, created_at, updated_at
             )
             SELECT 'lease_other', 'ws_other', 'thread_other', 'turn_other', 'as_other',
                    ${replacements.package_snapshot_id}, backend_kind, deployment_id, backend_version,
                    runtime_target_id, backend_lineage_json, ${replacements.sandbox_binding_ref}, ${replacements.backend_session_id},
                    ${replacements.staging_directory_ref}, transient_provider_instance_id,
                    workspace_handoff_state,
                    state, created_at, updated_at
             FROM worker_backend_sessions
             WHERE lease_id = 'lease_backend_session'`
          )
          .run()
      ).toThrow(/UNIQUE constraint failed/);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('uses compare-and-set transitions for cleanup and retry', () => {
    const coreDb = createFixture();

    try {
      recordWorkerBackendSessionMaterializing(coreDb, materializingInput());
      transitionWorkerBackendSessionState(coreDb, {
        fromState: 'materializing',
        leaseId: 'lease_backend_session',
        now: () => '2026-07-15T00:00:04.000Z',
        toState: 'cleanup-pending',
      });
      transitionWorkerBackendSessionState(coreDb, {
        fromState: 'cleanup-pending',
        leaseId: 'lease_backend_session',
        now: () => '2026-07-15T00:00:05.000Z',
        toState: 'cleanup-failed',
      });
      transitionWorkerBackendSessionState(coreDb, {
        fromState: 'cleanup-failed',
        leaseId: 'lease_backend_session',
        now: () => '2026-07-15T00:00:06.000Z',
        toState: 'cleanup-pending',
      });
      expect(
        transitionWorkerBackendSessionState(coreDb, {
          fromState: 'cleanup-pending',
          leaseId: 'lease_backend_session',
          now: () => '2026-07-15T00:00:07.000Z',
          toState: 'physical-cleaned',
        })
      ).toMatchObject({
        physicalCleanedAt: '2026-07-15T00:00:07.000Z',
        state: 'physical-cleaned',
        updatedAt: '2026-07-15T00:00:07.000Z',
      });
      expect(
        transitionWorkerBackendSessionState(coreDb, {
          fromState: 'physical-cleaned',
          leaseId: 'lease_backend_session',
          now: () => '2026-07-15T00:00:08.000Z',
          toState: 'cleaned',
        })
      ).toMatchObject({
        physicalCleanedAt: '2026-07-15T00:00:07.000Z',
        state: 'cleaned',
        updatedAt: '2026-07-15T00:00:08.000Z',
      });
      expect(() =>
        transitionWorkerBackendSessionState(coreDb, {
          fromState: 'physical-cleaned',
          leaseId: 'lease_backend_session',
          toState: 'cleaned',
        })
      ).toThrow('Worker backend session state changed before transition.');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('opens the launch gate only while the owning lease remains live', () => {
    const coreDb = createFixture();

    try {
      recordWorkerBackendSessionMaterializing(coreDb, materializingInput());
      transitionWorkerBackendSessionState(coreDb, {
        fromState: 'materializing',
        leaseId: 'lease_backend_session',
        now: () => '2026-07-15T00:00:04.000Z',
        toState: 'materialized',
      });
      markWorkerBackendWorkspaceHandoffComplete(coreDb, {
        leaseId: 'lease_backend_session',
        now: () => '2026-07-15T00:00:04.500Z',
      });

      expect(
        markWorkerBackendSessionLaunching(coreDb, {
          leaseId: 'lease_backend_session',
          now: () => '2026-07-15T00:00:05.000Z',
        })
      ).toMatchObject({ state: 'launching', updatedAt: '2026-07-15T00:00:05.000Z' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    ['stale lease', '2026-07-15T00:00:05.000Z'],
    ['expired startup deadline', '2026-07-15T00:03:00.000Z'],
  ] as const)('keeps the session materialized when the launch gate rejects a %s', (condition, now) => {
    const coreDb = createFixture();

    try {
      recordWorkerBackendSessionMaterializing(coreDb, materializingInput());
      transitionWorkerBackendSessionState(coreDb, {
        fromState: 'materializing',
        leaseId: 'lease_backend_session',
        now: () => '2026-07-15T00:00:04.000Z',
        toState: 'materialized',
      });
      markWorkerBackendWorkspaceHandoffComplete(coreDb, {
        leaseId: 'lease_backend_session',
        now: () => '2026-07-15T00:00:04.500Z',
      });
      if (condition === 'stale lease') {
        coreDb.sqlite
          .prepare("UPDATE scheduler_session_leases SET status = 'stale' WHERE lease_id = ?")
          .run('lease_backend_session');
      }

      expect(() =>
        markWorkerBackendSessionLaunching(coreDb, {
          leaseId: 'lease_backend_session',
          now: () => now,
        })
      ).toThrow('Scheduler lease is not live for worker backend launch.');
      expect(getWorkerBackendSession(coreDb, 'lease_backend_session')).toMatchObject({
        state: 'materialized',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });
});

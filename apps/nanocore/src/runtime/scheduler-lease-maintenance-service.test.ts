import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import type { ActorRef } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import {
  acceptSchedulerLeaseHeartbeat,
  createSchedulerAdmissionEntry,
  dispatchNextSchedulerEntry,
  expireReleasingSchedulerLeases,
  listSchedulerLeasesNeedingWorkspaceRecovery,
  markSchedulerSessionLeaseReleasing,
  upsertSchedulerCapacityRecord,
  upsertSchedulerTargetHealthRecord,
  upsertSchedulerWorkerPool,
} from '../scheduler-records';
import { openCoreDb, openWorkspaceDb } from '../storage/db';
import { LOCAL_USER_ID, workspaceDbPath } from '../storage/fs-layout';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate';
import { recordTestAgentEnvironmentPackage as recordBaseTestAgentEnvironmentPackage } from '../test-support/agent-environment';
import {
  runSchedulerLeaseMaintenanceOnce,
  startSchedulerLeaseMaintenanceService,
} from './scheduler-lease-maintenance-service';
import { recordWorkerBackendSessionMaterializing } from './worker-backend-sessions';
import {
  buildWorkspaceInputSnapshots,
  buildWorkspaceMaterializationRecords,
} from './workspace-materializer';
import { listWorkspaceReconciliationRecords } from './workspace-reconciliation-records';
import {
  recordWorkspaceInputSnapshots,
  recordWorkspaceMaterializationRecords,
  updateBackendWorkspaceHandleCleanupStatus,
} from './workspace-sync-records';

/** Creates an isolated migrated Core database for scheduler maintenance tests. */
function createMigratedCoreDb() {
  const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-scheduler-maintenance-')));
  applyMigrations(coreDb);
  return coreDb;
}

/** Records one production-shaped AEP after preparing its writable Git inputs. */
function recordTestAgentEnvironmentPackage(
  workspaceDb: ReturnType<typeof openWorkspaceDb>,
  input: {
    readonly suffix: string;
    readonly triggerActor?: ActorRef;
    readonly workspaceInputIds: readonly string[];
  }
): AgentEnvironmentPackage {
  const workspaceInputIds = input.workspaceInputIds.map(
    (inputId) => `maintenance_${input.suffix}_${inputId}`
  );

  for (const inputId of workspaceInputIds) {
    const repositoryPath = `/tmp/openkit-test-${inputId}`;
    mkdirSync(repositoryPath, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repositoryPath });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=OpenKit Test',
        '-c',
        'user.email=test@openkit.local',
        'commit',
        '--allow-empty',
        '-qm',
        'fixture',
      ],
      { cwd: repositoryPath }
    );
  }

  return recordBaseTestAgentEnvironmentPackage(workspaceDb, {
    suffix: input.suffix,
    triggerActor: input.triggerActor ?? { kind: 'user', id: LOCAL_USER_ID },
    workspaceInputIds,
  });
}

/** Records a canonical workspace handoff for selected immutable package inputs. */
function recordCanonicalWorkspaceHandoff(
  workspaceDb: ReturnType<typeof openWorkspaceDb>,
  environmentPackage: AgentEnvironmentPackage,
  inputIds = environmentPackage.workspace.inputs.map((input) => input.id)
): void {
  const selectedInputIds = new Set(inputIds);
  const selectedEnvironmentPackage: AgentEnvironmentPackage = {
    ...environmentPackage,
    workspace: {
      ...environmentPackage.workspace,
      inputs: environmentPackage.workspace.inputs.filter((input) => selectedInputIds.has(input.id)),
    },
  };
  const inputSnapshots = recordWorkspaceInputSnapshots(
    workspaceDb,
    buildWorkspaceInputSnapshots({
      backendCapabilities: environmentPackage.backend.requiredCapabilities,
      backendKind: 'openshell',
      createdAt: '2026-07-05T00:00:10.000Z',
      environmentPackage: selectedEnvironmentPackage,
    })
  );

  recordWorkspaceMaterializationRecords(
    workspaceDb,
    buildWorkspaceMaterializationRecords({
      createdAt: '2026-07-05T00:00:10.000Z',
      inputSnapshots,
      materialization: {
        backendKind: 'openshell',
        backendStatus: { health: 'ready', version: '0.0.80' },
        packageSnapshotId: environmentPackage.snapshotId,
        requiredCapabilities: environmentPackage.backend.requiredCapabilities,
        sandbox: {
          name: `sandbox_${environmentPackage.scope.agentSessionId.replace(/^as_/, '')}`,
          state: 'created',
        },
        workspaceInputs: selectedEnvironmentPackage.workspace.inputs.map((input) => ({
          id: input.id,
          target: input.target,
        })),
      },
    })
  );
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
  triggerActor: ActorRef = { kind: 'user', id: LOCAL_USER_ID }
): void {
  seedLocalTarget(coreDb, suffix);
  createSchedulerAdmissionEntry(coreDb, {
    triggerActor,
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

/** Records the production backend anchor owned by one dispatched test lease. */
function recordBackendSession(
  coreDb: ReturnType<typeof createMigratedCoreDb>,
  suffix: string
): void {
  recordWorkerBackendSessionMaterializing(coreDb, {
    backendLineage: { imageRef: 'openkit/worker-codex:dev', kind: 'reference' },
    backendVersion: '0.0.99',
    identity: {
      agentSessionId: `as_${suffix}`,
      backendKind: 'openshell',
      backendSessionId: `openkit-as_${suffix}`,
      deploymentId: 'deployment-test',
      packageSnapshotId: `aepsnap_turn_${suffix}_as_${suffix}`,
      runtimeTargetId: 'runtime-target-test',
      stagingDirectoryRef: `server/runtime/worker-backend-sessions/aepsnap_turn_${suffix}_as_${suffix}`,
      transientProviderInstanceId: null,
    },
    lineage: {
      threadId: `thread_${suffix}`,
      turnId: `turn_${suffix}`,
      workspaceId: 'ws_demo',
    },
    now: () => '2026-07-05T00:00:03.000Z',
    sandboxBindingRef: `lease-binding:lease_${suffix}`,
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
    expect(wiring).toContain('runRecoveryMaintenance:');
    expect(wiring).not.toContain('canRenewPackageSnapshot');
    expect(source).not.toContain('scheduleExpiredReconnectCleanup');
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

  it('renews healthy leases when workspace recovery projection keeps failing', () => {
    const coreDb = createMigratedCoreDb();
    const errors: unknown[] = [];
    const callbacks: Array<() => void> = [];

    try {
      dispatchLease(coreDb, 'broken_recovery');
      acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        leaseId: 'lease_broken_recovery',
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });
      dispatchLease(coreDb, 'renew_after_recovery_error');
      acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 900_000,
        leaseId: 'lease_renew_after_recovery_error',
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });
      const brokenWorkspaceDbPath = workspaceDbPath(coreDb.dataRoot, 'ws_demo');
      mkdirSync(dirname(brokenWorkspaceDbPath), { recursive: true });
      mkdirSync(brokenWorkspaceDbPath);

      const service = startSchedulerLeaseMaintenanceService(coreDb, {
        runRecoveryMaintenance: async () => {},
        intervalMs: 30_000,
        maxTotalLeaseMs: 7_200_000,
        now: () => '2026-07-05T00:10:30.000Z',
        onError: (error) => errors.push(error),
        renewalDurationMs: 1_800_000,
        renewalLeadMs: 300_000,
        setInterval: (callback) => {
          callbacks.push(callback);
          return 'timer';
        },
      });

      expect(callbacks).toHaveLength(1);
      expect(errors).toHaveLength(1);
      expect(
        coreDb.sqlite
          .prepare(
            "SELECT recovery_state AS recoveryState, renewal_count AS renewalCount, status FROM scheduler_session_leases WHERE lease_id = 'lease_renew_after_recovery_error'"
          )
          .get()
      ).toEqual({ recoveryState: null, renewalCount: 1, status: 'active' });
      expect(
        coreDb.sqlite
          .prepare(
            "SELECT recovery_state AS recoveryState FROM scheduler_session_leases WHERE lease_id = 'lease_broken_recovery'"
          )
          .get()
      ).toEqual({ recoveryState: 'needs-evidence' });
      service.stop();
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records workspace reconciliation triggers for stale leases with pending backend handles', () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, 'heartbeat');
      acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        leaseId: 'lease_heartbeat',
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });
      const environmentPackage = recordTestAgentEnvironmentPackage(workspaceDb, {
        suffix: 'heartbeat',
        workspaceInputIds: ['repo'],
      });
      recordCanonicalWorkspaceHandoff(workspaceDb, environmentPackage);

      runSchedulerLeaseMaintenanceOnce(coreDb, {
        maxTotalLeaseMs: 7_200_000,
        now: () => '2026-07-05T00:03:00.000Z',
        renewalDurationMs: 1_800_000,
        renewalLeadMs: 300_000,
      });

      expect(listWorkspaceReconciliationRecords(workspaceDb, 'ws_demo')).toEqual([
        expect.objectContaining({
          affectedRecordIds: [
            'wmr_aepsnap_turn_heartbeat_as_heartbeat_maintenance_heartbeat_repo',
            'bwh_wmr_aepsnap_turn_heartbeat_as_heartbeat_maintenance_heartbeat_repo',
          ],
          backendHandleSummary: expect.objectContaining({
            handleId: 'bwh_wmr_aepsnap_turn_heartbeat_as_heartbeat_maintenance_heartbeat_repo',
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

  it('opens the owner-independent workspace for a non-local scheduler admission', () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    const triggerActor = {
      kind: 'automation',
      id: 'automation_server_user',
      responsibleUserId: 'user_server',
    } as const;

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, 'server_user', triggerActor);
      acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        leaseId: 'lease_server_user',
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });
      const environmentPackage = recordTestAgentEnvironmentPackage(workspaceDb, {
        suffix: 'server_user',
        triggerActor,
        workspaceInputIds: ['repo'],
      });
      recordCanonicalWorkspaceHandoff(workspaceDb, environmentPackage);

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

  it('rejects workspace recovery when the package trigger actor differs from admission', () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    const errors: unknown[] = [];

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, 'actor_mismatch', {
        kind: 'automation',
        id: 'automation_admission',
        responsibleUserId: 'user_server',
      });
      acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        leaseId: 'lease_actor_mismatch',
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });
      const environmentPackage = recordTestAgentEnvironmentPackage(workspaceDb, {
        suffix: 'actor_mismatch',
        triggerActor: {
          kind: 'automation',
          id: 'automation_package',
          responsibleUserId: 'user_server',
        },
        workspaceInputIds: ['repo'],
      });
      recordCanonicalWorkspaceHandoff(workspaceDb, environmentPackage);

      runSchedulerLeaseMaintenanceOnce(coreDb, {
        maxTotalLeaseMs: 7_200_000,
        now: () => '2026-07-05T00:03:00.000Z',
        onError: (error) => errors.push(error),
        renewalDurationMs: 1_800_000,
        renewalLeadMs: 300_000,
      });

      expect(errors).toEqual([
        expect.objectContaining({ message: expect.stringContaining('trigger actor') }),
      ]);
      expect(listWorkspaceReconciliationRecords(workspaceDb, 'ws_demo')).toEqual([]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('retains capacity while an anchored releasing backend still owns cleanup', () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, 'release_retry');
      const environmentPackage = recordTestAgentEnvironmentPackage(workspaceDb, {
        suffix: 'release_retry',
        workspaceInputIds: ['repo'],
      });
      recordCanonicalWorkspaceHandoff(workspaceDb, environmentPackage);
      recordBackendSession(coreDb, 'release_retry');
      markSchedulerSessionLeaseReleasing(coreDb, {
        leaseId: 'lease_release_retry',
        now: () => '2026-07-05T00:00:10.000Z',
        releaseReason: 'worker-final-status',
      });
      expect(
        expireReleasingSchedulerLeases(coreDb, {
          now: () => '2026-07-05T00:05:11.000Z',
        })
      ).toEqual([]);

      for (let index = 0; index < 2; index += 1) {
        runSchedulerLeaseMaintenanceOnce(coreDb, {
          maxTotalLeaseMs: 7_200_000,
          now: () => '2026-07-05T00:05:12.000Z',
          renewalDurationMs: 1_800_000,
          renewalLeadMs: 300_000,
        });
      }

      expect(listWorkspaceReconciliationRecords(workspaceDb, 'ws_demo')).toEqual([]);
      expect(
        coreDb.sqlite
          .prepare(
            "SELECT recovery_state AS recoveryState FROM scheduler_session_leases WHERE lease_id = 'lease_release_retry'"
          )
          .get()
      ).toEqual({ recoveryState: 'needs-evidence' });
      expect(listSchedulerLeasesNeedingWorkspaceRecovery(coreDb)).toEqual([]);
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
      ).toEqual({ admittedCount: 1, inUseCount: 1, version: 2 });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('converges recovery explicitly for an AEP with no workspace inputs', () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, 'zero_input');
      acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        leaseId: 'lease_zero_input',
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });
      recordTestAgentEnvironmentPackage(workspaceDb, {
        suffix: 'zero_input',
        workspaceInputIds: [],
      });

      runSchedulerLeaseMaintenanceOnce(coreDb, {
        maxTotalLeaseMs: 7_200_000,
        now: () => '2026-07-05T00:03:00.000Z',
        renewalDurationMs: 1_800_000,
        renewalLeadMs: 300_000,
      });

      expect(listWorkspaceReconciliationRecords(workspaceDb, 'ws_demo')).toEqual([]);
      expect(listSchedulerLeasesNeedingWorkspaceRecovery(coreDb)).toEqual([]);
      expect(
        coreDb.sqlite
          .prepare(
            "SELECT recovery_state AS recoveryState FROM scheduler_session_leases WHERE lease_id = 'lease_zero_input'"
          )
          .get()
      ).toEqual({ recoveryState: 'recovery-projected' });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('keeps recovery retryable until every AEP workspace input has a handle', () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, 'partial_handoff');
      acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        leaseId: 'lease_partial_handoff',
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });
      const environmentPackage = recordTestAgentEnvironmentPackage(workspaceDb, {
        suffix: 'partial_handoff',
        workspaceInputIds: ['repo_a', 'repo_b'],
      });
      const [firstInput, secondInput] = environmentPackage.workspace.inputs;
      expect(firstInput).toBeDefined();
      expect(secondInput).toBeDefined();
      recordCanonicalWorkspaceHandoff(workspaceDb, environmentPackage, [firstInput!.id]);

      runSchedulerLeaseMaintenanceOnce(coreDb, {
        maxTotalLeaseMs: 7_200_000,
        now: () => '2026-07-05T00:03:00.000Z',
        renewalDurationMs: 1_800_000,
        renewalLeadMs: 300_000,
      });

      expect(listWorkspaceReconciliationRecords(workspaceDb, 'ws_demo')).toHaveLength(0);
      expect(listSchedulerLeasesNeedingWorkspaceRecovery(coreDb)).toHaveLength(1);
      recordCanonicalWorkspaceHandoff(workspaceDb, environmentPackage, [secondInput!.id]);

      runSchedulerLeaseMaintenanceOnce(coreDb, {
        maxTotalLeaseMs: 7_200_000,
        now: () => '2026-07-05T00:03:01.000Z',
        renewalDurationMs: 1_800_000,
        renewalLeadMs: 300_000,
      });

      expect(listWorkspaceReconciliationRecords(workspaceDb, 'ws_demo')).toHaveLength(2);
      expect(listSchedulerLeasesNeedingWorkspaceRecovery(coreDb)).toEqual([]);
      expect(
        coreDb.sqlite
          .prepare(
            "SELECT recovery_state AS recoveryState FROM scheduler_session_leases WHERE lease_id = 'lease_partial_handoff'"
          )
          .get()
      ).toEqual({ recoveryState: 'recovery-projected' });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('does not reinterpret retained handles as pending scheduler cleanup', () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, 'stale_retained');
      dispatchLease(coreDb, 'release_retained');
      const staleEnvironmentPackage = recordTestAgentEnvironmentPackage(workspaceDb, {
        suffix: 'stale_retained',
        workspaceInputIds: ['repo'],
      });
      const releaseEnvironmentPackage = recordTestAgentEnvironmentPackage(workspaceDb, {
        suffix: 'release_retained',
        workspaceInputIds: ['repo'],
      });
      recordCanonicalWorkspaceHandoff(workspaceDb, staleEnvironmentPackage);
      recordCanonicalWorkspaceHandoff(workspaceDb, releaseEnvironmentPackage);
      recordBackendSession(coreDb, 'stale_retained');
      recordBackendSession(coreDb, 'release_retained');
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

      expect(listWorkspaceReconciliationRecords(workspaceDb, 'ws_demo')).toEqual([]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('retains capacity when finalization times out before backend cleanup', () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, 'release_timeout');
      const environmentPackage = recordTestAgentEnvironmentPackage(workspaceDb, {
        suffix: 'release_timeout',
        workspaceInputIds: ['repo'],
      });
      recordCanonicalWorkspaceHandoff(workspaceDb, environmentPackage);
      recordBackendSession(coreDb, 'release_timeout');
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
      expect(listWorkspaceReconciliationRecords(workspaceDb, 'ws_demo')).toEqual([]);
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
        admittedCount: 1,
        expiresAt: '2026-07-05T00:05:10.000Z',
        inUseCount: 1,
        leaseStatus: 'releasing',
        planStatus: 'executing',
        recoveryState: 'needs-evidence',
        releaseReason: 'worker-final-status',
        version: 2,
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
        runRecoveryMaintenance: async () => {},
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

  it('serializes restart recovery maintenance and retries after an isolated failure', async () => {
    const coreDb = createMigratedCoreDb();
    const callbacks: Array<() => void> = [];
    const errors: unknown[] = [];
    let rejectFirstAttempt: ((error: Error) => void) | undefined;
    const firstAttempt = new Promise<void>((_resolve, reject) => {
      rejectFirstAttempt = reject;
    });
    let attempts = 0;

    try {
      const service = startSchedulerLeaseMaintenanceService(coreDb, {
        runRecoveryMaintenance: async () => {
          attempts += 1;
          if (attempts === 1) {
            await firstAttempt;
          }
        },
        intervalMs: 30_000,
        maxTotalLeaseMs: 7_200_000,
        now: () => '2026-07-05T00:10:30.000Z',
        onError: (error) => errors.push(error),
        renewalDurationMs: 1_800_000,
        renewalLeadMs: 300_000,
        setInterval: (callback) => {
          callbacks.push(callback);
          return 'timer';
        },
      });

      await Promise.resolve();
      expect(attempts).toBe(1);

      callbacks[0]?.();
      await Promise.resolve();
      expect(attempts).toBe(1);

      rejectFirstAttempt?.(new Error('NanoHost is not ready'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(errors).toEqual([expect.objectContaining({ message: 'NanoHost is not ready' })]);

      callbacks[0]?.();
      await Promise.resolve();
      expect(attempts).toBe(2);

      service.stop();
    } finally {
      coreDb.sqlite.close();
    }
  });
});

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import type { ActorRef } from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate';
import { recordTestAgentEnvironmentPackage as recordBaseTestAgentEnvironmentPackage } from '../test-support/agent-environment';
import { testEntityId } from '../test-support/entity-ids.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import {
  ensureLocalUser,
  FIXTURE_LOCAL_USER_ID as LOCAL_USER_ID,
} from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { markSchedulerExecutionAttemptClosing } from './execution-attempt-records.js';
import { acceptNanoHostAttemptHeartbeat } from './nanohost-attempt-records.js';
import { runNanoHostAttemptRecoveryMaintenance } from './nanohost-attempt-recovery.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  getNanoHostRuntimeTarget,
  upsertNanoHostRuntimeTarget,
} from './nanohost-runtime-target';
import { recordWorkerBackendSessionMaterializing } from './worker-backend-sessions';
import { getWorkerBackendSession, listWorkerBackendSessions } from './worker-backend-sessions.js';
import { recordWorkerControlAcceptedRecord } from './worker-control-records.js';
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
import { listBackendWorkspaceHandles } from './workspace-sync-records.js';

/** Creates an isolated migrated Core database for scheduler maintenance tests. */
function createMigratedCoreDb() {
  const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-scheduler-maintenance-')));
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({
    coreDb,
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    ownerUserId: LOCAL_USER_ID,
  });
  coreDb.sqlite
    .prepare(`INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind, status)
    VALUES ('usr_00000000-0000-7c6a-be9d-0973844c8526', 'Server worker owner', 'server@example.invalid', 0, ?, ?, 'human', 'active')`)
    .run(Date.now(), Date.now());
  coreDb.sqlite
    .prepare(`INSERT INTO workspace_members (workspace_id, user_id, status, access_level, invitation_id, joined_at, removed_at, revision, created_at, updated_at)
    VALUES ('ws_00000000-0000-7000-8000-000000000001', 'usr_00000000-0000-7c6a-be9d-0973844c8526', 'active', 'editor', NULL, ?, NULL, 1, ?, ?)`)
    .run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
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
    const repositoryPath = join(workspaceDb.dataRoot, 'test-repositories', inputId);
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

  const coreDb = openCoreDb(workspaceDb.dataRoot);
  try {
    return recordBaseTestAgentEnvironmentPackage(workspaceDb, {
      coreDb,
      suffix: input.suffix,
      triggerActor: input.triggerActor ?? { kind: 'user', id: LOCAL_USER_ID },
      workspaceInputIds,
    });
  } finally {
    coreDb.sqlite.close();
  }
}

/** Records a canonical workspace handoff for selected immutable package inputs. */
function recordCanonicalWorkspaceHandoff(
  workspaceDb: ReturnType<typeof openWorkspaceDb>,
  environmentPackage: AgentEnvironmentPackage,
  inputIds = environmentPackage.workspace.inputs.map((input) => input.id)
): void {
  const coreDb = openCoreDb(workspaceDb.dataRoot);
  let backendSessionId: string;
  try {
    const owner = listWorkerBackendSessions(coreDb).find(
      (record) =>
        record.agentSessionId === environmentPackage.scope.agentSessionId &&
        record.packageSnapshotId === environmentPackage.snapshotId
    );
    if (!owner) throw new Error('Fixture requires its exact recorded native backend session.');
    backendSessionId = owner.backendSessionId;
  } finally {
    coreDb.sqlite.close();
  }

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
          name: backendSessionId,
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

/** Establishes exact authorized submitted Native authority and its original physical anchor. */
function dispatchLease(
  coreDb: ReturnType<typeof createMigratedCoreDb>,
  suffix: string,
  triggerActor: ActorRef = { kind: 'user', id: LOCAL_USER_ID }
): void {
  const entry = createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    triggerActor,
    queueEntryId: `queue_${suffix}`,
    requestId: `request_${suffix}`,
    requestedAgentId: 'agent_codex_host',
    threadId: testEntityId('th', `thread_${suffix}`),
    turnId: testEntityId('tu', `turn_${suffix}`),
    turnInput: `Run ${suffix}`,
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    now: () => '2026-07-05T00:00:01.000Z',
  });
  recordTestExecutionAttempt(coreDb, {
    entry,
    attemptId: testEntityId('attempt', `lease_${suffix}`),
    agentSessionId: testEntityId('as', `as_${suffix}`),
    inputRef: `aepsnap_${testEntityId('tu', `turn_${suffix}`)}_${testEntityId('as', `as_${suffix}`)}`,
    bindingRef: `lease-binding:lease_${suffix}`,
    sessionCompatibilityKey: 'c'.repeat(64),
    operationId: `original:${suffix}`,
    now: () => '2026-07-05T00:00:02.000Z',
  });
  recordBackendSession(coreDb, suffix);
}

/** The Native recovery subject owns Workspace projection; only its product terminal callback is modeled here. */
function recoveryInput(coreDb: ReturnType<typeof createMigratedCoreDb>, now: () => string) {
  return {
    executionBackend: new SimulatedTurnExecutor({ coreDb }),
    now,
    cleanupBackendSession: vi.fn(async () => {}),
    prepareBackendCleanup: vi.fn(),
    restoreBackendSession: vi.fn(async () => {}),
    reconcileAcceptedFinalStatus: vi.fn(async () => {}),
    projectRecoveredTurn: vi.fn(async () => ({ status: 'interrupted' as const })),
  };
}

/** Records the production backend anchor owned by one dispatched test lease. */
function recordBackendSession(
  coreDb: ReturnType<typeof createMigratedCoreDb>,
  suffix: string
): void {
  if (!getNanoHostRuntimeTarget(coreDb, 'runtime-target-test')) {
    const allocated = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      deploymentId: 'deployment-test',
      identityId: 'identity-test',
      observedAt: '2026-07-05T00:00:00.000Z',
      targetId: 'runtime-target-test',
    });
    upsertNanoHostRuntimeTarget(coreDb, {
      ...allocated,
      freshEmpty: true,
      observedAt: '2026-07-05T00:00:01.000Z',
      physicalEpoch: 'a'.repeat(64),
      predecessorFenced: true,
      ready: true,
    });
  }
  recordWorkerBackendSessionMaterializing(coreDb, {
    backendLineage: { imageRef: 'openkit/worker-codex:dev', kind: 'reference' },
    backendVersion: '0.0.80',
    identity: {
      agentSessionId: testEntityId('as', `as_${suffix}`),
      backendKind: 'openshell',
      backendSessionId: `sandbox_${suffix}`,
      deploymentId: 'deployment-test',
      packageSnapshotId: `aepsnap_${testEntityId('tu', `turn_${suffix}`)}_${testEntityId('as', `as_${suffix}`)}`,
      runtimeTargetId: 'runtime-target-test',
      stagingDirectoryRef: `server/runtime/worker-backend-sessions/aepsnap_${testEntityId('tu', `turn_${suffix}`)}_${testEntityId('as', `as_${suffix}`)}`,
      transientProviderInstanceId: null,
    },
    lineage: {
      threadId: testEntityId('th', `thread_${suffix}`),
      turnId: testEntityId('tu', `turn_${suffix}`),
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    },
    now: () => '2026-07-05T00:00:03.000Z',
    sandboxBindingRef: `lease-binding:lease_${suffix}`,
  });
}

/** Observes the Core attempt phase without projecting the retired grant or physical accounting. */
function observeExecutionAttempts(
  coreDb: ReturnType<typeof openCoreDb>
): Record<string, unknown>[] {
  const present = coreDb.sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduler_execution_attempts'"
    )
    .get();
  return present
    ? (coreDb.sqlite
        .prepare('SELECT * FROM scheduler_execution_attempts ORDER BY rowid')
        .all() as Record<string, unknown>[])
    : [];
}

/** Requires exact affected-record coverage and uncertainty without prescribing record partition or teardown. */
function expectUnprovedWorkspaceReconciliation(
  coreDb: ReturnType<typeof openCoreDb>,
  workspaceDb: ReturnType<typeof openWorkspaceDb>,
  environmentPackage: AgentEnvironmentPackage
): void {
  const affectedRecordIds = environmentPackage.workspace.inputs.flatMap(({ id: inputId }) => {
    const materializationId = `wmr_${environmentPackage.snapshotId}_${inputId}`;
    return [materializationId, `bwh_${materializationId}`];
  });
  const records = listWorkspaceReconciliationRecords(
    workspaceDb,
    environmentPackage.scope.workspaceId
  ).filter((record) => record.affectedRecordIds.some((id) => affectedRecordIds.includes(id)));
  // Coverage is over the exact durable records, so an aggregate reconciliation is sufficient.
  expect(
    records.flatMap((record) => record.affectedRecordIds),
    'Stale/lost attempts must evaluate every affected materialization and backend handle.'
  ).toEqual(expect.arrayContaining(affectedRecordIds));
  for (const record of records) {
    // This fixture supplies neither collected output nor a reachability observation. Staleness
    // alone does not imply requires-human; the absent proof in this fixture does.
    expect(record.stateAfter).toBe('requires-human');
    expect(record.requiredHumanDecision).toBeTruthy();
    expect(record.collectedOutputManifestIds).toEqual([]);
    expect(['unknown', 'unavailable']).toContain(record.backendReachability.status);
    if (record.retentionDecision === 'retain-backend') {
      const backend = getWorkerBackendSession(
        coreDb,
        (
          coreDb.sqlite
            .prepare('SELECT attempt_id FROM scheduler_execution_attempts WHERE turn_id = ?')
            .get(environmentPackage.scope.turnId) as { attempt_id: string }
        ).attempt_id
      );
      expect(
        backend,
        'A retention decision must still refer to retained backend state.'
      ).not.toBeNull();
      expect(
        ['physical-cleaned', 'cleaned'],
        'A cleaned backend cannot simultaneously be recorded as retained.'
      ).not.toContain(backend?.state);
    }
  }
}

describe('scheduler lease maintenance service', () => {
  it('records workspace reconciliation triggers for stale Native attempts with pending backend handles', async () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, 'heartbeat');
      acceptNanoHostAttemptHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        attemptId: testEntityId('attempt', 'lease_heartbeat'),
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 0,
        workerProcessKeyHash: 'a'.repeat(43),
      });
      acceptNanoHostAttemptHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        attemptId: testEntityId('attempt', 'lease_heartbeat'),
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });
      const environmentPackage = recordTestAgentEnvironmentPackage(workspaceDb, {
        suffix: 'heartbeat',
        workspaceInputIds: ['repo'],
      });
      recordCanonicalWorkspaceHandoff(workspaceDb, environmentPackage);

      await runNanoHostAttemptRecoveryMaintenance(
        coreDb,
        recoveryInput(coreDb, () => '2026-07-05T00:03:00.000Z')
      );

      expectUnprovedWorkspaceReconciliation(coreDb, workspaceDb, environmentPackage);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('opens the owner-independent workspace for a non-local scheduler admission', async () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    const triggerActor = {
      kind: 'automation',
      id: 'auto_00000000-0000-771a-960d-419194416b71',
      responsibleUserId: 'usr_00000000-0000-7c6a-be9d-0973844c8526',
    } as const;

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, 'server_user', triggerActor);
      acceptNanoHostAttemptHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        attemptId: testEntityId('attempt', 'lease_server_user'),
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 0,
        workerProcessKeyHash: 'a'.repeat(43),
      });
      acceptNanoHostAttemptHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        attemptId: testEntityId('attempt', 'lease_server_user'),
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });
      const environmentPackage = recordTestAgentEnvironmentPackage(workspaceDb, {
        suffix: 'server_user',
        triggerActor,
        workspaceInputIds: ['repo'],
      });
      recordCanonicalWorkspaceHandoff(workspaceDb, environmentPackage);

      await runNanoHostAttemptRecoveryMaintenance(
        coreDb,
        recoveryInput(coreDb, () => '2026-07-05T00:03:00.000Z')
      );

      expectUnprovedWorkspaceReconciliation(coreDb, workspaceDb, environmentPackage);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('rejects workspace recovery when the package trigger actor differs from admission', async () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    const errors: unknown[] = [];

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, 'actor_mismatch', {
        kind: 'automation',
        id: 'auto_00000000-0000-77b8-960a-a219c6ca839d',
        responsibleUserId: 'usr_00000000-0000-7c6a-be9d-0973844c8526',
      });
      acceptNanoHostAttemptHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        attemptId: testEntityId('attempt', 'lease_actor_mismatch'),
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 0,
        workerProcessKeyHash: 'a'.repeat(43),
      });
      acceptNanoHostAttemptHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        attemptId: testEntityId('attempt', 'lease_actor_mismatch'),
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });
      const environmentPackage = recordTestAgentEnvironmentPackage(workspaceDb, {
        suffix: 'actor_mismatch',
        triggerActor: {
          kind: 'automation',
          id: 'auto_00000000-0000-727a-ad55-397eb258b17f',
          responsibleUserId: 'usr_00000000-0000-7c6a-be9d-0973844c8526',
        },
        workspaceInputIds: ['repo'],
      });
      recordCanonicalWorkspaceHandoff(workspaceDb, environmentPackage);

      await runNanoHostAttemptRecoveryMaintenance(
        coreDb,
        recoveryInput(coreDb, () => '2026-07-05T00:03:00.000Z')
      ).catch((error: AggregateError) => errors.push(...error.errors));

      expect(errors).toEqual([
        expect.objectContaining({ message: expect.stringContaining('trigger actor') }),
      ]);
      expect(
        listWorkspaceReconciliationRecords(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('preserves closing exclusion after physical cleanup without terminal barrier proof', async () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, 'release_retry');
      const environmentPackage = recordTestAgentEnvironmentPackage(workspaceDb, {
        suffix: 'release_retry',
        workspaceInputIds: ['repo'],
      });
      recordCanonicalWorkspaceHandoff(workspaceDb, environmentPackage);
      markSchedulerExecutionAttemptClosing(coreDb, {
        attemptId: testEntityId('attempt', 'lease_release_retry'),
        now: () => '2026-07-05T00:00:10.000Z',
        cause: 'worker-final-status',
      });

      for (let index = 0; index < 2; index += 1) {
        await runNanoHostAttemptRecoveryMaintenance(
          coreDb,
          recoveryInput(coreDb, () => '2026-07-05T00:05:12.000Z')
        );
      }

      // Expired Native liveness with no accepted final status still owns reconciliation;
      // closing alone neither suppresses evaluation nor proves the terminal release barrier.
      expectUnprovedWorkspaceReconciliation(coreDb, workspaceDb, environmentPackage);
      expect(
        observeExecutionAttempts(coreDb).find(
          (attempt) => attempt.attempt_id === testEntityId('attempt', 'lease_release_retry')
        )?.phase
      ).toBe('closing');
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('converges recovery explicitly for an AEP with no workspace inputs', async () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, 'zero_input');
      acceptNanoHostAttemptHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        attemptId: testEntityId('attempt', 'lease_zero_input'),
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 0,
        workerProcessKeyHash: 'a'.repeat(43),
      });
      acceptNanoHostAttemptHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        attemptId: testEntityId('attempt', 'lease_zero_input'),
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });
      recordTestAgentEnvironmentPackage(workspaceDb, {
        suffix: 'zero_input',
        workspaceInputIds: [],
      });

      await runNanoHostAttemptRecoveryMaintenance(
        coreDb,
        recoveryInput(coreDb, () => '2026-07-05T00:03:00.000Z')
      );

      expect(
        listWorkspaceReconciliationRecords(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([]);
      expect(['open', 'closing']).toContain(
        observeExecutionAttempts(coreDb).find(
          (attempt) => attempt.attempt_id === testEntityId('attempt', 'lease_zero_input')
        )?.phase
      );
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('keeps recovery retryable until every AEP workspace input has a handle', async () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, 'partial_handoff');
      acceptNanoHostAttemptHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        attemptId: testEntityId('attempt', 'lease_partial_handoff'),
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 0,
        workerProcessKeyHash: 'a'.repeat(43),
      });
      acceptNanoHostAttemptHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        attemptId: testEntityId('attempt', 'lease_partial_handoff'),
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

      // Partial evidence may retain the backend and return, or report incomplete handoff.
      // Either outcome must preserve exclusion until the missing input can be evaluated.
      await runNanoHostAttemptRecoveryMaintenance(
        coreDb,
        recoveryInput(coreDb, () => '2026-07-05T00:03:00.000Z')
      ).catch((error: AggregateError) => {
        expect(error.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ message: expect.stringContaining('handoff is incomplete') }),
          ])
        );
      });
      expect(
        listBackendWorkspaceHandles(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001').filter(
          (handle) => handle.packageSnapshotId === environmentPackage.snapshotId
        )
      ).toHaveLength(1);

      expect(['open', 'closing']).toContain(
        observeExecutionAttempts(coreDb).find(
          (attempt) => attempt.attempt_id === testEntityId('attempt', 'lease_partial_handoff')
        )?.phase
      );

      recordCanonicalWorkspaceHandoff(workspaceDb, environmentPackage, [secondInput!.id]);

      await runNanoHostAttemptRecoveryMaintenance(
        coreDb,
        recoveryInput(coreDb, () => '2026-07-05T00:03:01.000Z')
      );

      expectUnprovedWorkspaceReconciliation(coreDb, workspaceDb, environmentPackage);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('does not reinterpret retained handles as pending scheduler cleanup', async () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

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
      updateBackendWorkspaceHandleCleanupStatus(
        workspaceDb,
        'ws_00000000-0000-7000-8000-000000000001',
        staleEnvironmentPackage.snapshotId,
        'retained',
        '2026-07-05T00:00:20.000Z'
      );
      updateBackendWorkspaceHandleCleanupStatus(
        workspaceDb,
        'ws_00000000-0000-7000-8000-000000000001',
        releaseEnvironmentPackage.snapshotId,
        'retained',
        '2026-07-05T00:00:20.000Z'
      );
      acceptNanoHostAttemptHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        attemptId: testEntityId('attempt', 'lease_stale_retained'),
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 0,
        workerProcessKeyHash: 'a'.repeat(43),
      });
      acceptNanoHostAttemptHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        attemptId: testEntityId('attempt', 'lease_stale_retained'),
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });
      markSchedulerExecutionAttemptClosing(coreDb, {
        attemptId: testEntityId('attempt', 'lease_release_retained'),
        now: () => '2026-07-05T00:00:10.000Z',
        cause: 'worker-final-status',
      });

      await runNanoHostAttemptRecoveryMaintenance(
        coreDb,
        recoveryInput(coreDb, () => '2026-07-05T00:05:11.000Z')
      );

      expect(
        listWorkspaceReconciliationRecords(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('preserves closing exclusion when finalization times out before backend cleanup', async () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, 'release_timeout');
      const environmentPackage = recordTestAgentEnvironmentPackage(workspaceDb, {
        suffix: 'release_timeout',
        workspaceInputIds: ['repo'],
      });
      recordCanonicalWorkspaceHandoff(workspaceDb, environmentPackage);
      acceptNanoHostAttemptHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        attemptId: testEntityId('attempt', 'lease_release_timeout'),
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 0,
        workerProcessKeyHash: 'a'.repeat(43),
      });
      acceptNanoHostAttemptHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        attemptId: testEntityId('attempt', 'lease_release_timeout'),
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });
      markSchedulerExecutionAttemptClosing(coreDb, {
        attemptId: testEntityId('attempt', 'lease_release_timeout'),
        now: () => '2026-07-05T00:00:10.000Z',
        cause: 'worker-final-status',
      });

      recordWorkerControlAcceptedRecord(coreDb, {
        acceptedAt: '2026-07-05T00:00:11.000Z',
        lineage: {
          ...environmentPackage.scope,
          packageSnapshotId: environmentPackage.snapshotId,
          requestId: 'request_release_timeout',
        },
        operation: 'final_status',
        recordKey: '2',
        sequence: 2,
        record: { sequence: 2, status: 'completed', stopReason: 'completed' },
      });
      const recovery = recoveryInput(coreDb, () => '2026-07-05T00:01:00.000Z');
      recovery.reconcileAcceptedFinalStatus.mockImplementation(async () => {
        throw new Error('terminal finalization timeout');
      });
      await expect(runNanoHostAttemptRecoveryMaintenance(coreDb, recovery)).rejects.toMatchObject({
        errors: [expect.objectContaining({ message: 'terminal finalization timeout' })],
      });
      expect(
        observeExecutionAttempts(coreDb).find(
          (attempt) => attempt.attempt_id === testEntityId('attempt', 'lease_release_timeout')
        )?.phase
      ).toBe('closing');

      await expect(
        runNanoHostAttemptRecoveryMaintenance(coreDb, {
          ...recovery,
          now: () => '2026-07-05T00:05:11.000Z',
        })
      ).rejects.toMatchObject({
        errors: [expect.objectContaining({ message: 'terminal finalization timeout' })],
      });
      await expect(
        runNanoHostAttemptRecoveryMaintenance(coreDb, {
          ...recovery,
          now: () => '2026-07-05T00:05:11.000Z',
        })
      ).rejects.toMatchObject({
        errors: [expect.objectContaining({ message: 'terminal finalization timeout' })],
      });
      expect(recovery.reconcileAcceptedFinalStatus).toHaveBeenCalledTimes(3);
      expect(recovery.cleanupBackendSession).not.toHaveBeenCalled();
      expect(
        getWorkerBackendSession(coreDb, testEntityId('attempt', 'lease_release_timeout'))
      ).toMatchObject({
        state: 'materializing',
        physicalCleanedAt: null,
      });
      expect(
        listWorkspaceReconciliationRecords(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([]);
      expect(
        observeExecutionAttempts(coreDb).find(
          (attempt) => attempt.attempt_id === testEntityId('attempt', 'lease_release_timeout')
        )?.phase
      ).toBe('closing');
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });
});

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
} from '@openkit/config-schema';
import { describe, expect, it, vi } from 'vitest';
import { createApp, createDefaultWorkerControlGateway } from './app.js';
import type { FsStore } from './lib/store.js';
import { recordAgentEnvironmentPackageSnapshot } from './runtime/aep-snapshot-ledger.js';
import { resolveAgentEnvironmentPackage } from './runtime/agent-environment.js';
import { runSchedulerLeaseMaintenanceOnce } from './runtime/scheduler-lease-maintenance-service.js';
import {
  WorkerControlGateway,
  type WorkerControlGatewayError,
  type WorkerControlLineage,
} from './runtime/worker-control-gateway.js';
import { listWorkerControlRejectedEvidenceForWorkspace } from './runtime/worker-control-rejected-evidence.js';
import { listWorkspaceReconciliationRecords } from './runtime/workspace-reconciliation-records.js';
import {
  listBackendWorkspaceHandles,
  recordWorkspaceMaterializationRecords,
} from './runtime/workspace-sync-records.js';
import {
  acceptSchedulerLeaseHeartbeat,
  completeSchedulerLeaseForTerminalTurn,
  completeSchedulerSessionLease,
  createSchedulerAdmissionEntry,
  dispatchNextSchedulerEntry,
  requireSchedulerSessionLease,
  resolveSchedulerLeaseTokenBinding,
  schedulerLeaseHasAppliedSupplyRefreshAck,
  upsertSchedulerCapacityRecord,
  upsertSchedulerTargetHealthRecord,
  upsertSchedulerWorkerPool,
} from './scheduler-records.js';
import { type CoreDb, openCoreDb, openWorkspaceDb } from './storage/db.js';
import { LOCAL_USER_ID } from './storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createDemoStore } from './test-support/demo-store.js';

/**
 * Creates an app with one registered worker control session.
 *
 * @returns App, gateway, token, package, and lineage fixtures.
 */
function createWorkerControlRouteFixture(): {
  app: ReturnType<typeof createApp>;
  environmentPackage: AgentEnvironmentPackage;
  gateway: WorkerControlGateway;
  lineage: WorkerControlLineage;
  store: FsStore;
  token: string;
} {
  const store = createDemoStore();
  const turn = store.createTurn('ws_demo', 'th_demo', 'Control worker over HTTP');
  const agent = store.getAgent('ws_demo', 'agent_codex_host');
  const environmentPackage = AgentEnvironmentPackageSchema.parse(
    resolveAgentEnvironmentPackage({
      agent,
      agentSessionId: 'as_control_route_1',
      userId: 'user_local',
      backend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
      },
      createdAt: '2026-06-16T00:00:00.000Z',
      requestId: 'req_control_route_1',
      turn,
      workspaceCwd: '/workspace/repo',
      workspaceRoots: [],
    })
  );
  const gateway = new WorkerControlGateway({
    createToken: () => 'token_control_route_1',
    now: () => '2026-06-16T00:00:02.000Z',
  });
  const registration = gateway.registerSession(environmentPackage);

  return {
    app: createApp({ mode: 'server', store, workerControlGateway: gateway }),
    environmentPackage,
    gateway,
    lineage: {
      agentSessionId: 'as_control_route_1',
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: 'req_control_route_1',
      threadId: 'th_demo',
      turnId: turn.id,
      workspaceId: 'ws_demo',
    },
    store,
    token: registration.token,
  };
}

/**
 * Creates one live scheduler lease for a default database-backed worker-control gateway.
 *
 * @param coreDb Open Core database handle.
 * @param environmentPackage Durable package snapshot owned by the lease.
 * @param lineage Worker lineage owned by the lease.
 * @param suffix Stable test id suffix.
 * @returns Sandbox binding ref registered on the lease.
 */
function createDurableWorkerControlLease(
  coreDb: CoreDb,
  environmentPackage: AgentEnvironmentPackage,
  lineage: WorkerControlLineage,
  suffix: string
): string {
  const poolId = `pool_${suffix}`;
  const targetId = `target_${suffix}`;
  const binding = `lease-binding:lease_${suffix}`;

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
    poolId,
    queueLimit: 20,
    status: 'active',
  });
  upsertSchedulerCapacityRecord(coreDb, {
    capacityClass: 'local',
    concurrencyCeiling: 2,
    inUseCount: 0,
    observationSource: 'configured',
    observedAt: '2026-07-05T00:00:00.000Z',
    poolId,
    queueDepth: 0,
    targetId,
  });
  upsertSchedulerTargetHealthRecord(coreDb, {
    checkResults: [],
    consecutiveFailureCount: 0,
    consecutiveSuccessCount: 1,
    healthState: 'healthy',
    lastProbeAt: '2026-07-05T00:00:00.000Z',
    nextProbeAt: '2026-07-05T00:01:00.000Z',
    targetId,
  });
  createSchedulerAdmissionEntry(coreDb, {
    priorityClass: 'interactive',
    profileRef: 'profile_worker',
    queueEntryId: `queue_${suffix}`,
    requestId: lineage.requestId,
    requestedAgentId: 'agent_worker',
    requiredPoolConstraints: ['openshell.local'],
    threadId: lineage.threadId,
    turnId: lineage.turnId,
    turnInput: 'Run durable worker-control test',
    workspaceId: lineage.workspaceId,
  });
  dispatchNextSchedulerEntry(coreDb, {
    agentSessionId: lineage.agentSessionId,
    expectedControlMode: 'poll',
    expectedDataPlaneMode: 'openshell-files',
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 30_000,
    leaseDurationMs: 900_000,
    leaseId: `lease_${suffix}`,
    packageSnapshotId: lineage.packageSnapshotId,
    planId: `plan_${suffix}`,
    sandboxBindingRef: binding,
    schedulerEpoch: 1,
    startupTimeoutMs: 120_000,
  });
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, LOCAL_USER_ID, lineage.workspaceId);

  try {
    applyScopedMigrations(workspaceDb);
    recordAgentEnvironmentPackageSnapshot(workspaceDb, {
      createdAt: environmentPackage.createdAt,
      environmentPackage,
    });
  } finally {
    workspaceDb.sqlite.close();
  }

  return binding;
}

describe('worker control routes', () => {
  it('keeps worker route planes ahead of product API middleware', () => {
    const routes = createApp()
      .routes.filter(({ path }) => path.startsWith('/api/worker-') || path === '/api/*')
      .map(({ method, path }) => `${method} ${path}`);

    expect(routes).toEqual([
      'ALL /api/worker-control/*',
      'POST /api/worker-control/heartbeat',
      'POST /api/worker-control/artifacts',
      'POST /api/worker-control/commands/poll',
      'POST /api/worker-control/commands/ack',
      'POST /api/worker-control/terminal-results',
      'POST /api/worker-control/events/append',
      'POST /api/worker-control/final-status',
      'POST /api/worker-control/supply-refresh-ack',
      'POST /api/worker-control/capability-summary',
      'POST /api/worker-control/knowledge-proposal-summary',
      'ALL /api/worker-inference/*',
      'POST /api/worker-inference/v1/chat/completions',
      'POST /api/worker-inference/v1/responses',
      'ALL /api/*',
      'ALL /api/*',
    ]);
  });

  it('keeps event append sequence conflicts durable across default gateway instances', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-control-sequence-')));
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Durable sequence thread');
    const turn = store.createTurn('ws_demo', thread.id, 'Control worker');
    const agent = store.getAgent('ws_demo', 'agent_codex_host');
    const environmentPackage = AgentEnvironmentPackageSchema.parse(
      resolveAgentEnvironmentPackage({
        agent,
        agentSessionId: 'session_durable_sequence',
        userId: 'user_local',
        backend: {
          workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
          kind: 'openshell',
          sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
        },
        createdAt: '2026-06-16T00:00:00.000Z',
        requestId: 'req_durable_sequence',
        turn,
        workspaceCwd: '/workspace/repo',
        workspaceRoots: [],
      })
    );
    const lineage: WorkerControlLineage = {
      agentSessionId: environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: environmentPackage.scope.requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    };

    try {
      applyMigrations(coreDb);

      const binding = createDurableWorkerControlLease(
        coreDb,
        environmentPackage,
        lineage,
        'durable_sequence'
      );
      const firstGateway = createDefaultWorkerControlGateway(coreDb);
      const firstRegistration = firstGateway.registerSession(environmentPackage, {
        sandboxBindingRef: binding,
      });
      const firstApp = createApp({
        coreDb,
        mode: 'server',
        store,
        workerControlGateway: firstGateway,
      });
      const first = await firstApp.request('/api/worker-control/events/append', {
        body: JSON.stringify({
          lineage,
          record: {
            event: { data: { delta: 'hello', itemId: 'candidate_item_1' }, type: 'item.delta' },
            kind: 'event',
            lineage,
            schemaVersion: 1,
            sequence: 3,
          },
        }),
        headers: {
          authorization: `Bearer ${firstRegistration.token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });

      const secondGateway = createDefaultWorkerControlGateway(coreDb);
      const secondRegistration = secondGateway.registerSession(environmentPackage, {
        sandboxBindingRef: binding,
      });
      const secondApp = createApp({
        coreDb,
        mode: 'server',
        store,
        workerControlGateway: secondGateway,
      });
      const conflict = await secondApp.request('/api/worker-control/events/append', {
        body: JSON.stringify({
          lineage,
          record: {
            event: {
              data: { delta: 'different', itemId: 'candidate_item_1' },
              type: 'item.delta',
            },
            kind: 'event',
            lineage,
            schemaVersion: 1,
            sequence: 3,
          },
        }),
        headers: {
          authorization: `Bearer ${secondRegistration.token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const body = (await conflict.json()) as { code: string };

      expect(first.status).toBe(200);
      expect(conflict.status).toBe(409);
      expect(body.code).toBe('worker_control_sequence_conflict');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('persists accepted worker-control records through the default gateway', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-control-records-')));
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Durable control records thread');
    const turn = store.createTurn('ws_demo', thread.id, 'Control worker');
    const agent = store.getAgent('ws_demo', 'agent_codex_host');
    const environmentPackage = AgentEnvironmentPackageSchema.parse(
      resolveAgentEnvironmentPackage({
        agent,
        agentSessionId: 'session_durable_records',
        userId: 'user_local',
        backend: {
          workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
          kind: 'openshell',
          sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
        },
        createdAt: '2026-06-16T00:00:00.000Z',
        requestId: 'req_durable_records',
        turn,
        workspaceCwd: '/workspace/repo',
        workspaceRoots: [],
      })
    );
    const lineage: WorkerControlLineage = {
      agentSessionId: environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: environmentPackage.scope.requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    };

    try {
      applyMigrations(coreDb);

      const binding = createDurableWorkerControlLease(
        coreDb,
        environmentPackage,
        lineage,
        'durable_records'
      );
      const gateway = createDefaultWorkerControlGateway(coreDb);
      const registration = gateway.registerSession(environmentPackage, {
        sandboxBindingRef: binding,
      });
      const app = createApp({
        coreDb,
        mode: 'server',
        store,
        workerControlGateway: gateway,
      });
      const heartbeat = await app.request('/api/worker-control/heartbeat', {
        body: JSON.stringify({
          lineage,
          message: 'Worker is alive.',
          sequence: 1,
          status: 'running',
        }),
        headers: {
          authorization: `Bearer ${registration.token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const event = await app.request('/api/worker-control/events/append', {
        body: JSON.stringify({
          lineage,
          record: {
            event: { data: { delta: 'hello', itemId: 'candidate_item_1' }, type: 'item.delta' },
            kind: 'event',
            lineage,
            schemaVersion: 1,
            sequence: 3,
          },
        }),
        headers: {
          authorization: `Bearer ${registration.token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const rows = coreDb.sqlite
        .prepare(
          `
          SELECT operation, record_key AS recordKey, sequence, record_json AS recordJson
          FROM worker_control_records
          ORDER BY operation
          `
        )
        .all() as Array<{
        operation: string;
        recordJson: string;
        recordKey: string;
        sequence: number;
      }>;

      expect(heartbeat.status).toBe(200);
      expect(event.status).toBe(200);
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => [row.operation, row.recordKey, row.sequence])).toEqual([
        ['event_append', '3', 3],
        ['heartbeat', '1', 1],
      ]);
      expect(JSON.parse(rows[0].recordJson)).toMatchObject({
        event: { type: 'item.delta' },
        sequence: 3,
      });
      expect(JSON.parse(rows[1].recordJson)).toMatchObject({
        status: 'running',
        sequence: 1,
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records rejected worker-control evidence through the default gateway', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-control-rejected-')));
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Rejected control records thread');
    const turn = store.createTurn('ws_demo', thread.id, 'Control worker');
    const agent = store.getAgent('ws_demo', 'agent_codex_host');
    const environmentPackage = AgentEnvironmentPackageSchema.parse(
      resolveAgentEnvironmentPackage({
        agent,
        agentSessionId: 'session_rejected_records',
        userId: 'user_local',
        backend: {
          workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
          kind: 'openshell',
          sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
        },
        createdAt: '2026-06-16T00:00:00.000Z',
        requestId: 'req_rejected_records',
        turn,
        workspaceCwd: '/workspace/repo',
        workspaceRoots: [],
      })
    );
    const lineage: WorkerControlLineage = {
      agentSessionId: environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: environmentPackage.scope.requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    };

    try {
      applyMigrations(coreDb);

      const binding = createDurableWorkerControlLease(
        coreDb,
        environmentPackage,
        lineage,
        'rejected_records'
      );
      const gateway = createDefaultWorkerControlGateway(coreDb);
      const registration = gateway.registerSession(environmentPackage, {
        sandboxBindingRef: binding,
      });
      const app = createApp({
        coreDb,
        mode: 'server',
        store,
        workerControlGateway: gateway,
      });
      const response = await app.request('/api/worker-control/events/append', {
        body: JSON.stringify({
          lineage,
          record: {
            event: { data: { delta: 'hello', itemId: 'candidate_item_1' }, type: 'item.delta' },
            kind: 'event',
            lineage: { ...lineage, threadId: 'th_other' },
            schemaVersion: 1,
            sequence: 1,
          },
        }),
        headers: {
          authorization: `Bearer ${registration.token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const body = (await response.json()) as { code: string };
      const rejectedRow = coreDb.sqlite
        .prepare(
          `
          SELECT route, operation, error_code AS errorCode, http_status AS httpStatus, thread_id AS threadId
          FROM worker_control_rejected_evidence
          WHERE agent_session_id = ?
          `
        )
        .get(lineage.agentSessionId) as
        | {
            errorCode: string;
            httpStatus: number;
            operation: string;
            route: string;
            threadId: string;
          }
        | undefined;
      const acceptedCount = coreDb.sqlite
        .prepare('SELECT COUNT(*) AS count FROM worker_control_records')
        .get() as { count: number };

      expect(response.status).toBe(403);
      expect(body.code).toBe('worker_control_lineage_mismatch');
      expect(rejectedRow).toEqual({
        errorCode: 'worker_control_lineage_mismatch',
        httpStatus: 403,
        operation: 'event_append',
        route: '/api/worker-control/events/append',
        threadId: lineage.threadId,
      });
      expect(acceptedCount.count).toBe(0);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('enforces durable scheduler binding refs through the default gateway factory', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-control-default-')));
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Default binding thread');
    const turn = store.createTurn('ws_demo', thread.id, 'Control worker');
    const agent = store.getAgent('ws_demo', 'agent_codex_host');
    const environmentPackage = AgentEnvironmentPackageSchema.parse(
      resolveAgentEnvironmentPackage({
        agent,
        agentSessionId: 'session_default_binding',
        userId: 'user_local',
        backend: {
          workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
          kind: 'openshell',
          sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
        },
        createdAt: '2026-06-16T00:00:00.000Z',
        requestId: 'req_default_binding',
        turn,
        workspaceCwd: '/workspace/repo',
        workspaceRoots: [],
      })
    );
    const lineage: WorkerControlLineage = {
      agentSessionId: environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: environmentPackage.scope.requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    };

    applyMigrations(coreDb);
    const gateway = createDefaultWorkerControlGateway(coreDb);
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
      poolId: 'pool_default_binding',
      queueLimit: 20,
      status: 'active',
    });
    upsertSchedulerCapacityRecord(coreDb, {
      capacityClass: 'local',
      concurrencyCeiling: 2,
      inUseCount: 0,
      observationSource: 'configured',
      observedAt: '2026-07-05T00:00:00.000Z',
      poolId: 'pool_default_binding',
      queueDepth: 0,
      targetId: 'target_default_binding',
    });
    upsertSchedulerTargetHealthRecord(coreDb, {
      checkResults: [],
      consecutiveFailureCount: 0,
      consecutiveSuccessCount: 1,
      healthState: 'healthy',
      lastProbeAt: '2026-07-05T00:00:00.000Z',
      nextProbeAt: '2026-07-05T00:01:00.000Z',
      targetId: 'target_default_binding',
    });
    createSchedulerAdmissionEntry(coreDb, {
      priorityClass: 'interactive',
      profileRef: 'profile_worker',
      queueEntryId: 'queue_default_binding',
      requestedAgentId: 'agent_worker',
      requiredPoolConstraints: ['openshell.local'],
      threadId: lineage.threadId,
      turnId: lineage.turnId,
      turnInput: 'Run worker control route test',
      workspaceId: lineage.workspaceId,
    });
    dispatchNextSchedulerEntry(coreDb, {
      agentSessionId: lineage.agentSessionId,
      expectedControlMode: 'poll',
      expectedDataPlaneMode: 'openshell-files',
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 30_000,
      leaseDurationMs: 900_000,
      leaseId: 'lease_default_binding',
      packageSnapshotId: lineage.packageSnapshotId,
      planId: 'plan_default_binding',
      sandboxBindingRef: 'lease-binding:lease_default_binding',
      schedulerEpoch: 1,
      startupTimeoutMs: 120_000,
    });
    const registration = gateway.registerSession(environmentPackage, {
      sandboxBindingRef: 'lease-binding:lease_default_binding',
    });
    const app = createApp({ coreDb, mode: 'server', store, workerControlGateway: gateway });

    gateway.recordHeartbeat({
      authorization: `Bearer ${registration.token}`,
      lineage,
      sequence: 1,
      status: 'running',
    });
    expect(requireSchedulerSessionLease(coreDb, 'lease_default_binding')).toMatchObject({
      lastAcceptedHeartbeatAt: expect.any(String),
      lastWorkerSequence: 1,
      status: 'active',
    });
    const heartbeatBaseline = requireSchedulerSessionLease(coreDb, 'lease_default_binding');

    coreDb.sqlite
      .prepare('UPDATE scheduler_session_leases SET last_worker_sequence = ? WHERE lease_id = ?')
      .run(3, 'lease_default_binding');
    const staleSequenceResponse = await app.request('/api/worker-control/heartbeat', {
      body: JSON.stringify({
        lineage,
        sequence: 2,
        status: 'running',
      }),
      headers: {
        authorization: `Bearer ${registration.token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const staleSequenceBody = (await staleSequenceResponse.json()) as { code: string };

    expect.soft(staleSequenceResponse.status).toBe(409);
    expect.soft(staleSequenceBody.code).toBe('worker_control_sequence_stale');
    coreDb.sqlite
      .prepare(
        "DELETE FROM worker_control_sequence_fingerprints WHERE operation = 'heartbeat' AND sequence = ?"
      )
      .run(2);
    coreDb.sqlite
      .prepare('UPDATE scheduler_session_leases SET last_worker_sequence = ? WHERE lease_id = ?')
      .run(heartbeatBaseline.lastWorkerSequence, 'lease_default_binding');

    coreDb.sqlite.exec(`
      CREATE TRIGGER reject_second_heartbeat_record
      BEFORE INSERT ON worker_control_records
      WHEN NEW.operation = 'heartbeat' AND NEW.record_key = '2'
      BEGIN
        SELECT RAISE(ABORT, 'injected heartbeat record failure');
      END
    `);
    const failedHeartbeatResponse = await app.request('/api/worker-control/heartbeat', {
      body: JSON.stringify({
        lineage,
        sequence: 2,
        status: 'running',
      }),
      headers: {
        authorization: `Bearer ${registration.token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    coreDb.sqlite.exec('DROP TRIGGER reject_second_heartbeat_record');
    const failedSequence = coreDb.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM worker_control_sequence_fingerprints WHERE operation = 'heartbeat' AND sequence = ?"
      )
      .get(2) as { count: number };
    const failedRecord = coreDb.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM worker_control_records WHERE operation = 'heartbeat' AND record_key = ?"
      )
      .get('2') as { count: number };
    const leaseAfterFailure = requireSchedulerSessionLease(coreDb, 'lease_default_binding');

    expect(failedHeartbeatResponse.status).toBe(500);
    expect.soft(failedSequence.count).toBe(0);
    expect.soft(failedRecord.count).toBe(0);
    expect.soft(leaseAfterFailure).toMatchObject({
      heartbeatDeadline: heartbeatBaseline.heartbeatDeadline,
      lastAcceptedHeartbeatAt: heartbeatBaseline.lastAcceptedHeartbeatAt,
      lastWorkerSequence: heartbeatBaseline.lastWorkerSequence,
      status: heartbeatBaseline.status,
    });
    coreDb.sqlite
      .prepare(
        "DELETE FROM worker_control_sequence_fingerprints WHERE operation = 'heartbeat' AND sequence = ?"
      )
      .run(2);
    coreDb.sqlite
      .prepare(
        `UPDATE scheduler_session_leases
         SET status = ?, heartbeat_deadline = ?, last_accepted_heartbeat_at = ?, last_worker_sequence = ?
         WHERE lease_id = ?`
      )
      .run(
        heartbeatBaseline.status,
        heartbeatBaseline.heartbeatDeadline,
        heartbeatBaseline.lastAcceptedHeartbeatAt,
        heartbeatBaseline.lastWorkerSequence,
        'lease_default_binding'
      );
    coreDb.sqlite
      .prepare(
        "UPDATE scheduler_session_leases SET heartbeat_deadline = '2000-01-01T00:00:00.000Z' WHERE lease_id = ?"
      )
      .run('lease_default_binding');
    const staleResponse = await app.request('/api/worker-control/heartbeat', {
      body: JSON.stringify({
        lineage,
        sequence: 2,
        status: 'running',
      }),
      headers: {
        authorization: `Bearer ${registration.token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const staleBody = (await staleResponse.json()) as { code: string };

    expect(staleResponse.status).toBe(403);
    expect(staleBody.code).toBe('worker_control_lease_not_live');
    completeSchedulerSessionLease(coreDb, {
      leaseId: 'lease_default_binding',
      releaseReason: 'completed',
      terminalStatus: 'released',
    });

    expect(() =>
      gateway.recordHeartbeat({
        authorization: `Bearer ${registration.token}`,
        lineage,
        sequence: 3,
        status: 'running',
      })
    ).toThrowError(
      expect.objectContaining({
        code: 'worker_control_lease_not_live',
        status: 403,
      }) as WorkerControlGatewayError
    );

    coreDb.sqlite.close();
  });

  it('rejects non-lease tokens on the default database gateway', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-control-non-lease-')));
    const { environmentPackage, lineage, store } = createWorkerControlRouteFixture();

    try {
      applyMigrations(coreDb);
      const gateway = createDefaultWorkerControlGateway(coreDb);
      const registration = gateway.registerSession(environmentPackage);
      const app = createApp({ coreDb, mode: 'server', store, workerControlGateway: gateway });
      const response = await app.request('/api/worker-control/heartbeat', {
        body: JSON.stringify({ lineage, sequence: 1, status: 'running' }),
        headers: {
          authorization: `Bearer ${registration.token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const body = (await response.json()) as { code: string };

      expect(response.status).toBe(401);
      expect(body.code).toBe('worker_control_unauthorized');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('keeps worker-control database failures as internal server errors', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-control-db-error-')));
    const { environmentPackage, lineage, store } = createWorkerControlRouteFixture();

    applyMigrations(coreDb);
    const gateway = createDefaultWorkerControlGateway(coreDb);
    const registration = gateway.registerSession(environmentPackage, {
      sandboxBindingRef: 'lease-binding:database_failure',
    });
    const app = createApp({ mode: 'server', store, workerControlGateway: gateway });

    coreDb.sqlite.close();
    const response = await app.request('/api/worker-control/heartbeat', {
      body: JSON.stringify({
        lineage,
        sequence: 1,
        status: 'running',
      }),
      headers: {
        authorization: `Bearer ${registration.token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });

    expect(response.status).toBe(500);
  });

  it.each([
    ['missing', {}],
    ['null', { stopReason: null }],
    ['empty', { stopReason: '' }],
    ['whitespace', { stopReason: '   ' }],
  ])('rejects %s final-status stopReason', async (_label, bodyOverride) => {
    const { app, environmentPackage, gateway, lineage, token } = createWorkerControlRouteFixture();
    const response = await app.request('/api/worker-control/final-status', {
      body: JSON.stringify({
        body: { status: 'completed', ...bodyOverride },
        lineage,
        operation: 'final_status',
        schemaVersion: 1,
        sequence: 7,
      }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const responseBody = (await response.json()) as { code: string };

    expect(response.status).toBe(400);
    expect(responseBody.code).toBe('invalid_request');
    expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)?.events).toEqual([]);
  });

  it.each([
    'turn.completed',
    'turn.failed',
  ] as const)('rejects direct %s event append outside final status', async (eventType) => {
    const { app, environmentPackage, gateway, lineage, token } = createWorkerControlRouteFixture();
    const response = await app.request('/api/worker-control/events/append', {
      body: JSON.stringify({
        lineage,
        record: {
          event: { data: { stopReason: 'completed' }, type: eventType },
          kind: 'event',
          lineage,
          schemaVersion: 1,
          sequence: 7,
        },
      }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const responseBody = (await response.json()) as { code: string };

    expect(response.status).toBe(400);
    expect(responseBody.code).toBe('worker_control_terminal_event_requires_final_status');
    expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)?.events).toEqual([]);
  });

  it('rolls back final status atomically before a successful restart retry', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-control-final-')));
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Final status thread');
    const turn = store.createTurn('ws_demo', thread.id, 'Complete worker');
    const agent = store.getAgent('ws_demo', 'agent_codex_host');
    const environmentPackage = AgentEnvironmentPackageSchema.parse(
      resolveAgentEnvironmentPackage({
        agent,
        agentSessionId: 'session_final_status',
        userId: 'user_local',
        backend: {
          workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
          kind: 'openshell',
          sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
        },
        createdAt: '2026-06-16T00:00:00.000Z',
        requestId: 'req_final_status',
        turn,
        workspaceCwd: '/workspace/repo',
        workspaceRoots: [],
      })
    );
    const lineage: WorkerControlLineage = {
      agentSessionId: environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: environmentPackage.scope.requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    };

    applyMigrations(coreDb);
    const gateway = createDefaultWorkerControlGateway(coreDb);
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, LOCAL_USER_ID, lineage.workspaceId);
    applyScopedMigrations(workspaceDb);
    recordAgentEnvironmentPackageSnapshot(workspaceDb, {
      createdAt: environmentPackage.createdAt,
      environmentPackage,
    });
    recordWorkspaceMaterializationRecords(workspaceDb, [
      {
        backendKind: 'openshell',
        base: { commit: 'abc123', contentDigest: null },
        createdAt: '2026-06-16T00:00:01.000Z',
        id: 'wmr_final_status',
        inputSnapshotId: 'wis_final_status',
        materializedRootRef: 'workspace://ws_demo/repo_default',
        packageSnapshotId: lineage.packageSnapshotId,
        policyDigest: 'sha256:policy',
        readinessEvidence: [{ kind: 'backend.ready', ref: 'version:0.0.63' }],
        sourceId: 'repo_default',
        strategy: 'git',
        workerSessionId: 'sandbox_final_status',
        workspaceId: lineage.workspaceId,
      },
    ]);
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
      poolId: 'pool_final_status',
      queueLimit: 20,
      status: 'active',
    });
    upsertSchedulerCapacityRecord(coreDb, {
      capacityClass: 'local',
      concurrencyCeiling: 2,
      inUseCount: 0,
      observationSource: 'configured',
      observedAt: '2026-07-05T00:00:00.000Z',
      poolId: 'pool_final_status',
      queueDepth: 0,
      targetId: 'target_final_status',
    });
    upsertSchedulerTargetHealthRecord(coreDb, {
      checkResults: [],
      consecutiveFailureCount: 0,
      consecutiveSuccessCount: 1,
      healthState: 'healthy',
      lastProbeAt: '2026-07-05T00:00:00.000Z',
      nextProbeAt: '2026-07-05T00:01:00.000Z',
      targetId: 'target_final_status',
    });
    createSchedulerAdmissionEntry(coreDb, {
      priorityClass: 'interactive',
      profileRef: 'profile_worker',
      queueEntryId: 'queue_final_status',
      requestId: lineage.requestId,
      requestedAgentId: 'agent_worker',
      requiredPoolConstraints: ['openshell.local'],
      threadId: lineage.threadId,
      turnId: lineage.turnId,
      turnInput: 'Run final status route test',
      workspaceId: lineage.workspaceId,
    });
    dispatchNextSchedulerEntry(coreDb, {
      agentSessionId: lineage.agentSessionId,
      expectedControlMode: 'poll',
      expectedDataPlaneMode: 'openshell-files',
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 30_000,
      leaseDurationMs: 900_000,
      leaseId: 'lease_final_status',
      packageSnapshotId: lineage.packageSnapshotId,
      planId: 'plan_final_status',
      sandboxBindingRef: 'lease-binding:lease_final_status',
      schedulerEpoch: 1,
      startupTimeoutMs: 120_000,
      now: () => '2099-07-05T00:00:02.000Z',
    });
    acceptSchedulerLeaseHeartbeat(coreDb, {
      heartbeatTimeoutMs: 30_000,
      leaseId: 'lease_final_status',
      now: () => '2099-07-05T00:00:10.000Z',
      workerSequence: 1,
    });
    const registration = gateway.registerSession(environmentPackage, {
      sandboxBindingRef: 'lease-binding:lease_final_status',
    });
    const app = createApp({ coreDb, mode: 'server', store, workerControlGateway: gateway });
    const finalStatusBody = JSON.stringify({
      schemaVersion: 1,
      lineage,
      operation: 'final_status',
      sequence: 7,
      body: {
        status: 'completed',
        stopReason: 'completed',
      },
    });

    coreDb.sqlite.exec(`
      CREATE TRIGGER reject_final_status_release
      BEFORE UPDATE OF status ON scheduler_session_leases
      WHEN OLD.lease_id = 'lease_final_status' AND NEW.status = 'releasing'
      BEGIN
        SELECT RAISE(ABORT, 'injected final status release failure');
      END
    `);
    const failed = await app.request('/api/worker-control/final-status', {
      body: finalStatusBody,
      headers: {
        authorization: `Bearer ${registration.token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const recordsAfterFailure = coreDb.sqlite
      .prepare(
        `SELECT operation
           FROM worker_control_records
          WHERE turn_id = ? AND operation IN ('event_append', 'final_status')
          ORDER BY operation`
      )
      .all(lineage.turnId);
    const fingerprintsAfterFailure = coreDb.sqlite
      .prepare(
        `SELECT operation
           FROM worker_control_sequence_fingerprints
          WHERE turn_id = ? AND operation IN ('event_append', 'final_status')
          ORDER BY operation`
      )
      .all(lineage.turnId);

    expect(failed.status).toBe(500);
    expect.soft(recordsAfterFailure).toEqual([]);
    expect.soft(fingerprintsAfterFailure).toEqual([]);
    expect(requireSchedulerSessionLease(coreDb, 'lease_final_status')).toMatchObject({
      status: 'active',
    });

    coreDb.sqlite.exec('DROP TRIGGER reject_final_status_release');
    const rebuiltGateway = createDefaultWorkerControlGateway(coreDb);
    const rebuiltApp = createApp({
      coreDb,
      mode: 'server',
      store,
      workerControlGateway: rebuiltGateway,
    });
    const accepted = await rebuiltApp.request('/api/worker-control/final-status', {
      body: finalStatusBody,
      headers: {
        authorization: `Bearer ${registration.token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const lease = coreDb.sqlite
      .prepare(
        'SELECT status, release_reason AS releaseReason FROM scheduler_session_leases WHERE lease_id = ?'
      )
      .get('lease_final_status') as { releaseReason: string; status: string };
    const acceptedRecords = coreDb.sqlite
      .prepare(
        `SELECT operation, COUNT(*) AS count
           FROM worker_control_records
          WHERE turn_id = ? AND operation IN ('event_append', 'final_status')
          GROUP BY operation
          ORDER BY operation`
      )
      .all(lineage.turnId);
    const acceptedFingerprints = coreDb.sqlite
      .prepare(
        `SELECT operation, COUNT(*) AS count
           FROM worker_control_sequence_fingerprints
          WHERE turn_id = ? AND operation IN ('event_append', 'final_status')
          GROUP BY operation
          ORDER BY operation`
      )
      .all(lineage.turnId);

    expect(accepted.status).toBe(200);
    expect.soft(acceptedRecords).toEqual([
      { count: 1, operation: 'event_append' },
      { count: 1, operation: 'final_status' },
    ]);
    expect.soft(acceptedFingerprints).toEqual([
      { count: 1, operation: 'event_append' },
      { count: 1, operation: 'final_status' },
    ]);
    expect(lease).toEqual({
      releaseReason: 'worker-final-status',
      status: 'releasing',
    });

    expect(listBackendWorkspaceHandles(workspaceDb, lineage.workspaceId)).toEqual([
      expect.objectContaining({
        cleanupStatus: 'retained',
        id: 'bwh_wmr_final_status',
        packageSnapshotId: lineage.packageSnapshotId,
        workerSessionId: 'sandbox_final_status',
      }),
    ]);
    expect(
      resolveSchedulerLeaseTokenBinding(coreDb, {
        sandboxBindingRef: 'lease-binding:lease_final_status',
        lineage,
      })
    ).toEqual({ status: 'rejected', reason: 'lease-not-live' });

    const maintenance = runSchedulerLeaseMaintenanceOnce(coreDb, {
      maxTotalLeaseMs: 7_200_000,
      now: () => new Date(Date.now() + 60_000).toISOString(),
      renewalDurationMs: 1_800_000,
      renewalLeadMs: 300_000,
    });

    expect(maintenance.leaseWatch.stale).toEqual([]);
    expect(listWorkspaceReconciliationRecords(workspaceDb, lineage.workspaceId)).toEqual([]);
    expect(requireSchedulerSessionLease(coreDb, 'lease_final_status')).toMatchObject({
      heartbeatDeadline: '2099-07-05T00:00:40.000Z',
      releaseReason: 'worker-final-status',
      status: 'releasing',
    });
    expect(
      coreDb.sqlite
        .prepare(
          'SELECT in_use_count AS inUseCount, version FROM scheduler_capacity_records WHERE target_id = ?'
        )
        .get('target_final_status')
    ).toEqual({ inUseCount: 1, version: 2 });

    const completedTurn = {
      id: lineage.turnId,
      status: 'completed' as const,
      threadId: lineage.threadId,
      workspaceId: lineage.workspaceId,
    };
    completeSchedulerLeaseForTerminalTurn(coreDb, completedTurn);
    completeSchedulerLeaseForTerminalTurn(coreDb, completedTurn);

    expect(requireSchedulerSessionLease(coreDb, 'lease_final_status')).toMatchObject({
      releaseReason: 'turn-completed',
      status: 'released',
    });
    expect(
      coreDb.sqlite
        .prepare(
          'SELECT in_use_count AS inUseCount, version FROM scheduler_capacity_records WHERE target_id = ?'
        )
        .get('target_final_status')
    ).toEqual({ inUseCount: 0, version: 3 });

    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  });

  it('replays only exact final status while its lease is releasing', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-final-status-replay-')));
    const { environmentPackage, lineage, store } = createWorkerControlRouteFixture();

    try {
      applyMigrations(coreDb);
      const binding = createDurableWorkerControlLease(
        coreDb,
        environmentPackage,
        lineage,
        'final_status_replay'
      );
      const gateway = createDefaultWorkerControlGateway(coreDb);
      const app = createApp({ coreDb, mode: 'server', store, workerControlGateway: gateway });
      const authorization = `Bearer ${binding}`;
      const finalStatusBody = JSON.stringify({
        body: { status: 'completed', stopReason: 'completed' },
        lineage,
        operation: 'final_status',
        schemaVersion: 1,
        sequence: 7,
      });
      const accepted = await app.request('/api/worker-control/final-status', {
        body: finalStatusBody,
        headers: { authorization, 'content-type': 'application/json' },
        method: 'POST',
      });

      expect(accepted.status).toBe(200);
      expect(requireSchedulerSessionLease(coreDb, 'lease_final_status_replay')).toMatchObject({
        releaseReason: 'worker-final-status',
        status: 'releasing',
      });

      const sameProcessReplay = await app.request('/api/worker-control/final-status', {
        body: finalStatusBody,
        headers: { authorization, 'content-type': 'application/json' },
        method: 'POST',
      });
      const restartedGateway = createDefaultWorkerControlGateway(coreDb);
      const restartedApp = createApp({
        coreDb,
        mode: 'server',
        store,
        workerControlGateway: restartedGateway,
      });
      const restartedReplay = await restartedApp.request('/api/worker-control/final-status', {
        body: finalStatusBody,
        headers: { authorization, 'content-type': 'application/json' },
        method: 'POST',
      });
      const rejectedEventAppend = await restartedApp.request('/api/worker-control/events/append', {
        body: JSON.stringify({
          lineage,
          record: {
            event: {
              data: { evidenceManifestDigests: {}, stopReason: 'completed' },
              type: 'turn.completed',
            },
            kind: 'event',
            lineage,
            schemaVersion: 1,
            sequence: 7,
          },
        }),
        headers: { authorization, 'content-type': 'application/json' },
        method: 'POST',
      });
      const acceptedRecords = coreDb.sqlite
        .prepare(
          `SELECT operation, COUNT(*) AS count
             FROM worker_control_records
            WHERE turn_id = ? AND operation IN ('event_append', 'final_status')
            GROUP BY operation
            ORDER BY operation`
        )
        .all(lineage.turnId);
      const acceptedFingerprints = coreDb.sqlite
        .prepare(
          `SELECT operation, COUNT(*) AS count
             FROM worker_control_sequence_fingerprints
            WHERE turn_id = ? AND operation IN ('event_append', 'final_status')
            GROUP BY operation
            ORDER BY operation`
        )
        .all(lineage.turnId);

      expect.soft(sameProcessReplay.status).toBe(200);
      expect.soft(restartedReplay.status).toBe(200);
      expect(rejectedEventAppend.status).not.toBe(200);
      expect.soft(acceptedRecords).toEqual([
        { count: 1, operation: 'event_append' },
        { count: 1, operation: 'final_status' },
      ]);
      expect.soft(acceptedFingerprints).toEqual([
        { count: 1, operation: 'event_append' },
        { count: 1, operation: 'final_status' },
      ]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('accepts supply refresh acknowledgements through the control envelope', async () => {
    const { app, environmentPackage, gateway, lineage, token } = createWorkerControlRouteFixture();

    const res = await app.request('/api/worker-control/supply-refresh-ack', {
      body: JSON.stringify({
        body: {
          refreshId: 'refresh_1',
          status: 'applied',
        },
        lineage,
        operation: 'supply_refresh_ack',
        schemaVersion: 1,
        sequence: 8,
      }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const body = (await res.json()) as { supplyRefreshAck: { refreshId: string; status: string } };

    expect(res.status).toBe(200);
    expect(body.supplyRefreshAck).toMatchObject({
      refreshId: 'refresh_1',
      status: 'applied',
    });
    const invalidOperation = await app.request('/api/worker-control/supply-refresh-ack', {
      body: JSON.stringify({
        body: { refreshId: 'refresh_2', status: 'applied' },
        lineage,
        operation: 'final_status',
        schemaVersion: 1,
        sequence: 9,
      }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });

    expect(invalidOperation.status).toBe(400);
    expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)?.supplyRefreshAcks).toEqual([
      expect.objectContaining({ refreshId: 'refresh_1', status: 'applied' }),
    ]);
  });

  it('records supply refresh acknowledgements for durable scheduler renewal gates', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-supply-refresh-ack-')));
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Supply refresh thread');
    const turn = store.createTurn('ws_demo', thread.id, 'Control worker');
    const agent = store.getAgent('ws_demo', 'agent_codex_host');
    const environmentPackage = AgentEnvironmentPackageSchema.parse(
      resolveAgentEnvironmentPackage({
        agent,
        agentSessionId: 'session_supply_refresh',
        userId: 'user_local',
        backend: {
          workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
          kind: 'openshell',
          sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
        },
        createdAt: '2026-06-16T00:00:00.000Z',
        requestId: 'req_supply_refresh',
        turn,
        workspaceCwd: '/workspace/repo',
        workspaceRoots: [],
      })
    );
    const lineage: WorkerControlLineage = {
      agentSessionId: environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: environmentPackage.scope.requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    };

    try {
      applyMigrations(coreDb);
      const gateway = createDefaultWorkerControlGateway(coreDb);
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
        poolId: 'pool_supply_refresh',
        queueLimit: 20,
        status: 'active',
      });
      upsertSchedulerCapacityRecord(coreDb, {
        capacityClass: 'local',
        concurrencyCeiling: 2,
        inUseCount: 0,
        observationSource: 'configured',
        observedAt: '2026-07-05T00:00:00.000Z',
        poolId: 'pool_supply_refresh',
        queueDepth: 0,
        targetId: 'target_supply_refresh',
      });
      upsertSchedulerTargetHealthRecord(coreDb, {
        checkResults: [],
        consecutiveFailureCount: 0,
        consecutiveSuccessCount: 1,
        healthState: 'healthy',
        lastProbeAt: '2026-07-05T00:00:00.000Z',
        nextProbeAt: '2026-07-05T00:01:00.000Z',
        targetId: 'target_supply_refresh',
      });
      createSchedulerAdmissionEntry(coreDb, {
        priorityClass: 'interactive',
        profileRef: 'profile_worker',
        queueEntryId: 'queue_supply_refresh',
        requestedAgentId: 'agent_worker',
        requiredPoolConstraints: ['openshell.local'],
        threadId: lineage.threadId,
        turnId: lineage.turnId,
        turnInput: 'Run supply refresh worker',
        workspaceId: lineage.workspaceId,
      });
      dispatchNextSchedulerEntry(coreDb, {
        agentSessionId: lineage.agentSessionId,
        expectedControlMode: 'poll',
        expectedDataPlaneMode: 'openshell-files',
        heartbeatIntervalMs: 10_000,
        heartbeatTimeoutMs: 30_000,
        leaseDurationMs: 900_000,
        leaseId: 'lease_supply_refresh',
        packageSnapshotId: lineage.packageSnapshotId,
        planId: 'plan_supply_refresh',
        sandboxBindingRef: 'lease-binding:lease_supply_refresh',
        schedulerEpoch: 1,
        startupTimeoutMs: 120_000,
      });
      const registration = gateway.registerSession(environmentPackage, {
        sandboxBindingRef: 'lease-binding:lease_supply_refresh',
      });
      const app = createApp({ coreDb, mode: 'server', store, workerControlGateway: gateway });

      const res = await app.request('/api/worker-control/supply-refresh-ack', {
        body: JSON.stringify({
          body: {
            refreshId: 'refresh_safe_1',
            status: 'applied',
          },
          lineage,
          operation: 'supply_refresh_ack',
          schemaVersion: 1,
          sequence: 4,
        }),
        headers: {
          authorization: `Bearer ${registration.token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });

      expect(res.status).toBe(200);
      expect(
        schedulerLeaseHasAppliedSupplyRefreshAck(coreDb, {
          agentSessionId: lineage.agentSessionId,
          packageSnapshotId: lineage.packageSnapshotId,
        })
      ).toBe(true);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('accepts capability summaries through the control envelope', async () => {
    const { app, environmentPackage, gateway, lineage, token } = createWorkerControlRouteFixture();

    const res = await app.request('/api/worker-control/capability-summary', {
      body: JSON.stringify({
        body: {
          capabilityCallId: 'capability_1',
          diagnostics: [],
          family: 'knowledge.search',
          inputSummary: 'Search project knowledge.',
          lineage,
          outputSummary: 'Returned one entry.',
          schemaVersion: 1,
          sequence: 10,
          status: 'succeeded',
        },
        lineage,
        operation: 'capability_summary',
        schemaVersion: 1,
        sequence: 10,
      }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const body = (await res.json()) as {
      response: { accepted: boolean; nextExpectedSequence: number };
    };

    expect(res.status).toBe(200);
    expect(body.response).toMatchObject({
      accepted: true,
      nextExpectedSequence: 11,
    });
    expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)?.capabilitySummaries).toEqual([
      expect.objectContaining({ capabilityCallId: 'capability_1', status: 'succeeded' }),
    ]);
  });

  it('accepts knowledge proposal summaries through the control envelope', async () => {
    const { app, environmentPackage, gateway, lineage, store, token } =
      createWorkerControlRouteFixture();

    const res = await app.request('/api/worker-control/knowledge-proposal-summary', {
      body: JSON.stringify({
        body: {
          proposalId: 'knowledge_proposal_1',
          summary: 'Persist the worker-discovered project decision.',
          title: 'Remember project decision',
        },
        lineage,
        operation: 'knowledge_proposal_summary',
        schemaVersion: 1,
        sequence: 11,
      }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const body = (await res.json()) as {
      knowledgeProposalSummary: { proposalId: string; title: string };
    };

    expect(res.status).toBe(200);
    expect(body.knowledgeProposalSummary).toMatchObject({
      proposalId: 'knowledge_proposal_1',
      title: 'Remember project decision',
    });
    expect(
      gateway.getSessionSnapshot(environmentPackage.snapshotId)?.knowledgeProposalSummaries
    ).toEqual([expect.objectContaining({ proposalId: 'knowledge_proposal_1' })]);
    expect(store.listKnowledgeProposals(lineage.workspaceId)).toEqual([
      expect.objectContaining({
        id: 'knowledge_proposal_1',
        status: 'pending',
        summary: 'Persist the worker-discovered project decision.',
        title: 'Remember project decision',
      }),
    ]);
  });

  it('preserves stored knowledge proposal timestamps on exact replay', async () => {
    vi.useFakeTimers();

    try {
      vi.setSystemTime(new Date('2026-06-16T00:00:03.000Z'));
      const { app, lineage, store, token } = createWorkerControlRouteFixture();
      const request = {
        body: {
          proposalId: 'knowledge_proposal_replay',
          summary: 'Persist the worker-discovered project decision.',
          title: 'Remember replayed project decision',
        },
        lineage,
        operation: 'knowledge_proposal_summary',
        schemaVersion: 1,
        sequence: 12,
      };
      const init = {
        body: JSON.stringify(request),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      };

      const first = await app.request('/api/worker-control/knowledge-proposal-summary', init);
      store.updateKnowledgeProposalContent('knowledge_proposal_replay', {
        summary: 'Human-edited project decision.',
        title: 'Reviewed project decision',
        updatedAt: '2026-06-16T00:30:03.000Z',
      });
      store.recordKnowledgeProposalReviewDecision({
        decidedAt: '2026-06-16T00:31:03.000Z',
        message: 'Keep the edited proposal.',
        proposalId: 'knowledge_proposal_replay',
        requestId: 'req_review_proposal_replay',
        status: 'edited',
        workspaceId: lineage.workspaceId,
      });
      const reviewed = store.getKnowledgeProposal('knowledge_proposal_replay');

      vi.setSystemTime(new Date('2026-06-16T01:00:03.000Z'));
      const replay = await app.request('/api/worker-control/knowledge-proposal-summary', init);

      expect(first.status).toBe(200);
      expect(replay.status).toBe(200);
      expect(store.getKnowledgeProposal('knowledge_proposal_replay')).toEqual(reviewed);
      expect(store.getKnowledgeProposalReviewDecision('knowledge_proposal_replay')).toMatchObject({
        status: 'edited',
        message: 'Keep the edited proposal.',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a colliding worker proposal id before accepting its sequence', async () => {
    const { app, environmentPackage, gateway, lineage, store, token } =
      createWorkerControlRouteFixture();
    const existing = store.createKnowledgeProposal({
      createdAt: '2026-06-15T00:00:00.000Z',
      id: 'knowledge_proposal_collision',
      status: 'pending',
      summary: 'Existing workspace proposal.',
      title: 'Existing proposal',
      updatedAt: '2026-06-15T00:00:00.000Z',
      workspaceId: lineage.workspaceId,
    });
    const init = {
      body: JSON.stringify({
        body: {
          proposalId: existing.id,
          summary: 'Worker proposal must not overwrite an existing proposal.',
          title: 'Conflicting worker proposal',
        },
        lineage,
        operation: 'knowledge_proposal_summary',
        schemaVersion: 1,
        sequence: 13,
      }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    };

    const first = await app.request('/api/worker-control/knowledge-proposal-summary', init);
    const replay = await app.request('/api/worker-control/knowledge-proposal-summary', init);
    const firstBody = (await first.json()) as { code?: string };
    const replayBody = (await replay.json()) as { code?: string };

    expect([first.status, replay.status]).toEqual([409, 409]);
    expect([firstBody.code, replayBody.code]).toEqual([
      'worker_control_knowledge_proposal_conflict',
      'worker_control_knowledge_proposal_conflict',
    ]);
    expect(store.getKnowledgeProposal(existing.id)).toEqual(existing);
    expect(
      gateway.getSessionSnapshot(environmentPackage.snapshotId)?.knowledgeProposalSummaries
    ).toEqual([]);
  });

  it('rejects oversized control envelopes before schema handling', async () => {
    const { app, lineage, token } = createWorkerControlRouteFixture();

    const res = await app.request('/api/worker-control/knowledge-proposal-summary', {
      body: JSON.stringify({
        body: {
          proposalId: 'knowledge_proposal_large',
          summary: 'x'.repeat(70 * 1024),
          title: 'Oversized proposal',
        },
        lineage,
        operation: 'knowledge_proposal_summary',
        schemaVersion: 1,
        sequence: 12,
      }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(413);
    expect(body.code).toBe('worker_control_payload_too_large');
  });

  it('rejects oversized simple control requests before sandbox authentication', async () => {
    const { app, lineage } = createWorkerControlRouteFixture();
    const padding = 'x'.repeat(70 * 1024);
    const requests = [
      {
        body: { lineage, message: padding, sequence: 1, status: 'running' },
        path: '/api/worker-control/heartbeat',
      },
      {
        body: {
          artifact: { path: padding, title: 'Oversized artifact' },
          lineage,
          sequence: 1,
        },
        path: '/api/worker-control/artifacts',
      },
      {
        body: { lineage, padding },
        path: '/api/worker-control/commands/poll',
      },
      {
        body: { commandId: 'command_missing', lineage, padding },
        path: '/api/worker-control/commands/ack',
      },
    ];
    const results = await Promise.all(
      requests.map(async ({ body, path }) => {
        const response = await app.request(path, {
          body: JSON.stringify(body),
          headers: {
            authorization: 'Bearer invalid',
            'content-type': 'application/json',
          },
          method: 'POST',
        });

        return {
          body: (await response.json()) as { code: string },
          status: response.status,
        };
      })
    );

    expect(results).toEqual(
      requests.map(() => ({
        body: expect.objectContaining({ code: 'worker_control_payload_too_large' }),
        status: 413,
      }))
    );
  });

  it('accepts sandbox bearer heartbeats without a browser session cookie', async () => {
    const { app, lineage, token } = createWorkerControlRouteFixture();

    const res = await app.request('/api/worker-control/heartbeat', {
      body: JSON.stringify({
        lineage,
        message: 'Worker is alive.',
        sequence: 1,
        status: 'running',
      }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const body = (await res.json()) as { heartbeat: { status: string; lastHeartbeatAt: string } };

    expect(res.status).toBe(200);
    expect(body.heartbeat).toMatchObject({
      lastHeartbeatAt: '2026-06-16T00:00:02.000Z',
      status: 'running',
    });
  });

  it('accepts worker artifact notices over HTTP', async () => {
    const { app, lineage, token } = createWorkerControlRouteFixture();

    const res = await app.request('/api/worker-control/artifacts', {
      body: JSON.stringify({
        artifact: {
          mediaType: 'text/markdown',
          path: '/openkit/artifacts/report.md',
          title: 'Worker report',
        },
        lineage,
        sequence: 2,
      }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const body = (await res.json()) as {
      artifact: { path: string; title: string };
    };

    expect(res.status).toBe(200);
    expect(body.artifact).toMatchObject({
      path: '/openkit/artifacts/report.md',
      title: 'Worker report',
    });
  });

  it('returns queued commands to the authenticated worker poll', async () => {
    const { app, environmentPackage, gateway, lineage, token } = createWorkerControlRouteFixture();

    gateway.enqueueTerminalCommand(environmentPackage.snapshotId, {
      argv: ['pwd'],
      commandId: 'term_route_1',
      cwd: '/workspace/repo',
    });

    const res = await app.request('/api/worker-control/commands/poll', {
      body: JSON.stringify({ lineage }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const body = (await res.json()) as {
      commands: Array<{ argv: string[]; commandId: string; kind: string }>;
    };

    expect(res.status).toBe(200);
    expect(body.commands).toEqual([
      expect.objectContaining({
        argv: ['pwd'],
        commandId: 'term_route_1',
        kind: 'terminal-command',
      }),
    ]);
  });

  it('records command poll rejection evidence with the canonical operation', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-command-poll-rejected-')));
    const { gateway, lineage, store } = createWorkerControlRouteFixture();

    try {
      applyMigrations(coreDb);
      const app = createApp({ coreDb, mode: 'server', store, workerControlGateway: gateway });
      const res = await app.request('/api/worker-control/commands/poll', {
        body: JSON.stringify({ lineage }),
        headers: {
          authorization: 'Bearer wrong',
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const evidence = listWorkerControlRejectedEvidenceForWorkspace(
        coreDb,
        lineage.workspaceId
      )[0];

      expect(res.status).toBe(401);
      expect(evidence).toMatchObject({
        errorCode: 'worker_control_unauthorized',
        operation: 'command_poll',
        route: '/api/worker-control/commands/poll',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('persists worker-control command delivery state through the default gateway', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-control-commands-')));
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Durable command thread');
    const turn = store.createTurn('ws_demo', thread.id, 'Control worker');
    const agent = store.getAgent('ws_demo', 'agent_codex_host');
    const environmentPackage = AgentEnvironmentPackageSchema.parse(
      resolveAgentEnvironmentPackage({
        agent,
        agentSessionId: 'session_durable_command',
        userId: 'user_local',
        backend: {
          workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
          kind: 'openshell',
          sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
        },
        createdAt: '2026-06-16T00:00:00.000Z',
        requestId: 'req_durable_command',
        turn,
        workspaceCwd: '/workspace/repo',
        workspaceRoots: [],
      })
    );
    const lineage: WorkerControlLineage = {
      agentSessionId: environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: environmentPackage.scope.requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    };

    try {
      applyMigrations(coreDb);

      const binding = createDurableWorkerControlLease(
        coreDb,
        environmentPackage,
        lineage,
        'durable_command'
      );
      const gateway = createDefaultWorkerControlGateway(coreDb);
      const registration = gateway.registerSession(environmentPackage, {
        sandboxBindingRef: binding,
      });
      gateway.enqueueTerminalCommand(environmentPackage.snapshotId, {
        argv: ['pwd'],
        commandId: 'term_durable_1',
        cwd: '/workspace/repo',
      });
      const queued = coreDb.sqlite
        .prepare(
          'SELECT status, delivered_at AS deliveredAt, acknowledged_at AS acknowledgedAt FROM worker_control_commands WHERE command_id = ?'
        )
        .get('term_durable_1') as {
        acknowledgedAt: string | null;
        deliveredAt: string | null;
        status: string;
      };
      const app = createApp({ coreDb, mode: 'server', store, workerControlGateway: gateway });

      const poll = await app.request('/api/worker-control/commands/poll', {
        body: JSON.stringify({ lineage }),
        headers: {
          authorization: `Bearer ${registration.token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const delivered = coreDb.sqlite
        .prepare(
          'SELECT status, delivered_at AS deliveredAt, acknowledged_at AS acknowledgedAt FROM worker_control_commands WHERE command_id = ?'
        )
        .get('term_durable_1') as {
        acknowledgedAt: string | null;
        deliveredAt: string | null;
        status: string;
      };
      const result = await app.request('/api/worker-control/terminal-results', {
        body: JSON.stringify({
          durationMs: 10,
          exitCode: 0,
          lineage,
          stderr: '',
          stdout: '/workspace/repo\n',
          terminalCommandId: 'term_durable_1',
        }),
        headers: {
          authorization: `Bearer ${registration.token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const acknowledged = coreDb.sqlite
        .prepare(
          'SELECT status, delivered_at AS deliveredAt, acknowledged_at AS acknowledgedAt FROM worker_control_commands WHERE command_id = ?'
        )
        .get('term_durable_1') as {
        acknowledgedAt: string | null;
        deliveredAt: string | null;
        status: string;
      };

      expect(queued).toEqual({
        acknowledgedAt: null,
        deliveredAt: null,
        status: 'queued',
      });
      expect(poll.status).toBe(200);
      expect(delivered.status).toBe('delivered');
      expect(delivered.deliveredAt).toEqual(expect.any(String));
      expect(delivered.acknowledgedAt).toBe(null);
      expect(result.status).toBe(200);
      expect(acknowledged.status).toBe('acknowledged');
      expect(acknowledged.deliveredAt).toEqual(expect.any(String));
      expect(acknowledged.acknowledgedAt).toEqual(expect.any(String));
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('persists non-terminal command acknowledgements through the default gateway', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-control-command-ack-')));
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Durable command ack thread');
    const turn = store.createTurn('ws_demo', thread.id, 'Control worker');
    const agent = store.getAgent('ws_demo', 'agent_codex_host');
    const environmentPackage = AgentEnvironmentPackageSchema.parse(
      resolveAgentEnvironmentPackage({
        agent,
        agentSessionId: 'session_durable_command_ack',
        userId: 'user_local',
        backend: {
          workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
          kind: 'openshell',
          sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
        },
        createdAt: '2026-06-16T00:00:00.000Z',
        requestId: 'req_durable_command_ack',
        turn,
        workspaceCwd: '/workspace/repo',
        workspaceRoots: [],
      })
    );
    const lineage: WorkerControlLineage = {
      agentSessionId: environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: environmentPackage.scope.requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    };

    try {
      applyMigrations(coreDb);

      const binding = createDurableWorkerControlLease(
        coreDb,
        environmentPackage,
        lineage,
        'durable_command_ack'
      );
      const gateway = createDefaultWorkerControlGateway(coreDb);
      const registration = gateway.registerSession(environmentPackage, {
        sandboxBindingRef: binding,
      });
      const interrupt = gateway.enqueueInterrupt(environmentPackage.snapshotId, 'Stop now');
      const app = createApp({ coreDb, mode: 'server', store, workerControlGateway: gateway });

      await app.request('/api/worker-control/commands/poll', {
        body: JSON.stringify({ lineage }),
        headers: {
          authorization: `Bearer ${registration.token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const ack = await app.request('/api/worker-control/commands/ack', {
        body: JSON.stringify({ commandId: interrupt.commandId, lineage }),
        headers: {
          authorization: `Bearer ${registration.token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const acknowledged = coreDb.sqlite
        .prepare(
          'SELECT status, acknowledged_at AS acknowledgedAt FROM worker_control_commands WHERE command_id = ?'
        )
        .get(interrupt.commandId) as {
        acknowledgedAt: string | null;
        status: string;
      };

      expect(ack.status).toBe(200);
      expect(acknowledged.status).toBe('acknowledged');
      expect(acknowledged.acknowledgedAt).toEqual(expect.any(String));
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rebuilds live worker-control sessions from durable gateway rows', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-control-rebuild-')));
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Rebuild worker session');
    const turn = store.createTurn('ws_demo', thread.id, 'Control worker');
    const agent = store.getAgent('ws_demo', 'agent_codex_host');
    const environmentPackage = AgentEnvironmentPackageSchema.parse(
      resolveAgentEnvironmentPackage({
        agent,
        agentSessionId: 'session_rebuild',
        userId: 'user_local',
        backend: {
          workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
          kind: 'openshell',
          sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
        },
        createdAt: '2026-06-16T00:00:00.000Z',
        requestId: 'req_rebuild',
        turn,
        workspaceCwd: '/workspace/repo',
        workspaceRoots: [],
      })
    );
    const lineage: WorkerControlLineage = {
      agentSessionId: environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: environmentPackage.scope.requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    };

    try {
      applyMigrations(coreDb);
      const firstGateway = createDefaultWorkerControlGateway(coreDb);
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
        poolId: 'pool_rebuild',
        queueLimit: 20,
        status: 'active',
      });
      upsertSchedulerCapacityRecord(coreDb, {
        capacityClass: 'local',
        concurrencyCeiling: 2,
        inUseCount: 0,
        observationSource: 'configured',
        observedAt: '2026-07-05T00:00:00.000Z',
        poolId: 'pool_rebuild',
        queueDepth: 0,
        targetId: 'target_rebuild',
      });
      upsertSchedulerTargetHealthRecord(coreDb, {
        checkResults: [],
        consecutiveFailureCount: 0,
        consecutiveSuccessCount: 1,
        healthState: 'healthy',
        lastProbeAt: '2026-07-05T00:00:00.000Z',
        nextProbeAt: '2026-07-05T00:01:00.000Z',
        targetId: 'target_rebuild',
      });
      createSchedulerAdmissionEntry(coreDb, {
        priorityClass: 'interactive',
        profileRef: 'profile_worker',
        queueEntryId: 'queue_rebuild',
        requestId: lineage.requestId,
        requestedAgentId: 'agent_worker',
        requiredPoolConstraints: ['openshell.local'],
        threadId: lineage.threadId,
        turnId: lineage.turnId,
        turnInput: 'Run worker control rebuild test',
        workspaceId: lineage.workspaceId,
      });
      dispatchNextSchedulerEntry(coreDb, {
        agentSessionId: lineage.agentSessionId,
        expectedControlMode: 'poll',
        expectedDataPlaneMode: 'openshell-files',
        heartbeatIntervalMs: 10_000,
        heartbeatTimeoutMs: 30_000,
        leaseDurationMs: 900_000,
        leaseId: 'lease_rebuild',
        packageSnapshotId: lineage.packageSnapshotId,
        planId: 'plan_rebuild',
        sandboxBindingRef: 'lease-binding:lease_rebuild',
        schedulerEpoch: 1,
        startupTimeoutMs: 120_000,
      });

      const firstRegistration = firstGateway.registerSession(environmentPackage, {
        sandboxBindingRef: 'lease-binding:lease_rebuild',
      });
      firstGateway.enqueueTerminalCommand(environmentPackage.snapshotId, {
        argv: ['pwd'],
        commandId: 'term_rebuild_1',
        cwd: '/workspace/repo',
      });
      const firstApp = createApp({
        coreDb,
        mode: 'server',
        store,
        workerControlGateway: firstGateway,
      });

      const firstHeartbeatResponse = await firstApp.request('/api/worker-control/heartbeat', {
        body: JSON.stringify({
          lineage,
          message: 'Worker is alive.',
          sequence: 1,
          status: 'running',
        }),
        headers: {
          authorization: `Bearer ${firstRegistration.token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const firstHeartbeatBody = (await firstHeartbeatResponse.json()) as {
        heartbeat: { lastHeartbeatAt: string; sequence: number; status: string };
      };
      await firstApp.request('/api/worker-control/events/append', {
        body: JSON.stringify({
          lineage,
          record: {
            event: { data: { delta: 'hello', itemId: 'candidate_item_1' }, type: 'item.delta' },
            kind: 'event',
            lineage,
            schemaVersion: 1,
            sequence: 3,
          },
        }),
        headers: {
          authorization: `Bearer ${firstRegistration.token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });

      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, LOCAL_USER_ID, lineage.workspaceId);
      try {
        applyScopedMigrations(workspaceDb);
        recordAgentEnvironmentPackageSnapshot(workspaceDb, {
          createdAt: '2026-06-16T00:00:01.000Z',
          environmentPackage,
        });
      } finally {
        workspaceDb.sqlite.close();
      }

      vi.useFakeTimers();
      vi.setSystemTime(new Date(Date.parse(firstHeartbeatBody.heartbeat.lastHeartbeatAt) + 1_000));
      const rebuiltGateway = createDefaultWorkerControlGateway(coreDb);
      const rebuiltApp = createApp({
        coreDb,
        mode: 'server',
        store,
        workerControlGateway: rebuiltGateway,
      });
      const authorization = 'Bearer lease-binding:lease_rebuild';
      const retryHeartbeat = rebuiltGateway.recordHeartbeat({
        authorization,
        lineage,
        message: 'Worker is alive.',
        sequence: 1,
        status: 'running',
      });
      const snapshot = rebuiltGateway.getSessionSnapshot(lineage.packageSnapshotId);
      const leaseAfterRetry = requireSchedulerSessionLease(coreDb, 'lease_rebuild');
      const poll = await rebuiltApp.request('/api/worker-control/commands/poll', {
        body: JSON.stringify({ lineage }),
        headers: {
          authorization: 'Bearer lease-binding:lease_rebuild',
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const body = (await poll.json()) as { commands: Array<{ commandId: string }> };

      expect.soft(retryHeartbeat).toEqual(firstHeartbeatBody.heartbeat);
      expect.soft(snapshot?.heartbeat).toEqual(firstHeartbeatBody.heartbeat);
      expect
        .soft(leaseAfterRetry.lastAcceptedHeartbeatAt)
        .toBe(firstHeartbeatBody.heartbeat.lastHeartbeatAt);
      expect(snapshot).toMatchObject({
        agentSessionId: 'session_rebuild',
        commands: [expect.objectContaining({ commandId: 'term_rebuild_1' })],
        events: [expect.objectContaining({ sequence: 3 })],
        heartbeat: expect.objectContaining({ status: 'running' }),
        packageSnapshotId: lineage.packageSnapshotId,
      });
      expect(poll.status).toBe(200);
      expect(body.commands).toEqual([expect.objectContaining({ commandId: 'term_rebuild_1' })]);
      const terminalResult = rebuiltGateway.recordTerminalResult({
        authorization,
        durationMs: 10,
        exitCode: 0,
        lineage,
        stderr: '',
        stdout: '/workspace/repo\n',
        terminalCommandId: 'term_rebuild_1',
      });
      const afterTerminalResult = rebuiltGateway.pollCommands({ authorization, lineage });

      expect(terminalResult).toMatchObject({ commandId: 'term_rebuild_1', exitCode: 0 });
      expect.soft(afterTerminalResult.commands).toEqual([]);

      const interrupt = rebuiltGateway.enqueueInterrupt(
        environmentPackage.snapshotId,
        'Stop after current command.'
      );
      rebuiltGateway.pollCommands({ authorization, lineage });
      const interruptAck = rebuiltGateway.acknowledgeCommand({
        authorization,
        commandId: interrupt.commandId,
        lineage,
      });
      const afterInterruptAck = rebuiltGateway.pollCommands({ authorization, lineage });
      const finalGateway = createDefaultWorkerControlGateway(coreDb);
      const afterSecondRebuild = finalGateway.pollCommands({ authorization, lineage });

      expect(interruptAck).toMatchObject({ commandId: interrupt.commandId, kind: 'interrupt' });
      expect.soft(afterInterruptAck.commands).toEqual([]);
      expect.soft(afterSecondRebuild.commands).toEqual([]);
    } finally {
      vi.useRealTimers();
      coreDb.sqlite.close();
    }
  });

  it('rejects oversized terminal result requests before schema handling', async () => {
    const { app, environmentPackage, gateway, lineage, token } = createWorkerControlRouteFixture();

    gateway.enqueueTerminalCommand(environmentPackage.snapshotId, {
      argv: ['diagnose'],
      commandId: 'term_route_oversized',
      cwd: '/workspace/repo',
    });

    const res = await app.request('/api/worker-control/terminal-results', {
      body: JSON.stringify({
        durationMs: 100,
        exitCode: 0,
        lineage,
        stderr: '',
        stdout: 'x'.repeat(1025 * 1024),
        terminalCommandId: 'term_route_oversized',
      }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(413);
    expect(body.code).toBe('worker_control_payload_too_large');
  });

  it('accepts canonical event append requests without a browser session cookie', async () => {
    const { app, environmentPackage, gateway, lineage, token } = createWorkerControlRouteFixture();

    const res = await app.request('/api/worker-control/events/append', {
      body: JSON.stringify({
        lineage,
        record: {
          event: {
            data: {
              delta: 'hello',
              itemId: 'candidate_item_1',
            },
            type: 'item.delta',
          },
          kind: 'event',
          lineage,
          schemaVersion: 1,
          sequence: 3,
        },
      }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const body = (await res.json()) as { accepted: boolean; nextExpectedSequence: number };

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      accepted: true,
      nextExpectedSequence: 4,
    });
    expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)?.events).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({ type: 'item.delta' }),
        sequence: 3,
      }),
    ]);
  });

  it('rejects oversized event append requests before schema handling', async () => {
    const { app, lineage, token } = createWorkerControlRouteFixture();

    const res = await app.request('/api/worker-control/events/append', {
      body: JSON.stringify({
        lineage,
        record: {
          event: {
            data: {
              delta: 'x'.repeat(260 * 1024),
              itemId: 'candidate_item_oversized',
            },
            type: 'item.delta',
          },
          kind: 'event',
          lineage,
          schemaVersion: 1,
          sequence: 13,
        },
      }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(413);
    expect(body.code).toBe('worker_control_payload_too_large');
  });

  it('projects event append sequence conflicts as worker-control API errors', async () => {
    const { app, lineage, token } = createWorkerControlRouteFixture();
    const record = {
      event: {
        data: {
          delta: 'hello',
          itemId: 'candidate_item_1',
        },
        type: 'item.delta',
      },
      kind: 'event',
      lineage,
      schemaVersion: 1,
      sequence: 3,
    };

    await app.request('/api/worker-control/events/append', {
      body: JSON.stringify({ lineage, record }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const res = await app.request('/api/worker-control/events/append', {
      body: JSON.stringify({
        lineage,
        record: {
          ...record,
          event: {
            data: {
              delta: 'different',
              itemId: 'candidate_item_1',
            },
            type: 'item.delta',
          },
        },
      }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe('worker_control_sequence_conflict');
  });

  it('rejects worker requests with invalid sandbox bearer tokens', async () => {
    const { app, lineage } = createWorkerControlRouteFixture();

    const res = await app.request('/api/worker-control/heartbeat', {
      body: JSON.stringify({
        lineage,
        sequence: 1,
        status: 'running',
      }),
      headers: {
        authorization: 'Bearer wrong',
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(401);
    expect(body.code).toBe('worker_control_unauthorized');
  });
});

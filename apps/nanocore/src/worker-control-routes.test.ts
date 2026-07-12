import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
} from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';
import { createApp, createDefaultWorkerControlGateway } from './app.js';
import type { FsStore } from './lib/store.js';
import { resolveAgentEnvironmentPackage } from './runtime/agent-environment.js';
import {
  WorkerControlGateway,
  type WorkerControlGatewayError,
  type WorkerControlLineage,
} from './runtime/worker-control-gateway.js';
import {
  listBackendWorkspaceHandles,
  recordWorkspaceMaterializationRecords,
} from './runtime/workspace-sync-records.js';
import {
  completeSchedulerSessionLease,
  createSchedulerAdmissionEntry,
  dispatchNextSchedulerEntry,
  resolveSchedulerLeaseTokenBinding,
  schedulerLeaseHasAppliedSupplyRefreshAck,
  upsertSchedulerCapacityRecord,
  upsertSchedulerTargetHealthRecord,
  upsertSchedulerWorkerPool,
} from './scheduler-records.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
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
        controlRelayUpstream: 'https://nanocore.local/api/worker-control',
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

describe('worker control routes', () => {
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
          controlRelayUpstream: 'https://nanocore.local/api/worker-control',
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

      const firstGateway = createDefaultWorkerControlGateway(coreDb);
      const firstRegistration = firstGateway.registerSession(environmentPackage);
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
      const secondRegistration = secondGateway.registerSession(environmentPackage);
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
          controlRelayUpstream: 'https://nanocore.local/api/worker-control',
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

      const gateway = createDefaultWorkerControlGateway(coreDb);
      const registration = gateway.registerSession(environmentPackage);
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
          controlRelayUpstream: 'https://nanocore.local/api/worker-control',
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

      const gateway = createDefaultWorkerControlGateway(coreDb);
      const registration = gateway.registerSession(environmentPackage);
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

  it('enforces durable scheduler binding refs through the default gateway factory', () => {
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
          controlRelayUpstream: 'https://nanocore.local/api/worker-control',
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
    const gateway = createDefaultWorkerControlGateway(coreDb);
    const registration = gateway.registerSession(environmentPackage, {
      sandboxBindingRef: 'lease-binding:lease_default_binding',
    });

    gateway.recordHeartbeat({
      authorization: `Bearer ${registration.token}`,
      lineage,
      sequence: 1,
      status: 'running',
    });
    completeSchedulerSessionLease(coreDb, {
      leaseId: 'lease_default_binding',
      releaseReason: 'completed',
      terminalStatus: 'released',
    });

    expect(() =>
      gateway.recordHeartbeat({
        authorization: `Bearer ${registration.token}`,
        lineage,
        sequence: 2,
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

  it('marks durable scheduler leases releasing when final status arrives', async () => {
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
          controlRelayUpstream: 'https://nanocore.local/api/worker-control',
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
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, LOCAL_USER_ID, lineage.workspaceId);
    applyScopedMigrations(workspaceDb);
    recordWorkspaceMaterializationRecords(workspaceDb, [
      {
        backendKind: 'openshell',
        base: { commit: 'abc123', contentDigest: null },
        createdAt: '2026-06-16T00:00:01.000Z',
        id: 'wmr_final_status',
        inputSnapshotId: 'wis_final_status',
        materializedRootRef: 'workspace://ws_demo/repo_default',
        policyDigest: 'sha256:policy',
        readinessEvidence: [{ kind: 'backend.ready', ref: 'version:0.0.63' }],
        sourceId: 'repo_default',
        strategy: 'git',
        workerSessionId: lineage.agentSessionId,
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
    });
    const gateway = createDefaultWorkerControlGateway(coreDb);
    const registration = gateway.registerSession(environmentPackage, {
      sandboxBindingRef: 'lease-binding:lease_final_status',
    });
    const app = createApp({ coreDb, mode: 'server', store, workerControlGateway: gateway });

    const res = await app.request('/api/worker-control/final-status', {
      body: JSON.stringify({
        schemaVersion: 1,
        lineage,
        operation: 'final_status',
        sequence: 7,
        body: {
          status: 'completed',
          stopReason: 'completed',
        },
      }),
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

    expect(res.status).toBe(200);
    expect(lease).toEqual({
      releaseReason: 'worker-final-status',
      status: 'releasing',
    });
    expect(listBackendWorkspaceHandles(workspaceDb, lineage.workspaceId)).toEqual([
      expect.objectContaining({
        cleanupStatus: 'retained',
        id: 'bwh_wmr_final_status',
        workerSessionId: lineage.agentSessionId,
      }),
    ]);
    expect(
      resolveSchedulerLeaseTokenBinding(coreDb, {
        sandboxBindingRef: 'lease-binding:lease_final_status',
        lineage,
      })
    ).toEqual({ status: 'rejected', reason: 'lease-not-live' });

    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
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
          controlRelayUpstream: 'https://nanocore.local/api/worker-control',
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
      const gateway = createDefaultWorkerControlGateway(coreDb);
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
          controlRelayUpstream: 'https://nanocore.local/api/worker-control',
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

      const gateway = createDefaultWorkerControlGateway(coreDb);
      const registration = gateway.registerSession(environmentPackage);
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
          controlRelayUpstream: 'https://nanocore.local/api/worker-control',
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

      const gateway = createDefaultWorkerControlGateway(coreDb);
      const registration = gateway.registerSession(environmentPackage);
      const approval = gateway.enqueueApprovalResult(environmentPackage.snapshotId, {
        approvalRequestId: 'approval_durable_1',
        decision: 'granted',
      });
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
        body: JSON.stringify({ commandId: approval.commandId, lineage }),
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
        .get(approval.commandId) as {
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
          controlRelayUpstream: 'https://nanocore.local/api/worker-control',
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

      const firstGateway = createDefaultWorkerControlGateway(coreDb);
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

      await firstApp.request('/api/worker-control/heartbeat', {
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

      const rebuiltGateway = createDefaultWorkerControlGateway(coreDb);
      const snapshot = rebuiltGateway.getSessionSnapshot(lineage.packageSnapshotId);
      const rebuiltApp = createApp({
        coreDb,
        mode: 'server',
        store,
        workerControlGateway: rebuiltGateway,
      });
      const poll = await rebuiltApp.request('/api/worker-control/commands/poll', {
        body: JSON.stringify({ lineage }),
        headers: {
          authorization: 'Bearer lease-binding:lease_rebuild',
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const body = (await poll.json()) as { commands: Array<{ commandId: string }> };

      expect(snapshot).toMatchObject({
        agentSessionId: 'session_rebuild',
        commands: [expect.objectContaining({ commandId: 'term_rebuild_1' })],
        events: [expect.objectContaining({ sequence: 3 })],
        heartbeat: expect.objectContaining({ status: 'running' }),
        packageSnapshotId: lineage.packageSnapshotId,
      });
      expect(poll.status).toBe(200);
      expect(body.commands).toEqual([expect.objectContaining({ commandId: 'term_rebuild_1' })]);
    } finally {
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

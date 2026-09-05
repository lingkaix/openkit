import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
  type MaterializedWorkspaceRoot,
} from '@openkit/config-schema';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultWorkerControlGateway } from './app.js';
import type { FsStore } from './lib/store.js';
import { recordAgentEnvironmentPackageSnapshot } from './runtime/aep-snapshot-ledger.js';
import { resolveAgentEnvironmentPackage } from './runtime/agent-environment.js';
import { runSchedulerLeaseMaintenanceOnce } from './runtime/scheduler-lease-maintenance-service.js';
import {
  markWorkerBackendWorkspaceHandoffComplete,
  recordWorkerBackendSessionMaterializing,
  transitionWorkerBackendSessionState,
} from './runtime/worker-backend-sessions.js';
import {
  hashWorkerRouteToken,
  WorkerControlGateway,
  type WorkerControlGatewayError,
  type WorkerControlLineage,
} from './runtime/worker-control-gateway.js';
import {
  createWorkerControlAcceptedRecordRecorder,
  listWorkerControlAcceptedEvents,
  resolveWorkerControlFinalStatusTokenBinding,
} from './runtime/worker-control-records.js';
import { listWorkerControlRejectedEvidenceForWorkspace } from './runtime/worker-control-rejected-evidence.js';
import { createWorkerControlSequenceRecorder } from './runtime/worker-control-sequences.js';
import { importWorkerTranscript } from './runtime/worker-transcript.js';
import {
  buildWorkspaceInputSnapshots,
  buildWorkspaceMaterializationRecords,
} from './runtime/workspace-materializer.js';
import { listWorkspaceReconciliationRecords } from './runtime/workspace-reconciliation-records.js';
import {
  listBackendWorkspaceHandles,
  recordWorkspaceInputSnapshots,
  recordWorkspaceMaterializationRecords,
  updateBackendWorkspaceHandleCleanupStatus,
} from './runtime/workspace-sync-records.js';
import {
  acceptSchedulerLeaseHeartbeat,
  bindSchedulerLeaseRouteTokenHashes,
  completeSchedulerLeaseForTerminalTurn,
  completeSchedulerSessionLease,
  createSchedulerAdmissionEntry,
  dispatchNextSchedulerEntry,
  markSchedulerSessionLeaseReleasing,
  requireSchedulerSessionLease,
  resolveSchedulerLeaseTokenBinding,
  schedulerLeaseHasAppliedSupplyRefreshAck,
  upsertSchedulerCapacityRecord,
  upsertSchedulerTargetHealthRecord,
  upsertSchedulerWorkerPool,
} from './scheduler-records.js';
import { type CoreDb, openCoreDb, openWorkspaceDb } from './storage/db.js';
import { coreDbPath, LOCAL_USER_ID } from './storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createTestAgentSetup } from './test-support/agent-environment.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';

/**
 * Creates an app with one registered worker control session.
 *
 * @param workspaceRoots Workspace inputs declared by the package fixture.
 * @returns App, gateway, token, package, and lineage fixtures.
 */
function createWorkerControlRouteFixture(workspaceRoots: MaterializedWorkspaceRoot[] = []): {
  app: ReturnType<typeof createApp>;
  environmentPackage: AgentEnvironmentPackage;
  gateway: WorkerControlGateway;
  lineage: WorkerControlLineage;
  store: FsStore;
  token: string;
} {
  const store = createDemoStore();
  const turn = store.createTurn('ws_demo', 'th_demo', 'Control worker over HTTP', {
    kind: 'user',
    id: 'user_local',
  });
  const environmentPackage = AgentEnvironmentPackageSchema.parse(
    resolveAgentEnvironmentPackage({
      agentSetup: createTestAgentSetup(),
      agentSessionId: 'as_control_route_1',
      triggerActor: { kind: 'user', id: LOCAL_USER_ID },
      backend: {
        kind: 'openshell',
      },
      createdAt: '2026-06-16T00:00:00.000Z',
      requestId: 'req_control_route_1',
      turn,
      workspaceCwd: '/workspace/repo',
      workspaceRoots,
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
    triggerActor: { kind: 'user', id: LOCAL_USER_ID },
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
  bindSchedulerLeaseRouteTokenHashes(coreDb, {
    leaseId: `lease_${suffix}`,
    sandboxBindingRef: binding,
    workerCapabilityTokenHash: hashWorkerRouteToken(workerRouteToken(binding, 'capability')),
    workerControlTokenHash: hashWorkerRouteToken(workerRouteToken(binding, 'worker-control')),
    workerInferenceTokenHash: hashWorkerRouteToken(workerRouteToken(binding, 'inference')),
  });
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, lineage.workspaceId);

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

/** Derives one deterministic 32-byte raw route token for a durable fixture. */
function workerRouteToken(
  sandboxBindingRef: string,
  family: 'capability' | 'worker-control' | 'inference'
): string {
  return createHash('sha256').update(`${family}:${sandboxBindingRef}`).digest('base64url');
}

/** Registers the exact raw token pair whose hashes are owned by a durable fixture lease. */
function registerDurableWorkerControlSession(
  gateway: WorkerControlGateway,
  environmentPackage: AgentEnvironmentPackage,
  sandboxBindingRef: string
) {
  return gateway.registerSession(environmentPackage, {
    sandboxBindingRef,
    workerCapabilityToken: workerRouteToken(sandboxBindingRef, 'capability'),
    workerControlToken: workerRouteToken(sandboxBindingRef, 'worker-control'),
    workerInferenceToken: workerRouteToken(sandboxBindingRef, 'inference'),
  });
}

/** Records the exact durable backend identity owned by one worker-control lease fixture. */
function recordWorkerControlBackendSession(
  coreDb: CoreDb,
  _environmentPackage: AgentEnvironmentPackage,
  lineage: WorkerControlLineage,
  sandboxBindingRef: string,
  backendSessionId: string
): string {
  return recordWorkerBackendSessionMaterializing(coreDb, {
    backendLineage: { imageRef: 'openkit/worker-codex:dev', kind: 'reference' },
    backendVersion: '0.0.99',
    identity: {
      agentSessionId: lineage.agentSessionId,
      backendKind: 'openshell',
      backendSessionId,
      deploymentId: 'deployment-worker-control-test',
      packageSnapshotId: lineage.packageSnapshotId,
      runtimeTargetId: 'runtime-target-test',
      stagingDirectoryRef: `server/runtime/worker-backend-sessions/${lineage.packageSnapshotId}`,
      transientProviderInstanceId: null,
    },
    lineage: {
      threadId: lineage.threadId,
      turnId: lineage.turnId,
      workspaceId: lineage.workspaceId,
    },
    sandboxBindingRef,
  }).leaseId;
}

/** Advances one test backend identity through successful physical and durable cleanup. */
function markWorkerControlBackendSessionCleaned(coreDb: CoreDb, leaseId: string): void {
  const transitions = [
    ['materializing', 'cleanup-pending'],
    ['cleanup-pending', 'physical-cleaned'],
    ['physical-cleaned', 'cleaned'],
  ] as const;

  for (const [fromState, toState] of transitions) {
    transitionWorkerBackendSessionState(coreDb, { fromState, leaseId, toState });
  }
}

/** Builds the only worker heartbeat request shape accepted by the HTTP route. */
function heartbeatEnvelope(
  lineage: WorkerControlLineage,
  sequence: number,
  status: 'starting' | 'running' | 'stopping',
  message: string | null = null,
  processKeyHash?: string
) {
  return {
    body: { message, ...(processKeyHash ? { processKeyHash } : {}), status },
    lineage,
    operation: 'heartbeat' as const,
    schemaVersion: 1 as const,
    sequence,
  };
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
      'POST /api/worker-control/events/append',
      'POST /api/worker-control/final-status',
      'POST /api/worker-control/supply-refresh-ack',
      'POST /api/worker-control/capability-summary',
      'ALL /api/worker-inference/*',
      'POST /api/worker-inference/v1/chat/completions',
      'POST /api/worker-inference/v1/responses',
      'ALL /api/worker-capabilities/*',
      'POST /api/worker-capabilities/mcp/_list-servers',
      'POST /api/worker-capabilities/mcp/:serverId',
      'ALL /api/*',
      'ALL /api/*',
    ]);
  });

  it.each([
    [
      'original process key',
      createHash('sha256').update('route-process-key').digest('base64url'),
      true,
    ],
    [
      'different process key',
      createHash('sha256').update('wrong-route-process-key').digest('base64url'),
      false,
    ],
  ] as const)('accepts restart heartbeat only for the %s', async (_case, reconnectKey, accepted) => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-reconnect-route-')));
    const fixture = createWorkerControlRouteFixture();
    const originalKey = createHash('sha256').update('route-process-key').digest('base64url');
    const processKeyHash = createHash('sha256')
      .update(Buffer.from(originalKey, 'base64url'))
      .digest('base64url');

    try {
      applyMigrations(coreDb);
      const binding = createDurableWorkerControlLease(
        coreDb,
        fixture.environmentPackage,
        fixture.lineage,
        'process_key_reconnect'
      );
      const leaseId = recordWorkerControlBackendSession(
        coreDb,
        fixture.environmentPackage,
        fixture.lineage,
        binding,
        'sandbox-process-key-reconnect'
      );
      transitionWorkerBackendSessionState(coreDb, {
        fromState: 'materializing',
        leaseId,
        toState: 'materialized',
      });
      transitionWorkerBackendSessionState(coreDb, {
        fromState: 'materialized',
        leaseId,
        toState: 'launching',
      });
      markWorkerBackendWorkspaceHandoffComplete(coreDb, { leaseId });
      const firstGateway = createDefaultWorkerControlGateway(coreDb);
      registerDurableWorkerControlSession(firstGateway, fixture.environmentPackage, binding);
      const firstApp = createApp({
        coreDb,
        mode: 'server',
        store: fixture.store,
        workerControlGateway: firstGateway,
      });
      const firstHeartbeat = await firstApp.request('/api/worker-control/heartbeat', {
        body: JSON.stringify(
          heartbeatEnvelope(fixture.lineage, 0, 'starting', null, processKeyHash)
        ),
        headers: {
          authorization: `Bearer ${workerRouteToken(binding, 'worker-control')}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      expect(firstHeartbeat.status).toBe(200);
      coreDb.sqlite
        .prepare(
          `UPDATE scheduler_session_leases
           SET recovery_state = 'awaiting-reconnect',
               recovery_deadline = '2099-01-01T00:00:00.000Z',
               scheduler_epoch = 2
           WHERE lease_id = 'lease_process_key_reconnect'`
        )
        .run();

      const restartedGateway = createDefaultWorkerControlGateway(coreDb);
      registerDurableWorkerControlSession(restartedGateway, fixture.environmentPackage, binding);
      const restartedApp = createApp({
        coreDb,
        mode: 'server',
        store: fixture.store,
        workerControlGateway: restartedGateway,
      });
      const reconnect = await restartedApp.request('/api/worker-control/heartbeat', {
        body: JSON.stringify({
          ...heartbeatEnvelope(fixture.lineage, 1, 'running', 'Worker survived NanoCore restart.'),
          reconnectKey,
        }),
        headers: {
          authorization: `Bearer ${workerRouteToken(binding, 'worker-control')}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const lease = requireSchedulerSessionLease(coreDb, 'lease_process_key_reconnect');
      const durableWorkerControl = JSON.stringify(
        coreDb.sqlite
          .prepare(
            `SELECT record_json FROM worker_control_records
             UNION ALL
             SELECT fingerprint AS record_json FROM worker_control_sequence_fingerprints`
          )
          .all()
      );

      expect(reconnect.status === 200).toBe(accepted);
      expect(lease).toMatchObject(
        accepted
          ? { lastWorkerSequence: 1, recoveryDeadline: null, recoveryState: null }
          : {
              lastWorkerSequence: 0,
              recoveryDeadline: '2099-01-01T00:00:00.000Z',
              recoveryState: 'awaiting-reconnect',
            }
      );
      expect(await reconnect.text()).not.toContain(reconnectKey);
      expect(durableWorkerControl).not.toContain(reconnectKey);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('keeps event append sequence conflicts durable across default gateway instances', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-control-sequence-')));
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Durable sequence thread');
    const turn = store.createTurn('ws_demo', thread.id, 'Control worker', {
      kind: 'user',
      id: 'user_local',
    });
    const environmentPackage = AgentEnvironmentPackageSchema.parse(
      resolveAgentEnvironmentPackage({
        agentSetup: createTestAgentSetup(),
        agentSessionId: 'session_durable_sequence',
        triggerActor: { kind: 'user', id: 'user_local' },
        backend: {
          kind: 'openshell',
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
      const firstRegistration = registerDurableWorkerControlSession(
        firstGateway,
        environmentPackage,
        binding
      );
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
      const secondRegistration = registerDurableWorkerControlSession(
        secondGateway,
        environmentPackage,
        binding
      );
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
    const turn = store.createTurn('ws_demo', thread.id, 'Control worker', {
      kind: 'user',
      id: 'user_local',
    });
    const environmentPackage = AgentEnvironmentPackageSchema.parse(
      resolveAgentEnvironmentPackage({
        agentSetup: createTestAgentSetup(),
        agentSessionId: 'session_durable_records',
        triggerActor: { kind: 'user', id: 'user_local' },
        backend: {
          kind: 'openshell',
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
      const registration = registerDurableWorkerControlSession(
        gateway,
        environmentPackage,
        binding
      );
      const app = createApp({
        coreDb,
        mode: 'server',
        store,
        workerControlGateway: gateway,
      });
      const heartbeat = await app.request('/api/worker-control/heartbeat', {
        body: JSON.stringify(heartbeatEnvelope(lineage, 1, 'running', 'Worker is alive.')),
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

  it('never persists worker bearer tokens in sequenced control state', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-control-token-redaction-'));
    const coreDb = openCoreDb(dataRoot);
    const { environmentPackage, lineage, store } = createWorkerControlRouteFixture();
    const token = 'okw_sequence_fingerprint_secret';

    try {
      applyMigrations(coreDb);
      const gateway = new WorkerControlGateway({
        acceptedRecordRecorder: createWorkerControlAcceptedRecordRecorder(coreDb),
        createToken: () => token,
        now: () => '2026-07-15T00:00:00.000Z',
        sequenceRecorder: createWorkerControlSequenceRecorder(coreDb),
      });
      gateway.registerSession(environmentPackage);
      const app = createApp({ coreDb, mode: 'server', store, workerControlGateway: gateway });
      const requests = [
        {
          accepted: heartbeatEnvelope(lineage, 1, 'running', 'alive'),
          conflict: heartbeatEnvelope(lineage, 1, 'running', 'changed'),
          operation: 'heartbeat',
          route: '/api/worker-control/heartbeat',
        },
        {
          accepted: {
            artifact: { path: 'reports/result.md', title: 'Result' },
            lineage,
            sequence: 2,
          },
          conflict: {
            artifact: { path: 'reports/result.md', title: 'Changed result' },
            lineage,
            sequence: 2,
          },
          operation: 'artifact_notice',
          route: '/api/worker-control/artifacts',
        },
        {
          accepted: {
            body: { message: 'refreshed', refreshId: 'refresh_token_redaction', status: 'applied' },
            lineage,
            operation: 'supply_refresh_ack',
            schemaVersion: 1,
            sequence: 3,
          },
          conflict: {
            body: { message: 'changed', refreshId: 'refresh_token_redaction', status: 'applied' },
            lineage,
            operation: 'supply_refresh_ack',
            schemaVersion: 1,
            sequence: 3,
          },
          operation: 'supply_refresh_ack',
          route: '/api/worker-control/supply-refresh-ack',
        },
      ] as const;

      for (const request of requests) {
        const send = (body: unknown) =>
          app.request(request.route, {
            body: JSON.stringify(body),
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
            },
            method: 'POST',
          });
        const accepted = await send(request.accepted);
        const replay = await send(request.accepted);
        const conflict = await send(request.conflict);

        expect.soft(accepted.status, request.operation).toBe(200);
        expect.soft(replay.status, request.operation).toBe(200);
        expect.soft(conflict.status, request.operation).toBe(409);
        expect.soft(await conflict.json(), request.operation).toMatchObject({
          code: 'worker_control_sequence_conflict',
        });
      }

      const fingerprints = coreDb.sqlite
        .prepare(
          `SELECT operation, fingerprint
             FROM worker_control_sequence_fingerprints
            ORDER BY operation`
        )
        .all() as Array<{ fingerprint: string; operation: string }>;
      const records = coreDb.sqlite
        .prepare(
          `SELECT operation, record_json AS recordJson
             FROM worker_control_records
            ORDER BY operation`
        )
        .all() as Array<{ operation: string; recordJson: string }>;

      expect(fingerprints.map(({ operation }) => operation)).toEqual(
        requests.map(({ operation }) => operation).sort()
      );
      expect(records.map(({ operation }) => operation)).toEqual(
        requests.map(({ operation }) => operation).sort()
      );
      expect(JSON.stringify(fingerprints)).not.toContain(token);
      expect(JSON.stringify(records)).not.toContain(token);
      coreDb.sqlite.close();
      expect(readFileSync(coreDbPath(dataRoot)).includes(token)).toBe(false);
    } finally {
      if (coreDb.sqlite.open) {
        coreDb.sqlite.close();
      }
    }
  });

  it('records rejected worker-control evidence through the default gateway', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-control-rejected-')));
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Rejected control records thread');
    const turn = store.createTurn('ws_demo', thread.id, 'Control worker', {
      kind: 'user',
      id: 'user_local',
    });
    const environmentPackage = AgentEnvironmentPackageSchema.parse(
      resolveAgentEnvironmentPackage({
        agentSetup: createTestAgentSetup(),
        agentSessionId: 'session_rejected_records',
        triggerActor: { kind: 'user', id: 'user_local' },
        backend: {
          kind: 'openshell',
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
      const registration = registerDurableWorkerControlSession(
        gateway,
        environmentPackage,
        binding
      );
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
    const turn = store.createTurn('ws_demo', thread.id, 'Control worker', {
      kind: 'user',
      id: 'user_local',
    });
    const environmentPackage = AgentEnvironmentPackageSchema.parse(
      resolveAgentEnvironmentPackage({
        agentSetup: createTestAgentSetup(),
        agentSessionId: 'session_default_binding',
        triggerActor: { kind: 'user', id: 'user_local' },
        backend: {
          kind: 'openshell',
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
      triggerActor: { kind: 'user', id: 'user_local' },
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
    bindSchedulerLeaseRouteTokenHashes(coreDb, {
      leaseId: 'lease_default_binding',
      sandboxBindingRef: 'lease-binding:lease_default_binding',
      workerCapabilityTokenHash: hashWorkerRouteToken(
        workerRouteToken('lease-binding:lease_default_binding', 'capability')
      ),
      workerControlTokenHash: hashWorkerRouteToken(
        workerRouteToken('lease-binding:lease_default_binding', 'worker-control')
      ),
      workerInferenceTokenHash: hashWorkerRouteToken(
        workerRouteToken('lease-binding:lease_default_binding', 'inference')
      ),
    });
    const backendLeaseId = recordWorkerControlBackendSession(
      coreDb,
      environmentPackage,
      lineage,
      'lease-binding:lease_default_binding',
      'sandbox_default_binding'
    );
    const registration = registerDurableWorkerControlSession(
      gateway,
      environmentPackage,
      'lease-binding:lease_default_binding'
    );
    const app = createApp({ coreDb, mode: 'server', store, workerControlGateway: gateway });

    gateway.recordHeartbeat({
      authorization: `Bearer ${registration.token}`,
      ...heartbeatEnvelope(lineage, 1, 'running'),
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
      body: JSON.stringify(heartbeatEnvelope(lineage, 2, 'running')),
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
      body: JSON.stringify(heartbeatEnvelope(lineage, 2, 'running')),
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
      body: JSON.stringify(heartbeatEnvelope(lineage, 2, 'running')),
      headers: {
        authorization: `Bearer ${registration.token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const staleBody = (await staleResponse.json()) as { code: string };

    expect(staleResponse.status).toBe(403);
    expect(staleBody.code).toBe('worker_control_lease_not_live');
    markWorkerControlBackendSessionCleaned(coreDb, backendLeaseId);
    completeSchedulerSessionLease(coreDb, {
      leaseId: 'lease_default_binding',
      releaseReason: 'completed',
      terminalStatus: 'released',
    });

    expect(() =>
      gateway.recordHeartbeat({
        authorization: `Bearer ${registration.token}`,
        ...heartbeatEnvelope(lineage, 3, 'running'),
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
      const registration = registerDurableWorkerControlSession(
        gateway,
        environmentPackage,
        'lease-binding:missing_lease'
      );
      const app = createApp({ coreDb, mode: 'server', store, workerControlGateway: gateway });
      const response = await app.request('/api/worker-control/heartbeat', {
        body: JSON.stringify(heartbeatEnvelope(lineage, 1, 'running')),
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
      body: JSON.stringify(heartbeatEnvelope(lineage, 1, 'running')),
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

  it('records final status as the exact canonical terminal event', async () => {
    const { app, environmentPackage, gateway, lineage, token } = createWorkerControlRouteFixture();
    const response = await app.request('/api/worker-control/final-status', {
      body: JSON.stringify({
        body: {
          diagnostics: { stderr: 'Product-safe failure summary.' },
          evidenceManifestDigests: { runtime: 'sha256:runtime' },
          status: 'failed',
          stopReason: 'worker-runtime-failed',
        },
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

    expect(response.status, await response.clone().text()).toBe(200);
    expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)?.events).toEqual([
      {
        event: {
          data: {
            diagnostics: { stderr: 'Product-safe failure summary.' },
            evidenceManifestDigests: { runtime: 'sha256:runtime' },
            status: 'failed',
            stopReason: 'worker-runtime-failed',
          },
          type: 'turn.failed',
        },
        kind: 'event',
        lineage,
        schemaVersion: 1,
        sequence: 7,
      },
    ]);
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
          event: {
            data: {
              evidenceManifestDigests: {},
              status: eventType === 'turn.completed' ? 'completed' : 'failed',
              stopReason: eventType === 'turn.completed' ? 'completed' : 'failed',
            },
            type: eventType,
          },
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
    const turn = store.createTurn('ws_demo', thread.id, 'Complete worker', {
      kind: 'user',
      id: 'user_local',
    });
    const environmentPackage = AgentEnvironmentPackageSchema.parse(
      resolveAgentEnvironmentPackage({
        agentSetup: createTestAgentSetup(),
        agentSessionId: 'session_final_status',
        triggerActor: { kind: 'user', id: 'user_local' },
        backend: {
          kind: 'openshell',
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
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, lineage.workspaceId);
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
      triggerActor: { kind: 'user', id: 'user_local' },
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
    bindSchedulerLeaseRouteTokenHashes(coreDb, {
      leaseId: 'lease_final_status',
      now: () => '2099-07-05T00:00:03.000Z',
      sandboxBindingRef: 'lease-binding:lease_final_status',
      workerCapabilityTokenHash: hashWorkerRouteToken(
        workerRouteToken('lease-binding:lease_final_status', 'capability')
      ),
      workerControlTokenHash: hashWorkerRouteToken(
        workerRouteToken('lease-binding:lease_final_status', 'worker-control')
      ),
      workerInferenceTokenHash: hashWorkerRouteToken(
        workerRouteToken('lease-binding:lease_final_status', 'inference')
      ),
    });
    const backendLeaseId = recordWorkerControlBackendSession(
      coreDb,
      environmentPackage,
      lineage,
      'lease-binding:lease_final_status',
      'sandbox_final_status'
    );
    acceptSchedulerLeaseHeartbeat(coreDb, {
      heartbeatTimeoutMs: 30_000,
      leaseId: 'lease_final_status',
      now: () => '2099-07-05T00:00:10.000Z',
      workerSequence: 1,
    });
    const registration = registerDurableWorkerControlSession(
      gateway,
      environmentPackage,
      'lease-binding:lease_final_status'
    );
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
    const acceptedEvents = listWorkerControlAcceptedEvents(coreDb, lineage);
    const transcriptImport = importWorkerTranscript(
      store,
      environmentPackage,
      { eventsJsonl: `${JSON.stringify(acceptedEvents[0])}\n` },
      { acceptedLiveEvents: acceptedEvents }
    );

    expect(accepted.status).toBe(200);
    expect.soft(acceptedEvents).toEqual([
      {
        event: {
          data: {
            evidenceManifestDigests: {},
            status: 'completed',
            stopReason: 'completed',
          },
          type: 'turn.completed',
        },
        kind: 'event',
        lineage,
        schemaVersion: 1,
        sequence: 7,
      },
    ]);
    expect.soft(transcriptImport).toMatchObject({
      dedupedEventSequences: [7],
      diagnostics: [],
      rejectedEventSequences: [],
    });
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
    markWorkerControlBackendSessionCleaned(coreDb, backendLeaseId);
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

  it('resolves a live final-status binding inside its Core transaction', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-final-status-live-race-')));
    const { environmentPackage, lineage, store } = createWorkerControlRouteFixture();

    try {
      applyMigrations(coreDb);
      const binding = createDurableWorkerControlLease(
        coreDb,
        environmentPackage,
        lineage,
        'final_status_live_race'
      );
      const gateway = new WorkerControlGateway({
        acceptedRecordRecorder: createWorkerControlAcceptedRecordRecorder(coreDb),
        resolveFinalStatusTokenBinding: (input) =>
          resolveWorkerControlFinalStatusTokenBinding(coreDb, input),
        runFinalStatusTransaction: (operation) => {
          coreDb.sqlite
            .prepare(
              'UPDATE scheduler_session_leases SET sandbox_binding_ref = ? WHERE lease_id = ?'
            )
            .run('revoked-binding', 'lease_final_status_live_race');
          return coreDb.sqlite.transaction(operation)();
        },
        sequenceRecorder: createWorkerControlSequenceRecorder(coreDb),
      });
      registerDurableWorkerControlSession(gateway, environmentPackage, binding);
      const app = createApp({ coreDb, mode: 'server', store, workerControlGateway: gateway });
      const response = await app.request('/api/worker-control/final-status', {
        body: JSON.stringify({
          body: { status: 'completed', stopReason: 'completed' },
          lineage,
          operation: 'final_status',
          schemaVersion: 1,
          sequence: 7,
        }),
        headers: {
          authorization: `Bearer ${workerRouteToken(binding, 'worker-control')}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const acceptedRecordCount = coreDb.sqlite
        .prepare(
          `SELECT COUNT(*) AS count
             FROM worker_control_records
            WHERE turn_id = ? AND operation IN ('event_append', 'final_status')`
        )
        .get(lineage.turnId) as { count: number };
      const fingerprintCount = coreDb.sqlite
        .prepare(
          `SELECT COUNT(*) AS count
             FROM worker_control_sequence_fingerprints
            WHERE turn_id = ? AND operation IN ('event_append', 'final_status')`
        )
        .get(lineage.turnId) as { count: number };

      expect(response.status).toBe(401);
      expect.soft(acceptedRecordCount.count).toBe(0);
      expect.soft(fingerprintCount.count).toBe(0);
      expect(requireSchedulerSessionLease(coreDb, 'lease_final_status_live_race')).toMatchObject({
        releaseReason: null,
        sandboxBindingRef: 'revoked-binding',
        status: 'acquired',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects exact final-status replay when release grace expires at transaction entry', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-final-status-replay-race-')));
    const { environmentPackage, lineage, store } = createWorkerControlRouteFixture();
    let transactionCount = 0;

    try {
      applyMigrations(coreDb);
      const binding = createDurableWorkerControlLease(
        coreDb,
        environmentPackage,
        lineage,
        'final_status_replay_race'
      );
      const backendLeaseId = recordWorkerControlBackendSession(
        coreDb,
        environmentPackage,
        lineage,
        binding,
        'sandbox_final_status_replay_race'
      );
      const gateway = new WorkerControlGateway({
        acceptedRecordRecorder: createWorkerControlAcceptedRecordRecorder(coreDb),
        onFinalStatusAccepted: (input) => {
          const resolution = resolveSchedulerLeaseTokenBinding(coreDb, input);

          if (resolution.status !== 'accepted') {
            throw new Error('Expected a live lease during initial final-status acceptance.');
          }

          markSchedulerSessionLeaseReleasing(coreDb, {
            leaseId: resolution.lease.leaseId,
            releaseReason: 'worker-final-status',
          });
        },
        resolveFinalStatusTokenBinding: (input) =>
          resolveWorkerControlFinalStatusTokenBinding(coreDb, input),
        runFinalStatusTransaction: (operation) => {
          transactionCount += 1;
          if (transactionCount === 2) {
            coreDb.sqlite
              .prepare('UPDATE scheduler_session_leases SET expires_at = ? WHERE lease_id = ?')
              .run('2000-01-01T00:00:00.000Z', 'lease_final_status_replay_race');
            markWorkerControlBackendSessionCleaned(coreDb, backendLeaseId);
            completeSchedulerSessionLease(coreDb, {
              leaseId: 'lease_final_status_replay_race',
              recoveryState: 'needs-evidence',
              releaseReason: 'release-grace-timeout',
              terminalStatus: 'lost',
            });
          }
          return coreDb.sqlite.transaction(operation)();
        },
        sequenceRecorder: createWorkerControlSequenceRecorder(coreDb),
      });
      registerDurableWorkerControlSession(gateway, environmentPackage, binding);
      const app = createApp({ coreDb, mode: 'server', store, workerControlGateway: gateway });
      const request = {
        body: JSON.stringify({
          body: { status: 'completed', stopReason: 'completed' },
          lineage,
          operation: 'final_status',
          schemaVersion: 1,
          sequence: 7,
        }),
        headers: {
          authorization: `Bearer ${workerRouteToken(binding, 'worker-control')}`,
          'content-type': 'application/json',
        },
        method: 'POST' as const,
      };
      const accepted = await app.request('/api/worker-control/final-status', request);
      const replay = await app.request('/api/worker-control/final-status', request);
      const acceptedRecordCount = coreDb.sqlite
        .prepare(
          `SELECT COUNT(*) AS count
             FROM worker_control_records
            WHERE turn_id = ? AND operation IN ('event_append', 'final_status')`
        )
        .get(lineage.turnId) as { count: number };
      const fingerprintCount = coreDb.sqlite
        .prepare(
          `SELECT COUNT(*) AS count
             FROM worker_control_sequence_fingerprints
            WHERE turn_id = ? AND operation IN ('event_append', 'final_status')`
        )
        .get(lineage.turnId) as { count: number };

      expect(accepted.status).toBe(200);
      expect(replay.status).toBe(403);
      expect.soft(acceptedRecordCount.count).toBe(2);
      expect.soft(fingerprintCount.count).toBe(2);
      expect(requireSchedulerSessionLease(coreDb, 'lease_final_status_replay_race')).toMatchObject({
        expiresAt: '2000-01-01T00:00:00.000Z',
        recoveryState: 'needs-evidence',
        releaseReason: 'release-grace-timeout',
        status: 'lost',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('retains the backend handle in the canonical Workspace across final-status replay', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-final-status-workspace-')));
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-final-status-workspace-repo-'));

    execFileSync('git', ['init'], { cwd: repositoryPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'openkit@example.invalid'], {
      cwd: repositoryPath,
    });
    execFileSync('git', ['config', 'user.name', 'OpenKit'], { cwd: repositoryPath });
    writeFileSync(join(repositoryPath, 'README.md'), '# Workspace\n', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repositoryPath });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repositoryPath, stdio: 'ignore' });
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryPath,
      encoding: 'utf8',
    }).trim();
    const { environmentPackage, lineage, store } = createWorkerControlRouteFixture([
      {
        access: 'read-write',
        id: 'repo_default',
        sourceCommit,
        sourceKind: 'host-dir',
        sourcePath: repositoryPath,
        workerPath: '/workspace/repo',
      },
    ]);
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, lineage.workspaceId);

    try {
      applyMigrations(coreDb);
      const binding = createDurableWorkerControlLease(
        coreDb,
        environmentPackage,
        lineage,
        'final_status_workspace'
      );
      const backendLeaseId = recordWorkerControlBackendSession(
        coreDb,
        environmentPackage,
        lineage,
        binding,
        'sandbox_final_status_workspace'
      );
      applyScopedMigrations(workspaceDb);
      const inputSnapshots = buildWorkspaceInputSnapshots({
        backendCapabilities: environmentPackage.backend.requiredCapabilities,
        backendKind: 'openshell',
        createdAt: '2026-06-16T00:00:01.000Z',
        environmentPackage,
      });
      const materializations = buildWorkspaceMaterializationRecords({
        createdAt: '2026-06-16T00:00:01.000Z',
        inputSnapshots,
        materialization: {
          backendKind: 'openshell',
          backendStatus: { health: 'ready', version: '0.0.80' },
          packageSnapshotId: environmentPackage.snapshotId,
          requiredCapabilities: environmentPackage.backend.requiredCapabilities,
          sandbox: { name: 'sandbox_final_status_workspace', state: 'created' },
          workspaceInputs: environmentPackage.workspace.inputs.map((input) => ({
            id: input.id,
            target: input.target,
          })),
        },
      });
      recordWorkspaceInputSnapshots(workspaceDb, inputSnapshots);
      recordWorkspaceMaterializationRecords(workspaceDb, materializations);
      const gateway = createDefaultWorkerControlGateway(coreDb);
      const app = createApp({ coreDb, mode: 'server', store, workerControlGateway: gateway });
      const request = {
        body: JSON.stringify({
          body: { status: 'completed', stopReason: 'completed' },
          lineage,
          operation: 'final_status',
          schemaVersion: 1,
          sequence: 7,
        }),
        headers: {
          authorization: `Bearer ${workerRouteToken(binding, 'worker-control')}`,
          'content-type': 'application/json',
        },
        method: 'POST' as const,
      };
      const response = await app.request('/api/worker-control/final-status', request);

      expect(response.status).toBe(200);
      expect(listBackendWorkspaceHandles(workspaceDb, lineage.workspaceId)).toEqual([
        expect.objectContaining({ cleanupStatus: 'retained' }),
      ]);

      updateBackendWorkspaceHandleCleanupStatus(
        workspaceDb,
        lineage.workspaceId,
        lineage.packageSnapshotId,
        'pending',
        '2026-06-16T00:00:02.000Z'
      );
      const restartedGateway = createDefaultWorkerControlGateway(coreDb);
      const restartedApp = createApp({
        coreDb,
        mode: 'server',
        store,
        workerControlGateway: restartedGateway,
      });
      const replay = await restartedApp.request('/api/worker-control/final-status', request);

      expect(replay.status).toBe(200);
      expect(listBackendWorkspaceHandles(workspaceDb, lineage.workspaceId)).toEqual([
        expect.objectContaining({ cleanupStatus: 'retained' }),
      ]);

      markWorkerControlBackendSessionCleaned(coreDb, backendLeaseId);
      const releasingLease = requireSchedulerSessionLease(coreDb, 'lease_final_status_workspace');
      completeSchedulerSessionLease(coreDb, {
        leaseId: releasingLease.leaseId,
        recoveryState: 'needs-evidence',
        releaseReason: 'release-grace-timeout',
        terminalStatus: 'lost',
      });
      runSchedulerLeaseMaintenanceOnce(coreDb, {
        maxTotalLeaseMs: 7_200_000,
        now: () => new Date(Date.parse(releasingLease.expiresAt) + 1).toISOString(),
        onError: (error) => {
          throw error;
        },
        renewalDurationMs: 1_800_000,
        renewalLeadMs: 300_000,
      });

      expect(listWorkspaceReconciliationRecords(workspaceDb, lineage.workspaceId)).toEqual([
        expect.objectContaining({
          backendHandleSummary: expect.objectContaining({ cleanupStatus: 'retained' }),
          backendReachability: expect.objectContaining({ detail: 'release-grace-timeout' }),
          stateBefore: 'lease-releasing',
          triggerReason: 'backend_takeover',
        }),
      ]);
      expect(requireSchedulerSessionLease(coreDb, 'lease_final_status_workspace')).toMatchObject({
        recoveryState: 'recovery-projected',
        releaseReason: 'release-grace-timeout',
        status: 'lost',
      });
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT in_use_count AS inUseCount FROM scheduler_capacity_records WHERE target_id = ?'
          )
          .get('target_final_status_workspace')
      ).toEqual({ inUseCount: 0 });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
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
      const authorization = `Bearer ${workerRouteToken(binding, 'worker-control')}`;
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
              data: {
                evidenceManifestDigests: {},
                status: 'completed',
                stopReason: 'completed',
              },
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
    const turn = store.createTurn('ws_demo', thread.id, 'Control worker', {
      kind: 'user',
      id: 'user_local',
    });
    const environmentPackage = AgentEnvironmentPackageSchema.parse(
      resolveAgentEnvironmentPackage({
        agentSetup: createTestAgentSetup(),
        agentSessionId: 'session_supply_refresh',
        triggerActor: { kind: 'user', id: 'user_local' },
        backend: {
          kind: 'openshell',
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
        triggerActor: { kind: 'user', id: 'user_local' },
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
      bindSchedulerLeaseRouteTokenHashes(coreDb, {
        leaseId: 'lease_supply_refresh',
        sandboxBindingRef: 'lease-binding:lease_supply_refresh',
        workerCapabilityTokenHash: hashWorkerRouteToken(
          workerRouteToken('lease-binding:lease_supply_refresh', 'capability')
        ),
        workerControlTokenHash: hashWorkerRouteToken(
          workerRouteToken('lease-binding:lease_supply_refresh', 'worker-control')
        ),
        workerInferenceTokenHash: hashWorkerRouteToken(
          workerRouteToken('lease-binding:lease_supply_refresh', 'inference')
        ),
      });
      const registration = registerDurableWorkerControlSession(
        gateway,
        environmentPackage,
        'lease-binding:lease_supply_refresh'
      );
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

  it('rejects oversized simple control requests before sandbox authentication', async () => {
    const { app, lineage } = createWorkerControlRouteFixture();
    const padding = 'x'.repeat(70 * 1024);
    const requests = [
      {
        body: heartbeatEnvelope(lineage, 1, 'running', padding),
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
      body: JSON.stringify(heartbeatEnvelope(lineage, 1, 'running', 'Worker is alive.')),
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

    const interrupt = gateway.enqueueInterrupt(environmentPackage.snapshotId, 'Stop now');

    const res = await app.request('/api/worker-control/commands/poll', {
      body: JSON.stringify({ lineage }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const body = (await res.json()) as {
      commands: Array<{ commandId: string; kind: string }>;
    };

    expect(res.status).toBe(200);
    expect(body.commands).toEqual([
      expect.objectContaining({
        commandId: interrupt.commandId,
        kind: 'interrupt',
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

  it('persists interrupt command acknowledgements through the default gateway', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-control-command-ack-')));
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Durable command ack thread');
    const turn = store.createTurn('ws_demo', thread.id, 'Control worker', {
      kind: 'user',
      id: 'user_local',
    });
    const environmentPackage = AgentEnvironmentPackageSchema.parse(
      resolveAgentEnvironmentPackage({
        agentSetup: createTestAgentSetup(),
        agentSessionId: 'session_durable_command_ack',
        triggerActor: { kind: 'user', id: 'user_local' },
        backend: {
          kind: 'openshell',
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
      const registration = registerDurableWorkerControlSession(
        gateway,
        environmentPackage,
        binding
      );
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
    const turn = store.createTurn('ws_demo', thread.id, 'Control worker', {
      kind: 'user',
      id: 'user_local',
    });
    const environmentPackage = AgentEnvironmentPackageSchema.parse(
      resolveAgentEnvironmentPackage({
        agentSetup: createTestAgentSetup(),
        agentSessionId: 'session_rebuild',
        triggerActor: { kind: 'user', id: 'user_local' },
        backend: {
          kind: 'openshell',
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
        triggerActor: { kind: 'user', id: 'user_local' },
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
      bindSchedulerLeaseRouteTokenHashes(coreDb, {
        leaseId: 'lease_rebuild',
        sandboxBindingRef: 'lease-binding:lease_rebuild',
        workerCapabilityTokenHash: hashWorkerRouteToken(
          workerRouteToken('lease-binding:lease_rebuild', 'capability')
        ),
        workerControlTokenHash: hashWorkerRouteToken(
          workerRouteToken('lease-binding:lease_rebuild', 'worker-control')
        ),
        workerInferenceTokenHash: hashWorkerRouteToken(
          workerRouteToken('lease-binding:lease_rebuild', 'inference')
        ),
      });

      const firstRegistration = registerDurableWorkerControlSession(
        firstGateway,
        environmentPackage,
        'lease-binding:lease_rebuild'
      );
      const firstApp = createApp({
        coreDb,
        mode: 'server',
        store,
        workerControlGateway: firstGateway,
      });

      const firstHeartbeatResponse = await firstApp.request('/api/worker-control/heartbeat', {
        body: JSON.stringify(heartbeatEnvelope(lineage, 1, 'running', 'Worker is alive.')),
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

      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, lineage.workspaceId);
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
      const authorization = `Bearer ${workerRouteToken(
        'lease-binding:lease_rebuild',
        'worker-control'
      )}`;
      const retryHeartbeat = rebuiltGateway.recordHeartbeat({
        authorization,
        ...heartbeatEnvelope(lineage, 1, 'running', 'Worker is alive.'),
      });
      const snapshot = rebuiltGateway.getSessionSnapshot(lineage.packageSnapshotId);
      const leaseAfterRetry = requireSchedulerSessionLease(coreDb, 'lease_rebuild');
      expect.soft(retryHeartbeat).toEqual(firstHeartbeatBody.heartbeat);
      expect.soft(snapshot?.heartbeat).toEqual(firstHeartbeatBody.heartbeat);
      expect
        .soft(leaseAfterRetry.lastAcceptedHeartbeatAt)
        .toBe(firstHeartbeatBody.heartbeat.lastHeartbeatAt);
      expect(snapshot).toMatchObject({
        agentSessionId: 'session_rebuild',
        events: [expect.objectContaining({ sequence: 3 })],
        heartbeat: expect.objectContaining({ status: 'running' }),
        packageSnapshotId: lineage.packageSnapshotId,
      });
    } finally {
      vi.useRealTimers();
      coreDb.sqlite.close();
    }
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
      body: JSON.stringify(heartbeatEnvelope(lineage, 1, 'running')),
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

  it('authenticates only the worker-control token family', () => {
    const source = readFileSync(
      new URL('./runtime/worker-control-routes.ts', import.meta.url),
      'utf8'
    );

    expect(source).toContain('workerControlTokenHash');
    expect(source).toContain("tokenFamily: 'worker-control'");
    expect(source).not.toContain("tokenFamily: 'inference'");
  });
});

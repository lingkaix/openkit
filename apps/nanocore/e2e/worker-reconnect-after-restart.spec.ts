import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { seedDemoWorkspaceDataRoot } from '../../../tests/support/demo-data.mjs';
import { FsStore } from '../dist/lib/store.js';
import { recordAgentEnvironmentPackageSnapshot } from '../dist/runtime/aep-snapshot-ledger.js';
import { resolveAgentEnvironmentPackage } from '../dist/runtime/agent-environment.js';
import { OpenShellCellController } from '../dist/runtime/openshell-cell.js';
import {
  markWorkerBackendSessionLaunching,
  markWorkerBackendWorkspaceHandoffComplete,
  recordWorkerBackendSessionMaterializing,
  transitionWorkerBackendSessionState,
} from '../dist/runtime/worker-backend-sessions.js';
import { OpenShellWorkerGovernanceBackend } from '../dist/runtime/worker-governance-backend.js';
import {
  acceptSchedulerLeaseHeartbeat,
  createSchedulerAdmissionEntry,
  dispatchNextSchedulerEntry,
  ensureConfiguredSchedulerBaseline,
} from '../dist/scheduler-records.js';
import { openCoreDb, openWorkspaceDb } from '../dist/storage/db.js';
import {
  ensureLayout,
  LOCAL_USER_ID,
  readDataRootLayoutMarker,
} from '../dist/storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from '../dist/storage/migrate.js';
import { type NanoCoreHarness, removeDataRoot, startNanoCoreHarness } from './_lib/harness.js';

it('reconnects one anchored worker across a killed NanoCore process', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'openkit-reconnect-e2e-'));
  let harness: NanoCoreHarness | null = null;

  try {
    ensureLayout(dataRoot);
    seedDemoWorkspaceDataRoot(dataRoot);
    const store = new FsStore({ dataRoot, userId: LOCAL_USER_ID });
    const turn = store.createTurn('ws_demo', 'th_demo', 'Finish after NanoCore restarts.');
    const agent = store.getAgent('ws_demo', 'agent_codex_host');
    const agentSessionId = 'as_restart_e2e';
    const requestId = randomUUID();
    store.updateTurn(turn.id, { agentId: agent.id, agentSessionId, status: 'running' });
    store.createAgentSession({
      agentId: agent.id,
      createdAt: new Date().toISOString(),
      id: agentSessionId,
      message: null,
      status: 'busy',
      threadId: turn.threadId,
      updatedAt: new Date().toISOString(),
      workspaceId: turn.workspaceId,
    });
    const environmentPackage = resolveAgentEnvironmentPackage({
      agent,
      agentSessionId,
      backend: {
        gatewayUrl: 'http://127.0.0.1:17670',
        kind: 'openshell',
        placement: 'local',
        sandboxImageRef: 'openkit/worker-codex:dev',
        workerControlBaseUrl: 'http://host.openkit.internal/api/worker-control',
      },
      requestId,
      turn: store.getTurnById(turn.id),
      userId: LOCAL_USER_ID,
      workspaceCwd: '/workspace/repo',
      workspaceRoots: [],
    });
    const lineage = {
      agentSessionId: environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: environmentPackage.scope.requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    };
    const binding = 'lease-binding:lease_restart_e2e';
    const controlHeaders = {
      authorization: `Bearer ${binding}`,
      'content-type': 'application/json',
    };
    const processKey = randomBytes(32).toString('base64url');
    const processKeyHash = createHash('sha256')
      .update(Buffer.from(processKey, 'base64url'))
      .digest('base64url');
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const workspaceDb = openWorkspaceDb(dataRoot, LOCAL_USER_ID, turn.workspaceId);
    applyScopedMigrations(workspaceDb);
    recordAgentEnvironmentPackageSnapshot(workspaceDb, {
      createdAt: environmentPackage.createdAt,
      environmentPackage,
    });
    workspaceDb.sqlite.close();
    ensureConfiguredSchedulerBaseline(coreDb, { placement: 'local' });
    createSchedulerAdmissionEntry(coreDb, {
      priorityClass: 'interactive',
      profileRef: 'profile_restart_e2e',
      queueEntryId: 'queue_restart_e2e',
      requestId,
      requestedAgentId: agent.id,
      requiredPoolConstraints: ['openshell.local'],
      threadId: turn.threadId,
      turnId: turn.id,
      turnInput: 'Finish after NanoCore restarts.',
      userId: LOCAL_USER_ID,
      workspaceId: turn.workspaceId,
    });
    dispatchNextSchedulerEntry(coreDb, {
      agentSessionId,
      expectedControlMode: 'poll',
      expectedDataPlaneMode: 'openshell-files',
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 30_000,
      leaseDurationMs: 900_000,
      leaseId: 'lease_restart_e2e',
      packageSnapshotId: environmentPackage.snapshotId,
      planId: 'plan_restart_e2e',
      sandboxBindingRef: binding,
      schedulerEpoch: 1,
      startupTimeoutMs: 120_000,
    });
    const plannedIdentity = new OpenShellWorkerGovernanceBackend({
      cellLifecycle: new OpenShellCellController(),
      cli: {} as never,
      dataRoot,
      deploymentId: readDataRootLayoutMarker(dataRoot).deploymentId,
      gatewayName: 'openshell',
      gatewayUrl: 'http://127.0.0.1:17670',
    }).planSession(environmentPackage);
    const backend = recordWorkerBackendSessionMaterializing(coreDb, {
      backendVersion: '0.0.80',
      identity: plannedIdentity,
      lineage,
      sandboxBindingRef: binding,
      workerImage: environmentPackage.runtime.image.ref,
    });
    transitionWorkerBackendSessionState(coreDb, {
      fromState: 'materializing',
      leaseId: backend.leaseId,
      toState: 'materialized',
    });
    markWorkerBackendWorkspaceHandoffComplete(coreDb, { leaseId: backend.leaseId });
    markWorkerBackendSessionLaunching(coreDb, { leaseId: backend.leaseId });
    acceptSchedulerLeaseHeartbeat(coreDb, {
      heartbeatTimeoutMs: 30_000,
      leaseId: backend.leaseId,
      workerProcessKeyHash: processKeyHash,
      workerSequence: 0,
    });
    acceptSchedulerLeaseHeartbeat(coreDb, {
      heartbeatTimeoutMs: 30_000,
      leaseId: backend.leaseId,
      workerSequence: 1,
    });
    coreDb.sqlite.close();

    harness = await startNanoCoreHarness({
      dataRoot,
      seedDemoWorkspace: false,
      useSimulator: false,
    });
    const port = Number(new URL(harness.baseUrl).port);
    const database = openCoreDb(dataRoot);
    const readLease = database.sqlite.prepare(
      `SELECT last_worker_sequence AS lastWorkerSequence,
              recovery_deadline AS recoveryDeadline,
              recovery_state AS recoveryState,
              worker_process_key_hash AS workerProcessKeyHash
         FROM scheduler_session_leases WHERE lease_id = ?`
    );
    const firstBootBarrier = readLease.get(backend.leaseId) as {
      lastWorkerSequence: number;
      recoveryDeadline: string;
      recoveryState: string;
      workerProcessKeyHash: string;
    };
    expect(firstBootBarrier).toMatchObject({
      lastWorkerSequence: 1,
      recoveryState: 'awaiting-reconnect',
      workerProcessKeyHash: processKeyHash,
    });
    await harness.kill();
    harness = await startNanoCoreHarness({
      dataRoot,
      port,
      seedDemoWorkspace: false,
      useSimulator: false,
    });
    expect(readLease.get(backend.leaseId)).toMatchObject({
      lastWorkerSequence: 1,
      recoveryDeadline: firstBootBarrier.recoveryDeadline,
      recoveryState: 'awaiting-reconnect',
      workerProcessKeyHash: processKeyHash,
    });
    const adopted = await fetch(`${harness.baseUrl}/api/worker-control/heartbeat`, {
      body: JSON.stringify({
        body: { message: 'Worker reconnected.', status: 'running' },
        lineage,
        operation: 'heartbeat',
        reconnectKey: processKey,
        schemaVersion: 1,
        sequence: 2,
      }),
      headers: controlHeaders,
      method: 'POST',
    });
    expect(adopted.status, await adopted.text()).toBe(200);
    expect(readLease.get(backend.leaseId)).toMatchObject({
      lastWorkerSequence: 2,
      recoveryState: null,
    });
    // Real Cell recycle belongs to A1; this deterministic L3 starts closeout at its durable proof.
    transitionWorkerBackendSessionState(database, {
      fromState: 'launching',
      leaseId: backend.leaseId,
      toState: 'cleanup-pending',
    });
    transitionWorkerBackendSessionState(database, {
      fromState: 'cleanup-pending',
      leaseId: backend.leaseId,
      toState: 'physical-cleaned',
    });
    const finalStatus = await fetch(`${harness.baseUrl}/api/worker-control/final-status`, {
      body: JSON.stringify({
        body: { status: 'completed', stopReason: 'completed' },
        lineage,
        operation: 'final_status',
        schemaVersion: 1,
        sequence: 2,
      }),
      headers: controlHeaders,
      method: 'POST',
    });
    expect(finalStatus.status).toBe(200);
    await expect
      .poll(
        () =>
          database.sqlite
            .prepare(
              `SELECT backend.state AS backendState, lease.status AS leaseStatus,
                      (SELECT COUNT(*) FROM worker_control_records WHERE operation = 'final_status') AS finalStatusCount
                 FROM worker_backend_sessions AS backend
                 JOIN scheduler_session_leases AS lease ON lease.lease_id = backend.lease_id
                WHERE backend.lease_id = ?`
            )
            .get(backend.leaseId),
        { timeout: 10_000 }
      )
      .toEqual({ backendState: 'cleaned', finalStatusCount: 1, leaseStatus: 'released' });
    const dashboard = await fetch(
      `${harness.baseUrl}/api/app/workspaces/${turn.workspaceId}/threads/${turn.threadId}/dashboard`
    );
    const dashboardBody = (await dashboard.json()) as {
      turns: Array<{ id: string; status: string }>;
    };
    expect(dashboardBody.turns).toContainEqual(
      expect.objectContaining({ id: turn.id, status: 'completed' })
    );
    database.sqlite.close();
  } finally {
    await harness?.stop();
    await removeDataRoot(dataRoot);
  }
});

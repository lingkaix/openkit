import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createDefaultWorkerControlGateway } from '../app.js';
import { finishCapabilityCall, startCapabilityCall } from '../capability/usage-ledger.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { recordTestAgentEnvironmentPackage } from '../test-support/agent-environment.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { openTestNativeWorkspace } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { requireSchedulerExecutionAttempt } from './execution-attempt-records.js';
import { bindNanoHostAttemptRouteTokenHashes } from './nanohost-attempt-records.js';
import { hashWorkerRouteToken } from './worker-control-gateway.js';
import { getWorkerControlAcceptedFinalStatus } from './worker-control-records.js';
import {
  initializeWorkerRawOutput,
  observeWorkerRawOutput,
  settleWorkerRawOutput,
} from './worker-raw-output.js';
import {
  buildWorkspaceInputSnapshots,
  buildWorkspaceMaterializationRecords,
} from './workspace-materializer.js';
import {
  listBackendWorkspaceHandles,
  recordWorkspaceInputSnapshots,
  recordWorkspaceMaterializationRecords,
  requireCompleteBackendWorkspaceHandleHandoff,
} from './workspace-sync-records.js';

/** Captures complete retained handoff and raw-proof rows, including their original payload bytes. */
function handoffBytes(db: WorkspaceDb): string {
  return JSON.stringify(
    [
      'workspace_input_snapshots',
      'workspace_materialization_records',
      'backend_workspace_handles',
      'runtime_evidence',
      'capability_calls',
    ].map((table) => [table, db.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])
  );
}

it('accepts the original Core final under a Workspace write lock without claiming handoff cleanup', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-final-handoff-'));
  let coreDb = openCoreDb(dataRoot);
  const workspaceId = testEntityId('ws', 'final-handoff');
  let workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
  const competingWriter = openWorkspaceDb(dataRoot, workspaceId);
  try {
    applyMigrations(coreDb);
    applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
    const userId = ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({ coreDb, workspaceId, ownerUserId: userId });
    const environmentPackage = recordTestAgentEnvironmentPackage(workspaceDb, {
      coreDb,
      suffix: 'final_handoff',
      triggerActor: { kind: 'user', id: userId },
      workspaceInputIds: ['repo'],
    });
    const lineage = {
      agentSessionId: environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: environmentPackage.scope.requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId,
    };
    const timestamp = new Date().toISOString();
    const entry = createSchedulerAdmissionEntry(coreDb, {
      backendId: 'nanohost',
      queueEntryId: 'queue_final_handoff',
      requestId: lineage.requestId,
      requestedAgentId: environmentPackage.agent.agentId,
      threadId: lineage.threadId,
      triggerActor: { kind: 'user', id: userId },
      turnId: lineage.turnId,
      turnInput: 'Complete the admitted work.',
      workspaceId,
      now: () => timestamp,
    });
    const attemptId = testEntityId('attempt', 'final-handoff');
    const sandboxBindingRef = 'binding:final-handoff';
    recordTestExecutionAttempt(coreDb, {
      entry,
      attemptId,
      agentSessionId: lineage.agentSessionId,
      inputRef: environmentPackage.snapshotId,
      bindingRef: sandboxBindingRef,
      sessionCompatibilityKey: 'final-handoff',
      operationId: 'submit:final-handoff',
      now: () => timestamp,
    });
    const tokens = {
      workerControlToken: 'A'.repeat(43),
      workerInferenceToken: 'B'.repeat(43),
      workerCapabilityToken: 'C'.repeat(43),
    };
    bindNanoHostAttemptRouteTokenHashes(coreDb, {
      attemptId,
      sandboxBindingRef,
      workerControlTokenHash: hashWorkerRouteToken(tokens.workerControlToken),
      workerInferenceTokenHash: hashWorkerRouteToken(tokens.workerInferenceToken),
      workerCapabilityTokenHash: hashWorkerRouteToken(tokens.workerCapabilityToken),
      now: () => timestamp,
    });
    const backendIdentity = {
      backendKind: 'openshell',
      backendVersion: '0.0.80',
      workerSessionId: 'sandbox_final_handoff',
    };
    const inputSnapshots = recordWorkspaceInputSnapshots(
      workspaceDb,
      buildWorkspaceInputSnapshots({
        backendCapabilities: ['trusted-worker-inference-relay'],
        backendKind: backendIdentity.backendKind,
        createdAt: timestamp,
        environmentPackage,
      })
    );
    recordWorkspaceMaterializationRecords(
      workspaceDb,
      buildWorkspaceMaterializationRecords({
        createdAt: timestamp,
        inputSnapshots,
        materialization: {
          backendKind: backendIdentity.backendKind,
          backendStatus: { health: 'ready', version: backendIdentity.backendVersion },
          packageSnapshotId: environmentPackage.snapshotId,
          requiredCapabilities: environmentPackage.backend.requiredCapabilities,
          sandbox: { name: backendIdentity.workerSessionId, state: 'created' },
          workspaceInputs: environmentPackage.workspace.inputs.map(({ id, target }) => ({
            id,
            target,
          })),
        },
      })
    );
    expect(
      requireCompleteBackendWorkspaceHandleHandoff(workspaceDb, environmentPackage, backendIdentity)
    ).toHaveLength(1);
    await openTestNativeWorkspace(workspaceDb);
    const call = await startCapabilityCall({
      workspaceDb,
      workspaceId,
      threadId: lineage.threadId,
      turnId: lineage.turnId,
      authorityActor: environmentPackage.scope.triggerActor,
      family: 'llm',
      operation: 'chat_completions',
      capabilityId: 'llm.gateway.use',
      redactionClass: 'metadata-only',
      serviceRef: 'worker-inference-gateway',
    });
    initializeWorkerRawOutput(workspaceDb, call, lineage);
    observeWorkerRawOutput(workspaceDb, {
      ...lineage,
      callId: call.id,
      attemptId: 'source_final_handoff',
      partId: 0,
      field: 'text',
      fromBytePosition: 0,
      bytePosition: 41,
    });
    settleWorkerRawOutput(workspaceDb, lineage, call.id, true);
    await finishCapabilityCall({ workspaceDb, callId: call.id, status: 'succeeded' });
    const before = handoffBytes(workspaceDb);
    const notifications: unknown[] = [];
    const gateway = createDefaultWorkerControlGateway(coreDb, (notification) => {
      expect(coreDb.sqlite.inTransaction).toBe(false);
      expect(getWorkerControlAcceptedFinalStatus(coreDb, lineage)).not.toBeNull();
      notifications.push(notification);
    });
    gateway.registerSession(environmentPackage, { ...tokens, sandboxBindingRef });
    const request = {
      authorization: `Bearer ${tokens.workerControlToken}`,
      lineage,
      sequence: 1,
      status: 'completed' as const,
      stopReason: 'completed',
      evidenceManifestDigests: { output: 'sha256:final-handoff' },
    };
    expect(coreDb.sqlite.pragma('synchronous', { simple: true })).toBe(2);
    // A real competing SQLite writer models contention without inventing a native pause protocol.
    competingWriter.sqlite.exec('BEGIN IMMEDIATE');
    expect(competingWriter.sqlite.inTransaction).toBe(true);
    const response = gateway.recordFinalStatus(request);
    expect(response).toMatchObject({ accepted: true, nextExpectedSequence: 2 });
    expect(notifications).toHaveLength(1);
    const originalFinal = getWorkerControlAcceptedFinalStatus(coreDb, lineage);
    expect(originalFinal).toMatchObject({ status: 'completed', stopReason: 'completed' });
    const finalRow = coreDb.sqlite
      .prepare(
        "SELECT record_json, accepted_at FROM worker_control_records WHERE operation = 'final_status'"
      )
      .get() as { record_json: string; accepted_at: string };
    expect(JSON.parse(finalRow.record_json)).toEqual({
      acceptedAt: originalFinal!.acceptedAt,
      sequence: 1,
      status: 'completed',
      stopReason: 'completed',
      evidenceManifestDigests: request.evidenceManifestDigests,
    });
    expect(finalRow.accepted_at).toBe(originalFinal!.acceptedAt);
    const coreRows = JSON.stringify(
      coreDb.sqlite.prepare('SELECT * FROM worker_control_records ORDER BY rowid').all()
    );
    expect(gateway.recordFinalStatus(request)).toEqual(response);
    expect(
      JSON.stringify(
        coreDb.sqlite.prepare('SELECT * FROM worker_control_records ORDER BY rowid').all()
      )
    ).toBe(coreRows);
    expect(
      coreDb.sqlite.prepare('SELECT operation FROM worker_control_records ORDER BY operation').all()
    ).toEqual([{ operation: 'event_append' }, { operation: 'final_status' }]);
    expect(requireSchedulerExecutionAttempt(coreDb, attemptId)).toMatchObject({
      phase: 'closing',
      terminalCause: 'worker-final-status',
    });
    expect(handoffBytes(workspaceDb)).toBe(before);
    expect(listBackendWorkspaceHandles(workspaceDb, workspaceId)).toEqual([
      expect.objectContaining({ cleanupStatus: 'pending', updatedAt: timestamp }),
    ]);
    competingWriter.sqlite.exec('ROLLBACK');
    await shutdownControlStoreWorkerClient();
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
    workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
    coreDb = openCoreDb(dataRoot);
    expect(handoffBytes(workspaceDb)).toBe(before);
    expect(getWorkerControlAcceptedFinalStatus(coreDb, lineage)).toEqual(originalFinal);
    expect(
      JSON.stringify(
        coreDb.sqlite.prepare('SELECT * FROM worker_control_records ORDER BY rowid').all()
      )
    ).toBe(coreRows);
    expect(
      requireCompleteBackendWorkspaceHandleHandoff(workspaceDb, environmentPackage, backendIdentity)
    ).toHaveLength(1);
  } finally {
    if (competingWriter.sqlite.inTransaction) competingWriter.sqlite.exec('ROLLBACK');
    competingWriter.sqlite.close();
    await shutdownControlStoreWorkerClient();
    if (workspaceDb.sqlite.open) workspaceDb.sqlite.close();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

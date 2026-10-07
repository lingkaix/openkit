import { isDeepStrictEqual } from 'node:util';

import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import type {
  WorkerCanonicalEventRecord,
  WorkerCapabilityCallSummary,
} from '@openkit/worker-protocol';
import { requireSchedulerExecutionAttemptAdmissionContext } from '../scheduler-records.js';
import { type CoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { requireAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import {
  listRestorableNanoHostExecutionAttempts,
  type NanoHostExecutionAttemptRecord,
  requireNanoHostExecutionAttempt,
} from './nanohost-attempt-records.js';
import type {
  WorkerControlArtifactNotice,
  WorkerControlGateway,
  WorkerControlHeartbeat,
  WorkerControlLineage,
  WorkerControlSupplyRefreshAck,
} from './worker-control-gateway.js';

interface WorkerControlRecordRow {
  readonly acceptedAt: string;
  readonly operation: string;
  readonly recordJson: string;
}

/**
 * Restores live worker-control sessions from durable scheduler and gateway rows.
 *
 * @param coreDb Server-scope Core database.
 * @param gateway Gateway instance to hydrate.
 */
export function rebuildWorkerControlGatewaySessions(
  coreDb: CoreDb,
  gateway: WorkerControlGateway
): void {
  const leases = [
    ...listRestorableNanoHostExecutionAttempts(coreDb),
    ...listFinalStatusReplayLeases(coreDb),
  ];

  for (const lease of leases) {
    if (
      !lease.bindingRef ||
      !lease.workerControlTokenHash ||
      !lease.workerInferenceTokenHash ||
      !lease.workerCapabilityTokenHash
    ) {
      continue;
    }

    const admission = requireSchedulerExecutionAttemptAdmissionContext(coreDb, lease.attemptId);
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, lease.workspaceId);
    let environmentPackage: AgentEnvironmentPackage;

    try {
      applyScopedMigrations(workspaceDb);
      environmentPackage = requireAgentEnvironmentPackageSnapshot(
        workspaceDb,
        lease.workspaceId,
        lease.inputRef
      ).snapshot;
    } finally {
      workspaceDb.sqlite.close();
    }
    assertRestoredPackageLineage(environmentPackage, lease, admission);
    const lineage: WorkerControlLineage = {
      agentSessionId: environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: environmentPackage.scope.requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    };
    const records = readAcceptedRecords(coreDb, lineage);

    gateway.restoreSession({
      ...records,
      environmentPackage,
      lineage,
      registeredAt: lease.createdAt,
      sandboxBindingRef: lease.bindingRef,
      workerControlTokenHash: lease.workerControlTokenHash,
      workerInferenceTokenHash: lease.workerInferenceTokenHash,
      workerCapabilityTokenHash: lease.workerCapabilityTokenHash,
    });
  }
}

/**
 * Lists releasing leases that retain one durable final status within release grace.
 *
 * @param coreDb Server-scope Core database.
 * @returns Leases restorable only for exact final-status replay.
 */
function listFinalStatusReplayLeases(coreDb: CoreDb): NanoHostExecutionAttemptRecord[] {
  const table = coreDb.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get('scheduler_execution_attempts');

  if (!table) {
    return [];
  }

  const rows = coreDb.sqlite
    .prepare(
      `SELECT attempt_id AS attemptId
         FROM scheduler_execution_attempts AS lease
         WHERE lease.phase IN ('closing', 'closed')
           AND lease.binding_ref IS NOT NULL
           AND lease.worker_control_token_hash IS NOT NULL
           AND lease.worker_inference_token_hash IS NOT NULL
           AND lease.deadline > ?
          AND EXISTS (
            SELECT 1
              FROM worker_control_records AS record
             WHERE record.workspace_id = lease.workspace_id
               AND record.thread_id = lease.thread_id
               AND record.turn_id = lease.turn_id
               AND record.agent_session_id = lease.agent_session_id
               AND record.package_snapshot_id = lease.input_ref
               AND record.operation = 'final_status'
          )
        ORDER BY lease.created_at ASC, lease.attempt_id ASC`
    )
    .all(new Date().toISOString()) as Array<{ attemptId: string }>;

  return rows.map((row) => requireNanoHostExecutionAttempt(coreDb, row.attemptId));
}

/**
 * Verifies that a durable AEP belongs to the execution attempt and admission actor being restored.
 *
 * @param environmentPackage Durable redacted AEP snapshot.
 * @param lease Restorable execution attempt.
 * @param admission Admission authority resolved through the scheduler chain.
 * @throws Error when any authority-bearing lineage field disagrees.
 */
function assertRestoredPackageLineage(
  environmentPackage: AgentEnvironmentPackage,
  lease: NanoHostExecutionAttemptRecord,
  admission: ReturnType<typeof requireSchedulerExecutionAttemptAdmissionContext>
): void {
  const scope = environmentPackage.scope;

  if (
    environmentPackage.snapshotId !== lease.inputRef ||
    scope.agentSessionId !== lease.agentSessionId ||
    scope.workspaceId !== lease.workspaceId ||
    scope.threadId !== lease.threadId ||
    scope.turnId !== lease.turnId ||
    !isDeepStrictEqual(scope.triggerActor, admission.triggerActor) ||
    scope.requestId !== admission.requestId
  ) {
    throw new Error(`Restored worker-control package lineage mismatch: ${lease.attemptId}`);
  }
}

/**
 * Reads product-safe accepted worker-control records for one lineage.
 *
 * @param coreDb Server-scope Core database.
 * @param lineage Worker-control lineage selector.
 * @returns Accepted records grouped by snapshot field.
 */
function readAcceptedRecords(
  coreDb: CoreDb,
  lineage: WorkerControlLineage
): {
  artifacts: WorkerControlArtifactNotice[];
  capabilitySummaries: WorkerCapabilityCallSummary[];
  events: WorkerCanonicalEventRecord[];
  heartbeat: WorkerControlHeartbeat | null;
  supplyRefreshAcks: WorkerControlSupplyRefreshAck[];
} {
  const rows = coreDb.sqlite
    .prepare(
      `
      SELECT operation, record_json AS recordJson, accepted_at AS acceptedAt
      FROM worker_control_records
      WHERE agent_session_id = ?
        AND package_snapshot_id = ?
      ORDER BY accepted_at ASC, operation ASC
      `
    )
    .all(lineage.agentSessionId, lineage.packageSnapshotId) as WorkerControlRecordRow[];
  const result = {
    artifacts: [] as WorkerControlArtifactNotice[],
    capabilitySummaries: [] as WorkerCapabilityCallSummary[],
    events: [] as WorkerCanonicalEventRecord[],
    heartbeat: null as WorkerControlHeartbeat | null,
    supplyRefreshAcks: [] as WorkerControlSupplyRefreshAck[],
  };

  for (const row of rows) {
    const record = JSON.parse(row.recordJson) as unknown;

    if (row.operation === 'heartbeat') {
      result.heartbeat = record as WorkerControlHeartbeat;
    } else if (row.operation === 'artifact_notice') {
      result.artifacts.push(record as WorkerControlArtifactNotice);
    } else if (row.operation === 'supply_refresh_ack') {
      result.supplyRefreshAcks.push(record as WorkerControlSupplyRefreshAck);
    } else if (row.operation === 'capability_summary') {
      result.capabilitySummaries.push(record as WorkerCapabilityCallSummary);
    } else if (row.operation === 'event_append') {
      const eventType = (record as { event?: { type?: string } }).event?.type;
      // Observation transport receipts are not canonical transcript or public session events.
      // Their existing durable sequence fingerprints remain the replay authority.
      if (eventType !== 'observation.recorded' && eventType !== 'observation.content.chunk')
        result.events.push(record as WorkerCanonicalEventRecord);
    }
  }

  return result;
}

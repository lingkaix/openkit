import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import type {
  WorkerCanonicalEventRecord,
  WorkerCapabilityCallSummary,
} from '@openkit/worker-protocol';
import {
  listRestorableSchedulerSessionLeases,
  requireSchedulerSessionLeaseAdmissionContext,
  type SchedulerSessionLeaseRecord,
} from '../scheduler-records.js';
import { type CoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { requireAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import type {
  WorkerControlArtifactNotice,
  WorkerControlCommand,
  WorkerControlGateway,
  WorkerControlHeartbeat,
  WorkerControlKnowledgeProposalSummary,
  WorkerControlLineage,
  WorkerControlSupplyRefreshAck,
  WorkerControlTerminalResult,
} from './worker-control-gateway.js';

interface WorkerControlRecordRow {
  readonly acceptedAt: string;
  readonly operation: string;
  readonly recordJson: string;
}

interface WorkerControlCommandRow {
  readonly deliveredAt: string | null;
  readonly payloadJson: string;
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
  for (const lease of listRestorableSchedulerSessionLeases(coreDb)) {
    if (!lease.sandboxBindingRef) {
      continue;
    }

    const admission = requireSchedulerSessionLeaseAdmissionContext(coreDb, lease.leaseId);
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, admission.userId, lease.workspaceId);
    let environmentPackage: AgentEnvironmentPackage;

    try {
      applyScopedMigrations(workspaceDb);
      environmentPackage = requireAgentEnvironmentPackageSnapshot(
        workspaceDb,
        lease.workspaceId,
        lease.packageSnapshotId
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
      commands: readCommands(coreDb, lineage),
      environmentPackage,
      lineage,
      registeredAt: lease.acquiredAt,
      token: lease.sandboxBindingRef,
    });
  }
}

/**
 * Verifies that a durable AEP belongs to the scheduler lease and admission owner being restored.
 *
 * @param environmentPackage Durable redacted AEP snapshot.
 * @param lease Restorable scheduler lease.
 * @param admission Admission authority resolved through the scheduler chain.
 * @throws Error when any authority-bearing lineage field disagrees.
 */
function assertRestoredPackageLineage(
  environmentPackage: AgentEnvironmentPackage,
  lease: SchedulerSessionLeaseRecord,
  admission: { readonly requestId: string | null; readonly userId: string }
): void {
  const scope = environmentPackage.scope;

  if (
    environmentPackage.snapshotId !== lease.packageSnapshotId ||
    scope.agentSessionId !== lease.agentSessionId ||
    scope.workspaceId !== lease.workspaceId ||
    scope.threadId !== lease.threadId ||
    scope.turnId !== lease.turnId ||
    scope.userId !== admission.userId ||
    scope.requestId !== admission.requestId
  ) {
    throw new Error(`Restored worker-control package lineage mismatch: ${lease.leaseId}`);
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
  knowledgeProposalSummaries: WorkerControlKnowledgeProposalSummary[];
  supplyRefreshAcks: WorkerControlSupplyRefreshAck[];
  terminalResults: WorkerControlTerminalResult[];
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
    knowledgeProposalSummaries: [] as WorkerControlKnowledgeProposalSummary[],
    supplyRefreshAcks: [] as WorkerControlSupplyRefreshAck[],
    terminalResults: [] as WorkerControlTerminalResult[],
  };

  for (const row of rows) {
    const record = JSON.parse(row.recordJson) as unknown;

    if (row.operation === 'heartbeat') {
      result.heartbeat = record as WorkerControlHeartbeat;
    } else if (row.operation === 'artifact_notice') {
      result.artifacts.push(record as WorkerControlArtifactNotice);
    } else if (row.operation === 'terminal_result') {
      result.terminalResults.push(record as WorkerControlTerminalResult);
    } else if (row.operation === 'supply_refresh_ack') {
      result.supplyRefreshAcks.push(record as WorkerControlSupplyRefreshAck);
    } else if (row.operation === 'capability_summary') {
      result.capabilitySummaries.push(record as WorkerCapabilityCallSummary);
    } else if (row.operation === 'knowledge_proposal_summary') {
      result.knowledgeProposalSummaries.push(record as WorkerControlKnowledgeProposalSummary);
    } else if (row.operation === 'event_append') {
      result.events.push(record as WorkerCanonicalEventRecord);
    }
  }

  return result;
}

/**
 * Reads durable worker-control commands for one lineage.
 *
 * @param coreDb Server-scope Core database.
 * @param lineage Worker-control lineage selector.
 * @returns Restored command records.
 */
function readCommands(coreDb: CoreDb, lineage: WorkerControlLineage): WorkerControlCommand[] {
  return (
    coreDb.sqlite
      .prepare(
        `
        SELECT payload_json AS payloadJson, delivered_at AS deliveredAt
        FROM worker_control_commands
        WHERE agent_session_id = ?
          AND package_snapshot_id = ?
          AND acknowledged_at IS NULL
        ORDER BY sequence ASC
        `
      )
      .all(lineage.agentSessionId, lineage.packageSnapshotId) as WorkerControlCommandRow[]
  ).map((row) => ({
    ...(JSON.parse(row.payloadJson) as WorkerControlCommand),
    deliveredAt: row.deliveredAt,
  }));
}

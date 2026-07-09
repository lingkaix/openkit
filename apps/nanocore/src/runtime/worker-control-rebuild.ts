import type {
  WorkerCanonicalEventRecord,
  WorkerCapabilityCallSummary,
} from '@openkit/worker-protocol';
import { listRestorableSchedulerSessionLeases } from '../scheduler-records.js';
import type { CoreDb } from '../storage/db.js';
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

    const lineage: WorkerControlLineage = {
      agentSessionId: lease.agentSessionId,
      packageSnapshotId: lease.packageSnapshotId,
      requestId: null,
      threadId: lease.threadId,
      turnId: lease.turnId,
      workspaceId: lease.workspaceId,
    };
    const records = readAcceptedRecords(coreDb, lineage);

    gateway.restoreSession({
      ...records,
      commands: readCommands(coreDb, lineage),
      lineage,
      registeredAt: lease.acquiredAt,
      token: lease.sandboxBindingRef,
    });
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
        ORDER BY sequence ASC
        `
      )
      .all(lineage.agentSessionId, lineage.packageSnapshotId) as WorkerControlCommandRow[]
  ).map((row) => ({
    ...(JSON.parse(row.payloadJson) as WorkerControlCommand),
    deliveredAt: row.deliveredAt,
  }));
}

import type { CoreDb } from '../storage/db.js';
import type {
  WorkerControlCommandDeliveryRecord,
  WorkerControlCommandDeliveryRecorder,
  WorkerControlCommandDeliveryRecorderInput,
  WorkerControlCommandDeliveryStatus,
  WorkerControlCommandDeliveryStatusInput,
  WorkerControlLineage,
} from './worker-control-gateway.js';
import { deriveWorkerControlCommandId } from './worker-control-gateway.js';

/** Complete durable command projection used by every read boundary. */
export interface WorkerControlCommandRow {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly agentSessionId: string;
  readonly packageSnapshotId: string;
  readonly requestId: string | null;
  readonly commandId: string;
  readonly commandKind: string;
  readonly sequence: number;
  readonly payloadJson: string;
  readonly status: string;
  readonly queuedAt: string;
  readonly deliveredAt: string | null;
}

/** Creates the server-scope SQLite recorder for worker-control command delivery state. */
export function createWorkerControlCommandDeliveryRecorder(
  coreDb: CoreDb
): WorkerControlCommandDeliveryRecorder {
  return {
    markAcknowledged(input) {
      return markWorkerControlCommandAcknowledged(coreDb, input);
    },
    markDelivered(input) {
      return markWorkerControlCommandDelivered(coreDb, input);
    },
    recordQueued(input) {
      return recordWorkerControlQueuedCommand(coreDb, input);
    },
  };
}

/** Inserts or exactly replays one queued command while its complete-lineage lease is live. */
export function recordWorkerControlQueuedCommand(
  coreDb: CoreDb,
  input: WorkerControlCommandDeliveryRecorderInput
): WorkerControlCommandDeliveryRecord {
  const payloadJson = canonicalInterruptPayload(input.command.reason);
  commandRecord({
    agentSessionId: input.lineage.agentSessionId,
    commandId: input.command.commandId,
    commandKind: input.command.kind,
    deliveredAt: null,
    packageSnapshotId: input.lineage.packageSnapshotId,
    payloadJson,
    queuedAt: input.command.queuedAt,
    requestId: input.lineage.requestId ?? null,
    sequence: input.command.sequence,
    status: 'queued',
    threadId: input.lineage.threadId,
    turnId: input.lineage.turnId,
    workspaceId: input.lineage.workspaceId,
  });

  coreDb.sqlite.exec('BEGIN IMMEDIATE');
  try {
    if (!hasLiveSchedulerLease(coreDb, input.lineage)) {
      throw new Error('Worker command lineage has no live scheduler lease.');
    }

    const lineageRows = findLineageCommandRows(coreDb, input.lineage);
    if (lineageRows.length > 0) {
      const existing = lineageRows[0]!;
      if (lineageRows.length !== 1 || existing.commandId !== input.command.commandId) {
        throw new Error(`Worker interrupt already admitted for Turn: ${input.lineage.turnId}`);
      }
      if (!isExactReplay(existing, input, payloadJson)) {
        throw new Error(`Worker command identity conflict: ${input.command.commandId}`);
      }
      const replay = commandRecord(existing);
      coreDb.sqlite.exec('COMMIT');
      return replay;
    }

    const inserted = coreDb.sqlite
      .prepare(
        `INSERT INTO worker_control_commands (
          workspace_id, thread_id, turn_id, agent_session_id, package_snapshot_id,
          request_id, command_id, command_kind, sequence, payload_json, status,
          queued_at, delivered_at, acknowledged_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL, NULL)
        ON CONFLICT(command_id) DO NOTHING`
      )
      .run(
        input.lineage.workspaceId,
        input.lineage.threadId,
        input.lineage.turnId,
        input.lineage.agentSessionId,
        input.lineage.packageSnapshotId,
        input.lineage.requestId ?? null,
        input.command.commandId,
        input.command.kind,
        input.command.sequence,
        payloadJson,
        input.command.queuedAt
      );
    const row = requireCommandRow(coreDb, input.command.commandId);

    if (inserted.changes === 0 && !isExactReplay(row, input, payloadJson)) {
      throw new Error(`Worker command identity conflict: ${input.command.commandId}`);
    }

    const record = commandRecord(row);
    coreDb.sqlite.exec('COMMIT');
    return record;
  } catch (error) {
    if (coreDb.sqlite.inTransaction) {
      coreDb.sqlite.exec('ROLLBACK');
    }
    throw error;
  }
}

/** Changes one exact live-lineage command from queued to delivered. */
export function markWorkerControlCommandDelivered(
  coreDb: CoreDb,
  input: WorkerControlCommandDeliveryStatusInput
): WorkerControlCommandDeliveryRecord | null {
  coreDb.sqlite.exec('BEGIN IMMEDIATE');
  try {
    if (hasLiveSchedulerLease(coreDb, input.lineage)) {
      coreDb.sqlite
        .prepare(
          `UPDATE worker_control_commands
          SET status = 'delivered', delivered_at = ?
          WHERE command_id = ? AND workspace_id = ? AND thread_id = ? AND turn_id = ?
            AND agent_session_id = ? AND package_snapshot_id = ? AND request_id IS ?
            AND command_kind = 'interrupt' AND status = 'queued'`
        )
        .run(
          input.at,
          input.commandId,
          input.lineage.workspaceId,
          input.lineage.threadId,
          input.lineage.turnId,
          input.lineage.agentSessionId,
          input.lineage.packageSnapshotId,
          input.lineage.requestId ?? null
        );
    }
    const row = findCommandRow(coreDb, input.commandId, input.lineage);
    const record = row ? commandRecord(row) : null;

    coreDb.sqlite.exec('COMMIT');
    return record;
  } catch (error) {
    if (coreDb.sqlite.inTransaction) {
      coreDb.sqlite.exec('ROLLBACK');
    }
    throw error;
  }
}

/** Changes one exact command from delivered to acknowledged, preserving exact replay. */
export function markWorkerControlCommandAcknowledged(
  coreDb: CoreDb,
  input: WorkerControlCommandDeliveryStatusInput
): WorkerControlCommandDeliveryRecord | null {
  coreDb.sqlite.exec('BEGIN IMMEDIATE');
  try {
    coreDb.sqlite
      .prepare(
        `UPDATE worker_control_commands
        SET status = 'acknowledged', acknowledged_at = ?
        WHERE command_id = ? AND workspace_id = ? AND thread_id = ? AND turn_id = ?
          AND agent_session_id = ? AND package_snapshot_id = ? AND request_id IS ?
          AND command_kind = 'interrupt' AND status = 'delivered'`
      )
      .run(
        input.at,
        input.commandId,
        input.lineage.workspaceId,
        input.lineage.threadId,
        input.lineage.turnId,
        input.lineage.agentSessionId,
        input.lineage.packageSnapshotId,
        input.lineage.requestId ?? null
      );
    const row = findCommandRow(coreDb, input.commandId, input.lineage);
    const record = row ? commandRecord(row) : null;

    coreDb.sqlite.exec('COMMIT');
    return record;
  } catch (error) {
    if (coreDb.sqlite.inTransaction) {
      coreDb.sqlite.exec('ROLLBACK');
    }
    throw error;
  }
}

/** Returns whether one exact complete-lineage scheduler lease is live. */
function hasLiveSchedulerLease(coreDb: CoreDb, lineage: WorkerControlLineage): boolean {
  return Boolean(
    coreDb.sqlite
      .prepare(
        `SELECT 1
        FROM scheduler_session_leases AS lease
        JOIN scheduler_placement_plans AS plan ON plan.plan_id = lease.plan_id
        JOIN scheduler_admission_entries AS admission
          ON admission.queue_entry_id = plan.queue_entry_id
        WHERE lease.workspace_id = ? AND lease.thread_id = ? AND lease.turn_id = ?
          AND lease.agent_session_id = ? AND lease.package_snapshot_id = ?
          AND admission.request_id IS ?
          AND lease.status IN ('acquired', 'starting', 'active', 'idle')
        LIMIT 1`
      )
      .get(
        lineage.workspaceId,
        lineage.threadId,
        lineage.turnId,
        lineage.agentSessionId,
        lineage.packageSnapshotId,
        lineage.requestId ?? null
      )
  );
}

/** Reads one command by global identity. */
function requireCommandRow(coreDb: CoreDb, commandId: string): WorkerControlCommandRow {
  const row = coreDb.sqlite.prepare(`${commandSelectSql()} WHERE command_id = ?`).get(commandId) as
    | WorkerControlCommandRow
    | undefined;
  if (!row) {
    throw new Error(`Worker command insert did not produce a durable row: ${commandId}`);
  }
  return row;
}

/** Reads one command only when its complete lineage matches. */
function findCommandRow(
  coreDb: CoreDb,
  commandId: string,
  lineage: WorkerControlLineage
): WorkerControlCommandRow | null {
  return (
    (coreDb.sqlite
      .prepare(
        `${commandSelectSql()}
        WHERE command_id = ? AND workspace_id = ? AND thread_id = ? AND turn_id = ?
          AND agent_session_id = ? AND package_snapshot_id = ? AND request_id IS ?`
      )
      .get(
        commandId,
        lineage.workspaceId,
        lineage.threadId,
        lineage.turnId,
        lineage.agentSessionId,
        lineage.packageSnapshotId,
        lineage.requestId ?? null
      ) as WorkerControlCommandRow | undefined) ?? null
  );
}

/** Reads every command already admitted for one complete Turn lineage. */
function findLineageCommandRows(
  coreDb: CoreDb,
  lineage: WorkerControlLineage
): WorkerControlCommandRow[] {
  return coreDb.sqlite
    .prepare(
      `${commandSelectSql()}
      WHERE workspace_id = ? AND thread_id = ? AND turn_id = ?
        AND agent_session_id = ? AND package_snapshot_id = ? AND request_id IS ?
        AND command_kind = 'interrupt'
      ORDER BY sequence ASC`
    )
    .all(
      lineage.workspaceId,
      lineage.threadId,
      lineage.turnId,
      lineage.agentSessionId,
      lineage.packageSnapshotId,
      lineage.requestId ?? null
    ) as WorkerControlCommandRow[];
}

/** Returns the shared command-row projection. */
function commandSelectSql(): string {
  return `SELECT workspace_id AS workspaceId, thread_id AS threadId, turn_id AS turnId,
    agent_session_id AS agentSessionId, package_snapshot_id AS packageSnapshotId,
    request_id AS requestId, command_id AS commandId, command_kind AS commandKind,
    sequence, payload_json AS payloadJson, status, queued_at AS queuedAt,
    delivered_at AS deliveredAt
    FROM worker_control_commands`;
}

/** Compares every immutable command field and the canonical payload. */
function isExactReplay(
  row: WorkerControlCommandRow,
  input: WorkerControlCommandDeliveryRecorderInput,
  payloadJson: string
): boolean {
  const lineage = input.lineage;
  return (
    row.commandId === input.command.commandId &&
    row.workspaceId === lineage.workspaceId &&
    row.threadId === lineage.threadId &&
    row.turnId === lineage.turnId &&
    row.agentSessionId === lineage.agentSessionId &&
    row.packageSnapshotId === lineage.packageSnapshotId &&
    row.requestId === (lineage.requestId ?? null) &&
    row.commandKind === input.command.kind &&
    row.sequence === input.command.sequence &&
    row.payloadJson === payloadJson
  );
}

/** Validates and reconstructs the public command from durable columns. */
export function commandRecord(row: WorkerControlCommandRow): WorkerControlCommandDeliveryRecord {
  if (
    !isCommandStatus(row.status) ||
    row.commandKind !== 'interrupt' ||
    !Number.isSafeInteger(row.sequence) ||
    row.sequence < 0 ||
    row.commandId !== deriveWorkerControlCommandId(lineageFromRow(row), row.sequence)
  ) {
    throw new Error(`Invalid durable worker command row: ${row.commandId}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(row.payloadJson);
  } catch {
    throw new Error(`Invalid durable worker command payload: ${row.commandId}`);
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload) ||
    Object.keys(payload).length !== 1 ||
    !Object.hasOwn(payload, 'reason') ||
    !('reason' in payload) ||
    (payload.reason !== null && typeof payload.reason !== 'string')
  ) {
    throw new Error(`Invalid durable worker command payload: ${row.commandId}`);
  }
  const payloadJson = canonicalInterruptPayload(payload.reason);
  if (row.payloadJson !== payloadJson) {
    throw new Error(`Invalid durable worker command payload: ${row.commandId}`);
  }
  return {
    command: {
      commandId: row.commandId,
      deliveredAt: row.deliveredAt,
      kind: 'interrupt',
      queuedAt: row.queuedAt,
      reason: payload.reason,
      sequence: row.sequence,
    },
    status: row.status,
  };
}

/** Reconstructs complete lineage from one durable command row. */
function lineageFromRow(row: WorkerControlCommandRow): WorkerControlLineage {
  return {
    agentSessionId: row.agentSessionId,
    packageSnapshotId: row.packageSnapshotId,
    requestId: row.requestId,
    threadId: row.threadId,
    turnId: row.turnId,
    workspaceId: row.workspaceId,
  };
}

/** Serializes the exact canonical interrupt payload. */
function canonicalInterruptPayload(reason: string | null): string {
  return JSON.stringify({ reason });
}

/** Validates the closed durable delivery-state vocabulary. */
function isCommandStatus(value: string): value is WorkerControlCommandDeliveryStatus {
  return (
    value === 'queued' ||
    value === 'delivered' ||
    value === 'acknowledged' ||
    value === 'undeliverable'
  );
}

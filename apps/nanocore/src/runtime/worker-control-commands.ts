import type { CoreDb } from '../storage/db.js';
import type {
  WorkerControlCommandDeliveryRecorder,
  WorkerControlCommandDeliveryRecorderInput,
  WorkerControlCommandDeliveryStatusInput,
} from './worker-control-gateway.js';

/**
 * Creates a server-scope SQLite recorder for worker-control command delivery state.
 *
 * @param coreDb Server-scope Core database.
 * @returns Durable command delivery recorder.
 */
export function createWorkerControlCommandDeliveryRecorder(
  coreDb: CoreDb
): WorkerControlCommandDeliveryRecorder {
  return {
    markAcknowledged(input) {
      markWorkerControlCommandAcknowledged(coreDb, input);
    },
    markDelivered(input) {
      markWorkerControlCommandDelivered(coreDb, input);
    },
    recordQueued(input) {
      recordWorkerControlQueuedCommand(coreDb, input);
    },
  };
}

/**
 * Stores one queued worker-control command.
 *
 * @param coreDb Server-scope Core database.
 * @param input Queued command input.
 */
export function recordWorkerControlQueuedCommand(
  coreDb: CoreDb,
  input: WorkerControlCommandDeliveryRecorderInput
): void {
  coreDb.sqlite
    .prepare(
      `
      INSERT OR REPLACE INTO worker_control_commands (
        workspace_id,
        thread_id,
        turn_id,
        agent_session_id,
        package_snapshot_id,
        request_id,
        command_id,
        command_kind,
        sequence,
        payload_json,
        status,
        queued_at,
        delivered_at,
        acknowledged_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL, NULL)
      `
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
      JSON.stringify(input.command),
      input.command.queuedAt
    );
}

/**
 * Marks one worker-control command as delivered.
 *
 * @param coreDb Server-scope Core database.
 * @param input Delivery status input.
 */
export function markWorkerControlCommandDelivered(
  coreDb: CoreDb,
  input: WorkerControlCommandDeliveryStatusInput
): void {
  coreDb.sqlite
    .prepare(
      `
      UPDATE worker_control_commands
      SET status = CASE WHEN status = 'queued' THEN 'delivered' ELSE status END,
        delivered_at = COALESCE(delivered_at, ?)
      WHERE command_id = ?
      `
    )
    .run(input.at, input.commandId);
}

/**
 * Marks one worker-control command as acknowledged.
 *
 * @param coreDb Server-scope Core database.
 * @param input Acknowledgement status input.
 */
export function markWorkerControlCommandAcknowledged(
  coreDb: CoreDb,
  input: WorkerControlCommandDeliveryStatusInput
): void {
  coreDb.sqlite
    .prepare(
      `
      UPDATE worker_control_commands
      SET status = 'acknowledged',
        acknowledged_at = COALESCE(acknowledged_at, ?)
      WHERE command_id = ?
      `
    )
    .run(input.at, input.commandId);
}

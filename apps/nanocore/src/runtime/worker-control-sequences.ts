import type { CoreDb } from '../storage/db.js';
import type {
  WorkerControlSequenceRecorder,
  WorkerControlSequenceRecorderInput,
  WorkerControlSequenceRecorderResult,
} from './worker-control-gateway.js';

/**
 * Creates a server-scope SQLite recorder for worker-control sequence fingerprints.
 *
 * @param coreDb Server-scope Core database.
 * @returns Durable sequence recorder.
 */
export function createWorkerControlSequenceRecorder(coreDb: CoreDb): WorkerControlSequenceRecorder {
  return {
    accept(input) {
      return acceptWorkerControlSequence(coreDb, input);
    },
  };
}

/**
 * Accepts or rejects one worker-control sequence fingerprint against durable state.
 *
 * @param coreDb Server-scope Core database.
 * @param input Sequence fingerprint input.
 * @returns Durable accept or reject outcome.
 */
export function acceptWorkerControlSequence(
  coreDb: CoreDb,
  input: WorkerControlSequenceRecorderInput
): WorkerControlSequenceRecorderResult {
  const existing = coreDb.sqlite
    .prepare(
      `
      SELECT fingerprint
      FROM worker_control_sequence_fingerprints
      WHERE agent_session_id = ?
        AND package_snapshot_id = ?
        AND operation = ?
        AND sequence = ?
      `
    )
    .get(
      input.lineage.agentSessionId,
      input.lineage.packageSnapshotId,
      input.operation,
      input.sequence
    ) as { fingerprint: string } | undefined;

  if (existing) {
    if (existing.fingerprint !== input.fingerprint) {
      return {
        code: 'worker_control_sequence_conflict',
        message: `Worker control ${input.operation} sequence already accepted with different content: ${input.sequence}`,
        status: 'conflict',
      };
    }

    return {
      nextExpectedSequence: nextExpectedSequence(coreDb, input),
      status: 'accepted',
    };
  }

  const highest = highestAcceptedSequence(coreDb, input);

  if (highest !== null && input.sequence < highest) {
    return {
      code: 'worker_control_sequence_stale',
      message: `Worker control ${input.operation} sequence is older than the latest accepted sequence: ${input.sequence}`,
      status: 'stale',
    };
  }

  coreDb.sqlite
    .prepare(
      `
      INSERT INTO worker_control_sequence_fingerprints (
        workspace_id,
        thread_id,
        turn_id,
        agent_session_id,
        package_snapshot_id,
        request_id,
        operation,
        sequence,
        fingerprint,
        accepted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      input.lineage.workspaceId,
      input.lineage.threadId,
      input.lineage.turnId,
      input.lineage.agentSessionId,
      input.lineage.packageSnapshotId,
      input.lineage.requestId ?? null,
      input.operation,
      input.sequence,
      input.fingerprint,
      new Date().toISOString()
    );

  return {
    nextExpectedSequence: nextExpectedSequence(coreDb, input),
    status: 'accepted',
  };
}

/**
 * Reads the highest accepted sequence for one worker-control operation stream.
 *
 * @param coreDb Server-scope Core database.
 * @param input Sequence stream selector.
 * @returns Highest sequence, or null when none exists.
 */
function highestAcceptedSequence(
  coreDb: CoreDb,
  input: WorkerControlSequenceRecorderInput
): number | null {
  const row = coreDb.sqlite
    .prepare(
      `
      SELECT MAX(sequence) AS highest
      FROM worker_control_sequence_fingerprints
      WHERE agent_session_id = ?
        AND package_snapshot_id = ?
        AND operation = ?
      `
    )
    .get(input.lineage.agentSessionId, input.lineage.packageSnapshotId, input.operation) as
    | { highest: number | null }
    | undefined;

  return row?.highest ?? null;
}

/**
 * Computes the durable next expected sequence for one operation stream.
 *
 * @param coreDb Server-scope Core database.
 * @param input Sequence stream selector.
 * @returns Next sequence after the durable high-watermark, or zero before any sequence.
 */
function nextExpectedSequence(coreDb: CoreDb, input: WorkerControlSequenceRecorderInput): number {
  const highest = highestAcceptedSequence(coreDb, input);

  return highest === null ? 0 : highest + 1;
}

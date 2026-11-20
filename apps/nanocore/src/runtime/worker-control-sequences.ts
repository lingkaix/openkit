import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import type {
  WorkerControlSequenceRecorder,
  WorkerControlSequenceRecorderInput,
  WorkerControlSequenceRecorderResult,
} from './worker-control-gateway.js';

/** Admitted SQLite connection for retained Worker sequence fingerprints. */
type WorkerControlSequenceDb = { readonly sqlite: Database.Database };

/**
 * Creates a SQLite recorder for retained Worker control sequence fingerprints.
 *
 * @param owner Admitted SQLite handle for the fingerprint table.
 * @returns Durable sequence recorder.
 */
export function createWorkerControlSequenceRecorder(
  owner: WorkerControlSequenceDb
): WorkerControlSequenceRecorder {
  return {
    accept(input) {
      return acceptWorkerControlSequence(owner, input);
    },
  };
}

/**
 * Accepts or rejects one Worker control sequence fingerprint against durable state.
 *
 * The caller supplies the writer transaction when this observation is part of a Worker record.
 *
 * @param owner Admitted SQLite handle for the fingerprint table.
 * @param input Sequence fingerprint input.
 * @returns Durable accept or reject outcome.
 */
export function acceptWorkerControlSequence(
  owner: WorkerControlSequenceDb,
  input: WorkerControlSequenceRecorderInput
): WorkerControlSequenceRecorderResult {
  const duplicate = matchesAcceptedWorkerControlSequence(owner, input);
  if (duplicate !== null) {
    if (!duplicate) {
      return {
        code: 'worker_control_sequence_conflict',
        message: `Worker control ${input.operation} sequence already accepted with different content: ${input.sequence}`,
        status: 'conflict',
      };
    }

    return {
      duplicate: true,
      nextExpectedSequence: nextExpectedSequence(owner, input),
      status: 'accepted',
    };
  }

  const highest = highestAcceptedSequence(owner, input);

  if (highest !== null && input.sequence < highest) {
    return {
      code: 'worker_control_sequence_stale',
      message: `Worker control ${input.operation} sequence is older than the latest accepted sequence: ${input.sequence}`,
      status: 'stale',
    };
  }

  owner.sqlite
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
    duplicate: false,
    nextExpectedSequence: nextExpectedSequence(owner, input),
    status: 'accepted',
  };
}

/** Compares a retained observation without accepting a new sequence or changing liveness. */
export function matchesAcceptedWorkerControlSequence(
  owner: WorkerControlSequenceDb,
  input: WorkerControlSequenceRecorderInput
): boolean | null {
  const existing = owner.sqlite
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
  if (!existing) return null;
  // Stored JSON is original evidence. Malformed data cannot prove an exact replay.
  try {
    return isDeepStrictEqual(JSON.parse(existing.fingerprint), JSON.parse(input.fingerprint));
  } catch {
    return false;
  }
}

/**
 * Reads the highest accepted sequence for one worker-control operation stream.
 *
 * @param owner Admitted SQLite handle for the fingerprint table.
 * @param input Sequence stream selector.
 * @returns Highest sequence, or null when none exists.
 */
function highestAcceptedSequence(
  owner: WorkerControlSequenceDb,
  input: WorkerControlSequenceRecorderInput
): number | null {
  const row = owner.sqlite
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
 * @param owner Admitted SQLite handle for the fingerprint table.
 * @param input Sequence stream selector.
 * @returns Next sequence after the durable high-watermark, or zero before any sequence.
 */
function nextExpectedSequence(
  owner: WorkerControlSequenceDb,
  input: WorkerControlSequenceRecorderInput
): number {
  const highest = highestAcceptedSequence(owner, input);

  return highest === null ? 0 : highest + 1;
}

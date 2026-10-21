import type { FsStore } from '../lib/store.js';
import type { WorkspaceDb } from './db.js';
import {
  readWorkObservations,
  readWorkObservationTurnBinding,
  type WorkObservationRecord,
} from './work-observations.js';

/**
 * Verifies the reap snapshot committed with native terminalization; never repairs it after acknowledgement.
 *
 * @param workspaceDb Existing Workspace database for the recovered Turn.
 * @param turn Authoritative Turn returned by governed-worker terminalization.
 * @param reason Recovery basis: pre-anchor failure or anchored cleanup.
 * @returns The first committed reap snapshot, or null for another owner or never-recorded Turn.
 * @throws When the terminal tuple lacks its required reap snapshot.
 */
export function appendRecoveredTurnObservation(
  workspaceDb: WorkspaceDb,
  turn: ReturnType<FsStore['getTurnById']>,
  _reason: 'pre-anchor' | 'anchored-cleanup'
): WorkObservationRecord | null {
  if (turn.error?.code !== 'worker_governance_restart_recovery') return null;
  const owner = { threadId: turn.threadId, turnId: turn.id };
  const binding = readWorkObservationTurnBinding(workspaceDb, owner);
  if (!binding.coverage) return null;
  const rows = readWorkObservations(workspaceDb, owner);
  const id = `turn.reap:${turn.id}`;
  const existing = rows.find((row) => row.id === id);
  // Late observations must not change the snapshot or conflict with this one-time decision.
  if (existing) {
    if (existing.type !== 'turn.reap')
      throw new Error('recovery_required: turn.reap observation identity belongs to another type');
    return existing;
  }
  throw new Error(
    'recovery_required: native recovery terminal lacks its atomic turn.reap snapshot'
  );
}

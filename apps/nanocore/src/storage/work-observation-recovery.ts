import { WorkerObservationDataSchema } from '@openkit/worker-protocol';
import type { FsStore } from '../lib/store.js';
import type { WorkspaceDb } from './db.js';
import {
  appendWorkObservation,
  readWorkObservations,
  readWorkObservationTurnBinding,
  type WorkObservationRecord,
} from './work-observations.js';

/** Observed call identity retained without arguments, response bodies or effect conclusions. */
interface UnresolvedCall {
  readonly corr: string;
  readonly type: string;
  readonly name: string | null;
  readonly ts: string;
}

/**
 * Records the already-terminalized restart recovery decision using historical Turn admission.
 *
 * @param workspaceDb Existing Workspace database for the recovered Turn.
 * @param turn Authoritative Turn returned by governed-worker terminalization.
 * @param reason Recovery basis: pre-anchor failure or anchored cleanup.
 * @returns The first committed reap snapshot, or null for another owner or never-recorded Turn.
 * @throws When required retained evidence cannot be read or appended; scheduler recovery retries it.
 */
export function appendRecoveredTurnObservation(
  workspaceDb: WorkspaceDb,
  turn: ReturnType<FsStore['getTurnById']>,
  reason: 'pre-anchor' | 'anchored-cleanup'
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
  if (
    binding.turn.error?.code !== 'worker_governance_restart_recovery' ||
    !['failed', 'interrupted'].includes(binding.turn.status) ||
    !binding.turn.completedAt
  )
    throw new Error('recovery_required: turn.reap requires the durable restart recovery terminal');
  return appendWorkObservation(workspaceDb, {
    ...owner,
    bodies: [],
    observation: {
      id,
      type: 'turn.reap',
      ts: binding.turn.completedAt,
      obs: 'core',
      ret: 'turn-evidence',
      payload: {
        reason,
        lastObservedTs: rows.at(-1)?.ts ?? null,
        unresolvedCalls: unresolvedCalls(rows),
        inferredBy: 'scheduler-restart-recovery',
      },
    },
  }).observation;
}

/** Pairs actual gateway requests and runtime tool phases within this Turn's committed ledger. */
function unresolvedCalls(rows: readonly WorkObservationRecord[]): readonly UnresolvedCall[] {
  const calls = new Map<string, UnresolvedCall>();
  for (const row of rows) {
    if (row.type === 'model.observed' && row.corr) {
      if (row.payload.direction === 'request') {
        const key = JSON.stringify([row.type, row.corr, row.id]);
        calls.set(key, { corr: row.corr, type: row.type, name: null, ts: row.ts });
      } else if (
        row.payload.direction === 'response' &&
        row.parent &&
        ['done', 'error', 'interrupted', 'truncated', 'failed'].includes(String(row.payload.event))
      ) {
        // Several attempts share corr; a terminal names only its own request through parent.
        const key = JSON.stringify([row.type, row.corr, row.parent]);
        calls.delete(key);
      }
    } else if (row.type === 'runtime.observed') {
      const { fact } = WorkerObservationDataSchema.parse(row.payload);
      if (fact.kind !== 'tool' || !fact.callRef) continue;
      // The runtime producer retains callRef instead of a top-level corr; reuse that observed id.
      const corr = row.corr ?? fact.callRef;
      const key = JSON.stringify([row.type, corr]);
      if (['completed', 'failed', 'interrupted', 'closed'].includes(fact.phase ?? '')) {
        calls.delete(key);
      } else if (['started', 'running', 'updated'].includes(fact.phase ?? '')) {
        const previous = calls.get(key);
        calls.set(key, {
          corr,
          type: row.type,
          name: previous?.name ?? fact.toolName ?? null,
          ts: previous?.ts ?? row.ts,
        });
      }
    }
  }
  return [...calls.values()];
}

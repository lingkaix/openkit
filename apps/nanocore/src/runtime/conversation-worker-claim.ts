import { isDeepStrictEqual } from 'node:util';
import type { Turn } from '@openkit/protocol';
import type { FsStore } from '../lib/store.js';
import { listSchedulerAdmissionEntriesForWorkspace } from '../scheduler-records.js';
import { admitCoreScheduler } from '../storage/control-store-admission.js';
import type { CoreDb } from '../storage/db.js';
import { listSchedulerExecutionAttemptsForTurn } from './execution-attempts.js';
import { TurnStartValidationError } from './orchestrator.js';

/**
 * Projects the selected-Worker conversation status Item from the durable Turn outcome.
 *
 * The conversation command receipt stays `accepted`; only the status Item and explanation
 * name a failed or interrupted Worker Turn. Summaries are fixed product-safe text and never
 * copy Turn.error, which may carry Worker, backend, or cleanup diagnostics.
 *
 * @param turn Durable Worker Turn after its unique terminal outcome.
 * @param agentId Selected Worker identity used by the successful continuation summary.
 * @returns Status Item fields and explanation for the live write and exact replay.
 */
export function conversationWorkerTurnPresentation(
  turn: Pick<Turn, 'status'>,
  agentId: string
): {
  readonly level: 'info' | 'warning';
  readonly title: string;
  readonly summary: string;
  readonly explanation: string;
} {
  if (turn.status === 'failed') {
    return {
      level: 'warning',
      title: 'Worker Turn failed',
      summary: 'Worker turn ended without success.',
      explanation: 'The selected Worker failed the conversation Turn.',
    };
  }
  if (turn.status === 'interrupted') {
    return {
      level: 'warning',
      title: 'Worker Turn interrupted',
      summary: 'Worker turn ended without success.',
      explanation: 'The selected Worker interrupted the conversation Turn.',
    };
  }
  return {
    level: turn.status === 'completed' ? 'info' : 'warning',
    title: 'Worker Turn accepted',
    summary: `Conversation continued with ${agentId}.`,
    explanation: 'The selected Worker accepted the conversation Turn.',
  };
}

/** Cancels only the original queued admission if it races an explicit interruption of its unbound claim. */
export async function reconcileInterruptedConversationWorkerClaim(
  coreDb: CoreDb,
  store: FsStore,
  turnId: string,
  requestId: string
): Promise<void> {
  const turn = store.getTurnById(turnId);
  if (
    turn.owner.kind !== 'workspace' ||
    turn.status !== 'interrupted' ||
    turn.error?.code !== 'turn_cancelled' ||
    turn.agentSessionId
  )
    return;
  const entries = listSchedulerAdmissionEntriesForWorkspace(coreDb, {
    workspaceId: turn.owner.workspaceId,
    statuses: ['queued', 'denied', 'admitted', 'cancelled', 'expired'],
  }).filter((entry) => entry.turnId === turn.id && entry.threadId === turn.threadId);
  for (const entry of entries) {
    if (
      entry.requestId !== requestId ||
      !isDeepStrictEqual(entry.triggerActor, turn.triggerActor) ||
      entry.requestedAgentId !== turn.agentId
    )
      throw new TurnStartValidationError(
        'recovery_required',
        'The interrupted claim has conflicting admission evidence. Inspect this Turn.',
        409
      );
    if (entry.status !== 'queued' && entry.status !== 'denied') continue;
    if (
      listSchedulerExecutionAttemptsForTurn(coreDb, {
        workspaceId: turn.owner.workspaceId,
        threadId: turn.threadId,
        turnId,
      }).some((attempt) => attempt.phase !== 'closed')
    )
      throw new TurnStartValidationError(
        'recovery_required',
        'Worker admission raced interruption. Retry this interruption request to reconcile it.',
        409
      );
    await admitCoreScheduler(coreDb, {
      mode: 'cancel',
      queueEntryId: entry.queueEntryId,
      workspaceId: turn.owner.workspaceId,
    });
  }
}

import { isDeepStrictEqual } from 'node:util';
import type { AutomationOccurrence } from '@openkit/app-api-schemas';
import type { TurnSchema } from '@openkit/protocol';
import type { FsStore } from '../lib/store.js';
import type { SchedulerAdmissionEntryRecord } from '../scheduler-records.js';
import { readPublishedTurnFileRecords } from '../storage/workspace-file-records.js';

/** Canonical protocol Turn consumed by the publication checks. */
type Turn = import('zod').infer<typeof TurnSchema>;

/** Checks the accepted source tuple against a canonical Turn without consulting derivative caches. */
export function recurringCanonicalTurnPublicationIssue(
  entry: SchedulerAdmissionEntryRecord,
  turn: Turn | null
): AutomationOccurrence['publicationIssue'] {
  if (!turn) return 'turn_missing';
  if (
    turn.id !== entry.turnId ||
    turn.workspaceId !== entry.workspaceId ||
    turn.threadId !== entry.threadId ||
    turn.agentId !== entry.requestedAgentId ||
    !isDeepStrictEqual(turn.triggerActor, entry.triggerActor) ||
    turn.reasoningEffort !== entry.reasoningEffort ||
    (entry.status === 'queued' && (turn.status !== 'pending' || turn.agentSessionId))
  )
    return 'turn_contradictory';
  return null;
}

/** Checks canonical publication and the exact cache consumed by native dispatch and cancellation. */
export function recurringTurnPublicationIssue(
  store: FsStore,
  entry: SchedulerAdmissionEntryRecord
): AutomationOccurrence['publicationIssue'] {
  try {
    const dataRoot = store.getDataRoot();
    if (!dataRoot) return 'turn_missing';
    const turn = readPublishedTurnFileRecords(
      dataRoot,
      entry.workspaceId,
      entry.threadId,
      entry.turnId
    )?.turn;
    const issue = recurringCanonicalTurnPublicationIssue(entry, turn ?? null);
    if (issue) return issue;
    // Native consumers use the Store Turn; export uses the canonical Turn directly.
    if (!isDeepStrictEqual(store.getTurn(entry.workspaceId, entry.threadId, entry.turnId), turn))
      return 'turn_contradictory';
    return null;
  } catch {
    return 'turn_contradictory';
  }
}

import { isDeepStrictEqual } from 'node:util';
import type { AutomationOccurrence } from '@openkit/app-api-schemas';
import { type FsStore, StoreRecordNotFoundError } from '../lib/store.js';
import type { SchedulerAdmissionEntryRecord } from '../scheduler-records.js';

/** Inspects an already-proved accepted source tuple without reconstructing or synchronizing files. */
export function recurringTurnPublicationIssue(
  store: FsStore,
  entry: SchedulerAdmissionEntryRecord
): AutomationOccurrence['publicationIssue'] {
  try {
    const turn = store.getTurn(entry.workspaceId, entry.threadId, entry.turnId);
    if (
      turn.agentId !== entry.requestedAgentId ||
      !isDeepStrictEqual(turn.triggerActor, entry.triggerActor) ||
      turn.reasoningEffort !== entry.reasoningEffort ||
      (entry.status === 'queued' && (turn.status !== 'pending' || turn.agentSessionId))
    )
      return 'turn_contradictory';
    return null;
  } catch (error) {
    if (error instanceof StoreRecordNotFoundError) return 'turn_missing';
    throw error;
  }
}

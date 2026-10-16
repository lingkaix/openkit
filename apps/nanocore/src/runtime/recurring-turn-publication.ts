import { isDeepStrictEqual } from 'node:util';
import type { AutomationOccurrence } from '@openkit/app-api-schemas';
import type { FsStore } from '../lib/store.js';
import type { SchedulerAdmissionEntryRecord } from '../scheduler-records.js';
import { readPublishedTurnRecord } from '../storage/workspace-file-records.js';

/** Inspects an already-proved accepted source tuple without reconstructing or synchronizing files. */
export function recurringTurnPublicationIssue(
  store: FsStore,
  entry: SchedulerAdmissionEntryRecord
): AutomationOccurrence['publicationIssue'] {
  try {
    const dataRoot = store.getDataRoot();
    if (!dataRoot) return 'turn_missing';
    const turn = readPublishedTurnRecord(dataRoot, entry.workspaceId, entry.threadId, entry.turnId);
    if (!turn) return 'turn_missing';
    if (
      turn.agentId !== entry.requestedAgentId ||
      !isDeepStrictEqual(turn.triggerActor, entry.triggerActor) ||
      turn.reasoningEffort !== entry.reasoningEffort ||
      (entry.status === 'queued' && (turn.status !== 'pending' || turn.agentSessionId))
    )
      return 'turn_contradictory';
    return null;
  } catch {
    return 'turn_contradictory';
  }
}

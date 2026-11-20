import { isDeepStrictEqual } from 'node:util';
import type { AutomationOccurrence } from '@openkit/app-api-schemas';
import type { TurnSchema } from '@openkit/protocol';
import { workspaceIdForOwner } from '@openkit/protocol';
import type { FsStore } from '../lib/store.js';
import type { CoreSchedulerQueueEntry } from '../scheduler-records.js';
import { readPublishedTurnFileRecords } from '../storage/workspace-file-records.js';

/** Canonical protocol Turn consumed by the publication checks. */
type Turn = import('zod').infer<typeof TurnSchema>;

interface ActiveRecurringPublication {
  readonly dataRoot: string;
  awaiting?: {
    readonly since: string;
    readonly readback: () => boolean;
    readonly confirmed: () => void;
  };
}

const activePublications = new Map<string, ActiveRecurringPublication>();

/** Keeps Core cancellation and the Workspace publication from passing each other across the two stores. */
export function enterRecurringTurnPublication(dataRoot: string, queueEntryId: string) {
  const key = JSON.stringify([dataRoot, queueEntryId]);
  if (activePublications.has(key)) return null;
  const publication: ActiveRecurringPublication = { dataRoot };
  activePublications.set(key, publication);
  return {
    release: () => activePublications.delete(key),
    awaitReadback(readback: () => boolean, since: string) {
      const confirmed = Promise.withResolvers<void>();
      publication.awaiting = { readback, since, confirmed: confirmed.resolve };
      return confirmed.promise;
    },
  };
}

/** Reports the age only while exact posted delivery is unresolved in this Data Root owner. */
export function recurringPublicationUncertainSince(
  dataRoot: string,
  queueEntryId: string
): string | undefined {
  return activePublications.get(JSON.stringify([dataRoot, queueEntryId]))?.awaiting?.since;
}

/** Reuses the scanner to confirm the exact durable effect of a timed-out publication step. */
export function inspectRecurringPublicationSettlements(
  dataRoot: string,
  onError?: (error: unknown) => void
): void {
  for (const publication of activePublications.values()) {
    if (publication.dataRoot !== dataRoot || !publication.awaiting) continue;
    try {
      if (publication.awaiting.readback()) publication.awaiting.confirmed();
    } catch (error) {
      onError?.(error);
    }
  }
}

/** Checks the accepted source tuple against a canonical Turn without consulting derivative caches. */
export function recurringCanonicalTurnPublicationIssue(
  entry: CoreSchedulerQueueEntry,
  turn: Turn | null
): AutomationOccurrence['publicationIssue'] {
  if (!turn) return 'turn_missing';
  if (
    turn.id !== entry.turnId ||
    workspaceIdForOwner(turn.owner) !== entry.workspaceId ||
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
  entry: CoreSchedulerQueueEntry
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

import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { CoreSchedulerQueueEntry } from '../scheduler-records.js';
import type { CoreDb } from '../storage/db.js';
import {
  findAcceptedRecurringOccurrenceForQueue,
  RecurringAdmissionPayloadSchema,
  type RecurringOccurrence,
} from '../storage/recurring-records.js';
import { readWorkspaceQueueInput } from '../storage/workspace-queue-inputs.js';

export const StoredRecurringQueueInputSchema = z.object({
  schemaVersion: z.literal(1),
  occurrenceId: z.string().min(1),
  definitionRevision: z.number().int().positive(),
  text: z.string(),
  preparation: RecurringAdmissionPayloadSchema,
});

/** Reads the accepted occurrence's original staged input before Turn publication or dispatch. */
export function readRecurringQueueInput(
  dataRoot: string,
  entry: CoreSchedulerQueueEntry,
  occurrence: RecurringOccurrence
): string | null {
  const staged = readWorkspaceQueueInput(dataRoot, entry, entry.inputRef);
  if (!staged || staged.originalInvocationId !== occurrence.requestId) return null;
  const decoded = StoredRecurringQueueInputSchema.parse(JSON.parse(staged.text));
  return decoded.occurrenceId === occurrence.id &&
    decoded.definitionRevision === occurrence.definitionRevision &&
    decoded.text === occurrence.snapshot.prompt &&
    isDeepStrictEqual(decoded.preparation, occurrence.resolvedPayload)
    ? decoded.text
    : null;
}

/**
 * Reads the accepted occurrence's input when the scheduler entry came from a recurrence.
 * Recurring admissions use the occurrence request ID as both Core identities.
 */
export function readScheduledRecurringQueueInput(coreDb: CoreDb, entry: CoreSchedulerQueueEntry) {
  const occurrence = findAcceptedRecurringOccurrenceForQueue(coreDb, entry.queueEntryId);
  if (occurrence) return readRecurringQueueInput(coreDb.dataRoot, entry, occurrence);
  if (entry.triggerActor.kind === 'automation' && entry.queueEntryId === entry.requestId)
    return null;
  return undefined;
}

/** Checks exact recurring admission authority before inspecting its publication. */
export function isRecurringQueueEntry(coreDb: CoreDb, queueEntryId: string): boolean {
  return findAcceptedRecurringOccurrenceForQueue(coreDb, queueEntryId) !== null;
}

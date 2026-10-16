import {
  AutomationAttemptCodeSchema,
  AutomationDefinitionSnapshotSchema,
  AutomationOccurrenceSchema,
  AutomationExpiredRangeSchema,
  MaterializedWorkspaceRootSchema,
} from '@openkit/app-api-schemas';
import { ReasoningEffortSchema } from '@openkit/protocol';
import { uuidv5 } from '../generative-kernel/uuid.js';
import {
  requireSchedulerAdmissionEntry,
  schedulerAdmissionInputHash,
  type CreateSchedulerAdmissionEntryInput,
} from '../scheduler-records.js';
import type { CoreDb } from './db.js';
import { z } from 'zod';

/** Exact complete scheduler payload frozen by the first successful selection resolution. */
export const RecurringAdmissionPayloadSchema = z.object({
  backendId: z.string().min(1),
  requestedAgentId: z.string().min(1),
  profileRef: z.string().min(1).nullable(),
  modelId: z.string().min(1),
  workspaceCwd: z.string().min(1).nullable(),
  workspaceRoots: z.array(MaterializedWorkspaceRootSchema),
  reasoningEffort: ReasoningEffortSchema.optional(),
  requiredFeatures: z.array(z.never()).optional(),
});
/** Closed trigger outcome codes; summaries never contain dependency exception text. */
export const RecurringAttemptCodeSchema = AutomationAttemptCodeSchema;
/** Immutable authored request shared by individual occurrences and expired ranges. */
export const RecurringDefinitionSnapshotSchema = AutomationDefinitionSnapshotSchema;
/** Durable admission history for exactly one nominal UTC instant. */
export const RecurringOccurrenceSchema = AutomationOccurrenceSchema.omit({
  resolvedSelection: true,
  schedulerStatus: true,
}).extend({
  resolvedPayload: RecurringAdmissionPayloadSchema.nullable(),
  requiredFeatures: z.array(z.never()).optional(),
});
/** Lossless, immutable old-definition coverage for an arbitrary outage interval. */
export const ExpiredOccurrenceRangeSchema = AutomationExpiredRangeSchema.extend({
  requiredFeatures: z.array(z.never()).optional(),
});
/** Frozen scheduler request, including complete root selection. */
export type RecurringAdmissionPayload = z.infer<typeof RecurringAdmissionPayloadSchema>;
/** Individual durable occurrence. */
export type RecurringOccurrence = z.infer<typeof RecurringOccurrenceSchema>;
/** Bounded missed-history record. */
export type ExpiredOccurrenceRange = z.infer<typeof ExpiredOccurrenceRangeSchema>;
/** Typed committed attempt outcome. */
export type RecurringAttemptCode = z.infer<typeof RecurringAttemptCodeSchema>;
/** Bounded pre-admission result; no worker or external-effect handle is accepted. */
export type RecurringPreparation =
  | { readonly kind: 'ready'; readonly payload: RecurringAdmissionPayload }
  | {
      readonly kind: 'failure';
      readonly code: Exclude<RecurringAttemptCode, 'accepted'>;
      readonly payload?: RecurringAdmissionPayload;
    }
  | { readonly kind: 'recovery_required' };

/** Stable request UUID in the existing RFC URL namespace over the canonical schedule/instant pair. */
export function recurringRequestId(scheduleId: string, scheduledAt: string): string {
  return uuidv5(JSON.stringify([scheduleId, scheduledAt]));
}

/** Enforces identity, deadline and attempt bounds before trigger history can authorize effects. */
export function readRecurringOccurrence(json: string): RecurringOccurrence {
  const record = RecurringOccurrenceSchema.parse(JSON.parse(json));
  if (
    record.id !== `occ_${recurringRequestId(record.scheduleId, record.scheduledAt)}` ||
    record.requestId !== recurringRequestId(record.scheduleId, record.scheduledAt) ||
    record.snapshot.actor.id !== record.scheduleId ||
    Date.parse(record.deadline) !== Date.parse(record.scheduledAt) + 600_000 ||
    record.attempts.some((attempt, index) => attempt.number !== index + 1)
  )
    throw new Error('RecurringOccurrence violates its durable identity or attempt contract.');
  return record;
}

/** Builds the one exact queue primitive input for admission and later native tuple verification. */
export function recurringSchedulerAdmissionInput(
  occurrence: RecurringOccurrence,
  payload: RecurringAdmissionPayload,
  timestamp: string
): CreateSchedulerAdmissionEntryInput {
  return {
    ...payload,
    queueEntryId: `queue_recurring_${occurrence.requestId}`,
    requestId: occurrence.requestId,
    workspaceId: occurrence.workspaceId,
    threadId: occurrence.snapshot.threadId,
    turnId: `turn_recurring_${occurrence.requestId}`,
    turnInput: occurrence.snapshot.prompt,
    triggerActor: occurrence.snapshot.actor,
    now: () => timestamp,
  };
}

/** Reads exact accepted producer authority before scheduler boot or dispatch without assembling a mutation owner. */
export function findAcceptedRecurringOccurrenceForQueue(
  coreDb: CoreDb,
  queueEntryId: string
): RecurringOccurrence | null {
  const row = coreDb.sqlite
    .prepare(`SELECT record_json FROM recurring_occurrences
    WHERE queue_entry_id = ? AND state = 'admission-accepted'`)
    .get(queueEntryId) as { record_json: string } | undefined;
  if (!row) return null;
  const occurrence = readRecurringOccurrence(row.record_json);
  if (!occurrence.resolvedPayload)
    throw new Error('Accepted RecurringOccurrence has no exact admission payload.');
  const request = recurringSchedulerAdmissionInput(
    occurrence,
    occurrence.resolvedPayload,
    occurrence.createdAt
  );
  const entry = requireSchedulerAdmissionEntry(coreDb, queueEntryId);
  const expectedHash = schedulerAdmissionInputHash(request);
  if (
    queueEntryId !== request.queueEntryId ||
    occurrence.queueEntryId !== queueEntryId ||
    occurrence.turnId !== request.turnId ||
    entry.inputHash !== expectedHash ||
    schedulerAdmissionInputHash(entry) !== expectedHash
  )
    throw new Error('Accepted RecurringOccurrence contradicts its scheduler admission.');
  return occurrence;
}

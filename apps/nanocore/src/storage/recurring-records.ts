import { type AutomationRecord, MaterializedWorkspaceRootSchema } from '@openkit/app-api-schemas';
import { deriveEntityId, ReasoningEffortSchema, readRetainedV1 } from '@openkit/protocol';
import { z } from 'zod';
import { uuidv5 } from '../generative-kernel/uuid.js';
import {
  recurringNominalMatches,
  validateRecurringRangeCoverage,
} from '../lib/recurring-cadence.js';
import {
  type CreateSchedulerAdmissionEntryInput,
  requireSchedulerAdmissionEntry,
  schedulerAdmissionInputHash,
} from '../scheduler-records.js';
import type { CoreDb } from './db.js';
import {
  StoredRecurringAttemptCodeV1Schema,
  StoredRecurringDefinitionSnapshotV1Schema,
  StoredRecurringExpiredRangeV1Schema,
  StoredRecurringOccurrenceV1Schema,
  StoredRecurringScheduleV1Schema,
} from './recurring-retained-v1.js';

/** Fixed admission deadline measured from the original nominal instant. */
export const RECURRING_DEADLINE_MS = 600_000;

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
/** Closed native v1 attempt outcomes, independent of current operation projections. */
export const RecurringAttemptCodeSchema = StoredRecurringAttemptCodeV1Schema;
/** Fixed native snapshot shared by occurrence and expired-range history. */
export const RecurringDefinitionSnapshotSchema = StoredRecurringDefinitionSnapshotV1Schema;
/** Fixed native occurrence payload before exact identity and attempt-sequence checks. */
export const RecurringOccurrenceSchema = StoredRecurringOccurrenceV1Schema;
/** Fixed native range plus its unchanged exact coverage predicates. */
export const ExpiredOccurrenceRangeSchema = StoredRecurringExpiredRangeV1Schema.superRefine(
  (record, context) => {
    try {
      validateRecurringRangeCoverage(record);
      if (record.snapshot.actor.id !== record.scheduleId)
        throw new Error('Contradictory expired range actor.');
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'Expired recurring range contradicts its exact cadence or snapshot.',
      });
    }
  }
);
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
    record.id !== deriveEntityId('occ', [record.scheduleId, record.scheduledAt]) ||
    record.requestId !== recurringRequestId(record.scheduleId, record.scheduledAt) ||
    record.snapshot.actor.id !== record.scheduleId ||
    (record.snapshot.monthlyUtc !== undefined &&
      !recurringNominalMatches(
        { monthlyUtc: record.snapshot.monthlyUtc },
        Date.parse(record.scheduledAt)
      )) ||
    Date.parse(record.deadline) !== Date.parse(record.scheduledAt) + RECURRING_DEADLINE_MS ||
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
  const { reasoningEffort, requiredFeatures: _requiredFeatures, ...resolved } = payload;
  return {
    ...resolved,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    queueEntryId: occurrence.requestId,
    requestId: occurrence.requestId,
    workspaceId: occurrence.workspaceId,
    threadId: occurrence.snapshot.threadId,
    turnId: deriveEntityId('tu', ['recurring', occurrence.scheduleId, occurrence.scheduledAt]),
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
    .prepare(`SELECT schema_version AS schemaVersion, record_json FROM recurring_occurrences
    WHERE queue_entry_id = ? AND state = 'admission-accepted'`)
    .get(queueEntryId) as { schemaVersion: unknown; record_json: string } | undefined;
  if (!row) return null;
  const occurrence = readRetainedV1(row, () => readRecurringOccurrence(row.record_json));
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

/** Retained descriptive additions are ignored; unsupported required semantics fail closed. */
export function readRecurringSchedule(json: string): AutomationRecord {
  const value = JSON.parse(json);
  if (
    value.requiredFeatures !== undefined &&
    (!Array.isArray(value.requiredFeatures) || value.requiredFeatures.length)
  )
    throw new Error('RecurringSchedule has unsupported required semantics.');
  const { requiredFeatures: _requiredFeatures, ...record } =
    StoredRecurringScheduleV1Schema.parse(value);
  if (
    record.actor.id !== record.id ||
    record.actor.responsibleUserId !== record.responsibleUserId ||
    (record.monthlyUtc !== undefined &&
      record.nextScheduledAt !== null &&
      !recurringNominalMatches(record, Date.parse(record.nextScheduledAt)))
  )
    throw new Error('RecurringSchedule has contradictory automation identity.');
  return record;
}

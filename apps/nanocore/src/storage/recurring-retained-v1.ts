import {
  AutomationIdSchema,
  ReasoningEffortSchema,
  RecurringExpiredRangeIdSchema,
  RecurringOccurrenceIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';

// SQL owns the outer markers. These fixed payloads keep retained meaning separate from wire admission.
const StoredRecurringMonthlyUtcV1Schema = z.object({
  zone: z.literal('UTC'),
  dayOfMonth: z.number().int().min(1).max(28),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  second: z.number().int().min(0).max(59),
});
const storedTiming = {
  intervalSeconds: z.number().int().min(5).optional(),
  monthlyUtc: StoredRecurringMonthlyUtcV1Schema.optional(),
};
/** Fixed v1 cadence shared by retained record decoders and native nominal arithmetic. */
export const StoredAutomationCadenceV1Schema = z
  .object(storedTiming)
  .superRefine(requireOneStoredTiming);
const storedSelections = {
  agentId: z.string().min(1).optional(),
  profileId: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
};
const StoredRecurringActorV1Schema = z.object({
  kind: z.literal('automation'),
  id: AutomationIdSchema,
  responsibleUserId: UserIdSchema,
});
const StoredRecurringWorkspaceRootV1Schema = z.discriminatedUnion('sourceKind', [
  z.object({
    id: z.string().min(1),
    sourceKind: z.enum(['host-dir', 'materialized-dir']),
    sourcePath: z.string().min(1),
    sourceCommit: z
      .string()
      .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
      .optional(),
    workerPath: z.string().min(1),
    access: z.enum(['read-only', 'read-write']),
  }),
  z.object({
    id: z.string().min(1),
    sourceKind: z.literal('remote-git'),
    sourceCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    workerPath: z.string().min(1),
    access: z.enum(['read-only', 'read-write']),
  }),
]);
/** Exact retained payload; current preparation continues to use its separate admission schema. */
export const StoredRecurringAdmissionPayloadV1Schema = z.object({
  backendId: z.string().min(1),
  requestedAgentId: z.string().min(1),
  profileRef: z.string().min(1).nullable(),
  modelId: z.string().min(1),
  workspaceCwd: z.string().min(1).nullable(),
  workspaceRoots: z.array(StoredRecurringWorkspaceRootV1Schema),
  reasoningEffort: ReasoningEffortSchema.optional(),
  requiredFeatures: z.array(z.never()).optional(),
});
/** Closed trigger outcome codes; summaries never contain dependency exception text. */
export const StoredRecurringAttemptCodeV1Schema = z.enum([
  'accepted',
  'authority_denied',
  'workspace_missing',
  'thread_missing',
  'identity_inactive',
  'selection_unavailable',
  'invalid_input',
  'preparation_failed',
  'scheduler_unavailable',
  'queue_backlog_full',
  'queue_full',
  'admission_failed',
]);
/** Immutable authored request shared by individual occurrences and expired ranges. */
export const StoredRecurringDefinitionSnapshotV1Schema = z.object({
  threadId: ThreadIdSchema,
  actor: StoredRecurringActorV1Schema,
  prompt: z.string().min(1),
  ...storedSelections,
  monthlyUtc: StoredRecurringMonthlyUtcV1Schema.optional(),
});
/** Fixed schedule payload; identity and nominal cursor checks remain in the native reader. */
export const StoredRecurringScheduleV1Schema = z
  .object({
    id: AutomationIdSchema,
    workspaceId: WorkspaceIdSchema,
    name: z.string().min(1),
    threadId: ThreadIdSchema,
    ...storedTiming,
    prompt: z.string().min(1),
    ...storedSelections,
    responsibleUserId: UserIdSchema,
    actor: StoredRecurringActorV1Schema,
    status: z.enum(['paused', 'active', 'deleted']),
    revision: z.number().int().positive(),
    nextScheduledAt: z.iso.datetime().nullable(),
    greatestAccountedScheduledAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().nullable(),
    requiredFeatures: z.array(z.never()).optional(),
  })
  .superRefine(requireOneStoredTiming);
/** Fixed occurrence payload; its native reader also checks identity, deadline and attempt order. */
export const StoredRecurringOccurrenceV1Schema = z.object({
  id: RecurringOccurrenceIdSchema,
  scheduleId: AutomationIdSchema,
  workspaceId: WorkspaceIdSchema,
  definitionRevision: z.number().int().positive(),
  scheduledAt: z.iso.datetime(),
  deadline: z.iso.datetime(),
  snapshot: StoredRecurringDefinitionSnapshotV1Schema,
  state: z.enum([
    'pending',
    'admission-accepted',
    'admission-failed',
    'expired',
    'cancelled',
    'recovery_required',
  ]),
  attempts: z
    .array(
      z.object({
        number: z.number().int().min(1).max(3),
        at: z.iso.datetime(),
        code: StoredRecurringAttemptCodeV1Schema,
        summary: z.string().min(1),
      })
    )
    .max(3),
  requestId: z.string().uuid(),
  queueEntryId: z.string().min(1).nullable(),
  turnId: TurnIdSchema.nullable(),
  createdAt: z.iso.datetime(),
  terminalAt: z.iso.datetime().nullable(),
  resolvedPayload: StoredRecurringAdmissionPayloadV1Schema.nullable(),
  requiredFeatures: z.array(z.never()).optional(),
});
/** Fixed range payload; the native range decoder also checks exact cadence coverage and actor identity. */
export const StoredRecurringExpiredRangeV1Schema = z
  .object({
    id: RecurringExpiredRangeIdSchema,
    scheduleId: AutomationIdSchema,
    workspaceId: WorkspaceIdSchema,
    definitionRevision: z.number().int().positive(),
    ...storedTiming,
    firstScheduledAt: z.iso.datetime(),
    lastScheduledAt: z.iso.datetime(),
    count: z.number().int().positive(),
    snapshot: StoredRecurringDefinitionSnapshotV1Schema,
    reason: z.literal('deadline_elapsed'),
    createdAt: z.iso.datetime(),
    terminalAt: z.iso.datetime(),
    requiredFeatures: z.array(z.never()).optional(),
  })
  .superRefine(requireOneStoredTiming);

/** Requires exactly one of the two fixed v1 timing forms. */
function requireOneStoredTiming(
  value: { intervalSeconds?: number | undefined; monthlyUtc?: unknown },
  context: z.RefinementCtx
): void {
  if ((value.intervalSeconds === undefined) === (value.monthlyUtc === undefined))
    context.addIssue({
      code: 'custom',
      message: 'Exactly one intervalSeconds or monthlyUtc timing rule is required.',
    });
}

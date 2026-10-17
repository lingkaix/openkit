import {
  AutomationIdSchema,
  RecurringExpiredRangeIdSchema,
  RecurringOccurrenceIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';

const selections = {
  agentId: z.string().min(1).optional(),
  profileId: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
};
/** Complete bounded Gregorian monthly rule; all nominal instants use literal UTC and zero milliseconds. */
export const MonthlyUtcScheduleSchema = z.object({
  zone: z.literal('UTC'),
  dayOfMonth: z.number().int().min(1).max(28),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  second: z.number().int().min(0).max(59),
});
/** Authored monthly timing, independent of elapsed duration or local time. */
export type MonthlyUtcSchedule = z.infer<typeof MonthlyUtcScheduleSchema>;

const timing = {
  intervalSeconds: z.number().int().min(5).optional(),
  monthlyUtc: MonthlyUtcScheduleSchema.optional(),
};
function requireOneTiming(
  value: z.infer<z.ZodObject<typeof timing>>,
  context: z.RefinementCtx
): void {
  if ((value.intervalSeconds === undefined) === (value.monthlyUtc === undefined))
    context.addIssue({
      code: 'custom',
      message: 'Exactly one intervalSeconds or monthlyUtc timing rule is required.',
    });
}
/** The two admitted timing shapes preserve fixed-interval retained data without an artificial monthly interval. */
export const AutomationCadenceSchema = z.object(timing).superRefine(requireOneTiming);
/** Validated fixed-interval or monthly UTC cadence fields. */
export type AutomationCadence = z.infer<typeof AutomationCadenceSchema>;

const editable = {
  name: z.string().min(1),
  threadId: ThreadIdSchema,
  ...timing,
  prompt: z.string().min(1),
  ...selections,
};

/** Shared retained fields before complete-cadence validation. */
const AutomationRecordFieldsSchema = z.object({
  id: AutomationIdSchema,
  workspaceId: WorkspaceIdSchema,
  ...editable,
  responsibleUserId: UserIdSchema,
  actor: z.object({
    kind: z.literal('automation'),
    id: AutomationIdSchema,
    responsibleUserId: UserIdSchema,
  }),
  status: z.enum(['paused', 'active', 'deleted']),
  revision: z.number().int().positive(),
  nextScheduledAt: z.iso.datetime().nullable(),
  greatestAccountedScheduledAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});

/** Durable schedule projection; the creator binding and one complete cadence are immutable history inputs. */
export const AutomationRecordSchema = AutomationRecordFieldsSchema.superRefine(requireOneTiming);

/** Workspace-authorized schedule collection. */
export const ListAutomationsResponseSchema = z.object({ items: z.array(AutomationRecordSchema) });

/** A new schedule is always paused and targets an existing Thread. */
export const CreateAutomationRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    ...editable,
    monthlyUtc: MonthlyUtcScheduleSchema.strict().optional(),
  })
  .superRefine(requireOneTiming);

/** Revision-checked edit or pause/resume; resume also requires an exact UTC instant. */
export const UpdateAutomationRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    status: z.enum(['paused', 'active']).optional(),
    scheduledAt: z.iso.datetime().optional(),
    name: editable.name.optional(),
    threadId: editable.threadId.optional(),
    intervalSeconds: timing.intervalSeconds,
    monthlyUtc: MonthlyUtcScheduleSchema.strict().optional(),
    prompt: editable.prompt.optional(),
    agentId: selections.agentId.unwrap().nullable().optional(),
    profileId: selections.profileId.unwrap().nullable().optional(),
    modelId: selections.modelId.unwrap().nullable().optional(),
  })
  .superRefine((value, context) => {
    if (value.intervalSeconds !== undefined && value.monthlyUtc !== undefined)
      context.addIssue({
        code: 'custom',
        message: 'A timing edit must supply only one complete cadence.',
      });
  });

/** Fixed-interval or monthly UTC schedule returned by NanoCore. */
export type AutomationRecord = z.infer<typeof AutomationRecordSchema>;
/** Workspace-authorized collection response. */
export type ListAutomationsResponse = z.infer<typeof ListAutomationsResponseSchema>;
/** Authored paused definition. */
export type CreateAutomationRequest = z.infer<typeof CreateAutomationRequestSchema>;
/** Revision-checked schedule mutation. */
export type UpdateAutomationRequest = z.infer<typeof UpdateAutomationRequestSchema>;

/** Immutable authored request retained by occurrences and expired ranges. */
export const AutomationDefinitionSnapshotSchema = AutomationRecordFieldsSchema.pick({
  threadId: true,
  actor: true,
  prompt: true,
  agentId: true,
  profileId: true,
  modelId: true,
  monthlyUtc: true,
});
/** Closed admission outcomes; dependency exception text never becomes public history. */
export const AutomationAttemptCodeSchema = z.enum([
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
/** Individual trigger history, with public selections and a current scheduler-status join. */
export const AutomationOccurrenceSchema = z.object({
  id: RecurringOccurrenceIdSchema,
  scheduleId: AutomationIdSchema,
  workspaceId: WorkspaceIdSchema,
  definitionRevision: z.number().int().positive(),
  scheduledAt: z.iso.datetime(),
  deadline: z.iso.datetime(),
  snapshot: AutomationDefinitionSnapshotSchema,
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
        code: AutomationAttemptCodeSchema,
        summary: z.string().min(1),
      })
    )
    .max(3),
  requestId: z.string().uuid(),
  queueEntryId: z.string().min(1).nullable(),
  turnId: TurnIdSchema.nullable(),
  createdAt: z.iso.datetime(),
  terminalAt: z.iso.datetime().nullable(),
  resolvedSelection: z
    .object({
      agentId: z.string().min(1),
      profileId: z.string().nullable(),
      modelId: z.string().min(1),
    })
    .nullable(),
  schedulerStatus: z.enum(['queued', 'admitted', 'denied', 'cancelled', 'expired']).nullable(),
  publicationIssue: z.enum(['turn_missing', 'turn_contradictory']).nullable(),
});
/** Exact missed nominal coverage; reads return a range without expanding its occurrences. */
export const AutomationExpiredRangeSchema = z
  .object({
    id: RecurringExpiredRangeIdSchema,
    scheduleId: AutomationIdSchema,
    workspaceId: WorkspaceIdSchema,
    definitionRevision: z.number().int().positive(),
    ...timing,
    firstScheduledAt: z.iso.datetime(),
    lastScheduledAt: z.iso.datetime(),
    count: z.number().int().positive(),
    snapshot: AutomationDefinitionSnapshotSchema,
    reason: z.literal('deadline_elapsed'),
    createdAt: z.iso.datetime(),
    terminalAt: z.iso.datetime(),
  })
  .superRefine(requireOneTiming);
/** Bounded newest-first history cursor uses the last returned nominal instant. */
export const AutomationHistoryRequestSchema = z.object({
  automationId: AutomationIdSchema,
  limit: z.number().int().min(1).max(128).optional(),
  before: z.iso.datetime().optional(),
});
/** Joined occurrence history and inert exact ranges; no backend or host path is exposed. */
export const AutomationHistoryResponseSchema = z.object({
  items: z.array(
    z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('occurrence'), record: AutomationOccurrenceSchema }),
      z.object({ kind: z.literal('expired-range'), record: AutomationExpiredRangeSchema }),
    ])
  ),
  nextBefore: z.iso.datetime().nullable(),
});
/** Public bounded history response. */
export type AutomationHistoryResponse = z.infer<typeof AutomationHistoryResponseSchema>;
/** Public occurrence with actual retained Turn availability, never a publication or retry grant. */
export type AutomationOccurrence = z.infer<typeof AutomationOccurrenceSchema>;

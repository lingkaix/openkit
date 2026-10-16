import { z } from 'zod';

const selections = {
  agentId: z.string().min(1).optional(),
  profileId: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
};
const editable = {
  name: z.string().min(1),
  threadId: z.string().min(1),
  intervalSeconds: z.number().int().min(5),
  prompt: z.string().min(1),
  ...selections,
};

/** Durable fixed-interval schedule projection; the creator binding is immutable. */
export const AutomationRecordSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  ...editable,
  responsibleUserId: z.string().min(1),
  actor: z.object({
    kind: z.literal('automation'),
    id: z.string().min(1),
    responsibleUserId: z.string().min(1),
  }),
  status: z.enum(['paused', 'active', 'deleted']),
  revision: z.number().int().positive(),
  nextScheduledAt: z.iso.datetime().nullable(),
  greatestAccountedScheduledAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});

/** Workspace-authorized schedule collection. */
export const ListAutomationsResponseSchema = z.object({ items: z.array(AutomationRecordSchema) });

/** A new schedule is always paused and targets an existing Thread. */
export const CreateAutomationRequestSchema = z.object({
  workspaceId: z.string().min(1),
  ...editable,
});

/** Revision-checked edit or pause/resume; resume also requires an exact UTC instant. */
export const UpdateAutomationRequestSchema = z.object({
  expectedRevision: z.number().int().positive(),
  status: z.enum(['paused', 'active']).optional(),
  scheduledAt: z.iso.datetime().optional(),
  name: editable.name.optional(),
  threadId: editable.threadId.optional(),
  intervalSeconds: editable.intervalSeconds.optional(),
  prompt: editable.prompt.optional(),
  agentId: selections.agentId.unwrap().nullable().optional(),
  profileId: selections.profileId.unwrap().nullable().optional(),
  modelId: selections.modelId.unwrap().nullable().optional(),
});

/** Fixed-interval schedule returned by NanoCore. */
export type AutomationRecord = z.infer<typeof AutomationRecordSchema>;
/** Workspace-authorized collection response. */
export type ListAutomationsResponse = z.infer<typeof ListAutomationsResponseSchema>;
/** Authored paused definition. */
export type CreateAutomationRequest = z.infer<typeof CreateAutomationRequestSchema>;
/** Revision-checked schedule mutation. */
export type UpdateAutomationRequest = z.infer<typeof UpdateAutomationRequestSchema>;

/** Immutable authored request retained by occurrences and expired ranges. */
export const AutomationDefinitionSnapshotSchema = AutomationRecordSchema.pick({
  threadId: true,
  actor: true,
  prompt: true,
  agentId: true,
  profileId: true,
  modelId: true,
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
  id: z.string().min(1),
  scheduleId: z.string().min(1),
  workspaceId: z.string().min(1),
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
  turnId: z.string().min(1).nullable(),
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
export const AutomationExpiredRangeSchema = z.object({
  id: z.string().min(1),
  scheduleId: z.string().min(1),
  workspaceId: z.string().min(1),
  definitionRevision: z.number().int().positive(),
  intervalSeconds: z.number().int().min(5),
  firstScheduledAt: z.iso.datetime(),
  lastScheduledAt: z.iso.datetime(),
  count: z.number().int().positive(),
  snapshot: AutomationDefinitionSnapshotSchema,
  reason: z.literal('deadline_elapsed'),
  createdAt: z.iso.datetime(),
  terminalAt: z.iso.datetime(),
});
/** Bounded newest-first history cursor uses the last returned nominal instant. */
export const AutomationHistoryRequestSchema = z.object({
  automationId: z.string().min(1),
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

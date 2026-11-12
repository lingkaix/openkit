import {
  ActorRefSchema,
  AgentIdSchema,
  ApprovalRequestIdSchema,
  CapabilityCallIdSchema,
  ItemIdSchema,
  ItemSchema,
  ItemStatusSchema,
  type ItemType,
  ItemTypeSchema,
  PermissionDecisionIdSchema,
  ThreadIdSchema,
  TimestampSchema,
  TurnErrorPresentationSchema,
  TurnIdSchema,
  TurnStatusSchema,
  UsageRecordSchema,
  UserInputRequestIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';

/** The sole server mirror of the entry registry; presentation and voice stay with Web. */
export const THREAD_TIMELINE_PLACEMENT = {
  'user-message': 'narrative',
  'assistant-message': 'narrative',
  'context-summary': 'step',
  reasoning: 'step',
  'artifact-reference': 'narrative',
  'command-execution': 'step',
  'approval-request': 'narrative',
  'approval-decision': 'narrative',
  'user-input-request': 'narrative',
  'user-input-response': 'narrative',
  'file-change': 'step',
  'tool-call': 'step',
  'agent-handoff': 'narrative',
  status: 'narrative',
  plan: 'narrative',
  'knowledge-injection': 'step',
  'generative-ui-reference': 'narrative',
} as const satisfies Record<ItemType, 'narrative' | 'step'>;

/** Release-coupled payload and preview limits, measured in UTF-8 JSON and body bytes respectively. */
export const THREAD_TIMELINE_LIMITS = {
  bytes: 262_144,
  previewBytes: 4_096,
  runs: 31,
  items: 50,
  digestRuns: 31,
  digestRevisions: 256,
  digestItemBytes: 65_536,
} as const;
const cursor = z.string().min(1).max(4096);
const position = z.object({ turnId: TurnIdSchema, itemId: ItemIdSchema.optional() });

/** Logical anchors do not grant source access; NanoCore resolves each through its owner. */
export const ThreadTimelineAnchorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('latest') }).strict(),
  z.object({ kind: z.literal('turn'), turnId: TurnIdSchema }).strict(),
  z.object({ kind: z.literal('item'), itemId: ItemIdSchema }).strict(),
  z
    .object({ kind: z.literal('approval-request'), approvalRequestId: ApprovalRequestIdSchema })
    .strict(),
  z
    .object({ kind: z.literal('user-input-request'), userInputRequestId: UserInputRequestIdSchema })
    .strict(),
  z.object({ kind: z.literal('attention'), rowId: z.string().min(1).max(512) }).strict(),
  z.object({ kind: z.literal('catch-up') }).strict(),
]);

/** One bounded read: run entries or original Item positions within one run, paged in either direction. */
export const ThreadTimelineInputSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
    view: z.enum(['runs', 'items']).optional(),
    turnId: TurnIdSchema.optional(),
    placement: z.enum(['all', 'narrative', 'step']).optional(),
    anchor: ThreadTimelineAnchorSchema.optional(),
    cursor: cursor.optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.cursor && (value.anchor || value.view || value.turnId || value.placement))
      context.addIssue({
        code: 'custom',
        message: 'A cursor carries its original window selectors.',
      });
    if (!value.cursor && (value.view ?? 'runs') === 'items' && !value.turnId)
      context.addIssue({ code: 'custom', message: 'An Item window requires its exact run.' });
    if (!value.cursor && (value.view ?? 'runs') === 'runs' && (value.turnId || value.placement))
      context.addIssue({
        code: 'custom',
        message: 'Run windows do not accept Item-window selectors.',
      });
    if (!value.cursor && (value.view ?? 'runs') === 'runs' && (value.limit ?? 31) > 31)
      context.addIssue({ code: 'custom', message: 'A run window contains at most 31 entries.' });
  });

/** Complete small Items retain their protocol reader; large Items expose only a truthful bounded head or tail. */
export const TimelineItemDetailSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('complete'),
    value: ItemSchema.refine(
      (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 4096,
      'Complete Item exceeds the preview budget.'
    ),
  }),
  z.object({
    kind: z.literal('preview'),
    text: z
      .string()
      .refine(
        (value) => new TextEncoder().encode(value).byteLength <= 4096,
        'Preview exceeds its UTF-8 byte budget.'
      ),
    field: z.enum(['text', 'output', 'result', 'content', 'json']),
    sizeBytes: z.number().int().nonnegative(),
    side: z.enum(['head', 'tail']),
    truncated: z.boolean(),
  }),
]);

/** Same-Turn input delivery is receipt evidence, never a claim that the model read or applied it. */
export const TimelineSteerStateSchema = z.object({
  requestId: z.string().min(1).max(128),
  state: z.enum(['sending', 'accepted', 'not-delivered', 'unknown']),
  reason: z.string().max(512).nullable(),
});

/** Recorded MCP policy only; absence is not permission and a pending approval is not denial. */
export const TimelinePolicyBadgeSchema = z.object({
  outcome: z.enum(['allowed', 'denied', 'waiting-approval']),
  permissionDecisionId: PermissionDecisionIdSchema,
  capabilityCallId: CapabilityCallIdSchema,
  connectionRef: z.string().max(512).nullable(),
});

/** One recorded plan-step interval, counted by original publication positions rather than clocks. */
export const TimelinePlanSegmentsSchema = z.object({
  segments: z
    .array(
      z.object({
        planItemId: ItemIdSchema,
        planRevision: z.number().int().positive(),
        stepId: z.string().min(1).max(128),
        title: z.string().max(256),
        startSequence: z.number().int().positive(),
        endSequence: z.number().int().positive().nullable(),
        steps: z.number().int().nonnegative(),
      })
    )
    .max(8),
  coverage: z.enum(['complete', 'partial']),
});

/** An addressed Item's exact lineage accompanies both complete and bounded representations. */
export const TimelineItemSchema = z.object({
  id: ItemIdSchema,
  turnId: TurnIdSchema,
  type: ItemTypeSchema,
  placement: z.enum(['narrative', 'step']),
  status: ItemStatusSchema,
  createdAt: TimestampSchema,
  completedAt: TimestampSchema.nullable(),
  actor: ActorRefSchema.nullable(),
  detail: TimelineItemDetailSchema,
  steer: TimelineSteerStateSchema.nullable(),
  policy: TimelinePolicyBadgeSchema.nullable().optional(),
});

/** Counts come from original identities; source-derived counts remain restricted until their owner admits them. */
export const TimelineStatisticsSchema = z.object({
  steps: z.number().int().nonnegative(),
  failedStepCount: z.number().int().nonnegative(),
  failedCommandCount: z.number().int().nonnegative(),
  filesChanged: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
  itemCounts: z.partialRecord(ItemTypeSchema, z.number().int().nonnegative()),
  coverage: z.enum(['complete', 'partial']),
});

/** One admission-ordered run with a budgeted narrative, plan, notes and immutable-position continuation. */
export const TimelineRunEntrySchema = z.object({
  id: TurnIdSchema,
  admissionOrder: z.number().int().positive(),
  status: TurnStatusSchema,
  triggerActor: ActorRefSchema,
  agentId: AgentIdSchema.nullable(),
  triggerSource: z
    .object({ kind: z.string().max(80), summary: z.string().max(512).nullable() })
    .nullable(),
  startedAt: TimestampSchema.nullable(),
  completedAt: TimestampSchema.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  error: z
    .object({
      code: z.string().max(256).nullable(),
      message: z.string().max(4096),
      presentation: TurnErrorPresentationSchema.optional(),
    })
    .nullable(),
  long: z.boolean(),
  narrative: z.array(TimelineItemSchema).max(24),
  plan: TimelineItemSchema.nullable(),
  noteItemIds: z.array(ItemIdSchema).max(3),
  finalItemId: ItemIdSchema.nullable(),
  narrativeCursor: cursor.nullable(),
  statistics: TimelineStatisticsSchema,
  planSegments: TimelinePlanSegmentsSchema.optional(),
  /** Recorded call-linked lower bounds; units and metric sources are never conflated. */
  usage: z
    .object({
      measurements: z
        .array(
          z.object({
            category: UsageRecordSchema.shape.category,
            unit: UsageRecordSchema.shape.unit,
            source: z.string().min(1).max(96).nullable(),
            quantity: z.number().nonnegative(),
          })
        )
        .min(1)
        .max(8),
      coverage: z.enum(['complete', 'partial']),
    })
    .nullable()
    .optional(),
  /** Actual reached route members only; no inferred serving model or current configuration. */
  fallback: z
    .object({
      callsWithFallback: z.number().int().nonnegative().max(16),
      coverage: z.enum(['complete', 'partial']),
    })
    .nullable()
    .optional(),
  interruptedBy: z.discriminatedUnion('visibility', [
    z.object({ visibility: z.literal('restricted') }),
    z.object({ visibility: z.literal('available'), actor: ActorRefSchema.nullable() }),
  ]),
  restrictedReferences: z.boolean(),
});

/** Exact receipt-eligible unread messages before B, or null when a fixed probe cannot prove the answer. */
export const TimelineEarlierUnreadSchema = z
  .object({
    count: z.number().int().nonnegative().max(100),
    capped: z.boolean(),
    oldest: position.extend({ itemId: ItemIdSchema }).strict().nullable(),
  })
  .strict()
  .refine(
    (value) =>
      (value.count === 0) === (value.oldest === null) && (!value.capped || value.count === 100),
    'Earlier unread count, cap and oldest must agree.'
  );

/** Deterministic counts over a bounded retained window after B; partial counts are lower bounds. */
export const TimelineDigestSchema = z.object({
  lines: z
    .array(
      z.object({
        kind: z.enum([
          'needs-you',
          'runs-finished',
          'outputs',
          'plan-steps-finished',
          'problems',
          'decisions-by-others',
          'new-messages',
        ]),
        count: z.number().int().positive(),
        anchor: ThreadTimelineAnchorSchema,
      })
    )
    .max(7),
  coverage: z.enum(['complete', 'partial']),
});

/** A single source snapshot per window; cursors are positions and confer no authorization. */
export const ThreadTimelineResponseSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
    view: z.enum(['runs', 'items']),
    runs: z.array(TimelineRunEntrySchema).max(31),
    items: z.array(TimelineItemSchema).max(50),
    beforeCursor: cursor.nullable(),
    afterCursor: cursor.nullable(),
    itemWindow: z
      .object({
        turnId: TurnIdSchema,
        items: z.array(TimelineItemSchema).max(50),
        beforeCursor: cursor.nullable(),
        afterCursor: cursor.nullable(),
      })
      .nullable(),
    anchor: position.nullable(),
    catchUpAnchor: position.nullable(),
    earlierUnread: TimelineEarlierUnreadSchema.nullable().optional(),
    digest: TimelineDigestSchema,
    restrictedReferences: z.boolean(),
  })
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 262144,
    'Timeline response exceeds its UTF-8 JSON byte budget.'
  );

/** Public logical selectors for the bounded timeline operation. */
export type ThreadTimelineInput = z.infer<typeof ThreadTimelineInputSchema>;
/** Release-coupled bounded timeline response. */
export type ThreadTimelineResponse = z.infer<typeof ThreadTimelineResponseSchema>;
/** One bounded addressed Item projection. */
export type TimelineItem = z.infer<typeof TimelineItemSchema>;
/** One admission-ordered run entry. */
export type TimelineRunEntry = z.infer<typeof TimelineRunEntrySchema>;

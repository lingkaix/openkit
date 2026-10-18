/** Retained v1 owns these payload fields independently of release-coupled Item projections. */
import {
  AgentIdSchema,
  ArtifactIdSchema,
  AutomationIdSchema,
  ItemIdSchema,
  KnowledgeEntryIdSchema,
  PresentationIdSchema,
  RETAINED_FORMAT_VERSION,
  ThreadIdSchema,
  TimestampSchema,
  TurnIdSchema,
  UserIdSchema,
  UserInputRequestIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';

/** Fixed retained attribution keeps its accountability branches and permits descriptive annotations. */
const UserActorRefSchema = z.object({ kind: z.literal('user'), id: UserIdSchema });
const RetainedActorRefSchema = z.union([
  UserActorRefSchema,
  z.object({
    kind: z.enum(['agent', 'integration', 'system']),
    id: z.string().min(1),
    responsibleUserId: UserIdSchema.nullable(),
  }),
  z.object({
    kind: z.literal('automation'),
    id: AutomationIdSchema,
    responsibleUserId: UserIdSchema.nullable(),
  }),
]);

/** Native maintenance result stored on a Status Item, independent of its current API projection. */
const KnowledgeMaintenanceOutcomeSchema = z
  .object({
    threadId: ThreadIdSchema,
    turnId: TurnIdSchema,
    outcome: z.enum(['published', 'review-required', 'no-change', 'skipped', 'failed']),
    notebookRevision: z.string().min(1),
    candidateRevision: z.string().min(1).optional(),
    proposalId: z.string().min(1).optional(),
    summary: z.string().min(1),
  })
  .strict();

/**
 * Closed lifecycle states shared by all turn item records.
 */
const ItemStatusSchema = z.enum(['in_progress', 'completed', 'failed', 'declined']);

const BaseItemSchema = z.object({
  id: ItemIdSchema,
  workspaceId: WorkspaceIdSchema,
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema,
  status: ItemStatusSchema,
  parentItemId: ItemIdSchema.nullable().optional(),
  causationId: z.string().min(1).nullable().optional(),
  createdAt: TimestampSchema,
  completedAt: TimestampSchema.nullable(),
});

/**
 * User message item.
 */
const UserMessageItemSchema = BaseItemSchema.extend({
  type: z.literal('user-message'),
  actor: RetainedActorRefSchema,
  text: z.string().min(1),
});

/**
 * Assistant message item. The initial text may be empty while deltas stream in.
 */
const AssistantMessageItemSchema = BaseItemSchema.extend({
  type: z.literal('assistant-message'),
  text: z.string(),
});

/** Exact canonical prefix covered by one internal continuation summary. */
const ContextSummarySourceRangeSchema = z.object({
  firstItemId: ItemIdSchema,
  lastItemId: ItemIdSchema,
  itemCount: z.number().int().positive(),
  sourceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  evidenceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});

/** Completed untrusted continuation text; exact source history remains canonical and retrievable. */
const ContextSummaryItemSchema = BaseItemSchema.extend({
  type: z.literal('context-summary'),
  strategy: z.enum(['rolling', 'compaction']),
  logicalModelId: z.string().min(1),
  status: z.literal('completed'),
  text: z
    .string()
    .min(1)
    .max(65_536)
    .refine((text) => new TextEncoder().encode(text).byteLength <= 65_536, {
      message: 'Continuation summary exceeds its UTF-8 byte bound.',
    }),
  completedAt: TimestampSchema,
  environmentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  sourceRange: ContextSummarySourceRangeSchema,
  previousSummary: z
    .object({
      itemId: ItemIdSchema,
      digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    })
    .optional(),
});

/**
 * Reasoning/progress note item.
 */
const ReasoningItemSchema = BaseItemSchema.extend({
  type: z.literal('reasoning'),
  summary: z.array(z.string()),
  content: z.array(z.string()),
});

/**
 * Timeline entry that references a durable artifact.
 */
const ArtifactReferenceItemSchema = BaseItemSchema.extend({
  type: z.literal('artifact-reference'),
  artifactId: ArtifactIdSchema,
  artifactVersion: z.number().int().positive(),
  lastMutationRequestId: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().nullable(),
});

/**
 * Product-visible summary of a command execution.
 */
const CommandExecutionItemSchema = BaseItemSchema.extend({
  type: z.literal('command-execution'),
  command: z.string().min(1),
  cwd: z.string().min(1),
  /**
   * Canonical accumulated command output.
   *
   * `item-delta` events with `deltaKind: 'output-delta'` append their string `delta` value to this snapshot while the command is running. At `item-completed` time, this full snapshot is the source of truth.
   */
  output: z.string(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
});

/**
 * Product-visible approval request item.
 */
const ApprovalRequestItemSchema = BaseItemSchema.extend({
  type: z.literal('approval-request'),
  approvalRequestId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  kind: z.enum(['permission', 'destructive-action']),
});

/**
 * Product-visible approval decision item. The only system actor is the repository-push policy grant.
 */
const ApprovalDecisionItemSchema = BaseItemSchema.extend({
  type: z.literal('approval-decision'),
  actor: z.union([
    UserActorRefSchema.strip(),
    z
      .object({
        kind: z.literal('system'),
        id: z.literal('nanocore-repo-push-policy'),
        responsibleUserId: z.null(),
      })
      .strip(),
  ]),
  causationId: z.string().min(1),
  approvalRequestId: z.string().min(1),
  decision: z.enum(['granted', 'denied']),
  decidedAt: TimestampSchema,
}).refine(
  (item) =>
    item.actor.kind === 'user' ||
    (item.actor.id === 'nanocore-repo-push-policy' && item.decision === 'granted'),
  { message: 'A system approval decision must be a repository-push policy grant.' }
);

/**
 * Selectable option attached to one agent user-input question.
 */
const UserInputQuestionOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string().min(1),
});

/**
 * Agent question embedded in a product-visible user-input request item.
 */
const UserInputQuestionSchema = z.object({
  id: z.string().min(1),
  header: z.string().min(1),
  question: z.string().min(1),
  options: z.array(UserInputQuestionOptionSchema).nullable(),
  isOther: z.boolean(),
  isSecret: z.boolean(),
});

/** Exact work selected by a human answer; this never grants execution or disclosure authority. */
const AssistantHandoffSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('task'),
      targetWorkspaceId: WorkspaceIdSchema,
      input: z.string().min(1).max(65536),
      agentId: z.string().min(1).optional(),
      modelId: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('goal'),
      targetWorkspaceId: WorkspaceIdSchema,
      intent: z.string().min(1).max(65536),
    })
    .strict(),
]);

/**
 * Product-visible agent question request item.
 *
 * Separate request/response item types keep question handling explicit instead of overloading approvals. The request does not pause the raising Turn.
 */
const UserInputRequestItemSchema = BaseItemSchema.extend({
  type: z.literal('user-input-request'),
  responsibleUserId: UserIdSchema,
  userInputRequestId: UserInputRequestIdSchema,
  prompt: z.string().min(1),
  questions: z.array(UserInputQuestionSchema).min(1),
  assistantHandoff: AssistantHandoffSchema.optional(),
});

/**
 * Product-visible agent question response item.
 */
const UserInputResponseItemSchema = BaseItemSchema.extend({
  type: z.literal('user-input-response'),
  actor: UserActorRefSchema.strip(),
  causationId: z.string().min(1),
  userInputRequestId: UserInputRequestIdSchema,
  answers: z.record(z.string().min(1), z.tuple([z.string().min(1)])),
  answeredAt: TimestampSchema,
});

/**
 * Product-visible summary of a file change.
 */
const FileChangeItemSchema = BaseItemSchema.extend({
  type: z.literal('file-change'),
  path: z.string().min(1),
  changeKind: z.enum(['created', 'modified', 'deleted']),
});

/**
 * Product-visible summary of an MCP/external tool call.
 */
const ToolCallItemSchema = BaseItemSchema.extend({
  type: z.literal('tool-call'),
  tool: z.string().min(1),
  server: z.string().min(1).nullable(),
  arguments: z.record(z.string(), z.unknown()).nullable(),
  result: z.string().nullable(),
  error: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
});

/**
 * Handoff between agents.
 */
const AgentHandoffItemSchema = BaseItemSchema.extend({
  type: z.literal('agent-handoff'),
  fromAgentId: AgentIdSchema,
  toAgentId: AgentIdSchema,
  reason: z.string().nullable(),
});

/**
 * Product-visible status item for bounded progress and state transitions.
 */
const StatusItemSchema = BaseItemSchema.extend({
  /** Actual native result, never model-authored authority; the existing command receipt points to this Turn. */
  knowledgeMaintenanceResult: KnowledgeMaintenanceOutcomeSchema.optional(),
  type: z.literal('status'),
  level: z.enum(['info', 'warning', 'error']),
  title: z.string().min(1),
  summary: z.string().min(1).nullable(),
});

/**
 * Stable step state for a lightweight plan item.
 */
const PlanItemStepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'completed', 'blocked']),
});

/**
 * Product-visible plan item for reviewable agent intent without runtime payloads.
 */
const PlanItemSchema = BaseItemSchema.extend({
  type: z.literal('plan'),
  title: z.string().min(1),
  summary: z.string().min(1).nullable(),
  steps: z.array(PlanItemStepSchema),
});

/**
 * Product-visible knowledge context injected into a turn.
 */
const KnowledgeInjectionItemSchema = BaseItemSchema.extend({
  type: z.literal('knowledge-injection'),
  summary: z.string().min(1),
  knowledgeEntryIds: z.array(KnowledgeEntryIdSchema),
  policySummary: z.string().min(1).nullable(),
});

/**
 * Thread Item that references one immutable Generative UI presentation.
 */
const GenerativeUiReferenceItemSchema = BaseItemSchema.extend({
  type: z.literal('generative-ui-reference'),
  presentationId: PresentationIdSchema,
  title: z.string().min(1),
  fallbackText: z.string().min(1),
});

/** Fixed retained Item revision format; wire-only Item changes do not alter v1 decoding. */
export const StoredItemPayloadV1Schema = z.discriminatedUnion('type', [
  UserMessageItemSchema,
  AssistantMessageItemSchema,
  ContextSummaryItemSchema,
  ReasoningItemSchema,
  ArtifactReferenceItemSchema,
  CommandExecutionItemSchema,
  ApprovalRequestItemSchema,
  ApprovalDecisionItemSchema,
  UserInputRequestItemSchema,
  UserInputResponseItemSchema,
  FileChangeItemSchema,
  ToolCallItemSchema,
  AgentHandoffItemSchema,
  StatusItemSchema,
  PlanItemSchema,
  KnowledgeInjectionItemSchema,
  GenerativeUiReferenceItemSchema,
]);

/** Root Item revision header; embedded event snapshots inherit the event's format instead. */
const itemRows = StoredItemPayloadV1Schema.options.map((schema) =>
  schema.safeExtend({ schemaVersion: z.literal(RETAINED_FORMAT_VERSION) })
);

/** Fixed v1 Item row with its explicit retained marker. */
export const StoredItemV1Schema = z.discriminatedUnion('type', [
  itemRows[0]!,
  ...itemRows.slice(1),
]);

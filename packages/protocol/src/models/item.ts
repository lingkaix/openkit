import { z } from 'zod';

import {
  AgentIdSchema,
  ItemIdSchema,
  KnowledgeEntryIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  UserInputRequestIdSchema,
  WorkspaceIdSchema,
} from '../common/ids.js';
import { TimestampSchema } from '../common/timestamps.js';
import { ActorRefSchema, UserActorRefSchema } from './actor.js';

/**
 * Closed lifecycle states shared by all turn item records.
 */
export const ItemStatusSchema = z.enum(['in_progress', 'completed', 'failed', 'declined']);

/**
 * Closed item type values shared by turn item records and item-delta validation.
 */
export const ItemTypeSchema = z.enum([
  'user-message',
  'assistant-message',
  'reasoning',
  'artifact-reference',
  'command-execution',
  'approval-request',
  'approval-decision',
  'user-input-request',
  'user-input-response',
  'file-change',
  'tool-call',
  'agent-handoff',
  'status',
  'plan',
  'knowledge-injection',
]);

/**
 * Closed lifecycle state for a turn item record.
 */
export type ItemStatus = z.infer<typeof ItemStatusSchema>;

/**
 * Closed type value for a turn item record.
 */
export type ItemType = z.infer<typeof ItemTypeSchema>;

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
export const UserMessageItemSchema = BaseItemSchema.extend({
  type: z.literal('user-message'),
  actor: ActorRefSchema,
  text: z.string().min(1),
});

/**
 * Assistant message item. The initial text may be empty while deltas stream in.
 */
export const AssistantMessageItemSchema = BaseItemSchema.extend({
  type: z.literal('assistant-message'),
  text: z.string(),
});

/**
 * Reasoning/progress note item.
 */
export const ReasoningItemSchema = BaseItemSchema.extend({
  type: z.literal('reasoning'),
  summary: z.array(z.string()),
  content: z.array(z.string()),
});

/**
 * Timeline entry that references a durable artifact.
 */
export const ArtifactReferenceItemSchema = BaseItemSchema.extend({
  type: z.literal('artifact-reference'),
  artifactId: z.string().min(1),
  artifactVersion: z.number().int().positive(),
  lastMutationRequestId: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().nullable(),
});

/**
 * Product-visible summary of a command execution.
 */
export const CommandExecutionItemSchema = BaseItemSchema.extend({
  type: z.literal('command-execution'),
  command: z.string().min(1),
  cwd: z.string().min(1),
  /**
   * Canonical accumulated command output.
   *
   * `item-delta` events with `deltaKind: 'output-delta'` append their string
   * `delta` value to this snapshot while the command is running. At
   * `item-completed` time, this full snapshot is the source of truth.
   */
  output: z.string(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
});

/**
 * Product-visible approval request item.
 */
export const ApprovalRequestItemSchema = BaseItemSchema.extend({
  type: z.literal('approval-request'),
  approvalRequestId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  kind: z.enum(['permission', 'destructive-action']),
});

/**
 * Product-visible approval decision item.
 */
export const ApprovalDecisionItemSchema = BaseItemSchema.extend({
  type: z.literal('approval-decision'),
  actor: UserActorRefSchema,
  causationId: z.string().min(1),
  approvalRequestId: z.string().min(1),
  decision: z.enum(['granted', 'denied']),
});

/**
 * Selectable option attached to one agent user-input question.
 */
export const UserInputQuestionOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string().min(1),
});

/**
 * Agent question embedded in a product-visible user-input request item.
 */
export const UserInputQuestionSchema = z.object({
  id: z.string().min(1),
  header: z.string().min(1),
  question: z.string().min(1),
  options: z.array(UserInputQuestionOptionSchema).nullable(),
  isOther: z.boolean(),
  isSecret: z.boolean(),
});

/**
 * Product-visible agent question request item.
 *
 * Separate request/response item types keep question handling explicit instead of overloading
 * approvals, while still reusing the existing paused turn status for v0.0.1.
 */
export const UserInputRequestItemSchema = BaseItemSchema.extend({
  type: z.literal('user-input-request'),
  responsibleUserId: z.string().min(1),
  userInputRequestId: UserInputRequestIdSchema,
  prompt: z.string().min(1),
  questions: z.array(UserInputQuestionSchema).min(1),
});

/**
 * Product-visible agent question response item.
 */
export const UserInputResponseItemSchema = BaseItemSchema.extend({
  type: z.literal('user-input-response'),
  actor: UserActorRefSchema,
  causationId: z.string().min(1),
  userInputRequestId: UserInputRequestIdSchema,
  answers: z.record(z.string().min(1), z.tuple([z.string().min(1)])),
});

/**
 * Product-visible summary of a file change.
 */
export const FileChangeItemSchema = BaseItemSchema.extend({
  type: z.literal('file-change'),
  path: z.string().min(1),
  changeKind: z.enum(['created', 'modified', 'deleted']),
});

/**
 * Product-visible summary of an MCP/external tool call.
 */
export const ToolCallItemSchema = BaseItemSchema.extend({
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
export const AgentHandoffItemSchema = BaseItemSchema.extend({
  type: z.literal('agent-handoff'),
  fromAgentId: AgentIdSchema,
  toAgentId: AgentIdSchema,
  reason: z.string().nullable(),
});

/**
 * Product-visible status item for bounded progress and state transitions.
 */
export const StatusItemSchema = BaseItemSchema.extend({
  type: z.literal('status'),
  level: z.enum(['info', 'warning', 'error']),
  title: z.string().min(1),
  summary: z.string().min(1).nullable(),
});

/**
 * Stable step state for a lightweight plan item.
 */
export const PlanItemStepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'completed', 'blocked']),
});

/**
 * Product-visible plan item for reviewable agent intent without runtime payloads.
 */
export const PlanItemSchema = BaseItemSchema.extend({
  type: z.literal('plan'),
  title: z.string().min(1),
  summary: z.string().min(1).nullable(),
  steps: z.array(PlanItemStepSchema),
});

/**
 * Product-visible knowledge context injected into a turn.
 */
export const KnowledgeInjectionItemSchema = BaseItemSchema.extend({
  type: z.literal('knowledge-injection'),
  summary: z.string().min(1),
  knowledgeEntryIds: z.array(KnowledgeEntryIdSchema),
  policySummary: z.string().min(1).nullable(),
});

/**
 * Item union for turn streams.
 */
export const ItemSchema = z.discriminatedUnion('type', [
  UserMessageItemSchema,
  AssistantMessageItemSchema,
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
]);

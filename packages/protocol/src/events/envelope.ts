import { z } from 'zod';

import {
  ItemIdSchema,
  RequestIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from '../common/ids.js';
import { ItemDeltaKindSchema } from '../common/item-delta.js';
import { TimestampSchema } from '../common/timestamps.js';
import { AgentSessionSchema } from '../models/agent.js';
import { ApprovalRequestSchema } from '../models/approval.js';
import { ArtifactSchema } from '../models/artifact.js';
import { ItemSchema, ItemTypeSchema } from '../models/item.js';
import { ThreadSchema } from '../models/thread.js';
import {
  ProductTurnSchema,
  StopReasonSchema,
  TurnSchema,
  TurnStatusSchema,
} from '../models/turn.js';
import { WorkspaceRecordSchema } from '../models/workspace.js';

/**
 * Item type literal union used to validate stream delta targets.
 */
type ItemType = z.infer<typeof ItemTypeSchema>;

/**
 * Item delta kind literal union used to validate stream delta payloads.
 */
type ItemDeltaKind = z.infer<typeof ItemDeltaKindSchema>;

/**
 * Non-empty item type list required by Zod enum construction.
 */
type NonEmptyItemTypeList = readonly [ItemType, ...ItemType[]];

/**
 * Workspace update event.
 */
export const WorkspaceUpdatedEventSchema = z.object({
  type: z.literal('workspace-updated'),
  workspace: WorkspaceRecordSchema,
});

/**
 * Thread creation event.
 */
export const ThreadCreatedEventSchema = z.object({
  type: z.literal('thread-created'),
  thread: ThreadSchema,
});

/**
 * Thread update event.
 */
export const ThreadUpdatedEventSchema = z.object({
  type: z.literal('thread-updated'),
  thread: ThreadSchema,
});

/**
 * Turn status event.
 */
export const TurnStartedEventSchema = z.object({
  type: z.literal('turn-started'),
  turnId: TurnIdSchema,
  status: TurnStatusSchema,
});

/**
 * Turn status event.
 */
export const TurnUpdatedEventSchema = z.object({
  type: z.literal('turn-updated'),
  turn: TurnSchema,
});

/**
 * Item event.
 */
export const ItemCreatedEventSchema = z.object({
  type: z.literal('item-created'),
  item: ItemSchema,
});

const UntypedItemDeltaEventBaseSchema = z.object({
  type: z.literal('item-delta'),
  itemId: ItemIdSchema,
});

const itemTypesByDeltaKind = {
  'text-delta': ['assistant-message', 'reasoning', 'plan'],
  'indexed-text-delta': ['assistant-message', 'reasoning'],
  'part-started': ['assistant-message', 'reasoning'],
  'output-delta': ['command-execution'],
  'snapshot-updated': [
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
  ],
  'progress-updated': [
    'assistant-message',
    'reasoning',
    'command-execution',
    'approval-request',
    'user-input-request',
    'file-change',
    'tool-call',
    'agent-handoff',
    'status',
    'plan',
  ],
  'request-started': ['assistant-message', 'command-execution', 'tool-call'],
  'request-resolved': ['assistant-message', 'command-execution', 'tool-call'],
  'interaction-delta': ['command-execution'],
  'artifact-updated': ['artifact-reference'],
  'knowledge-injection-updated': ['knowledge-injection'],
} as const satisfies Record<ItemDeltaKind, NonEmptyItemTypeList>;

/**
 * Creates the strict per-delta base schema that encodes the item type matrix.
 */
function createItemDeltaEventBaseSchema<const ItemTypes extends NonEmptyItemTypeList>(
  deltaKind: ItemDeltaKind,
  itemTypes: ItemTypes
) {
  return UntypedItemDeltaEventBaseSchema.extend({
    itemType: z.enum(itemTypes, {
      error: (issue) => formatItemDeltaItemTypeError(deltaKind, issue.input),
    }),
  });
}

/**
 * Formats item type matrix validation errors without changing the JSON Schema shape.
 */
function formatItemDeltaItemTypeError(deltaKind: ItemDeltaKind, itemType: unknown): string {
  if (deltaKind === 'output-delta') {
    return 'output-delta is only valid for command-execution items';
  }

  return `${deltaKind} is not valid for ${String(itemType)} items`;
}

/**
 * Text delta payload for assistant, reasoning, and plan items.
 */
export const TextDeltaEventSchema = createItemDeltaEventBaseSchema(
  'text-delta',
  itemTypesByDeltaKind['text-delta']
).extend({
  deltaKind: z.literal('text-delta'),
  delta: z.string().min(1),
});

/**
 * Indexed text delta payload for structured text parts.
 */
export const IndexedTextDeltaEventSchema = createItemDeltaEventBaseSchema(
  'indexed-text-delta',
  itemTypesByDeltaKind['indexed-text-delta']
).extend({
  deltaKind: z.literal('indexed-text-delta'),
  partId: z.string().min(1),
  delta: z.string().min(1),
});

/**
 * Text part start payload.
 */
export const PartStartedDeltaEventSchema = createItemDeltaEventBaseSchema(
  'part-started',
  itemTypesByDeltaKind['part-started']
).extend({
  deltaKind: z.literal('part-started'),
  partId: z.string().min(1),
  label: z.string().min(1).nullable().optional(),
});

/**
 * Command or process output delta payload.
 */
export const OutputDeltaEventSchema = createItemDeltaEventBaseSchema(
  'output-delta',
  itemTypesByDeltaKind['output-delta']
).extend({
  deltaKind: z.literal('output-delta'),
  delta: z.string().min(1),
});

/**
 * Snapshot update payload for bounded structured state.
 */
export const SnapshotUpdatedDeltaEventSchema = createItemDeltaEventBaseSchema(
  'snapshot-updated',
  itemTypesByDeltaKind['snapshot-updated']
).extend({
  deltaKind: z.literal('snapshot-updated'),
  snapshot: z.record(z.string(), z.unknown()),
});

/**
 * Progress update payload for bounded structured state.
 */
export const ProgressUpdatedDeltaEventSchema = createItemDeltaEventBaseSchema(
  'progress-updated',
  itemTypesByDeltaKind['progress-updated']
).extend({
  deltaKind: z.literal('progress-updated'),
  progress: z.object({
    message: z.string().min(1),
    current: z.number().nonnegative().nullable().optional(),
    total: z.number().positive().nullable().optional(),
  }),
});

/**
 * Request start payload for correlating UI-visible server requests.
 */
export const RequestStartedDeltaEventSchema = createItemDeltaEventBaseSchema(
  'request-started',
  itemTypesByDeltaKind['request-started']
).extend({
  deltaKind: z.literal('request-started'),
  requestRefId: z.string().min(1),
  label: z.string().min(1).nullable().optional(),
});

/**
 * Request resolution payload for correlating UI-visible server requests.
 */
export const RequestResolvedDeltaEventSchema = createItemDeltaEventBaseSchema(
  'request-resolved',
  itemTypesByDeltaKind['request-resolved']
).extend({
  deltaKind: z.literal('request-resolved'),
  requestRefId: z.string().min(1),
  status: z.enum(['completed', 'failed', 'cancelled']),
  errorCode: z.string().min(1).nullable().optional(),
});

/**
 * Interactive terminal or tool stream delta payload.
 */
export const InteractionDeltaEventSchema = createItemDeltaEventBaseSchema(
  'interaction-delta',
  itemTypesByDeltaKind['interaction-delta']
).extend({
  deltaKind: z.literal('interaction-delta'),
  delta: z.string().min(1),
});

/**
 * Artifact update payload for bounded artifact state.
 */
export const ArtifactUpdatedDeltaEventSchema = createItemDeltaEventBaseSchema(
  'artifact-updated',
  itemTypesByDeltaKind['artifact-updated']
).extend({
  deltaKind: z.literal('artifact-updated'),
  artifactId: z.string().min(1),
  summary: z.string().min(1).nullable().optional(),
});

/**
 * Knowledge injection update payload for bounded knowledge state.
 */
export const KnowledgeInjectionUpdatedDeltaEventSchema = createItemDeltaEventBaseSchema(
  'knowledge-injection-updated',
  itemTypesByDeltaKind['knowledge-injection-updated']
).extend({
  deltaKind: z.literal('knowledge-injection-updated'),
  knowledgeEntryIds: z.array(z.string().min(1)),
  summary: z.string().min(1).nullable().optional(),
});

/**
 * Item delta event with a bounded payload selected by delta kind.
 */
export const ItemDeltaEventSchema = z.discriminatedUnion('deltaKind', [
  TextDeltaEventSchema,
  IndexedTextDeltaEventSchema,
  PartStartedDeltaEventSchema,
  OutputDeltaEventSchema,
  SnapshotUpdatedDeltaEventSchema,
  ProgressUpdatedDeltaEventSchema,
  RequestStartedDeltaEventSchema,
  RequestResolvedDeltaEventSchema,
  InteractionDeltaEventSchema,
  ArtifactUpdatedDeltaEventSchema,
  KnowledgeInjectionUpdatedDeltaEventSchema,
]);

/**
 * Validates an item delta event against the referenced item snapshot.
 *
 * @param event Item delta event to validate as supplied by the stream.
 * @param item Item snapshot referenced by the delta event.
 * @returns The original event when its payload and item type match the item snapshot.
 * @throws Error when the event payload is invalid or its item type does not match the item snapshot.
 */
export function validateItemDelta(
  event: z.infer<typeof ItemDeltaEventSchema>,
  item: z.infer<typeof ItemSchema>
): z.infer<typeof ItemDeltaEventSchema> {
  const parsed = ItemDeltaEventSchema.parse(event);

  if (parsed.itemType !== undefined && parsed.itemType !== item.type) {
    throw new Error(`itemType ${parsed.itemType} does not match ${item.type} item ${item.id}`);
  }

  return event;
}

/**
 * Item completion event.
 */
export const ItemCompletedEventSchema = z.object({
  type: z.literal('item-completed'),
  itemId: ItemIdSchema,
  item: ItemSchema,
});

/**
 * Approval request event.
 */
export const ApprovalRequestedEventSchema = z.object({
  type: z.literal('approval-requested'),
  approval: ApprovalRequestSchema,
});

/**
 * Approval resolution event.
 */
export const ApprovalResolvedEventSchema = z.object({
  type: z.literal('approval-resolved'),
  approval: ApprovalRequestSchema,
});

/**
 * AgentSession update event.
 */
export const AgentSessionUpdatedEventSchema = z.object({
  type: z.literal('agent-session-updated'),
  agentSession: AgentSessionSchema,
});

/**
 * Artifact creation event.
 */
export const ArtifactCreatedEventSchema = z.object({
  type: z.literal('artifact-created'),
  artifact: ArtifactSchema,
});

/**
 * Artifact update event.
 */
export const ArtifactUpdatedEventSchema = z.object({
  type: z.literal('artifact-updated'),
  artifact: ArtifactSchema,
});

/**
 * Turn completion event.
 */
export const TurnCompletedEventSchema = z.object({
  type: z.literal('turn-completed'),
  stopReason: StopReasonSchema,
  turn: TurnSchema,
});

/**
 * Error event.
 */
export const ErrorEventSchema = z.object({
  type: z.literal('error'),
  code: z.string().min(1),
  message: z.string().min(1),
});

/**
 * Discriminated union for server event payloads.
 */
export const ServerEventSchema = z.discriminatedUnion('type', [
  WorkspaceUpdatedEventSchema,
  ThreadCreatedEventSchema,
  ThreadUpdatedEventSchema,
  TurnStartedEventSchema,
  TurnUpdatedEventSchema,
  ItemCreatedEventSchema,
  ItemDeltaEventSchema,
  ItemCompletedEventSchema,
  ApprovalRequestedEventSchema,
  ApprovalResolvedEventSchema,
  AgentSessionUpdatedEventSchema,
  ArtifactCreatedEventSchema,
  ArtifactUpdatedEventSchema,
  TurnCompletedEventSchema,
  ErrorEventSchema,
]);

const KNOWN_SERVER_EVENT_TYPES = [
  'workspace-updated',
  'thread-created',
  'thread-updated',
  'turn-started',
  'turn-updated',
  'item-created',
  'item-delta',
  'item-completed',
  'approval-requested',
  'approval-resolved',
  'agent-session-updated',
  'artifact-created',
  'artifact-updated',
  'turn-completed',
  'error',
] as const;

/**
 * Closed enum of SSE event names used in the protocol.
 */
export const SseEventNameSchema = z.enum([
  'workspace.updated',
  'thread.created',
  'thread.updated',
  'turn.started',
  'turn.updated',
  'item.created',
  'item.delta',
  'item.completed',
  'approval.requested',
  'approval.resolved',
  'agent.session.updated',
  'artifact.created',
  'artifact.updated',
  'turn.completed',
  'error',
]);

/**
 * Explicit SSE envelope shared by all stream events.
 */
export const SseEventEnvelopeSchema = z.object({
  protocolVersion: z.string().min(1),
  event: SseEventNameSchema,
  sequence: z.number().int().nonnegative(),
  requestId: RequestIdSchema.nullable(),
  timestamp: TimestampSchema,
  workspaceId: WorkspaceIdSchema,
  threadId: ThreadIdSchema.optional(),
  turnId: TurnIdSchema.optional(),
  data: ServerEventSchema,
});

/**
 * Bounded unknown event payload accepted only by forward-compatible stream consumers.
 */
export const UnknownServerEventSchema = z
  .object({
    type: z
      .string()
      .min(1)
      .refine((value) => {
        return !KNOWN_SERVER_EVENT_TYPES.includes(
          value as (typeof KNOWN_SERVER_EVENT_TYPES)[number]
        );
      }, 'Known server event types must pass strict validation.'),
  })
  .passthrough();

const UnknownItemPayloadSchema = z
  .object({
    id: ItemIdSchema,
    type: z
      .string()
      .min(1)
      .refine((value) => {
        return !ItemTypeSchema.options.includes(value as ItemType);
      }, 'Known item types must pass strict validation.'),
  })
  .passthrough();

/**
 * Forward-compatible item-created payload for future additive item types.
 */
export const ForwardCompatibleItemCreatedEventSchema = z.object({
  type: z.literal('item-created'),
  item: UnknownItemPayloadSchema,
});

/**
 * Forward-compatible item-completed payload for future additive item types.
 */
export const ForwardCompatibleItemCompletedEventSchema = z.object({
  type: z.literal('item-completed'),
  itemId: ItemIdSchema,
  item: UnknownItemPayloadSchema,
});

/**
 * Forward-compatible item-delta payload for future additive delta kinds.
 */
export const ForwardCompatibleItemDeltaEventSchema = UntypedItemDeltaEventBaseSchema.extend({
  itemType: z.string().min(1),
  deltaKind: z.string().min(1),
})
  .passthrough()
  .refine((event) => {
    const deltaKind = ItemDeltaKindSchema.safeParse(event.deltaKind);
    const isFutureItemType = !ItemTypeSchema.safeParse(event.itemType).success;

    if (!deltaKind.success) {
      return true;
    }

    if (!isFutureItemType) {
      return false;
    }

    return ItemDeltaEventSchema.safeParse({
      ...event,
      itemType: itemTypesByDeltaKind[deltaKind.data][0],
    }).success;
  }, 'Known item delta payloads must pass strict validation.');

/**
 * Server event union for stream consumers that must tolerate future additive event payloads.
 */
export const ForwardCompatibleServerEventSchema = z.union([
  ServerEventSchema,
  ForwardCompatibleItemCreatedEventSchema,
  ForwardCompatibleItemDeltaEventSchema,
  ForwardCompatibleItemCompletedEventSchema,
  UnknownServerEventSchema,
]);

/**
 * SSE envelope parser for live clients that must not crash on future additive stream payloads.
 */
export const ForwardCompatibleSseEventEnvelopeSchema = z.object({
  protocolVersion: z.string().min(1),
  event: z.union([SseEventNameSchema, z.string().min(1)]),
  sequence: z.number().int().nonnegative(),
  requestId: RequestIdSchema.nullable(),
  timestamp: TimestampSchema,
  workspaceId: WorkspaceIdSchema,
  threadId: ThreadIdSchema.optional(),
  turnId: TurnIdSchema.optional(),
  data: ForwardCompatibleServerEventSchema,
});

const ProductTurnUpdatedEventSchema = TurnUpdatedEventSchema.extend({
  turn: ProductTurnSchema,
});

const ProductTurnCompletedEventSchema = TurnCompletedEventSchema.extend({
  turn: ProductTurnSchema,
});

const ProductServerEventSchema = z.discriminatedUnion('type', [
  WorkspaceUpdatedEventSchema,
  ThreadCreatedEventSchema,
  ThreadUpdatedEventSchema,
  TurnStartedEventSchema,
  ProductTurnUpdatedEventSchema,
  ItemCreatedEventSchema,
  ItemDeltaEventSchema,
  ItemCompletedEventSchema,
  ApprovalRequestedEventSchema,
  ApprovalResolvedEventSchema,
  ArtifactCreatedEventSchema,
  ArtifactUpdatedEventSchema,
  ProductTurnCompletedEventSchema,
  ErrorEventSchema,
]);

const ProductForwardCompatibleServerEventSchema = z.union([
  ProductServerEventSchema,
  ForwardCompatibleItemCreatedEventSchema,
  ForwardCompatibleItemDeltaEventSchema,
  ForwardCompatibleItemCompletedEventSchema,
  UnknownServerEventSchema,
]);

/**
 * Ordinary product SSE envelope without hidden AgentSession identity.
 */
export const ProductSseEventEnvelopeSchema = ForwardCompatibleSseEventEnvelopeSchema.extend({
  event: z
    .string()
    .min(1)
    .refine((event) => event !== 'agent.session.updated', 'AgentSession events are internal.'),
  data: ProductForwardCompatibleServerEventSchema,
});

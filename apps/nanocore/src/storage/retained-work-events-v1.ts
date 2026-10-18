/** Stored event v1 fixes its envelope and payload vocabularies independently of live SSE. */
import {
  ApprovalRequestIdSchema,
  ArtifactIdSchema,
  ItemIdSchema,
  RETAINED_FORMAT_VERSION,
  RequestIdSchema,
  ThreadIdSchema,
  TimestampSchema,
  TurnIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import { StoredItemPayloadV1Schema } from './retained-work-items-v1.js';
import {
  refineStoredArtifactV1,
  StoredAgentSessionPayloadV1Shape,
  StoredArtifactPayloadV1Shape,
  StoredTurnPayloadV1Shape,
  StoredWorkspacePayloadV1Shape,
} from './retained-work-metadata-v1.js';

const ItemDeltaKindSchema = z.enum([
  'text-delta',
  'indexed-text-delta',
  'part-started',
  'output-delta',
  'snapshot-updated',
  'progress-updated',
  'request-started',
  'request-resolved',
  'interaction-delta',
  'artifact-updated',
  'knowledge-injection-updated',
]);
const TurnStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'interrupted',
  'cancelled',
  'failed',
]);
const StopReasonSchema = z.enum(['completed', 'error', 'aborted', 'length', 'budget_exhausted']);

/** Captured aggregate fields are evidence, not a second Workspace authority. */
export const StoredWorkspaceSnapshotV1Schema = z.object({
  ...StoredWorkspacePayloadV1Shape,
  name: z.string().min(1),
  counts: z.object({
    threadCount: z.number().int().nonnegative(),
    artifactCount: z.number().int().nonnegative(),
    knowledgeEntryCount: z.number().int().nonnegative(),
  }),
});

/** Event snapshots include full Items under their existing attributable Turn. */
export const StoredTurnSnapshotV1Schema = z
  .object(StoredTurnPayloadV1Shape)
  .omit({ captureCoverage: true, requiredFeatures: true })
  .extend({ items: z.array(StoredItemPayloadV1Schema) })
  .superRefine(refineStoredTurnItemsV1);

/** Preserves the fixed responsible User relationship for both Workspace and Server Turn snapshots. */
export function refineStoredTurnItemsV1(
  turn: {
    triggerActor: z.infer<typeof StoredTurnPayloadV1Shape.triggerActor>;
    items: readonly { type: string; responsibleUserId?: string | undefined }[];
  },
  context: z.RefinementCtx
): void {
  const responsible =
    turn.triggerActor.kind === 'user' ? turn.triggerActor.id : turn.triggerActor.responsibleUserId;
  for (const [index, item] of turn.items.entries()) {
    if (item.type === 'user-input-request' && item.responsibleUserId !== responsible) {
      context.addIssue({
        code: 'custom',
        message: 'User-input request responsible user must match the turn trigger actor.',
        path: ['items', index, 'responsibleUserId'],
      });
    }
  }
}

/** Event history keeps the published inline body rather than the disk-only descriptor. */
export const StoredArtifactSnapshotV1Schema = z
  .object({
    ...StoredArtifactPayloadV1Shape,
    content: z.discriminatedUnion('format', [
      z.object({ format: z.enum(['markdown', 'text', 'json']), body: z.string().min(1) }),
      z.object({
        format: z.literal('file'),
        mediaType: z
          .string()
          .max(255)
          .regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/),
        byteLength: z.number().int().min(0).max(1_000_000_000),
      }),
    ]),
  })
  .superRefine(refineStoredArtifactV1);

/** Public event snapshots exclude private native admission fields. */
const AgentSessionSnapshotV1Schema = z.object({
  id: StoredAgentSessionPayloadV1Shape.id,
  agentId: StoredAgentSessionPayloadV1Shape.agentId,
  workspaceId: StoredAgentSessionPayloadV1Shape.workspaceId,
  threadId: StoredAgentSessionPayloadV1Shape.threadId,
  status: StoredAgentSessionPayloadV1Shape.status,
  message: StoredAgentSessionPayloadV1Shape.message,
  sandboxSummary: z
    .object({
      access: z.enum(['none', 'read-only', 'read-write']),
      workspaceRootRefs: z.array(z.string().min(1)).default([]),
      summary: z.string().min(1).nullable(),
    })
    .nullable()
    .default(null),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
const ApprovalRequestSchema = z.object({
  id: ApprovalRequestIdSchema,
  workspaceId: WorkspaceIdSchema,
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema,
  kind: z.enum(['permission', 'destructive-action']),
  status: z.enum(['pending', 'granted', 'denied', 'expired', 'superseded', 'withdrawn']),
  title: z.string().min(1),
  description: z.string().min(1),
  createdAt: TimestampSchema,
  resolvedAt: TimestampSchema.nullable(),
});

/** Server-authored product entry that owns one Thread's continuation path. */
const ThreadEntryPathSchema = z.enum(['conversation', 'administration', 'knowledge-manager']);

/**
 * A long-lived conversation/work container within a workspace.
 */
const ThreadSnapshotV1Schema = z
  .object({
    id: ThreadIdSchema,
    workspaceId: WorkspaceIdSchema,
    /** Immutable originating Thread of a separate receiving-Thread handoff. */
    parentThreadId: ThreadIdSchema.optional(),
    name: z.string().min(1).nullable(),
    preview: z.string().min(1),
    status: z.enum(['active', 'archived']),
    entryPath: ThreadEntryPathSchema,
    /** Missing on retained records whose inception owner did not record classification. */
    threadSource: z.enum(['conversation', 'worker']).optional(),
    visibility: z.enum(['private', 'workspace']),
    privateOwnerUserId: UserIdSchema.optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .superRefine((thread, context) => {
    if (thread.parentThreadId === thread.id) {
      context.addIssue({
        code: 'custom',
        path: ['parentThreadId'],
        message: 'A receiving Thread must differ from its parent.',
      });
    }
    if ((thread.visibility === 'private') !== (thread.privateOwnerUserId !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['privateOwnerUserId'],
        message: 'Private ownership is required exactly for private Threads.',
      });
    }
    if (thread.entryPath === 'administration' && thread.visibility !== 'private') {
      context.addIssue({
        code: 'custom',
        path: ['visibility'],
        message: 'Administration Threads must be private.',
      });
    }
  });

/**
 * Item type literal union used to validate stream delta targets.
 */
type ItemType = z.infer<typeof StoredItemPayloadV1Schema>['type'];

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
const WorkspaceUpdatedEventSchema = z.object({
  type: z.literal('workspace-updated'),
  workspace: StoredWorkspaceSnapshotV1Schema,
});

/**
 * Thread creation event.
 */
const ThreadCreatedEventSchema = z.object({
  type: z.literal('thread-created'),
  thread: ThreadSnapshotV1Schema,
});

/**
 * Thread update event.
 */
const ThreadUpdatedEventSchema = z.object({
  type: z.literal('thread-updated'),
  thread: ThreadSnapshotV1Schema,
});

/**
 * Turn status event.
 */
const TurnStartedEventSchema = z.object({
  type: z.literal('turn-started'),
  turnId: TurnIdSchema,
  status: TurnStatusSchema,
});

/**
 * Turn status event.
 */
const TurnUpdatedEventSchema = z.object({
  type: z.literal('turn-updated'),
  turn: StoredTurnSnapshotV1Schema,
});

/**
 * Item event.
 */
const ItemCreatedEventSchema = z.object({
  type: z.literal('item-created'),
  item: StoredItemPayloadV1Schema,
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
    'generative-ui-reference',
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
const TextDeltaEventSchema = createItemDeltaEventBaseSchema(
  'text-delta',
  itemTypesByDeltaKind['text-delta']
).extend({
  deltaKind: z.literal('text-delta'),
  delta: z.string().min(1),
});

/**
 * Indexed text delta payload for structured text parts.
 */
const IndexedTextDeltaEventSchema = createItemDeltaEventBaseSchema(
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
const PartStartedDeltaEventSchema = createItemDeltaEventBaseSchema(
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
const OutputDeltaEventSchema = createItemDeltaEventBaseSchema(
  'output-delta',
  itemTypesByDeltaKind['output-delta']
).extend({
  deltaKind: z.literal('output-delta'),
  delta: z.string().min(1),
});

/**
 * Snapshot update payload for bounded structured state.
 */
const SnapshotUpdatedDeltaEventSchema = createItemDeltaEventBaseSchema(
  'snapshot-updated',
  itemTypesByDeltaKind['snapshot-updated']
).extend({
  deltaKind: z.literal('snapshot-updated'),
  snapshot: z.record(z.string(), z.unknown()),
});

/**
 * Progress update payload for bounded structured state.
 */
const ProgressUpdatedDeltaEventSchema = createItemDeltaEventBaseSchema(
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
const RequestStartedDeltaEventSchema = createItemDeltaEventBaseSchema(
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
const RequestResolvedDeltaEventSchema = createItemDeltaEventBaseSchema(
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
const InteractionDeltaEventSchema = createItemDeltaEventBaseSchema(
  'interaction-delta',
  itemTypesByDeltaKind['interaction-delta']
).extend({
  deltaKind: z.literal('interaction-delta'),
  delta: z.string().min(1),
});

/**
 * Artifact update payload for bounded artifact state.
 */
const ArtifactUpdatedDeltaEventSchema = createItemDeltaEventBaseSchema(
  'artifact-updated',
  itemTypesByDeltaKind['artifact-updated']
).extend({
  deltaKind: z.literal('artifact-updated'),
  artifactId: ArtifactIdSchema,
  summary: z.string().min(1).nullable().optional(),
});

/**
 * Knowledge injection update payload for bounded knowledge state.
 */
const KnowledgeInjectionUpdatedDeltaEventSchema = createItemDeltaEventBaseSchema(
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
const ItemDeltaEventSchema = z.discriminatedUnion('deltaKind', [
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
 * Item completion event.
 */
const ItemCompletedEventSchema = z.object({
  type: z.literal('item-completed'),
  itemId: ItemIdSchema,
  item: StoredItemPayloadV1Schema,
});

/**
 * Approval request event.
 */
const ApprovalRequestedEventSchema = z.object({
  type: z.literal('approval-requested'),
  approval: ApprovalRequestSchema,
});

/**
 * Approval resolution event.
 */
const ApprovalResolvedEventSchema = z.object({
  type: z.literal('approval-resolved'),
  approval: ApprovalRequestSchema,
});

/**
 * AgentSession update event.
 */
const AgentSessionUpdatedEventSchema = z.object({
  type: z.literal('agent-session-updated'),
  agentSession: AgentSessionSnapshotV1Schema,
});

/**
 * Artifact creation event.
 */
const ArtifactCreatedEventSchema = z.object({
  type: z.literal('artifact-created'),
  artifact: StoredArtifactSnapshotV1Schema,
});

/**
 * Artifact update event.
 */
const ArtifactUpdatedEventSchema = z.object({
  type: z.literal('artifact-updated'),
  artifact: StoredArtifactSnapshotV1Schema,
});

/**
 * Turn completion event.
 */
const TurnCompletedEventSchema = z.object({
  type: z.literal('turn-completed'),
  stopReason: StopReasonSchema,
  turn: StoredTurnSnapshotV1Schema,
});

/**
 * Error event.
 */
const ErrorEventSchema = z.object({
  type: z.literal('error'),
  code: z.string().min(1),
  message: z.string().min(1),
});

/**
 * Discriminated union for server event payloads.
 */
const ServerEventSchema = z.discriminatedUnion('type', [
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

/**
 * Closed enum of SSE event names used in the protocol.
 */
const SseEventNameSchema = z.enum([
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
export const StoredEventPayloadV1Schema = z.object({
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

/** Retained log rows add the storage marker; in-memory snapshots use the fixed payload schema. */
export const StoredEventV1Schema = StoredEventPayloadV1Schema.extend({
  schemaVersion: z.literal(RETAINED_FORMAT_VERSION),
});

/** Fixed common snapshot and delta components reused by the native Server transcript owner. */
export {
  ItemDeltaEventSchema as StoredItemDeltaEventV1Schema,
  StopReasonSchema as StoredStopReasonV1Schema,
  ThreadSnapshotV1Schema as StoredWorkspaceThreadSnapshotV1Schema,
};

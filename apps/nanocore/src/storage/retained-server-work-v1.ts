import {
  ItemIdSchema,
  RETAINED_FORMAT_VERSION,
  RequestIdSchema,
  ThreadIdSchema,
  TimestampSchema,
  TurnIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import {
  refineStoredTurnItemsV1,
  StoredItemDeltaEventV1Schema,
  StoredStopReasonV1Schema,
  StoredWorkspaceThreadSnapshotV1Schema,
} from './retained-work-events-v1.js';
import {
  isPermittedStoredApprovalDecisionV1,
  StoredApprovalDecisionItemV1Schema,
  StoredItemPayloadV1Schema,
} from './retained-work-items-v1.js';
import { StoredTurnPayloadV1Shape } from './retained-work-metadata-v1.js';

/** Server records carry their own immutable owner and must not acquire a Workspace anchor. */
const ServerOwnershipV1Shape = {
  owner: z.object({ kind: z.literal('server') }),
  workspaceId: z.never().optional(),
};

const serverItems = StoredItemPayloadV1Schema.options.map((schema) => {
  if (schema === StoredApprovalDecisionItemV1Schema) {
    return z
      .object({ ...StoredApprovalDecisionItemV1Schema.shape, ...ServerOwnershipV1Shape })
      .refine(isPermittedStoredApprovalDecisionV1, {
        message: 'A system approval decision must be a repository-push policy grant.',
      });
  }
  return schema.omit({ workspaceId: true }).extend(ServerOwnershipV1Shape);
});

/** Fixed Server Item payloads share the retained Item vocabulary and its approval refinement. */
export const StoredServerItemPayloadV1Schema = z.discriminatedUnion('type', [
  serverItems[0]!,
  ...serverItems.slice(1),
]);

const serverItemRows = StoredServerItemPayloadV1Schema.options.map((schema) =>
  schema.safeExtend({ schemaVersion: z.literal(RETAINED_FORMAT_VERSION) })
);

/** Root Server Item revisions add a retained header; embedded snapshots inherit their event header. */
export const StoredServerItemV1Schema = z.discriminatedUnion('type', [
  serverItemRows[0]!,
  ...serverItemRows.slice(1),
]);

const ServerTurnV1BaseSchema = z.object({
  ...StoredTurnPayloadV1Shape,
  ...ServerOwnershipV1Shape,
  items: z.array(StoredServerItemPayloadV1Schema),
});

/** Server metadata and reconstructed Turns keep capture declarations and Item responsibility. */
export const StoredServerTurnPayloadV1Schema =
  ServerTurnV1BaseSchema.superRefine(refineStoredTurnItemsV1);

/** Transcript snapshots omit private capture declarations just as the current public Turn projection does. */
export const StoredServerTurnSnapshotV1Schema = ServerTurnV1BaseSchema.omit({
  captureCoverage: true,
  requiredFeatures: true,
}).superRefine(refineStoredTurnItemsV1);

/** Root Server Turn metadata owns no embedded Item history. */
export const StoredServerTurnV1Schema = ServerTurnV1BaseSchema.extend({
  schemaVersion: z.literal(RETAINED_FORMAT_VERSION),
  items: z.array(z.never()).max(0),
});

/** Fixed Server Thread fields preserve the existing envelope and exclude private Workspace ownership. */
export const StoredServerThreadPayloadV1Schema = z
  .object({
    ...StoredWorkspaceThreadSnapshotV1Schema.shape,
    ...ServerOwnershipV1Shape,
    visibility: z.literal('server'),
    privateOwnerUserId: z.never().optional(),
  })
  .superRefine((thread, context) => {
    if (thread.parentThreadId === thread.id) {
      context.addIssue({
        code: 'custom',
        path: ['parentThreadId'],
        message: 'A receiving Thread must differ from its parent.',
      });
    }
  });

/** Only the nine existing Server transcript payload families are retained v1 authority. */
const StoredServerTurnEventV1Schema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('thread-created'), thread: StoredServerThreadPayloadV1Schema }),
  z.object({ type: z.literal('thread-updated'), thread: StoredServerThreadPayloadV1Schema }),
  z.object({
    type: z.literal('turn-started'),
    turnId: TurnIdSchema,
    status: StoredTurnPayloadV1Shape.status,
  }),
  z.object({ type: z.literal('turn-updated'), turn: StoredServerTurnSnapshotV1Schema }),
  z.object({ type: z.literal('item-created'), item: StoredServerItemPayloadV1Schema }),
  StoredItemDeltaEventV1Schema,
  z.object({
    type: z.literal('item-completed'),
    itemId: ItemIdSchema,
    item: StoredServerItemPayloadV1Schema,
  }),
  z.object({
    type: z.literal('turn-completed'),
    stopReason: StoredStopReasonV1Schema,
    turn: StoredServerTurnSnapshotV1Schema,
  }),
  z.object({
    type: z.literal('error'),
    code: z.string().min(1),
    message: z.string().min(1),
  }),
]);

/** The native Server transcript owns its closed event grammar independently of protocolVersion. */
export const StoredServerEventPayloadV1Schema = z.object({
  ...ServerOwnershipV1Shape,
  protocolVersion: z.string().min(1),
  event: z.enum([
    'thread.created',
    'thread.updated',
    'turn.started',
    'turn.updated',
    'item.created',
    'item.delta',
    'item.completed',
    'turn.completed',
    'error',
  ]),
  sequence: z.number().int().nonnegative(),
  requestId: RequestIdSchema.nullable(),
  timestamp: TimestampSchema,
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema,
  data: StoredServerTurnEventV1Schema,
});

/** Independently decoded Server transcript rows carry their own retained header. */
export const StoredServerEventV1Schema = StoredServerEventPayloadV1Schema.extend({
  schemaVersion: z.literal(RETAINED_FORMAT_VERSION),
});

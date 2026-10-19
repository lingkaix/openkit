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
  StoredItemDeltaEventV1Schema,
  StoredStopReasonV1Schema,
  StoredThreadSnapshotV1Schema,
  StoredTurnSnapshotV1Schema,
} from './retained-work-events-v1.js';
import { StoredItemPayloadV1Schema } from './retained-work-items-v1.js';
import { StoredTurnPayloadV1Shape } from './retained-work-metadata-v1.js';

/** Only the nine existing Server transcript payload families are retained v1 authority. */
const StoredServerTurnEventV1Schema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('thread-created'), thread: StoredThreadSnapshotV1Schema }),
  z.object({ type: z.literal('thread-updated'), thread: StoredThreadSnapshotV1Schema }),
  z.object({
    type: z.literal('turn-started'),
    turnId: TurnIdSchema,
    status: StoredTurnPayloadV1Shape.status,
  }),
  z.object({ type: z.literal('turn-updated'), turn: StoredTurnSnapshotV1Schema }),
  z.object({ type: z.literal('item-created'), item: StoredItemPayloadV1Schema }),
  StoredItemDeltaEventV1Schema,
  z.object({
    type: z.literal('item-completed'),
    itemId: ItemIdSchema,
    item: StoredItemPayloadV1Schema,
  }),
  z.object({
    type: z.literal('turn-completed'),
    stopReason: StoredStopReasonV1Schema,
    turn: StoredTurnSnapshotV1Schema,
  }),
  z.object({
    type: z.literal('error'),
    code: z.string().min(1),
    message: z.string().min(1),
  }),
]);

/** The native Server transcript owns its closed event grammar independently of protocolVersion. */
export const StoredServerEventPayloadV1Schema = z.object({
  owner: z.object({ kind: z.literal('server'), workspaceId: z.never().optional() }),
  workspaceId: z.never().optional(),
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

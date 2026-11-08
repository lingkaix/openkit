import type { Item } from '@openkit/protocol';
import { ItemIdSchema, TurnIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import type { FsStore } from '../lib/store.js';
import { commandInputHash } from '../storage/control-store-input.js';

/** Bounded completed-receipt metadata; the Harness owner retains dispatch and native acceptance evidence. */
export const TaskSteerReceiptMetadataSchema = z
  .object({
    turnId: TurnIdSchema,
    inputItemId: ItemIdSchema,
    inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    disposition: z.enum(['accepted', 'refused', 'unknown']),
    reason: z.string().max(512).nullable(),
    operationId: z.string().min(1).max(128),
    executionId: z.string().min(1).max(128),
  })
  .strict();
/** Complete bounded metadata carried by the existing command receipt. */
export type TaskSteerReceiptMetadata = z.infer<typeof TaskSteerReceiptMetadataSchema>;

/** Reads the known metadata core without treating descriptive additions as authority. */
export function readTaskSteerReceiptMetadata(json: string): TaskSteerReceiptMetadata {
  return TaskSteerReceiptMetadataSchema.strip().parse(JSON.parse(json));
}

/** Retained linkage on an ordinary user input distinguishes an in-run instruction from a fresh Turn. */
export function taskSteerCausation(requestId: string): string {
  return `task.steer:${requestId}`;
}

/** Requires exact receipt, actor, input hash and Item/Turn pointers; receipt absence never means queued. */
export function readTaskSteerState(
  store: FsStore,
  workspaceId: string,
  threadId: string,
  item: Item
) {
  if (
    item.type !== 'user-message' ||
    item.actor.kind !== 'user' ||
    !item.causationId?.startsWith('task.steer:')
  )
    return null;
  const requestId = item.causationId.slice('task.steer:'.length);
  if (!requestId || requestId.length > 128) return null;
  const unknown = { requestId, state: 'unknown' as const, reason: null };
  const receipt = store.getCommandRequest('task.steer', requestId, {
    workspaceId,
    threadId,
    actorId: item.actor.id,
  });
  const metadata = receipt?.response.steerMetadata;
  if (!receipt || !metadata) return unknown;
  const hash = commandInputHash({ workspaceId, threadId, turnId: item.turnId, input: item.text });
  if (
    receipt.response.kind !== 'turn' ||
    receipt.response.id !== item.turnId ||
    receipt.inputHash !== hash ||
    metadata.inputHash !== hash ||
    metadata.turnId !== item.turnId ||
    metadata.inputItemId !== item.id
  )
    return unknown;
  return {
    requestId,
    state:
      metadata.disposition === 'accepted'
        ? ('accepted' as const)
        : metadata.disposition === 'refused'
          ? ('not-delivered' as const)
          : ('unknown' as const),
    reason: metadata.reason,
  };
}

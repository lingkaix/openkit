import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import { THREAD_OPERATION_DEFINITIONS } from './index.js';

const workspaceId = allocateEntityId('ws');
const threadId = allocateEntityId('th');
const itemId = allocateEntityId('it');

describe('thread operation schemas', () => {
  it('enforces safe integer cursor without leading zeros or trailing newlines on thread.items input', () => {
    const schema = THREAD_OPERATION_DEFINITIONS['thread.items'].inputSchema;

    expect(
      schema.parse({
        workspaceId,
        threadId,
        since: 0,
        limit: 25,
        cursor: '0',
      })
    ).toMatchObject({ cursor: '0', limit: 25, since: 0 });

    expect(
      schema.parse({
        workspaceId,
        threadId,
        cursor: String(Number.MAX_SAFE_INTEGER),
      }).cursor
    ).toBe('9007199254740991');

    for (const invalidCursor of ['01', '-1', '10\n', '10 ', '9007199254740992', 'abc', '']) {
      expect(schema.safeParse({ workspaceId, threadId, cursor: invalidCursor }).success).toBe(
        false
      );
    }

    for (const invalid of [
      { workspaceId, threadId, since: -1 },
      { workspaceId, threadId, limit: 0 },
      { workspaceId, threadId, limit: 1.5 },
      { workspaceId, threadId, extra: true },
    ]) {
      expect(schema.safeParse(invalid).success).toBe(false);
    }
  });

  it('caps thread.mark-read itemIds at 200 items and validates bounded acknowledgements', () => {
    const inputSchema = THREAD_OPERATION_DEFINITIONS['thread.mark-read'].inputSchema;
    const outputSchema = THREAD_OPERATION_DEFINITIONS['thread.mark-read'].outputSchema;

    expect(inputSchema.parse({ workspaceId, threadId })).toEqual({ workspaceId, threadId });
    expect(
      inputSchema.parse({
        workspaceId,
        threadId,
        itemIds: Array.from({ length: 200 }, () => itemId),
      }).itemIds
    ).toHaveLength(200);

    expect(
      inputSchema.safeParse({
        workspaceId,
        threadId,
        itemIds: Array.from({ length: 201 }, () => itemId),
      }).success
    ).toBe(false);

    const acknowledgement = { scope: 'window', acknowledgedItemIds: [itemId] };
    expect(outputSchema.parse(acknowledgement)).toEqual(acknowledgement);
    expect(outputSchema.parse({ scope: 'thread', acknowledgedCount: 10_000 })).toEqual({
      scope: 'thread',
      acknowledgedCount: 10_000,
    });
    for (const invalid of [
      { scope: 'window', acknowledgedItemIds: ['not-an-item-id'] },
      { scope: 'window', acknowledgedItemIds: Array(201).fill(itemId) },
      { scope: 'thread', acknowledgedCount: -1 },
      { scope: 'thread', acknowledgedCount: 1.5 },
      { readItemIds: [itemId], unreadItemIds: [] },
    ])
      expect(outputSchema.safeParse(invalid).success).toBe(false);
  });

  it('distinguishes bounded window state from the temporary complete Thread read', () => {
    const { inputSchema, outputSchema } = THREAD_OPERATION_DEFINITIONS['thread.read-state'];
    expect(inputSchema.parse({ workspaceId, threadId })).toEqual({ workspaceId, threadId });
    expect(inputSchema.parse({ workspaceId, threadId, itemIds: [] }).itemIds).toEqual([]);
    expect(
      inputSchema.parse({ workspaceId, threadId, itemIds: Array(200).fill(itemId) }).itemIds
    ).toHaveLength(200);
    expect(
      inputSchema.safeParse({ workspaceId, threadId, itemIds: Array(201).fill(itemId) }).success
    ).toBe(false);
    expect(inputSchema.safeParse({ workspaceId, threadId, itemIds: [null] }).success).toBe(false);
    const window = { scope: 'window', readItemIds: [itemId], unreadItemIds: [] };
    expect(outputSchema.parse(window)).toEqual(window);
    expect(
      outputSchema.safeParse({ ...window, readItemIds: Array(201).fill(itemId) }).success
    ).toBe(false);
    expect(
      outputSchema.parse({
        scope: 'thread',
        readItemIds: Array(201).fill(itemId),
        unreadItemIds: [],
      }).readItemIds
    ).toHaveLength(201);
    expect(outputSchema.safeParse({ ...window, unreadItemIds: ['not-an-item-id'] }).success).toBe(
      false
    );
  });
});

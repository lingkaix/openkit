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

  it('caps thread.mark-read itemIds at 200 items and validates read-state output', () => {
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

    expect(
      outputSchema.parse({
        readItemIds: [itemId],
        unreadItemIds: [],
      })
    ).toEqual({
      readItemIds: [itemId],
      unreadItemIds: [],
    });

    expect(
      outputSchema.safeParse({
        readItemIds: ['not-an-item-id'],
        unreadItemIds: [],
      }).success
    ).toBe(false);
  });
});

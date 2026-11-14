import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';
import { navigationFixture } from '../test-support/nav-oracle.fixture.js';
import { markThreadRead } from '../thread-read-state.js';
import { openUserDb } from './db.js';

/** Counterfaults preserve receipt schema and exact User/Workspace/Thread identity, not source-history provenance. */
async function installReceiptCounterfault(
  f: Awaited<ReturnType<typeof navigationFixture>>,
  reply: string,
  members: number
) {
  await markThreadRead({
    store: f.store,
    coreDb: f.coreDb,
    userId: f.actor.id,
    workspaceId: f.workspaceId,
    threadId: f.thread.id,
    itemIds: [reply],
  });
  const ids = [reply, ...Array.from({ length: members - 1 }, () => allocateEntityId('it'))].sort();
  const membership = JSON.stringify(ids);
  const db = openUserDb(f.dataRoot, f.actor.id);
  try {
    // Labelled retained-state counterfault after real owner publication. No competing writer is active.
    const changed = db.sqlite
      .prepare(
        'UPDATE thread_read_receipts SET item_ids_json=? WHERE workspace_id=? AND thread_id=?'
      )
      .run(membership, f.workspaceId, f.thread.id);
    expect(changed.changes).toBe(1);
  } finally {
    db.sqlite.close();
  }
  return membership;
}

/** Isolates receipt overflow from candidate and body overflow through the real route. */
describe('navigation v2 receipt proof', () => {
  it('does not parse oversized membership even for one small already-read message', async () => {
    const f = await navigationFixture();
    const reply = await f.message('Small already-read message.');
    const membership = await installReceiptCounterfault(f, reply, 1600);
    expect(Buffer.byteLength(membership)).toBeGreaterThan(65536);
    expect(f.store.listThreadItems(f.workspaceId, f.thread.id)).toHaveLength(1);
    expect(
      Buffer.byteLength(JSON.stringify(f.store.getThreadItem(f.workspaceId, f.thread.id, reply)))
    ).toBeLessThan(1024);
    const original = JSON.parse;
    let decoded = 0;
    const parse = vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
      if (text === membership) decoded++;
      return original(text, reviver);
    });
    try {
      expect.soft((await f.row()).unreadCount).toBeNull();
      expect(decoded, 'Oversized membership must be refused before JSON decoding').toBe(0);
    } finally {
      parse.mockRestore();
    }
  });

  it('shares one byte allowance between a fitting receipt and a fitting body', async () => {
    const f = await navigationFixture();
    const seed = await f.message('An earlier actually displayed reply.');
    const text = 'x'.repeat(30000);
    const reply = await f.message(text);
    expect((await f.row()).unreadCount).toBe(2);
    const membership = await installReceiptCounterfault(f, seed, 1000);
    const receiptBytes = Buffer.byteLength(membership);
    const bodyBytes = Buffer.byteLength(
      JSON.stringify(f.store.getThreadItem(f.workspaceId, f.thread.id, reply))
    );
    expect(receiptBytes).toBeLessThan(65536);
    expect(bodyBytes).toBeLessThan(65536);
    // Text alone plus receipt already exceeds the allowance, independent of retained envelope overhead.
    expect(Buffer.byteLength(text) + receiptBytes).toBeGreaterThan(65536);
    expect(f.store.listThreadItems(f.workspaceId, f.thread.id)).toHaveLength(2);
    expect(JSON.parse(membership)).not.toContain(reply);
    expect((await f.row()).unreadCount).toBeNull();
  });
});

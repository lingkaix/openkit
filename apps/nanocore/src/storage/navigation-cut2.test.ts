import { describe, expect, it, vi } from 'vitest';
import { navigationFixture } from '../test-support/nav-oracle.fixture.js';
import { markThreadRead } from '../thread-read-state.js';

/** Exact-or-null unread must never publish a lower bound as an exact count. */
describe('navigation cut 2 independent oracle', () => {
  it('does not enumerate complete Turn or Item history', async () => {
    const f = await navigationFixture();
    await f.message('One unread reply.');
    const turns = vi.spyOn(f.store, 'listThreadTurns');
    const items = vi.spyOn(f.store, 'listThreadItems');
    try {
      expect((await f.row()).unreadCount).toBe(1);
      expect.soft(turns).not.toHaveBeenCalled();
      expect.soft(items).not.toHaveBeenCalled();
    } finally {
      turns.mockRestore();
      items.mockRestore();
    }
  });

  it('returns exact small counts and exact zero after actual display acknowledgement', async () => {
    const f = await navigationFixture();
    expect((await f.row()).unreadCount).toBe(0);
    const reply = await f.message('Visible reply.');
    await f.message(' \n\t ');
    await f.message('My own input.', 'user-message', true);
    await f.message('Other actor input.', 'user-message');
    expect((await f.row()).unreadCount).toBe(2);
    await markThreadRead({
      store: f.store,
      coreDb: f.coreDb,
      userId: f.actor.id,
      workspaceId: f.workspaceId,
      threadId: f.thread.id,
      itemIds: [reply],
    });
    expect((await f.row()).unreadCount).toBe(1);
    await markThreadRead({
      store: f.store,
      coreDb: f.coreDb,
      userId: f.actor.id,
      workspaceId: f.workspaceId,
      threadId: f.thread.id,
    });
    expect((await f.row()).unreadCount).toBe(0);
  });

  it('proves all 64 candidates when they fit, but refuses a partial count at 65', async () => {
    const f = await navigationFixture();
    for (let i = 0; i < 64; i++) await f.message(`Reply ${i}`);
    expect((await f.row()).unreadCount).toBe(64);
    await f.message('The unproved next candidate.');
    expect((await f.row()).unreadCount).toBeNull();
  });

  it('returns null for an oversized message body rather than counting a preview', async () => {
    const f = await navigationFixture();
    await f.message('x'.repeat(65_537));
    expect((await f.row()).unreadCount).toBeNull();
  });

  it('applies the 64 KiB allowance to combined selected bodies', async () => {
    const f = await navigationFixture();
    await f.message('a'.repeat(33_000));
    await f.message('b'.repeat(33_000));
    expect((await f.row()).unreadCount).toBeNull();
  });

  it('does not turn oversized retained membership into an empty set or exact zero', async () => {
    const f = await navigationFixture();
    // Publish valid receipt members through their owner. No SQL or fabricated retained receipt.
    for (let i = 0; i < 1600; i++) await f.message(`Read ${i}`);
    await markThreadRead({
      store: f.store,
      coreDb: f.coreDb,
      userId: f.actor.id,
      workspaceId: f.workspaceId,
      threadId: f.thread.id,
    });
    expect((await f.row()).unreadCount).toBeNull();
  }, 120_000);
});

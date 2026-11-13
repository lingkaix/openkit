import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId, ProductSseEventEnvelopeSchema } from '@openkit/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import { createAppWithWorkspaceAuthority } from './test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from './test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID } from './test-support/local-user.js';
import { disposeTestStore } from './test-support/store.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await disposeTestStore(root);
});

/** Publishes genuine native records before App admission hooks, without SQL or response doubles. */
async function fixture(count = 2, completed = false) {
  const root = mkdtempSync(join(tmpdir(), 'sse-entry-regression-'));
  roots.push(root);
  const store = await createDemoStore({ dataRoot: root });
  const workspaceId = DEMO_WORKSPACE_ID;
  const thread = await store.createThread(workspaceId, 'Bounded SSE');
  const sibling = await store.createThread(workspaceId, 'Wrong selector');
  const turn = await store.createTurn(workspaceId, thread.id, 'Native stream', {
    kind: 'user',
    id: FIXTURE_LOCAL_USER_ID,
  });
  const base = {
    owner: turn.owner,
    threadId: thread.id,
    turnId: turn.id,
    status: 'completed' as const,
    createdAt: '2026-11-13T00:00:00.000Z',
    completedAt: '2026-11-13T00:00:00.000Z',
  };
  const item = await store.createItem({
    ...base,
    id: allocateEntityId('it'),
    type: 'assistant-message',
    text: 'Ordinary message',
  });
  const protectedItem = await store.createItem({
    ...base,
    id: allocateEntityId('it'),
    type: 'knowledge-injection',
    summary: 'PROTECTED-SOURCE',
    knowledgeEntryIds: [],
    policySummary: null,
  });
  const selector = { workspaceId, threadId: thread.id, turnId: turn.id };
  const publish = async (delta: string) => {
    const event = await store.persistTurnEvent(turn.id, {
      ...selector,
      event: 'item.delta',
      data: {
        type: 'item-delta',
        itemId: item.id,
        itemType: item.type,
        deltaKind: 'text-delta',
        delta,
      },
    });
    store.emitTurnEvent(turn.id, event);
    return event;
  };
  for (let n = 1; n <= count; n++) await publish(`delta-${n}`);
  if (completed) {
    const ended = await store.updateTurn(turn.id, {
      status: 'completed',
      completedAt: base.completedAt,
    });
    store.emitTurnEvent(
      turn.id,
      await store.persistTurnEvent(turn.id, {
        ...selector,
        event: 'turn.completed',
        data: { type: 'turn-completed', stopReason: 'completed', turn: ended },
      })
    );
  }
  const app = createAppWithWorkspaceAuthority({ store, dataRoot: root });
  const url = (since = 0, threadId = thread.id) =>
    `/api/workspaces/${workspaceId}/threads/${threadId}/events?turnId=${turn.id}&since=${since}`;
  return { store, turn, sibling, selector, protectedItem, publish, app, url };
}

/** Full-history APIs must not be used by entry, replay selection, or listener subscription. */
function forbidHistory(store: Awaited<ReturnType<typeof fixture>>['store']) {
  return [
    vi.spyOn(store, 'getTurnById'),
    vi.spyOn(store, 'getTurn'),
    vi.spyOn(store, 'getTurnEventsForExport'),
  ].map((spy) =>
    spy.mockImplementation(() => {
      throw new Error('SSE entry must not drain full Turn history');
    })
  );
}

/** Reads one real wire frame with a bounded wait and no synthetic listener return. */
async function frameReader(response: Response) {
  const reader = response.body!.getReader();
  let pending = '';
  const next = async () => {
    while (!pending.includes('\n\n')) {
      const part = await reader.read();
      if (part.done) throw new Error('Stream closed before expected frame');
      pending += new TextDecoder().decode(part.value);
    }
    const boundary = pending.indexOf('\n\n');
    const chunk = pending.slice(0, boundary);
    pending = pending.slice(boundary + 2);
    return ProductSseEventEnvelopeSchema.parse(
      JSON.parse(
        chunk
          .split('\n')
          .find((line) => line.startsWith('data: '))!
          .slice(6)
      )
    );
  };
  return { next, cancel: () => reader.cancel() };
}

it('opens native replay and subscribes to real live delivery without full-history reads', async () => {
  const f = await fixture();
  const listener = vi.spyOn(f.store, 'addTurnListener');
  const forbidden = forbidHistory(f.store);
  const response = await f.app.request(f.url());
  expect(response.status, 'bounded SSE entry must succeed while full-history APIs throw').toBe(200);
  const wire = await frameReader(response);
  try {
    expect((await wire.next()).sequence).toBe(1);
    expect((await wire.next()).sequence).toBe(2);
    expect(listener).toHaveBeenCalledTimes(1);
    const live = await f.publish('actual-live-notification');
    f.store.emitTurnEvent(f.turn.id, live);
    expect(await wire.next()).toMatchObject({
      sequence: 3,
      data: { delta: 'actual-live-notification' },
    });
    await f.publish('after-duplicate');
    expect((await wire.next()).sequence).toBe(4);
    for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
  } finally {
    await wire.cancel();
  }
}, 60_000);

it('replays the exact retained suffix, expires old cursors, and closes terminal cursors without draining history', async () => {
  const f = await fixture(105, true);
  const forbidden = forbidHistory(f.store);
  const expired = await f.app.request(f.url(1));
  expect(expired.status).toBe(410);
  expect(await expired.json()).toMatchObject({ code: 'core.stream.cursor_expired' });
  const replay = await f.app.request(f.url(103));
  expect(replay.status).toBe(200);
  const frames = (await replay.text())
    .split('\n\n')
    .filter(Boolean)
    .map((chunk) =>
      ProductSseEventEnvelopeSchema.parse(
        JSON.parse(
          chunk
            .split('\n')
            .find((line) => line.startsWith('data: '))!
            .slice(6)
        )
      )
    );
  expect(frames.map((event) => event.sequence)).toEqual([104, 105, 106]);
  expect(frames.at(-1)?.event).toBe('turn.completed');
  const terminal = await f.app.request(f.url(106));
  expect(terminal.status).toBe(204);
  for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
}, 60_000);

it('keeps exact Thread selector denial and protected source filtering on replay and live delivery', async () => {
  const f = await fixture();
  const protectedEvent = await f.store.persistTurnEvent(f.turn.id, {
    ...f.selector,
    event: 'item.created',
    data: { type: 'item-created', item: f.protectedItem },
  });
  f.store.emitTurnEvent(f.turn.id, protectedEvent);
  const denied = await f.app.request(f.url(0, f.sibling.id));
  expect(denied.status).toBe(404);
  expect(await denied.text()).not.toContain('PROTECTED-SOURCE');
  const response = await f.app.request(f.url());
  expect(response.status).toBe(200);
  const wire = await frameReader(response);
  try {
    expect((await wire.next()).sequence).toBe(1);
    expect((await wire.next()).sequence).toBe(2);
    const liveProtected = await f.store.persistTurnEvent(f.turn.id, {
      ...f.selector,
      event: 'item.completed',
      data: { type: 'item-completed', itemId: f.protectedItem.id, item: f.protectedItem },
    });
    f.store.emitTurnEvent(f.turn.id, liveProtected);
    await f.publish('visible-after-protected');
    expect(await wire.next()).toMatchObject({
      sequence: 5,
      data: { delta: 'visible-after-protected' },
    });
  } finally {
    await wire.cancel();
  }
}, 60_000);

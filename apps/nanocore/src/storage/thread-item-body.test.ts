import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId, ProductSseEventEnvelopeSchema } from '@openkit/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import { createAppWithWorkspaceAuthority } from '../test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { disposeTestStore } from '../test-support/store.js';
import { CONTROL_WORKER_VERSION, isControlWorkerRequest } from './control-store-worker-protocol.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await disposeTestStore(root);
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'thread-item-body-'));
  roots.push(root);
  const store = await createDemoStore({ dataRoot: root });
  const thread = await store.createThread(DEMO_WORKSPACE_ID, 'Large body');
  const app = createAppWithWorkspaceAuthority({ store, dataRoot: root });
  const selector = { workspaceId: DEMO_WORKSPACE_ID, threadId: thread.id };
  const turn = await store.createTurn(DEMO_WORKSPACE_ID, thread.id, 'Large body', {
    kind: 'user',
    id: FIXTURE_LOCAL_USER_ID,
  });
  const read = async (input: object) => {
    const response = await app.request('/api/app/operations/thread.timeline', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...selector, ...input }),
    });
    return { response, body: await response.json() };
  };
  return { store, thread, turn, selector, read, app };
}

it('returns an exact bounded UTF-8 tail for a 5 MB command output', async () => {
  const f = await fixture();
  const output = `Beginning ${'x'.repeat(5 * 1024 * 1024)} final 🙂`;
  const item = await f.store.createItem({
    id: allocateEntityId('it'),
    owner: f.turn.owner,
    threadId: f.thread.id,
    turnId: f.turn.id,
    type: 'command-execution',
    command: 'fixture command',
    cwd: '.',
    output,
    exitCode: 0,
    durationMs: 1,
    status: 'completed',
    createdAt: '2026-11-08T17:00:00.000Z',
    completedAt: '2026-11-08T17:00:00.000Z',
  });
  const result = await f.read({ view: 'items', turnId: f.turn.id, placement: 'step' });
  expect(result.response.status).toBe(200);
  const projected = result.body.items.find((row: { id: string }) => row.id === item.id);
  expect(projected.detail).toMatchObject({
    kind: 'preview',
    field: 'output',
    side: 'tail',
    sizeBytes: Buffer.byteLength(output),
    truncated: true,
  });
  expect(Buffer.byteLength(projected.detail.text)).toBeLessThanOrEqual(4096);
  expect(output.endsWith(projected.detail.text)).toBe(true);
  expect(projected.detail.text.endsWith('final 🙂')).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(result.body))).toBeLessThanOrEqual(262144);
  const response = await f.app.request('/api/app/operations/thread.item-body', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...f.selector, turnId: f.turn.id, itemId: item.id }),
  });
  expect(response.status).toBe(200);
  expect((await response.json()).item).toEqual(item);
});

it('rejects an Item outside the exact addressed Thread and Turn', async () => {
  const f = await fixture();
  const item = await f.store.createItem({
    id: allocateEntityId('it'),
    owner: f.turn.owner,
    threadId: f.thread.id,
    turnId: f.turn.id,
    type: 'command-execution',
    command: 'fixture',
    cwd: '.',
    output: 'Original body',
    exitCode: 0,
    durationMs: 1,
    status: 'completed',
    createdAt: '2026-11-08T17:00:00.000Z',
    completedAt: '2026-11-08T17:00:00.000Z',
  });
  const sibling = await f.store.createThread(DEMO_WORKSPACE_ID, 'Other Thread');
  await f.store.completeTurn(f.turn.id, {
    status: 'completed',
    completedAt: new Date().toISOString(),
  });
  const anotherTurn = await f.store.createTurn(DEMO_WORKSPACE_ID, f.thread.id, 'Other Turn', {
    kind: 'user',
    id: FIXTURE_LOCAL_USER_ID,
  });
  for (const selector of [
    { threadId: sibling.id, turnId: f.turn.id },
    { threadId: f.thread.id, turnId: anotherTurn.id },
  ]) {
    const response = await f.app.request('/api/app/operations/thread.item-body', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: DEMO_WORKSPACE_ID, ...selector, itemId: item.id }),
    });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('Original body');
  }
});

it('publishes bounded exact output tails and body references in live and replayed command events', async () => {
  const f = await fixture();
  const publish = async (id: string, input: Parameters<typeof f.store.persistTurnEvent>[1]) => {
    const event = await f.store.persistTurnEvent(id, input);
    f.store.emitTurnEvent(id, event);
  };
  const listening = Promise.withResolvers<void>();
  const add = f.store.addTurnListener.bind(f.store);
  vi.spyOn(f.store, 'addTurnListener').mockImplementation((...args) => {
    const stop = add(...args);
    listening.resolve();
    return stop;
  });
  const responsePending = f.app.request(
    `/api/workspaces/${DEMO_WORKSPACE_ID}/threads/${f.thread.id}/events?turnId=${f.turn.id}`
  );
  await listening.promise;
  const live = responsePending.then((response) => {
    expect(response.status).toBe(200);
    return response.text();
  });
  const output = `Original head ${'🙂x'.repeat(1_100_000)} exact tail 🙂`;
  const item = await f.store.createItem({
    id: allocateEntityId('it'),
    owner: f.turn.owner,
    threadId: f.thread.id,
    turnId: f.turn.id,
    type: 'command-execution',
    command: 'fixture command',
    cwd: '.',
    output,
    exitCode: 0,
    durationMs: 1,
    status: 'completed',
    createdAt: '2026-11-08T17:00:00.000Z',
    completedAt: '2026-11-08T17:00:00.000Z',
  });
  await publish(f.turn.id, {
    event: 'item.created',
    ...f.selector,
    turnId: f.turn.id,
    data: { type: 'item-created', item },
  });
  await publish(f.turn.id, {
    event: 'item.delta',
    ...f.selector,
    turnId: f.turn.id,
    data: {
      type: 'item-delta',
      itemId: item.id,
      itemType: item.type,
      deltaKind: 'output-delta',
      delta: output,
    },
  });
  await publish(f.turn.id, {
    event: 'item.completed',
    ...f.selector,
    turnId: f.turn.id,
    data: { type: 'item-completed', itemId: item.id, item },
  });
  await publish(f.turn.id, {
    event: 'turn.updated',
    ...f.selector,
    turnId: f.turn.id,
    data: {
      type: 'turn-updated',
      turn: f.store.getTurn(DEMO_WORKSPACE_ID, f.thread.id, f.turn.id),
    },
  });
  const readBody = vi.spyOn(f.store, 'getThreadItem');
  await publish(f.turn.id, {
    event: 'item.delta',
    ...f.selector,
    turnId: f.turn.id,
    data: {
      type: 'item-delta',
      itemId: item.id,
      itemType: item.type,
      deltaKind: 'output-delta',
      delta: 'tick',
    },
  });
  expect(readBody).not.toHaveBeenCalled();
  const completed = await f.store.completeTurn(f.turn.id, {
    status: 'completed',
    completedAt: new Date().toISOString(),
  });
  await publish(f.turn.id, {
    event: 'turn.completed',
    ...f.selector,
    turnId: f.turn.id,
    data: { type: 'turn-completed', stopReason: 'completed', turn: completed },
  });
  const replay = await f.app.request(
    `/api/workspaces/${DEMO_WORKSPACE_ID}/threads/${f.thread.id}/events?turnId=${f.turn.id}`
  );
  for (const wire of [await live, await replay.text()]) {
    const frames = wire
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => {
        expect(Buffer.byteLength(line)).toBeLessThanOrEqual(32768);
        return ProductSseEventEnvelopeSchema.parse(JSON.parse(line.slice(6)));
      });
    const previews = frames.filter((frame) => frame.data.type === 'item-preview');
    expect(previews).toHaveLength(3);
    for (const frame of previews) {
      expect(frame.data).toMatchObject({
        type: 'item-preview',
        itemId: item.id,
        body: { ...f.selector, turnId: f.turn.id, itemId: item.id },
        preview: {
          field: 'output',
          sizeBytes: Buffer.byteLength(output),
          side: 'tail',
          truncated: true,
        },
      });
      const preview = (frame.data as unknown as { preview: { text: string } }).preview.text;
      expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(4096);
      expect(output.endsWith(preview)).toBe(true);
      expect(preview.endsWith('exact tail 🙂')).toBe(true);
    }
    expect(frames.find((frame) => frame.data.type === 'turn-updated')?.data).toMatchObject({
      type: 'turn-updated',
      turn: { items: [] },
    });
    expect(frames.at(-1)?.data).toMatchObject({ type: 'turn-completed', turn: { items: [] } });
    expect(wire).not.toContain(output);
  }
  expect(f.store.getThreadItem(DEMO_WORKSPACE_ID, f.thread.id, item.id)).toEqual(item);
}, 20000);

it('keeps oversized inline control envelopes refused while file-backed Item bodies are admitted', () => {
  const request = {
    version: CONTROL_WORKER_VERSION,
    id: 1,
    database: 'fixture',
    operation: 'products',
    transition: {
      products: [
        { kind: 'turn', expectedRevision: 0, record: { id: 'candidate', annotation: 'small' } },
      ],
      entries: [],
    },
  };
  expect(isControlWorkerRequest(request)).toBe(true);
  const oversized = structuredClone(request);
  oversized.transition.products[0]!.record.annotation = 'x'.repeat(5 * 1024 * 1024);
  expect(isControlWorkerRequest(oversized)).toBe(false);
});

it('preserves a 5 MiB text body with JSON escaping and an exact bounded head', async () => {
  const f = await fixture();
  const text = `Exact head 🙂 ${'\0'.repeat(5 * 1024 * 1024)} original end`;
  const item = await f.store.createItem({
    id: allocateEntityId('it'),
    owner: f.turn.owner,
    threadId: f.thread.id,
    turnId: f.turn.id,
    type: 'assistant-message',
    text,
    status: 'completed',
    createdAt: '2026-11-08T17:00:00.000Z',
    completedAt: '2026-11-08T17:00:00.000Z',
  });
  const result = await f.read({ view: 'items', turnId: f.turn.id, placement: 'narrative' });
  expect(result.response.status).toBe(200);
  const projected = result.body.items.find((row: { id: string }) => row.id === item.id);
  expect(projected.detail).toMatchObject({
    kind: 'preview',
    field: 'text',
    side: 'head',
    sizeBytes: Buffer.byteLength(text),
    truncated: true,
  });
  expect(text.startsWith(projected.detail.text)).toBe(true);
  expect(projected.detail.text.startsWith('Exact head 🙂')).toBe(true);
  expect(Buffer.byteLength(projected.detail.text)).toBeLessThanOrEqual(4096);
  const body = await f.app.request('/api/app/operations/thread.item-body', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...f.selector, turnId: f.turn.id, itemId: item.id }),
  });
  expect(body.status).toBe(200);
  expect((await body.json()).item).toEqual(item);
}, 20000);

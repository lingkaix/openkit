// openkit-test-platform: posix
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { allocateEntityId, type Item } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { FsStore } from '../lib/store.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { closeWorkspaceProductReadHandles } from './control-store-products.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openWorkspaceDb } from './db.js';
import { workspaceDbPath } from './fs-layout.js';

const observation = vi.hoisted(() => ({
  root: undefined as string | undefined,
  writes: [] as string[],
}));
// Observe Main only; the actual native worker has its independent filesystem realm.
vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) => {
      if (
        observation.root &&
        String(args[0]).startsWith(observation.root) &&
        /[wa+]/.test(String(args[1]))
      )
        observation.writes.push(String(args[0]));
      return actual.open(...args);
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  observation.root = undefined;
  observation.writes.length = 0;
  vi.restoreAllMocks();
  await shutdownControlStoreWorkerClient();
  for (const root of roots.splice(0)) {
    closeWorkspaceProductReadHandles(root);
    rmSync(root, { recursive: true, force: true });
  }
});

it('publishes exact ordered Workspace events off Main and preserves sealed replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'database-owner-event-'));
  roots.push(root);
  const store = await createDemoStore({ dataRoot: root });
  const turn = await store.createTurn(DEMO_WORKSPACE_ID, DEMO_THREAD_ID, 'Exact events.', {
    kind: 'user',
    id: FIXTURE_LOCAL_USER_ID,
  });
  const items: Item[] = [1, 2].map((index) => ({
    id: allocateEntityId('it'),
    owner: turn.owner,
    threadId: turn.threadId,
    turnId: turn.id,
    type: 'assistant-message',
    status: 'completed',
    text: `${index}: exact large event\n`.repeat(5_000),
    createdAt: turn.startedAt!,
    completedAt: turn.startedAt!,
  }));
  for (const item of items) await store.createItem(item);
  const inputs = items.map((item) => ({
    event: 'item.created' as const,
    workspaceId: DEMO_WORKSPACE_ID,
    threadId: turn.threadId,
    turnId: turn.id,
    data: { type: 'item-created' as const, item },
  }));
  const probe = new Database(':memory:');
  const prototype = Object.getPrototypeOf(probe.prepare('SELECT 1')) as Database.Statement;
  probe.close();
  const reads: string[] = [];
  let armed = true;
  for (const method of ['get', 'all'] as const) {
    const original = prototype[method];
    vi.spyOn(prototype, method).mockImplementation(function (
      this: Database.Statement,
      ...args: unknown[]
    ) {
      if (armed && this.database.name === workspaceDbPath(root, DEMO_WORKSPACE_ID))
        reads.push(this.source);
      return Reflect.apply(original, this, args);
    });
  }
  observation.root = `${join(root, 'workspaces', DEMO_WORKSPACE_ID)}${sep}`;
  const acks: number[] = [];
  const events = await Promise.all(
    inputs.map((input, index) =>
      store.persistTurnEvent(turn.id, input).then((event) => {
        acks.push(index + 1);
        return event;
      })
    )
  ).finally(() => {
    armed = false;
    observation.root = undefined;
  });
  // DatabaseOwner resolves dependent head/sequence and prepares durable payloads in the native owner.
  expect.soft(reads).toEqual([]);
  expect.soft(observation.writes).toEqual([]);
  expect(acks).toEqual([1, 2]);
  expect(events.map((event) => event.sequence)).toEqual([1, 2]);
  expect(events.map((event) => event.data)).toEqual(inputs.map((input) => input.data));
  await store.completeTurn(turn.id, { status: 'completed', completedAt: turn.startedAt! });
  const sealed = store.getTurnEventsForExport(turn.id);
  await expect(store.persistTurnEvent(turn.id, inputs[0]!)).resolves.toEqual(events[0]);
  await expect(
    store.persistTurnEvent(turn.id, {
      ...inputs[0]!,
      data: { ...inputs[0]!.data, item: { ...items[0]!, text: 'Changed after sealing.' } },
    })
  ).rejects.toThrow();
  expect(store.getTurnEventsForExport(turn.id)).toEqual(sealed);
  await shutdownControlStoreWorkerClient();
  closeWorkspaceProductReadHandles(root);
  const reopened = new FsStore({ dataRoot: root });
  expect(reopened.getTurnEventsForExport(turn.id)).toEqual(sealed);
  expect(sealed.slice(0, 2)).toEqual(events);
  closeWorkspaceProductReadHandles(root);
  // Deliberate corruption: retained events cannot prove that their referenced Items still exist.
  const damaged = openWorkspaceDb(root, DEMO_WORKSPACE_ID);
  try {
    expect(
      damaged.sqlite
        .prepare("DELETE FROM control_product_entries WHERE kind='item' AND turn_id=?")
        .run(turn.id).changes
    ).toBe(items.length);
  } finally {
    damaged.sqlite.close();
  }
  await expect(
    new FsStore({ dataRoot: root }).persistTurnEvent(turn.id, inputs[0]!)
  ).rejects.toThrow();
});

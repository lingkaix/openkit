// openkit-test-platform: posix
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId, type Item } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { FsStore } from '../lib/store.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { closeWorkspaceProductReadHandles } from './control-store-product-records.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openWorkspaceDb } from './db.js';
import { workspaceDbPath } from './fs-layout.js';

const roots: string[] = [];
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const root of roots.splice(0)) {
    closeWorkspaceProductReadHandles(root);
    rmSync(root, { recursive: true, force: true });
  }
});

describe('DatabaseOwner addressed Workspace Item publication', () => {
  it('retains ordered large Item revisions across reopen and refuses a corrupt sealed log', async () => {
    const root = mkdtempSync(join(tmpdir(), 'database-owner-item-'));
    roots.push(root);
    const store = await createDemoStore({ dataRoot: root });
    const turn = await store.createTurn(
      DEMO_WORKSPACE_ID,
      DEMO_THREAD_ID,
      'Publish exact revisions.',
      { kind: 'user', id: FIXTURE_LOCAL_USER_ID }
    );
    const first: Item = {
      id: allocateEntityId('it'),
      owner: turn.owner,
      threadId: turn.threadId,
      turnId: turn.id,
      type: 'assistant-message',
      status: 'in_progress',
      text: 'large original\n'.repeat(5_000),
      createdAt: turn.startedAt!,
      completedAt: turn.startedAt!,
    };
    const second: Item = {
      ...first,
      status: 'completed',
      text: `${first.text}final exact bytes\n`,
      completedAt: first.createdAt,
    };
    const databasePath = workspaceDbPath(root, DEMO_WORKSPACE_ID);
    const acknowledgements: number[] = [];
    const results = await Promise.all([
      store.createItem(first).then((item) => {
        acknowledgements.push(1);
        return item;
      }),
      store.createItem(second).then((item) => {
        acknowledgements.push(2);
        return item;
      }),
    ]);
    // Storage Item Log Invariants and DX natural batching preserve same-Turn FULL ACK order.
    expect(acknowledgements).toEqual([1, 2]);
    expect(results).toEqual([first, second]);
    await shutdownControlStoreWorkerClient();
    closeWorkspaceProductReadHandles(root);
    const reopened = new FsStore({ dataRoot: root });
    expect(reopened.listThreadItems(DEMO_WORKSPACE_ID, DEMO_THREAD_ID)).toEqual([second]);
    expect(reopened.listWorkspaceItemRevisions(DEMO_WORKSPACE_ID)).toEqual([first, second]);

    const third: Item = { ...second, id: allocateEntityId('it'), text: 'Third retained sequence.' };
    await reopened.createItem(third);
    await reopened.completeTurn(turn.id, {
      status: 'completed',
      completedAt: second.completedAt,
    });
    await shutdownControlStoreWorkerClient();
    closeWorkspaceProductReadHandles(root);
    // Deliberate corruption leaves each ID at revision1 but removes position2 from the shared log.
    const damaged = new Database(databasePath, { fileMustExist: true });
    try {
      expect(
        damaged
          .prepare(
            "DELETE FROM control_product_entries WHERE kind='item' AND turn_id=? AND sequence=2"
          )
          .run(turn.id).changes
      ).toBe(1);
    } finally {
      damaged.close();
    }
    // Item Log Invariants require contiguous history even for an exact terminal replay.
    await expect(new FsStore({ dataRoot: root }).createItem(third)).rejects.toThrow();
  });
});

it('refuses foreign event payloads, retains exact ordered Workspace events across reopen and preserves sealed replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'database-owner-event-'));
  roots.push(root);
  const store = await createDemoStore({ dataRoot: root });
  const turn = await store.createTurn(DEMO_WORKSPACE_ID, DEMO_THREAD_ID, 'Exact events.', {
    kind: 'user',
    id: FIXTURE_LOCAL_USER_ID,
  });
  const items: Extract<Item, { type: 'assistant-message' }>[] = [1, 2].map((index) => ({
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
  const acks: number[] = [];
  const events = await Promise.all(
    inputs.map((input, index) =>
      store.persistTurnEvent(turn.id, input).then((event) => {
        acks.push(index + 1);
        return event;
      })
    )
  );
  expect(acks).toEqual([1, 2]);
  expect(events.map((event) => event.sequence)).toEqual([1, 2]);
  expect(events.map((event) => event.data)).toEqual(inputs.map((input) => input.data));
  for (const foreign of [
    { ...items[0]!, owner: { kind: 'server' as const } },
    { ...items[0]!, turnId: allocateEntityId('tu') },
  ]) {
    await expect(
      store.persistTurnEvent(turn.id, {
        ...inputs[0]!,
        data: { type: 'item-created', item: foreign },
      })
    ).rejects.toThrow();
    expect(store.getTurnEventsForExport(turn.id)).toEqual(events);
  }
  const nextItem = {
    ...items[0]!,
    id: allocateEntityId('it'),
    text: 'Accepted after refused payloads.',
  };
  await store.createItem(nextItem);
  items.push(nextItem);
  const continued = await store.persistTurnEvent(turn.id, {
    ...inputs[0]!,
    data: { type: 'item-created', item: nextItem },
  });
  expect(continued.sequence).toBe(3);
  expect(store.getTurnEventsForExport(turn.id)).toEqual([...events, continued]);
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

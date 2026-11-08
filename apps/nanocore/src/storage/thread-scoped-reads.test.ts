// openkit-test-platform: posix
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId, type Item } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { FsStore, StoreRecordNotFoundError } from '../lib/store.js';
import { createTestStore, disposeTestStore } from '../test-support/store.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { nativeProductScope, readNativeThreadTurnPages } from './workspace-file-records.js';

const roots: string[] = [];
const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;
afterEach(async () => {
  for (const root of roots.splice(0)) await disposeTestStore(root);
});

/** Admits actual native Turns and Item revisions; timestamps deliberately oppose admission order. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'thread-scoped-native-'));
  roots.push(root);
  const store = createTestStore({ dataRoot: root });
  const workspace = await store.createWorkspace('Thread reads');
  const thread = await store.createThread(workspace.id, 'Requested Thread');
  const sibling = await store.createThread(workspace.id, 'Unrelated Thread');
  const first = await store.createTurn(workspace.id, thread.id, 'First admission', actor, null, {
    startedAt: '2026-11-08T12:00:00.000Z',
  });
  await store.createItem({
    id: allocateEntityId('it'),
    owner: first.owner,
    threadId: thread.id,
    turnId: first.id,
    type: 'user-message',
    actor,
    status: 'completed',
    text: 'Original input',
    createdAt: first.startedAt!,
    completedAt: first.startedAt,
  });
  const item: Extract<Item, { type: 'assistant-message' }> = {
    id: allocateEntityId('it'),
    owner: first.owner,
    threadId: thread.id,
    turnId: first.id,
    type: 'assistant-message',
    status: 'in_progress',
    text: 'Original',
    createdAt: first.startedAt!,
    completedAt: null,
  };
  await store.createItem(item);
  await store.updateItem(item.id, {
    text: 'Updated',
    status: 'completed',
    completedAt: first.startedAt,
  });
  await store.completeTurn(first.id, { status: 'completed', completedAt: first.startedAt });
  const second = await store.createTurn(workspace.id, thread.id, 'Second admission', actor, null, {
    startedAt: '2026-11-08T11:00:00.000Z',
  });
  const unrelated = await store.createTurn(workspace.id, sibling.id, 'Unrelated', actor);
  return {
    root,
    store,
    workspace,
    thread,
    sibling,
    first,
    second,
    unrelated,
    item,
    scope: nativeProductScope(root, { kind: 'workspace', workspaceId: workspace.id }),
  };
}

it('reads native admission order across start times, updates and a cold reopen', async () => {
  const f = await fixture();
  const ids = [f.first.id, f.second.id];
  expect(f.store.listThreadTurns(f.workspace.id, f.thread.id).map((turn) => turn.id)).toEqual(ids);
  const original = [...readNativeThreadTurnPages(f.scope, f.thread.id)].flat();
  expect(original.map((row) => row.record.id)).toEqual(ids);
  expect(original[1]!.admissionOrder).toBeGreaterThan(original[0]!.admissionOrder);
  await f.store.updateTurn(f.second.id, { error: null });
  expect(
    [...readNativeThreadTurnPages(f.scope, f.thread.id)].flat().map((row) => row.admissionOrder)
  ).toEqual(original.map((row) => row.admissionOrder));
  await shutdownControlStoreWorkerClient();
  const cold = new FsStore({ dataRoot: f.root });
  expect(cold.listThreadTurns(f.workspace.id, f.thread.id).map((turn) => turn.id)).toEqual(ids);
  expect(
    [...readNativeThreadTurnPages(f.scope, f.thread.id, original[0]!.admissionOrder)]
      .flat()
      .map((row) => row.record.id)
  ).toEqual([f.second.id]);
});

it('does not decode sibling Turn metadata or disclose its Item through a Thread selector', async () => {
  const f = await fixture();
  expect(() => f.store.getThreadItem(f.workspace.id, f.sibling.id, f.item.id)).toThrow(
    StoreRecordNotFoundError
  );
  await shutdownControlStoreWorkerClient();
  const sqlite = new Database(f.scope.path);
  try {
    sqlite
      .prepare(
        "UPDATE control_turns SET record_json=json_set(record_json,'$.status','unsupported') WHERE id=?"
      )
      .run(f.unrelated.id);
    expect(f.store.listThreadTurns(f.workspace.id, f.thread.id).map((turn) => turn.id)).toEqual([
      f.first.id,
      f.second.id,
    ]);
    expect(() => f.store.listThreadTurns(f.workspace.id, f.sibling.id)).toThrow();
    expect(() =>
      sqlite
        .prepare('UPDATE control_turns SET admission_order=admission_order+100 WHERE id=?')
        .run(f.first.id)
    ).toThrow('Turn admission order is immutable');
  } finally {
    sqlite.close();
  }
});

it('resolves the current exact Item and counts originals rather than revision rows', async () => {
  const f = await fixture();
  expect(f.store.getThreadItem(f.workspace.id, f.thread.id, f.item.id)).toMatchObject({
    id: f.item.id,
    text: 'Updated',
    status: 'completed',
  });
  // The fixture explicitly admits one user message and two revisions of one assistant Item.
  expect(f.store.getThreadTurnItemCounts(f.workspace.id, f.thread.id, f.first.id)).toEqual({
    'assistant-message': 1,
    'user-message': 1,
  });
  expect(() => f.store.getThreadTurnItemCounts(f.workspace.id, f.sibling.id, f.first.id)).toThrow(
    StoreRecordNotFoundError
  );
});

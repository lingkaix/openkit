// openkit-test-platform: posix
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { allocateEntityId, type Item } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FsStore } from '../lib/store.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { closeWorkspaceProductReadHandles } from './control-store-products.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { workspaceDbPath } from './fs-layout.js';

const observation = vi.hoisted(() => ({
  workspaceRoot: undefined as string | undefined,
  writeOpens: [] as string[],
}));

// Observe actual Main filesystem effects; the real worker retains its independent filesystem realm.
vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) => {
      const path = String(args[0]);
      if (
        observation.workspaceRoot &&
        path.startsWith(observation.workspaceRoot) &&
        /[wa+]/.test(String(args[1]))
      )
        observation.writeOpens.push(path);
      return actual.open(...args);
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  observation.workspaceRoot = undefined;
  observation.writeOpens.length = 0;
  vi.restoreAllMocks();
  await shutdownControlStoreWorkerClient();
  for (const root of roots.splice(0)) {
    closeWorkspaceProductReadHandles(root);
    rmSync(root, { recursive: true, force: true });
  }
});

describe('DatabaseOwner addressed Workspace Item publication', () => {
  it('keeps dependent reads and large-body preparation off Main for new and revised Items', async () => {
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
    const probe = new Database(':memory:');
    const statementPrototype = Object.getPrototypeOf(
      probe.prepare('SELECT 1')
    ) as Database.Statement;
    probe.close();
    const databasePath = workspaceDbPath(root, DEMO_WORKSPACE_ID);
    const mainReads: string[] = [];
    let armed = true;
    // Cached statements also cross these actual native methods; observing prepare alone misses them.
    for (const method of ['get', 'all'] as const) {
      const original = statementPrototype[method];
      vi.spyOn(statementPrototype, method).mockImplementation(function (
        this: Database.Statement,
        ...args: unknown[]
      ) {
        if (armed && this.database.name === databasePath) mainReads.push(this.source);
        return Reflect.apply(original, this, args);
      });
    }
    observation.workspaceRoot = `${join(root, 'workspaces', DEMO_WORKSPACE_ID)}${sep}`;
    const acknowledgements: number[] = [];
    let results: Item[];
    try {
      results = await Promise.all([
        store.createItem(first).then((item) => {
          acknowledgements.push(1);
          return item;
        }),
        store.createItem(second).then((item) => {
          acknowledgements.push(2);
          return item;
        }),
      ]);
    } finally {
      armed = false;
      observation.workspaceRoot = undefined;
    }
    // Foundation DatabaseOwner writer and R4277 move the complete dependent preparation off Main.
    expect.soft(mainReads).toEqual([]);
    expect.soft(observation.writeOpens).toEqual([]);
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

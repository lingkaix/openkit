// openkit-test-platform: posix
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { allocateEntityId, ItemSchema, writeRetainedV1 } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FsStore } from '../lib/store.js';
import { createTestStore } from '../test-support/store.js';
import { openControlStoreProductReadHandle } from './control-store-products.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { prepareImmutableProductJson, readImmutableProductJson } from './immutable-content.js';
import { nativeProductScope, readNativeProductEntries } from './workspace-file-records.js';

const observation = vi.hoisted(() => ({ readers: [] as import('better-sqlite3').Database[] }));

// Observe actual Main read connections; all SQLite construction and effects pass through.
vi.mock('better-sqlite3', async (load) => {
  const actual = await load<{ default: typeof Database }>();
  return {
    ...actual,
    default: class extends actual.default {
      constructor(...args: ConstructorParameters<typeof actual.default>) {
        super(...args);
        if (this.readonly) observation.readers.push(this);
      }
    },
  };
});

const roots: string[] = [];
const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;

afterEach(async () => {
  vi.restoreAllMocks();
  await shutdownControlStoreWorkerClient();
  observation.readers.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Establishes real acknowledged Store records before any retained-byte fault. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-product-head-semantics-'));
  roots.push(root);
  const store = createTestStore({ dataRoot: root });
  const workspace = await store.createWorkspace('Retained Item semantics');
  const thread = await store.createThread(workspace.id, 'Addressed publication');
  const turn = await store.createTurn(workspace.id, thread.id, 'Input', actor);
  const item = ItemSchema.parse({
    id: allocateEntityId('it'),
    owner: turn.owner,
    threadId: thread.id,
    turnId: turn.id,
    type: 'user-message',
    actor,
    text: 'Acknowledged original',
    status: 'completed',
    createdAt: turn.startedAt!,
    completedAt: turn.startedAt!,
  });
  await expect(store.createItem(item)).resolves.toEqual(item);
  const scope = nativeProductScope(root, { kind: 'workspace', workspaceId: workspace.id });
  return { root, store, workspace, thread, turn, item, scope };
}

/** Reads the committed descriptor cut even when unsupported body semantics refuse product history. */
function committedCut(f: Awaited<ReturnType<typeof fixture>>) {
  const reader = openControlStoreProductReadHandle(f.scope.path, f.scope.owner);
  try {
    return {
      turn: reader.get('turn', f.turn.id)!,
      items: reader.entries(f.turn.id, 'item', 0),
      events: reader.entries(f.turn.id, 'event', 0),
    };
  } finally {
    reader.close();
  }
}

/** Publishes exact retained fault bytes through real immutable preparation and native SQL ownership. */
async function appendRetainedItem(
  f: Awaited<ReturnType<typeof fixture>>,
  value: Record<string, unknown>
) {
  const before = committedCut(f);
  const previous = before.items.filter((entry) => entry.id === f.item.id).at(-1)!;
  const prepared = await prepareImmutableProductJson(
    f.scope.contentMount,
    f.scope.owner,
    join(dirname(dirname(f.scope.path)), 'runtime', 'staging'),
    value
  );
  await expect(
    getControlStoreWorkerClient().products(`workspace:${f.scope.path}`, {
      products: [
        { kind: 'turn', expectedRevision: before.turn.revision, record: before.turn.record },
      ],
      entries: [
        {
          kind: 'item',
          turnId: f.turn.id,
          sequence: before.items.at(-1)!.sequence + 1,
          expectedRevision: previous.revision,
          ...prepared,
        },
      ],
    })
  ).resolves.toBeUndefined();
  expect(readImmutableProductJson(f.scope.contentMount, f.scope.owner, prepared.content)).toEqual(
    value
  );
}

/** Uses the public addressed event publisher with the same validated Item as its positive control. */
function publishEvent(f: Awaited<ReturnType<typeof fixture>>, item: typeof f.item) {
  return f.store.persistTurnEvent(f.turn.id, {
    event: 'item.completed',
    workspaceId: f.workspace.id,
    threadId: f.thread.id,
    turnId: f.turn.id,
    requestId: null,
    data: { type: 'item-completed', itemId: item.id, item },
  });
}

describe('addressed retained Item required semantics', () => {
  it.each([
    ['Item revision', ['future-item-authority-v1']],
    ['Item revision', 'future-item-authority-v1'],
    ['addressed event', ['future-item-authority-v1']],
    ['addressed event', 'future-item-authority-v1'],
  ] as const)('refuses %s for requiredFeatures=%j before acknowledging another reference', async (operation, requiredFeatures) => {
    const f = await fixture();
    // Contract Evolution: descriptive additions and an empty required-feature list remain readable.
    const descriptive = {
      ...writeRetainedV1(f.item),
      operatorNote: { purpose: 'descriptive only' },
      requiredFeatures: [],
    };
    await appendRetainedItem(f, descriptive);
    expect(readNativeProductEntries(f.scope, f.turn.id, 'item').at(-1)!.value).toEqual(descriptive);
    const candidate = { ...f.item, text: 'Descriptive revision acknowledged' };
    await expect(f.store.createItem(candidate)).resolves.toEqual({
      ...candidate,
      operatorNote: descriptive.operatorNote,
      requiredFeatures: [],
    });
    await expect(publishEvent(f, candidate)).resolves.toMatchObject({
      event: 'item.completed',
      data: { itemId: candidate.id },
    });

    // Fault injection starts only after both public publication controls have acknowledged success.
    await appendRetainedItem(f, { ...writeRetainedV1(candidate), requiredFeatures });
    const before = committedCut(f);
    // The established complete-history reader supplies an independent refusal control.
    expect(() => readNativeProductEntries(f.scope, f.turn.id, 'item')).toThrow();

    const attempt =
      operation === 'Item revision'
        ? f.store.createItem({ ...candidate, text: 'Must not be acknowledged' })
        : publishEvent(f, candidate);
    const [outcome] = await Promise.allSettled([attempt]);
    // Contract Evolution, Closed Core, Open Extension: unsupported required semantics fail closed.
    expect.soft(outcome!.status).toBe('rejected');
    // Durable Execution, Commit Rule: refusal creates no Item/event reference or Turn revision.
    expect(committedCut(f)).toEqual(before);
  });
});

describe('retained native metadata reader lifetime', () => {
  it('reuses statements and fresh snapshots, then closes readers through complete and repeated shutdown', async () => {
    const f = await fixture();
    const peer = new FsStore({ dataRoot: f.root });
    const { items: _items, ...expected } = f.store.getTurnById(f.turn.id);
    const readers = () => observation.readers.filter((sqlite) => sqlite.name === f.scope.path);
    const prepared = vi.spyOn(Database.prototype, 'prepare');
    expect(f.store.getTurnMetadata(f.workspace.id, f.thread.id, f.turn.id)).toEqual(expected);

    // COORD07:1x requires one readonly, query-only connection per Workspace DB and cached statements.
    const retained = readers().filter((sqlite) => sqlite.open);
    expect(retained).toHaveLength(1);
    const reader = retained[0]!;
    expect(reader.readonly).toBe(true);
    expect(reader.pragma('query_only', { simple: true })).toBe(1);
    expect(reader.inTransaction).toBe(false);
    const opened = readers().length;
    prepared.mockClear();
    for (const store of [f.store, peer, f.store, peer]) {
      expect(store.getTurnMetadata(f.workspace.id, f.thread.id, f.turn.id)).toEqual(expected);
      expect(reader.inTransaction).toBe(false);
    }
    expect(readers()).toHaveLength(opened);
    expect(readers().filter((sqlite) => sqlite.open)).toEqual([reader]);
    expect(
      (prepared.mock.contexts as Database.Database[]).filter(
        (sqlite) => sqlite.readonly && sqlite.name === f.scope.path
      )
    ).toHaveLength(0);
    prepared.mockRestore();

    // The same connection must see an acknowledged commit without a row cache or pinned snapshot.
    await f.store.completeTurn(f.turn.id, { status: 'completed', completedAt: f.turn.startedAt! });
    const { items: _currentItems, ...current } = new FsStore({ dataRoot: f.root }).getTurnById(
      f.turn.id
    );
    expect(current.status).toBe('completed');
    expect(f.store.getTurnMetadata(f.workspace.id, f.thread.id, f.turn.id)).toEqual(current);
    expect(readers().filter((sqlite) => sqlite.open)).toEqual([reader]);
    expect(reader.inTransaction).toBe(false);

    // Shutdown includes readers opened while real Worker termination is still settling.
    let reached!: () => void;
    const terminating = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const terminate = Worker.prototype.terminate;
    const heldTermination = vi.spyOn(Worker.prototype, 'terminate').mockImplementation(function (
      this: Worker
    ) {
      return terminate.call(this).then(async (code) => {
        reached();
        await released;
        return code;
      });
    });
    const stopping = shutdownControlStoreWorkerClient();
    try {
      await terminating;
      expect(f.store.getTurnMetadata(f.workspace.id, f.thread.id, f.turn.id)).toEqual(current);
    } finally {
      release();
      try {
        await stopping;
      } finally {
        heldTermination.mockRestore();
      }
    }
    expect(readers().filter((sqlite) => sqlite.open)).toEqual([]);

    // Read-only inspection can reopen a reader after shutdown; repeated cleanup closes it too.
    expect(f.store.getTurnMetadata(f.workspace.id, f.thread.id, f.turn.id)).toEqual(current);
    await shutdownControlStoreWorkerClient();
    expect(readers().filter((sqlite) => sqlite.open)).toEqual([]);
  });
});

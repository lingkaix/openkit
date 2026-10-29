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
import {
  nativeProductScope,
  readNativeProductEntries,
  readNativeTurnWriteHead,
} from './workspace-file-records.js';

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
  it('reuses the Workspace reader for public opaque lookups and sees later native acknowledgements', async () => {
    const f = await fixture();
    const peer = new FsStore({ dataRoot: f.root });
    const readers = () => observation.readers.filter((sqlite) => sqlite.name === f.scope.path);
    const expected = f.store.getTurnMetadata(f.workspace.id, f.thread.id, f.turn.id);
    expect(f.store.getTurnLineage(f.turn.id)).toEqual({
      workspaceId: f.workspace.id,
      threadId: f.thread.id,
    });
    const reader = readers().find((sqlite) => sqlite.open)!;
    const opened = readers().length;
    const prepared = vi.spyOn(Database.prototype, 'prepare');
    for (const store of [f.store, peer]) {
      expect(store.getTurnLineage(f.turn.id)).toEqual({
        workspaceId: f.workspace.id,
        threadId: f.thread.id,
      });
    }
    const lookupOpens = readers().length - opened;
    const metadataPreparations = prepared.mock.calls.filter(
      ([sql], index) =>
        /SELECT \* FROM control_workspaces WHERE id=/.test(sql) &&
        (prepared.mock.contexts[index] as Database.Database).name === f.scope.path
    ).length;
    prepared.mockRestore();

    // DX committed reads: the same opaque path must observe later real native ACKs.
    const revised = { ...f.item, text: 'Acknowledged after opaque lookup warming' };
    await expect(peer.createItem(revised)).resolves.toEqual(revised);
    await peer.completeTurn(f.turn.id, { status: 'completed', completedAt: f.turn.startedAt! });
    const current = f.store.getTurnById(f.turn.id);
    expect(current).toMatchObject({
      id: expected.id,
      owner: expected.owner,
      threadId: expected.threadId,
      status: 'completed',
    });
    expect(current.items.find((item) => item.id === f.item.id)).toEqual(revised);
    expect(f.store.getThread(f.workspace.id, f.thread.id)).toEqual(
      peer.getThread(f.workspace.id, f.thread.id)
    );
    expect(reader.inTransaction).toBe(false);
    expect(
      observation.readers.filter((sqlite) => sqlite.name.endsWith('/core.sqlite') && sqlite.open)
    ).toEqual([]);

    // The existing Workspace owner retains connections and metadata statements, never rows.
    expect(lookupOpens).toBe(0);
    expect(metadataPreparations).toBe(0);
    expect(readers().filter((sqlite) => sqlite.open)).toEqual([reader]);
  });

  it('invalidates the exact retained Workspace reader after a public opaque selector failure', async () => {
    const f = await fixture();
    const expected = f.store.getTurnMetadata(f.workspace.id, f.thread.id, f.turn.id);
    const reader = observation.readers.find(
      (sqlite) => sqlite.name === f.scope.path && sqlite.open
    )!;
    const failure = new Error('Injected opaque selector preparation failure');
    const prepare = Database.prototype.prepare;
    const fault = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
      this: Database.Database,
      sql: string
    ) {
      // Fail the real SQLite crossing once, without replacing rows or acknowledgements.
      if (
        this.name === f.scope.path &&
        /SELECT schema_version,thread_id FROM control_turns WHERE id=/.test(sql)
      ) {
        throw failure;
      }
      return prepare.call(this, sql);
    });
    try {
      expect(() => f.store.getTurnById(f.turn.id)).toThrow(failure);
    } finally {
      fault.mockRestore();
    }
    const invalidated = !reader.open;
    // A closed registry entry must not poison the next normal public metadata read.
    expect(f.store.getTurnMetadata(f.workspace.id, f.thread.id, f.turn.id)).toEqual(expected);
    expect(f.store.getTurnById(f.turn.id).id).toBe(f.turn.id);
    expect(invalidated).toBe(true);
    const retained = observation.readers.filter(
      (sqlite) => sqlite.name === f.scope.path && sqlite.open
    );
    expect(retained).toHaveLength(1);
    expect(retained[0]).not.toBe(reader);
  });

  it('reuses statements and fresh snapshots, then closes readers through complete and repeated shutdown', async () => {
    const f = await fixture();
    const peer = new FsStore({ dataRoot: f.root });
    const { items: _items, ...expected } = f.store.getTurnById(f.turn.id);
    const readers = () => observation.readers.filter((sqlite) => sqlite.name === f.scope.path);
    const cut = committedCut(f);
    const itemHead = cut.items.filter((entry) => entry.id === f.item.id).at(-1)!;
    const expectedHead = {
      revision: cut.turn.revision,
      metadata: cut.turn.record,
      itemRevision: itemHead.revision,
      itemSequence: cut.items.at(-1)!.sequence,
      eventSequence: cut.events.at(-1)?.sequence ?? 0,
      itemRevisions: [f.item],
    };
    const prepared = vi.spyOn(Database.prototype, 'prepare');
    expect(f.store.getTurnMetadata(f.workspace.id, f.thread.id, f.turn.id)).toEqual(expected);
    expect(readNativeTurnWriteHead(f.scope, f.turn.id, f.item.id)).toMatchObject(expectedHead);

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
      // COORD13:1x extends retained connections and statements to addressed publication heads.
      expect(readNativeTurnWriteHead(f.scope, f.turn.id, f.item.id)).toMatchObject(expectedHead);
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

    // DX committed-read semantics: warmed heads must see both later Item and event ACKs.
    const revised = { ...f.item, text: 'Committed after warming the addressed head' };
    await expect(f.store.createItem(revised)).resolves.toEqual(revised);
    await publishEvent(f, revised);
    expect(readNativeTurnWriteHead(f.scope, f.turn.id, f.item.id)).toMatchObject({
      itemRevisions: [revised],
      itemRevision: itemHead.revision + 1,
      itemSequence: expectedHead.itemSequence + 1,
      eventSequence: expectedHead.eventSequence + 1,
    });
    expect(reader.inTransaction).toBe(false);

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

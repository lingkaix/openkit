import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { allocateEntityId, ItemSchema } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { nativeProductScope, readNativeProductEntries } from '../storage/workspace-file-records.js';
import { createTestStore } from '../test-support/store.js';
import { FsStore, StoreRecordNotFoundError } from './store.js';

const observation = vi.hoisted(() => ({
  active: undefined as
    | { root: string; priorIds: Set<string>; metadata: number; priorBodies: number }
    | undefined,
}));

// Observe actual Main filesystem work. All calls, bytes and native worker effects pass through.
// No production helper, statement, directory layout or connection placement is prescribed.
vi.mock('node:fs', async (load) => {
  const actual = await load<typeof import('node:fs')>();
  const observed: Record<string, unknown> = { ...actual };
  for (const name of ['lstatSync', 'readdirSync', 'realpathSync', 'openSync'] as const) {
    observed[name] = (...args: unknown[]) => {
      const active = observation.active;
      if (active && typeof args[0] === 'string' && args[0].startsWith(active.root)) {
        active.metadata++;
      }
      return Reflect.apply(actual[name], actual, args);
    };
  }
  observed.readFileSync = ((...args: unknown[]) => {
    const value = Reflect.apply(actual.readFileSync, actual, args);
    const active = observation.active;
    if (active) {
      try {
        const record = JSON.parse(value.toString());
        if (active.priorIds.has(record?.id)) active.priorBodies++;
      } catch {
        // Non-JSON files are outside the retained Item-body observation.
      }
    }
    return value;
  }) as typeof actual.readFileSync;
  return observed;
});

const roots: string[] = [];
const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;
type Turn = ReturnType<FsStore['getTurnById']>;
type Item = ReturnType<typeof message>;

/** Builds an ordinary Core-minted Item, not a retained-ID import candidate. */
function message(turn: Turn, index: number) {
  return ItemSchema.parse({
    id: allocateEntityId('it'),
    owner: turn.owner,
    threadId: turn.threadId,
    turnId: turn.id,
    type: 'user-message',
    actor,
    text: `Message ${index}`.padEnd(128, '.'),
    status: 'completed',
    createdAt: turn.startedAt!,
    completedAt: turn.startedAt!,
  });
}

/** Creates the native schema and Workspace through existing shared and production owners. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'store-write-complexity-'));
  roots.push(root);
  const store = createTestStore({ dataRoot: root });
  initializeDefaultKnowledgeBaseId({
    dataRoot: root,
    scope: { kind: 'server' },
    knowledgeBaseId: allocateEntityId('kb'),
  });
  const workspace = await store.createWorkspace('Write complexity');
  return { root, store, workspace };
}

/** Reaches short or long retained history through acknowledged public writes only. */
async function history(f: Awaited<ReturnType<typeof fixture>>, count: number) {
  const thread = await f.store.createThread(f.workspace.id, `History ${count}`);
  const turn = await f.store.createTurn(f.workspace.id, thread.id, 'Write messages', actor);
  const expected: Item[] = [];
  for (let index = 0; index < count; index++) {
    const item = message(turn, index);
    expect(await f.store.createItem(item)).toEqual(item);
    expected.push(item);
  }
  return { turn, expected };
}

/** Measures a real ACK and proves its retained native bytes separately from the cost observation. */
async function sample(
  f: Awaited<ReturnType<typeof fixture>>,
  h: Awaited<ReturnType<typeof history>>,
  label: string
) {
  const item = message(h.turn, h.expected.length);
  const active = {
    root: f.root,
    priorIds: new Set(h.expected.map((value) => value.id)),
    metadata: 0,
    priorBodies: 0,
  };
  observation.active = active;
  let returned: Item;
  try {
    returned = await f.store.createItem(item);
  } finally {
    observation.active = undefined;
  }
  expect(returned).toEqual(item);
  h.expected.push(item);

  // Time a separate uninstrumented real write. Timing informs the scale comparison;
  // filesystem counts decide it, so host load cannot turn the regression green or red.
  const timed = message(h.turn, h.expected.length);
  const started = performance.now();
  const timedResult = await f.store.createItem(timed);
  const elapsedMs = performance.now() - started;
  expect(timedResult).toEqual(timed);
  h.expected.push(timed);

  // A fresh reader proves that an in-memory result cannot satisfy either arm.
  const cold = new FsStore({ dataRoot: f.root });
  const control = {
    ...active,
    priorIds: new Set(h.expected.map((value) => value.id)),
    metadata: 0,
    priorBodies: 0,
  };
  observation.active = control;
  try {
    expect(cold.getTurnById(h.turn.id).items).toEqual(h.expected);
  } finally {
    observation.active = undefined;
  }
  // Explicit history reads must exercise the observer: a detached hook cannot pass the cost check.
  expect(control.priorBodies).toBeGreaterThanOrEqual(h.expected.length);
  expect(control.metadata).toBeGreaterThan(0);
  const rows = readNativeProductEntries(
    nativeProductScope(f.root, h.turn.owner),
    h.turn.id,
    'item'
  );
  expect(rows.map((row) => [row.sequence, row.id, row.revision])).toEqual(
    h.expected.map((value, index) => [index + 1, value.id, 1])
  );
  const result = { label, metadata: active.metadata, priorBodies: active.priorBodies, elapsedMs };
  console.info('PERF-READ', JSON.stringify(result));
  return result;
}

afterEach(async () => {
  observation.active = undefined;
  try {
    await shutdownControlStoreWorkerClient();
  } finally {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }
});

// #445 accepted COORD14:35Z course, as amended by COORD00:3xZ:
// ordinary Core-minted writes have flat cost in Workspace count and Turn history.
describe('Store native write complexity', () => {
  it('does no more filesystem discovery with eight Workspaces than with one', async () => {
    const f = await fixture();
    const one = await sample(f, await history(f, 1), '1 Workspace, 1 prior Item');
    for (let index = 1; index < 8; index++) await f.store.createWorkspace(`Sibling ${index}`);
    const eight = await sample(f, await history(f, 1), '8 Workspaces, 1 prior Item');
    expect(eight.metadata).toBeLessThanOrEqual(one.metadata);
  });

  it('does no more retained-body work with long history than with short history', async () => {
    const f = await fixture();
    const short = await sample(f, await history(f, 1), '1 Workspace, 1 prior Item');
    const long = await sample(f, await history(f, 32), '1 Workspace, 32 prior Items');
    expect(long.priorBodies).toBeLessThanOrEqual(short.priorBodies);
    expect(long.metadata).toBeLessThanOrEqual(short.metadata);
  });
});

/** Appends real canonical events and checks their complete retained order after reopen. */
async function eventSample(f: Awaited<ReturnType<typeof fixture>>, count: number, label: string) {
  const h = await history(f, count);
  const input = (item: Item) => ({
    event: 'item.created' as const,
    workspaceId: f.workspace.id,
    threadId: h.turn.threadId,
    turnId: h.turn.id,
    data: { type: 'item-created' as const, item },
  });
  const expected = [];
  for (const item of h.expected.slice(0, -1)) {
    expected.push(await f.store.persistTurnEvent(h.turn.id, input(item)));
  }
  const active = {
    root: f.root,
    priorIds: new Set(h.expected.map((item) => item.id)),
    metadata: 0,
    priorBodies: 0,
  };
  observation.active = active;
  try {
    expected.push(await f.store.persistTurnEvent(h.turn.id, input(h.expected.at(-1)!)));
  } finally {
    observation.active = undefined;
  }
  expect(expected.map((event) => event.sequence)).toEqual(h.expected.map((_, index) => index + 1));
  const cold = new FsStore({ dataRoot: f.root });
  expect(cold.getTurnById(h.turn.id).items).toEqual(h.expected);
  expect(cold.getTurnEventsForExport(h.turn.id)).toEqual(expected);
  const rows = readNativeProductEntries(
    nativeProductScope(f.root, h.turn.owner),
    h.turn.id,
    'event'
  );
  expect(rows.map((row) => [row.sequence, row.revision])).toEqual(
    expected.map((event) => [event.sequence, 1])
  );
  const result = { label, metadata: active.metadata, priorBodies: active.priorBodies };
  console.info('PERF-READ event append', JSON.stringify(result));
  return result;
}

describe('Store addressed event and current metadata reads', () => {
  it('keeps addressed event append cost flat across Workspaces and retained history', async () => {
    const f = await fixture();
    const one = await eventSample(f, 1, '1 Workspace, short history');
    for (let index = 1; index < 8; index++) await f.store.createWorkspace(`Sibling ${index}`);
    const eight = await eventSample(f, 1, '8 Workspaces, short history');
    const long = await eventSample(f, 32, '8 Workspaces, long history');
    expect(eight.metadata).toBeLessThanOrEqual(one.metadata);
    expect(eight.priorBodies).toBeLessThanOrEqual(one.priorBodies);
    expect(long.metadata).toBeLessThanOrEqual(eight.metadata);
    expect(long.priorBodies).toBeLessThanOrEqual(eight.priorBodies);
  });

  it('returns actual current metadata for point hints and preserves lookup and storage errors', async () => {
    const f = await fixture();
    const h = await history(f, 32);
    const sibling = await f.store.createWorkspace('Other metadata hint');
    const otherThread = await f.store.createThread(f.workspace.id, 'Other Thread hint');
    const { items: _items, ...expected } = f.store.getTurnById(h.turn.id);
    const active = {
      root: f.root,
      priorIds: new Set(h.expected.map((item) => item.id)),
      metadata: 0,
      priorBodies: 0,
    };
    observation.active = active;
    let metadata: ReturnType<FsStore['getTurnMetadata']>;
    try {
      metadata = f.store.getTurnMetadata(f.workspace.id, h.turn.threadId, h.turn.id);
    } finally {
      observation.active = undefined;
    }
    expect(metadata).toEqual(expected);
    expect(metadata).not.toHaveProperty('items');
    expect(active.priorBodies).toBe(0);
    // Hints locate a point read; only the actual returned owner and Thread are authority.
    for (const [workspaceId, threadId] of [
      [sibling.id, h.turn.threadId],
      [f.workspace.id, otherThread.id],
    ]) {
      const hinted = f.store.getTurnMetadata(workspaceId!, threadId!, h.turn.id);
      expect(hinted).toEqual(expected);
      expect(hinted.owner).toEqual(h.turn.owner);
      expect(hinted.threadId).toBe(h.turn.threadId);
    }
    expect(() =>
      f.store.getTurnMetadata(f.workspace.id, h.turn.threadId, allocateEntityId('tu'))
    ).toThrow(StoreRecordNotFoundError);
    await f.store.completeTurn(h.turn.id, {
      status: 'completed',
      completedAt: h.turn.startedAt!,
    });
    const { items: _currentItems, ...current } = new FsStore({ dataRoot: f.root }).getTurnById(
      h.turn.id
    );
    expect(current.status).toBe('completed');
    expect(f.store.getTurnMetadata(f.workspace.id, h.turn.threadId, h.turn.id)).toEqual(current);

    // A real unavailable hint database is a storage failure, not a known selector miss.
    // Keep the actual Turn healthy so a catch-and-fallback implementation would return success.
    const path = nativeProductScope(f.root, { kind: 'workspace', workspaceId: sibling.id }).path;
    renameSync(path, `${path}.held`);
    try {
      mkdirSync(path);
      let failure: unknown;
      try {
        f.store.getTurnMetadata(sibling.id, h.turn.threadId, h.turn.id);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(StoreRecordNotFoundError);
    } finally {
      rmSync(path, { recursive: true, force: true });
      renameSync(`${path}.held`, path);
    }
  });
});

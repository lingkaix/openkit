// openkit-test-platform: posix

import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { allocateEntityId, ItemSchema, type TurnSchema, writeRetainedV1 } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestStore } from '../test-support/store.js';
import {
  type ControlProductEntry,
  type ControlProductTransition,
  type ControlStoreProductReadHandle,
  openControlStoreProductReadHandle,
} from './control-store-products.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { CONTROL_WORKER_LIMITS, isControlProductCohort } from './control-store-worker-protocol.js';
import { prepareImmutableProductJson } from './immutable-content.js';
import { nativeProductScope } from './workspace-file-records.js';

const instrument = vi.hoisted(() => ({
  shared: undefined as SharedArrayBuffer | undefined,
  source: '',
  replies: [] as { id: number; status: string }[],
}));

// The entry, file operations, SQLite execution, transport and original replies remain real.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        const entry = options?.eval
          ? String(filename)
          : `import(${JSON.stringify(String(filename))});`;
        super(
          `(${instrument.source})(require, require('node:worker_threads').workerData);` + entry,
          {
            ...options,
            eval: true,
            workerData: {
              ...options?.workerData,
              shared: instrument.shared,
              databaseModule: createRequire(import.meta.url).resolve('better-sqlite3'),
            },
          }
        );
        this.on('message', (reply) => instrument.replies.push(reply));
      }
    },
  };
});

/** Holds actual file synchronization, coalescing callbacks and outer COMMIT; replies stay real. */
function install(
  require: NodeRequire,
  data: { shared: SharedArrayBuffer; databaseModule: string }
) {
  const state = new Int32Array(data.shared, 0, 16);
  // DX first-idle/barrier work must advance even while deliberate 5 ms callbacks are held.
  const setTimer = globalThis.setTimeout;
  const clearTimer = globalThis.clearTimeout;
  const heldTimers = new Map<ReturnType<typeof setTimeout>, { cancelled: boolean }>();
  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay !== 5 || !Atomics.load(state, 10)) return setTimer(callback, delay, ...args);
    const held = { cancelled: false };
    const timer = setTimer(async () => {
      Atomics.add(state, 11, 1);
      await Atomics.waitAsync(state, 12, 0).value;
      if (!held.cancelled) callback(...args);
      heldTimers.delete(timer);
    }, delay);
    heldTimers.set(timer, held);
    return timer;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout> | undefined) => {
    const held = timer === undefined ? undefined : heldTimers.get(timer);
    if (held) held.cancelled = true;
    clearTimer(timer);
  }) as typeof clearTimeout;
  const fs = require('node:fs/promises') as typeof import('node:fs/promises');
  const open = fs.open;
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    const target = Buffer.from(data.shared, 64, 64).toString();
    for (const method of ['sync', 'datasync'] as const) {
      const actual = file[method].bind(file);
      file[method] = async () => {
        if (
          Atomics.load(state, 0) &&
          String(args[0]).includes(target) &&
          Atomics.compareExchange(state, 1, 0, 1) === 0
        )
          await Atomics.waitAsync(state, 2, 0).value;
        return actual();
      };
    }
    return file;
  }) as typeof fs.open;
  require('node:module').syncBuiltinESMExports();
  const Database = require(data.databaseModule);
  const exec = Database.prototype.exec;
  Database.prototype.exec = function (
    this: { pragma(sql: string, options: { simple: boolean }): number },
    sql: string
  ) {
    const commit = /^COMMIT$/i.test(sql) && Atomics.load(state, 0);
    if (commit) {
      Atomics.add(state, 6, 1);
      if (this.pragma('synchronous', { simple: true }) !== 2) Atomics.add(state, 8, 1);
      if (Atomics.load(state, 3) && Atomics.compareExchange(state, 4, 0, 1) === 0)
        Atomics.wait(state, 5, 0);
      if (Atomics.load(state, 13) && Atomics.load(state, 6) === 2) {
        Atomics.store(state, 14, 1);
        Atomics.wait(state, 15, 0);
      }
    }
    const result = exec.call(this, sql);
    if (commit) Atomics.add(state, 7, 1);
    if (/^ROLLBACK TO\b/i.test(sql) && Atomics.load(state, 0)) Atomics.add(state, 9, 1);
    return result;
  };
}

type Frame = { requests: { id: number; transition: ControlProductTransition }[] };
type Lane = {
  turn: ReturnType<typeof TurnSchema.parse>;
  scope: ReturnType<typeof nativeProductScope>;
  reader: ControlStoreProductReadHandle;
  database: string;
  head: NonNullable<ReturnType<ControlStoreProductReadHandle['get']>>;
};
const roots: string[] = [];
const readers: ControlStoreProductReadHandle[] = [];
function release(index: 2 | 5 | 12 | 15) {
  if (!instrument.shared) return;
  const state = new Int32Array(instrument.shared, 0, 16);
  Atomics.store(state, index, 1);
  Atomics.notify(state, index);
}
afterEach(async () => {
  release(2);
  release(5);
  release(12);
  release(15);
  await shutdownControlStoreWorkerClient();
  for (const reader of readers.splice(0)) reader.close();
  instrument.shared = undefined;
  instrument.replies = [];
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Reuses Store-owned running Turns and Storage-owned immutable bodies, not synthetic durable rows. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-cohort-'));
  roots.push(root);
  instrument.shared = new SharedArrayBuffer(128);
  instrument.source = install.toString();
  const state = new Int32Array(instrument.shared, 0, 16);
  const store = createTestStore({ dataRoot: root });
  const workspace = await store.createWorkspace('Native cohort');
  const client = getControlStoreWorkerClient();
  const lanes: Lane[] = [];
  for (let index = 0; index < 2; index++) {
    const thread = await store.createThread(workspace.id, 'Independent Turn');
    const turn = await store.createTurn(workspace.id, thread.id, 'Input', {
      kind: 'user',
      id: 'usr_00000000-0000-7000-8000-000000000001',
    });
    const scope = nativeProductScope(root, turn.owner);
    const database = `workspace:${scope.path}`;
    await client.open({
      database,
      path: scope.path,
      dataRoot: root,
      create: false,
      initialize: 'workspace',
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
    const reader = openControlStoreProductReadHandle(scope.path, scope.owner);
    readers.push(reader);
    lanes.push({ turn, scope, reader, database, head: reader.get('turn', turn.id)! });
  }
  const post = vi.spyOn(Worker.prototype, 'postMessage');
  /** Prepares an ordinary valid request; deliberate stale CAS is supplied only by the failure case. */
  async function member(
    lane: Lane,
    sequence: number,
    revision: number,
    id = allocateEntityId('it')
  ) {
    const item = ItemSchema.parse({
      id,
      owner: lane.turn.owner,
      threadId: lane.turn.threadId,
      turnId: lane.turn.id,
      type: 'assistant-message',
      status: 'completed',
      createdAt: lane.turn.startedAt!,
      completedAt: lane.turn.startedAt!,
      text: `Exact cohort body ${sequence}`,
    });
    const content = await prepareImmutableProductJson(
      lane.scope.contentMount,
      lane.scope.owner,
      join(dirname(dirname(lane.scope.path)), 'runtime', 'staging'),
      writeRetainedV1(item)
    );
    const transition: ControlProductTransition = {
      products: [{ kind: 'turn', expectedRevision: revision, record: lane.head.record }],
      entries: [{ kind: 'item', turnId: lane.turn.id, sequence, expectedRevision: 0, ...content }],
    };
    return { item, transition };
  }
  return {
    root,
    store,
    client,
    lanes,
    state,
    member,
    post,
    arm(entry: ControlProductEntry) {
      new Uint8Array(instrument.shared!, 64, 64).set(
        Buffer.from(entry.content.reference.contentDigest.slice(7))
      );
      Atomics.store(state, 0, 1);
    },
    wait(index: 1 | 4 | 14) {
      return vi.waitFor(() => expect(Atomics.load(state, index)).toBe(1), { timeout: 3000 });
    },
    frames() {
      return post.mock.calls.flatMap(([frame]) =>
        frame.operation === 'products' && Array.isArray(frame.requests) ? [frame as Frame] : []
      );
    },
    replies(ids: number[]) {
      return instrument.replies.filter((reply) => ids.includes(reply.id));
    },
    cohort(transitions: ControlProductTransition[]) {
      if (typeof client.productsCohort !== 'function')
        throw new Error('SETUP: native productsCohort API is unavailable');
      return client
        .productsCohort(lanes[0]!.database, transitions, { immediate: true })
        .catch((reason: unknown) =>
          transitions.map(() => ({ status: 'rejected' as const, reason }))
        );
    },
  };
}

/** Reads stored exact Items through their owning Store after native shutdown and reopen. */
async function reopened(f: Awaited<ReturnType<typeof fixture>>) {
  await shutdownControlStoreWorkerClient();
  return createTestStore({ dataRoot: f.root }).getTurnById(f.lanes[0]!.turn.id).items;
}

describe('eligible native product cohorts', () => {
  it('drains a healthy accepted cohort on shutdown when ordinary envelope capacity is saturated', async () => {
    const f = await fixture();
    const lane = f.lanes[0]!;
    const one = await f.member(lane, 1, lane.head.revision);
    const two = await f.member(lane, 2, lane.head.revision + 1);
    f.arm(two.transition.entries[0]!);
    Atomics.store(f.state, 3, 1);
    const cohort = f.cohort([one.transition, two.transition]);
    await f.wait(1);
    const ids = f.frames()[0]!.requests.map(({ id }) => id);
    // Read-only storage-owner graybox setup: measure actual admission cost; never set accounting.
    const admission = f.client as unknown as {
      readonly inputBytes: number;
      readonly materialBytes: number;
    };
    const usedBytes = () => admission.inputBytes + admission.materialBytes;
    const observe = <T>(operation: Promise<T>) =>
      operation.then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason })
      );
    const read = (value: Uint8Array) =>
      f.client.write(lane.database, [
        {
          mode: 'get',
          sql: 'SELECT length(?) AS size',
          parameters: [value],
        },
      ]);
    const before = usedBytes();
    const small = observe(read(new Uint8Array(1)));
    const cost = usedBytes() - before;
    const smallId = f.post.mock.calls.at(-1)![0].id as number;
    const idGrowth = String(smallId + 1).length - String(smallId).length;
    const remaining = CONTROL_WORKER_LIMITS.pendingBytes - usedBytes();
    const backing = new ArrayBuffer(remaining - cost + 1 - idGrowth);
    const filled = observe(read(new Uint8Array(backing, 0, 1)));
    const overflow = observe(read(new Uint8Array(1)));
    let shutdownPosted = false;
    const stopped = observe(f.client.shutdown());
    try {
      shutdownPosted = await vi
        .waitFor(
          () =>
            expect(f.post.mock.calls.some(([frame]) => frame.operation === 'shutdown')).toBe(true),
          { timeout: 3000 }
        )
        .then(
          () => true,
          () => false
        );
      expect(f.replies(ids)).toEqual([]);
      expect(lane.reader.entries(lane.turn.id, 'item')).toEqual([]);
      release(2);
      if (shutdownPosted) {
        await f.wait(4);
        expect(f.replies(ids)).toEqual([]);
        expect(lane.reader.entries(lane.turn.id, 'item')).toEqual([]);
      }
    } finally {
      release(2);
      release(5);
    }
    const [members, smallResult, filledResult, refused, shutdownResult] = await Promise.all([
      cohort,
      small,
      filled,
      overflow,
      stopped,
    ]);
    // A failed shutdown has also settled. Give cleanup a fresh, unopened client lifetime.
    if (f.client.isClosed) getControlStoreWorkerClient();
    const items = await reopened(f);
    expect(refused).toEqual({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'busy', commit: 'not-committed' }),
    });
    expect(smallResult).toEqual({
      status: 'fulfilled',
      value: [{ mode: 'get', row: { size: 1n } }],
    });
    expect(filledResult).toEqual(smallResult);
    expect(shutdownResult).toEqual({ status: 'fulfilled', value: undefined });
    expect(members.map(({ status }) => status)).toEqual(['fulfilled', 'fulfilled']);
    expect(f.replies(ids).map(({ id, status }) => [id, status])).toEqual(
      ids.map((id) => [id, 'ok'])
    );
    expect(Atomics.load(f.state, 8)).toBe(0);
    expect(items).toEqual([one.item, two.item]);
    expect(shutdownPosted).toBe(true);
  });

  it.each([
    'Uint8Array',
    'Buffer',
  ] as const)('refuses a one-byte %s with oversized cloned backing before posting and retains a healthy control', async (kind) => {
    const f = await fixture();
    const lane = f.lanes[0]!;
    // DX finite pending-byte admission counts cloned allocation, not a view or Buffer.toJSON.
    const backing = new ArrayBuffer(64 * 1024 * 1024 + 1);
    const value = kind === 'Buffer' ? Buffer.from(backing, 0, 1) : new Uint8Array(backing, 0, 1);
    expect(value.byteLength).toBe(1);
    const resume = await f.client.pauseForDataRootBackup();
    let outcome: unknown;
    const oversized = f.client
      .write(lane.database, [
        {
          mode: 'get',
          sql: 'SELECT length(?) AS size',
          parameters: [value],
        },
      ])
      .then(
        (result) => {
          outcome = { status: 'fulfilled', result };
        },
        (reason: unknown) => {
          outcome = { status: 'rejected', reason };
        }
      );
    const control = f.client.write(lane.database, [
      {
        mode: 'get',
        sql: 'SELECT length(?) AS size',
        parameters: [new Uint8Array([7])],
      },
    ]);
    let refusedBeforePosting = false;
    try {
      refusedBeforePosting = await vi
        .waitFor(
          () =>
            expect(outcome).toEqual({
              status: 'rejected',
              reason: expect.objectContaining({ code: 'busy', commit: 'not-committed' }),
            }),
          { timeout: 3000 }
        )
        .then(
          () => true,
          () => false
        );
      expect(f.post).not.toHaveBeenCalled();
    } finally {
      resume();
      await Promise.all([oversized, control]);
    }
    expect(await control).toEqual([{ mode: 'get', row: { size: 1n } }]);
    expect(refusedBeforePosting).toBe(true);
    // Only the retained healthy control may cross the real Worker boundary.
    expect(f.post.mock.calls.filter(([frame]) => frame.operation === 'write')).toHaveLength(1);
    expect(lane.reader.get('turn', lane.turn.id)).toEqual(lane.head);
  });

  it('flushes a 31-slot prefix and whole two-member immediate cohort without releasing a 5 ms timer', async () => {
    const f = await fixture();
    const [lane, sibling] = f.lanes;
    const one = await f.member(lane!, 1, lane!.head.revision);
    const two = await f.member(lane!, 2, lane!.head.revision + 1);
    const resume = await f.client.pauseForDataRootBackup();
    f.arm(two.transition.entries[0]!);
    release(2);
    Atomics.store(f.state, 3, 1);
    Atomics.store(f.state, 10, 1);
    Atomics.store(f.state, 13, 1);
    const prefix = Array.from({ length: 31 }, (_, index) =>
      f.client.products(sibling!.database, {
        products: [
          {
            kind: 'turn',
            expectedRevision: sibling!.head.revision + index,
            record: sibling!.head.record,
          },
        ],
        entries: [],
      })
    );
    const cohort = f.cohort([one.transition, two.transition]);
    try {
      expect(f.post).not.toHaveBeenCalled();
    } finally {
      resume();
    }
    // DX 32-transition batches keep the cohort whole. Its immediate status flushes the prefix too.
    const advancedWithoutTimer = await f.wait(4).then(
      () => true,
      () => false
    );
    if (!advancedWithoutTimer) {
      expect(Atomics.load(f.state, 11)).toBeGreaterThan(0);
      release(12);
      await f.wait(4);
    }
    const frame = f.frames()[0]!;
    expect(frame.requests).toHaveLength(2);
    const ids = frame.requests.map(({ id }) => id);
    expect(f.replies(ids)).toEqual([]);
    expect(Atomics.load(f.state, 7)).toBe(0);
    expect(sibling!.reader.get('turn', sibling!.turn.id)).toEqual(sibling!.head);
    expect(lane!.reader.entries(lane!.turn.id, 'item')).toEqual([]);
    release(5);
    await f.wait(14);
    await Promise.all(prefix);
    expect(sibling!.reader.get('turn', sibling!.turn.id)!.revision).toBe(
      sibling!.head.revision + 31
    );
    expect(Atomics.load(f.state, 7)).toBe(1);
    expect(f.replies(ids)).toEqual([]);
    expect(lane!.reader.get('turn', lane!.turn.id)).toEqual(lane!.head);
    expect(lane!.reader.entries(lane!.turn.id, 'item')).toEqual([]);
    release(15);
    expect((await cohort).map(({ status }) => status)).toEqual(['fulfilled', 'fulfilled']);
    expect(f.replies(ids).map(({ id, status }) => [id, status])).toEqual(
      ids.map((id) => [id, 'ok'])
    );
    expect(Atomics.load(f.state, 7)).toBe(2);
    expect(Atomics.load(f.state, 8)).toBe(0);
    expect(await reopened(f)).toEqual([one.item, two.item]);
    expect(advancedWithoutTimer).toBe(true);
  });

  it('holds the later real preparation and original backup frame through one FULL commit and ordered ACKs', async () => {
    const f = await fixture();
    const [lane, sibling] = f.lanes;
    const one = await f.member(lane!, 1, lane!.head.revision);
    const two = await f.member(lane!, 2, lane!.head.revision + 1);
    const other = await f.member(sibling!, 1, sibling!.head.revision);
    const resume = await f.client.pauseForDataRootBackup();
    f.arm(two.transition.entries[0]!);
    const cohort = f.cohort([one.transition, two.transition]);
    try {
      expect(f.post).not.toHaveBeenCalled();
    } finally {
      resume();
    }
    await f.wait(1);
    expect(f.frames()).toHaveLength(1);
    const frame = f.frames()[0]!;
    expect(isControlProductCohort(frame)).toBe(true);
    // Original per-member ACK correlation must stay one-to-one after structured cloning.
    const aliased = structuredClone({ ...frame, requests: [frame.requests[0], frame.requests[0]] });
    expect(aliased.requests[0]).toBe(aliased.requests[1]);
    expect(isControlProductCohort(aliased)).toBe(false);
    const ids = f.frames()[0]!.requests.map(({ id }) => id);
    expect(
      f.frames()[0]!.requests.map(({ transition }) => transition.entries[0]!.sequence)
    ).toEqual([1, 2]);
    expect(new Set(ids).size).toBe(2);
    await f.client.products(sibling!.database, other.transition);
    expect(f.store.getTurnById(sibling!.turn.id).items).toEqual([other.item]);
    expect(f.replies(ids)).toEqual([]);
    expect(lane!.reader.entries(lane!.turn.id, 'item')).toEqual([]);
    expect(lane!.reader.get('turn', lane!.turn.id)).toEqual(lane!.head);
    const commits = Atomics.load(f.state, 7);
    Atomics.store(f.state, 3, 1);
    release(2);
    await f.wait(4);
    expect(f.replies(ids)).toEqual([]);
    expect(lane!.reader.entries(lane!.turn.id, 'item')).toEqual([]);
    expect(Atomics.load(f.state, 7)).toBe(commits);
    release(5);
    expect((await cohort).map(({ status }) => status)).toEqual(['fulfilled', 'fulfilled']);
    expect(f.replies(ids).map(({ id, status }) => [id, status])).toEqual(
      ids.map((id) => [id, 'ok'])
    );
    // DX: this eligible prefix shares one outer FULL COMMIT, not merely two ordered commits.
    expect(Atomics.load(f.state, 7) - commits).toBe(1);
    expect(Atomics.load(f.state, 8)).toBe(0);
    expect(lane!.reader.get('turn', lane!.turn.id)!.revision).toBe(lane!.head.revision + 2);
    expect(await reopened(f)).toEqual([one.item, two.item]);
  });

  it('keeps the valid prefix, rolls back the middle member and refuses its applicable successor', async () => {
    const f = await fixture();
    const [lane, sibling] = f.lanes;
    const one = await f.member(lane!, 1, lane!.head.revision);
    const middle = await f.member(lane!, 2, lane!.head.revision + 1, one.item.id);
    const successor = await f.member(lane!, 2, lane!.head.revision + 1);
    const other = await f.member(sibling!, 1, sibling!.head.revision);
    f.arm(middle.transition.entries[0]!);
    const cohort = f.cohort([one.transition, middle.transition, successor.transition]);
    await f.wait(1);
    expect(f.frames()).toHaveLength(1);
    const ids = f.frames()[0]!.requests.map(({ id }) => id);
    await f.client.products(sibling!.database, other.transition);
    expect(f.store.getTurnById(sibling!.turn.id).items).toEqual([other.item]);
    expect(f.replies(ids)).toEqual([]);
    expect(lane!.reader.entries(lane!.turn.id, 'item')).toEqual([]);
    const commits = Atomics.load(f.state, 7);
    release(2);
    expect(await cohort).toEqual([
      { status: 'fulfilled', value: undefined },
      { status: 'rejected', reason: expect.objectContaining({ commit: 'not-committed' }) },
      { status: 'rejected', reason: expect.objectContaining({ commit: 'not-committed' }) },
    ]);
    expect(f.replies(ids).map(({ id, status }) => [id, status])).toEqual([
      [ids[0], 'ok'],
      [ids[1], 'error'],
      [ids[2], 'error'],
    ]);
    expect(Atomics.load(f.state, 9)).toBeGreaterThan(0);
    expect(Atomics.load(f.state, 7) - commits).toBe(1);
    expect(Atomics.load(f.state, 8)).toBe(0);
    // The middle Turn mutation must roll back; the third member would apply at this exact revision.
    expect(lane!.reader.get('turn', lane!.turn.id)!.revision).toBe(lane!.head.revision + 1);
    expect(await reopened(f)).toEqual([one.item]);
  });

  it.each([
    'count',
    'bytes',
  ] as const)('refuses the whole cohort before posting at the %s budget', async (budget) => {
    const f = await fixture();
    const lane = f.lanes[0]!;
    const width = budget === 'bytes' ? 32 : 2;
    const members = await Promise.all(
      Array.from({ length: width }, (_, index) =>
        f.member(lane, index + 1, lane.head.revision + index)
      )
    );
    const resume = await f.client.pauseForDataRootBackup();
    const fillerErrors: unknown[] = [];
    const fillers: Promise<boolean>[] = [];
    const fill = (count: number, bytes: number) => {
      fillers.push(
        ...Array.from({ length: count }, () =>
          f.client
            .write(lane.database, [
              {
                mode: 'get',
                sql: 'SELECT length(?) AS size',
                parameters: ['x'.repeat(bytes)],
              },
            ])
            .then(
              () => true,
              (error: unknown) => {
                fillerErrors.push(error);
                return false;
              }
            )
        )
      );
    };
    fill(
      budget === 'bytes' ? 80 : CONTROL_WORKER_LIMITS.pendingTransitions - 1,
      budget === 'bytes' ? 900_000 : 1
    );
    let observed: readonly PromiseSettledResult<void>[] | undefined;
    let refusal: Promise<unknown> | undefined;
    try {
      if (budget === 'bytes') {
        await vi.waitFor(() => expect(fillerErrors.length).toBeGreaterThan(0), { timeout: 3000 });
        // A refused large envelope can leave room for a small cohort. Fill that remainder too.
        for (const [count, bytes] of [
          [16, 65_536],
          [20, 4_096],
          [24, 256],
        ] as const) {
          const refusedBefore = fillerErrors.length;
          fill(count, bytes);
          await vi.waitFor(() => expect(fillerErrors.length).toBeGreaterThan(refusedBefore), {
            timeout: 3000,
          });
        }
        expect(fillers.length + width).toBeLessThan(CONTROL_WORKER_LIMITS.pendingTransitions);
        expect(
          Buffer.byteLength(JSON.stringify(members.map(({ transition }) => transition)))
        ).toBeGreaterThan(4_096);
        expect(fillerErrors).toEqual(
          fillerErrors.map(() => expect.objectContaining({ code: 'busy', commit: 'not-committed' }))
        );
      }
      refusal = f.cohort(members.map(({ transition }) => transition)).then((result) => {
        observed = result;
      });
      await vi.waitFor(() => expect(observed).toHaveLength(width), { timeout: 3000 });
      expect(observed).toEqual(
        members.map(() => ({
          status: 'rejected',
          reason: expect.objectContaining({ code: 'busy', commit: 'not-committed' }),
        }))
      );
      expect(f.post).not.toHaveBeenCalled();
      expect(lane.reader.get('turn', lane.turn.id)).toEqual(lane.head);
      expect(lane.reader.entries(lane.turn.id, 'item')).toEqual([]);
    } finally {
      resume();
      await Promise.all([...fillers, refusal]);
    }
    expect((await Promise.all(fillers)).some(Boolean)).toBe(true);
    if (budget === 'count') expect(fillerErrors).toEqual([]);
    // Atomic refusal must not leave a partial member/frame waiting for backup release.
    expect(f.post.mock.calls.filter(([frame]) => frame.operation === 'products')).toEqual([]);
    expect(lane.reader.get('turn', lane.turn.id)).toEqual(lane.head);
    expect(await reopened(f)).toEqual([]);
  });
});

import { performance } from 'node:perf_hooks';
import { setTimeout as delay, setImmediate as nextMain } from 'node:timers/promises';
import { expect, it, onTestFinished, vi } from 'vitest';
import { navigationFixture } from '../test-support/nav-oracle.fixture.js';
import * as productReaders from './control-store-product-records.js';
import type { ThreadTimelineSnapshot } from './workspace-file-records.js';

/** Attach rejection observation immediately so held readers cannot create unhandled rejections. */
function outcome<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error })
  );
}

/** Bounded harness wait, not a product latency oracle or fake clock. */
async function entered(predicate: () => boolean) {
  const deadline = performance.now() + 1500;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('Reader entry barrier did not open');
    await nextMain();
  }
}

/** Observes actual owner handles without substituting readers, rows or SQLite results. */
function observeReaders() {
  const original = productReaders.openControlStoreProductReadHandle;
  const handles: Array<{
    reader: ReturnType<typeof original>;
    borrowed: Parameters<typeof original>[2];
  }> = [];
  const claimed = new Set<ReturnType<typeof original>>();
  const spy = vi
    .spyOn(productReaders, 'openControlStoreProductReadHandle')
    .mockImplementation((...args) => {
      const reader = original(...args);
      handles.push({ reader, borrowed: args[2] });
      return reader;
    });
  onTestFinished(() => spy.mockRestore());
  return {
    handles,
    claimActive() {
      const active = handles.filter(
        (entry) => entry.reader.sqlite.open && entry.reader.sqlite.inTransaction
      );
      expect(active.length).toBeGreaterThan(0);
      expect(active.length).toBeLessThanOrEqual(2);
      for (const entry of active) {
        expect(entry.borrowed).toBeUndefined();
        expect(entry.reader.sqlite.readonly).toBe(true);
        expect(entry.reader.sqlite.pragma('query_only', { simple: true })).toBe(1);
        claimed.add(entry.reader);
      }
      return active;
    },
    assertClosed() {
      expect(claimed.size).toBeGreaterThan(0);
      for (const reader of claimed) expect(reader.sqlite.open).toBe(false);
    },
  };
}

/** The real native ACK must precede the second read from the held snapshot. */
it('keeps one private query-only snapshot coherent across an acknowledged native Item revision', async () => {
  const f = await navigationFixture();
  const id = await f.message('Before native acknowledgement.');
  const readers = observeReaders();
  let ready = false;
  let acknowledged = false;
  let finished = 0;
  let held: (typeof readers.handles)[number] | undefined;
  const cut = outcome(
    f.store.readThreadTimelineSnapshotCooperative(
      f.workspaceId,
      f.thread.id,
      function* (snapshot: ThreadTimelineSnapshot) {
        try {
          const before = snapshot.item(id);
          const head = snapshot.revisionHead(f.turn.id);
          const active = readers.claimActive();
          expect(active).toHaveLength(1);
          held = active[0]!;
          expect(held.borrowed).toBeUndefined();
          expect(held.reader.sqlite.readonly).toBe(true);
          expect(held.reader.sqlite.pragma('query_only', { simple: true })).toBe(1);
          ready = true;
          while (!acknowledged) yield;
          expect(held.reader.sqlite.inTransaction).toBe(true);
          return {
            before,
            after: snapshot.item(id),
            head,
            afterHead: snapshot.revisionHead(f.turn.id),
          };
        } finally {
          finished++;
        }
      }
    )
  );
  try {
    await entered(() => ready);
    await f.store.updateItem(id, { text: 'After native acknowledgement.' });
    acknowledged = true;
    const result = await cut;
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.before).toMatchObject({ id, text: 'Before native acknowledgement.' });
    expect(result.value.after).toEqual(result.value.before);
    expect(result.value.afterHead).toBe(result.value.head);
    expect(finished).toBe(1);
    expect(held!.reader.sqlite.open).toBe(false);
    const current = await f.store.readThreadTimelineSnapshotCooperative(
      f.workspaceId,
      f.thread.id,
      function* (snapshot: ThreadTimelineSnapshot) {
        yield;
        return { item: snapshot.item(id), head: snapshot.revisionHead(f.turn.id) };
      }
    );
    expect(current.item).toMatchObject({ id, text: 'After native acknowledgement.' });
    expect(current.head).toBeGreaterThan(result.value.head);
    readers.assertClosed();
  } finally {
    acknowledged = true;
    await cut;
  }
}, 15000);

/** Two actual entered cuts hold their own barriers; an excess reader must not enter early. */
it('queues reader three, removes a queued abort, and reuses a slot after an active abort', async () => {
  const f = await navigationFixture();
  const id = await f.message('Slot ownership source.');
  const readers = observeReaders();
  const first = new AbortController();
  const second = new AbortController();
  const queued = new AbortController();
  let count = 0;
  let returned = 0;
  let closed = 0;
  let release = false;
  const hold = function* (snapshot: ThreadTimelineSnapshot) {
    count++;
    try {
      snapshot.item(id);
      readers.claimActive();
      while (!release) yield;
      returned++;
      return snapshot.item(id);
    } finally {
      closed++;
    }
  };
  const a = outcome(
    f.store.readThreadTimelineSnapshotCooperative(f.workspaceId, f.thread.id, hold, first.signal)
  );
  const b = outcome(
    f.store.readThreadTimelineSnapshotCooperative(f.workspaceId, f.thread.id, hold, second.signal)
  );
  let thirdEntered = false;
  let c: ReturnType<typeof outcome> | undefined;
  try {
    await entered(() => count === 2);
    c = outcome(
      f.store.readThreadTimelineSnapshotCooperative(
        f.workspaceId,
        f.thread.id,
        function* (snapshot: ThreadTimelineSnapshot) {
          thirdEntered = true;
          yield;
          return snapshot.item(id);
        },
        queued.signal
      )
    );
    await nextMain();
    await nextMain();
    expect(thirdEntered).toBe(false);
    expect(count).toBe(2);
    const livePrivate = readers.handles.filter(
      (entry) => entry.borrowed === undefined && entry.reader.sqlite.open
    );
    expect(new Set(livePrivate.map((entry) => entry.reader.sqlite)).size).toBe(2);
    queued.abort();
    expect((await c).ok).toBe(false);
    expect(thirdEntered).toBe(false);
    first.abort();
    expect((await a).ok).toBe(false);
    expect(
      new Set(
        readers.handles
          .filter((entry) => entry.borrowed === undefined && entry.reader.sqlite.open)
          .map((entry) => entry.reader.sqlite)
      ).size
    ).toBe(1);
    const replacement = await f.store.readThreadTimelineSnapshotCooperative(
      f.workspaceId,
      f.thread.id,
      function* (snapshot: ThreadTimelineSnapshot) {
        yield;
        return snapshot.item(id);
      }
    );
    expect(replacement).toMatchObject({ id, text: 'Slot ownership source.' });
    second.abort();
    expect((await b).ok).toBe(false);
    expect(returned).toBe(0);
    expect(closed).toBe(2);
    readers.assertClosed();
  } finally {
    first.abort();
    second.abort();
    queued.abort();
    release = true;
    await Promise.all([a, b, ...(c ? [c] : [])]);
  }
}, 15000);

/** Queue time consumes the same two-second allowance; entry must not reset its clock. */
it('rejects an over-budget queued read without returning its Item and permits a subsequent cut', async () => {
  const f = await navigationFixture();
  const id = await f.message('Deadline source.');
  const readers = observeReaders();
  let holders = 0;
  let release = false;
  let returned = false;
  const hold = function* (snapshot: ThreadTimelineSnapshot) {
    holders++;
    snapshot.item(id);
    readers.claimActive();
    while (!release) yield;
    return snapshot.item(id);
  };
  const a = outcome(
    f.store.readThreadTimelineSnapshotCooperative(f.workspaceId, f.thread.id, hold)
  );
  const b = outcome(
    f.store.readThreadTimelineSnapshotCooperative(f.workspaceId, f.thread.id, hold)
  );
  let queued: ReturnType<typeof outcome> | undefined;
  try {
    await entered(() => holders === 2);
    queued = outcome(
      f.store.readThreadTimelineSnapshotCooperative(
        f.workspaceId,
        f.thread.id,
        function* (snapshot: ThreadTimelineSnapshot) {
          snapshot.item(id);
          readers.claimActive();
          const started = performance.now();
          while (performance.now() - started < 1500) yield;
          returned = true;
          return snapshot.item(id);
        }
      )
    );
    await delay(900);
    release = true;
    expect((await a).ok).toBe(true);
    expect((await b).ok).toBe(true);
    expect((await queued).ok).toBe(false);
    expect(returned).toBe(false);
    readers.assertClosed();
    const next = await f.store.readThreadTimelineSnapshotCooperative(
      f.workspaceId,
      f.thread.id,
      function* (snapshot: ThreadTimelineSnapshot) {
        yield;
        return snapshot.item(id);
      }
    );
    expect(next).toMatchObject({ id, text: 'Deadline source.' });
    readers.assertClosed();
  } finally {
    release = true;
    await Promise.all([a, b, ...(queued ? [queued] : [])]);
  }
}, 15000);

/** A real consumer exception closes its iterator and does not poison the next real source read. */
it('cleans up a consumer error and allows another native cut', async () => {
  const f = await navigationFixture();
  const id = await f.message('Error cleanup source.');
  const readers = observeReaders();
  let closed = 0;
  const failed = outcome(
    f.store.readThreadTimelineSnapshotCooperative(
      f.workspaceId,
      f.thread.id,
      function* (snapshot: ThreadTimelineSnapshot) {
        try {
          snapshot.item(id);
          readers.claimActive();
          yield;
          throw new Error('Deliberate cooperative consumer failure.');
        } finally {
          closed++;
        }
      }
    )
  );
  expect((await failed).ok).toBe(false);
  expect(closed).toBe(1);
  readers.assertClosed();
  const next = await f.store.readThreadTimelineSnapshotCooperative(
    f.workspaceId,
    f.thread.id,
    function* (snapshot: ThreadTimelineSnapshot) {
      yield;
      return snapshot.item(id);
    }
  );
  expect(next).toMatchObject({ id, text: 'Error cleanup source.' });
  readers.assertClosed();
}, 15000);

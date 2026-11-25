import { describe, expect, it, vi } from 'vitest';
import { createWriterCaseOwner } from './writer-case-owner.js';

/** Waits on the real clock. */
const elapse = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A promise that the test settles. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

// S3a-r2d A8 finding 1: the owner fails closed. Each stop below is a stub, so no writer runs.
describe('writer case owner', () => {
  it('refuses a stop with no token while no unit runs', async () => {
    const owner = createWriterCaseOwner();
    const stop = vi.fn(async () => undefined);
    expect(owner.owns()).toBe(false);
    await owner.shutdown(stop);
    expect(stop).not.toHaveBeenCalled();
  });

  it('ends a suite hook token at its runner timeout, and keeps it until then', async () => {
    const owner = createWriterCaseOwner();
    const late = vi.fn(async () => undefined);
    const work = deferred();
    const stale = owner.runHook(async () => {
      await work.promise;
      await owner.shutdown(late);
    }, 20);
    await elapse(60);
    work.resolve();
    await stale;
    expect(late).not.toHaveBeenCalled();
    // Control: a stop before the timeout runs once.
    const own = vi.fn(async () => undefined);
    await owner.runHook(() => owner.shutdown(own), 10_000);
    expect(own).toHaveBeenCalledTimes(1);
  });

  it('lets a sibling suite hook supersede a stale one at its entry', async () => {
    const owner = createWriterCaseOwner();
    const late = vi.fn(async () => undefined);
    const own = vi.fn(async () => undefined);
    const work = deferred();
    const stale = owner.runHook(async () => {
      await work.promise;
      await owner.shutdown(late);
    }, 60_000);
    await owner.runHook(async () => {
      work.resolve();
      await stale;
      await owner.shutdown(own);
    }, 60_000);
    expect(late).not.toHaveBeenCalled();
    expect(own).toHaveBeenCalledTimes(1);
  });

  it('runs a suite hook only after a published shutdown settles', async () => {
    const owner = createWriterCaseOwner();
    const drain = deferred();
    await owner.runHook(async () => {
      void owner.shutdown(() => drain.promise);
    }, 10_000);
    const order: string[] = [];
    const next = owner.runHook(async () => {
      order.push('body');
    }, 10_000);
    await elapse(10);
    expect(order).toEqual([]);
    drain.resolve();
    await next;
    expect(order).toEqual(['body']);
  });

  it('ends every inner token when the runner completes a case', async () => {
    const owner = createWriterCaseOwner();
    const late = vi.fn(async () => undefined);
    const work = deferred();
    let inner: Promise<void> | undefined;
    await owner.runTest(async () => {
      expect(owner.owns()).toBe(true);
      inner = owner.runCase(async () => {
        await work.promise;
        await owner.shutdown(late);
      });
    });
    work.resolve();
    await inner;
    expect(late).not.toHaveBeenCalled();
    expect(owner.owns()).toBe(false);
  });
});

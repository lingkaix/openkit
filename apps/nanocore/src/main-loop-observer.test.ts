import { performance } from 'node:perf_hooks';
import { setTimeout as delay, setImmediate as nextCallback } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import { startMainLoopObserver, withMainLoopOperation } from './main-loop-observer.js';

let stop: (() => void) | undefined;
afterEach(() => stop?.());

/** Real synchronous work and an independent timer expose blocking without a mocked clock. */
function block(milliseconds: number) {
  const end = performance.now() + milliseconds;
  while (performance.now() < end) {}
}

it('observes a real Main block after await with its registered operation and independent timer', async () => {
  const records: Record<string, unknown>[] = [];
  const observer = startMainLoopObserver({ emit: (record) => records.push(record) });
  stop = observer.stop;
  await delay(30);
  let timerGap = 0;
  await withMainLoopOperation('thread.read', async () => {
    await nextCallback();
    const started = performance.now();
    const timer = delay(0).then(() => {
      timerGap = performance.now() - started;
    });
    block(130);
    await timer;
  });
  await delay(20);
  observer.flush();
  expect(timerGap).toBeGreaterThan(100);
  expect(records).toContainEqual(
    expect.objectContaining({
      event: 'main_loop_long_task',
      operation: 'thread.read',
      observation: 'callback',
    })
  );
  const tasks = records.filter((record) => record.event === 'main_loop_long_task');
  expect(tasks.some((record) => Number(record.durationMs) > 100)).toBe(true);
  expect(records).toContainEqual(
    expect.objectContaining({ event: 'main_loop_window', thresholdMs: 100 })
  );
});

it('does not classify pending nonblocking work as a long callback', async () => {
  const records: Record<string, unknown>[] = [];
  const observer = startMainLoopObserver({ emit: (record) => records.push(record) });
  stop = observer.stop;
  expect(
    await withMainLoopOperation('thread.read', async () => {
      await delay(160);
      return 'exact';
    })
  ).toBe('exact');
  observer.flush();
  expect(
    records.filter(
      (record) => record.event === 'main_loop_long_task' && record.operation === 'thread.read'
    )
  ).toEqual([]);
});

it('omits unregistered labels and all argument, error and path content', () => {
  const records: Record<string, unknown>[] = [];
  const observer = startMainLoopObserver({ emit: (record) => records.push(record) });
  stop = observer.stop;
  const privateMarker = 'PRIVATE-OPERATION-ARGUMENT-PATH';
  const failure = new Error(privateMarker);
  expect(() =>
    withMainLoopOperation(privateMarker, () => {
      block(110);
      throw failure;
    })
  ).toThrow(failure);
  observer.flush();
  expect(records).toContainEqual(
    expect.objectContaining({ event: 'main_loop_long_task', operation: 'unknown' })
  );
  expect(JSON.stringify(records)).not.toContain(privateMarker);
});

it('keeps sink failures outcome-independent and reports bounded loss on the next working flush', () => {
  const records: Record<string, unknown>[] = [];
  let fail = true;
  const observer = startMainLoopObserver({
    emit: (record) => {
      if (fail) throw Error('private sink failure');
      records.push(record);
    },
  });
  stop = observer.stop;
  expect(
    withMainLoopOperation('thread.read', () => {
      block(110);
      return 42;
    })
  ).toBe(42);
  expect(() => observer.flush()).not.toThrow();
  fail = false;
  observer.flush();
  expect(records).toContainEqual(
    expect.objectContaining({ event: 'main_loop_observation_gap', reason: 'sink_failure' })
  );
  observer.stop();
  observer.stop();
  const count = records.length;
  expect(withMainLoopOperation('thread.read', () => 'after stop')).toBe('after stop');
  observer.flush();
  expect(records).toHaveLength(count);
});

it('bounds callback bookkeeping overhead while retaining the original result', async () => {
  const observer = startMainLoopObserver({ emit: () => {} });
  stop = observer.stop;
  const started = performance.now();
  let count = 0;
  await withMainLoopOperation('thread.read', async () => {
    for (let index = 0; index < 1000; index++) {
      await Promise.resolve();
      count++;
    }
  });
  expect(count).toBe(1000);
  expect(performance.now() - started).toBeLessThan(100);
});

it('retains a bounded observation queue and reports overflow explicitly', () => {
  const records: Record<string, unknown>[] = [];
  const observer = startMainLoopObserver({ emit: (record) => records.push(record) });
  stop = observer.stop;
  const nested = (depth: number): void =>
    withMainLoopOperation('thread.read', () => {
      if (depth) nested(depth - 1);
      else block(110);
    });
  nested(70);
  observer.flush();
  expect(records.filter((record) => record.event === 'main_loop_long_task')).toHaveLength(64);
  expect(records).toContainEqual(
    expect.objectContaining({ event: 'main_loop_observation_gap', reason: 'bounded_capacity' })
  );
});

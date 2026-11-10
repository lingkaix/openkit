import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ client: undefined as any, failChannel: false }));
vi.mock('../storage/control-store-worker-client.js', () => ({
  getControlStoreWorkerClient: () => state.client,
}));
vi.mock('node:worker_threads', () => ({
  BroadcastChannel: class {
    onmessage?: (event: { data: unknown }) => void;
    unref() {}
    close() {}
    postMessage(message: { kind: string }) {
      if (state.failChannel) throw new Error('observer channel unavailable');
      for (const host of state.client.hosts)
        if (host.worker)
          queueMicrotask(() =>
            this.onmessage?.({
              data: {
                kind: message.kind === 'window' ? 'ready' : 'finished',
                threadId: host.worker.threadId,
              },
            })
          );
    }
  },
}));

import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { withMainLoopOperation } from '../main-loop-observer.js';
import { mainLoopBudget, observeMainLoop, observeNative } from './load-observe.js';

afterEach(() => {
  state.failChannel = false;
});

function client() {
  state.client = {
    hosts: [{ worker: { threadId: 1 } }],
    backing: new Map<string, { inputBytes: number; materialBytes: number }>(),
    outstanding: new Map<string, number>(),
    pending: new Map(),
  };
  return state.client;
}

it('observes per-database backing without a removed scalar and restores prior hooks', async () => {
  const c = client();
  const set = function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
    return Map.prototype.set.call(this, key, value);
  };
  Object.defineProperty(c.backing, 'set', { configurable: true, writable: true, value: set });
  const before = Object.getOwnPropertyDescriptor(c.backing, 'set');
  const observation = await observeNative(0, Infinity);
  const first = { inputBytes: 20, materialBytes: 0 };
  expect(c.backing.set('a', first)).toBe(c.backing);
  c.backing.set('b', { inputBytes: 30, materialBytes: 0 });
  first.inputBytes = 45;
  c.backing.set('a', first);
  c.outstanding.set('a', 2);
  c.outstanding.set('b', 3);
  c.pending.set(1, {});
  c.backing.delete('b');
  const result = await observation.finish();
  expect(result.all).toMatchObject({
    maxInputBytes: 45,
    maxTotalInputBytes: 75,
    maxOutstandingPerDatabase: 3,
    maxOutstandingTotal: 5,
    maxPendingNativeRequests: 1,
  });
  expect(result.observerErrors).toBe(0);
  expect(result.exactClientMutationBoundaryPeaks).toBe(true);
  expect(Object.hasOwn(c, 'inputBytes')).toBe(false);
  expect(Object.getOwnPropertyDescriptor(c.backing, 'set')).toEqual(before);
});

it('keeps original map results when sampling fails and reports the observation gap', async () => {
  const c = client();
  const observation = await observeNative(0, Infinity);
  c.backing.values = () => {
    throw new Error('observer unavailable');
  };
  expect(c.backing.set('a', { inputBytes: 10, materialBytes: 0 })).toBe(c.backing);
  expect(c.backing.get('a').inputBytes).toBe(10);
  const result = await observation.finish();
  expect(result.observerErrors).toBeGreaterThan(0);
  expect(result.exactClientMutationBoundaryPeaks).toBe(false);
});

it('includes a lazily started native host in final custody', async () => {
  const c = client();
  const observation = await observeNative(0, Infinity);
  c.hosts.push({ worker: { threadId: 2 } });
  const result = await observation.finish();
  expect(result.expectedNativeNodeIds).toEqual([1, 2]);
  expect(result.observerErrors).toBe(0);
});

it('fails open with explicit gaps when no native handshake is available', async () => {
  const c = client();
  c.hosts = [];
  state.failChannel = true;
  const observation = await observeNative(0, Infinity);
  expect(c.outstanding.set('a', 1)).toBe(c.outstanding);
  const result = await observation.finish();
  expect(result.observerErrors).toBeGreaterThan(0);
  expect(result.exactClientMutationBoundaryPeaks).toBe(false);
});

const quiet = { start: { load1: 4, load5: 5 }, end: { load1: 6, load5: 7 } };
const metrics = { p50Ms: 1, p99Ms: 20, p999Ms: 50, maxMs: 150, samples: 1000 };

it('fails only quiet absolute budget violations, with inclusive 20/50ms boundaries', () => {
  expect(mainLoopBudget(metrics, quiet, 'reference-1ws').status).toBe('PASS');
  const receipt = { ...metrics, gaps: [], gapCountMeaning: 'timer intervals', observerErrors: 0 };
  expect(mainLoopBudget(receipt, quiet, 'reference-1ws').status).toBe('PASS');
  expect(mainLoopBudget({ ...metrics, p99Ms: 20.001 }, quiet, 'reference-1ws').status).toBe('FAIL');
  expect(mainLoopBudget({ ...metrics, p999Ms: 50.001 }, quiet, 'reference-1ws').status).toBe(
    'FAIL'
  );
  expect(mainLoopBudget({ ...metrics, maxMs: 2000 }, quiet, 'reference-1ws').status).toBe('PASS');
});

it('classifies contention at either boundary and either load average without failing', () => {
  for (const boundary of ['start', 'end'] as const)
    for (const kind of ['load1', 'load5'] as const) {
      const host = structuredClone(quiet);
      host[boundary][kind] = 8;
      const result = mainLoopBudget({ ...metrics, p99Ms: 100 }, host, 'reference-1ws');
      expect(result.status).toBe('HOST CONFOUNDED');
      expect(result.absolute.exceeded).toEqual(['p99Ms']);
    }
});

it('never turns absent measurements or host observations into a pass or zero baseline', () => {
  expect(mainLoopBudget(metrics, { start: null, end: quiet.end }, 'reference-1ws').status).toBe(
    'NOT CHECKED'
  );
  expect(mainLoopBudget({ ...metrics, samples: 0 }, quiet, 'reference-1ws').status).toBe(
    'NOT CHECKED'
  );
  expect(mainLoopBudget({ ...metrics, p999Ms: null }, quiet, 'reference-1ws').status).toBe(
    'NOT CHECKED'
  );
});

it('relative regressions warn without failing and do not compare a different load profile', () => {
  const result = mainLoopBudget({ ...metrics, p999Ms: 40 }, quiet, 'reference-1ws');
  expect(result.status).toBe('PASS');
  expect(result.warnings).toContain('WARN main-loop p999Ms exceeds baseline by more than 25%');
  expect(mainLoopBudget(metrics, quiet, 'reference-4ws').relative).toContain('NOT CHECKED');
  expect(mainLoopBudget(metrics, quiet, 'control').warnings).toEqual([]);
  expect(
    mainLoopBudget({ ...metrics, p999Ms: 24.084479 * 1.25 }, quiet, 'reference-1ws').warnings
  ).not.toContain('WARN main-loop p999Ms exceeds baseline by more than 25%');
});

it('records all percentiles and a real long gap with the existing operation sampler', async () => {
  const observer = observeMainLoop();
  expect(observer).not.toBeNull();
  try {
    await sleep(25);
    withMainLoopOperation('thread.read', () => {
      const end = performance.now() + 130;
      while (performance.now() < end) {}
    });
    await sleep(25);
  } finally {
    const result = observer!.finish();
    expect(result.samples).toBeGreaterThan(0);
    expect(result.maxMs).toBeGreaterThan(100);
    expect(result.gapsOver100Ms).toBeGreaterThanOrEqual(1);
    expect(result.gapsOver100Ms).toBe(result.gaps.length + result.omittedGaps);
    expect(
      result.gaps.some((gap) =>
        gap.observations.some((record) => record.operation === 'thread.read')
      )
    ).toBe(true);
    expect([result.p50Ms, result.p99Ms, result.p999Ms, result.maxMs].every(Number.isFinite)).toBe(
      true
    );
  }
});

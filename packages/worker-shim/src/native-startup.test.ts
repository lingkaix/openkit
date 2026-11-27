import { afterEach, expect, it, vi } from 'vitest';
import { LIFECYCLE_DEFAULTS, LifecycleDeadline } from './lifecycle-deadline.js';
import { NativeStartupAdmission } from './native-startup.js';

/** Holds native acceptance independently of the admitted Turn's later settlement. */
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => vi.useRealTimers());

it('admits twenty simultaneous Turn starts in bounded FIFO batches without holding running Turns', async () => {
  const admission = new NativeStartupAdmission(2);
  const entered: number[] = [];
  const accepted = Array.from({ length: 20 }, gate);
  const settlement = gate();
  let active = 0;
  let peak = 0;
  const starts = accepted.map((ready, index) =>
    admission.run(async () => {
      entered.push(index);
      peak = Math.max(peak, ++active);
      await ready.promise;
      active -= 1;
      return { settled: settlement.promise };
    })
  );
  for (let index = 0; index < 20; index += 2) {
    await vi.waitFor(() => expect(entered).toEqual(Array.from({ length: index + 2 }, (_, i) => i)));
    expect(active).toBe(2);
    accepted[index]!.resolve();
    accepted[index + 1]!.resolve();
  }
  expect(await Promise.all(starts)).toHaveLength(20);
  expect(peak).toBe(2);
  settlement.resolve();
});

it('starts the owned eight-second RPC deadline after a queue wait longer than eight seconds', async () => {
  vi.useFakeTimers();
  const admission = new NativeStartupAdmission(1);
  const first = gate();
  const held = admission.run(() => first.promise);
  let deadline: LifecycleDeadline | undefined;
  const queued = admission.run(async () => {
    deadline = new LifecycleDeadline(LIFECYCLE_DEFAULTS.nativeRequestMs);
    await new Promise((resolve) => setTimeout(resolve, 7_999));
    expect(deadline.remainingMs()).toBe(1);
    return 'accepted';
  });
  await vi.advanceTimersByTimeAsync(9_000);
  expect(deadline).toBeUndefined();
  first.resolve();
  await held;
  await vi.advanceTimersByTimeAsync(0);
  expect(deadline!.remainingMs()).toBe(8_000);
  await vi.advanceTimersByTimeAsync(7_999);
  expect(await queued).toBe('accepted');
});

it('removes cancelled queued starts without launching and leaves the current start unchanged', async () => {
  const admission = new NativeStartupAdmission(1);
  const first = gate();
  const held = admission.run(() => first.promise);
  const controller = new AbortController();
  const launch = vi.fn(async () => undefined);
  const queued = admission.run(launch, controller.signal);
  const rejected = expect(queued).rejects.toThrow('Turn interrupted');
  controller.abort(new Error('Turn interrupted'));
  await rejected;
  expect(launch).not.toHaveBeenCalled();
  first.resolve();
  await held;
  await admission.run(async () => undefined);
  expect(launch).not.toHaveBeenCalled();
});

it('returns the handed-off slot without launching an interrupted queued Turn', async () => {
  const admission = new NativeStartupAdmission(1);
  const firstEntered = gate();
  const firstAccepted = gate();
  const held = admission.run(() => {
    firstEntered.resolve();
    return firstAccepted.promise;
  });
  await firstEntered.promise;

  const controller = new AbortController();
  const reason = new Error('Turn interrupted during startup handoff');
  const interruptedStart = vi.fn(async () => 'interrupted start');
  const nextStart = vi.fn(async () => 'next start');
  const interrupted = admission.run(interruptedStart, controller.signal);
  const next = admission.run(nextStart);
  const results = Promise.allSettled([interrupted, next]);

  firstAccepted.resolve();
  // The prior start returns its slot before this continuation. The dequeued start resumes after it.
  await Promise.resolve();
  controller.abort(reason);

  await held;
  const [interruptedResult, nextResult] = await results;
  expect(interruptedResult.status).toBe('rejected');
  if (interruptedResult.status === 'rejected') expect(interruptedResult.reason).toBe(reason);
  expect(interruptedStart).not.toHaveBeenCalled();
  expect(nextResult).toEqual({ status: 'fulfilled', value: 'next start' });
  expect(nextStart).toHaveBeenCalledOnce();
});

it('leaves the queue without launching when the enclosing Turn deadline cancels it', async () => {
  vi.useFakeTimers();
  const admission = new NativeStartupAdmission(1);
  const first = gate();
  const held = admission.run(() => first.promise);
  const launch = vi.fn(async () => undefined);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('Turn deadline exceeded')), 5_000);
  const queued = admission.run(launch, controller.signal);
  const rejected = expect(queued).rejects.toThrow('Turn deadline exceeded');
  await vi.advanceTimersByTimeAsync(5_000);
  await rejected;
  first.resolve();
  await held;
  expect(launch).not.toHaveBeenCalled();
});

it('returns startup capacity after failure and refuses an already cancelled start', async () => {
  const admission = new NativeStartupAdmission(1);
  const launch = vi.fn(async () => undefined);
  await expect(
    admission.run(async () => {
      throw new Error('native failed');
    })
  ).rejects.toThrow('native failed');
  await admission.run(launch);
  const signal = AbortSignal.abort(new Error('already cancelled'));
  await expect(admission.run(launch, signal)).rejects.toThrow('already cancelled');
  expect(launch).toHaveBeenCalledTimes(1);
});

it('hands a failed startup slot to the FIFO head while a peer remains active', async () => {
  const admission = new NativeStartupAdmission(2);
  const failFirst = gate();
  const peerEntered = gate();
  const acceptPeer = gate();
  const acceptHead = gate();
  const acceptTail = gate();
  const queued = new AbortController();
  const startupFailure = new Error('Native startup failed before acceptance');
  const failing = admission.run(async () => {
    await failFirst.promise;
    throw startupFailure;
  });
  const peer = admission.run(() => {
    peerEntered.resolve();
    return acceptPeer.promise;
  });
  const launchHead = vi.fn(() => acceptHead.promise);
  const launchTail = vi.fn(() => acceptTail.promise);
  const head = admission.run(launchHead, queued.signal);
  const tail = admission.run(launchTail, queued.signal);
  const failed = expect(failing).rejects.toBe(startupFailure);
  const settled = Promise.allSettled([failing, peer, head, tail]);

  try {
    await peerEntered.promise;
    expect(launchHead).not.toHaveBeenCalled();
    expect(launchTail).not.toHaveBeenCalled();
    failFirst.resolve();
    await failed;
    expect(launchHead).toHaveBeenCalledOnce();
    expect(launchTail).not.toHaveBeenCalled();

    acceptPeer.resolve();
    await peer;
    expect(launchHead).toHaveBeenCalledOnce();
    expect(launchTail).toHaveBeenCalledOnce();

    acceptHead.resolve();
    acceptTail.resolve();
    await Promise.all([head, tail]);
  } finally {
    failFirst.resolve();
    acceptPeer.resolve();
    acceptHead.resolve();
    acceptTail.resolve();
    queued.abort();
    await settled;
  }
});

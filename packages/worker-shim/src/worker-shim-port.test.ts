import { describe, expect, it, vi } from 'vitest';
import { WORKER_ADAPTERS } from './adapter-registry.js';
import { LifecycleDeadline } from './lifecycle-deadline.js';
import { FakeWorkerShim, type FakeWorkerShimOptions } from './test-support/worker-shim-fake.js';
import type {
  WorkerShimDesiredSet,
  WorkerShimInventory,
  WorkerShimOperationKey,
  WorkerShimReceipt,
  WorkerShimSession,
  WorkerShimStart,
  WorkerShimTurnInput,
} from './worker-shim-port.js';

const session: WorkerShimSession = { sandboxIncarnationId: 'sandbox-1', connectionGeneration: 1 };
const start: WorkerShimStart = {
  workerId: 'worker-1',
  agentSessionId: 'agent-session-1',
  adapterId: 'codex',
  workSlotRef: 'slot-1',
  resume: null,
};
const input: WorkerShimTurnInput = {
  workerId: start.workerId,
  attemptId: 'attempt-1',
  turnId: 'turn-1',
  operationId: 'operation-1',
  payloadDigest: 'digest-1',
  inputRef: 'immutable-input',
  routeGrant: 'admitted-grant',
};

function fake(incarnation: string, options: FakeWorkerShimOptions = {}): FakeWorkerShim {
  return new FakeWorkerShim(incarnation, {
    input: () => 'accepted',
    steer: () => 'accepted',
    ...options,
  });
}

function key({
  workerId,
  operationId,
  payloadDigest,
}: WorkerShimOperationKey): WorkerShimOperationKey {
  return { workerId, operationId, payloadDigest };
}

function desired(
  revision: number,
  overrides: Partial<WorkerShimDesiredSet> = {}
): WorkerShimDesiredSet {
  return {
    session,
    revision,
    workers: [],
    inputs: [],
    steers: [],
    interrupts: [],
    acknowledgedOperations: [],
    ...overrides,
  };
}

const emptyReport: WorkerShimInventory = { session, workers: [], receipts: [], interrupts: [] };
const runningWorker = {
  workerId: start.workerId,
  state: 'running',
  stop: { kind: 'best-effort' },
} as const;
const runningReport: WorkerShimInventory = { ...emptyReport, workers: [runningWorker] };

function receipt(
  kind: WorkerShimReceipt['kind'],
  original: WorkerShimOperationKey,
  disposition: WorkerShimReceipt['disposition']
): WorkerShimReceipt {
  return { kind, key: key(original), disposition };
}

async function expectPoll(
  shim: FakeWorkerShim,
  reply: WorkerShimDesiredSet,
  expected: WorkerShimInventory,
  result: 'applied' | 'stale' = 'applied'
) {
  const exchange = vi.fn(async (_report: WorkerShimInventory) => reply);
  const observed = await shim.poll(expected.session, exchange);
  expect(exchange.mock.calls).toEqual([[expected]]);
  expect(observed).toBe(result);
}

describe('Worker Shim contract', () => {
  it('starts only after desired state arrives and keeps one start over lost observation and reconnect', async () => {
    const shim = fake(session.sandboxIncarnationId);
    const run = [{ state: 'run' as const, worker: start }];
    const lostBeforeDelivery = vi.fn(async (_report: WorkerShimInventory) => {
      throw new Error('lost before delivery');
    });
    await expect(shim.poll(session, lostBeforeDelivery)).rejects.toThrow('lost before delivery');
    expect(lostBeforeDelivery.mock.calls).toEqual([[emptyReport]]);
    expect(shim.started).toEqual([]);

    await expectPoll(shim, desired(1, { workers: run }), emptyReport);
    const lostReport = vi.fn(async (_report: WorkerShimInventory) => {
      throw new Error('lost report');
    });
    await expect(shim.poll(session, lostReport)).rejects.toThrow('lost report');
    expect(lostReport.mock.calls).toEqual([[runningReport]]);
    const successor = { ...session, connectionGeneration: 2 };
    await expectPoll(shim, desired(1, { session: successor, workers: run }), {
      ...runningReport,
      session: successor,
    });
    const obsolete = vi.fn(async () => desired(100, { workers: run }));
    expect(await shim.poll(session, obsolete)).toBe('stale');
    expect(obsolete).not.toHaveBeenCalled();
    expect(shim.started).toEqual([start.workerId]);
  });

  it('discards a delayed old-session reply and a superseded revision before they start work', async () => {
    const shim = fake(session.sandboxIncarnationId);
    const delayed = Promise.withResolvers<WorkerShimDesiredSet>();
    const oldExchange = vi.fn((_report: WorkerShimInventory) => delayed.promise);
    const oldPoll = shim.poll(session, oldExchange);
    const successor = { ...session, connectionGeneration: 2 };
    const current = { ...emptyReport, session: successor };
    await expectPoll(shim, desired(3, { session: successor }), current);
    const workers = [{ state: 'run' as const, worker: start }];
    delayed.resolve(desired(100, { workers }));
    expect(await oldPoll).toBe('stale');
    expect(oldExchange.mock.calls).toEqual([[emptyReport]]);
    await expectPoll(shim, desired(2, { session: successor, workers }), current, 'stale');
    await expectPoll(
      shim,
      desired(101, { session: { ...successor, sandboxIncarnationId: 'other' }, workers }),
      current,
      'stale'
    );
    expect(shim.started).toEqual([]);
  });

  it('keeps original input evidence until acknowledged and never repeats a native admission', async () => {
    const shim = fake(session.sandboxIncarnationId);
    await expectPoll(
      shim,
      desired(1, {
        workers: [{ state: 'run', worker: start }],
        inputs: [input],
      }),
      emptyReport
    );
    const successor = { ...session, connectionGeneration: 2 };
    const running = { ...runningReport, session: successor };
    const pending = { ...running, receipts: [receipt('input', input, 'accepted')] };
    await expectPoll(shim, desired(1, { session: successor, inputs: [input] }), pending);
    expect(await shim.keyedTurnInput(input)).toBe('accepted');
    expect(await shim.keyedTurnInput({ ...input, payloadDigest: 'changed' })).toBe('refused');
    expect(await shim.keyedTurnInput({ ...input, attemptId: 'other' })).toBe('refused');
    expect(await shim.keyedTurnInput({ ...input, routeGrant: 'other' })).toBe('refused');
    expect(shim.contacted).toEqual([input.operationId]);
    await expectPoll(
      shim,
      desired(2, {
        session: successor,
        acknowledgedOperations: [{ ...key(input), payloadDigest: 'changed' }],
      }),
      pending
    );
    await expectPoll(
      shim,
      desired(3, { session: successor, acknowledgedOperations: [key(input)] }),
      pending
    );
    await expectPoll(shim, desired(4, { session: successor, inputs: [input] }), running);
    await expectPoll(shim, desired(5, { session: successor }), running);
    expect(shim.contacted).toEqual([input.operationId]);
  });

  it('holds unknown input, ends that Worker and retains the original unknown after local exit', async () => {
    const receiveInput = vi.fn(() => {
      throw new Error('native reply lost');
    });
    const shim = fake(session.sandboxIncarnationId, { input: receiveInput });
    await shim.start(start);
    expect(await shim.keyedTurnInput(input)).toBe('unknown');
    expect(await shim.keyedTurnInput(input)).toBe('unknown');
    const laterInput = { ...input, operationId: 'other' };
    const laterSteer = { ...input, operationId: 'late-steer' };
    expect(await shim.keyedTurnInput(laterInput)).toBe('refused');
    expect(await shim.keyedSteer(laterSteer)).toBe('refused');
    expect(await shim.stop(start.workerId)).toBe('stopping');
    expect(shim.contacted).toEqual([input.operationId]);
    expect(receiveInput).toHaveBeenCalledExactlyOnceWith(input);
    const stopped = {
      ...emptyReport,
      receipts: [
        receipt('input', input, 'unknown'),
        receipt('input', laterInput, 'refused'),
        receipt('steer', laterSteer, 'refused'),
      ],
    };
    await expectPoll(shim, desired(1), {
      ...stopped,
      workers: [{ ...runningWorker, state: 'stopping' }],
    });
    shim.observeChildExit(start.workerId);
    shim.observeTreeAbsent(start.workerId);
    expect(await shim.waitUntilAbsent(start.workerId, new LifecycleDeadline(0))).toEqual({
      state: 'held',
    });
    await expectPoll(shim, desired(2), {
      ...stopped,
      workers: [{ ...runningWorker, state: 'exited' }],
    });
  });

  it('uses the receiver result for fresh poll steer and refuses OpenCode steer before contact', async () => {
    const steer = { ...input, operationId: 'steer-1', payloadDigest: 'steer-digest' };
    const receiveSteer = vi.fn(() => undefined);
    const shim = fake(session.sandboxIncarnationId, { steer: receiveSteer });
    await expectPoll(
      shim,
      desired(1, {
        workers: [{ state: 'run', worker: start }],
        inputs: [input],
        steers: [steer],
      }),
      emptyReport
    );
    const acceptedInput = receipt('input', input, 'accepted');
    await expectPoll(shim, desired(2, { steers: [steer] }), {
      ...runningReport,
      receipts: [acceptedInput, receipt('steer', steer, 'unknown')],
    });
    expect(receiveSteer).toHaveBeenCalledExactlyOnceWith(steer);
    expect(shim.contacted).toEqual([input.operationId, steer.operationId]);

    const openCode = fake(session.sandboxIncarnationId, { steer: receiveSteer });
    await openCode.start({ ...start, adapterId: 'opencode' });
    await openCode.keyedTurnInput(input);
    expect(await openCode.keyedSteer(steer)).toBe('refused');
    await expectPoll(openCode, desired(1), {
      ...runningReport,
      receipts: [acceptedInput, receipt('steer', steer, 'refused')],
    });
    expect(openCode.contacted).toEqual([input.operationId]);
    expect(receiveSteer).toHaveBeenCalledTimes(1);
  });

  it('keeps the interrupt unproved until correlated settlement and reports conflicting refusal', async () => {
    const shim = fake(session.sandboxIncarnationId);
    await shim.start(start);
    await shim.keyedTurnInput(input);
    const interrupt = {
      workerId: input.workerId,
      attemptId: input.attemptId,
      turnId: input.turnId,
      requestId: 'interrupt-1',
      cause: 'observation_limit_reached' as const,
    };
    const conflict = { ...interrupt, requestId: 'conflict' };
    const conflicts = desired(1, { interrupts: [interrupt, conflict] });
    const active = { ...runningReport, receipts: [receipt('input', input, 'accepted')] };
    await expectPoll(shim, conflicts, active);
    shim.observeInterruptSettlement({ ...interrupt, attemptId: 'foreign' });
    const next = { ...input, turnId: 'next', attemptId: 'next', operationId: 'next' };
    expect(await shim.keyedTurnInput(next)).toBe('refused');
    const fenced = { ...active, receipts: [...active.receipts, receipt('input', next, 'refused')] };
    const refusal = { ...conflict, disposition: 'refused' } as const;
    await expectPoll(
      shim,
      { ...conflicts, revision: 2 },
      {
        ...fenced,
        interrupts: [{ ...interrupt, disposition: 'unknown' }, refusal],
      }
    );
    shim.observeInterruptSettlement(interrupt);
    await expectPoll(shim, desired(3), {
      ...fenced,
      interrupts: [{ ...interrupt, disposition: 'cancelled' }, refusal],
    });
    expect(shim.interrupted).toEqual([interrupt.requestId]);
    expect(shim.contacted).toEqual([input.operationId]);
    expect(await shim.keyedTurnInput({ ...next, operationId: 'authorized-next' })).toBe('accepted');
  });

  it('blocks fresh action before reconciling a committed cutoff and keeps inactive settlement unknown', async () => {
    const shim = fake(session.sandboxIncarnationId);
    const interrupt = {
      workerId: input.workerId,
      turnId: input.turnId,
      attemptId: input.attemptId,
      requestId: 'cutoff-1',
      cause: 'observation_limit_reached' as const,
    };
    await expectPoll(
      shim,
      desired(1, {
        workers: [{ state: 'run', worker: start }],
        inputs: [input],
        interrupts: [interrupt],
      }),
      emptyReport
    );
    expect(shim.contacted).toEqual([]);
    expect(shim.interrupted).toEqual([]);
    await expectPoll(shim, desired(2, { inputs: [input], interrupts: [interrupt] }), {
      ...runningReport,
      interrupts: [{ ...interrupt, disposition: 'unknown' }],
      receipts: [receipt('input', input, 'refused')],
    });
    expect(shim.contacted).toEqual([]);
    expect(await shim.waitUntilAbsent(start.workerId, new LifecycleDeadline(0))).toEqual({
      state: 'held',
    });
  });

  it('keeps stop monotonic and distinguishes direct-child exit from qualified absence', async () => {
    const shim = fake(session.sandboxIncarnationId);
    await expectPoll(shim, desired(1, { workers: [{ state: 'run', worker: start }] }), emptyReport);
    await expectPoll(
      shim,
      desired(2, {
        workers: [{ state: 'stop', workerId: start.workerId }],
        inputs: [input],
      }),
      runningReport
    );
    const refused = { ...emptyReport, receipts: [receipt('input', input, 'refused')] };
    await expectPoll(shim, desired(3), {
      ...refused,
      workers: [{ ...runningWorker, state: 'stopping' }],
    });
    expect(await shim.keyedTurnInput(input)).toBe('refused');
    expect(shim.contacted).toEqual([]);
    shim.observeChildExit(start.workerId);
    shim.observeTreeAbsent(start.workerId);
    expect(await shim.waitUntilAbsent(start.workerId, new LifecycleDeadline(0))).toEqual({
      state: 'held',
    });
    await expectPoll(shim, desired(4), {
      ...refused,
      workers: [{ ...runningWorker, state: 'exited' }],
    });
    expect(await shim.start(start)).toBe('refused');
    for (const adapter of ['codex', 'opencode', 'pi']) {
      expect(WORKER_ADAPTERS[adapter]?.stop).toEqual({ kind: 'best-effort' });
    }
    const stop = { kind: 'exact', proofKind: 'fixture-tree' } as const;
    const exact = fake(session.sandboxIncarnationId, { adapterStops: { 'exact-fixture': stop } });
    const exactStart = { ...start, adapterId: 'exact-fixture' };
    await exact.start(exactStart);
    expect(await exact.stop(start.workerId)).toBe('stopping');
    await expectPoll(exact, desired(1), {
      ...emptyReport,
      workers: [{ ...runningWorker, state: 'stopping', stop }],
    });
    exact.observeChildExit(start.workerId);
    expect(await exact.waitUntilAbsent(start.workerId, new LifecycleDeadline(0))).toEqual({
      state: 'held',
    });
    const exited = { ...runningWorker, state: 'exited', stop } as const;
    await expectPoll(exact, desired(2), { ...emptyReport, workers: [exited] });
    exact.observeTreeAbsent(start.workerId);
    const absence = {
      state: 'absent',
      workerId: start.workerId,
      proofKind: 'fixture-tree',
    } as const;
    expect(await exact.waitUntilAbsent(start.workerId, new LifecycleDeadline(0))).toEqual(absence);
    expect(await exact.waitUntilAbsent('foreign', new LifecycleDeadline(0))).toEqual({
      state: 'held',
    });
    await expectPoll(exact, desired(3), { ...emptyReport, workers: [{ ...exited, absence }] });
    expect(await exact.start(exactStart)).toBe('refused');
  });

  it('does not apply the predecessor session to a shim in a replacement incarnation', async () => {
    const replacement = fake('sandbox-2');
    const oldCore = vi.fn(async () => desired(1, { workers: [{ state: 'run', worker: start }] }));
    expect(await replacement.poll(session, oldCore)).toBe('stale');
    expect(oldCore).not.toHaveBeenCalled();
    expect(replacement.started).toEqual([]);
    const next = { ...session, sandboxIncarnationId: 'sandbox-2' };
    const worker = { ...start, workerId: 'worker-2' };
    const nextInput = {
      ...input,
      workerId: 'worker-2',
      attemptId: 'attempt-2',
      turnId: 'turn-2',
      operationId: 'operation-2',
    };
    await expectPoll(
      replacement,
      desired(1, {
        session: next,
        workers: [{ state: 'run', worker }],
        inputs: [nextInput],
      }),
      { ...emptyReport, session: next }
    );
    await expectPoll(replacement, desired(2, { session: next }), {
      ...emptyReport,
      session: next,
      workers: [{ ...runningWorker, workerId: worker.workerId }],
      receipts: [receipt('input', nextInput, 'accepted')],
    });
    expect(replacement.started).toEqual([worker.workerId]);
    expect(replacement.contacted).toEqual([nextInput.operationId]);
  });
});

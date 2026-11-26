import { describe, expect, it, vi } from 'vitest';
import { WORKER_ADAPTERS } from './adapter-registry.js';
import { LifecycleDeadline } from './lifecycle-deadline.js';
import { FakeWorkerShim, type FakeWorkerShimOptions } from './test-support/worker-shim-fake.js';
import type {
  WorkerShimDesiredSet,
  WorkerShimInventory,
  WorkerShimOperationKey,
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

describe('Worker Shim contract', () => {
  it('starts only after desired state arrives and keeps one start over lost observation and reconnect', async () => {
    const shim = fake(session.sandboxIncarnationId);
    const run = [{ state: 'run' as const, worker: start }];
    await expect(
      shim.poll(session, async () => {
        throw new Error('lost before delivery');
      })
    ).rejects.toThrow();
    expect(shim.started).toEqual([]);
    await shim.poll(session, async () => desired(1, { workers: run }));
    let inventory: WorkerShimInventory | undefined;
    await expect(
      shim.poll(session, async (report) => {
        inventory = report;
        throw new Error('lost report');
      })
    ).rejects.toThrow('lost report');
    expect(inventory?.workers).toEqual([
      { workerId: start.workerId, state: 'running', stop: { kind: 'best-effort' } },
    ]);
    const successor = { ...session, connectionGeneration: 2 };
    await shim.poll(successor, async () => desired(1, { session: successor, workers: run }));
    const obsolete = vi.fn(async () => desired(100, { workers: run }));
    expect(await shim.poll(session, obsolete)).toBe('stale');
    expect(obsolete).not.toHaveBeenCalled();
    expect(shim.started).toEqual([start.workerId]);
  });

  it('discards a delayed old-session reply and a superseded revision before they start work', async () => {
    const shim = fake(session.sandboxIncarnationId);
    const delayed = Promise.withResolvers<WorkerShimDesiredSet>();
    const oldPoll = shim.poll(session, () => delayed.promise);
    const successor = { ...session, connectionGeneration: 2 };
    await shim.poll(successor, async () => desired(3, { session: successor }));
    const workers = [{ state: 'run' as const, worker: start }];
    delayed.resolve(desired(100, { workers }));
    expect(await oldPoll).toBe('stale');
    expect(
      await shim.poll(successor, async () => desired(2, { session: successor, workers }))
    ).toBe('stale');
    expect(
      await shim.poll(successor, async () =>
        desired(101, { session: { ...successor, sandboxIncarnationId: 'other' }, workers })
      )
    ).toBe('stale');
    expect(shim.started).toEqual([]);
  });

  it('keeps original input evidence until acknowledged and never repeats a native admission', async () => {
    const shim = fake(session.sandboxIncarnationId);
    await shim.poll(session, async () =>
      desired(1, {
        workers: [{ state: 'run', worker: start }],
        inputs: [input],
      })
    );
    const successor = { ...session, connectionGeneration: 2 };
    let inventory: WorkerShimInventory | undefined;
    await shim.poll(successor, async (report) => {
      inventory = report;
      return desired(1, { session: successor, inputs: [input] });
    });
    expect(inventory?.receipts).toEqual([
      {
        kind: 'input',
        key: {
          workerId: input.workerId,
          operationId: input.operationId,
          payloadDigest: input.payloadDigest,
        },
        disposition: 'accepted',
      },
    ]);
    expect(await shim.keyedTurnInput(input)).toBe('accepted');
    expect(await shim.keyedTurnInput({ ...input, payloadDigest: 'changed' })).toBe('refused');
    expect(await shim.keyedTurnInput({ ...input, attemptId: 'other' })).toBe('refused');
    expect(await shim.keyedTurnInput({ ...input, routeGrant: 'other' })).toBe('refused');
    expect(shim.contacted).toEqual([input.operationId]);
    await shim.poll(successor, async () =>
      desired(2, {
        session: successor,
        acknowledgedOperations: [{ ...key(input), payloadDigest: 'changed' }],
      })
    );
    await shim.poll(successor, async (report) => {
      expect(report.receipts).toEqual([
        { kind: 'input', key: key(input), disposition: 'accepted' },
      ]);
      return desired(3, { session: successor, acknowledgedOperations: [key(input)] });
    });
    await shim.poll(successor, async (report) => {
      expect(report.receipts).toEqual([]);
      return desired(4, { session: successor, inputs: [input] });
    });
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
    await shim.stop(start.workerId);
    expect(shim.contacted).toEqual([input.operationId]);
    expect(receiveInput).toHaveBeenCalledExactlyOnceWith(input);
    shim.observeChildExit(start.workerId);
    shim.observeTreeAbsent(start.workerId);
    expect(await shim.waitUntilAbsent(start.workerId, new LifecycleDeadline(0))).toEqual({
      state: 'held',
    });
    await shim.poll(session, async (report) => {
      expect(report.receipts).toEqual([
        { kind: 'input', key: key(input), disposition: 'unknown' },
        { kind: 'input', key: key(laterInput), disposition: 'refused' },
        { kind: 'steer', key: key(laterSteer), disposition: 'refused' },
      ]);
      return desired(1);
    });
  });

  it('uses the receiver result for fresh poll steer and refuses OpenCode steer before contact', async () => {
    const steer = { ...input, operationId: 'steer-1', payloadDigest: 'steer-digest' };
    const receiveSteer = vi.fn(() => undefined);
    const shim = fake(session.sandboxIncarnationId, { steer: receiveSteer });
    await shim.poll(session, async () =>
      desired(1, {
        workers: [{ state: 'run', worker: start }],
        inputs: [input],
        steers: [steer],
      })
    );
    await shim.poll(session, async (report) => {
      expect(report.receipts).toEqual([
        { kind: 'input', key: key(input), disposition: 'accepted' },
        { kind: 'steer', key: key(steer), disposition: 'unknown' },
      ]);
      return desired(2, { steers: [steer] });
    });
    expect(receiveSteer).toHaveBeenCalledExactlyOnceWith(steer);
    expect(shim.contacted).toEqual([input.operationId, steer.operationId]);

    const openCode = fake(session.sandboxIncarnationId, { steer: receiveSteer });
    await openCode.start({ ...start, adapterId: 'opencode' });
    await openCode.keyedTurnInput(input);
    expect(await openCode.keyedSteer(steer)).toBe('refused');
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
    await shim.poll(session, async () => desired(1, { interrupts: [interrupt, conflict] }));
    shim.observeInterruptSettlement({ ...interrupt, attemptId: 'foreign' });
    const next = { ...input, turnId: 'next', attemptId: 'next', operationId: 'next' };
    expect(await shim.keyedTurnInput(next)).toBe('refused');
    await shim.poll(session, async (report) => {
      expect(report.interrupts).toEqual([
        { ...interrupt, disposition: 'unknown' },
        { ...conflict, disposition: 'refused' },
      ]);
      return desired(2, { interrupts: [interrupt, conflict] });
    });
    shim.observeInterruptSettlement(interrupt);
    await shim.poll(session, async (report) => {
      expect(report.interrupts).toEqual([
        { ...interrupt, disposition: 'cancelled' },
        { ...conflict, disposition: 'refused' },
      ]);
      return desired(3);
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
    await shim.poll(session, async () =>
      desired(1, {
        workers: [{ state: 'run', worker: start }],
        inputs: [input],
        interrupts: [interrupt],
      })
    );
    expect(shim.contacted).toEqual([]);
    expect(shim.interrupted).toEqual([]);
    await shim.poll(session, async (report) => {
      expect(report.interrupts).toEqual([{ ...interrupt, disposition: 'unknown' }]);
      expect(report.receipts).toContainEqual(expect.objectContaining({ disposition: 'refused' }));
      return desired(2, { inputs: [input], interrupts: [interrupt] });
    });
    expect(shim.contacted).toEqual([]);
    expect(await shim.waitUntilAbsent(start.workerId, new LifecycleDeadline(0))).toEqual({
      state: 'held',
    });
  });

  it('keeps stop monotonic and distinguishes direct-child exit from qualified absence', async () => {
    const shim = fake(session.sandboxIncarnationId);
    await shim.poll(session, async () =>
      desired(1, { workers: [{ state: 'run', worker: start }] })
    );
    await shim.poll(session, async () =>
      desired(2, {
        workers: [{ state: 'stop', workerId: start.workerId }],
        inputs: [input],
      })
    );
    expect(await shim.keyedTurnInput(input)).toBe('refused');
    expect(shim.contacted).toEqual([]);
    shim.observeChildExit(start.workerId);
    shim.observeTreeAbsent(start.workerId);
    expect(await shim.waitUntilAbsent(start.workerId, new LifecycleDeadline(0))).toEqual({
      state: 'held',
    });
    expect(await shim.start(start)).toBe('refused');
    for (const adapter of ['codex', 'opencode', 'pi']) {
      expect(WORKER_ADAPTERS[adapter]?.stop).toEqual({ kind: 'best-effort' });
    }
    const exact = fake(session.sandboxIncarnationId, {
      adapterStops: { 'exact-fixture': { kind: 'exact', proofKind: 'fixture-tree' } },
    });
    const exactStart = { ...start, adapterId: 'exact-fixture' };
    await exact.start(exactStart);
    await exact.stop(start.workerId);
    exact.observeChildExit(start.workerId);
    expect(await exact.waitUntilAbsent(start.workerId, new LifecycleDeadline(0))).toEqual({
      state: 'held',
    });
    exact.observeTreeAbsent(start.workerId);
    expect(await exact.waitUntilAbsent(start.workerId, new LifecycleDeadline(0))).toEqual({
      state: 'absent',
      workerId: start.workerId,
      proofKind: 'fixture-tree',
    });
    expect(await exact.waitUntilAbsent('foreign', new LifecycleDeadline(0))).toEqual({
      state: 'held',
    });
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
    await replacement.poll(next, async () =>
      desired(1, {
        session: next,
        workers: [{ state: 'run', worker }],
        inputs: [nextInput],
      })
    );
    expect(replacement.started).toEqual([worker.workerId]);
    expect(replacement.contacted).toEqual([nextInput.operationId]);
  });
});

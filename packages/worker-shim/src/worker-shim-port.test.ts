import { describe, expect, it, vi } from 'vitest';
import { LifecycleDeadline } from './lifecycle-deadline.js';
import { FakeWorkerShim } from './test-support/worker-shim-fake.js';
import type {
  WorkerShimDesiredSet,
  WorkerShimInventory,
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
    const shim = new FakeWorkerShim(session.sandboxIncarnationId);
    const run = [{ state: 'run' as const, worker: start }];
    await expect(
      shim.poll(session, async () => {
        throw new Error('lost before delivery');
      })
    ).rejects.toThrow();
    expect(shim.started).toEqual([]);
    await shim.poll(session, async () => desired(1, { workers: run }));
    await expect(
      shim.poll(session, async (report) => {
        expect(report.workers).toMatchObject([{ workerId: start.workerId, state: 'running' }]);
        throw new Error('lost report');
      })
    ).rejects.toThrow();
    const successor = { ...session, connectionGeneration: 2 };
    await shim.poll(successor, async () => desired(1, { session: successor, workers: run }));
    const obsolete = vi.fn();
    expect(await shim.poll(session, obsolete)).toBe('stale');
    expect(obsolete).not.toHaveBeenCalled();
    expect(shim.started).toEqual([start.workerId]);
  });

  it('discards a delayed old-session reply and a superseded revision before they start work', async () => {
    const shim = new FakeWorkerShim(session.sandboxIncarnationId);
    const delayed = Promise.withResolvers<WorkerShimDesiredSet>();
    const oldPoll = shim.poll(session, () => delayed.promise);
    const successor = { ...session, connectionGeneration: 2 };
    await shim.poll(successor, async () => desired(3, { session: successor }));
    const workers = [{ state: 'run' as const, worker: start }];
    delayed.resolve(desired(1, { workers }));
    expect(await oldPoll).toBe('stale');
    expect(
      await shim.poll(successor, async () => desired(2, { session: successor, workers }))
    ).toBe('stale');
    expect(shim.started).toEqual([]);
  });

  it('keeps original input evidence until acknowledged and never repeats a native admission', async () => {
    const shim = new FakeWorkerShim(session.sandboxIncarnationId);
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
    expect(await shim.keyedTurnInput({ ...input, payloadDigest: 'changed' })).toBe('refused');
    expect(shim.contacted).toEqual([input.operationId]);
    await shim.poll(successor, async () =>
      desired(2, { session: successor, acknowledgedOperations: [input] })
    );
    await shim.poll(successor, async (report) => {
      expect(report.receipts).toEqual([]);
      return desired(3, { session: successor, inputs: [input] });
    });
    expect(shim.contacted).toEqual([input.operationId]);
  });

  it('holds unknown input, ends that Worker and retains the original unknown after local exit', async () => {
    const shim = new FakeWorkerShim(session.sandboxIncarnationId, { input: 'unknown' });
    await shim.start(start);
    expect(await shim.keyedTurnInput(input)).toBe('unknown');
    expect(await shim.keyedTurnInput(input)).toBe('unknown');
    expect(await shim.keyedTurnInput({ ...input, operationId: 'other' })).toBe('refused');
    expect(shim.contacted).toEqual([input.operationId]);
    shim.observeChildExit(start.workerId);
    expect(await shim.waitUntilAbsent(start.workerId, new LifecycleDeadline(0))).toEqual({
      state: 'held',
    });
    await shim.poll(session, async (report) => {
      expect(report.receipts).toContainEqual(expect.objectContaining({ disposition: 'unknown' }));
      return desired(1);
    });
  });

  it('keeps unknown steer on its original key and retains an admitted interrupt after the Turn ends', async () => {
    const shim = new FakeWorkerShim(session.sandboxIncarnationId, { steer: 'unknown' });
    await shim.start(start);
    await shim.keyedTurnInput(input);
    const steer = { ...input, operationId: 'steer-1' };
    const interrupt = {
      workerId: input.workerId,
      attemptId: input.attemptId,
      turnId: input.turnId,
      requestId: 'interrupt-1',
      cause: 'observation_limit_reached' as const,
    };
    expect(await shim.keyedSteer(steer)).toBe('unknown');
    await shim.poll(session, async () => desired(1, { steers: [steer], interrupts: [interrupt] }));
    await shim.poll(session, async (report) => {
      expect(report.interrupts).toEqual([{ ...interrupt, disposition: 'cancelled' }]);
      expect(report.receipts).toContainEqual(
        expect.objectContaining({ kind: 'steer', disposition: 'unknown' })
      );
      return desired(2, { interrupts: [interrupt, { ...interrupt, requestId: 'conflict' }] });
    });
    expect(shim.interrupted).toEqual([interrupt.requestId]);
    expect(shim.contacted).toEqual([input.operationId, steer.operationId]);
  });

  it('blocks fresh action before reconciling a committed cutoff and keeps inactive settlement unknown', async () => {
    const shim = new FakeWorkerShim(session.sandboxIncarnationId);
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
    const shim = new FakeWorkerShim(session.sandboxIncarnationId);
    await shim.start(start);
    expect(await shim.stop(start.workerId)).toBe('stopping');
    expect(await shim.keyedTurnInput(input)).toBe('refused');
    expect(shim.contacted).toEqual([]);
    shim.observeChildExit(start.workerId);
    expect(await shim.waitUntilAbsent(start.workerId, new LifecycleDeadline(0))).toEqual({
      state: 'held',
    });
    expect(await shim.start(start)).toBe('refused');
    const exact = new FakeWorkerShim(session.sandboxIncarnationId, {
      stop: { kind: 'exact', proofKind: 'fixture-tree' },
    });
    await exact.start(start);
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
    expect(await exact.start(start)).toBe('refused');
  });

  it('does not apply the predecessor session to a shim in a replacement incarnation', async () => {
    const replacement = new FakeWorkerShim('sandbox-2');
    const oldCore = vi.fn();
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

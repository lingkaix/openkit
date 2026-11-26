import { describe, expect, it } from 'vitest';
import { LifecycleDeadline } from '../../../../packages/worker-shim/src/lifecycle-deadline.js';
import { FakeWorkerShim } from '../../../../packages/worker-shim/src/test-support/worker-shim-fake.js';
import type {
  WorkerShimDesiredSet,
  WorkerShimInventory,
  WorkerShimTurnInput,
} from '../../../../packages/worker-shim/src/worker-shim-port.js';
import type {
  ExecutionBackendCorrelation,
  ExecutionBackendObservation,
  ExecutionBackendPort,
  ExecutionReleaseProof,
} from './execution-backend.js';

type SubmitCut = 'refused' | 'before-commit' | 'after-commit' | 'no-readback';

/** S5 uses the same port calls and effect oracles with a different fixture on a real backend. */
interface ContractFixture {
  readonly backend: ExecutionBackendPort;
  readonly original: ExecutionBackendCorrelation;
  readonly deadline: string;
  reopen(): Promise<ExecutionBackendPort>;
  setHistoryReadable(readable: boolean): Promise<void>;
  advanceToDeadline(): Promise<void>;
  fence(): Promise<void>;
  closeIngress(): Promise<void>;
  joinAcceptedWork(): Promise<void>;
  observeAbsence(scope: ExecutionBackendCorrelation): Promise<void>;
  readEffects(): Promise<{ readonly nativeStarts: number; readonly releases: number }>;
}

const handoffs = {
  terminalHandoff: true,
  output: true,
  evidence: true,
  outsideWorkspaceCollection: true,
  integrationDrain: true,
  routesRevoked: true,
} satisfies ExecutionReleaseProof;

/** The independent evidence survives replacement of the port object in the fake. */
function fakeFixture(
  cut: SubmitCut,
  deliverInput?: (input: ExecutionBackendCorrelation) => Promise<void>
): ContractFixture {
  const original: ExecutionBackendCorrelation = {
    attemptId: 'attempt',
    backendId: 'backend',
    bindingRef: 'binding',
    inputRef: 'input',
    operationId: 'operation',
  };
  let now = Date.parse('2026-11-26T00:00:00.000Z');
  const deadline = new Date(now + 7_200_000).toISOString();
  let submitted = false;
  let nativeStarts = 0;
  let releases = 0;
  const receiverHistory = new Map<
    string,
    { receipt: 'accepted' | 'not_accepted' | null; complete: boolean }
  >();
  let historyReadable = true;
  let fenced = false;
  let ingressClosed = false;
  let acceptedWorkJoined = false;
  let qualifiedAbsence = false;

  const correlationKey = (input: ExecutionBackendCorrelation) =>
    JSON.stringify([
      input.attemptId,
      input.backendId,
      input.bindingRef,
      input.inputRef,
      input.operationId,
    ]);
  const originalKey = correlationKey(original);
  const matches = (input: ExecutionBackendCorrelation) => correlationKey(input) === originalKey;

  const readDisposition = (input: ExecutionBackendCorrelation) => {
    const history = receiverHistory.get(correlationKey(input));
    if (!history) return undefined;
    if (!historyReadable) return 'unknown';
    if (history.receipt) return history.receipt;
    if (ingressClosed && acceptedWorkJoined && history.complete) return 'not_accepted';
    return 'unknown';
  };
  const fencedRef = () => (releases > 0 ? 'original-scope-proof' : null);
  const observation = (
    result: ExecutionBackendObservation['disposition']
  ): ExecutionBackendObservation => ({
    ...original,
    disposition: result,
    execution: result === 'accepted' ? 'pending' : 'unknown',
    fenceRef: fencedRef(),
    outcomeRef: null,
  });

  const openPort = (): ExecutionBackendPort => ({
    id: original.backendId,
    async submit(input) {
      if (!matches(input) || input.deadline !== deadline || submitted)
        throw new Error('Submission lacks original unused admission');
      submitted = true;
      const key = correlationKey(input);
      if (cut === 'refused' || fenced || now >= Date.parse(deadline)) {
        receiverHistory.set(key, { receipt: 'not_accepted', complete: true });
        return observation('not_accepted');
      }
      if (cut === 'before-commit') {
        receiverHistory.set(key, { receipt: null, complete: true });
        throw new Error('Submit reply lost before acceptance');
      }
      await deliverInput?.(input);
      nativeStarts++;
      if (cut === 'after-commit') {
        receiverHistory.set(key, { receipt: 'accepted', complete: true });
        throw new Error('Submit reply lost after acceptance');
      }
      receiverHistory.set(key, { receipt: null, complete: false });
      return observation('unknown');
    },
    async inspect(input) {
      const disposition = readDisposition(input);
      return disposition === undefined ? null : observation(disposition);
    },
    async cancel(input) {
      if (!fenced || !matches(input)) throw new Error('Cancellation lacks original fenced scope');
      return {
        ...observation(readDisposition(input) ?? 'unknown'),
        execution: 'unknown',
        fenceRef: null,
      };
    },
    async release(input) {
      if (!matches(input) || !fenced) throw new Error('Release lacks original fenced scope');
      if (
        !qualifiedAbsence ||
        Object.keys(handoffs).some((key) => !input.proof[key as keyof ExecutionReleaseProof])
      )
        return { ...original, state: 'pending', fenceRef: null };
      if (releases === 0) releases++;
      return { ...original, state: 'released', fenceRef: fencedRef() };
    },
  });

  return {
    backend: openPort(),
    original,
    deadline,
    reopen: async () => openPort(),
    async setHistoryReadable(readable) {
      historyReadable = readable;
    },
    async advanceToDeadline() {
      now = Date.parse(deadline);
    },
    async fence() {
      fenced = true;
    },
    async closeIngress() {
      ingressClosed = true;
    },
    async joinAcceptedWork() {
      acceptedWorkJoined = true;
    },
    async observeAbsence(scope) {
      if (matches(scope) && ingressClosed && acceptedWorkJoined) qualifiedAbsence = true;
    },
    async readEffects() {
      return { nativeStarts, releases };
    },
  };
}

function expectedObservation(
  original: ExecutionBackendCorrelation,
  disposition: ExecutionBackendObservation['disposition'],
  fenceRef: string | null = null
): ExecutionBackendObservation {
  return {
    ...original,
    disposition,
    execution: disposition === 'accepted' ? 'pending' : 'unknown',
    fenceRef,
    outcomeRef: null,
  };
}

function expectHeld(
  result: Awaited<ReturnType<ExecutionBackendPort['release']>>,
  original: ExecutionBackendCorrelation
): void {
  expect(result).toEqual({
    ...original,
    state: expect.stringMatching(/^(pending|unknown)$/),
    fenceRef: null,
  });
}

/** C = Compute Neutrality Target. S = Durable Scheduler Design. */
function executionBackendContract(
  fixture: (cut: SubmitCut) => ContractFixture | Promise<ContractFixture>
): void {
  it('C27, S132 refuses definitively before contact with zero starts', async () => {
    const f = await fixture('refused');
    const refusal = expectedObservation(f.original, 'not_accepted');
    expect(await f.backend.submit({ ...f.original, deadline: f.deadline })).toEqual(refusal);
    expect(await f.backend.inspect(f.original)).toEqual(refusal);

    const reopened = await f.reopen();
    expect(await reopened.inspect(f.original)).toEqual(refusal);
    expect(await f.readEffects()).toEqual({ nativeStarts: 0, releases: 0 });
  });

  it('C28, S128/170 reads the original committed key after reply loss and reopen without resending', async () => {
    const f = await fixture('after-commit');
    await expect(f.backend.submit({ ...f.original, deadline: f.deadline })).rejects.toThrow(
      'Submit reply lost after acceptance'
    );
    const unknown = expectedObservation(f.original, 'unknown');
    expect(await f.readEffects()).toEqual({ nativeStarts: 1, releases: 0 });
    await f.setHistoryReadable(false);
    expect(await f.backend.inspect(f.original)).toEqual(unknown);
    const reopened = await f.reopen();
    expect(await reopened.inspect(f.original)).toEqual(unknown);
    await f.setHistoryReadable(true);
    for (const [key, value] of Object.entries(f.original)) {
      const wrong = { ...f.original, [key]: `${value}-other` };
      expect(await reopened.inspect(wrong)).toBeNull();
    }
    expect(await reopened.inspect(f.original)).toEqual(expectedObservation(f.original, 'accepted'));
    expect(await f.readEffects()).toEqual({ nativeStarts: 1, releases: 0 });
  });

  it.each(['ingress', 'accepted work'] as const)(
    'C28, S130 requires quiescence and readable negative history after loss before commit (%s settles first)',
    async (first) => {
      const f = await fixture('before-commit');
      await expect(f.backend.submit({ ...f.original, deadline: f.deadline })).rejects.toThrow(
        'Submit reply lost before acceptance'
      );
      const unknown = expectedObservation(f.original, 'unknown');
      await f.advanceToDeadline();
      expect(await f.backend.inspect(f.original)).toEqual(unknown);
      const reopened = await f.reopen();
      expect(await reopened.inspect(f.original)).toEqual(unknown);
      await f.fence();
      if (first === 'ingress') await f.closeIngress();
      else await f.joinAcceptedWork();
      expect(await reopened.inspect(f.original)).toEqual(unknown);
      await f.setHistoryReadable(false);
      if (first === 'ingress') await f.joinAcceptedWork();
      else await f.closeIngress();
      expect(await reopened.inspect(f.original)).toEqual(unknown);
      await f.setHistoryReadable(true);
      expect(await reopened.inspect(f.original)).toEqual(
        expectedObservation(f.original, 'not_accepted')
      );
      expect(await f.readEffects()).toEqual({ nativeStarts: 0, releases: 0 });
    }
  );

  it('C29–30/70, S145 holds after a stop ACK, expiry, early observation or foreign absence', async () => {
    const f = await fixture('no-readback');
    expect(await f.backend.submit({ ...f.original, deadline: f.deadline })).toEqual(
      expectedObservation(f.original, 'unknown')
    );
    await f.fence();
    expect(await f.backend.cancel(f.original)).toEqual(expectedObservation(f.original, 'unknown'));

    const release = { ...f.original, proof: handoffs };
    expectHeld(await f.backend.release(release), f.original);
    await f.advanceToDeadline();
    await f.observeAbsence(f.original);
    expectHeld(await f.backend.release(release), f.original);
    await f.closeIngress();
    await f.observeAbsence(f.original);
    await f.joinAcceptedWork();
    expectHeld(await f.backend.release(release), f.original);
    await f.observeAbsence({ ...f.original, bindingRef: 'foreign-binding' });
    expectHeld(await f.backend.release(release), f.original);
    expect(await f.readEffects()).toEqual({ nativeStarts: 1, releases: 0 });
  });

  it('C30/70, S145 releases once with each handoff and exact proof, even across reopen', async () => {
    const f = await fixture('no-readback');
    const unknown = expectedObservation(f.original, 'unknown');
    expect(await f.backend.submit({ ...f.original, deadline: f.deadline })).toEqual(unknown);
    await f.fence();
    expect(await f.backend.cancel(f.original)).toEqual(unknown);
    await f.closeIngress();
    await f.joinAcceptedWork();
    await f.observeAbsence(f.original);
    for (const key of Object.keys(handoffs)) {
      expectHeld(
        await f.backend.release({ ...f.original, proof: { ...handoffs, [key]: false } }),
        f.original
      );
    }
    expect(await f.readEffects()).toEqual({ nativeStarts: 1, releases: 0 });

    const release = { ...f.original, proof: handoffs };
    const foreign = { ...f.original, bindingRef: 'foreign-binding' };
    await expect(f.backend.release({ ...foreign, proof: handoffs })).rejects.toThrow(
      'Release lacks original fenced scope'
    );
    expect(await f.readEffects()).toEqual({ nativeStarts: 1, releases: 0 });

    const result = await f.backend.release(release);
    expect(result).toEqual({
      ...f.original,
      state: 'released',
      fenceRef: expect.any(String),
    });
    const reopened = await f.reopen();
    expect(await reopened.release(release)).toEqual(result);
    expect(await f.readEffects()).toEqual({ nativeStarts: 1, releases: 1 });
  });

  it('C28/70, S130/134 keeps input unknown after physical absence and release', async () => {
    const f = await fixture('no-readback');
    expect(await f.backend.submit({ ...f.original, deadline: f.deadline })).toEqual(
      expectedObservation(f.original, 'unknown')
    );
    expect(await f.backend.inspect(f.original)).toEqual(expectedObservation(f.original, 'unknown'));
    await f.fence();
    expect(await f.backend.cancel(f.original)).toEqual(expectedObservation(f.original, 'unknown'));
    await f.closeIngress();
    await f.joinAcceptedWork();
    await f.observeAbsence(f.original);
    expect(await f.backend.inspect(f.original)).toEqual(expectedObservation(f.original, 'unknown'));
    const released = await f.backend.release({ ...f.original, proof: handoffs });
    expect(released).toEqual({
      ...f.original,
      state: 'released',
      fenceRef: expect.any(String),
    });
    const reopened = await f.reopen();
    expect(await reopened.inspect(f.original)).toEqual(
      expectedObservation(f.original, 'unknown', released.fenceRef)
    );
    expect(await f.readEffects()).toEqual({ nativeStarts: 1, releases: 1 });
  });
}

describe('execution backend port S5 contract', () => executionBackendContract(fakeFixture));

it('keeps the shim input unknown across reconnect and backend reopen after scoped release', async () => {
  const session = { sandboxIncarnationId: 'incarnation', connectionGeneration: 1 };
  const worker = {
    workerId: 'worker',
    adapterId: 'codex',
    agentSessionId: 'agent-session',
    workSlotRef: 'work-slot',
    resume: null,
  };
  const nativeAcceptances: WorkerShimTurnInput[] = [];
  const shim = new FakeWorkerShim(session.sandboxIncarnationId, {
    input(input) {
      nativeAcceptances.push(input);
      throw new Error('lost result after native acceptance');
    },
  });
  const desired = {
    session,
    revision: 1,
    workers: [],
    inputs: [],
    steers: [],
    interrupts: [],
    acknowledgedOperations: [],
  } satisfies WorkerShimDesiredSet;
  const emptyReport: WorkerShimInventory = { session, workers: [], receipts: [], interrupts: [] };
  const expectPoll = async (reply: WorkerShimDesiredSet, expected: WorkerShimInventory) => {
    const reports: WorkerShimInventory[] = [];
    const result = await shim.poll(reply.session, async (report) => {
      reports.push(report);
      return reply;
    });
    expect(reports).toEqual([expected]);
    expect(result).toBe('applied');
  };
  const f = fakeFixture('no-readback', async ({ attemptId, inputRef, operationId }) => {
    if (inputRef === null) throw new Error('Expected original input reference');
    await expectPoll(
      {
        ...desired,
        workers: [{ state: 'run', worker }],
        inputs: [
          {
            attemptId,
            inputRef,
            operationId,
            workerId: worker.workerId,
            turnId: 'turn',
            payloadDigest: 'digest',
            routeGrant: 'grant',
          },
        ],
      },
      emptyReport
    );
  });
  const release = { ...f.original, proof: handoffs };
  const unknown = expectedObservation(f.original, 'unknown');
  const receiptKey = {
    workerId: worker.workerId,
    operationId: f.original.operationId,
    payloadDigest: 'digest',
  };

  expect(await f.backend.submit({ ...f.original, deadline: f.deadline })).toEqual(unknown);
  expect(nativeAcceptances).toEqual([
    {
      ...receiptKey,
      attemptId: f.original.attemptId,
      inputRef: f.original.inputRef,
      turnId: 'turn',
      routeGrant: 'grant',
    },
  ]);
  await f.fence();
  expect(await f.backend.cancel(f.original)).toEqual(unknown);
  const reconnected = { ...session, connectionGeneration: 2 };
  const stoppingWorker = {
    workerId: worker.workerId,
    state: 'stopping',
    stop: { kind: 'best-effort' },
  } as const;
  const stoppingReport: WorkerShimInventory = {
    session: reconnected,
    receipts: [{ kind: 'input', key: receiptKey, disposition: 'unknown' }],
    workers: [stoppingWorker],
    interrupts: [],
  };
  await expectPoll(
    {
      ...desired,
      session: reconnected,
      workers: [{ state: 'stop', workerId: worker.workerId }],
    },
    stoppingReport
  );
  await expectPoll({ ...desired, session: reconnected, revision: 2 }, stoppingReport);

  expectHeld(await f.backend.release(release), f.original);
  shim.observeChildExit(worker.workerId);
  await expectPoll(
    { ...desired, session: reconnected, revision: 3 },
    {
      ...stoppingReport,
      workers: [{ ...stoppingWorker, state: 'exited' }],
    }
  );
  await f.advanceToDeadline();
  expect(await shim.waitUntilAbsent(worker.workerId, new LifecycleDeadline(0))).toEqual({
    state: 'held',
  });
  await f.closeIngress();
  await f.joinAcceptedWork();
  expectHeld(await f.backend.release(release), f.original);
  expect(await f.readEffects()).toEqual({ nativeStarts: 1, releases: 0 });

  await f.observeAbsence(f.original);
  const released = await f.backend.release(release);
  expect(released).toEqual({
    ...f.original,
    state: 'released',
    fenceRef: expect.any(String),
  });
  const reopened = await f.reopen();
  expect(await reopened.release(release)).toEqual(released);
  expect(await reopened.inspect(f.original)).toEqual(
    expectedObservation(f.original, 'unknown', released.fenceRef)
  );
  expect(nativeAcceptances).toHaveLength(1);
  expect(await f.readEffects()).toEqual({ nativeStarts: 1, releases: 1 });
});

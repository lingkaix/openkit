import { describe, expect, it } from 'vitest';
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
function fakeFixture(cut: SubmitCut): ContractFixture {
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
  const receiverHistory = new Map<string, { receipt: 'accepted' | null; complete: boolean }>();
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
      if (cut === 'refused' || fenced || now >= Date.parse(deadline))
        return observation('not_accepted');
      const key = correlationKey(input);
      if (cut === 'before-commit') {
        receiverHistory.set(key, { receipt: null, complete: true });
        throw new Error('Submit reply lost before acceptance');
      }
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

function expectUnproved(result: ExecutionBackendObservation | null): void {
  if (result) expect(result.disposition).toBe('unknown');
}

function expectHeld(
  result: Awaited<ReturnType<ExecutionBackendPort['release']>>,
  original: ExecutionBackendCorrelation
): void {
  expect(result).toMatchObject(original);
  expect(result.state).toMatch(/^(pending|unknown)$/);
}

/** C = Compute Neutrality Target. S = Durable Scheduler Design. */
function executionBackendContract(
  fixture: (cut: SubmitCut) => ContractFixture | Promise<ContractFixture>
): void {
  it('C27, S132 refuses definitively before contact with zero starts', async () => {
    const f = await fixture('refused');
    expect(await f.backend.submit({ ...f.original, deadline: f.deadline })).toMatchObject({
      ...f.original,
      disposition: 'not_accepted',
    });
    expect(await f.readEffects()).toEqual({ nativeStarts: 0, releases: 0 });
  });

  it('C28, S128/170 reads the original committed key after reply loss and reopen without resending', async () => {
    const f = await fixture('after-commit');
    expectUnproved(
      await f.backend.submit({ ...f.original, deadline: f.deadline }).catch(() => null)
    );
    expect(await f.readEffects()).toEqual({ nativeStarts: 1, releases: 0 });
    await f.setHistoryReadable(false);
    expectUnproved(await f.backend.inspect(f.original));
    const reopened = await f.reopen();
    expectUnproved(await reopened.inspect(f.original));
    await f.setHistoryReadable(true);
    for (const [key, value] of Object.entries(f.original)) {
      const wrong = { ...f.original, [key]: `${value}-other` };
      expectUnproved(await reopened.inspect(wrong));
    }
    expect(await reopened.inspect(f.original)).toMatchObject({
      ...f.original,
      disposition: 'accepted',
    });
    expect(await f.readEffects()).toEqual({ nativeStarts: 1, releases: 0 });
  });

  it.each(['ingress', 'accepted work'] as const)(
    'C28, S130 requires quiescence and readable negative history after loss before commit (%s settles first)',
    async (first) => {
      const f = await fixture('before-commit');
      expectUnproved(
        await f.backend.submit({ ...f.original, deadline: f.deadline }).catch(() => null)
      );
      await f.advanceToDeadline();
      expectUnproved(await f.backend.inspect(f.original));
      const reopened = await f.reopen();
      expectUnproved(await reopened.inspect(f.original));
      await f.fence();
      if (first === 'ingress') await f.closeIngress();
      else await f.joinAcceptedWork();
      expectUnproved(await reopened.inspect(f.original));
      await f.setHistoryReadable(false);
      if (first === 'ingress') await f.joinAcceptedWork();
      else await f.closeIngress();
      expectUnproved(await reopened.inspect(f.original));
      await f.setHistoryReadable(true);
      expect(await reopened.inspect(f.original)).toMatchObject({
        ...f.original,
        disposition: 'not_accepted',
      });
      expect(await f.readEffects()).toEqual({ nativeStarts: 0, releases: 0 });
    }
  );

  it('C29–30/70, S145 holds after a stop ACK, expiry, early observation or foreign absence', async () => {
    const f = await fixture('no-readback');
    expect(await f.backend.submit({ ...f.original, deadline: f.deadline })).toMatchObject({
      ...f.original,
      disposition: 'unknown',
    });
    await f.fence();
    expect(await f.backend.cancel(f.original)).toMatchObject({
      ...f.original,
      disposition: 'unknown',
      fenceRef: null,
    });

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
    await f.backend.submit({ ...f.original, deadline: f.deadline });
    await f.fence();
    await f.backend.cancel(f.original);
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
    const foreignResult = await f.backend
      .release({ ...foreign, proof: handoffs })
      .catch(() => null);
    if (foreignResult) expectHeld(foreignResult, foreign);
    expect(await f.readEffects()).toEqual({ nativeStarts: 1, releases: 0 });

    const result = await f.backend.release(release);
    expect(result).toMatchObject({
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
    expect(await f.backend.submit({ ...f.original, deadline: f.deadline })).toMatchObject({
      ...f.original,
      disposition: 'unknown',
    });
    expect(await f.backend.inspect(f.original)).toMatchObject({
      ...f.original,
      disposition: 'unknown',
    });
    await f.fence();
    expect(await f.backend.cancel(f.original)).toMatchObject({
      ...f.original,
      disposition: 'unknown',
      fenceRef: null,
    });
    await f.closeIngress();
    await f.joinAcceptedWork();
    await f.observeAbsence(f.original);
    expect(await f.backend.inspect(f.original)).toMatchObject({
      ...f.original,
      disposition: 'unknown',
    });
    expect(await f.backend.release({ ...f.original, proof: handoffs })).toMatchObject({
      ...f.original,
      state: 'released',
      fenceRef: expect.any(String),
    });
    const reopened = await f.reopen();
    expect(await reopened.inspect(f.original)).toMatchObject({
      ...f.original,
      disposition: 'unknown',
    });
    expect(await f.readEffects()).toEqual({ nativeStarts: 1, releases: 1 });
  });
}

describe('execution backend port S5 contract', () => executionBackendContract(fakeFixture));

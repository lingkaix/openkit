import { allocateEntityId } from '@openkit/protocol';
import { expect, it, vi } from 'vitest';
import type { RepairCallIntent, RepairCallReservation } from '../storage/control-kernel-port.js';
import { storageRequestId } from '../storage/storage-owner.js';
import { runRepairModelCall } from './gateway-repair.js';

type RepairInput = Parameters<typeof runRepairModelCall<string>>[0];
type Kernel = NonNullable<RepairInput['kernel']>;
const failures = ['synchronous throw', 'rejected promise'] as const;

function failReply(mode: (typeof failures)[number], message: string): Promise<never> {
  const error = new Error(message);
  if (mode === 'synchronous throw') throw error;
  return Promise.reject(error);
}

function repairFixture() {
  const occurrence = {
    deploymentId: 'deployment',
    sourceOwner: 'control-kernel',
    verb: 'repair.model-call',
    occurrenceKey: allocateEntityId('cap'),
  } as const;
  const execution = { owner: { kind: 'server' }, executionId: 'original' } as const;
  const intent: RepairCallIntent = {
    ...occurrence,
    requestId: storageRequestId(occurrence),
    expectedGeneration: 'grant-revision',
    inputDigest: `sha256:${'a'.repeat(64)}`,
    target: {
      entryStep: { execution, stepId: 'admit-original' },
      attemptId: 'attempt-original',
      invocationId: 'invocation-original',
      callId: occurrence.occurrenceKey,
      routeRef: 'repair.route',
      allocationRef: 'repair.allocation',
    },
  };
  const reservation: RepairCallReservation = {
    intent,
    receiptDigest: `sha256:${'b'.repeat(64)}`,
    disposition: 'applied',
    result: { step: { execution, stepId: 'reserve-original' } },
  };
  const auditEventId = allocateEntityId('aud');
  const kernel = {
    reserveRepairCall: vi.fn<Kernel['reserveRepairCall']>(async () => ({
      state: 'ready',
      value: { state: 'reserved-now', reservation },
    })),
    inspectRepairCall: vi.fn<Kernel['inspectRepairCall']>(async () => ({
      state: 'ready',
      value: { state: 'reserved', reservation },
    })),
    settleRepairCall: vi.fn<Kernel['settleRepairCall']>(async () => ({
      state: 'ready',
      value: { state: 'settled', receipt: auditEventId },
    })),
  };
  const checkCurrentAuthority = vi.fn<RepairInput['checkCurrentAuthority']>(async () => 'allowed');
  const provider = vi.fn(async () => ({
    disposition: 'succeeded' as const,
    reply: 'private model reply',
    inputTokens: 10,
    outputTokens: 3,
  }));
  const request = {
    payload: { text: 'private repair input' },
    contextWindowTokens: 4096,
    outputReserveTokens: 32,
  };
  const invoke = vi.fn<RepairInput['invoke']>(async (transport) => {
    expect(transport.singleAttempt).toBe(true);
    await transport.finalRequestAdmission(request);
    return provider();
  });
  return {
    intent,
    reservation,
    kernel,
    checkCurrentAuthority,
    invoke,
    provider,
    request,
    auditEventId,
  };
}

it('is typed unavailable before Gateway preparation when the kernel repair binding is absent', async () => {
  const { intent, checkCurrentAuthority, invoke, provider } = repairFixture();
  await expect(runRepairModelCall({ intent, checkCurrentAuthority, invoke })).resolves.toEqual({
    state: 'unavailable',
    owner: 'control-kernel',
    reason: 'disabled',
  });
  expect(invoke).not.toHaveBeenCalled();
  expect(checkCurrentAuthority).not.toHaveBeenCalled();
  expect(provider).not.toHaveBeenCalled();
});

it('returns the original repair result only after the kernel terminal Audit acknowledgment', async () => {
  const f = repairFixture();
  const audit = Promise.withResolvers<Awaited<ReturnType<Kernel['settleRepairCall']>>>();
  f.kernel.settleRepairCall.mockReturnValueOnce(audit.promise);
  const reply = vi.fn();
  const result = runRepairModelCall(f).then(reply);
  await vi.waitFor(() => expect(f.kernel.settleRepairCall).toHaveBeenCalledTimes(1));
  expect(reply).not.toHaveBeenCalled();
  expect(f.kernel.reserveRepairCall).toHaveBeenCalledWith(f.intent);
  expect(f.checkCurrentAuthority).toHaveBeenCalledWith(f.reservation, f.request);
  expect(f.provider).toHaveBeenCalledTimes(1);
  expect(f.kernel.reserveRepairCall.mock.invocationCallOrder[0]).toBeLessThan(
    f.checkCurrentAuthority.mock.invocationCallOrder[0]!
  );
  expect(f.checkCurrentAuthority.mock.invocationCallOrder[0]).toBeLessThan(
    f.provider.mock.invocationCallOrder[0]!
  );
  expect(f.kernel.settleRepairCall).toHaveBeenCalledWith(f.reservation, {
    disposition: 'succeeded',
    inputTokens: 10,
    outputTokens: 3,
  });
  audit.resolve({ state: 'ready', value: { state: 'settled', receipt: f.auditEventId } });
  await result;
  expect(reply).toHaveBeenCalledWith({
    state: 'ready',
    value: { state: 'succeeded', auditEventId: f.auditEventId, reply: 'private model reply' },
  });
});

it.each(['policy', 'vault', 'budget'] as const)(
  'makes zero provider contacts on a kernel %s refusal',
  async (reason) => {
    const f = repairFixture();
    const refusal = { state: 'ready', value: { state: 'refused', reason } } as const;
    f.kernel.reserveRepairCall.mockResolvedValueOnce(refusal);
    f.kernel.inspectRepairCall.mockResolvedValueOnce({
      state: 'ready',
      value: { state: 'absent' },
    });
    await expect(runRepairModelCall(f)).resolves.toEqual(refusal);
    expect(f.kernel.inspectRepairCall).toHaveBeenCalledWith(f.intent);
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.kernel.settleRepairCall).not.toHaveBeenCalled();
  }
);

it.each(['policy', 'vault'] as const)(
  'rechecks current %s at the final request without restoring the reservation',
  async (reason) => {
    const f = repairFixture();
    f.checkCurrentAuthority.mockResolvedValueOnce(reason);
    await expect(runRepairModelCall(f)).resolves.toEqual({
      state: 'ready',
      value: { state: 'refused', reason },
    });
    expect(f.provider).not.toHaveBeenCalled();
    expect(f.kernel.settleRepairCall).toHaveBeenCalledWith(f.reservation, {
      disposition: 'failed',
    });
  }
);

it.each(failures)(
  'inspects the original reserve after a %s and grants no contact',
  async (mode) => {
    const f = repairFixture();
    const retained = {
      state: 'ready',
      value: { state: 'reserved', reservation: f.reservation },
    } as const;
    const failReserve = () => failReply(mode, 'lost reserve acknowledgment');
    f.kernel.reserveRepairCall.mockImplementationOnce(failReserve);
    await expect(runRepairModelCall(f)).resolves.toEqual(retained);
    expect(f.kernel.inspectRepairCall).toHaveBeenCalledWith(f.intent);
    f.kernel.reserveRepairCall.mockResolvedValueOnce(retained);
    await expect(runRepairModelCall(f)).resolves.toEqual(retained);
    f.kernel.reserveRepairCall.mockImplementationOnce(failReserve);
    f.kernel.inspectRepairCall.mockImplementationOnce(() => failReply(mode, 'inspection failed'));
    await expect(runRepairModelCall(f)).resolves.toEqual({
      state: 'ready',
      value: { state: 'unknown' },
    });
    expect(f.kernel.inspectRepairCall).toHaveBeenCalledTimes(2);
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.provider).not.toHaveBeenCalled();
    expect(f.kernel.settleRepairCall).not.toHaveBeenCalled();
  }
);

it('refuses a fresh reservation for another retained intent', async () => {
  const f = repairFixture();
  f.kernel.reserveRepairCall.mockResolvedValueOnce({
    state: 'ready',
    value: {
      state: 'reserved-now',
      reservation: {
        ...f.reservation,
        intent: { ...f.intent, target: { ...f.intent.target, routeRef: 'different.route' } },
      },
    },
  });
  await expect(runRepairModelCall(f)).resolves.toEqual({
    state: 'ready',
    value: { state: 'conflict' },
  });
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.kernel.settleRepairCall).not.toHaveBeenCalled();
});

it('keeps the charged reservation and reports an unknown outcome after a lost provider reply', async () => {
  const f = repairFixture();
  f.provider.mockRejectedValueOnce(new Error('lost provider reply'));
  await expect(runRepairModelCall(f)).resolves.toEqual({
    state: 'ready',
    value: { state: 'unknown' },
  });
  expect(f.provider).toHaveBeenCalledTimes(1);
  expect(f.kernel.settleRepairCall).toHaveBeenCalledWith(f.reservation, { disposition: 'unknown' });
  const terminal = {
    state: 'ready',
    value: { state: 'terminal', auditEventId: f.auditEventId },
  } as const;
  f.kernel.reserveRepairCall.mockResolvedValueOnce(terminal);
  await expect(runRepairModelCall(f)).resolves.toEqual(terminal);
  expect(f.provider).toHaveBeenCalledTimes(1);
});

it.each(failures)('settles unknown after a %s during Gateway preparation', async (mode) => {
  const f = repairFixture();
  f.invoke.mockImplementationOnce(() => failReply(mode, 'Gateway preparation failed'));
  await expect(runRepairModelCall(f)).resolves.toEqual({
    state: 'ready',
    value: { state: 'unknown' },
  });
  expect(f.checkCurrentAuthority).not.toHaveBeenCalled();
  expect(f.provider).not.toHaveBeenCalled();
  expect(f.kernel.settleRepairCall).toHaveBeenCalledTimes(1);
  expect(f.kernel.settleRepairCall).toHaveBeenCalledWith(f.reservation, { disposition: 'unknown' });
});

it.each(failures)('withholds the reply after a %s from terminal Audit', async (mode) => {
  const f = repairFixture();
  f.kernel.settleRepairCall.mockImplementationOnce(() =>
    failReply(mode, 'lost terminal acknowledgment')
  );
  await expect(runRepairModelCall(f)).resolves.toEqual({
    state: 'ready',
    value: { state: 'unknown' },
  });
  expect(f.provider).toHaveBeenCalledTimes(1);
  expect(f.kernel.settleRepairCall).toHaveBeenCalledTimes(1);
  expect(f.kernel.settleRepairCall).toHaveBeenCalledWith(f.reservation, {
    disposition: 'succeeded',
    inputTokens: 10,
    outputTokens: 3,
  });
});

it('allows a final admission check once for the fresh reservation', async () => {
  const f = repairFixture();
  f.invoke.mockImplementationOnce(async (transport) => {
    await transport.finalRequestAdmission(f.request);
    const response = await f.provider();
    await expect(transport.finalRequestAdmission(f.request)).rejects.toThrow('already checked');
    return response;
  });
  const result = await runRepairModelCall(f);
  expect(result).toMatchObject({ state: 'ready', value: { state: 'succeeded' } });
  expect(f.checkCurrentAuthority).toHaveBeenCalledTimes(1);
  expect(f.provider).toHaveBeenCalledTimes(1);
});

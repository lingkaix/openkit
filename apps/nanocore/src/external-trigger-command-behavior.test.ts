import { describe, expect, it, vi } from 'vitest';
import { externalTriggerFixture } from '../test-support/external-trigger-behavior.fixture.js';

vi.mock('./runtime/scheduler-dispatch-loop.js', () => ({
  runSchedulerDispatchLoop: vi.fn(async () => ({ started: [] })),
}));

const EVENT = 'external-s1-event';

describe('external event command-log behavior', () => {
  it('retains the original external event after eight days, ordinary Core pruning and reopen', async () => {
    const f = await externalTriggerFixture();
    const first = await f.admit(EVENT, 'Original event.');
    const sourceTurnId = first.admission.sourceTurnId;
    await f.nextPoll();
    await f.ordinaryCoreCommand();
    const repeated = await f.admit(EVENT, 'Changed later payload.');
    expect(repeated.duplicate).toBe(true);
    expect(repeated.admission.queueEntryId).toBe(first.admission.queueEntryId);
    expect(repeated.admission.sourceTurnId).toBe(sourceTurnId);
    expect(repeated.turn.id).toBe(first.turn.id);
    expect(repeated.turn.threadId).toBe(first.turn.threadId);
    expect(repeated.entry.turnInput).toBe(first.entry.turnInput);
    await f.reopen();
    const reopened = await f.admit(EVENT, 'Changed after reopening.');
    expect(reopened.duplicate).toBe(true);
    expect(reopened.admission).toEqual(first.admission);
    expect(reopened.turn.id).toBe(first.turn.id);
    expect(reopened.entry.turnInput).toBe(first.entry.turnInput);
  });

  it('refuses a corrupt retained sourceTurnId with 409 recovery_required', async () => {
    const f = await externalTriggerFixture();
    const first = await f.admit(EVENT, 'Original event.');
    await f.nextPoll();
    await f.corruptOriginalSourceTurnId(first.admission.sourceTurnId);
    await expect(f.admit(EVENT, 'Must not replace the damaged original.')).rejects.toMatchObject({
      code: 'recovery_required',
      status: 409,
    });
  });
});

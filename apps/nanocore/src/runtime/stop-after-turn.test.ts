import type { TurnStatus } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';

import { shouldStopAfterTurn, stopReasonForTurnStatus } from './stop-after-turn.js';

describe('shouldStopAfterTurn', () => {
  it('completes or enters review after normal completion', () => {
    expect(
      shouldStopAfterTurn({
        stopReason: 'completed',
        reviewRequired: false,
        remainingWorkerIterations: 1,
      })
    ).toEqual({
      outcome: 'complete',
      shouldStop: true,
      stopReason: 'completed',
    });
    expect(
      shouldStopAfterTurn({
        stopReason: 'completed',
        reviewRequired: true,
        remainingWorkerIterations: 1,
      })
    ).toEqual({
      outcome: 'review',
      shouldStop: true,
      stopReason: 'completed',
    });
  });

  it('continues on length while budget remains and blocks after budget exhaustion', () => {
    expect(
      shouldStopAfterTurn({
        stopReason: 'length',
        reviewRequired: true,
        remainingWorkerIterations: 1,
      })
    ).toEqual({
      outcome: 'continue',
      shouldStop: false,
      stopReason: 'length',
    });
    expect(
      shouldStopAfterTurn({
        stopReason: 'budget_exhausted',
        reviewRequired: true,
        remainingWorkerIterations: 0,
      })
    ).toEqual({
      outcome: 'block',
      shouldStop: true,
      stopReason: 'budget_exhausted',
    });
    expect(
      shouldStopAfterTurn({
        stopReason: 'length',
        reviewRequired: true,
        remainingWorkerIterations: 0,
      })
    ).toEqual({
      outcome: 'block',
      shouldStop: true,
      stopReason: 'length',
    });
  });

  it('routes ask-user, error, and aborted outcomes explicitly', () => {
    expect(
      shouldStopAfterTurn({
        stopReason: 'ask_user',
        reviewRequired: true,
        remainingWorkerIterations: 1,
      })
    ).toEqual({
      outcome: 'ask_user',
      shouldStop: true,
      stopReason: 'ask_user',
    });
    expect(
      shouldStopAfterTurn({
        stopReason: 'error',
        reviewRequired: true,
        remainingWorkerIterations: 1,
      })
    ).toEqual({
      outcome: 'block',
      shouldStop: true,
      stopReason: 'error',
    });
    expect(
      shouldStopAfterTurn({
        stopReason: 'aborted',
        reviewRequired: true,
        remainingWorkerIterations: 1,
      })
    ).toEqual({
      outcome: 'abort',
      shouldStop: true,
      stopReason: 'aborted',
    });
  });

  it('maps terminal turn read-model statuses to protocol stop reasons', () => {
    const mappings: Array<[TurnStatus, ReturnType<typeof stopReasonForTurnStatus>]> = [
      ['completed', 'completed'],
      ['interrupted', 'aborted'],
      ['awaiting_human', 'ask_user'],
      ['failed', 'error'],
    ];

    for (const [status, stopReason] of mappings) {
      expect(stopReasonForTurnStatus(status)).toBe(stopReason);
    }
  });
});

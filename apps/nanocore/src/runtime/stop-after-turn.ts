import type { StopReason, TurnStatus } from '@openkit/protocol';

/**
 * Loop outcome after one worker turn completes.
 */
export type StopAfterTurnOutcome =
  | 'continue'
  | 'review'
  | 'ask_user'
  | 'block'
  | 'abort'
  | 'complete';

/**
 * Input used to decide whether the worker or Goal Mode loop should stop.
 */
export interface ShouldStopAfterTurnInput {
  /** Protocol stop reason emitted by the worker turn. */
  readonly stopReason: StopReason;
  /** Whether normal completion should pass through review before final completion. */
  readonly reviewRequired: boolean;
  /** Remaining worker iterations available after the completed turn. */
  readonly remainingWorkerIterations: number;
}

/**
 * Decision returned after evaluating one worker turn stop reason.
 */
export interface StopAfterTurnDecision {
  /** Higher-level loop outcome selected from the stop reason and loop policy. */
  readonly outcome: StopAfterTurnOutcome;
  /** True when the current loop should pause or terminate instead of continuing. */
  readonly shouldStop: boolean;
  /** Protocol stop reason that produced the decision. */
  readonly stopReason: StopReason;
}

/**
 * Decides whether a worker or Goal Mode loop should stop after one worker turn.
 *
 * @param input Stop reason and loop policy input.
 * @returns Loop stop decision.
 */
export function shouldStopAfterTurn(input: ShouldStopAfterTurnInput): StopAfterTurnDecision {
  switch (input.stopReason) {
    case 'completed':
      return createDecision(input.stopReason, input.reviewRequired ? 'review' : 'complete');
    case 'length':
      return createDecision(
        input.stopReason,
        input.remainingWorkerIterations > 0 ? 'continue' : 'block'
      );
    case 'ask_user':
      return createDecision(input.stopReason, 'ask_user');
    case 'aborted':
      return createDecision(input.stopReason, 'abort');
    case 'error':
    case 'budget_exhausted':
      return createDecision(input.stopReason, 'block');
  }
}

/**
 * Maps a stored turn read-model status to the protocol stop reason vocabulary.
 *
 * @param status Stored turn status after worker execution.
 * @returns Stop reason for the worker envelope.
 */
export function stopReasonForTurnStatus(status: TurnStatus): StopReason {
  if (status === 'completed') {
    return 'completed';
  }

  if (status === 'interrupted') {
    return 'aborted';
  }

  if (status === 'awaiting_human') {
    return 'ask_user';
  }

  return 'error';
}

/**
 * Creates a normalized stop-after-turn decision.
 *
 * @param stopReason Protocol stop reason that produced the decision.
 * @param outcome Higher-level loop outcome.
 * @returns Normalized stop-after-turn decision.
 */
function createDecision(
  stopReason: StopReason,
  outcome: StopAfterTurnOutcome
): StopAfterTurnDecision {
  return {
    outcome,
    shouldStop: outcome !== 'continue',
    stopReason,
  };
}

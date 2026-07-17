import type { StopReason } from '@openkit/protocol';

/**
 * App-local worker turn stages used by checkpoint and recovery flows.
 */
export const WORKER_TURN_STAGES = [
  'preparing',
  'running_worker',
  'waiting_for_user',
  'completed',
  'failed',
  'aborted',
] as const;

/**
 * App-local worker turn stage.
 */
export type WorkerTurnStage = (typeof WORKER_TURN_STAGES)[number];

/**
 * Terminal worker turn stages.
 */
export type TerminalWorkerTurnStage = Extract<WorkerTurnStage, 'completed' | 'failed' | 'aborted'>;

/**
 * Checks whether a worker turn stage is terminal.
 *
 * @param stage Worker turn stage to inspect.
 * @returns True when the stage cannot transition further.
 */
export function isTerminalWorkerTurnStage(
  stage: WorkerTurnStage
): stage is TerminalWorkerTurnStage {
  return stage === 'completed' || stage === 'failed' || stage === 'aborted';
}

/**
 * Maps a protocol stop reason to the app-local worker checkpoint stage.
 *
 * @param stopReason Protocol stop reason returned by a worker turn.
 * @returns Worker checkpoint stage that should be persisted for the terminal outcome.
 */
export function workerTurnStageForStopReason(stopReason: StopReason): WorkerTurnStage {
  if (
    stopReason === 'completed' ||
    stopReason === 'length' ||
    stopReason === 'budget_exhausted'
  ) {
    return 'completed';
  }

  if (stopReason === 'aborted') {
    return 'aborted';
  }

  if (stopReason === 'ask_user') {
    return 'waiting_for_user';
  }

  return 'failed';
}

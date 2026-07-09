import type { StopReason } from '@openkit/protocol';

/**
 * App-local worker turn stages used by checkpoint and recovery flows.
 */
export const WORKER_TURN_STAGES = [
  'preparing',
  'running_worker',
  'waiting_for_user',
  'reviewing',
  'verifying',
  'saving',
  'recovering',
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

const VALID_STAGE_TRANSITIONS = {
  preparing: ['running_worker', 'waiting_for_user', 'failed', 'aborted'],
  running_worker: ['waiting_for_user', 'reviewing', 'verifying', 'recovering', 'failed', 'aborted'],
  waiting_for_user: ['running_worker', 'reviewing', 'aborted'],
  reviewing: ['running_worker', 'verifying', 'saving', 'failed', 'aborted'],
  verifying: ['reviewing', 'saving', 'failed', 'aborted'],
  saving: ['completed', 'failed', 'aborted'],
  recovering: ['preparing', 'running_worker', 'waiting_for_user', 'failed', 'aborted'],
  completed: [],
  failed: [],
  aborted: [],
} as const satisfies Record<WorkerTurnStage, readonly WorkerTurnStage[]>;

/**
 * Applies one worker turn stage transition.
 *
 * @param current Current worker turn stage.
 * @param next Requested next worker turn stage.
 * @returns The accepted next stage.
 * @throws Error when the transition is not valid for the initial worker stage model.
 */
export function transitionWorkerTurnStage(
  current: WorkerTurnStage,
  next: WorkerTurnStage
): WorkerTurnStage {
  if ((VALID_STAGE_TRANSITIONS[current] as readonly WorkerTurnStage[]).includes(next)) {
    return next;
  }

  throw new Error(`Invalid worker turn stage transition: ${current} -> ${next}`);
}

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
  if (stopReason === 'completed') {
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

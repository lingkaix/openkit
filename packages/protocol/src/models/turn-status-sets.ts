import type { TurnStatus } from './turn.js';

/**
 * Exhaustive membership for sealed Turn terminals.
 *
 * Sealed terminals are completed, interrupted, cancelled, and failed.
 *
 * Authority lives in docs/core/protocol.md Turn Semantics.
 *
 * Adding a TurnStatus value fails compilation because this record must name every status.
 */
export const SEALED_TURN_TERMINALS: Record<TurnStatus, boolean> = {
  pending: false,
  running: false,
  completed: true,
  interrupted: true,
  cancelled: true,
  failed: true,
};

/**
 * Exhaustive membership for Turn statuses that are settled for waiters.
 *
 * No Turn state pauses for a person, so settled for waiters is the sealed terminals.
 *
 * Authority lives in docs/core/protocol.md Turn Semantics.
 *
 * Adding a TurnStatus value fails compilation because this record must name every status.
 */
export const SETTLED_FOR_WAITERS_TURN_STATUSES: Record<TurnStatus, boolean> = {
  pending: false,
  running: false,
  completed: true,
  interrupted: true,
  cancelled: true,
  failed: true,
};

/**
 * Exhaustive membership for checkpoint-collectable Turn statuses.
 *
 * Checkpoint collectable is the sealed terminals minus interrupted, because recovery may still own interrupted Turns.
 *
 * Authority lives in docs/core/protocol.md Turn Semantics.
 *
 * Adding a TurnStatus value fails compilation because this record must name every status.
 */
export const CHECKPOINT_COLLECTABLE_TURN_STATUSES: Record<TurnStatus, boolean> = {
  pending: false,
  running: false,
  completed: true,
  interrupted: false,
  cancelled: true,
  failed: true,
};

/**
 * Exhaustive membership for recovery-rewritable Turn statuses.
 *
 * Recovery rewritable is pending and running only.
 *
 * Authority lives in docs/core/protocol.md Turn Semantics.
 *
 * Adding a TurnStatus value fails compilation because this record must name every status.
 */
export const RECOVERY_REWRITABLE_TURN_STATUSES: Record<TurnStatus, boolean> = {
  pending: true,
  running: true,
  completed: false,
  interrupted: false,
  cancelled: false,
  failed: false,
};

/**
 * Returns whether a Turn status is a sealed terminal.
 *
 * @param status Turn status to classify.
 * @returns True for completed, interrupted, cancelled, and failed.
 */
export function isSealedTurnTerminal(status: TurnStatus): boolean {
  return SEALED_TURN_TERMINALS[status] === true;
}

/**
 * Returns whether a Turn status is settled for waiters.
 *
 * @param status Turn status to classify.
 * @returns True for the sealed terminals.
 */
export function isSettledForWaitersTurnStatus(status: TurnStatus): boolean {
  return SETTLED_FOR_WAITERS_TURN_STATUSES[status] === true;
}

/**
 * Returns whether a Turn status is checkpoint collectable.
 *
 * @param status Turn status to classify.
 * @returns True for sealed terminals except interrupted.
 */
export function isCheckpointCollectableTurnStatus(status: TurnStatus): boolean {
  return CHECKPOINT_COLLECTABLE_TURN_STATUSES[status] === true;
}

/**
 * Returns whether a Turn status is recovery rewritable.
 *
 * @param status Turn status to classify.
 * @returns True for pending and running only.
 */
export function isRecoveryRewritableTurnStatus(status: TurnStatus): boolean {
  return RECOVERY_REWRITABLE_TURN_STATUSES[status] === true;
}

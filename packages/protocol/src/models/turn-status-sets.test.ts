import { describe, expect, it } from 'vitest';

import { type TurnStatus, TurnStatusSchema } from './turn.js';
import {
  CHECKPOINT_COLLECTABLE_TURN_STATUSES,
  isCheckpointCollectableTurnStatus,
  isRecoveryRewritableTurnStatus,
  isSealedTurnTerminal,
  isSettledForWaitersTurnStatus,
  RECOVERY_REWRITABLE_TURN_STATUSES,
  SEALED_TURN_TERMINALS,
  SETTLED_FOR_WAITERS_TURN_STATUSES,
} from './turn-status-sets.js';

/**
 * Lists Turn statuses whose exhaustive membership flag is true, in schema order.
 *
 * @param membership Exhaustive Turn status membership record.
 * @returns Included statuses in TurnStatusSchema order.
 */
function included(membership: Record<TurnStatus, boolean>): TurnStatus[] {
  return TurnStatusSchema.options.filter((status) => membership[status]);
}

describe('Turn status derived sets', () => {
  it('lists sealed terminals as completed, interrupted, cancelled, and failed', () => {
    expect(included(SEALED_TURN_TERMINALS)).toEqual([
      'completed',
      'interrupted',
      'cancelled',
      'failed',
    ]);
  });

  it('lists settled-for-waiters as the sealed terminals plus awaiting_human', () => {
    expect(included(SETTLED_FOR_WAITERS_TURN_STATUSES)).toEqual([
      'awaiting_human',
      'completed',
      'interrupted',
      'cancelled',
      'failed',
    ]);
  });

  it('lists checkpoint-collectable as the sealed terminals minus interrupted', () => {
    expect(included(CHECKPOINT_COLLECTABLE_TURN_STATUSES)).toEqual([
      'completed',
      'cancelled',
      'failed',
    ]);
  });

  it('lists recovery-rewritable as pending and running only', () => {
    expect(included(RECOVERY_REWRITABLE_TURN_STATUSES)).toEqual(['pending', 'running']);
  });

  it('keeps predicates aligned with the exhaustive membership records', () => {
    for (const status of TurnStatusSchema.options) {
      expect(isSealedTurnTerminal(status)).toBe(SEALED_TURN_TERMINALS[status] === true);
      expect(isSettledForWaitersTurnStatus(status)).toBe(
        SETTLED_FOR_WAITERS_TURN_STATUSES[status] === true
      );
      expect(isCheckpointCollectableTurnStatus(status)).toBe(
        CHECKPOINT_COLLECTABLE_TURN_STATUSES[status] === true
      );
      expect(isRecoveryRewritableTurnStatus(status)).toBe(
        RECOVERY_REWRITABLE_TURN_STATUSES[status] === true
      );
    }
  });
});

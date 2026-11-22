import type { AdmittedNanoHostAttemptRecovery } from '../runtime/nanohost-attempt-recovery.js';
import { ControlProductPreconditionError } from '../storage/control-store-product-records.js';
import type { NanoHostOwnerBinding } from '../storage/control-store-worker-client.js';

/** Uses the same acknowledged owner that fenced the RuntimeTarget before serving. */
export function bindBootNanoHostAttemptRecovery(
  owner: NanoHostOwnerBinding
): AdmittedNanoHostAttemptRecovery {
  const hold = { state: 'unavailable', owner: 'nanohost', reason: 'recovery-required' } as const;
  return {
    owner,
    close: owner.closeRecovery,
    commit: async (input) => {
      if (input.kind === 'retire-orphan') return hold;
      return owner.classifyRecovery(
        input as Parameters<NanoHostOwnerBinding['classifyRecovery']>[0]
      );
    },
    reconcileFinal: async () => {
      // Boot needs an inspect-only join of the original Core observation and Native final.
      throw new ControlProductPreconditionError();
    },
    // Recovery already reads exact physical receipts on replay. A first cleanup needs a
    // transport that pins the original lease and target and returns that same receipt.
    cleanup: async () => hold,
  };
}

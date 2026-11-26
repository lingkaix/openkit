import type { AdmittedNanoHostAttemptRecovery } from '../runtime/nanohost-attempt-recovery.js';
import type { WorkerBackendSessionRecord } from '../runtime/worker-backend-session-records.js';
import { ControlProductPreconditionError } from '../storage/control-store-product-records.js';
import type { NanoHostOwnerBinding } from '../storage/control-store-worker-client.js';
import {
  inspectAcceptedNanoHostFinalInDb,
  type NanoHostAcceptedFinalCommitment,
} from '../storage/core-journal-native.js';
import type { CoreDb } from '../storage/db.js';

/** The existing restart closeout owner. Its guarded read rechecks the same commitment. */
export interface BootNanoHostAcceptedFinalCloseout {
  readonly coreDb: CoreDb;
  readonly reconcileAcceptedFinalStatus: (
    session: WorkerBackendSessionRecord,
    commitment: NanoHostAcceptedFinalCommitment
  ) => Promise<unknown>;
}

/** Uses the same acknowledged owner that fenced the RuntimeTarget before serving. */
export function bindBootNanoHostAttemptRecovery(
  owner: NanoHostOwnerBinding,
  closeout: BootNanoHostAcceptedFinalCloseout
): AdmittedNanoHostAttemptRecovery {
  const hold = { state: 'unavailable', owner: 'nanohost', reason: 'recovery-required' } as const;
  return {
    owner,
    close: owner.closeRecovery,
    commit: async (input, cleanup) => {
      if (input.kind === 'retire-orphan') return hold;
      return owner.classifyRecovery(
        input as Parameters<NanoHostOwnerBinding['classifyRecovery']>[0],
        cleanup
      );
    },
    reconcileFinal: async (lease, session) => {
      // K8b: one inspect-only join of the Native final pair with the original Core intake and receipt.
      const read = owner.read((sqlite) =>
        inspectAcceptedNanoHostFinalInDb(closeout.coreDb, sqlite, lease.grant.attemptId)
      );
      // Unavailable, missing, duplicate or contradictory proof holds with the recovery diagnostic.
      if (read.state !== 'ready' || read.value.state === 'held')
        throw new ControlProductPreconditionError();
      if (read.value.state === 'native-only') return read.value;
      await closeout.reconcileAcceptedFinalStatus(session, read.value);
      return 'closed';
    },
    // Recovery already reads exact physical receipts on replay. K8b unit 2 replaces this typed hold
    // with the target-pinned first-cleanup entry. The expired-submission handoff reaches it here.
    cleanup: async () => hold,
  };
}

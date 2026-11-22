import type { AdmittedNanoHostAttemptRecovery } from '../runtime/nanohost-attempt-recovery.js';
import { ControlProductPreconditionError } from '../storage/control-store-product-records.js';
import type { NanoHostOwnerBinding } from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
import type { StorageResult } from '../storage/storage-owner.js';
import {
  currentAdmittedTestNanoHostOwner,
  reopenAdmittedTestNanoHost,
} from './admitted-nanohost.js';

/**
 * Same binding as Boot (`index.ts` `bindBootNanoHostAttemptRecovery`), which is private to the Boot module.
 * Keep it identical: the same owner close and classification writer, and the same holds for
 * `retire-orphan`, the inspect-only final join and the first physical cleanup.
 */
export function bindTestBootNanoHostAttemptRecovery(
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
      throw new ControlProductPreconditionError();
    },
    cleanup: async () => hold,
  };
}

/** The Boot recovery selection for a fixture root that holds an admitted NanoHost opening. */
export function testBootNanoHostRecovery(
  coreDb: Pick<CoreDb, 'dataRoot'>
): StorageResult<'nanohost', AdmittedNanoHostAttemptRecovery> | undefined {
  if (directRecoveryRoots.has(coreDb.dataRoot)) return undefined;
  const owner = currentAdmittedTestNanoHostOwner(coreDb);
  return owner ? { state: 'ready', value: bindTestBootNanoHostAttemptRecovery(owner) } : undefined;
}

const directRecoveryRoots = new Set<string>();

/**
 * Keeps one case on its own direct recovery input, without the Boot selection. Only for a case whose
 * attempt seed still predates the original submitted Core grant and Native worker lease, so that
 * Boot recovery would stop at the seed rather than at the behaviour under test. Remove the call when
 * the seed is ported.
 */
export function keepTestDirectNanoHostRecovery(coreDb: Pick<CoreDb, 'dataRoot'>): void {
  directRecoveryRoots.add(coreDb.dataRoot);
}

/**
 * Boot opens the admitted NanoHost owner once per process. After a fixture restart
 * (`shutdownControlStoreWorkerClient`), the next Boot rejoins the persisted owner before recovery.
 */
export async function bootTestNanoHost(coreDb: CoreDb): Promise<void> {
  const owner = currentAdmittedTestNanoHostOwner(coreDb);
  if (!owner || owner.read(() => true).state === 'ready') return;
  await reopenAdmittedTestNanoHost(coreDb);
}

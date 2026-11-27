import {
  type BootNanoHostAcceptedFinalCloseout,
  bindBootNanoHostAttemptRecovery,
} from '../bootstrap/nanohost-recovery.js';
import type { AdmittedNanoHostAttemptRecovery } from '../runtime/nanohost-attempt-recovery.js';
import type { CoreDb } from '../storage/db.js';
import type { StorageResult } from '../storage/storage-owner.js';
import {
  currentAdmittedTestNanoHostOwner,
  reopenAdmittedTestNanoHost,
} from './admitted-nanohost.js';

/**
 * The Boot recovery selection for a fixture root that holds an admitted NanoHost opening.
 * Without a closeout owner, a verified accepted final stops at a hold before closeout.
 */
export function testBootNanoHostRecovery(
  coreDb: CoreDb,
  reconcileAcceptedFinalStatus: BootNanoHostAcceptedFinalCloseout['reconcileAcceptedFinalStatus'] = async () => {
    throw new Error('This recovery fixture has no restart closeout owner.');
  }
): StorageResult<'nanohost', AdmittedNanoHostAttemptRecovery> | undefined {
  if (directRecoveryRoots.has(coreDb.dataRoot)) return undefined;
  const owner = currentAdmittedTestNanoHostOwner(coreDb);
  return owner
    ? {
        state: 'ready',
        value: bindBootNanoHostAttemptRecovery(owner, { coreDb, reconcileAcceptedFinalStatus }),
      }
    : undefined;
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

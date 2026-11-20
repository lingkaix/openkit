import { mutateNanoHostRuntimeTarget } from '../runtime/nanohost-runtime-target-records.js';
import { assertControlProductWriter } from './control-store-products.js';
import type { CoreDb } from './db.js';
import type { ControlRuntimeTargetInput } from './runtime-target-codecs.js';
import { fenceVaultCredentialWritersForEpoch } from './vault-native.js';

/** Performs one original current-target tuple inside the existing savepoint and FULL commit. */
export function applyControlRuntimeTarget(db: CoreDb, input: ControlRuntimeTargetInput) {
  assertControlProductWriter(db.sqlite);
  const before = db.sqlite
    .prepare(
      'SELECT target_id AS targetId, physical_epoch AS physicalEpoch FROM nanohost_runtime_targets'
    )
    .get() as { targetId: string; physicalEpoch: string | null } | undefined;
  const result = mutateNanoHostRuntimeTarget(db, input);
  if (
    before?.physicalEpoch &&
    result?.targetId === before.targetId &&
    result.physicalEpoch !== before.physicalEpoch
  )
    fenceVaultCredentialWritersForEpoch(db, before.targetId, before.physicalEpoch);
  return result;
}

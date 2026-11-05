import { ControlProductPreconditionError } from '../storage/control-store-product-records.js';
import type { CoreDb } from '../storage/db.js';
import type {
  ControlAccessTokenLifecycle,
  ControlAccessTokenLifecycleResult,
} from './access-token-lifecycle-codecs.js';
import {
  revokeOpenKitAccessTokenRecord,
  rotateOpenKitAccessTokenRecord,
} from './access-token-store.js';

/** Applies only the original canonical mutation inside the existing native Core savepoint. */
export function applyControlAccessTokenLifecycle(
  coreDb: CoreDb,
  input: ControlAccessTokenLifecycle
): ControlAccessTokenLifecycleResult {
  if (coreDb.scope !== 'core' || !coreDb.sqlite.inTransaction)
    throw new ControlProductPreconditionError();
  if (input.kind === 'revoke')
    return { kind: 'revoke', record: revokeOpenKitAccessTokenRecord(coreDb, input.tokenId) };
  return {
    kind: 'rotate',
    value: rotateOpenKitAccessTokenRecord(coreDb, input.tokenId, {
      graceSeconds: input.graceSeconds,
      successor: input.successor,
    }),
  };
}

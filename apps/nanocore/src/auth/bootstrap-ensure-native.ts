import { ControlProductPreconditionError } from '../storage/control-store-product-records.js';
import type { CoreDb } from '../storage/db.js';
import type {
  ControlBootstrapEnsure,
  ControlBootstrapEnsureResult,
} from './bootstrap-ensure-codecs.js';
import { ensureServerBootstrapToken } from './bootstrap-token.js';

/** Reuses the complete original ENSURE guard/upsert in the existing Core savepoint. */
export function applyControlBootstrapEnsure(
  coreDb: CoreDb,
  input: ControlBootstrapEnsure
): ControlBootstrapEnsureResult {
  if (coreDb.scope !== 'core' || !coreDb.sqlite.inTransaction)
    throw new ControlProductPreconditionError();
  return ensureServerBootstrapToken(coreDb, {}, input);
}

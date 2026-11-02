import {
  admitWorkerImageEnvironment,
  writeWorkerImageSettlementInTransaction,
} from '../runtime/worker-image-settlements-records.js';
import { assertControlProductWriter } from './control-store-products.js';
import type { CoreDb } from './db.js';
import type { ControlWorkerImageInput } from './worker-image-codecs.js';
/** Runs one original image tuple under the existing savepoint and covering FULL commit. */
export function applyControlWorkerImage(db: CoreDb, input: ControlWorkerImageInput): null {
  assertControlProductWriter(db.sqlite);
  if (input.kind === 'settlement')
    writeWorkerImageSettlementInTransaction(db, input.value, db.sqlite);
  else admitWorkerImageEnvironment(db, input.candidate, input.environment);
  return null;
}

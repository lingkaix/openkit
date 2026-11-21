import type Database from 'better-sqlite3';
import {
  admitWorkerImageEnvironment,
  writeWorkerImageSettlementInTransaction,
} from '../runtime/worker-image-settlements-records.js';
import { assertControlProductWriter } from './control-store-products.js';
import type { ControlWorkerImageInput } from './worker-image-codecs.js';
/** Runs one original image tuple under the existing savepoint and covering FULL commit. */
export function applyControlWorkerImage(
  owner: { readonly sqlite: Database.Database },
  input: ControlWorkerImageInput
): null {
  assertControlProductWriter(owner.sqlite);
  if (input.kind === 'settlement')
    writeWorkerImageSettlementInTransaction(owner, input.value, owner.sqlite);
  else admitWorkerImageEnvironment(owner, input.candidate, input.environment);
  return null;
}

import type Database from 'better-sqlite3';
import {
  admitWorkerImageEnvironment,
  insertWorkerImageSettlementInTransaction,
  writeWorkerImageSettlementInTransaction,
} from '../runtime/worker-image-settlements-records.js';
import { ControlProductPreconditionError } from './control-store-product-records.js';
import { assertControlProductWriter } from './control-store-products.js';
import type { CoreDb } from './db.js';
import type { ControlWorkerImageInput } from './worker-image-codecs.js';

/** Applies the original image tuple, with acquisition journal settlement confined to Core. */
export function applyControlWorkerImage(
  owner: CoreDb | { readonly scope?: never; readonly sqlite: Database.Database },
  input: ControlWorkerImageInput
): null {
  assertControlProductWriter(owner.sqlite);
  if (input.kind === 'environment') {
    admitWorkerImageEnvironment(owner, input.candidate, input.environment);
  } else if (owner.scope === 'core') {
    writeWorkerImageSettlementInTransaction(owner, input.value, owner.sqlite);
  } else {
    if (input.value.operation !== 'image.build') throw new ControlProductPreconditionError();
    insertWorkerImageSettlementInTransaction(owner, input.value);
  }
  return null;
}

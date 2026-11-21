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

/** Runs an image tuple that can complete in the NanoHost file alone. */
export function applyNanoHostLocalWorkerImage(
  owner: { readonly sqlite: Database.Database },
  input: ControlWorkerImageInput
): null {
  assertControlProductWriter(owner.sqlite);
  if (input.kind === 'environment') {
    admitWorkerImageEnvironment(owner, input.candidate, input.environment);
  } else {
    if (input.value.operation !== 'image.build') throw new ControlProductPreconditionError();
    insertWorkerImageSettlementInTransaction(owner, input.value);
  }
  return null;
}

/** The current Core path also settles the original image-acquisition journal step. */
export function applyControlWorkerImage(db: CoreDb, input: ControlWorkerImageInput): null {
  if (input.kind === 'environment') return applyNanoHostLocalWorkerImage(db, input);
  assertControlProductWriter(db.sqlite);
  writeWorkerImageSettlementInTransaction(db, input.value, db.sqlite);
  return null;
}

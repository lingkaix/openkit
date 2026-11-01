import * as records from '../runtime/nanohost-runtime-target-records.js';
import { assertControlProductWriter } from './control-store-products.js';
import type { CoreDb } from './db.js';
import type { ControlRuntimeTargetInput } from './runtime-target-codecs.js';

/** Performs one original current-target tuple inside the existing savepoint and FULL commit. */
export function applyControlRuntimeTarget(db: CoreDb, input: ControlRuntimeTargetInput) {
  assertControlProductWriter(db.sqlite);
  switch (input.kind) {
    case 'allocate':
      return records.allocateNanoHostRuntimeTargetConnectionGeneration(db, input);
    case 'ready':
      return records.upsertNanoHostRuntimeTarget(db, input);
    case 'close':
      return records.recordNanoHostRuntimeTargetConnectionClose(db, input);
    case 'restart':
      return records.fenceNanoHostRuntimeTargetAfterRestart(db, input.observedAt);
  }
}

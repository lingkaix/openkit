import { writeWorkerControlAcceptedRecord } from '../runtime/worker-control-records.js';
import { acceptWorkerControlSequence } from '../runtime/worker-control-sequences.js';
import {
  assertControlProductWriter,
  ControlProductPreconditionError,
} from './control-store-products.js';
import type { CoreDb } from './db.js';
import { WorkerHeartbeatRefusal } from './worker-control-heartbeat-codecs.js';
import { requireWorkerControlBinding } from './worker-control-heartbeat-native.js';
import {
  type ControlWorkerRecordInput,
  ControlWorkerRecordPayloadSchema,
  type ControlWorkerRecordResult,
} from './worker-control-record-codecs.js';

/** Applies exactly one original nonterminal sequence or receipt stage, never a combined replacement tuple. */
export function applyControlWorkerRecord(
  db: CoreDb,
  input: ControlWorkerRecordInput,
  content?: ArrayBuffer
): ControlWorkerRecordResult {
  assertControlProductWriter(db.sqlite);
  if (!content) throw new ControlProductPreconditionError();
  const payload = ControlWorkerRecordPayloadSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content))
  );
  requireWorkerControlBinding(db, input, new Date().toISOString());
  if (payload.kind === 'sequence') {
    const result = acceptWorkerControlSequence(db, { ...payload, lineage: input.lineage });
    if (result.status !== 'accepted')
      throw new WorkerHeartbeatRefusal(result.code, result.message, 409);
    return {
      kind: 'sequence',
      duplicate: result.duplicate,
      nextExpectedSequence: result.nextExpectedSequence,
    };
  }
  writeWorkerControlAcceptedRecord(db, { ...payload, lineage: input.lineage });
  return { kind: 'record' };
}

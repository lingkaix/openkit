import type Database from 'better-sqlite3';
import { writeWorkerControlAcceptedRecord } from '../runtime/worker-control-records.js';
import { acceptWorkerControlSequence } from '../runtime/worker-control-sequences.js';
import { ControlProductPreconditionError } from './control-store-product-records.js';
import { assertControlProductWriter } from './control-store-products.js';
import type { CoreDb } from './db.js';
import { WorkerHeartbeatRefusal } from './worker-control-heartbeat-codecs.js';
import { requireWorkerControlBinding } from './worker-control-heartbeat-native.js';
import {
  type ControlWorkerRecordCommand,
  type ControlWorkerRecordInput,
  ControlWorkerRecordPayloadSchema,
  type ControlWorkerRecordResult,
} from './worker-control-record-codecs.js';

/** Applies exactly one original nonterminal sequence or receipt stage, never a combined replacement tuple. */
export function applyControlWorkerRecord(
  ...args:
    | [db: CoreDb, input: ControlWorkerRecordInput, content?: ArrayBuffer | undefined]
    | [
        native: {
          readonly sqlite: Database.Database;
          readonly coreDb: CoreDb;
          readonly input: ControlWorkerRecordCommand;
          readonly observedAt?: string;
        },
      ]
): ControlWorkerRecordResult {
  if (args.length === 1) {
    const { sqlite, coreDb, input, observedAt } = args[0];
    assertControlProductWriter(sqlite);
    const payload = ControlWorkerRecordPayloadSchema.parse(input.payload);
    const recordLineage =
      payload.kind === 'record' &&
      (payload.operation === 'event_append' || payload.operation === 'capability_summary')
        ? payload.record.lineage
        : undefined;
    requireWorkerControlBinding(coreDb, input, observedAt ?? new Date().toISOString(), {
      sqlite,
      ...(recordLineage ? { recordLineage } : {}),
    });
    return applyNanoHostWorkerRecord(sqlite, input.lineage, payload);
  }
  const [db, input, content] = args;
  assertControlProductWriter(db.sqlite);
  if (!content) throw new ControlProductPreconditionError();
  const payload = ControlWorkerRecordPayloadSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content))
  );
  requireWorkerControlBinding(db, input, new Date().toISOString());
  return applyNanoHostWorkerRecord(db.sqlite, input.lineage, payload);
}

/** Commits a local sequence or receipt after the exact live Core decision. */
function applyNanoHostWorkerRecord(
  sqlite: Database.Database,
  lineage: ControlWorkerRecordInput['lineage'],
  payload: ControlWorkerRecordCommand['payload']
): ControlWorkerRecordResult {
  const owner = { sqlite };
  if (payload.kind === 'sequence') {
    const result = acceptWorkerControlSequence(owner, { ...payload, lineage });
    if (result.status !== 'accepted')
      throw new WorkerHeartbeatRefusal(result.code, result.message, 409);
    return {
      kind: 'sequence',
      duplicate: result.duplicate,
      nextExpectedSequence: result.nextExpectedSequence,
    };
  }
  writeWorkerControlAcceptedRecord(owner, { ...payload, lineage });
  return { kind: 'record' };
}

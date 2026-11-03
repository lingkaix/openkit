import { timingSafeEqual } from 'node:crypto';
import { canonicalJsonText } from '@openkit/protocol';
import { buildWorkerCanonicalTerminalEventRecord } from '@openkit/worker-protocol';
import { markSchedulerExecutionAttemptClosing } from '../runtime/execution-attempt-records.js';
import { resolveNanoHostAttemptTokenBinding } from '../runtime/nanohost-attempt-records.js';
import {
  resolveWorkerControlFinalStatusTokenBinding,
  writeWorkerControlAcceptedRecord,
} from '../runtime/worker-control-records.js';
import { acceptWorkerControlSequence } from '../runtime/worker-control-sequences.js';
import { ControlProductPreconditionError } from './control-store-product-records.js';
import { assertControlProductWriter } from './control-store-products.js';
import type { CoreDb } from './db.js';
import {
  type ControlWorkerFinalStatusInput,
  ControlWorkerFinalStatusPayloadSchema,
  type ControlWorkerFinalStatusResult,
  WorkerFinalStatusRefusal,
} from './worker-control-final-status-codecs.js';

/** Repeats the original lease refusal inside the deciding Core savepoint. */
function refuseBinding(
  reason: 'binding-not-found' | 'lineage-mismatch' | 'attempt-not-live' | 'reconnect-required'
): never {
  if (reason === 'binding-not-found')
    throw new WorkerFinalStatusRefusal(
      'worker_control_unauthorized',
      'Worker control request is missing a valid sandbox token.',
      401
    );
  if (reason === 'lineage-mismatch')
    throw new WorkerFinalStatusRefusal(
      'worker_control_lineage_mismatch',
      'Worker control request lineage does not match the durable lease binding.',
      403
    );
  if (reason === 'reconnect-required')
    throw new WorkerFinalStatusRefusal(
      'worker_control_reconnect_required',
      'Worker control session must reconnect after NanoCore restart.',
      503
    );
  throw new WorkerFinalStatusRefusal(
    'worker_control_lease_not_live',
    'Worker control request lease is not live.',
    403
  );
}

/** Commits both original fingerprints, both retained receipts and attempt close as one native FULL tuple. */
export function applyControlWorkerFinalStatus(
  db: CoreDb,
  input: ControlWorkerFinalStatusInput,
  content?: ArrayBuffer
): ControlWorkerFinalStatusResult {
  assertControlProductWriter(db.sqlite);
  if (!content) throw new ControlProductPreconditionError();
  const payload = ControlWorkerFinalStatusPayloadSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content))
  );
  const hash = db.sqlite
    .prepare(
      'SELECT worker_control_token_hash AS tokenHash FROM scheduler_execution_attempts WHERE binding_ref = ?'
    )
    .get(input.sandboxBindingRef) as { tokenHash: string | null } | undefined;
  if (
    !hash?.tokenHash ||
    !/^[0-9a-f]{64}$/.test(hash.tokenHash) ||
    !timingSafeEqual(Buffer.from(input.tokenHash), Buffer.from(hash.tokenHash))
  )
    refuseBinding('binding-not-found');
  const binding = { lineage: input.lineage, sandboxBindingRef: input.sandboxBindingRef };
  const resolution = resolveWorkerControlFinalStatusTokenBinding(db, binding);
  if (resolution.status === 'rejected') refuseBinding(resolution.reason);
  const { terminalData, sequence, acceptedAt, eventAcceptedAt } = payload;
  if (
    resolution.cancellationOnly &&
    !(
      (terminalData.status === 'cancelled' || terminalData.status === 'interrupted') &&
      terminalData.stopReason === 'aborted'
    )
  )
    throw new WorkerFinalStatusRefusal(
      'worker_control_lease_not_live',
      'A closing cancelled Turn accepts only a cancellation or interruption final with aborted StopReason.',
      403
    );
  const finalSequence = acceptWorkerControlSequence(db, {
    lineage: input.lineage,
    operation: 'final_status',
    sequence,
    fingerprint: canonicalJsonText({ ...terminalData, lineage: input.lineage, sequence }),
  });
  if (finalSequence.status !== 'accepted')
    throw new WorkerFinalStatusRefusal(finalSequence.code, finalSequence.message, 409);
  const event = buildWorkerCanonicalTerminalEventRecord({
    data: terminalData,
    lineage: input.lineage,
    sequence,
  });
  const eventSequence = acceptWorkerControlSequence(db, {
    lineage: input.lineage,
    operation: 'event_append',
    sequence,
    fingerprint: canonicalJsonText(event),
  });
  if (eventSequence.status !== 'accepted')
    throw new WorkerFinalStatusRefusal(eventSequence.code, eventSequence.message, 409);
  if (resolution.replayOnly && (!finalSequence.duplicate || !eventSequence.duplicate))
    throw new WorkerFinalStatusRefusal(
      'worker_control_lease_not_live',
      'A releasing lease accepts only an exact final-status replay.',
      403
    );
  writeWorkerControlAcceptedRecord(db, {
    acceptedAt: eventAcceptedAt,
    lineage: input.lineage,
    operation: 'event_append',
    record: event,
    recordKey: String(sequence),
    sequence,
  });
  if (!finalSequence.duplicate)
    writeWorkerControlAcceptedRecord(db, {
      acceptedAt,
      lineage: input.lineage,
      operation: 'final_status',
      recordKey: String(sequence),
      sequence,
      record: {
        acceptedAt,
        ...(terminalData.diagnostics ? { diagnostics: terminalData.diagnostics } : {}),
        evidenceManifestDigests: terminalData.evidenceManifestDigests,
        sequence,
        status: terminalData.status,
        stopReason: terminalData.stopReason,
      },
    });
  if (!resolution.replayOnly) {
    const live = resolveNanoHostAttemptTokenBinding(db, binding);
    if (live.status === 'accepted')
      markSchedulerExecutionAttemptClosing(db, {
        attemptId: live.attempt.attemptId,
        cause: 'worker-final-status',
      });
    else if (
      live.reason !== 'attempt-not-live' ||
      resolveWorkerControlFinalStatusTokenBinding(db, binding).status !== 'accepted'
    )
      refuseBinding(live.reason);
  }
  return {
    finalStatusDuplicate: finalSequence.duplicate,
    eventDuplicate: eventSequence.duplicate,
    nextFinalStatusSequence: finalSequence.nextExpectedSequence,
    nextEventSequence: eventSequence.nextExpectedSequence,
  };
}

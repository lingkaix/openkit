import { timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { canonicalJsonText } from '@openkit/protocol';
import { buildWorkerCanonicalTerminalEventRecord } from '@openkit/worker-protocol';
import type Database from 'better-sqlite3';
import { markSchedulerExecutionAttemptClosing } from '../runtime/execution-attempt-records.js';
import { resolveNanoHostAttemptTokenBinding } from '../runtime/nanohost-attempt-records.js';
import {
  getWorkerControlAcceptedFinalStatus,
  hasPendingWorkerCancellationFinal,
  resolveWorkerControlFinalStatusTokenBinding,
  writeWorkerControlAcceptedRecord,
} from '../runtime/worker-control-records.js';
import { acceptWorkerControlSequence } from '../runtime/worker-control-sequences.js';
import {
  assertControlProductWriter,
  ControlProductPreconditionError,
} from './control-store-product-records.js';
import type { CoreDb } from './db.js';
import {
  type NanoHostWorkerCoordinates,
  type NanoHostWorkerFinalDecision,
  nanoHostWorkerFinalDecisionFingerprint,
} from './nanohost-submitted-lease.js';
import { inspectNanoHostWorkerBinding } from './nanohost-worker-binding.js';
import {
  type ControlWorkerFinalStatusCommand,
  type ControlWorkerFinalStatusInput,
  type ControlWorkerFinalStatusPayload,
  ControlWorkerFinalStatusPayloadSchema,
  type ControlWorkerFinalStatusResult,
  WorkerFinalStatusRefusal,
} from './worker-control-final-status-codecs.js';

/** Completes the exact decided final or the exact pair of previously retained Native records. */
function applyAdmittedNanoHostWorkerFinalStatus(
  sqlite: Database.Database,
  original: NanoHostWorkerCoordinates,
  input: ControlWorkerFinalStatusCommand,
  decision: NanoHostWorkerFinalDecision | null
): ControlWorkerFinalStatusResult {
  assertControlProductWriter(sqlite);
  if (
    !decision ||
    (decision.kind !== 'decided' &&
      decision.kind !== 'cancellation-decided' &&
      decision.kind !== 'replay') ||
    !isDeepStrictEqual(decision.grant, original.lease.grant) ||
    decision.fingerprint !== nanoHostWorkerFinalDecisionFingerprint(input)
  )
    throw new ControlProductPreconditionError();

  const payload = ControlWorkerFinalStatusPayloadSchema.parse({
    ...input.payload,
    acceptedAt: decision.acceptedAt,
    eventAcceptedAt: decision.eventAcceptedAt,
  });
  if (typeof input.tokenHash !== 'string') refuseBinding('binding-not-found');
  const native = inspectNanoHostWorkerBinding(sqlite, original, {
    lineage: input.lineage,
    sandboxBindingRef: input.sandboxBindingRef,
    tokenHash: input.tokenHash,
    tokenFamily: 'worker-control',
  });
  if (native.status === 'rejected') refuseBinding(native.reason);
  const settled = getWorkerControlAcceptedFinalStatus({ sqlite }, input.lineage);
  const replayOnly = decision.kind === 'replay' || settled !== null;
  if (
    !replayOnly &&
    (!native.currentPlacement ||
      native.attempt.phase !== 'closing' ||
      native.attempt.fenceRef !== null ||
      native.proof.recoveryState !== null ||
      native.proof.heartbeatDeadline <= payload.acceptedAt ||
      original.lease.grant.deadline <= payload.acceptedAt ||
      (decision.kind === 'decided'
        ? native.attempt.terminalCause !== 'worker-final-status'
        : !hasPendingWorkerCancellationFinal(native.attempt, payload.acceptedAt)))
  )
    refuseBinding('attempt-not-live');
  if (replayOnly) {
    const { lineage } = input;
    const eventClock = sqlite
      .prepare(`SELECT accepted_at FROM worker_control_records
      WHERE workspace_id=? AND thread_id=? AND turn_id=? AND agent_session_id=?
        AND package_snapshot_id=? AND request_id IS ? AND operation='event_append' AND record_key=?`)
      .pluck()
      .get(
        lineage.workspaceId,
        lineage.threadId,
        lineage.turnId,
        lineage.agentSessionId,
        lineage.packageSnapshotId,
        lineage.requestId ?? null,
        String(payload.sequence)
      );
    if (settled?.acceptedAt !== payload.acceptedAt || eventClock !== payload.eventAcceptedAt)
      throw new WorkerFinalStatusRefusal(
        'worker_control_lease_not_live',
        'A releasing lease accepts only an exact final-status replay.',
        403
      );
  }

  return sqlite.transaction(() =>
    settleNanoHostWorkerFinalRecords(sqlite, input.lineage, payload, {
      replayOnly,
      cancellationOnly: !replayOnly && decision.kind === 'cancellation-decided',
    })
  )();
}

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
  ...args:
    | [db: CoreDb, input: ControlWorkerFinalStatusInput, content?: ArrayBuffer | undefined]
    | [
        admitted: {
          readonly sqlite: Database.Database;
          readonly original: NanoHostWorkerCoordinates;
          readonly input: ControlWorkerFinalStatusCommand;
          readonly decision: NanoHostWorkerFinalDecision | null;
        },
      ]
): ControlWorkerFinalStatusResult {
  if (args.length === 1) {
    const { sqlite, original, input, decision } = args[0];
    return applyAdmittedNanoHostWorkerFinalStatus(sqlite, original, input, decision);
  }
  const [db, input, content] = args;
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
  const result = settleNanoHostWorkerFinalRecords(db.sqlite, input.lineage, payload, resolution);
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
  return result;
}

/** Settles both exact original final fingerprints and records on the admitted Native writer.
 * The caller supplies the first deciding Core ACK or the original verified replay decision.
 */
function settleNanoHostWorkerFinalRecords(
  sqlite: Database.Database,
  lineage: ControlWorkerFinalStatusInput['lineage'],
  payload: ControlWorkerFinalStatusPayload,
  resolution: { readonly replayOnly: boolean; readonly cancellationOnly?: boolean }
): ControlWorkerFinalStatusResult {
  assertControlProductWriter(sqlite);
  const owner = { sqlite };
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
  const finalSequence = acceptWorkerControlSequence(owner, {
    lineage: lineage,
    operation: 'final_status',
    sequence,
    fingerprint: canonicalJsonText({ ...terminalData, lineage: lineage, sequence }),
  });
  if (finalSequence.status !== 'accepted')
    throw new WorkerFinalStatusRefusal(finalSequence.code, finalSequence.message, 409);
  const event = buildWorkerCanonicalTerminalEventRecord({
    data: terminalData,
    lineage: lineage,
    sequence,
  });
  const eventSequence = acceptWorkerControlSequence(owner, {
    lineage: lineage,
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
  writeWorkerControlAcceptedRecord(owner, {
    acceptedAt: eventAcceptedAt,
    lineage: lineage,
    operation: 'event_append',
    record: event,
    recordKey: String(sequence),
    sequence,
  });
  if (!finalSequence.duplicate)
    writeWorkerControlAcceptedRecord(owner, {
      acceptedAt,
      lineage: lineage,
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
  return {
    finalStatusDuplicate: finalSequence.duplicate,
    eventDuplicate: eventSequence.duplicate,
    nextFinalStatusSequence: finalSequence.nextExpectedSequence,
    nextEventSequence: eventSequence.nextExpectedSequence,
  };
}

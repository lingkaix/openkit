import * as records from '../runtime/execution-attempt-records.js';
import {
  armNanoHostAttemptReconnect,
  bindNanoHostAttemptPreparation,
  markNanoHostAttemptNeedsEvidence,
} from '../runtime/nanohost-attempt-records.js';
import { writeWorkerControlAcceptedRecord } from '../runtime/worker-control-records.js';
import { requireSchedulerAdmissionEntry } from '../scheduler-records.js';
import { ControlProductPreconditionError } from './control-store-product-records.js';
import { assertControlProductWriter } from './control-store-products.js';
import type { CoreDb } from './db.js';
import type { ControlExecutionAttemptInput } from './execution-attempt-codecs.js';

/** Applies one original attempt tuple within the existing Core savepoint and FULL acknowledgement. */
export function applyControlExecutionAttempt(
  db: CoreDb,
  input: ControlExecutionAttemptInput,
  content?: ArrayBuffer
) {
  assertControlProductWriter(db.sqlite);
  const now =
    'observedAt' in input && input.observedAt !== undefined ? { now: () => input.observedAt! } : {};
  switch (input.kind) {
    case 'native-preparation':
      bindNanoHostAttemptPreparation(db, { ...input, ...now });
      return records.requireSchedulerExecutionAttempt(db, input.attemptId);
    case 'native-reconnect-arm':
      armNanoHostAttemptReconnect(db, { ...input, ...now });
      return records.requireSchedulerExecutionAttempt(db, input.attemptId);
    case 'native-needs-evidence':
      markNanoHostAttemptNeedsEvidence(db, input.attemptId);
      return records.requireSchedulerExecutionAttempt(db, input.attemptId);

    case 'simulator-final': {
      const attempt = records.requireSchedulerExecutionAttempt(db, input.attemptId);
      const lineage = input.lineage;
      if (
        attempt.workspaceId !== lineage.workspaceId ||
        attempt.threadId !== lineage.threadId ||
        attempt.turnId !== lineage.turnId ||
        attempt.agentSessionId !== lineage.agentSessionId ||
        attempt.inputRef !== lineage.packageSnapshotId
      )
        throw new ControlProductPreconditionError();
      writeWorkerControlAcceptedRecord(db, {
        acceptedAt: input.acceptedAt,
        lineage,
        operation: 'final_status',
        record: { sequence: 1, status: 'completed', stopReason: 'completed' },
        recordKey: '1',
        sequence: 1,
      });
      return attempt;
    }

    case 'create': {
      if (!content) throw new ControlProductPreconditionError();
      // The old method consumed only this address and expected backend from its input entry;
      // all admission, identity and current authority facts are reread inside this same owner.
      const entry = requireSchedulerAdmissionEntry(db, input.queueEntryId);
      return records.createSchedulerExecutionAttempt(db, {
        entry: { ...entry, backendId: input.backendId },
        preparationInput: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content)),
        ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
        ...now,
      });
    }
    case 'bind-session':
      return records.bindSchedulerExecutionAttemptSession(db, {
        attemptId: input.attemptId,
        agentSessionId: input.agentSessionId,
        ...now,
      });
    case 'finalize-input':
      return records.finalizeSchedulerExecutionAttemptInput(db, {
        attemptId: input.attemptId,
        inputRef: input.inputRef,
        bindingRef: input.bindingRef,
        ...now,
      });
    case 'record-operation':
      return records.recordSchedulerExecutionOperation(db, {
        attemptId: input.attemptId,
        operationId: input.operationId,
        ...(input.submission === undefined ? {} : { submission: input.submission }),
        ...now,
      });
    case 'observe':
      return records.acceptSchedulerExecutionObservation(db, input.observation);
    case 'closing':
      return records.markSchedulerExecutionAttemptClosing(db, {
        attemptId: input.attemptId,
        cause: input.cause,
        ...(input.outcomeRef === undefined ? {} : { outcomeRef: input.outcomeRef }),
        ...now,
      });
    case 'close-without-effects':
      return records.closeSchedulerExecutionAttemptWithoutEffects(db, {
        attemptId: input.attemptId,
        noOutstandingEffects: true,
        cause: input.cause,
        ...(input.requeue === undefined ? {} : { requeue: input.requeue }),
        ...now,
      });
    case 'close-with-fence':
      return records.closeSchedulerExecutionAttemptWithFence(db, {
        correlation: input.correlation,
        proof: input.proof,
        fenceRef: input.fenceRef,
        ...now,
      });
  }
}

/** Uses only the actual admission/attempt's Turn and session for existing predecessor-failure ordering. */
export function controlExecutionAttemptLanes(
  db: CoreDb,
  input: ControlExecutionAttemptInput
): ReadonlySet<string> {
  const lanes = new Set<string>();
  if (input.kind === 'observe' && input.observation === null) return lanes;
  const row =
    input.kind === 'create'
      ? requireSchedulerAdmissionEntry(db, input.queueEntryId)
      : records.requireSchedulerExecutionAttempt(
          db,
          input.kind === 'observe'
            ? input.observation!.attemptId
            : input.kind === 'close-with-fence'
              ? input.correlation.attemptId
              : input.attemptId
        );
  lanes.add(row.turnId);
  if ('agentSessionId' in row && row.agentSessionId) lanes.add(`session:${row.agentSessionId}`);
  if (input.kind === 'bind-session') lanes.add(`session:${input.agentSessionId}`);
  return lanes;
}

import type Database from 'better-sqlite3';
import { requireSchedulerExecutionAttempt } from '../runtime/execution-attempt-records.js';
import { getWorkerBackendSession } from '../runtime/worker-backend-session-records.js';
import { writeWorkerControlAcceptedRecord } from '../runtime/worker-control-records.js';
import { requireSchedulerExecutionAttemptAdmissionContext } from '../scheduler-records.js';
import { commandInputHash } from './control-store-input.js';
import {
  assertControlProductWriter,
  ControlProductPreconditionError,
} from './control-store-product-records.js';
import type { CoreDb } from './db.js';
import type { ControlExecutionAttemptCommand } from './execution-attempt-codecs.js';

/** The internal fixture has synthetic backend ownership and no physical route authority. */
export function applyNanoHostSimulatorFinalStatus(
  sqlite: Database.Database,
  coreDb: CoreDb,
  input: Extract<ControlExecutionAttemptCommand, { kind: 'simulator-final' }>
) {
  assertControlProductWriter(sqlite);
  if (process.env.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR !== '1')
    throw new ControlProductPreconditionError();
  const attempt = requireSchedulerExecutionAttempt(coreDb, input.attemptId);
  const admission = requireSchedulerExecutionAttemptAdmissionContext(coreDb, attempt.attemptId);
  const backend = getWorkerBackendSession({ sqlite }, attempt.attemptId);
  const { lineage } = input;
  if (
    !backend ||
    backend.backendSessionId !== `self-check_${lineage.packageSnapshotId}` ||
    backend.packageSnapshotId !== attempt.inputRef ||
    backend.sandboxBindingRef !== attempt.bindingRef ||
    backend.workspaceHandoffState !== 'complete' ||
    backend.state !== 'materialized' ||
    attempt.workspaceId !== lineage.workspaceId ||
    attempt.threadId !== lineage.threadId ||
    attempt.turnId !== lineage.turnId ||
    attempt.agentSessionId !== lineage.agentSessionId ||
    attempt.inputRef !== lineage.packageSnapshotId ||
    (lineage.requestId ?? null) !== (admission.requestId ?? null) ||
    attempt.phase !== 'open' ||
    attempt.disposition !== 'accepted' ||
    attempt.operationId !==
      commandInputHash({
        attemptId: attempt.attemptId,
        inputRef: attempt.inputRef,
        operation: 'submit',
      })
  )
    throw new ControlProductPreconditionError();
  writeWorkerControlAcceptedRecord(
    { sqlite },
    {
      acceptedAt: input.acceptedAt,
      lineage,
      operation: 'final_status',
      record: { sequence: 1, status: 'completed', stopReason: 'completed' },
      recordKey: '1',
      sequence: 1,
    }
  );
  return attempt;
}

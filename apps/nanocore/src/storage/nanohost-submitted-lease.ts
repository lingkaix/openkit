import { requireSchedulerExecutionAttempt } from '../runtime/execution-attempt-records.js';
import { readKernelSchedulerGrantInDb } from '../runtime/execution-journal.js';
import { requireSchedulerExecutionAttemptAdmissionContext } from '../scheduler-records.js';
import { commandInputHash } from './control-store-input.js';
import type { CoreDb } from './db.js';
import type { NanoHostRecoveryLease, SubmittedNanoHostGrant } from './nanohost-recovery-native.js';
import type { ControlWorkerFinalStatusCommand } from './worker-control-final-status-codecs.js';

/** Original Core correlation to carry from the deciding connection into the Native savepoint. */
export interface NanoHostWorkerCoordinates {
  readonly lease: NanoHostRecoveryLease;
  readonly requestId: string | null;
}

export function readRetainedNanoHostSubmission(
  coreDb: CoreDb,
  attemptId: string
): NanoHostWorkerCoordinates | null {
  const attempt = requireSchedulerExecutionAttempt(coreDb, attemptId);
  if (
    attempt.backendId !== 'nanohost' ||
    !attempt.agentSessionId ||
    !attempt.inputRef ||
    !attempt.bindingRef ||
    !attempt.deadline ||
    attempt.operationId !==
      commandInputHash({ attemptId, inputRef: attempt.inputRef, operation: 'submit' })
  )
    return null;
  const grant = readKernelSchedulerGrantInDb(
    coreDb,
    { owner: { kind: 'server' }, executionId: attemptId },
    attempt.operationId
  );
  if (
    !grant?.deadline ||
    grant.backendId !== attempt.backendId ||
    grant.attemptId !== attemptId ||
    grant.turnId !== attempt.turnId ||
    grant.operationId !== attempt.operationId ||
    grant.inputRef !== attempt.inputRef ||
    grant.bindingRef !== attempt.bindingRef ||
    grant.deadline !== attempt.deadline
  )
    return null;
  const admission = requireSchedulerExecutionAttemptAdmissionContext(coreDb, attemptId);
  if (admission.backendId !== grant.backendId) return null;
  return {
    requestId: admission.requestId ?? null,
    lease: {
      grant,
      attempt: {
        ...attempt,
        agentSessionId: attempt.agentSessionId,
        inputRef: attempt.inputRef,
        bindingRef: attempt.bindingRef,
      },
    },
  };
}

/** Authenticated by the Core writer under the original submitted grant before carriage. */
export interface NanoHostWorkerFinalDecision {
  readonly kind: 'decided' | 'cancellation-decided' | 'replay';
  readonly grant: SubmittedNanoHostGrant;
  readonly fingerprint: string;
  readonly acceptedAt: string;
  readonly eventAcceptedAt: string;
}

/** The Core receipt binds this exact semantic final, including its Worker sequence. */
export function nanoHostWorkerFinalDecisionFingerprint(
  input: ControlWorkerFinalStatusCommand
): string {
  return commandInputHash({
    lineage: input.lineage,
    sandboxBindingRef: input.sandboxBindingRef,
    tokenHash: input.tokenHash,
    sequence: input.payload.sequence,
    terminalData: input.payload.terminalData,
  });
}

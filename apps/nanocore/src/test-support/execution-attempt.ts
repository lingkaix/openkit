import {
  bindSchedulerExecutionAttemptSession,
  createSchedulerExecutionAttempt,
  recordSchedulerExecutionOperation,
  requireSchedulerExecutionAttempt,
} from '../runtime/execution-attempt-records.js';
import { bindNanoHostAttemptPreparation } from '../runtime/nanohost-attempt-records.js';
import type { SchedulerAdmissionEntryRecord } from '../scheduler-records.js';
import type { CoreDb } from '../storage/db.js';

/**
 * Establishes exact prepared Native authority for tests below the dispatcher.
 * The caller supplies an already-authorized admission; this fixture grants no Workspace authority.
 * @param coreDb Database owning the exact admission and attempt.
 * @param input Explicit product correlation and optional already-submitted operation.
 * @returns The prepared or submitted attempt, with no fabricated backend acceptance.
 */
export function recordTestExecutionAttempt(
  coreDb: CoreDb,
  input: {
    readonly entry: SchedulerAdmissionEntryRecord;
    readonly attemptId: string;
    readonly agentSessionId: string;
    readonly inputRef: string;
    readonly bindingRef: string;
    readonly sessionCompatibilityKey: string;
    readonly now: () => string;
    readonly operationId?: string;
  }
) {
  const attempt = createSchedulerExecutionAttempt(coreDb, {
    entry: input.entry,
    attemptId: input.attemptId,
    preparationInput: { admission: input.entry },
    now: input.now,
  });
  bindSchedulerExecutionAttemptSession(coreDb, {
    attemptId: attempt.attemptId,
    agentSessionId: input.agentSessionId,
    now: input.now,
  });
  bindNanoHostAttemptPreparation(coreDb, {
    attemptId: attempt.attemptId,
    agentSessionId: input.agentSessionId,
    inputRef: input.inputRef,
    bindingRef: input.bindingRef,
    sessionCompatibilityKey: input.sessionCompatibilityKey,
    now: input.now,
  });
  return input.operationId
    ? recordSchedulerExecutionOperation(coreDb, {
        attemptId: attempt.attemptId,
        operationId: input.operationId,
        submission: true,
        now: input.now,
      })
    : requireSchedulerExecutionAttempt(coreDb, attempt.attemptId);
}

import { currentSchedulerAdmissionWorkspaceAuthority } from '../auth/operation-authorizer.js';
import type { FsStore } from '../lib/store.js';
import { requireSchedulerAdmissionEntry } from '../scheduler-records.js';
import type { CoreDb } from '../storage/db.js';
import {
  acceptSchedulerExecutionObservation,
  closeSchedulerExecutionAttemptWithoutEffects,
  listOpenSchedulerExecutionAttempts,
  markSchedulerExecutionAttemptClosing,
  requireSchedulerExecutionAttempt,
  type SchedulerExecutionAttemptRecord,
  schedulerExecutionCorrelation,
} from './execution-attempt-records.js';
import type { ExecutionBackend } from './execution-backend.js';
import { logRecoveryMaintenanceFailure } from './scheduler-attempt-maintenance-service.js';

/** Product outcome established by its existing recovery owner. */
export type RecoveredTurnStatus = 'completed' | 'failed' | 'interrupted' | 'cancelled' | 'missing';
/** Exact preparation lineage; a queued or failed pre-effect Turn may have no AgentSession. */
export interface PreAnchorRecoveryContext {
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly agentSessionId: string | null;
  readonly packageSnapshotId: string | null;
}
/** Generic restart dependencies contain no native liveness or placement policy. */
export interface RunSchedulerRestartRecoveryInput {
  readonly store?: FsStore;
  readonly executionBackend: ExecutionBackend;
  readonly isTurnExecutionActive?: (turnId: string) => boolean;
  readonly now?: () => string;
  readonly projectRecoveredTurn: (
    subject: PreAnchorRecoveryContext
  ) => Promise<{ readonly status: RecoveredTurnStatus }>;
}
/** Read-only Core startup classification never retries an unknown effect. */
export async function runSchedulerRestartRecovery(
  coreDb: CoreDb,
  input: RunSchedulerRestartRecoveryInput
): Promise<{ readonly preparationFailedAttemptIds: string[] }> {
  const preparationFailedAttemptIds: string[] = [];
  for (const attempt of listOpenSchedulerExecutionAttempts(coreDb)) {
    if (attempt.backendId !== input.executionBackend.id)
      throw new Error('Retained attempt names an unavailable backend.');
    if (attempt.operationId !== null) continue;
    closeSchedulerExecutionAttemptWithoutEffects(coreDb, {
      attemptId: attempt.attemptId,
      noOutstandingEffects: true,
      cause: 'restart-before-effects',
      ...(input.now ? { now: input.now } : {}),
    });
    await input.projectRecoveredTurn({ ...attempt, packageSnapshotId: attempt.inputRef });
    preparationFailedAttemptIds.push(attempt.attemptId);
  }
  return { preparationFailedAttemptIds };
}
/** After listen, inspect the original operation and revoke expired authority without replay. */
export async function runSchedulerRecoveryMaintenance(
  coreDb: CoreDb,
  input: RunSchedulerRestartRecoveryInput
): Promise<void> {
  const errors: unknown[] = [];
  const timestamp = input.now?.() ?? new Date().toISOString();
  for (const attempt of listOpenSchedulerExecutionAttempts(coreDb)) {
    try {
      if (attempt.backendId !== input.executionBackend.id)
        throw new Error('Attempt backend identity changed.');
      const entry = requireSchedulerAdmissionEntry(coreDb, attempt.queueEntryId);
      const revoked = !currentSchedulerAdmissionWorkspaceAuthority(
        coreDb,
        entry,
        'runtime.launch',
        true
      );
      const expired = attempt.deadline !== null && attempt.deadline <= timestamp;
      if (attempt.phase === 'open' && (revoked || expired)) {
        const closing = markSchedulerExecutionAttemptClosing(coreDb, {
          attemptId: attempt.attemptId,
          cause: revoked ? 'authority-revoked' : 'execution-deadline',
          ...(input.now ? { now: input.now } : {}),
        });
        if (!closing.operationId) {
          closeSchedulerExecutionAttemptWithoutEffects(coreDb, {
            attemptId: closing.attemptId,
            noOutstandingEffects: true,
            cause: closing.terminalCause!,
            ...(input.now ? { now: input.now } : {}),
          });
          await input.projectRecoveredTurn({ ...closing, packageSnapshotId: closing.inputRef });
        } else
          acceptSchedulerExecutionObservation(
            coreDb,
            await input.executionBackend.cancel(schedulerExecutionCorrelation(closing))
          );
      }
      if (!attempt.operationId) continue;
      acceptSchedulerExecutionObservation(
        coreDb,
        await input.executionBackend.inspect(schedulerExecutionCorrelation(attempt))
      );
    } catch (error) {
      logRecoveryMaintenanceFailure('attempt-recovery', attempt);
      errors.push(error);
    }
  }
  // A crash may leave definite no-effect closure ahead of product publication. Retry only
  // that existing publication owner, without requesting a never-published AEP snapshot.
  const failures = coreDb.sqlite
    .prepare(`SELECT attempt_id AS attemptId, workspace_id AS workspaceId, thread_id AS threadId,
      turn_id AS turnId, agent_session_id AS agentSessionId FROM scheduler_execution_attempts
    WHERE phase = 'closed' AND disposition = 'not_accepted' AND operation_id IS NULL
      AND terminal_cause IN ('restart-before-effects', 'authority-revoked', 'execution-deadline')
    ORDER BY rowid`)
    .all() as Array<
    Pick<
      SchedulerExecutionAttemptRecord,
      'attemptId' | 'workspaceId' | 'threadId' | 'turnId' | 'agentSessionId'
    >
  >;
  for (const failure of failures) {
    try {
      const attempt = requireSchedulerExecutionAttempt(coreDb, failure.attemptId);
      if (input.isTurnExecutionActive?.(attempt.turnId)) continue;
      await input.projectRecoveredTurn({ ...attempt, packageSnapshotId: attempt.inputRef });
    } catch (error) {
      logRecoveryMaintenanceFailure('failed-publication', failure);
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, 'Execution attempt recovery requires inspection.');
}

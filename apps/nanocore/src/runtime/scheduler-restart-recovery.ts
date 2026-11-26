import { currentSchedulerAdmissionWorkspaceAuthority } from '../auth/operation-authorizer.js';
import type { BootPhaseOutcome } from '../bootstrap/phases.js';
import { isScopeAdmitted } from '../bootstrap/readiness.js';
import type { FsStore } from '../lib/store.js';
import { requireSchedulerAdmissionEntry } from '../scheduler-records.js';
import type { CoreDb } from '../storage/db.js';
import {
  acceptSchedulerExecutionObservation,
  closeSchedulerExecutionAttemptWithoutEffects,
  EXECUTION_ATTEMPT_BUDGET_MS,
  listOpenSchedulerExecutionAttempts,
  markSchedulerExecutionAttemptClosing,
  requireSchedulerExecutionAttempt,
  type SchedulerExecutionAttemptRecord,
  schedulerExecutionCorrelation,
} from './execution-attempts.js';
import type { ExecutionBackendObservation, ExecutionBackendPort } from './execution-backend.js';
import { logRecoveryMaintenanceFailure } from './scheduler-attempt-maintenance-service.js';
import { releaseExpiredSchedulerPreparation } from './scheduler-dispatch-loop.js';

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
  readonly executionBackend: ExecutionBackendPort;
  readonly isTurnExecutionActive?: (turnId: string) => boolean;
  readonly now?: () => string;
  readonly projectRecoveredTurn: (
    subject: PreAnchorRecoveryContext
  ) => Promise<{ readonly status: RecoveredTurnStatus }>;
}
/** Effect-free startup classification isolates unresolved attempts for post-listen maintenance. */
export async function runSchedulerRestartRecovery(
  coreDb: CoreDb,
  input: RunSchedulerRestartRecoveryInput
): Promise<{
  readonly preparationFailedAttemptIds: string[];
  readonly failedAttemptIds: string[];
}> {
  const preparationFailedAttemptIds: string[] = [];
  const failedAttemptIds: string[] = [];
  for (const attempt of listOpenSchedulerExecutionAttempts(coreDb)) {
    if (!isScopeAdmitted(coreDb.dataRoot, 'workspace', attempt.workspaceId)) continue;
    try {
      if (attempt.backendId !== input.executionBackend.id)
        throw new Error('Retained attempt names an unavailable backend.');
      if (attempt.operationId !== null) continue;
      await closeSchedulerExecutionAttemptWithoutEffects(coreDb, {
        attemptId: attempt.attemptId,
        noOutstandingEffects: true,
        cause: 'restart-before-effects',
        ...(input.now ? { now: input.now } : {}),
      });
      await input.projectRecoveredTurn({ ...attempt, packageSnapshotId: attempt.inputRef });
      preparationFailedAttemptIds.push(attempt.attemptId);
    } catch {
      // Proved no-effect closure remains valid if publication fails; maintenance retries it.
      logRecoveryMaintenanceFailure('attempt-recovery', attempt);
      failedAttemptIds.push(attempt.attemptId);
    }
  }
  return { preparationFailedAttemptIds, failedAttemptIds };
}

/** Reports held classification faults without blocking unrelated product work or duplicating an attempt. */
export function schedulerRestartRecoveryOutcome(
  failedAttemptIds: readonly string[],
  checkpointRecoveryFailures: number
): BootPhaseOutcome {
  const failedAttemptCount = new Set(failedAttemptIds).size;
  if (failedAttemptCount === 0 && checkpointRecoveryFailures === 0) return { status: 'ok' };
  return {
    status: 'degraded',
    reason: {
      code:
        failedAttemptCount > 0
          ? 'scheduler.attempt_recovery_failed'
          : 'scheduler.checkpoint_recovery_required',
      message:
        failedAttemptCount > 0
          ? `${failedAttemptCount} execution attempt(s) and ${checkpointRecoveryFailures} worker checkpoint recovery attempt(s) require inspection.`
          : `${checkpointRecoveryFailures} worker checkpoint recovery attempt(s) require inspection.`,
      blocks: [],
    },
  };
}

/** Rejects replies for another attempt before the writer checks the remaining correlation. */
async function acceptRecoveryObservation(
  coreDb: CoreDb,
  requestedAttemptId: string,
  observation: ExecutionBackendObservation | null
): Promise<void> {
  if (observation && observation.attemptId !== requestedAttemptId) return;
  await acceptSchedulerExecutionObservation(coreDb, observation);
}

/** After listen, inspect the original operation and revoke expired authority without replay. */
export async function runSchedulerRecoveryMaintenance(
  coreDb: CoreDb,
  input: RunSchedulerRestartRecoveryInput
): Promise<void> {
  const errors: unknown[] = [];
  const timestamp = input.now?.() ?? new Date().toISOString();
  for (const attempt of listOpenSchedulerExecutionAttempts(coreDb)) {
    if (!isScopeAdmitted(coreDb.dataRoot, 'workspace', attempt.workspaceId)) continue;
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
      const preparationExpired =
        attempt.deadline === null &&
        Date.parse(timestamp) - Date.parse(attempt.createdAt) >= EXECUTION_ATTEMPT_BUDGET_MS;
      const executionExpired = attempt.deadline !== null && attempt.deadline <= timestamp;
      let current = attempt;
      if (attempt.phase === 'open' && (revoked || executionExpired || preparationExpired)) {
        const preparationFence = preparationExpired && !revoked;
        current = await markSchedulerExecutionAttemptClosing(coreDb, {
          attemptId: attempt.attemptId,
          cause: revoked
            ? 'authority-revoked'
            : preparationFence
              ? 'preparation-deadline'
              : 'execution-deadline',
          ...(preparationFence ? { requireUnsubmitted: true } : {}),
          ...(input.now ? { now: input.now } : {}),
        });
        // The native submission intent might have won while the expiry check awaited the writer.
        if (preparationFence && current.terminalCause !== 'preparation-deadline') continue;
        if (current.operationId)
          await acceptRecoveryObservation(
            coreDb,
            current.attemptId,
            await input.executionBackend.cancel(schedulerExecutionCorrelation(current))
          );
        else if (!preparationFence) {
          await closeSchedulerExecutionAttemptWithoutEffects(coreDb, {
            attemptId: current.attemptId,
            noOutstandingEffects: true,
            cause: current.terminalCause!,
            ...(input.now ? { now: input.now } : {}),
          });
          await input.projectRecoveredTurn({ ...current, packageSnapshotId: current.inputRef });
        }
      }
      if (current.operationId)
        await acceptRecoveryObservation(
          coreDb,
          current.attemptId,
          await input.executionBackend.inspect(schedulerExecutionCorrelation(current))
        );
      else if (current.phase === 'closing' && current.terminalCause === 'preparation-deadline')
        await closeSchedulerExecutionAttemptWithoutEffects(coreDb, {
          attemptId: current.attemptId,
          noOutstandingEffects: true,
          cause: 'preparation-deadline',
          ...(input.now ? { now: input.now } : {}),
        });
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
      AND terminal_cause IN ('restart-before-effects', 'authority-revoked', 'execution-deadline', 'preparation-deadline')
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
      if (attempt.backendId !== input.executionBackend.id) continue;
      // Readback also releases a waiter whose native close committed with a lost reply.
      if (attempt.terminalCause === 'preparation-deadline')
        releaseExpiredSchedulerPreparation(coreDb, attempt.attemptId);
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

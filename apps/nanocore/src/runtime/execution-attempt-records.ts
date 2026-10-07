import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { currentSchedulerAdmissionWorkspaceAuthority } from '../auth/operation-authorizer.js';
import {
  requireSchedulerAdmissionEntry,
  type SchedulerAdmissionEntryRecord,
} from '../scheduler-records.js';
import type { CoreDb } from '../storage/db.js';
import type {
  ExecutionBackendCorrelation,
  ExecutionBackendObservation,
  ExecutionOperationDisposition,
  ExecutionReleaseProof,
} from './execution-backend.js';
import { commandInputHash } from './idempotent-command.js';

/** The production execution authority budget, fixed once at native submission. */
export const EXECUTION_ATTEMPT_BUDGET_MS = 7_200_000;

const AttemptSchema = z.object({
  attemptId: z.string().min(1),
  queueEntryId: z.string().min(1),
  backendId: z.string().min(1),
  workspaceId: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  agentSessionId: z.string().min(1).nullable(),
  preparationInputJson: z.string(),
  inputRef: z.string().min(1).nullable(),
  bindingRef: z.string().min(1).nullable(),
  phase: z.enum(['open', 'closing', 'closed']),
  disposition: z.enum(['not_accepted', 'accepted', 'unknown']),
  operationId: z.string().min(1).nullable(),
  deadline: z.string().datetime().nullable(),
  terminalCause: z.string().nullable(),
  outcomeRef: z.string().nullable(),
  fenceRef: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/** Generic durable attempt projection deliberately excludes NanoHost proof fields. */
export type SchedulerExecutionAttemptRecord = z.infer<typeof AttemptSchema>;

const attemptSelect = `SELECT attempt_id AS attemptId, queue_entry_id AS queueEntryId,
  backend_id AS backendId, workspace_id AS workspaceId, thread_id AS threadId, turn_id AS turnId,
  agent_session_id AS agentSessionId, preparation_input_json AS preparationInputJson,
  input_ref AS inputRef, binding_ref AS bindingRef, phase, disposition, operation_id AS operationId,
  deadline, terminal_cause AS terminalCause, outcome_ref AS outcomeRef, fence_ref AS fenceRef,
  created_at AS createdAt, updated_at AS updatedAt FROM scheduler_execution_attempts`;

/** Loads exact current authority and refuses unknown core values rather than guessing a phase. */
export function requireSchedulerExecutionAttempt(
  coreDb: CoreDb,
  attemptId: string
): SchedulerExecutionAttemptRecord {
  return AttemptSchema.parse(
    coreDb.sqlite.prepare(`${attemptSelect} WHERE attempt_id = ?`).get(attemptId)
  );
}

/** Lists exact Turn attempts in creation order; closed history cannot grant new authority. */
export function listSchedulerExecutionAttemptsForTurn(
  coreDb: CoreDb,
  input: { readonly workspaceId: string; readonly threadId: string; readonly turnId: string }
): SchedulerExecutionAttemptRecord[] {
  return coreDb.sqlite
    .prepare(
      `${attemptSelect} WHERE workspace_id = ? AND thread_id = ? AND turn_id = ? ORDER BY rowid`
    )
    .all(input.workspaceId, input.threadId, input.turnId)
    .map((row) => AttemptSchema.parse(row));
}

/** Closed busy refusals contain no execution and cannot compete with the later original-Turn attempt. */
export function isSchedulerExecutionBusyRefusal(attempt: SchedulerExecutionAttemptRecord): boolean {
  return (
    attempt.phase === 'closed' &&
    attempt.disposition === 'not_accepted' &&
    attempt.operationId === null &&
    attempt.terminalCause === 'backend-busy'
  );
}

/** Enumerates held exclusion for the existing restart and maintenance owner. */
export function listOpenSchedulerExecutionAttempts(
  coreDb: CoreDb
): SchedulerExecutionAttemptRecord[] {
  return coreDb.sqlite
    .prepare(`${attemptSelect} WHERE phase <> 'closed' ORDER BY rowid`)
    .all()
    .map((row) => AttemptSchema.parse(row));
}

/** Acquires only the selected entry's product boundaries, before any preparation effect. */
export function createSchedulerExecutionAttempt(
  coreDb: CoreDb,
  input: {
    readonly entry: SchedulerAdmissionEntryRecord;
    readonly attemptId?: string;
    readonly preparationInput: unknown;
    readonly now?: () => string;
  }
): SchedulerExecutionAttemptRecord {
  const timestamp = input.now?.() ?? new Date().toISOString();
  const attemptId = input.attemptId ?? `attempt_${randomUUID()}`;
  return coreDb.sqlite
    .transaction(() => {
      const entry = requireSchedulerAdmissionEntry(coreDb, input.entry.queueEntryId);
      if (
        entry.status !== 'queued' ||
        entry.backendId !== input.entry.backendId ||
        !currentSchedulerAdmissionWorkspaceAuthority(coreDb, entry, 'runtime.launch', true)
      ) {
        throw new Error('The exact queued admission is no longer dispatchable.');
      }
      coreDb.sqlite
        .prepare(`INSERT INTO scheduler_execution_attempts
      (attempt_id, queue_entry_id, backend_id, workspace_id, thread_id, turn_id,
       preparation_input_json, phase, disposition, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 'not_accepted', ?, ?)`)
        .run(
          attemptId,
          entry.queueEntryId,
          entry.backendId,
          entry.workspaceId,
          entry.threadId,
          entry.turnId,
          JSON.stringify(input.preparationInput),
          timestamp,
          timestamp
        );
      const acquired = coreDb.sqlite
        .prepare(
          "UPDATE scheduler_admission_entries SET status = 'admitted' WHERE queue_entry_id = ? AND status = 'queued'"
        )
        .run(entry.queueEntryId);
      if (acquired.changes !== 1)
        throw new Error('Admission ownership changed before preparation.');
      return requireSchedulerExecutionAttempt(coreDb, attemptId);
    })
    .immediate();
}

/** Binds the selected AgentSession conditionally under its unique live-attempt constraint. */
export function bindSchedulerExecutionAttemptSession(
  coreDb: CoreDb,
  input: {
    readonly attemptId: string;
    readonly agentSessionId: string;
    readonly now?: () => string;
  }
): SchedulerExecutionAttemptRecord {
  const attempt = requireSchedulerExecutionAttempt(coreDb, input.attemptId);
  if (
    attempt.phase !== 'open' ||
    (attempt.agentSessionId !== null && attempt.agentSessionId !== input.agentSessionId)
  )
    throw new Error('Attempt AgentSession ownership changed.');
  const updated = coreDb.sqlite
    .prepare(`UPDATE scheduler_execution_attempts SET agent_session_id = ?, updated_at = ?
    WHERE attempt_id = ? AND phase = 'open' AND agent_session_id IS ?`)
    .run(
      input.agentSessionId,
      input.now?.() ?? new Date().toISOString(),
      attempt.attemptId,
      attempt.agentSessionId
    );
  if (updated.changes !== 1) throw new Error('Attempt lost its AgentSession binding race.');
  return requireSchedulerExecutionAttempt(coreDb, attempt.attemptId);
}

/** Publishes the immutable finalized package and compatible binding before native submission. */
export function finalizeSchedulerExecutionAttemptInput(
  coreDb: CoreDb,
  input: {
    readonly attemptId: string;
    readonly inputRef: string;
    readonly bindingRef: string;
    readonly now?: () => string;
  }
): SchedulerExecutionAttemptRecord {
  const attempt = requireSchedulerExecutionAttempt(coreDb, input.attemptId);
  if (
    attempt.phase !== 'open' ||
    !attempt.agentSessionId ||
    (attempt.inputRef && attempt.inputRef !== input.inputRef) ||
    (attempt.bindingRef && attempt.bindingRef !== input.bindingRef)
  )
    throw new Error('Finalized attempt input contradicts its owner.');
  const updated = coreDb.sqlite
    .prepare(`UPDATE scheduler_execution_attempts SET input_ref = ?, binding_ref = ?, updated_at = ?
    WHERE attempt_id = ? AND phase = 'open' AND input_ref IS ? AND binding_ref IS ?`)
    .run(
      input.inputRef,
      input.bindingRef,
      input.now?.() ?? new Date().toISOString(),
      attempt.attemptId,
      attempt.inputRef,
      attempt.bindingRef
    );
  if (updated.changes !== 1) throw new Error('Finalized input lost its attempt ownership race.');
  return requireSchedulerExecutionAttempt(coreDb, attempt.attemptId);
}

/** Records exact possible acceptance before an operation can affect the backend. */
export function recordSchedulerExecutionOperation(
  coreDb: CoreDb,
  input: {
    readonly attemptId: string;
    readonly operationId: string;
    readonly submission?: boolean;
    readonly now?: () => string;
  }
): SchedulerExecutionAttemptRecord {
  if (!input.operationId)
    throw new Error('Backend operation identity is required before an effect.');
  const attempt = requireSchedulerExecutionAttempt(coreDb, input.attemptId);
  const entry = requireSchedulerAdmissionEntry(coreDb, attempt.queueEntryId);
  const timestamp = input.now?.() ?? new Date().toISOString();
  if (
    attempt.phase !== 'open' ||
    !currentSchedulerAdmissionWorkspaceAuthority(coreDb, entry, 'runtime.launch', true)
  )
    throw new Error('Execution authority was revoked before the operation.');
  if (input.submission && (!attempt.agentSessionId || !attempt.inputRef || !attempt.bindingRef))
    throw new Error('Submission has no finalized package or assigned binding.');
  if (attempt.disposition === 'unknown')
    throw new Error('An unknown operation must be inspected or fenced before another effect.');
  if (input.submission && attempt.deadline !== null)
    throw new Error('This attempt already owns a possible submission.');
  const deadline = input.submission
    ? new Date(Date.parse(timestamp) + EXECUTION_ATTEMPT_BUDGET_MS).toISOString()
    : attempt.deadline;
  const updated = coreDb.sqlite
    .prepare(`UPDATE scheduler_execution_attempts SET operation_id = ?, disposition = 'unknown', deadline = ?, updated_at = ?
    WHERE attempt_id = ? AND phase = 'open' AND operation_id IS ? AND deadline IS ?`)
    .run(
      input.operationId,
      deadline,
      timestamp,
      attempt.attemptId,
      attempt.operationId,
      attempt.deadline
    );
  if (updated.changes !== 1) throw new Error('Operation intent lost its attempt ownership race.');
  return requireSchedulerExecutionAttempt(coreDb, attempt.attemptId);
}

/** Returns the original operation identity for inspection, cancellation, or release without replay. */
export function schedulerExecutionCorrelation(
  attempt: SchedulerExecutionAttemptRecord
): ExecutionBackendCorrelation {
  if (!attempt.operationId) throw new Error('Attempt has no outstanding operation identity.');
  return {
    attemptId: attempt.attemptId,
    backendId: attempt.backendId,
    bindingRef: attempt.bindingRef,
    inputRef: attempt.inputRef,
    operationId: attempt.operationId,
  };
}

/** Rejects missing, stale, or contradictory observations without changing held exclusion. */
export function acceptSchedulerExecutionObservation(
  coreDb: CoreDb,
  observation: ExecutionBackendObservation | null
): SchedulerExecutionAttemptRecord | null {
  if (!observation) return null;
  const found = coreDb.sqlite
    .prepare(`${attemptSelect} WHERE attempt_id = ?`)
    .get(observation.attemptId);
  if (!found) return null;
  const attempt = AttemptSchema.parse(found);
  if (
    attempt.backendId !== observation.backendId ||
    attempt.bindingRef !== observation.bindingRef ||
    attempt.inputRef !== observation.inputRef ||
    attempt.operationId !== observation.operationId ||
    !['not_accepted', 'accepted', 'unknown'].includes(observation.disposition) ||
    !['pending', 'running', 'terminal', 'unknown'].includes(observation.execution) ||
    (observation.outcomeRef !== null &&
      (typeof observation.outcomeRef !== 'string' || !observation.outcomeRef)) ||
    (observation.fenceRef !== null &&
      (typeof observation.fenceRef !== 'string' || !observation.fenceRef)) ||
    (attempt.outcomeRef !== null &&
      observation.outcomeRef !== null &&
      attempt.outcomeRef !== observation.outcomeRef) ||
    (attempt.fenceRef !== null &&
      observation.fenceRef !== null &&
      attempt.fenceRef !== observation.fenceRef)
  )
    return null;
  // Uncertainty cannot erase definite acceptance; cancellation never reopens authority.
  const disposition: ExecutionOperationDisposition =
    attempt.disposition === 'accepted' && observation.disposition === 'unknown'
      ? 'accepted'
      : observation.disposition;
  if (attempt.disposition === 'accepted' && disposition === 'not_accepted') return null;
  if (attempt.phase === 'closed') return attempt;
  coreDb.sqlite
    .prepare(`UPDATE scheduler_execution_attempts SET disposition = ?, outcome_ref = COALESCE(outcome_ref, ?), fence_ref = COALESCE(fence_ref, ?), updated_at = ?
    WHERE attempt_id = ? AND phase = ? AND operation_id = ?`)
    .run(
      disposition,
      observation.outcomeRef,
      observation.fenceRef,
      new Date().toISOString(),
      attempt.attemptId,
      attempt.phase,
      attempt.operationId
    );
  return requireSchedulerExecutionAttempt(coreDb, attempt.attemptId);
}

/** Revokes new authority before cancellation or terminal handoff; the first cause survives late facts. */
export function markSchedulerExecutionAttemptClosing(
  coreDb: CoreDb,
  input: {
    readonly attemptId: string;
    readonly cause: string;
    readonly outcomeRef?: string | null;
    readonly now?: () => string;
  }
): SchedulerExecutionAttemptRecord {
  coreDb.sqlite
    .prepare(
      `UPDATE scheduler_execution_attempts SET phase = 'closing', terminal_cause = COALESCE(terminal_cause, ?), outcome_ref = COALESCE(outcome_ref, ?), updated_at = ? WHERE attempt_id = ? AND phase <> 'closed'`
    )
    .run(
      input.cause,
      input.outcomeRef ?? null,
      input.now?.() ?? new Date().toISOString(),
      input.attemptId
    );
  return requireSchedulerExecutionAttempt(coreDb, input.attemptId);
}

/** Closes only the entire attempt's definite no-effect refusal, preserving the same queued Turn on busy. */
export function closeSchedulerExecutionAttemptWithoutEffects(
  coreDb: CoreDb,
  input: {
    readonly attemptId: string;
    readonly noOutstandingEffects: true;
    readonly cause: string;
    readonly requeue?: boolean;
    readonly now?: () => string;
  }
): SchedulerExecutionAttemptRecord {
  return coreDb.sqlite
    .transaction(() => {
      const attempt = requireSchedulerExecutionAttempt(coreDb, input.attemptId);
      if (input.noOutstandingEffects !== true)
        throw new Error('Attempt closure requires definite whole-attempt no-effect proof.');
      if (attempt.phase === 'closed') return attempt;
      if (attempt.disposition === 'accepted')
        throw new Error('Accepted effects require the proved release fence.');
      const timestamp = input.now?.() ?? new Date().toISOString();
      coreDb.sqlite
        .prepare(
          `UPDATE scheduler_execution_attempts SET phase = 'closed', disposition = 'not_accepted', terminal_cause = COALESCE(terminal_cause, ?), updated_at = ? WHERE attempt_id = ? AND phase <> 'closed'`
        )
        .run(input.cause, timestamp, attempt.attemptId);
      if (input.requeue)
        coreDb.sqlite
          .prepare(
            "UPDATE scheduler_admission_entries SET status = 'queued' WHERE queue_entry_id = ? AND status = 'admitted'"
          )
          .run(attempt.queueEntryId);
      return requireSchedulerExecutionAttempt(coreDb, attempt.attemptId);
    })
    .immediate();
}

/** Releases exclusion only after complete Core barriers and the exact backend fence. */
export function closeSchedulerExecutionAttemptWithFence(
  coreDb: CoreDb,
  input: {
    readonly correlation: ExecutionBackendCorrelation;
    readonly proof: ExecutionReleaseProof;
    readonly fenceRef: string;
    readonly now?: () => string;
  }
): SchedulerExecutionAttemptRecord {
  const attempt = requireSchedulerExecutionAttempt(coreDb, input.correlation.attemptId);
  if (
    commandInputHash(schedulerExecutionCorrelation(attempt)) !==
      commandInputHash(input.correlation) ||
    !input.fenceRef ||
    (attempt.fenceRef !== null && attempt.fenceRef !== input.fenceRef) ||
    ![
      input.proof.terminalHandoff,
      input.proof.output,
      input.proof.evidence,
      input.proof.outsideWorkspaceCollection,
      input.proof.integrationDrain,
      input.proof.routesRevoked,
    ].every((value) => value === true)
  )
    throw new Error('Attempt release has unresolved handoff or fencing proof.');
  if (attempt.phase === 'closed') return attempt;
  if (attempt.phase !== 'closing') throw new Error('Attempt release has no revoked owner.');
  const updated = coreDb.sqlite
    .prepare(
      `UPDATE scheduler_execution_attempts SET phase = 'closed', fence_ref = ?, updated_at = ? WHERE attempt_id = ? AND phase = 'closing' AND operation_id = ?`
    )
    .run(
      input.fenceRef,
      input.now?.() ?? new Date().toISOString(),
      attempt.attemptId,
      attempt.operationId
    );
  if (updated.changes !== 1) throw new Error('Release proof lost its attempt ownership race.');
  return requireSchedulerExecutionAttempt(coreDb, attempt.attemptId);
}

/** Terminal product publication revokes authority; only the backend's complete release proof closes it. */
export function markSchedulerAttemptForTerminalTurn(
  coreDb: CoreDb | undefined,
  turn: {
    readonly id: string;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly status: string;
  }
): void {
  if (!coreDb || !['completed', 'interrupted', 'cancelled', 'failed'].includes(turn.status)) return;
  for (const attempt of listSchedulerExecutionAttemptsForTurn(coreDb, {
    workspaceId: turn.workspaceId,
    threadId: turn.threadId,
    turnId: turn.id,
  })) {
    if (attempt.phase === 'closed') continue;
    markSchedulerExecutionAttemptClosing(coreDb, {
      attemptId: attempt.attemptId,
      cause: `turn-${turn.status}`,
      outcomeRef: `turn:${turn.id}:${turn.status}`,
    });
  }
}

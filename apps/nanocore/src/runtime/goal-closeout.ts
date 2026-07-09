import type { StopReason } from '@openkit/protocol';

import type { WorkspaceDb } from '../storage/db.js';
import type { GoalRecord, GoalTaskRecord } from './goal-store.js';
import { listGoalTasks, updateGoalStatus } from './goal-store.js';
import {
  type GoalVerificationRecord,
  listGoalVerificationRecordsForGoal,
} from './goal-verification-records.js';

/**
 * Terminal closeout status selected for a goal run.
 */
export type GoalCloseoutStatus = 'completed' | 'blocked' | 'aborted' | 'failed';

/**
 * Input used to close one Goal Mode run.
 */
export interface CloseGoalRunInput {
  /** Workspace that owns the goal. */
  readonly workspaceId: string;
  /** Thread that owns the goal. */
  readonly threadId: string;
  /** Goal to close. */
  readonly goalId: string;
  /** Optional known risks to include in the closeout summary. */
  readonly risks?: readonly string[];
  /** Optional suggested next work to include in the closeout summary. */
  readonly suggestedNextWork?: readonly string[];
  /** Optional clock used by deterministic tests. */
  readonly now?: () => string;
}

/**
 * Structured final summary for a Goal Mode run.
 */
export interface GoalCloseoutSummary {
  /** Completed task ids. */
  readonly completedTaskIds: readonly string[];
  /** Explicitly skipped task ids. */
  readonly skippedTaskIds: readonly string[];
  /** Blocked or failed task ids. */
  readonly blockedTaskIds: readonly string[];
  /** Artifact ids referenced by verification evidence. */
  readonly artifactIds: readonly string[];
  /** Verification record ids included as evidence. */
  readonly verificationEvidenceIds: readonly string[];
  /** Remaining risks for the user. */
  readonly risks: readonly string[];
  /** Suggested next work after closeout. */
  readonly suggestedNextWork: readonly string[];
}

/**
 * Result returned after a goal closeout attempt.
 */
export interface CloseGoalRunResult {
  /** Terminal status written to the goal. */
  readonly status: GoalCloseoutStatus;
  /** Terminal stop reason written to the goal. */
  readonly stopReason: StopReason;
  /** Updated goal record. */
  readonly goal: GoalRecord;
  /** Structured closeout summary. */
  readonly summary: GoalCloseoutSummary;
}

/**
 * Closes one Goal Mode run after checking task and verification evidence.
 *
 * @param workspaceDb Open workspace-scope database handle for goal task state.
 * @param input Goal closeout input.
 * @returns Closeout result with a structured summary.
 * @throws Error when the goal does not exist in the requested scope.
 */
export function closeGoalRun(
  workspaceDb: WorkspaceDb,
  input: CloseGoalRunInput
): CloseGoalRunResult {
  const tasks = listGoalTasks(workspaceDb, input);
  const verifications = listGoalVerificationRecordsForGoal(workspaceDb, input);
  const risks = createCloseoutRisks(tasks, verifications, input.risks ?? []);
  const status: GoalCloseoutStatus = risks.length === 0 ? 'completed' : 'blocked';
  const stopReason: StopReason = status === 'completed' ? 'completed' : 'ask_user';
  const goal = updateGoalStatus(workspaceDb, {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    goalId: input.goalId,
    status,
    currentTaskId: null,
    terminalStopReason: stopReason,
    ...(input.now ? { now: input.now } : {}),
  });

  return {
    goal,
    status,
    stopReason,
    summary: createCloseoutSummary(tasks, verifications, risks, input.suggestedNextWork ?? []),
  };
}

/**
 * Creates closeout risks from task and verification state.
 *
 * @param tasks Goal tasks to inspect.
 * @param verifications Verification evidence records.
 * @param explicitRisks User or caller supplied risks.
 * @returns Closeout risk strings.
 */
function createCloseoutRisks(
  tasks: readonly GoalTaskRecord[],
  verifications: readonly GoalVerificationRecord[],
  explicitRisks: readonly string[]
): string[] {
  const risks = [...explicitRisks];
  const blockedTaskCount = tasks.filter(
    (task) => task.status === 'blocked' || task.status === 'failed'
  ).length;
  const incompleteTaskCount = tasks.filter(
    (task) => !['completed', 'skipped', 'blocked', 'failed'].includes(task.status)
  ).length;
  const hasPassingFinalVerification = verifications.some(
    (verification) => verification.taskId === null && verification.status === 'passed'
  );

  if (blockedTaskCount > 0) {
    risks.push(`${blockedTaskCount} required task is blocked or failed.`);
  }

  if (incompleteTaskCount > 0) {
    risks.push(`${incompleteTaskCount} required task is not accepted or skipped.`);
  }

  if (!hasPassingFinalVerification) {
    risks.push('No passing final verification record is available.');
  }

  return risks;
}

/**
 * Creates the structured closeout summary.
 *
 * @param tasks Goal tasks included in closeout.
 * @param verifications Verification evidence records.
 * @param risks Closeout risks.
 * @param suggestedNextWork Suggested next work strings.
 * @returns Structured closeout summary.
 */
function createCloseoutSummary(
  tasks: readonly GoalTaskRecord[],
  verifications: readonly GoalVerificationRecord[],
  risks: readonly string[],
  suggestedNextWork: readonly string[]
): GoalCloseoutSummary {
  return {
    artifactIds: dedupe(verifications.flatMap((verification) => verification.artifactIds)),
    blockedTaskIds: tasks
      .filter((task) => task.status === 'blocked' || task.status === 'failed')
      .map((task) => task.taskId),
    completedTaskIds: tasks
      .filter((task) => task.status === 'completed')
      .map((task) => task.taskId),
    risks,
    skippedTaskIds: tasks.filter((task) => task.status === 'skipped').map((task) => task.taskId),
    suggestedNextWork,
    verificationEvidenceIds: verifications.map((verification) => verification.verificationId),
  };
}

/**
 * Deduplicates strings while preserving first-seen order.
 *
 * @param values Values to deduplicate.
 * @returns Deduplicated values.
 */
function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

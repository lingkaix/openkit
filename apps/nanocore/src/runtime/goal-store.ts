import type { StopReason } from '@openkit/protocol';

import { recordWorkspaceAuditEvent } from '../audit-events.js';
import type { WorkspaceDb } from '../storage/db.js';
import type { GoalRecordStatus, GoalTaskStatus } from '../storage/schema/index.js';
import { type GoalPlanVerificationCheck, GoalPlanVerificationCheckSchema } from './goal-plan.js';

/**
 * Callback used by goal store helpers to confirm app-local workspace ownership.
 *
 * @param workspaceId Workspace id to check.
 * @returns True when the workspace exists in the caller-owned app-local store.
 */
export type GoalStoreWorkspaceExists = (workspaceId: string) => boolean;

/**
 * Stored app-local goal record.
 */
export interface GoalRecord {
  /** Stable goal id. */
  readonly goalId: string;
  /** Workspace that owns the goal. */
  readonly workspaceId: string;
  /** Thread that owns the goal. */
  readonly threadId: string;
  /** Goal lifecycle status. */
  readonly status: GoalRecordStatus;
  /** Human-readable goal title. */
  readonly title: string;
  /** Full user-facing goal objective. */
  readonly objective: string;
  /** Optional item id that created the goal. */
  readonly createdByItemId: string | null;
  /** Optional item id containing the accepted plan. */
  readonly planItemId: string | null;
  /** Optional current task id for read-model projection. */
  readonly currentTaskId: string | null;
  /** Optional terminal stop reason after closeout. */
  readonly terminalStopReason: StopReason | null;
  /** ISO timestamp for goal creation. */
  readonly createdAt: string;
  /** ISO timestamp for latest goal update. */
  readonly updatedAt: string;
}

/**
 * Stored app-local goal task record.
 */
export interface GoalTaskRecord {
  /** Stable goal task id. */
  readonly taskId: string;
  /** Workspace that owns the task. */
  readonly workspaceId: string;
  /** Thread that owns the task. */
  readonly threadId: string;
  /** Goal that owns the task. */
  readonly goalId: string;
  /** Goal task lifecycle status. */
  readonly status: GoalTaskStatus;
  /** Human-readable task title. */
  readonly title: string;
  /** Worker-facing task objective. */
  readonly objective: string;
  /** Stable ordering field within the goal. */
  readonly orderIndex: number;
  /** Task ids that must complete before this task. */
  readonly dependsOnTaskIds: readonly string[];
  /** Task acceptance criteria. */
  readonly acceptanceCriteria: readonly string[];
  /** Estimated context budget in tokens for this task. */
  readonly contextBudgetTokens: number;
  /** Verification checks configured for this task. */
  readonly verificationChecks: readonly GoalPlanVerificationCheck[];
  /** ISO timestamp for task creation. */
  readonly createdAt: string;
  /** ISO timestamp for latest task update. */
  readonly updatedAt: string;
}

interface GoalRecordRow {
  readonly goal_id: string;
  readonly workspace_id: string;
  readonly thread_id: string;
  readonly status: GoalRecordStatus;
  readonly title: string;
  readonly objective: string;
  readonly created_by_item_id: string | null;
  readonly plan_item_id: string | null;
  readonly current_task_id: string | null;
  readonly terminal_stop_reason: StopReason | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface GoalTaskRow {
  readonly task_id: string;
  readonly workspace_id: string;
  readonly thread_id: string;
  readonly goal_id: string;
  readonly status: GoalTaskStatus;
  readonly title: string;
  readonly objective: string;
  readonly order_index: number;
  readonly depends_on_task_ids_json: string;
  readonly acceptance_criteria_json: string;
  readonly context_budget_tokens: number;
  readonly verification_checks_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * Input used to create one goal record.
 */
export interface CreateGoalRecordInput {
  /** App-local workspace existence callback. */
  readonly workspaceExists: GoalStoreWorkspaceExists;
  /** Stable goal id. */
  readonly goalId: string;
  /** Workspace that owns the goal. */
  readonly workspaceId: string;
  /** Thread that owns the goal. */
  readonly threadId: string;
  /** Human-readable goal title. */
  readonly title: string;
  /** Full user-facing goal objective. */
  readonly objective: string;
  /** Optional item id that created the goal. */
  readonly createdByItemId?: string | null;
  /** Optional initial goal status. */
  readonly status?: GoalRecordStatus;
  /** Optional clock used by deterministic tests. */
  readonly now?: () => string;
}

/**
 * Input used to list goal records for one thread.
 */
export interface ListGoalRecordsForThreadInput {
  /** Workspace that owns the goals. */
  readonly workspaceId: string;
  /** Thread that owns the goals. */
  readonly threadId: string;
}

/**
 * Input used to update one goal status.
 */
export interface UpdateGoalStatusInput {
  /** Workspace that owns the goal. */
  readonly workspaceId: string;
  /** Thread that owns the goal. */
  readonly threadId: string;
  /** Goal id to update. */
  readonly goalId: string;
  /** New goal status. */
  readonly status: GoalRecordStatus;
  /** Optional item id containing the accepted plan. */
  readonly planItemId?: string | null;
  /** Optional current task id for read-model projection. */
  readonly currentTaskId?: string | null;
  /** Optional terminal stop reason after closeout. */
  readonly terminalStopReason?: StopReason | null;
  /** Optional clock used by deterministic tests. */
  readonly now?: () => string;
}

/**
 * Input used to create one goal task.
 */
export interface CreateGoalTaskInput {
  /** Workspace that owns the goal. */
  readonly workspaceId: string;
  /** Thread that owns the goal. */
  readonly threadId: string;
  /** Goal that owns the task. */
  readonly goalId: string;
  /** Stable goal task id. */
  readonly taskId: string;
  /** Human-readable task title. */
  readonly title: string;
  /** Worker-facing task objective. */
  readonly objective: string;
  /** Stable ordering field within the goal. */
  readonly orderIndex: number;
  /** Task ids that must complete before this task. */
  readonly dependsOnTaskIds: readonly string[];
  /** Task acceptance criteria. */
  readonly acceptanceCriteria: readonly string[];
  /** Estimated context budget in tokens for this task. */
  readonly contextBudgetTokens: number;
  /** Verification checks configured for this task. */
  readonly verificationChecks?: readonly GoalPlanVerificationCheck[];
  /** Optional initial task status. */
  readonly status?: GoalTaskStatus;
  /** Optional clock used by deterministic tests. */
  readonly now?: () => string;
}

/**
 * Input used to identify a goal's task list.
 */
export interface GoalTaskListInput {
  /** Workspace that owns the goal. */
  readonly workspaceId: string;
  /** Thread that owns the goal. */
  readonly threadId: string;
  /** Goal that owns the tasks. */
  readonly goalId: string;
}

/**
 * Input used to update one goal task.
 */
export interface UpdateGoalTaskInput extends GoalTaskListInput {
  /** Task id to update. */
  readonly taskId: string;
  /** Optional updated task status. */
  readonly status?: GoalTaskStatus;
  /** Optional updated ordering field within the goal. */
  readonly orderIndex?: number;
  /** Optional clock used by deterministic tests. */
  readonly now?: () => string;
}

/**
 * Creates one goal record.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Goal creation input.
 * @returns Stored goal record.
 * @throws Error when the workspace does not exist.
 */
export function createGoalRecord(
  workspaceDb: WorkspaceDb,
  input: CreateGoalRecordInput
): GoalRecord {
  assertWorkspaceExists(input.workspaceExists, input.workspaceId);

  const timestamp = input.now?.() ?? new Date().toISOString();

  workspaceDb.sqlite
    .prepare(
      `INSERT INTO goal_records (
        goal_id,
        workspace_id,
        thread_id,
        status,
        title,
        objective,
        created_by_item_id,
        plan_item_id,
        current_task_id,
        terminal_stop_reason,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.goalId,
      input.workspaceId,
      input.threadId,
      input.status ?? 'planning',
      input.title,
      input.objective,
      input.createdByItemId ?? null,
      null,
      null,
      null,
      timestamp,
      timestamp
    );

  const goal = requireGoalRecord(workspaceDb, input.workspaceId, input.threadId, input.goalId);
  recordGoalCreatedAuditEvent(workspaceDb, goal);
  return goal;
}

/**
 * Reads one goal record by workspace, thread, and goal id.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @param threadId Thread id.
 * @param goalId Goal id.
 * @returns Stored goal record, or null.
 */
export function getGoalRecord(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  threadId: string,
  goalId: string
): GoalRecord | null {
  const row = workspaceDb.sqlite
    .prepare(
      `${goalRecordSelectSql()}
      WHERE workspace_id = ? AND thread_id = ? AND goal_id = ?`
    )
    .get(workspaceId, threadId, goalId) as GoalRecordRow | undefined;

  return row ? mapGoalRecordRow(row) : null;
}

/**
 * Lists goal records for one thread in deterministic order.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Thread scope for goals.
 * @returns Stored goal records.
 */
export function listGoalRecordsForThread(
  workspaceDb: WorkspaceDb,
  input: ListGoalRecordsForThreadInput
): GoalRecord[] {
  return (
    workspaceDb.sqlite
      .prepare(
        `${goalRecordSelectSql()}
        WHERE workspace_id = ? AND thread_id = ?
        ORDER BY updated_at ASC, goal_id ASC`
      )
      .all(input.workspaceId, input.threadId) as GoalRecordRow[]
  ).map(mapGoalRecordRow);
}

/**
 * Lists all goal records for one workspace in stable export order.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Goal records in oldest-first order.
 */
export function listExportableGoalRecords(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): GoalRecord[] {
  return (
    workspaceDb.sqlite
      .prepare(
        `${goalRecordSelectSql()}
        WHERE workspace_id = ?
        ORDER BY updated_at ASC, thread_id ASC, goal_id ASC`
      )
      .all(workspaceId) as GoalRecordRow[]
  ).map(mapGoalRecordRow);
}

/**
 * Updates one goal status and optional projection fields.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Goal status update input.
 * @returns Updated goal record.
 * @throws Error when the goal does not exist in the requested scope.
 */
export function updateGoalStatus(
  workspaceDb: WorkspaceDb,
  input: UpdateGoalStatusInput
): GoalRecord {
  const existing = requireGoalRecord(workspaceDb, input.workspaceId, input.threadId, input.goalId);
  const timestamp = input.now?.() ?? new Date().toISOString();

  workspaceDb.sqlite
    .prepare(
      `UPDATE goal_records
      SET
        status = ?,
        plan_item_id = ?,
        current_task_id = ?,
        terminal_stop_reason = ?,
        updated_at = ?
      WHERE workspace_id = ? AND thread_id = ? AND goal_id = ?`
    )
    .run(
      input.status,
      input.planItemId === undefined ? existing.planItemId : input.planItemId,
      input.currentTaskId === undefined ? existing.currentTaskId : input.currentTaskId,
      input.terminalStopReason === undefined
        ? existing.terminalStopReason
        : input.terminalStopReason,
      timestamp,
      existing.workspaceId,
      existing.threadId,
      existing.goalId
    );

  const goal = requireGoalRecord(workspaceDb, input.workspaceId, input.threadId, input.goalId);
  recordGoalStatusAuditEvent(workspaceDb, existing, goal);
  return goal;
}

/**
 * Creates one goal task after confirming goal ownership.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Goal task creation input.
 * @returns Stored goal task record.
 * @throws Error when the goal does not exist in the requested scope.
 */
export function createGoalTask(
  workspaceDb: WorkspaceDb,
  input: CreateGoalTaskInput
): GoalTaskRecord {
  requireGoalRecord(workspaceDb, input.workspaceId, input.threadId, input.goalId);

  const timestamp = input.now?.() ?? new Date().toISOString();

  workspaceDb.sqlite
    .prepare(
      `INSERT INTO goal_tasks (
        task_id,
        workspace_id,
        thread_id,
        goal_id,
        status,
        title,
        objective,
        order_index,
        depends_on_task_ids_json,
        acceptance_criteria_json,
        context_budget_tokens,
        verification_checks_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.taskId,
      input.workspaceId,
      input.threadId,
      input.goalId,
      input.status ?? 'pending',
      input.title,
      input.objective,
      input.orderIndex,
      JSON.stringify(input.dependsOnTaskIds),
      JSON.stringify(input.acceptanceCriteria),
      input.contextBudgetTokens,
      JSON.stringify(input.verificationChecks ?? []),
      timestamp,
      timestamp
    );

  const task = requireGoalTask(
    workspaceDb,
    input.workspaceId,
    input.threadId,
    input.goalId,
    input.taskId
  );
  recordGoalTaskCreatedAuditEvent(workspaceDb, task);
  return task;
}

/**
 * Lists goal tasks after confirming goal ownership.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Goal task list input.
 * @returns Goal task records in deterministic order.
 * @throws Error when the goal does not exist in the requested scope.
 */
export function listGoalTasks(
  workspaceDb: WorkspaceDb,
  input: GoalTaskListInput
): GoalTaskRecord[] {
  requireGoalRecord(workspaceDb, input.workspaceId, input.threadId, input.goalId);

  return (
    workspaceDb.sqlite
      .prepare(
        `${goalTaskSelectSql()}
        WHERE workspace_id = ? AND thread_id = ? AND goal_id = ?
        ORDER BY order_index ASC, task_id ASC`
      )
      .all(input.workspaceId, input.threadId, input.goalId) as GoalTaskRow[]
  ).map(mapGoalTaskRow);
}

/**
 * Lists all goal task records for one workspace in stable export order.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Goal task records in stable order.
 */
export function listExportableGoalTasks(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): GoalTaskRecord[] {
  return (
    workspaceDb.sqlite
      .prepare(
        `${goalTaskSelectSql()}
        WHERE workspace_id = ?
        ORDER BY updated_at ASC, thread_id ASC, goal_id ASC, order_index ASC, task_id ASC`
      )
      .all(workspaceId) as GoalTaskRow[]
  ).map(mapGoalTaskRow);
}

/**
 * Replays imported goal records without emitting goal audit events.
 *
 * @param workspaceDb Open target workspace database handle.
 * @param goals Goal rows to replay.
 */
export function importGoalRecords(workspaceDb: WorkspaceDb, goals: readonly GoalRecord[]): void {
  for (const goal of goals) {
    workspaceDb.sqlite
      .prepare(
        `INSERT OR IGNORE INTO goal_records (
          goal_id,
          workspace_id,
          thread_id,
          status,
          title,
          objective,
          created_by_item_id,
          plan_item_id,
          current_task_id,
          terminal_stop_reason,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        goal.goalId,
        goal.workspaceId,
        goal.threadId,
        goal.status,
        goal.title,
        goal.objective,
        goal.createdByItemId,
        goal.planItemId,
        goal.currentTaskId,
        goal.terminalStopReason,
        goal.createdAt,
        goal.updatedAt
      );
  }
}

/**
 * Replays imported goal task records without emitting goal task audit events.
 *
 * @param workspaceDb Open target workspace database handle.
 * @param tasks Goal task rows to replay.
 */
export function importGoalTasks(workspaceDb: WorkspaceDb, tasks: readonly GoalTaskRecord[]): void {
  for (const task of tasks) {
    workspaceDb.sqlite
      .prepare(
        `INSERT OR IGNORE INTO goal_tasks (
          task_id,
          workspace_id,
          thread_id,
          goal_id,
          status,
          title,
          objective,
          order_index,
          depends_on_task_ids_json,
          acceptance_criteria_json,
          context_budget_tokens,
          verification_checks_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        task.taskId,
        task.workspaceId,
        task.threadId,
        task.goalId,
        task.status,
        task.title,
        task.objective,
        task.orderIndex,
        JSON.stringify(task.dependsOnTaskIds),
        JSON.stringify(task.acceptanceCriteria),
        task.contextBudgetTokens,
        JSON.stringify(task.verificationChecks),
        task.createdAt,
        task.updatedAt
      );
  }
}

/**
 * Updates one goal task after confirming goal ownership.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Goal task update input.
 * @returns Updated goal task record.
 * @throws Error when the goal or task does not exist in the requested scope.
 */
export function updateGoalTask(
  workspaceDb: WorkspaceDb,
  input: UpdateGoalTaskInput
): GoalTaskRecord {
  requireGoalRecord(workspaceDb, input.workspaceId, input.threadId, input.goalId);
  const existing = requireGoalTask(
    workspaceDb,
    input.workspaceId,
    input.threadId,
    input.goalId,
    input.taskId
  );
  const timestamp = input.now?.() ?? new Date().toISOString();

  workspaceDb.sqlite
    .prepare(
      `UPDATE goal_tasks
      SET
        status = ?,
        order_index = ?,
        updated_at = ?
      WHERE workspace_id = ? AND thread_id = ? AND goal_id = ? AND task_id = ?`
    )
    .run(
      input.status ?? existing.status,
      input.orderIndex ?? existing.orderIndex,
      timestamp,
      existing.workspaceId,
      existing.threadId,
      existing.goalId,
      existing.taskId
    );

  const task = requireGoalTask(
    workspaceDb,
    input.workspaceId,
    input.threadId,
    input.goalId,
    input.taskId
  );
  recordGoalTaskStatusAuditEvent(workspaceDb, existing, task);
  return task;
}

/**
 * Confirms a workspace exists before goals are written.
 *
 * @param workspaceExists App-local workspace existence callback.
 * @param workspaceId Workspace id to check.
 * @throws Error when the workspace does not exist.
 */
function assertWorkspaceExists(
  workspaceExists: GoalStoreWorkspaceExists,
  workspaceId: string
): void {
  if (!workspaceExists(workspaceId)) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }
}

/**
 * Reads one goal record or throws a scoped ownership error.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @param threadId Thread id.
 * @param goalId Goal id.
 * @returns Stored goal record.
 * @throws Error when the goal does not exist in the requested scope.
 */
function requireGoalRecord(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  threadId: string,
  goalId: string
): GoalRecord {
  const goal = getGoalRecord(workspaceDb, workspaceId, threadId, goalId);

  if (!goal) {
    throw new Error(`Goal not found: ${workspaceId}/${threadId}/${goalId}`);
  }

  return goal;
}

/**
 * Records audit lineage for a newly created goal.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param goal Stored goal record.
 */
function recordGoalCreatedAuditEvent(workspaceDb: WorkspaceDb, goal: GoalRecord): void {
  recordWorkspaceAuditEvent({
    action: 'goal.create',
    category: 'system',
    itemId: goal.createdByItemId,
    now: new Date(goal.createdAt),
    outcome: 'succeeded',
    resource: `goal:${goal.goalId}`,
    severity: 'info',
    summary: 'Goal created.',
    threadId: goal.threadId,
    workspaceDb,
    workspaceId: goal.workspaceId,
  });
}

/**
 * Records audit lineage for a newly created goal task.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param task Stored goal task record.
 */
function recordGoalTaskCreatedAuditEvent(workspaceDb: WorkspaceDb, task: GoalTaskRecord): void {
  recordWorkspaceAuditEvent({
    action: 'goal.task.create',
    category: 'system',
    now: new Date(task.createdAt),
    outcome: 'succeeded',
    resource: `goal-task:${task.taskId}`,
    severity: 'info',
    summary: 'Goal task created.',
    threadId: task.threadId,
    workspaceDb,
    workspaceId: task.workspaceId,
  });
}

/**
 * Records audit lineage for a goal task status transition.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param previous Goal task record before the update.
 * @param task Goal task record after the update.
 */
function recordGoalTaskStatusAuditEvent(
  workspaceDb: WorkspaceDb,
  previous: GoalTaskRecord,
  task: GoalTaskRecord
): void {
  if (previous.status === task.status) {
    return;
  }

  recordWorkspaceAuditEvent({
    action: 'goal.task.status.update',
    category: 'system',
    now: new Date(task.updatedAt),
    outcome: goalTaskStatusAuditOutcome(task.status),
    resource: `goal-task:${task.taskId}`,
    severity: goalTaskStatusAuditSeverity(task.status),
    summary: `Goal task status changed: ${previous.status} -> ${task.status}`,
    threadId: task.threadId,
    workspaceDb,
    workspaceId: task.workspaceId,
  });
}

/**
 * Records audit lineage for a goal status transition.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param previous Goal record before the update.
 * @param goal Goal record after the update.
 */
function recordGoalStatusAuditEvent(
  workspaceDb: WorkspaceDb,
  previous: GoalRecord,
  goal: GoalRecord
): void {
  if (previous.status === goal.status) {
    return;
  }

  recordWorkspaceAuditEvent({
    action: 'goal.status.update',
    category: 'system',
    now: new Date(goal.updatedAt),
    outcome: goalStatusAuditOutcome(goal.status),
    resource: `goal:${goal.goalId}`,
    severity: goalStatusAuditSeverity(goal.status),
    summary: `Goal status changed: ${previous.status} -> ${goal.status}`,
    threadId: goal.threadId,
    workspaceDb,
    workspaceId: goal.workspaceId,
  });
}

/**
 * Maps a goal status to an audit outcome.
 *
 * @param status Updated goal status.
 * @returns Audit outcome for the status transition.
 */
function goalStatusAuditOutcome(
  status: GoalRecordStatus
): 'succeeded' | 'failed' | 'denied' | 'cancelled' {
  if (status === 'aborted') {
    return 'cancelled';
  }

  return status === 'blocked' || status === 'failed' ? 'failed' : 'succeeded';
}

/**
 * Maps a goal status to an audit severity.
 *
 * @param status Updated goal status.
 * @returns Audit severity for the status transition.
 */
function goalStatusAuditSeverity(status: GoalRecordStatus): 'info' | 'warning' {
  return status === 'blocked' || status === 'failed' || status === 'aborted' ? 'warning' : 'info';
}

/**
 * Maps a goal task status to an audit outcome.
 *
 * @param status Updated goal task status.
 * @returns Audit outcome for the task status transition.
 */
function goalTaskStatusAuditOutcome(
  status: GoalTaskStatus
): 'succeeded' | 'failed' | 'denied' | 'cancelled' {
  if (status === 'skipped') {
    return 'cancelled';
  }

  return status === 'needs_revision' || status === 'blocked' || status === 'failed'
    ? 'failed'
    : 'succeeded';
}

/**
 * Maps a goal task status to an audit severity.
 *
 * @param status Updated goal task status.
 * @returns Audit severity for the task status transition.
 */
function goalTaskStatusAuditSeverity(status: GoalTaskStatus): 'info' | 'warning' {
  return status === 'needs_revision' ||
    status === 'blocked' ||
    status === 'failed' ||
    status === 'skipped'
    ? 'warning'
    : 'info';
}

/**
 * Reads one goal task or throws a scoped task error.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @param threadId Thread id.
 * @param goalId Goal id.
 * @param taskId Task id.
 * @returns Stored goal task record.
 * @throws Error when the task does not exist for the goal.
 */
function requireGoalTask(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  threadId: string,
  goalId: string,
  taskId: string
): GoalTaskRecord {
  const row = workspaceDb.sqlite
    .prepare(
      `${goalTaskSelectSql()}
      WHERE workspace_id = ? AND thread_id = ? AND goal_id = ? AND task_id = ?`
    )
    .get(workspaceId, threadId, goalId, taskId) as GoalTaskRow | undefined;

  if (!row) {
    throw new Error(`Goal task not found: ${workspaceId}/${threadId}/${goalId}/${taskId}`);
  }

  return mapGoalTaskRow(row);
}

/**
 * Maps a goal row to a store record.
 *
 * @param row Goal row.
 * @returns Goal store record.
 */
function mapGoalRecordRow(row: GoalRecordRow): GoalRecord {
  return {
    goalId: row.goal_id,
    workspaceId: row.workspace_id,
    threadId: row.thread_id,
    status: row.status,
    title: row.title,
    objective: row.objective,
    createdByItemId: row.created_by_item_id,
    planItemId: row.plan_item_id,
    currentTaskId: row.current_task_id,
    terminalStopReason: row.terminal_stop_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Maps a goal task row to a store record.
 *
 * @param row Goal task row.
 * @returns Goal task store record.
 */
function mapGoalTaskRow(row: GoalTaskRow): GoalTaskRecord {
  return {
    taskId: row.task_id,
    workspaceId: row.workspace_id,
    threadId: row.thread_id,
    goalId: row.goal_id,
    status: row.status,
    title: row.title,
    objective: row.objective,
    orderIndex: row.order_index,
    dependsOnTaskIds: parseStringArray(row.depends_on_task_ids_json),
    acceptanceCriteria: parseStringArray(row.acceptance_criteria_json),
    contextBudgetTokens: row.context_budget_tokens,
    verificationChecks: parseVerificationChecks(row.verification_checks_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Returns the goal record projection shared by goal store reads.
 *
 * @returns SQL select projection.
 */
function goalRecordSelectSql(): string {
  return `SELECT
    goal_id,
    workspace_id,
    thread_id,
    status,
    title,
    objective,
    created_by_item_id,
    plan_item_id,
    current_task_id,
    terminal_stop_reason,
    created_at,
    updated_at
  FROM goal_records`;
}

/**
 * Returns the goal task projection shared by goal store reads.
 *
 * @returns SQL select projection.
 */
function goalTaskSelectSql(): string {
  return `SELECT
    task_id,
    workspace_id,
    thread_id,
    goal_id,
    status,
    title,
    objective,
    order_index,
    depends_on_task_ids_json,
    acceptance_criteria_json,
    context_budget_tokens,
    verification_checks_json,
    created_at,
    updated_at
  FROM goal_tasks`;
}

/**
 * Parses a stored JSON string array.
 *
 * @param value JSON string value to parse.
 * @returns Parsed string array.
 * @throws Error when the stored JSON is malformed.
 */
function parseStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;

  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    throw new Error('Stored goal task JSON field is not a string array.');
  }

  return parsed;
}

/**
 * Parses a stored verification check JSON array.
 *
 * @param value JSON string value to parse.
 * @returns Parsed verification checks.
 * @throws Error when the stored JSON is malformed.
 */
function parseVerificationChecks(value: string): GoalPlanVerificationCheck[] {
  return GoalPlanVerificationCheckSchema.array().parse(JSON.parse(value));
}

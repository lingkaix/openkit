import type { StopReason } from '@openkit/protocol';

import { recordWorkspaceAuditEvent } from '../audit-events.js';
import type { WorkspaceDb } from '../storage/db.js';
import type { GoalRecordStatus, GoalTaskStatus } from '../storage/schema/index.js';
import {
  computeGoalPlanDigest,
  type GoalPlanOutput,
  GoalPlanOutputSchema,
  type GoalPlanTask,
  GoalPlanTaskSchema,
  selectGoalPlanPayload,
} from './goal-plan.js';

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
 * Stored immutable app-local Goal Plan authority.
 */
export interface GoalPlanRecord extends GoalPlanOutput {
  /** Workspace that owns the plan. */
  readonly workspaceId: string;
  /** Thread that owns the plan. */
  readonly threadId: string;
  /** Goal that owns the plan. */
  readonly goalId: string;
  /** Visible plan Item and immutable record id. */
  readonly planItemId: string;
  /** Canonical digest of the exact Plan payload. */
  readonly planDigest: string;
  /** Request that created the plan authority. */
  readonly createdByRequestId: string;
  /** ISO timestamp for plan creation. */
  readonly createdAt: string;
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
  /** Immutable Goal Plan that supplied the task. */
  readonly planItemId: string;
  /** Goal task lifecycle status. */
  readonly status: GoalTaskStatus;
  /** Latest closed Human Gate response carried into the next Task attempt. */
  readonly latestGateContextItemId: string | null;
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
  /** Exact semantic resource declarations for this task. */
  readonly resources: GoalPlanTask['resources'];
  /** Exact expected artifacts for this task. */
  readonly expectedArtifacts: GoalPlanTask['expectedArtifacts'];
  /** Verification checks configured for this task. */
  readonly verificationChecks: GoalPlanTask['verificationChecks'];
  /** Immutable human review policy for this task. */
  readonly reviewPolicy: GoalPlanTask['reviewPolicy'];
  /** Exact escalation conditions for this task. */
  readonly escalationConditions: GoalPlanTask['escalationConditions'];
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

interface GoalPlanRecordRow {
  readonly workspace_id: string;
  readonly thread_id: string;
  readonly goal_id: string;
  readonly plan_item_id: string;
  readonly plan_digest: string;
  readonly plan_json: string;
  readonly created_by_request_id: string;
  readonly created_at: string;
}

interface GoalTaskRow {
  readonly task_id: string;
  readonly workspace_id: string;
  readonly thread_id: string;
  readonly goal_id: string;
  readonly plan_item_id: string;
  readonly status: GoalTaskStatus;
  readonly latest_gate_context_item_id: string | null;
  readonly title: string;
  readonly objective: string;
  readonly order_index: number;
  readonly depends_on_task_ids_json: string;
  readonly acceptance_criteria_json: string;
  readonly context_budget_tokens: number;
  readonly resources_json: string;
  readonly expected_artifacts_json: string;
  readonly verification_checks_json: string;
  readonly review_policy_json: string;
  readonly escalation_conditions_json: string;
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
 * Input used to create one immutable Goal Plan authority.
 */
export interface CreateGoalPlanRecordInput {
  /** Workspace that owns the plan. */
  readonly workspaceId: string;
  /** Thread that owns the plan. */
  readonly threadId: string;
  /** Goal that owns the plan. */
  readonly goalId: string;
  /** Visible plan Item and immutable record id. */
  readonly planItemId: string;
  /** Exact validated Plan payload. */
  readonly plan: GoalPlanOutput;
  /** Request that created the plan authority. */
  readonly createdByRequestId: string;
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
  /** Immutable Goal Plan that supplied the task. */
  readonly planItemId: string;
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
  /** Exact semantic resource declarations for this task. */
  readonly resources: GoalPlanTask['resources'];
  /** Exact expected artifacts for this task. */
  readonly expectedArtifacts: GoalPlanTask['expectedArtifacts'];
  /** Verification checks configured for this task. */
  readonly verificationChecks: GoalPlanTask['verificationChecks'];
  /** Immutable human review policy for this task. */
  readonly reviewPolicy: GoalPlanTask['reviewPolicy'];
  /** Exact escalation conditions for this task. */
  readonly escalationConditions: GoalPlanTask['escalationConditions'];
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
  /** Optional latest closed Human Gate response, with null clearing the pointer. */
  readonly latestGateContextItemId?: string | null;
  /** Optional clock used by deterministic tests. */
  readonly now?: () => string;
}

/**
 * Exact Goal and Task identity required for one worker-turn reservation.
 */
export interface ReserveGoalTaskForWorkerTurnInput extends GoalTaskListInput {
  /** Ready task selected for the worker turn. */
  readonly taskId: string;
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
 * Creates one immutable Goal Plan authority after confirming Goal ownership.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Goal Plan creation input.
 * @returns Stored immutable Goal Plan record.
 * @throws Error when the Goal is missing, the Plan needs questions, or the identity already exists.
 */
export function createGoalPlanRecord(
  workspaceDb: WorkspaceDb,
  input: CreateGoalPlanRecordInput
): GoalPlanRecord {
  requireGoalRecord(workspaceDb, input.workspaceId, input.threadId, input.goalId);
  const plan = GoalPlanOutputSchema.parse(input.plan);
  if (plan.questions.length > 0) {
    throw new Error('Goal Plan records require an empty questions array.');
  }
  if (input.createdByRequestId.trim().length === 0) {
    throw new Error('Goal Plan creation requires a non-empty request id.');
  }
  const createdAt = input.now?.() ?? new Date().toISOString();

  workspaceDb.sqlite
    .prepare(
      `INSERT INTO goal_plan_records (
        workspace_id,
        thread_id,
        goal_id,
        plan_item_id,
        plan_digest,
        plan_json,
        created_by_request_id,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.workspaceId,
      input.threadId,
      input.goalId,
      input.planItemId,
      computeGoalPlanDigest(plan),
      JSON.stringify(plan),
      input.createdByRequestId,
      createdAt
    );

  return requireGoalPlanRecord(workspaceDb, input.workspaceId, input.threadId, input.planItemId);
}

/**
 * Reads one immutable Goal Plan authority by its visible plan Item id.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace that owns the plan.
 * @param threadId Thread that owns the plan.
 * @param planItemId Visible plan Item and record id.
 * @returns Stored Plan authority, or null when absent.
 * @throws Error when stored payload validation or digest verification fails.
 */
export function getGoalPlanRecord(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  threadId: string,
  planItemId: string
): GoalPlanRecord | null {
  const row = workspaceDb.sqlite
    .prepare(
      `${goalPlanRecordSelectSql()}
      WHERE workspace_id = ? AND thread_id = ? AND plan_item_id = ?`
    )
    .get(workspaceId, threadId, planItemId) as GoalPlanRecordRow | undefined;

  return row ? mapGoalPlanRecordRow(row) : null;
}

/**
 * Lists all immutable Goal Plan authorities for one Workspace in stable export order.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Stored Plan records in stable order.
 */
export function listExportableGoalPlanRecords(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): GoalPlanRecord[] {
  return (
    workspaceDb.sqlite
      .prepare(
        `${goalPlanRecordSelectSql()}
        WHERE workspace_id = ?
        ORDER BY created_at ASC, thread_id ASC, goal_id ASC, plan_item_id ASC`
      )
      .all(workspaceId) as GoalPlanRecordRow[]
  ).map(mapGoalPlanRecordRow);
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
        plan_item_id,
        status,
        title,
        objective,
        order_index,
        depends_on_task_ids_json,
        acceptance_criteria_json,
        context_budget_tokens,
        resources_json,
        expected_artifacts_json,
        verification_checks_json,
        review_policy_json,
        escalation_conditions_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.taskId,
      input.workspaceId,
      input.threadId,
      input.goalId,
      input.planItemId,
      input.status ?? 'pending',
      input.title,
      input.objective,
      input.orderIndex,
      JSON.stringify(input.dependsOnTaskIds),
      JSON.stringify(input.acceptanceCriteria),
      input.contextBudgetTokens,
      JSON.stringify(input.resources),
      JSON.stringify(input.expectedArtifacts),
      JSON.stringify(input.verificationChecks),
      JSON.stringify(input.reviewPolicy),
      JSON.stringify(input.escalationConditions),
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
 * Replays imported immutable Goal Plan authorities without adding another lifecycle.
 *
 * @param workspaceDb Open target workspace database handle.
 * @param plans Validated and reminted Goal Plan records.
 */
export function importGoalPlanRecords(
  workspaceDb: WorkspaceDb,
  plans: readonly GoalPlanRecord[]
): void {
  for (const record of plans) {
    const plan = GoalPlanOutputSchema.parse(selectGoalPlanPayload(record));
    if (record.planDigest !== computeGoalPlanDigest(plan)) {
      throw new Error(`Goal Plan digest mismatch: ${record.planItemId}.`);
    }
    if (record.createdByRequestId.trim().length === 0) {
      throw new Error(`Goal Plan request lineage is empty: ${record.planItemId}.`);
    }
    workspaceDb.sqlite
      .prepare(
        `INSERT INTO goal_plan_records (
          workspace_id,
          thread_id,
          goal_id,
          plan_item_id,
          plan_digest,
          plan_json,
          created_by_request_id,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.workspaceId,
        record.threadId,
        record.goalId,
        record.planItemId,
        record.planDigest,
        JSON.stringify(plan),
        record.createdByRequestId,
        record.createdAt
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
        `INSERT INTO goal_tasks (
          task_id,
          workspace_id,
          thread_id,
          goal_id,
          plan_item_id,
          status,
          latest_gate_context_item_id,
          title,
          objective,
          order_index,
          depends_on_task_ids_json,
          acceptance_criteria_json,
          context_budget_tokens,
          resources_json,
          expected_artifacts_json,
          verification_checks_json,
          review_policy_json,
          escalation_conditions_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        task.taskId,
        task.workspaceId,
        task.threadId,
        task.goalId,
        task.planItemId,
        task.status,
        task.latestGateContextItemId,
        task.title,
        task.objective,
        task.orderIndex,
        JSON.stringify(task.dependsOnTaskIds),
        JSON.stringify(task.acceptanceCriteria),
        task.contextBudgetTokens,
        JSON.stringify(task.resources),
        JSON.stringify(task.expectedArtifacts),
        JSON.stringify(task.verificationChecks),
        JSON.stringify(task.reviewPolicy),
        JSON.stringify(task.escalationConditions),
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
  const status = input.status ?? existing.status;
  const latestGateContextItemId = ['completed', 'blocked', 'failed'].includes(status)
    ? null
    : input.latestGateContextItemId === undefined
      ? existing.latestGateContextItemId
      : input.latestGateContextItemId;

  workspaceDb.sqlite
    .prepare(
      `UPDATE goal_tasks
      SET
        status = ?,
        latest_gate_context_item_id = ?,
        updated_at = ?
      WHERE workspace_id = ? AND thread_id = ? AND goal_id = ? AND task_id = ?`
    )
    .run(
      status,
      latestGateContextItemId,
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
 * Reserves one exact ready Goal Task while its Goal remains runnable.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Exact Goal and Task identity selected before preparation.
 * @returns True when both owners were reserved, otherwise false.
 */
export function reserveGoalTaskForWorkerTurn(
  workspaceDb: WorkspaceDb,
  input: ReserveGoalTaskForWorkerTurnInput
): boolean {
  return workspaceDb.sqlite.transaction(() => {
    const goal = getGoalRecord(workspaceDb, input.workspaceId, input.threadId, input.goalId);
    const tasks = listGoalTasks(workspaceDb, {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      goalId: input.goalId,
    });
    const task = tasks.find((candidate) => candidate.taskId === input.taskId);
    const firstReadyTask = tasks.find((candidate) => candidate.status === 'ready');
    const unresolvedCheckpoint = workspaceDb.sqlite
      .prepare(
        `SELECT 1
        FROM worker_turn_checkpoints
        WHERE workspace_id = ? AND thread_id = ? AND goal_id = ?
        LIMIT 1`
      )
      .get(input.workspaceId, input.threadId, input.goalId);

    if (
      !goal ||
      !task ||
      unresolvedCheckpoint ||
      goal.status !== 'running' ||
      goal.currentTaskId !== null ||
      goal.terminalStopReason !== null ||
      task.status !== 'ready' ||
      firstReadyTask?.taskId !== task.taskId
    ) {
      return false;
    }

    updateGoalTask(workspaceDb, {
      ...input,
      status: 'running',
    });
    updateGoalStatus(workspaceDb, {
      ...input,
      status: 'running',
      currentTaskId: input.taskId,
    });

    return true;
  })();
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
 * Reads one immutable Goal Plan authority or throws a scoped error.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace that owns the plan.
 * @param threadId Thread that owns the plan.
 * @param planItemId Visible plan Item and record id.
 * @returns Stored Goal Plan authority.
 * @throws Error when the Plan record is absent or corrupt.
 */
function requireGoalPlanRecord(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  threadId: string,
  planItemId: string
): GoalPlanRecord {
  const record = getGoalPlanRecord(workspaceDb, workspaceId, threadId, planItemId);
  if (!record) {
    throw new Error(`Goal Plan not found: ${workspaceId}/${threadId}/${planItemId}`);
  }
  return record;
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
  return status === 'blocked' || status === 'failed' ? 'failed' : 'succeeded';
}

/**
 * Maps a goal task status to an audit severity.
 *
 * @param status Updated goal task status.
 * @returns Audit severity for the task status transition.
 */
function goalTaskStatusAuditSeverity(status: GoalTaskStatus): 'info' | 'warning' {
  return status === 'blocked' || status === 'failed' ? 'warning' : 'info';
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
 * Maps one stored Goal Plan row and verifies its payload digest.
 *
 * @param row Stored Goal Plan row.
 * @returns Validated immutable Goal Plan record.
 * @throws Error when the payload or digest is invalid.
 */
function mapGoalPlanRecordRow(row: GoalPlanRecordRow): GoalPlanRecord {
  const plan = GoalPlanOutputSchema.parse(JSON.parse(row.plan_json));
  const digest = computeGoalPlanDigest(plan);
  if (row.plan_digest !== digest) {
    throw new Error(`Goal Plan digest mismatch: ${row.plan_item_id}.`);
  }
  return {
    ...plan,
    workspaceId: row.workspace_id,
    threadId: row.thread_id,
    goalId: row.goal_id,
    planItemId: row.plan_item_id,
    planDigest: row.plan_digest,
    createdByRequestId: row.created_by_request_id,
    createdAt: row.created_at,
  };
}

/**
 * Maps a goal task row to a store record.
 *
 * @param row Goal task row.
 * @returns Goal task store record.
 */
function mapGoalTaskRow(row: GoalTaskRow): GoalTaskRecord {
  const task = GoalPlanTaskSchema.parse({
    taskId: row.task_id,
    title: row.title,
    objective: row.objective,
    dependsOnTaskIds: JSON.parse(row.depends_on_task_ids_json),
    acceptanceCriteria: JSON.parse(row.acceptance_criteria_json),
    contextBudgetTokens: row.context_budget_tokens,
    resources: JSON.parse(row.resources_json),
    expectedArtifacts: JSON.parse(row.expected_artifacts_json),
    verificationChecks: JSON.parse(row.verification_checks_json),
    reviewPolicy: JSON.parse(row.review_policy_json),
    escalationConditions: JSON.parse(row.escalation_conditions_json),
  });
  return {
    ...task,
    workspaceId: row.workspace_id,
    threadId: row.thread_id,
    goalId: row.goal_id,
    planItemId: row.plan_item_id,
    status: row.status,
    latestGateContextItemId: row.latest_gate_context_item_id,
    orderIndex: row.order_index,
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
 * Returns the immutable Goal Plan projection shared by store reads.
 *
 * @returns SQL select projection.
 */
function goalPlanRecordSelectSql(): string {
  return `SELECT
    workspace_id,
    thread_id,
    goal_id,
    plan_item_id,
    plan_digest,
    plan_json,
    created_by_request_id,
    created_at
  FROM goal_plan_records`;
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
    plan_item_id,
    status,
    latest_gate_context_item_id,
    title,
    objective,
    order_index,
    depends_on_task_ids_json,
    acceptance_criteria_json,
    context_budget_tokens,
    resources_json,
    expected_artifacts_json,
    verification_checks_json,
    review_policy_json,
    escalation_conditions_json,
    created_at,
    updated_at
  FROM goal_tasks`;
}

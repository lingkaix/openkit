import type { StopReason } from '@openkit/protocol';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Durable app-local Goal Mode lifecycle status.
 */
export type GoalRecordStatus =
  | 'planning'
  | 'awaiting_plan_approval'
  | 'running'
  | 'paused'
  | 'awaiting_user'
  | 'reviewing'
  | 'verifying'
  | 'completed'
  | 'blocked'
  | 'aborted'
  | 'failed';

/**
 * Durable app-local Goal Mode task lifecycle status.
 */
export type GoalTaskStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'reviewing'
  | 'needs_revision'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'skipped';

/**
 * Durable app-local goal records scoped by workspace and thread.
 */
export const goalRecords = sqliteTable(
  'goal_records',
  {
    /** Stable goal id. */
    goalId: text('goal_id').notNull(),
    /** Workspace that owns the goal. */
    workspaceId: text('workspace_id').notNull(),
    /** Thread that owns the goal. */
    threadId: text('thread_id').notNull(),
    /** Goal lifecycle status. */
    status: text('status').$type<GoalRecordStatus>().notNull(),
    /** Human-readable goal title. */
    title: text('title').notNull(),
    /** Full user-facing goal objective. */
    objective: text('objective').notNull(),
    /** Optional item id that created the goal. */
    createdByItemId: text('created_by_item_id'),
    /** Optional item id containing the accepted plan. */
    planItemId: text('plan_item_id'),
    /** Optional current task id for read-model projection. */
    currentTaskId: text('current_task_id'),
    /** Optional terminal stop reason after closeout. */
    terminalStopReason: text('terminal_stop_reason').$type<StopReason | null>(),
    /** ISO timestamp for goal creation. */
    createdAt: text('created_at').notNull(),
    /** ISO timestamp for latest goal update. */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.threadId, table.goalId] }),
    index('goal_records_thread_idx').on(
      table.workspaceId,
      table.threadId,
      table.updatedAt,
      table.goalId
    ),
  ]
);

/**
 * Durable app-local goal task records scoped by goal.
 */
export const goalTasks = sqliteTable(
  'goal_tasks',
  {
    /** Stable goal task id. */
    taskId: text('task_id').notNull(),
    /** Workspace that owns the task. */
    workspaceId: text('workspace_id').notNull(),
    /** Thread that owns the task. */
    threadId: text('thread_id').notNull(),
    /** Goal that owns the task. */
    goalId: text('goal_id').notNull(),
    /** Goal task lifecycle status. */
    status: text('status').$type<GoalTaskStatus>().notNull(),
    /** Human-readable task title. */
    title: text('title').notNull(),
    /** Worker-facing task objective. */
    objective: text('objective').notNull(),
    /** Stable ordering field within the goal. */
    orderIndex: integer('order_index').notNull(),
    /** JSON array of task ids that must complete before this task. */
    dependsOnTaskIdsJson: text('depends_on_task_ids_json').notNull(),
    /** JSON array of task acceptance criteria strings. */
    acceptanceCriteriaJson: text('acceptance_criteria_json').notNull(),
    /** Estimated context budget in tokens for this task. */
    contextBudgetTokens: integer('context_budget_tokens').notNull(),
    /** JSON array of verification checks configured for this task. */
    verificationChecksJson: text('verification_checks_json').notNull(),
    /** ISO timestamp for task creation. */
    createdAt: text('created_at').notNull(),
    /** ISO timestamp for latest task update. */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.threadId, table.goalId, table.taskId] }),
    index('goal_tasks_goal_order_idx').on(
      table.workspaceId,
      table.threadId,
      table.goalId,
      table.orderIndex,
      table.taskId
    ),
  ]
);

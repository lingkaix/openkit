import { index, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Durable app-local verification status recorded for Goal Mode evidence.
 */
export type GoalVerificationStatus =
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'unavailable'
  | 'manual_required';

/**
 * Durable app-local goal verification evidence scoped by goal and optional task.
 */
export const goalVerificationRecords = sqliteTable(
  'goal_verification_records',
  {
    /** Stable verification record id. */
    verificationId: text('verification_id').notNull(),
    /** Workspace that owns the verification evidence. */
    workspaceId: text('workspace_id').notNull(),
    /** Thread that owns the verification evidence. */
    threadId: text('thread_id').notNull(),
    /** Goal that owns the verification evidence. */
    goalId: text('goal_id').notNull(),
    /** Optional goal task associated with the evidence. */
    taskId: text('task_id'),
    /** Optional turn associated with the evidence. */
    turnId: text('turn_id'),
    /** Optional command id associated with command execution. */
    commandId: text('command_id'),
    /** Optional redacted command or manual check description. */
    command: text('command'),
    /** Verification status. */
    status: text('status').$type<GoalVerificationStatus>().notNull(),
    /** Redacted human-readable verification summary. */
    summary: text('summary').notNull(),
    /** JSON array of item ids associated with the evidence. */
    itemIdsJson: text('item_ids_json').notNull(),
    /** JSON array of artifact ids associated with the evidence. */
    artifactIdsJson: text('artifact_ids_json').notNull(),
    /** JSON array of redacted output pointers associated with the evidence. */
    outputPointersJson: text('output_pointers_json').notNull(),
    /** ISO timestamp for verification record creation. */
    createdAt: text('created_at').notNull(),
    /** ISO timestamp for latest verification record update. */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.threadId, table.goalId, table.verificationId],
    }),
    index('goal_verification_records_goal_idx').on(
      table.workspaceId,
      table.threadId,
      table.goalId,
      table.createdAt,
      table.verificationId
    ),
    index('goal_verification_records_task_idx').on(
      table.workspaceId,
      table.threadId,
      table.goalId,
      table.taskId,
      table.createdAt,
      table.verificationId
    ),
  ]
);

import { index, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Durable app-local review verdict recorded at a goal task checkpoint.
 */
export type GoalReviewVerdict =
  | 'accept'
  | 'refine'
  | 'retry'
  | 'decompose'
  | 'ask_user'
  | 'block'
  | 'abort';

/**
 * Durable app-local goal task review records scoped by goal task.
 */
export const goalReviewRecords = sqliteTable(
  'goal_review_records',
  {
    /** Stable review id. */
    reviewId: text('review_id').notNull(),
    /** Workspace that owns the reviewed task. */
    workspaceId: text('workspace_id').notNull(),
    /** Thread that owns the reviewed task. */
    threadId: text('thread_id').notNull(),
    /** Goal that owns the reviewed task. */
    goalId: text('goal_id').notNull(),
    /** Goal task reviewed by this record. */
    taskId: text('task_id').notNull(),
    /** Optional worker or reviewer turn associated with the review. */
    turnId: text('turn_id'),
    /** JSON array of item ids considered by the review. */
    itemIdsJson: text('item_ids_json').notNull(),
    /** JSON array of artifact ids considered by the review. */
    artifactIdsJson: text('artifact_ids_json').notNull(),
    /** JSON array of redacted verification evidence considered by the review. */
    verificationEvidenceJson: text('verification_evidence_json').notNull(),
    /** Review verdict. */
    verdict: text('verdict').$type<GoalReviewVerdict>().notNull(),
    /** Redacted human-readable review reason. */
    reason: text('reason').notNull(),
    /** ISO timestamp for review record creation. */
    createdAt: text('created_at').notNull(),
    /** ISO timestamp for latest review record update. */
    updatedAt: text('updated_at').notNull(),
    /** ISO timestamp when the review decision was resolved. */
    resolvedAt: text('resolved_at'),
    /** Request id that resolved this review decision. */
    resolutionRequestId: text('resolution_request_id'),
    /** Immutable JSON snapshot of the first successful review advance result. */
    resolutionSnapshotJson: text('resolution_snapshot_json'),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.threadId, table.goalId, table.reviewId] }),
    index('goal_review_records_task_idx').on(
      table.workspaceId,
      table.threadId,
      table.goalId,
      table.taskId,
      table.createdAt,
      table.reviewId
    ),
  ]
);

import { index, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Durable workspace apply result status.
 */
export type WorkspaceApplyResultStatus = 'applied' | 'conflicted' | 'blocked';

/**
 * Durable review-gated workspace apply results scoped by workspace.
 */
export const workspaceApplyResults = sqliteTable(
  'workspace_apply_results',
  {
    /** Stable workspace apply result id. */
    applyResultId: text('apply_result_id').notNull(),
    /** Workspace that owns the applied review. */
    workspaceId: text('workspace_id').notNull(),
    /** Staged workspace review id that was applied. */
    reviewId: text('review_id').notNull(),
    /** Worker-produced change set id that was applied. */
    changeSetId: text('change_set_id').notNull(),
    /** Final apply status. */
    status: text('status').$type<WorkspaceApplyResultStatus>().notNull(),
    /** JSON array of workspace-relative paths applied to the target workspace. */
    appliedPathsJson: text('applied_paths_json').notNull(),
    /** JSON array of workspace-relative paths skipped during apply. */
    skippedPathsJson: text('skipped_paths_json').notNull(),
    /** JSON array of product-safe conflict summaries. */
    conflictRecordsJson: text('conflict_records_json').notNull(),
    /** JSON array of product-safe verification records. */
    verificationJson: text('verification_json').notNull(),
    /** JSON array of commit ids created by the apply operation. */
    commitIdsJson: text('commit_ids_json').notNull(),
    /** ISO timestamp when the result was applied or finalized. */
    appliedAt: text('applied_at').notNull(),
    /** Request id that created this result. */
    requestId: text('request_id').notNull(),
    /** ISO timestamp for result record creation. */
    createdAt: text('created_at').notNull(),
    /** ISO timestamp for latest result record update. */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.applyResultId] }),
    index('workspace_apply_results_review_idx').on(
      table.workspaceId,
      table.reviewId,
      table.appliedAt,
      table.applyResultId
    ),
  ]
);

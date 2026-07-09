import { index, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Durable workspace apply plans scoped by workspace.
 */
export const workspaceApplyPlans = sqliteTable(
  'workspace_apply_plans',
  {
    /** Stable workspace apply plan id. */
    applyPlanId: text('apply_plan_id').notNull(),
    /** Workspace that owns the apply plan. */
    workspaceId: text('workspace_id').notNull(),
    /** Staged workspace review id planned for apply. */
    reviewId: text('review_id').notNull(),
    /** Worker-produced change set id planned for apply. */
    changeSetId: text('change_set_id').notNull(),
    /** Synchronization strategy selected by NanoCore. */
    strategy: text('strategy').notNull(),
    /** Approval state observed before mutation. */
    approvalState: text('approval_state').notNull(),
    /** Schema-validated public payload JSON. */
    payloadJson: text('payload_json').notNull(),
    /** ISO timestamp for plan record creation. */
    createdAt: text('created_at').notNull(),
    /** ISO timestamp for latest plan record update. */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.applyPlanId] }),
    index('workspace_apply_plans_review_idx').on(
      table.workspaceId,
      table.reviewId,
      table.createdAt,
      table.applyPlanId
    ),
  ]
);

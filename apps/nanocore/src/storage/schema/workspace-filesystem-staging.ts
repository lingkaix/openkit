import { index, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Internal filesystem staging roots used to apply approved workspace reviews.
 */
export const workspaceFilesystemStagingRoots = sqliteTable(
  'workspace_filesystem_staging_roots',
  {
    /** Workspace that owns the staged review. */
    workspaceId: text('workspace_id').notNull(),
    /** Staged workspace review id. */
    reviewId: text('review_id').notNull(),
    /** Workspace change set staged for review. */
    changeSetId: text('change_set_id').notNull(),
    /** Internal host staging root path. */
    stagingRootPath: text('staging_root_path').notNull(),
    /** Internal host target root path. */
    targetRootPath: text('target_root_path').notNull(),
    /** JSON serialized filesystem snapshot manifest captured before worker execution. */
    beforeManifestJson: text('before_manifest_json').notNull(),
    /** ISO timestamp for record creation. */
    createdAt: text('created_at').notNull(),
    /** ISO timestamp for latest record update. */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.reviewId] }),
    index('workspace_filesystem_staging_change_set_idx').on(
      table.workspaceId,
      table.changeSetId,
      table.updatedAt,
      table.reviewId
    ),
  ]
);

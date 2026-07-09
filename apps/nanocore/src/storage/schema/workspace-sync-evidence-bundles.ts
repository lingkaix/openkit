import { index, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Durable workspace synchronization evidence linkage records scoped by workspace. */
export const workspaceSyncEvidenceBundles = sqliteTable(
  'workspace_sync_evidence_bundles',
  {
    /** Stable workspace synchronization evidence bundle id. */
    syncEvidenceBundleId: text('sync_evidence_bundle_id').notNull(),
    /** Workspace that owns the evidence linkage record. */
    workspaceId: text('workspace_id').notNull(),
    /** Schema-validated public payload JSON. */
    payloadJson: text('payload_json').notNull(),
    /** ISO timestamp for record creation. */
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.syncEvidenceBundleId] }),
    index('idx_workspace_sync_evidence_bundles_workspace_created').on(
      table.workspaceId,
      table.createdAt,
      table.syncEvidenceBundleId
    ),
  ]
);

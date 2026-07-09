import { index, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Durable workspace quarantine records scoped by workspace. */
export const workspaceQuarantineRecords = sqliteTable(
  'workspace_quarantine_records',
  {
    /** Stable workspace quarantine record id. */
    quarantineRecordId: text('quarantine_record_id').notNull(),
    /** Workspace that owns the quarantine record. */
    workspaceId: text('workspace_id').notNull(),
    /** Validation failure class that caused quarantine. */
    failureKind: text('failure_kind').notNull(),
    /** Current quarantine resolution state. */
    resolution: text('resolution').notNull(),
    /** Schema-validated public payload JSON. */
    payloadJson: text('payload_json').notNull(),
    /** ISO timestamp for quarantine creation. */
    createdAt: text('created_at').notNull(),
    /** ISO timestamp for latest record update. */
    updatedAt: text('updated_at').notNull(),
    /** ISO timestamp for resolution, when terminal. */
    resolvedAt: text('resolved_at'),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.quarantineRecordId] }),
    index('idx_workspace_quarantine_records_workspace_resolution_created').on(
      table.workspaceId,
      table.resolution,
      table.createdAt,
      table.quarantineRecordId
    ),
  ]
);

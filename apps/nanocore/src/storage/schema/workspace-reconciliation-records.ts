import { index, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Durable workspace reconciliation records scoped by workspace. */
export const workspaceReconciliationRecords = sqliteTable(
  'workspace_reconciliation_records',
  {
    /** Stable workspace reconciliation record id. */
    reconciliationRecordId: text('reconciliation_record_id').notNull(),
    /** Workspace that owns the reconciliation record. */
    workspaceId: text('workspace_id').notNull(),
    /** Recovery trigger reason. */
    triggerReason: text('trigger_reason').notNull(),
    /** State reached by this reconciliation step. */
    stateAfter: text('state_after').notNull(),
    /** Schema-validated public payload JSON. */
    payloadJson: text('payload_json').notNull(),
    /** ISO timestamp for reconciliation start. */
    startedAt: text('started_at').notNull(),
    /** ISO timestamp for reconciliation finish, when terminal. */
    finishedAt: text('finished_at'),
    /** ISO timestamp for latest record update. */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.reconciliationRecordId] }),
    index('workspace_reconciliation_records_state_idx').on(
      table.workspaceId,
      table.stateAfter,
      table.startedAt,
      table.reconciliationRecordId
    ),
  ]
);

import { sql } from 'drizzle-orm';
import { check, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Workspace-owned capture decisions, not a snapshot, closure proof or exclusion mechanism. */
export const workspaceCaptureRecords = sqliteTable(
  'workspace_capture_records',
  {
    /** Stable capture identity supplied by its owner; retries do not create another record. */
    captureId: text('capture_id').primaryKey().notNull(),
    /** Workspace that owns this record and its physical SQL authority. */
    workspaceId: text('workspace_id').notNull(),
    /** Closed lifecycle; only an explicit owner decision can end active protection. */
    state: text('state', { enum: ['active', 'finished', 'abandoned'] }).notNull(),
    /** Trusted capture origin; predecessor records stay manual and never auto-abandon. */
    origin: text('origin', { enum: ['manual', 'automatic'] })
      .notNull()
      .default('manual'),
    /** Original creation time in UTC ISO format, never an expiry deadline. */
    createdAt: text('created_at').notNull(),
    /** First terminal decision time in UTC ISO format; null while active. */
    endedAt: text('ended_at'),
  },
  (table) => [
    check(
      'workspace_capture_records_state_check',
      sql`${table.state} IN ('active', 'finished', 'abandoned')`
    ),
    check(
      'workspace_capture_records_origin_check',
      sql`${table.origin} IN ('manual', 'automatic')`
    ),
    check(
      'workspace_capture_records_end_check',
      sql`(${table.state} = 'active' AND ${table.endedAt} IS NULL) OR (${table.state} IN ('finished', 'abandoned') AND ${table.endedAt} IS NOT NULL)`
    ),
  ]
);

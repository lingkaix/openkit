import { sql } from 'drizzle-orm';
import { blob, check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Immutable scheduler input scoped to the Workspace file that owns the bytes. */
export const workspaceWorkInputs = sqliteTable(
  'workspace_work_inputs',
  {
    inputId: text('input_id').primaryKey().notNull(),
    threadId: text('thread_id').notNull(),
    turnId: text('turn_id').notNull(),
    invocationId: text('invocation_id').notNull(),
    inputDigest: text('input_digest').notNull(),
    inputBytes: blob('input_bytes', { mode: 'buffer' }).notNull(),
    schemaVersion: integer('schema_version').notNull(),
  },
  (table) => [
    check(
      'workspace_work_inputs_identity_check',
      sql`length(${table.inputId}) > 0 AND length(${table.threadId}) > 0 AND length(${table.turnId}) > 0 AND length(${table.invocationId}) > 0`
    ),
    check(
      'workspace_work_inputs_digest_check',
      sql`length(${table.inputDigest}) = 64 AND ${table.inputDigest} NOT GLOB '*[^0-9a-f]*'`
    ),
    check('workspace_work_inputs_bytes_check', sql`typeof(${table.inputBytes}) = 'blob'`),
    check('workspace_work_inputs_version_check', sql`${table.schemaVersion} = 1`),
  ]
);

import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Offline request ownership survives candidate removal and failed registration (WM:434-441). */
export const workspaceRecoveryAdmissions = sqliteTable(
  'workspace_recovery_admissions',
  {
    schemaVersion: integer('schema_version').notNull().default(1),
    admissionId: text('admission_id').primaryKey().notNull(),
    backupId: text('backup_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    purpose: text('purpose', { enum: ['backup', 'move'] }).notNull(),
    state: text('state', { enum: ['prepared', 'finished', 'abandoned'] }).notNull(),
    revision: integer('revision').notNull().default(1),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    candidateRef: text('candidate_ref').notNull(),
    /** Closed request/verification facts needed for exact finish and result-first replay; never a receipt. */
    proofJson: text('proof_json').notNull(),
  },
  (table) => [
    check('workspace_recovery_state', sql`${table.state} IN ('prepared', 'finished', 'abandoned')`),
    check('workspace_recovery_purpose', sql`${table.purpose} IN ('backup', 'move')`),
    check('workspace_recovery_revision', sql`${table.revision} > 0`),
    check('workspace_recovery_schema', sql`${table.schemaVersion} = 1`),
  ]
);

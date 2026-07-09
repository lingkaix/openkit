import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Durable vault admin audit event outcomes. */
export type VaultAdminAuditOutcome = 'succeeded' | 'failed' | 'denied';

/** Durable vault admin audit event severities. */
export type VaultAdminAuditSeverity = 'info' | 'warning' | 'error';

/** Server-scoped vault admin audit event rows. */
export const vaultAdminAuditEvents = sqliteTable(
  'vault_admin_audit_events',
  {
    /** Stable audit event id. */
    auditEventId: text('audit_event_id').primaryKey().notNull(),
    /** Actor user id when available. */
    actorUserId: text('actor_user_id'),
    /** Actor kind when available. */
    actorKind: text('actor_kind'),
    /** Stable admin action name. */
    action: text('action').notNull(),
    /** Event outcome. */
    outcome: text('outcome').$type<VaultAdminAuditOutcome>().notNull(),
    /** Event severity. */
    severity: text('severity').$type<VaultAdminAuditSeverity>().notNull(),
    /** Redacted event summary. */
    summary: text('summary').notNull(),
    /** Stable error code when applicable. */
    errorCode: text('error_code'),
    /** Backend kind administered by the action. */
    backendKind: text('backend_kind').notNull(),
    /** Event creation timestamp. */
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('vault_admin_audit_events_action_idx').on(table.action, table.outcome, table.createdAt),
    index('vault_admin_audit_events_actor_idx').on(table.actorUserId, table.createdAt),
  ]
);

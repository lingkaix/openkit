import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Durable workspace audit event category values. */
export type AuditEventCategory =
  | 'command'
  | 'approval'
  | 'capability'
  | 'knowledge'
  | 'artifact'
  | 'system';

/** Durable workspace audit event outcome values. */
export type AuditEventOutcome = 'succeeded' | 'failed' | 'denied' | 'cancelled';

/** Durable workspace audit event severity values. */
export type AuditEventSeverity = 'info' | 'warning' | 'error';

/** Durable workspace-scoped audit event rows. */
export const auditEvents = sqliteTable(
  'audit_events',
  {
    /** Stable audit event id. */
    auditEventId: text('audit_event_id').primaryKey().notNull(),
    /** Workspace that owns the event. */
    workspaceId: text('workspace_id'),
    /** Protocol version when the producer records one. */
    protocolVersion: text('protocol_version'),
    /** Thread lineage when available. */
    threadId: text('thread_id'),
    /** Turn lineage when available. */
    turnId: text('turn_id'),
    /** Item lineage when available. */
    itemId: text('item_id'),
    /** Capability call lineage when available. */
    capabilityCallId: text('capability_call_id'),
    /** Permission decision lineage when available. */
    permissionDecisionId: text('permission_decision_id'),
    /** Vault grant lineage when available. */
    vaultGrantId: text('vault_grant_id'),
    /** Request id when available. */
    requestId: text('request_id'),
    /** Agent lineage when available. */
    agentId: text('agent_id'),
    /** Agent session lineage when available. */
    agentSessionId: text('agent_session_id'),
    /** Audit category. */
    category: text('category').$type<AuditEventCategory>().notNull(),
    /** Stable action name. */
    action: text('action').notNull(),
    /** Redacted resource reference. */
    resource: text('resource'),
    /** Event outcome. */
    outcome: text('outcome').$type<AuditEventOutcome>().notNull(),
    /** Event severity. */
    severity: text('severity').$type<AuditEventSeverity>().notNull(),
    /** Redacted summary. */
    summary: text('summary').notNull(),
    /** Stable error code when applicable. */
    errorCode: text('error_code'),
    /** Storage creation timestamp. */
    createdAt: text('created_at').notNull(),
    /** Event occurrence timestamp. */
    occurredAt: text('occurred_at').notNull(),
  },
  (table) => [
    index('audit_events_workspace_idx').on(table.workspaceId, table.category, table.createdAt),
    index('audit_events_capability_call_idx').on(table.capabilityCallId),
    index('audit_events_permission_decision_idx').on(table.permissionDecisionId),
    index('audit_events_vault_grant_idx').on(table.vaultGrantId),
    index('audit_events_request_idx').on(table.requestId),
  ]
);

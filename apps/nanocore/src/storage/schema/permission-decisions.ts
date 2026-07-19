import { sql } from 'drizzle-orm';
import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Durable product-level permission decision result. */
export type PermissionDecisionResult =
  | 'allow'
  | 'deny'
  | 'require_approval'
  | 'require_escalation'
  | 'defer'
  | 'not_applicable'
  | 'error';

/**
 * Durable permission decision rows linking policy evaluation to product behavior.
 */
export const permissionDecisions = sqliteTable(
  'permission_decisions',
  {
    /** Stable decision id. */
    decisionId: text('decision_id').primaryKey().notNull(),
    /** Storage ownership scope for this decision. */
    ownerScope: text('owner_scope').notNull(),
    /** Workspace id when the decision is workspace-scoped. */
    workspaceId: text('workspace_id'),
    /** Policy engine and version that produced the decision. */
    policyEngineVersion: text('policy_engine_version').notNull(),
    /** Policy snapshot id evaluated for this decision. */
    policySnapshotId: text('policy_snapshot_id').notNull(),
    /** Redacted subject summary JSON. */
    subjectSummaryJson: text('subject_summary_json').notNull(),
    /** Product action or operation evaluated. */
    action: text('action').notNull(),
    /** Redacted resource summary JSON. */
    resourceSummaryJson: text('resource_summary_json').notNull(),
    /** Redacted context summary JSON. */
    contextSummaryJson: text('context_summary_json').notNull(),
    /** Product-level permission decision result. */
    result: text('result').$type<PermissionDecisionResult>().notNull(),
    /** Machine-readable reason code. */
    reasonCode: text('reason_code').notNull(),
    /** Enforcement point that produced this decision. */
    enforcementPoint: text('enforcement_point').notNull(),
    /** Approval kind required when result is require_approval. */
    requiredApprovalKind: text('required_approval_kind'),
    /** Linked approval id when present. */
    approvalId: text('approval_id'),
    /** Linked audit event id when present. */
    auditEventId: text('audit_event_id'),
    /** ISO timestamp for decision creation. */
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('permission_decisions_owner_idx').on(
      table.ownerScope,
      table.workspaceId,
      table.createdAt
    ),
    index('permission_decisions_enforcement_idx').on(table.enforcementPoint, table.createdAt),
    uniqueIndex('permission_decisions_terminal_approval_idx')
      .on(table.approvalId)
      .where(
        sql`${table.ownerScope} = 'workspace' AND ${table.approvalId} IS NOT NULL AND ${table.result} IN ('allow', 'deny')`
      ),
  ]
);

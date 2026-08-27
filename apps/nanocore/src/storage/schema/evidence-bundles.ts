import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Durable evidence bundle retention classes. */
export type EvidenceBundleRetentionClass =
  | 'ephemeral-diagnostic'
  | 'turn-evidence'
  | 'workspace-audit'
  | 'restricted-raw'
  | 'legal-hold';

/** Durable evidence bundle sensitivity classes. */
export type EvidenceBundleSensitivityClass = 'product-safe' | 'restricted' | 'secret';

/** Durable evidence bundle import lifecycle status. */
export type EvidenceBundleImportStatus =
  | 'collected'
  | 'verified'
  | 'normalized'
  | 'promoted'
  | 'quarantined'
  | 'expired';

/** Durable workspace-owned evidence bundle index rows. */
export const evidenceBundles = sqliteTable(
  'evidence_bundles',
  {
    /** Stable evidence bundle id. */
    evidenceBundleId: text('evidence_bundle_id').primaryKey().notNull(),
    /** Workspace that owns the bundle. */
    workspaceId: text('workspace_id').notNull(),
    /** Thread lineage when available. */
    threadId: text('thread_id'),
    /** Goal lineage when available. */
    goalId: text('goal_id'),
    /** Turn lineage when available. */
    turnId: text('turn_id'),
    /** AgentSession lineage when available. */
    agentSessionId: text('agent_session_id'),
    /** Worker backend type when available. */
    backendType: text('backend_type'),
    /** Evidence source kind. */
    sourceKind: text('source_kind').notNull(),
    /** Product-safe summary. */
    summary: text('summary').notNull(),
    /** JSON array of restricted raw evidence references. */
    rawEvidenceRefsJson: text('raw_evidence_refs_json').notNull(),
    /** JSON array of product-safe evidence references. */
    redactedEvidenceRefsJson: text('redacted_evidence_refs_json').notNull(),
    /** JSON array of content digests for indexed evidence. */
    contentDigestsJson: text('content_digests_json').notNull(),
    /** Retention class. */
    retentionClass: text('retention_class').$type<EvidenceBundleRetentionClass>().notNull(),
    /** Sensitivity class. */
    sensitivityClass: text('sensitivity_class').$type<EvidenceBundleSensitivityClass>().notNull(),
    /** Import lifecycle status. */
    importStatus: text('import_status').$type<EvidenceBundleImportStatus>().notNull(),
    /** JSON array of required semantic features. */
    requiredFeaturesJson: text('required_features_json').notNull(),
    /** Storage creation timestamp. */
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('evidence_bundles_workspace_idx').on(table.workspaceId, table.createdAt),
    index('evidence_bundles_thread_idx').on(table.workspaceId, table.threadId, table.turnId),
    index('evidence_bundles_goal_idx').on(table.workspaceId, table.goalId),
    index('evidence_bundles_status_idx').on(table.importStatus, table.retentionClass),
  ]
);

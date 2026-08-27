import { index, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Durable capability call status stored by the shared usage ledger. */
export type CapabilityCallLedgerStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

/** Capability families supported by the shared usage ledger. */
export type CapabilityCallFamily =
  | 'llm'
  | 'mcp'
  | 'knowledge'
  | 'network'
  | 'runtime'
  | 'storage'
  | 'workspace';

/** Durable workspace-scoped capability call rows. */
export const capabilityCalls = sqliteTable(
  'capability_calls',
  {
    /** Stable capability call id. */
    callId: text('call_id').primaryKey().notNull(),
    /** Workspace that owns the call. */
    workspaceId: text('workspace_id').notNull(),
    /** Thread lineage when available. */
    threadId: text('thread_id'),
    /** Turn lineage when available. */
    turnId: text('turn_id'),
    /** Item lineage when available. */
    itemId: text('item_id'),
    /** Agent lineage when available. */
    agentId: text('agent_id'),
    /** AgentSession lineage when available. */
    agentSessionId: text('agent_session_id'),
    /** Agent Environment Package snapshot that authorized the call. */
    packageSnapshotId: text('package_snapshot_id'),
    /** Product-safe runtime origin correlation reference. */
    runtimeOriginRef: text('runtime_origin_ref'),
    /** Product-safe runtime cache-lineage correlation reference. */
    runtimeCacheLineageRef: text('runtime_cache_lineage_ref'),
    /** Request id used for idempotency when available. */
    requestId: text('request_id'),
    /** Workspace data source ids touched by the call. */
    sourceIdsJson: text('source_ids_json').notNull().default('[]'),
    /** Product capability id. */
    capabilityId: text('capability_id').notNull(),
    /** Capability family. */
    family: text('family').$type<CapabilityCallFamily>().notNull(),
    /** Gateway operation. */
    operation: text('operation').notNull(),
    /** Current durable call status. */
    status: text('status').$type<CapabilityCallLedgerStatus>().notNull(),
    /** Redacted summary. */
    summary: text('summary'),
    /** Redacted provider reference. */
    providerRef: text('provider_ref'),
    /** Redacted service reference. */
    serviceRef: text('service_ref'),
    /** Redaction class applied by the producer. */
    redactionClass: text('redaction_class').notNull(),
    /** Stable error code for terminal failures. */
    errorCode: text('error_code'),
    /** Call start timestamp. */
    startedAt: text('started_at'),
    /** Terminal timestamp. */
    completedAt: text('completed_at'),
  },
  (table) => [
    uniqueIndex('capability_calls_idempotency_idx').on(
      table.workspaceId,
      table.requestId,
      table.family,
      table.operation
    ),
    index('capability_calls_workspace_idx').on(table.workspaceId, table.status, table.startedAt),
  ]
);

/** Durable workspace-scoped usage rows linked to capability calls. */
export const usageRecords = sqliteTable(
  'usage_records',
  {
    /** Stable usage record id. */
    usageId: text('usage_id').primaryKey().notNull(),
    /** Workspace that owns the usage. */
    workspaceId: text('workspace_id').notNull(),
    /** Thread lineage when available. */
    threadId: text('thread_id'),
    /** Turn lineage when available. */
    turnId: text('turn_id'),
    /** Item lineage when available. */
    itemId: text('item_id'),
    /** Linked capability call id. */
    capabilityCallId: text('capability_call_id'),
    /** Request id when available. */
    requestId: text('request_id'),
    /** Agent lineage when available. */
    agentId: text('agent_id'),
    /** AgentSession lineage when available. */
    agentSessionId: text('agent_session_id'),
    /** Immutable responsible-user attribution for this measurement. */
    responsibleUserId: text('responsible_user_id'),
    /** Workspace data source ids attributed to this measurement. */
    sourceIdsJson: text('source_ids_json').notNull().default('[]'),
    /** Usage category. */
    category: text('category').notNull(),
    /** Usage unit. */
    unit: text('unit').notNull(),
    /** Measured quantity. */
    quantity: real('quantity').notNull(),
    /** Model id for LLM usage. */
    modelId: text('model_id'),
    /** Provider reference. */
    providerRef: text('provider_ref'),
    /** Measurement source. */
    source: text('source'),
    /** Usage recording timestamp. */
    recordedAt: text('recorded_at').notNull(),
  },
  (table) => [
    index('usage_records_workspace_idx').on(table.workspaceId, table.category, table.recordedAt),
    index('usage_records_capability_call_idx').on(table.capabilityCallId),
  ]
);

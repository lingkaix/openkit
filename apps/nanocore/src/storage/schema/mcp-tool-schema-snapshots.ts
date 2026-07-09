import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Durable workspace-scoped MCP tool schema snapshot source. */
export type McpToolSchemaSnapshotSource = 'aep' | 'live';

/** Durable workspace-scoped MCP tool schema snapshots. */
export const mcpToolSchemaSnapshots = sqliteTable(
  'mcp_tool_schema_snapshots',
  {
    /** Stable schema snapshot id used by worker capability responses. */
    snapshotId: text('snapshot_id').primaryKey().notNull(),
    /** Workspace that owns the snapshot. */
    workspaceId: text('workspace_id').notNull(),
    /** Product-safe MCP catalog entry id. */
    catalogEntryId: text('catalog_entry_id').notNull(),
    /** Product-safe catalog source reference. */
    sourceRef: text('source_ref'),
    /** Product-safe server version when known. */
    serverVersion: text('server_version'),
    /** Content digest for the tool schema list. */
    contentDigest: text('content_digest').notNull(),
    /** JSON encoded product-safe tool names and input schemas. */
    toolsJson: text('tools_json').notNull(),
    /** Snapshot source. */
    source: text('source').$type<McpToolSchemaSnapshotSource>().notNull(),
    /** Capture timestamp. */
    capturedAt: text('captured_at').notNull(),
  },
  (table) => [
    uniqueIndex('mcp_tool_schema_snapshots_digest_idx').on(
      table.workspaceId,
      table.catalogEntryId,
      table.source,
      table.contentDigest
    ),
    index('mcp_tool_schema_snapshots_workspace_idx').on(
      table.workspaceId,
      table.catalogEntryId,
      table.capturedAt
    ),
  ]
);

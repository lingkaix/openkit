import { createHash } from 'node:crypto';

import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { z } from 'zod';

import type { WorkspaceDb } from '../storage/db.js';
import { WorkerControlGatewayError } from './worker-control-gateway.js';

export const WorkerCapabilityMcpToolSchema = z.object({
  name: z.string().min(1),
  inputSchema: z.record(z.string(), z.unknown()),
});

/** Product-safe MCP tool schema snapshot retained for workspace export and import. */
export interface ExportableMcpToolSchemaSnapshot {
  /** Snapshot capture timestamp. */
  readonly capturedAt: string;
  /** MCP catalog entry id. */
  readonly catalogEntryId: string;
  /** Digest of the tool schema content. */
  readonly contentDigest: string;
  /** Durable schema snapshot id. */
  readonly schemaSnapshotId: string;
  /** Optional server-reported version. */
  readonly serverVersion: string | null;
  /** Snapshot source. */
  readonly source: 'aep' | 'live';
  /** Optional product-safe catalog source reference. */
  readonly sourceRef: string | null;
  /** Product-safe tool schemas captured for validation. */
  readonly tools: z.infer<typeof WorkerCapabilityMcpToolSchema>[];
  /** Workspace that owns the snapshot. */
  readonly workspaceId: string;
}

/**
 * Records the product-safe MCP tool schema snapshot visible to one worker session.
 *
 * @param input Snapshot persistence context.
 */
export function recordMcpToolSchemaSnapshot(input: {
  contentDigest?: string | undefined;
  environmentPackage: AgentEnvironmentPackage;
  schemaSnapshotId: string;
  serverVersion?: string | null | undefined;
  serverId: string;
  source: 'live';
  tools: z.infer<typeof WorkerCapabilityMcpToolSchema>[];
  workspaceDb: WorkspaceDb;
  workspaceId: string;
}): void {
  const server = input.environmentPackage.supply.mcpServers.find(
    (candidate) => candidate.id === input.serverId
  );

  if (!server) {
    throw new WorkerControlGatewayError(
      'mcp-server-unavailable',
      `MCP server is not enabled for this worker session: ${input.serverId}`,
      404
    );
  }

  const toolsJson = JSON.stringify(input.tools);
  const contentDigest = input.contentDigest ?? mcpToolSchemaContentDigest(input.tools);

  input.workspaceDb.sqlite
    .prepare(
      `INSERT OR IGNORE INTO mcp_tool_schema_snapshots (
        snapshot_id,
        workspace_id,
        catalog_entry_id,
        source_ref,
        server_version,
        content_digest,
        tools_json,
        source,
        captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.schemaSnapshotId,
      input.workspaceId,
      server.id,
      null,
      input.serverVersion ?? null,
      contentDigest,
      toolsJson,
      input.source,
      new Date().toISOString()
    );
}

/**
 * Lists all product-safe MCP tool schema snapshots for workspace export.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Schema snapshot records in stable order.
 */
export function listExportableMcpToolSchemaSnapshots(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): ExportableMcpToolSchemaSnapshot[] {
  const rows = workspaceDb.sqlite
    .prepare(
      `SELECT
        snapshot_id,
        workspace_id,
        catalog_entry_id,
        source_ref,
        server_version,
        content_digest,
        tools_json,
        source,
        captured_at
      FROM mcp_tool_schema_snapshots
      WHERE workspace_id = ?
      ORDER BY captured_at ASC, snapshot_id ASC`
    )
    .all(workspaceId) as Array<{
    captured_at: string;
    catalog_entry_id: string;
    content_digest: string;
    snapshot_id: string;
    server_version: string | null;
    source: 'aep' | 'live';
    source_ref: string | null;
    tools_json: string;
    workspace_id: string;
  }>;

  return rows.map((row) => ({
    capturedAt: row.captured_at,
    catalogEntryId: row.catalog_entry_id,
    contentDigest: row.content_digest,
    schemaSnapshotId: row.snapshot_id,
    serverVersion: row.server_version,
    source: row.source,
    sourceRef: row.source_ref,
    tools: z.array(WorkerCapabilityMcpToolSchema).parse(JSON.parse(row.tools_json)),
    workspaceId: row.workspace_id,
  }));
}

/**
 * Replays imported MCP schema snapshots without emitting gateway audit events.
 *
 * @param workspaceDb Open target workspace-scope database handle.
 * @param snapshots MCP schema snapshots to replay.
 */
export function importMcpToolSchemaSnapshots(
  workspaceDb: WorkspaceDb,
  snapshots: readonly ExportableMcpToolSchemaSnapshot[]
): void {
  for (const snapshot of snapshots) {
    workspaceDb.sqlite
      .prepare(
        `INSERT OR IGNORE INTO mcp_tool_schema_snapshots (
          snapshot_id,
          workspace_id,
          catalog_entry_id,
          source_ref,
          server_version,
          content_digest,
          tools_json,
          source,
          captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        snapshot.schemaSnapshotId,
        snapshot.workspaceId,
        snapshot.catalogEntryId,
        snapshot.sourceRef,
        snapshot.serverVersion,
        snapshot.contentDigest,
        JSON.stringify(snapshot.tools),
        snapshot.source,
        snapshot.capturedAt
      );
  }
}

/**
 * Computes the stable content digest for one product-safe MCP tool schema list.
 *
 * @param tools Product-safe tool schemas.
 * @returns Hexadecimal SHA-256 digest.
 */
export function mcpToolSchemaContentDigest(
  tools: Array<{ inputSchema: Record<string, unknown>; name: string }>
): string {
  return createHash('sha256').update(JSON.stringify(tools)).digest('hex');
}

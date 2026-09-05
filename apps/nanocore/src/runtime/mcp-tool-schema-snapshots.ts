import { createHash } from 'node:crypto';

import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { WorkspaceMcpToolNameSchema } from '@openkit/config-schema';
import { z } from 'zod';

import { recordWorkspaceAuditEvent } from '../audit-events.js';
import type { WorkspaceDb } from '../storage/db.js';
import { WorkerControlGatewayError } from './worker-control-gateway.js';

const TRACKING_SNAPSHOT_RETENTION = 8;

export const WorkerCapabilityMcpToolSchema = z.object({
  name: WorkspaceMcpToolNameSchema,
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
  capabilityCallId?: string | undefined;
  environmentPackage: AgentEnvironmentPackage;
  schemaSnapshotId: string;
  serverVersion?: string | null | undefined;
  serverId: string;
  source: 'live';
  tools: z.infer<typeof WorkerCapabilityMcpToolSchema>[];
  workspaceDb: WorkspaceDb;
  workspaceId: string;
}): string {
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

  const tools = canonicalMcpToolSchemas(input.tools);
  const toolsJson = JSON.stringify(tools);
  const contentDigest = mcpToolSchemaContentDigest(tools);

  return input.workspaceDb.sqlite
    .transaction(() => {
      const previous = input.workspaceDb.sqlite
        .prepare(
          `SELECT captured_at
           FROM mcp_tool_schema_snapshots
           WHERE workspace_id = ? AND catalog_entry_id = ? AND source = ?
           ORDER BY captured_at DESC, snapshot_id DESC
           LIMIT 1`
        )
        .get(input.workspaceId, server.id, input.source) as { captured_at: string } | undefined;
      const previousAt = previous ? Date.parse(previous.captured_at) : Number.NaN;
      const capturedAt = new Date(
        Number.isFinite(previousAt) ? Math.max(Date.now(), previousAt + 1) : Date.now()
      );
      const existing = input.workspaceDb.sqlite
        .prepare(
          `SELECT snapshot_id
           FROM mcp_tool_schema_snapshots
           WHERE workspace_id = ?
             AND catalog_entry_id = ?
             AND source = ?
             AND content_digest = ?`
        )
        .get(input.workspaceId, server.id, input.source, contentDigest) as
        | { snapshot_id: string }
        | undefined;
      const inserted = input.workspaceDb.sqlite
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
          capturedAt.toISOString()
        );
      const collision =
        inserted.changes === 0
          ? (input.workspaceDb.sqlite
              .prepare(
                `SELECT snapshot_id, workspace_id, catalog_entry_id, content_digest, tools_json, source
                 FROM mcp_tool_schema_snapshots
                 WHERE snapshot_id = ?`
              )
              .get(input.schemaSnapshotId) as
              | {
                  catalog_entry_id: string;
                  content_digest: string;
                  snapshot_id: string;
                  source: 'aep' | 'live';
                  tools_json: string;
                  workspace_id: string;
                }
              | undefined)
          : undefined;
      let collisionToolsMatch = false;
      if (collision) {
        try {
          collisionToolsMatch =
            JSON.stringify(
              canonicalMcpToolSchemas(
                z.array(WorkerCapabilityMcpToolSchema).parse(JSON.parse(collision.tools_json))
              )
            ) === toolsJson;
        } catch {}
      }
      if (
        collision &&
        (collision.workspace_id !== input.workspaceId ||
          collision.catalog_entry_id !== server.id ||
          collision.content_digest !== contentDigest ||
          !collisionToolsMatch)
      ) {
        throw new Error(`MCP schema snapshot identity conflicts: ${input.schemaSnapshotId}`);
      }
      const schemaSnapshotId =
        existing?.snapshot_id ?? collision?.snapshot_id ?? input.schemaSnapshotId;
      if (existing || collision) {
        input.workspaceDb.sqlite
          .prepare(
            `UPDATE mcp_tool_schema_snapshots
             SET captured_at = ?, server_version = ?, tools_json = ?, source = 'live', source_ref = NULL
             WHERE snapshot_id = ?`
          )
          .run(capturedAt.toISOString(), input.serverVersion ?? null, toolsJson, schemaSnapshotId);
      }
      if (inserted.changes === 1 || collision?.source === 'aep') {
        recordWorkspaceAuditEvent({
          action: 'mcp.schema.capture',
          actor: input.environmentPackage.scope.triggerActor,
          agentId: input.environmentPackage.agent.agentId,
          agentSessionId: input.environmentPackage.scope.agentSessionId,
          capabilityCallId: input.capabilityCallId ?? null,
          category: 'capability',
          occurredAt: capturedAt,
          outcome: 'succeeded',
          resource: `mcp-schema:${schemaSnapshotId}`,
          summary: `Captured MCP tool schema for ${server.id}.`,
          workspaceDb: input.workspaceDb,
          workspaceId: input.workspaceId,
        });
      }

      if (server.schemaPolicy === 'tracking') {
        input.workspaceDb.sqlite
          .prepare(
            `DELETE FROM mcp_tool_schema_snapshots
         WHERE snapshot_id IN (
           SELECT snapshot_id
           FROM mcp_tool_schema_snapshots
           WHERE workspace_id = ?
             AND catalog_entry_id = ?
             AND source = 'live'
             AND snapshot_id NOT IN (
               SELECT schema_snapshot_id
               FROM capability_calls
               WHERE schema_snapshot_id IS NOT NULL
             )
           ORDER BY captured_at DESC, snapshot_id DESC
           LIMIT -1 OFFSET ?
         )`
          )
          .run(input.workspaceId, server.id, TRACKING_SNAPSHOT_RETENTION);
      }
      return schemaSnapshotId;
    })
    .immediate();
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
    const tools = z.array(WorkerCapabilityMcpToolSchema).parse(snapshot.tools);
    if (mcpToolSchemaContentDigest(tools) !== snapshot.contentDigest) {
      throw new Error(`MCP schema snapshot digest mismatch: ${snapshot.schemaSnapshotId}`);
    }
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
        JSON.stringify(canonicalMcpToolSchemas(tools)),
        'aep',
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
  return createHash('sha256')
    .update(JSON.stringify(canonicalMcpToolSchemas(tools)))
    .digest('hex');
}

/** Computes the stable digest for one MCP tool argument object. */
export function mcpToolArgumentsContentDigest(argumentsValue: Record<string, unknown>): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonicalJsonValue(argumentsValue)))
    .digest('hex')}`;
}

/** Reads the current durable schema snapshot used before approval or upstream contact. */
export function readCurrentMcpToolSchemaSnapshot(input: {
  readonly catalogEntryId: string;
  readonly pinnedSchemaSnapshotId: string | null;
  readonly workspaceDb: WorkspaceDb;
  readonly workspaceId: string;
}): Pick<ExportableMcpToolSchemaSnapshot, 'schemaSnapshotId' | 'tools'> | null {
  const row = input.workspaceDb.sqlite
    .prepare(
      `SELECT snapshot_id, tools_json
       FROM mcp_tool_schema_snapshots
       WHERE workspace_id = ?
         AND catalog_entry_id = ?
         AND source = 'live'
         AND (? IS NULL OR snapshot_id = ?)
       ORDER BY captured_at DESC, snapshot_id DESC
       LIMIT 1`
    )
    .get(
      input.workspaceId,
      input.catalogEntryId,
      input.pinnedSchemaSnapshotId,
      input.pinnedSchemaSnapshotId
    ) as { snapshot_id: string; tools_json: string } | undefined;

  return row
    ? {
        schemaSnapshotId: row.snapshot_id,
        tools: z.array(WorkerCapabilityMcpToolSchema).parse(JSON.parse(row.tools_json)),
      }
    : null;
}

/** Canonicalizes tool order and recursive JSON object-key order. */
export function canonicalMcpToolSchemas(
  tools: Array<{ inputSchema: Record<string, unknown>; name: string }>
): Array<{ inputSchema: Record<string, unknown>; name: string }> {
  return tools
    .map((tool) => ({
      inputSchema: canonicalJsonValue(tool.inputSchema) as Record<string, unknown>,
      name: tool.name,
    }))
    .sort((left, right) => compareOrdinal(left.name, right.name));
}

/** Recursively sorts JSON object keys while preserving array order. */
function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareOrdinal(left, right))
      .map(([key, child]) => [key, canonicalJsonValue(child)])
  );
}

/** Compares strings by stable UTF-16 code units without locale state. */
function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

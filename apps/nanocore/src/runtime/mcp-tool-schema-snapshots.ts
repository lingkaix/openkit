import { createHash } from 'node:crypto';

import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { readRetainedV1, writeRetainedV1 } from '@openkit/protocol';
import { z } from 'zod';

import { recordWorkspaceAuditEvent } from '../audit-events.js';
import { WorkerControlGatewayError } from '../operation-error.js';
import type { WorkerCapabilityMcpToolSchema } from '../storage/control-store-input.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { WorkspaceDb } from '../storage/db.js';

const TRACKING_SNAPSHOT_RETENTION = 8;

/** Only the original schema owner facts cross native preparation; the full AEP stays on Main. */
export interface McpToolSchemaEnvironment {
  readonly snapshotId: AgentEnvironmentPackage['snapshotId'];
  readonly scope: Pick<
    AgentEnvironmentPackage['scope'],
    'workspaceId' | 'threadId' | 'turnId' | 'agentSessionId' | 'triggerActor'
  >;
  readonly agent: Pick<AgentEnvironmentPackage['agent'], 'agentId'>;
  readonly supply: {
    readonly mcpServers: readonly Pick<
      AgentEnvironmentPackage['supply']['mcpServers'][number],
      'id' | 'schemaPolicy' | 'pinnedSchemaSnapshotId'
    >[];
  };
}

export { WorkerCapabilityMcpToolSchema } from '../storage/control-store-input.js';

/** Frozen v1 retained Tool meaning; current catalog admission cannot reinterpret captured input schemas. */
const StoredMcpToolV1Schema = z.object({
  name: z
    .string()
    .min(1)
    .max(256)
    .refine((value) => value === value.trim(), 'MCP tool names must not have outer whitespace.'),
  inputSchema: z.record(z.string(), z.unknown()),
});

/** Checks a native row header before decoding its complete retained Tool schemas. */
function readStoredMcpToolsV1(row: {
  readonly schemaVersion: unknown;
  readonly tools_json: string;
}): z.infer<typeof StoredMcpToolV1Schema>[] {
  return readRetainedV1(row, () =>
    z.array(StoredMcpToolV1Schema).parse(JSON.parse(row.tools_json))
  );
}

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
export type RecordMcpToolSchemaSnapshotInput = {
  capabilityCallId?: string | undefined;
  environmentPackage: McpToolSchemaEnvironment;
  schemaSnapshotId: string;
  serverVersion?: string | null | undefined;
  serverId: string;
  source: 'live';
  tools: z.infer<typeof WorkerCapabilityMcpToolSchema>[];
  workspaceDb: WorkspaceDb;
  workspaceId: string;
};

/** Publishes an exact selected-server observation through its existing admitted native Workspace. */
export async function recordMcpToolSchemaSnapshot(
  input: RecordMcpToolSchemaSnapshotInput
): Promise<string> {
  const server = selectMcpToolSchemaServer(input);
  const { workspaceId, threadId, turnId, agentSessionId, triggerActor } =
    input.environmentPackage.scope;
  const result = await getControlStoreWorkerClient().workspaceCapability(input.workspaceDb, {
    kind: 'mcp-schema',
    workspaceId: input.workspaceId,
    callId: input.capabilityCallId,
    schemaSnapshotId: input.schemaSnapshotId,
    serverVersion: input.serverVersion,
    tools: input.tools,
    environmentPackage: {
      snapshotId: input.environmentPackage.snapshotId,
      scope: { workspaceId, threadId, turnId, agentSessionId, triggerActor },
      agent: { agentId: input.environmentPackage.agent.agentId },
      supply: {
        mcpServers: [
          {
            id: server.id,
            schemaPolicy: server.schemaPolicy,
            pinnedSchemaSnapshotId: server.pinnedSchemaSnapshotId,
          },
        ],
      },
    },
  });
  if (!result || typeof result !== 'object' || !('liveSnapshotId' in result))
    throw new TypeError('Invalid native MCP schema snapshot result.');
  return result.liveSnapshotId;
}

/** Applies the original capture body and fixed native Call binding on the caller's savepoint. */
export function recordMcpToolSchemaSnapshotInDb(
  input: RecordMcpToolSchemaSnapshotInput & {
    /** Fixed native binding only; no caller callback crosses the wire. */
    onRecorded?: (schemaSnapshotId: string) => void;
  },
  prepared = prepareMcpToolSchemaSnapshot(input)
): string {
  const { server, toolsJson, contentDigest, previous, reusedSnapshotId } = prepared;
  if (reusedSnapshotId !== null) {
    input.onRecorded?.(reusedSnapshotId);
    return reusedSnapshotId;
  }

  const previousAt = previous ? Date.parse(previous.captured_at) : Number.NaN;
  const capturedAt = new Date(
    Number.isFinite(previousAt) ? Math.max(Date.now(), previousAt + 1) : Date.now()
  );
  const existing = input.workspaceDb.sqlite
    .prepare(
      `SELECT schema_version AS schemaVersion, snapshot_id
       FROM mcp_tool_schema_snapshots
       WHERE workspace_id = ?
         AND catalog_entry_id = ?
         AND source = ?
         AND content_digest = ?`
    )
    .get(input.workspaceId, server.id, input.source, contentDigest) as
    | { schemaVersion: unknown; snapshot_id: string }
    | undefined;
  if (existing) readRetainedV1(existing, () => undefined);
  const inserted = input.workspaceDb.sqlite
    .prepare(
      `INSERT OR IGNORE INTO mcp_tool_schema_snapshots (
        schema_version,
        snapshot_id,
        workspace_id,
        catalog_entry_id,
        source_ref,
        server_version,
        content_digest,
        tools_json,
        source,
        captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      writeRetainedV1({}).schemaVersion,
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
            `SELECT schema_version AS schemaVersion, snapshot_id, workspace_id, catalog_entry_id, content_digest, tools_json, source
             FROM mcp_tool_schema_snapshots
             WHERE snapshot_id = ?`
          )
          .get(input.schemaSnapshotId) as
          | {
              schemaVersion: unknown;
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
    readRetainedV1(collision, () => undefined);
    try {
      collisionToolsMatch =
        JSON.stringify(
          canonicalMcpToolSchemas(
            z.array(StoredMcpToolV1Schema).parse(JSON.parse(collision.tools_json))
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
    const retainedCalls = input.workspaceDb.sqlite
      .prepare('SELECT schema_version FROM capability_calls WHERE schema_snapshot_id IS NOT NULL')
      .all() as { schema_version: number }[];
    for (const call of retainedCalls) {
      readRetainedV1({ schemaVersion: call.schema_version }, () => undefined);
    }
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
  input.onRecorded?.(schemaSnapshotId);
  return schemaSnapshotId;
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
      `SELECT schema_version AS schemaVersion,
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
    schemaVersion: unknown;
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
    tools: readStoredMcpToolsV1(row),
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
    const existing = workspaceDb.sqlite
      .prepare(
        'SELECT schema_version AS schemaVersion FROM mcp_tool_schema_snapshots WHERE snapshot_id=?'
      )
      .get(snapshot.schemaSnapshotId);
    if (existing) readRetainedV1(existing, () => undefined);
    const tools = z.array(StoredMcpToolV1Schema).parse(snapshot.tools);
    if (mcpToolSchemaContentDigest(tools) !== snapshot.contentDigest) {
      throw new Error(`MCP schema snapshot digest mismatch: ${snapshot.schemaSnapshotId}`);
    }
    workspaceDb.sqlite
      .prepare(
        `INSERT OR IGNORE INTO mcp_tool_schema_snapshots (
          schema_version,
          snapshot_id,
          workspace_id,
          catalog_entry_id,
          source_ref,
          server_version,
          content_digest,
          tools_json,
          source,
          captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        writeRetainedV1({}).schemaVersion,
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

/** Reads exact retained approval evidence without treating imported history as current live authority. */
export function readRetainedMcpToolSchemaSnapshot(input: {
  readonly catalogEntryId: string;
  readonly schemaSnapshotId: string;
  readonly workspaceDb: WorkspaceDb;
  readonly workspaceId: string;
}): Pick<ExportableMcpToolSchemaSnapshot, 'schemaSnapshotId' | 'tools'> | null {
  const row = input.workspaceDb.sqlite
    .prepare(
      `SELECT schema_version AS schemaVersion, snapshot_id, tools_json
       FROM mcp_tool_schema_snapshots
       WHERE workspace_id = ? AND catalog_entry_id = ? AND snapshot_id = ?
         AND source IN ('aep', 'live')`
    )
    .get(input.workspaceId, input.catalogEntryId, input.schemaSnapshotId) as
    | { schemaVersion: unknown; snapshot_id: string; tools_json: string }
    | undefined;

  return row
    ? {
        schemaSnapshotId: row.snapshot_id,
        tools: readStoredMcpToolsV1(row),
      }
    : null;
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
      `SELECT schema_version AS schemaVersion, snapshot_id, tools_json
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
    ) as { schemaVersion: unknown; snapshot_id: string; tools_json: string } | undefined;

  return row
    ? {
        schemaSnapshotId: row.snapshot_id,
        tools: readStoredMcpToolsV1(row),
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

/** Reads the exact live schema already selected for this Turn through its capability calls. */
export function readTurnMcpToolSchemaSnapshot(input: {
  readonly environmentPackage: Pick<McpToolSchemaEnvironment, 'scope' | 'snapshotId'>;
  readonly selected: McpToolSchemaEnvironment['supply']['mcpServers'][number];
  readonly workspaceDb: WorkspaceDb;
}): ReturnType<typeof readCurrentMcpToolSchemaSnapshot> {
  const scope = input.environmentPackage.scope;
  const bound = input.workspaceDb.sqlite
    .prepare(`
    SELECT schema_version AS schemaVersion, schema_snapshot_id FROM capability_calls
    WHERE workspace_id = ? AND thread_id = ? AND turn_id = ?
      AND agent_session_id = ? AND package_snapshot_id = ?
      AND family = 'mcp' AND provider_ref = ?
      AND operation IN ('mcp.list-tools', 'mcp.call-tool')
      AND schema_snapshot_id IS NOT NULL
    ORDER BY started_at, call_id LIMIT 1
  `)
    .get(
      scope.workspaceId,
      scope.threadId,
      scope.turnId,
      scope.agentSessionId,
      input.environmentPackage.snapshotId,
      input.selected.id
    ) as { schemaVersion: unknown; schema_snapshot_id: string } | undefined;
  if (!bound) return null;
  readRetainedV1(bound, () => bound);
  const snapshot = readCurrentMcpToolSchemaSnapshot({
    catalogEntryId: input.selected.id,
    pinnedSchemaSnapshotId: bound.schema_snapshot_id,
    workspaceDb: input.workspaceDb,
    workspaceId: scope.workspaceId,
  });
  if (
    !snapshot ||
    (input.selected.schemaPolicy === 'pinned' &&
      snapshot.schemaSnapshotId !== input.selected.pinnedSchemaSnapshotId)
  ) {
    throw new WorkerControlGatewayError(
      'mcp-schema-drift',
      'MCP Turn tool schema is unavailable.',
      409
    );
  }
  return snapshot;
}

/** Selects the original enabled server before projecting its exact native frame. */
function selectMcpToolSchemaServer(
  input: Pick<RecordMcpToolSchemaSnapshotInput, 'environmentPackage' | 'serverId'>
) {
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
  return server;
}

/** The original latest-observation/collision decision, shared by capture and native no-write prefix. */
export function prepareMcpToolSchemaSnapshot(input: RecordMcpToolSchemaSnapshotInput) {
  const server = selectMcpToolSchemaServer(input);

  const tools = canonicalMcpToolSchemas(input.tools);
  const toolsJson = JSON.stringify(tools);
  const contentDigest = mcpToolSchemaContentDigest(tools);
  const previous = input.workspaceDb.sqlite
    .prepare(
      `SELECT schema_version AS schemaVersion, captured_at, snapshot_id, content_digest,
                  server_version, tools_json, source_ref
           FROM mcp_tool_schema_snapshots
           WHERE workspace_id = ? AND catalog_entry_id = ? AND source = ?
           ORDER BY captured_at DESC, snapshot_id DESC
           LIMIT 1`
    )
    .get(input.workspaceId, server.id, input.source) as
    | {
        schemaVersion: unknown;
        captured_at: string;
        snapshot_id: string;
        content_digest: string;
        server_version: string | null;
        tools_json: string;
        source_ref: string | null;
      }
    | undefined;
  if (previous) readRetainedV1(previous, () => undefined);
  if (
    previous &&
    previous.content_digest === contentDigest &&
    previous.server_version === (input.serverVersion ?? null) &&
    previous.source_ref === null &&
    JSON.stringify(canonicalMcpToolSchemas(readStoredMcpToolsV1(previous))) === toolsJson
  ) {
    // A different proposed ID must still pass the existing identity-conflict boundary.
    const collision = input.workspaceDb.sqlite
      .prepare(
        'SELECT content_digest FROM mcp_tool_schema_snapshots WHERE snapshot_id = ? AND snapshot_id <> ?'
      )
      .get(input.schemaSnapshotId, previous.snapshot_id) as { content_digest: string } | undefined;
    if (collision) {
      const retained = readRetainedMcpToolSchemaSnapshot({
        catalogEntryId: server.id,
        schemaSnapshotId: input.schemaSnapshotId,
        workspaceDb: input.workspaceDb,
        workspaceId: input.workspaceId,
      });
      if (
        !retained ||
        collision.content_digest !== contentDigest ||
        JSON.stringify(canonicalMcpToolSchemas(retained.tools)) !== toolsJson
      )
        throw new Error(`MCP schema snapshot identity conflicts: ${input.schemaSnapshotId}`);
    }
    return { server, toolsJson, contentDigest, previous, reusedSnapshotId: previous.snapshot_id };
  }

  return { server, toolsJson, contentDigest, previous, reusedSnapshotId: null };
}

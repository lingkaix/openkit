import type { WorkspaceDb } from '../storage/db.js';
import type { ResolvedAgentSetup } from './setup-resolver.js';

/** Durable workspace-scoped resolved setup record. */
export interface ResolvedAgentSetupRecord {
  /** Durable setup record id. */
  readonly id: string;
  /** Workspace that owns the record. */
  readonly workspaceId: string;
  /** Turn that used this setup, when known. */
  readonly turnId: string | null;
  /** Request that produced this setup, when known. */
  readonly requestId: string | null;
  /** Resolved agent id. */
  readonly agentId: string;
  /** Resolved provider id, when configured. */
  readonly providerId: string | null;
  /** Runtime family. */
  readonly runtimeKind: string;
  /** Runtime adapter id. */
  readonly runtimeAdapter: string;
  /** Required feature ids preserved by resolution. */
  readonly requiredFeatures: string[];
  /** Redacted resolved setup payload. */
  readonly setup: ResolvedAgentSetup;
  /** Creation timestamp. */
  readonly createdAt: string;
}

/** Input for recording one resolved setup. */
export interface RecordResolvedAgentSetupInput {
  /** Durable setup record id. */
  readonly recordId: string;
  /** Workspace that owns the record. */
  readonly workspaceId: string;
  /** Turn that used this setup, when known. */
  readonly turnId?: string | null;
  /** Request that produced this setup, when known. */
  readonly requestId?: string | null;
  /** Resolved setup to persist. */
  readonly setup: ResolvedAgentSetup;
  /** Creation timestamp. */
  readonly createdAt: string;
}

interface ResolvedAgentSetupRow {
  readonly setup_record_id: string;
  readonly workspace_id: string;
  readonly turn_id: string | null;
  readonly request_id: string | null;
  readonly agent_id: string;
  readonly provider_id: string | null;
  readonly runtime_kind: string;
  readonly runtime_adapter: string;
  readonly required_features_json: string;
  readonly setup_json: string;
  readonly created_at: string;
}

/**
 * Persists one redacted resolved agent setup in the workspace ledger.
 *
 * @param workspaceDb Open workspace database.
 * @param input Resolved setup record input.
 * @returns Stored record.
 */
export function recordResolvedAgentSetup(
  workspaceDb: WorkspaceDb,
  input: RecordResolvedAgentSetupInput
): ResolvedAgentSetupRecord {
  workspaceDb.sqlite
    .prepare(
      `INSERT OR REPLACE INTO resolved_agent_setups (
        setup_record_id,
        workspace_id,
        turn_id,
        request_id,
        agent_id,
        provider_id,
        runtime_kind,
        runtime_adapter,
        required_features_json,
        setup_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.recordId,
      input.workspaceId,
      input.turnId ?? null,
      input.requestId ?? null,
      input.setup.agent.id,
      input.setup.provider?.providerId ?? null,
      input.setup.runtime.kind,
      input.setup.runtime.adapter,
      JSON.stringify(input.setup.requiredFeatures),
      JSON.stringify(input.setup),
      input.createdAt
    );

  return requireResolvedAgentSetup(workspaceDb, input.workspaceId, input.recordId);
}

/**
 * Reads one resolved setup record or throws when missing.
 *
 * @param workspaceDb Open workspace database.
 * @param workspaceId Workspace id.
 * @param recordId Setup record id.
 * @returns Stored record.
 */
export function requireResolvedAgentSetup(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  recordId: string
): ResolvedAgentSetupRecord {
  const row = workspaceDb.sqlite
    .prepare(
      `SELECT
        setup_record_id,
        workspace_id,
        turn_id,
        request_id,
        agent_id,
        provider_id,
        runtime_kind,
        runtime_adapter,
        required_features_json,
        setup_json,
        created_at
       FROM resolved_agent_setups
       WHERE workspace_id = ? AND setup_record_id = ?`
    )
    .get(workspaceId, recordId) as ResolvedAgentSetupRow | undefined;

  if (!row) {
    throw new Error(`Resolved agent setup not found: ${recordId}`);
  }

  return resolvedAgentSetupFromRow(row);
}

/**
 * Lists resolved setup records for workspace export.
 *
 * @param workspaceDb Open workspace database.
 * @param workspaceId Workspace id.
 * @returns Exportable setup records in stable storage order.
 */
export function listExportableResolvedAgentSetups(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): ResolvedAgentSetupRecord[] {
  return (
    workspaceDb.sqlite
      .prepare(
        `SELECT
          setup_record_id,
          workspace_id,
          turn_id,
          request_id,
          agent_id,
          provider_id,
          runtime_kind,
          runtime_adapter,
          required_features_json,
          setup_json,
          created_at
         FROM resolved_agent_setups
         WHERE workspace_id = ?
         ORDER BY created_at ASC, setup_record_id ASC`
      )
      .all(workspaceId) as ResolvedAgentSetupRow[]
  ).map(resolvedAgentSetupFromRow);
}

/**
 * Replays exported resolved setup records into an imported workspace.
 *
 * @param workspaceDb Open target workspace database.
 * @param records Exported records already rewritten to the target workspace id.
 */
export function importResolvedAgentSetups(
  workspaceDb: WorkspaceDb,
  records: readonly ResolvedAgentSetupRecord[]
): void {
  const insert = workspaceDb.sqlite.prepare(
    `INSERT OR IGNORE INTO resolved_agent_setups (
      setup_record_id,
      workspace_id,
      turn_id,
      request_id,
      agent_id,
      provider_id,
      runtime_kind,
      runtime_adapter,
      required_features_json,
      setup_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const record of records) {
    insert.run(
      record.id,
      record.workspaceId,
      record.turnId,
      record.requestId,
      record.agentId,
      record.providerId,
      record.runtimeKind,
      record.runtimeAdapter,
      JSON.stringify(record.requiredFeatures),
      JSON.stringify(record.setup),
      record.createdAt
    );
  }
}

/**
 * Maps one database row to a resolved setup record.
 *
 * @param row Resolved setup row.
 * @returns Parsed resolved setup record.
 */
function resolvedAgentSetupFromRow(row: ResolvedAgentSetupRow): ResolvedAgentSetupRecord {
  return {
    id: row.setup_record_id,
    workspaceId: row.workspace_id,
    turnId: row.turn_id,
    requestId: row.request_id,
    agentId: row.agent_id,
    providerId: row.provider_id,
    runtimeKind: row.runtime_kind,
    runtimeAdapter: row.runtime_adapter,
    requiredFeatures: JSON.parse(row.required_features_json) as string[],
    setup: JSON.parse(row.setup_json) as ResolvedAgentSetup,
    createdAt: row.created_at,
  };
}

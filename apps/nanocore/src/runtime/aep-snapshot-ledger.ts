import { createHash } from 'node:crypto';
import {
  type AgentEnvironmentPackage,
  redactAgentEnvironmentPackageSnapshot,
} from '@openkit/config-schema';
import type { WorkspaceDb } from '../storage/db.js';

/** Durable workspace-owned AEP snapshot record. */
export interface AgentEnvironmentPackageSnapshotRecord {
  /** AEP snapshot id. */
  readonly snapshotId: string;
  /** Workspace that owns the snapshot. */
  readonly workspaceId: string;
  /** Turn that launched from the snapshot. */
  readonly turnId: string;
  /** Thread that owns the turn. */
  readonly threadId: string;
  /** Agent session that launched from the snapshot. */
  readonly agentSessionId: string;
  /** Worker agent id. */
  readonly agentId: string;
  /** AEP package id. */
  readonly packageId: string;
  /** Runtime kind selected by AEP resolution. */
  readonly runtimeKind: string;
  /** Backend kind selected by AEP resolution. */
  readonly backendKind: string;
  /** Digest of the redacted snapshot JSON. */
  readonly contentDigest: string;
  /** Redacted immutable AEP snapshot. */
  readonly snapshot: AgentEnvironmentPackage;
  /** Record creation timestamp. */
  readonly createdAt: string;
}

/** Input for recording an AEP snapshot. */
export interface RecordAgentEnvironmentPackageSnapshotInput {
  /** Full parsed AEP snapshot. The helper stores only its redacted form. */
  readonly environmentPackage: AgentEnvironmentPackage;
  /** Record creation timestamp. */
  readonly createdAt: string;
}

interface AgentEnvironmentPackageSnapshotRow {
  readonly snapshot_id: string;
  readonly workspace_id: string;
  readonly turn_id: string;
  readonly thread_id: string;
  readonly agent_session_id: string;
  readonly agent_id: string;
  readonly package_id: string;
  readonly runtime_kind: string;
  readonly backend_kind: string;
  readonly content_digest: string;
  readonly snapshot_json: string;
  readonly created_at: string;
}

/**
 * Persists one immutable, redacted AEP snapshot in the workspace ledger.
 *
 * @param workspaceDb Open workspace database.
 * @param input AEP snapshot input.
 * @returns Stored snapshot record.
 */
export function recordAgentEnvironmentPackageSnapshot(
  workspaceDb: WorkspaceDb,
  input: RecordAgentEnvironmentPackageSnapshotInput
): AgentEnvironmentPackageSnapshotRecord {
  const snapshot = redactAgentEnvironmentPackageSnapshot(input.environmentPackage);
  const snapshotJson = JSON.stringify(snapshot);
  const contentDigest = createHash('sha256').update(snapshotJson).digest('hex');

  workspaceDb.sqlite
    .prepare(
      `INSERT OR IGNORE INTO agent_environment_package_snapshots (
        snapshot_id,
        workspace_id,
        turn_id,
        thread_id,
        agent_session_id,
        agent_id,
        package_id,
        runtime_kind,
        backend_kind,
        content_digest,
        snapshot_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      snapshot.snapshotId,
      snapshot.scope.workspaceId,
      snapshot.scope.turnId,
      snapshot.scope.threadId,
      snapshot.scope.agentSessionId,
      snapshot.agent.agentId,
      snapshot.packageId,
      snapshot.agent.runtimeKind,
      snapshot.backend.preferred,
      contentDigest,
      snapshotJson,
      input.createdAt
    );

  return requireAgentEnvironmentPackageSnapshot(
    workspaceDb,
    snapshot.scope.workspaceId,
    snapshot.snapshotId
  );
}

/**
 * Reads one durable AEP snapshot record or throws when missing.
 *
 * @param workspaceDb Open workspace database.
 * @param workspaceId Workspace id.
 * @param snapshotId AEP snapshot id.
 * @returns Stored AEP snapshot record.
 */
export function requireAgentEnvironmentPackageSnapshot(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  snapshotId: string
): AgentEnvironmentPackageSnapshotRecord {
  const row = workspaceDb.sqlite
    .prepare(
      `SELECT
        snapshot_id,
        workspace_id,
        turn_id,
        thread_id,
        agent_session_id,
        agent_id,
        package_id,
        runtime_kind,
        backend_kind,
        content_digest,
        snapshot_json,
        created_at
       FROM agent_environment_package_snapshots
       WHERE workspace_id = ? AND snapshot_id = ?`
    )
    .get(workspaceId, snapshotId) as AgentEnvironmentPackageSnapshotRow | undefined;

  if (!row) {
    throw new Error(`Agent environment package snapshot not found: ${snapshotId}`);
  }

  return agentEnvironmentPackageSnapshotFromRow(row);
}

/**
 * Lists redacted AEP snapshots for workspace export.
 *
 * @param workspaceDb Open workspace database.
 * @param workspaceId Workspace id.
 * @returns Exportable snapshot records in stable storage order.
 */
export function listExportableAgentEnvironmentPackageSnapshots(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): AgentEnvironmentPackageSnapshotRecord[] {
  return (
    workspaceDb.sqlite
      .prepare(
        `SELECT
          snapshot_id,
          workspace_id,
          turn_id,
          thread_id,
          agent_session_id,
          agent_id,
          package_id,
          runtime_kind,
          backend_kind,
          content_digest,
          snapshot_json,
          created_at
         FROM agent_environment_package_snapshots
         WHERE workspace_id = ?
         ORDER BY created_at ASC, snapshot_id ASC`
      )
      .all(workspaceId) as AgentEnvironmentPackageSnapshotRow[]
  ).map(agentEnvironmentPackageSnapshotFromRow);
}

/**
 * Replays exported redacted AEP snapshots into an imported workspace.
 *
 * @param workspaceDb Open target workspace database.
 * @param records Exported records already rewritten to the target workspace id.
 */
export function importAgentEnvironmentPackageSnapshots(
  workspaceDb: WorkspaceDb,
  records: readonly AgentEnvironmentPackageSnapshotRecord[]
): void {
  const insert = workspaceDb.sqlite.prepare(
    `INSERT OR IGNORE INTO agent_environment_package_snapshots (
      snapshot_id,
      workspace_id,
      turn_id,
      thread_id,
      agent_session_id,
      agent_id,
      package_id,
      runtime_kind,
      backend_kind,
      content_digest,
      snapshot_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const record of records) {
    insert.run(
      record.snapshotId,
      record.workspaceId,
      record.turnId,
      record.threadId,
      record.agentSessionId,
      record.agentId,
      record.packageId,
      record.runtimeKind,
      record.backendKind,
      record.contentDigest,
      JSON.stringify(record.snapshot),
      record.createdAt
    );
  }
}

/**
 * Maps one database row to a redacted AEP snapshot record.
 *
 * @param row AEP snapshot row.
 * @returns Parsed snapshot record.
 */
function agentEnvironmentPackageSnapshotFromRow(
  row: AgentEnvironmentPackageSnapshotRow
): AgentEnvironmentPackageSnapshotRecord {
  return {
    snapshotId: row.snapshot_id,
    workspaceId: row.workspace_id,
    turnId: row.turn_id,
    threadId: row.thread_id,
    agentSessionId: row.agent_session_id,
    agentId: row.agent_id,
    packageId: row.package_id,
    runtimeKind: row.runtime_kind,
    backendKind: row.backend_kind,
    contentDigest: row.content_digest,
    snapshot: JSON.parse(row.snapshot_json) as AgentEnvironmentPackage,
    createdAt: row.created_at,
  };
}

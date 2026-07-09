import {
  type WorkspaceSyncEvidenceBundle,
  WorkspaceSyncEvidenceBundleSchema,
} from '@openkit/app-api-schemas';
import type { WorkspaceDb } from '../storage/db.js';

interface WorkspaceSyncEvidenceBundleRow {
  readonly payload_json: string;
}

/** Exportable workspace synchronization evidence bundle. */
export interface ExportedWorkspaceSyncEvidenceBundle extends WorkspaceSyncEvidenceBundle {}

/**
 * Persists one durable workspace synchronization evidence bundle.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param record Evidence linkage record to persist.
 * @returns Stored public workspace synchronization evidence bundle.
 */
export function recordWorkspaceSyncEvidenceBundle(
  workspaceDb: WorkspaceDb,
  record: WorkspaceSyncEvidenceBundle
): WorkspaceSyncEvidenceBundle {
  const parsed = WorkspaceSyncEvidenceBundleSchema.parse(record);
  workspaceDb.sqlite
    .prepare(
      `INSERT INTO workspace_sync_evidence_bundles (
        sync_evidence_bundle_id,
        workspace_id,
        payload_json,
        created_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_id, sync_evidence_bundle_id) DO UPDATE SET
        payload_json = excluded.payload_json,
        created_at = excluded.created_at`
    )
    .run(parsed.id, parsed.workspaceId, JSON.stringify(parsed), parsed.createdAt);

  return parsed;
}

/**
 * Lists durable workspace synchronization evidence bundles for one workspace.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Stored evidence linkage records in newest-first order.
 */
export function listWorkspaceSyncEvidenceBundles(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): WorkspaceSyncEvidenceBundle[] {
  return (
    workspaceDb.sqlite
      .prepare(
        `SELECT payload_json
         FROM workspace_sync_evidence_bundles
         WHERE workspace_id = ?
         ORDER BY created_at ASC, sync_evidence_bundle_id ASC`
      )
      .all(workspaceId) as WorkspaceSyncEvidenceBundleRow[]
  )
    .map((row) => WorkspaceSyncEvidenceBundleSchema.parse(JSON.parse(row.payload_json) as unknown))
    .reverse();
}

/**
 * Lists durable workspace synchronization evidence bundles for export in stable order.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Exportable evidence linkage records in oldest-first order.
 */
export function listExportableWorkspaceSyncEvidenceBundles(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): ExportedWorkspaceSyncEvidenceBundle[] {
  return [...listWorkspaceSyncEvidenceBundles(workspaceDb, workspaceId)].reverse();
}

/**
 * Replays imported workspace synchronization evidence bundles.
 *
 * @param workspaceDb Open target workspace database handle.
 * @param records Exported evidence linkage records to replay.
 */
export function importWorkspaceSyncEvidenceBundles(
  workspaceDb: WorkspaceDb,
  records: readonly ExportedWorkspaceSyncEvidenceBundle[]
): void {
  for (const record of records) {
    recordWorkspaceSyncEvidenceBundle(workspaceDb, WorkspaceSyncEvidenceBundleSchema.parse(record));
  }
}

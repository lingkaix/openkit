import {
  type WorkspaceQuarantineRecord,
  WorkspaceQuarantineRecordSchema,
} from '@openkit/app-api-schemas';
import type { WorkspaceDb } from '../storage/db.js';

interface WorkspaceQuarantineRecordRow {
  readonly payload_json: string;
}

/**
 * Persists one durable workspace quarantine record.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param record Quarantine record to persist.
 * @returns Stored public workspace quarantine record.
 */
export function recordWorkspaceQuarantineRecord(
  workspaceDb: WorkspaceDb,
  record: WorkspaceQuarantineRecord
): WorkspaceQuarantineRecord {
  const parsed = WorkspaceQuarantineRecordSchema.parse(record);
  workspaceDb.sqlite
    .prepare(
      `INSERT INTO workspace_quarantine_records (
        quarantine_record_id,
        workspace_id,
        failure_kind,
        resolution,
        payload_json,
        created_at,
        updated_at,
        resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, quarantine_record_id) DO UPDATE SET
        failure_kind = excluded.failure_kind,
        resolution = excluded.resolution,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at,
        resolved_at = excluded.resolved_at`
    )
    .run(
      parsed.id,
      parsed.workspaceId,
      parsed.failureKind,
      parsed.resolution,
      JSON.stringify(parsed),
      parsed.createdAt,
      parsed.updatedAt,
      parsed.resolvedAt
    );

  return parsed;
}

/**
 * Lists durable workspace quarantine records for one workspace.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Stored quarantine records in newest-first order.
 */
export function listWorkspaceQuarantineRecords(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): WorkspaceQuarantineRecord[] {
  return (
    workspaceDb.sqlite
      .prepare(
        `SELECT payload_json
         FROM workspace_quarantine_records
         WHERE workspace_id = ?
         ORDER BY created_at ASC, quarantine_record_id ASC`
      )
      .all(workspaceId) as WorkspaceQuarantineRecordRow[]
  )
    .map((row) => WorkspaceQuarantineRecordSchema.parse(JSON.parse(row.payload_json) as unknown))
    .reverse();
}

/**
 * Lists durable workspace quarantine records for export in stable order.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Exportable quarantine records in oldest-first order.
 */
export function listExportableWorkspaceQuarantineRecords(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): WorkspaceQuarantineRecord[] {
  return [...listWorkspaceQuarantineRecords(workspaceDb, workspaceId)].reverse();
}

/**
 * Replays imported workspace quarantine records.
 *
 * @param workspaceDb Open target workspace database handle.
 * @param records Exported quarantine records to replay.
 */
export function importWorkspaceQuarantineRecords(
  workspaceDb: WorkspaceDb,
  records: readonly WorkspaceQuarantineRecord[]
): void {
  for (const record of records) {
    recordWorkspaceQuarantineRecord(workspaceDb, WorkspaceQuarantineRecordSchema.parse(record));
  }
}

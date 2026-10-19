import {
  type WorkspaceQuarantineRecord,
  WorkspaceQuarantineRecordSchema,
} from '@openkit/app-api-schemas';
import { readRetainedV1, writeRetainedV1 } from '@openkit/protocol';
import type { WorkspaceDb } from '../storage/db.js';
import { StoredWorkspaceQuarantineRecordV1Schema } from './workspace-sync-outcomes-v1.js';

interface WorkspaceQuarantineRecordRow {
  readonly schemaVersion: unknown;
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
  return persistWorkspaceQuarantineRecordV1(
    workspaceDb,
    WorkspaceQuarantineRecordSchema.parse(record)
  );
}

/** Persists validated current or imported v1 payloads without replacing an unsupported format. */
function persistWorkspaceQuarantineRecordV1(
  workspaceDb: WorkspaceDb,
  record: WorkspaceQuarantineRecord
): WorkspaceQuarantineRecord {
  const parsed = StoredWorkspaceQuarantineRecordV1Schema.parse(record);
  const existing = workspaceDb.sqlite
    .prepare(
      'SELECT schema_version AS schemaVersion FROM workspace_quarantine_records WHERE workspace_id=? AND quarantine_record_id=?'
    )
    .get(parsed.workspaceId, parsed.id);
  if (existing) readRetainedV1(existing, () => undefined);
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
        resolved_at,
        schema_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, quarantine_record_id) DO UPDATE SET
        failure_kind = excluded.failure_kind,
        resolution = excluded.resolution,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at,
        resolved_at = excluded.resolved_at,
        schema_version = excluded.schema_version`
    )
    .run(
      parsed.id,
      parsed.workspaceId,
      parsed.failureKind,
      parsed.resolution,
      JSON.stringify(parsed),
      parsed.createdAt,
      parsed.updatedAt,
      parsed.resolvedAt,
      writeRetainedV1({}).schemaVersion
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
        `SELECT schema_version AS schemaVersion,payload_json
         FROM workspace_quarantine_records
         WHERE workspace_id = ?
         ORDER BY created_at ASC, quarantine_record_id ASC`
      )
      .all(workspaceId) as WorkspaceQuarantineRecordRow[]
  )
    .map((row) =>
      readRetainedV1(row, () =>
        StoredWorkspaceQuarantineRecordV1Schema.parse(JSON.parse(row.payload_json))
      )
    )
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
    persistWorkspaceQuarantineRecordV1(
      workspaceDb,
      StoredWorkspaceQuarantineRecordV1Schema.parse(record)
    );
  }
}

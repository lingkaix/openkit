import type { WorkspaceReconciliationRecord } from '@openkit/app-api-schemas';
import { readRetainedV1 } from '@openkit/protocol';
import type { WorkspaceDb } from '../storage/db.js';
import { StoredWorkspaceReconciliationRecordV1Schema } from './workspace-sync-outcomes-v1.js';

/**
 * Lists durable workspace reconciliation records for one workspace.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Stored reconciliation records in newest-first order.
 */
export function listWorkspaceReconciliationRecords(
  workspaceDb: Pick<WorkspaceDb, 'sqlite'>,
  workspaceId: string
): WorkspaceReconciliationRecord[] {
  return (
    workspaceDb.sqlite
      .prepare(
        `SELECT schema_version AS schemaVersion,payload_json
         FROM workspace_reconciliation_records
         WHERE workspace_id = ?
         ORDER BY started_at ASC, reconciliation_record_id ASC`
      )
      .all(workspaceId) as Array<{ schemaVersion: unknown; payload_json: string }>
  )
    .map((row) =>
      readRetainedV1(row, () =>
        StoredWorkspaceReconciliationRecordV1Schema.parse(JSON.parse(row.payload_json))
      )
    )
    .reverse();
}

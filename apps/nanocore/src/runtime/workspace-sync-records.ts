import { BackendWorkspaceHandleReaderSchema } from '@openkit/app-api-schemas';
import { readRetainedV1 } from '@openkit/protocol';

export {
  listBackendWorkspaceHandles,
  listWorkspaceInputSnapshots,
  listWorkspaceMaterializationRecords,
  requireCompleteBackendWorkspaceHandleHandoff,
} from '../storage/workspace-handoff-read.js';

import {
  listBackendWorkspaceHandles,
  listPayloadRows,
  listWorkspaceInputSnapshots,
  listWorkspaceMaterializationRecords,
} from '../storage/workspace-handoff-read.js';

export {
  type RecordWorkspaceSyncReviewInput,
  recordWorkerOutputManifest,
  recordWorkspaceSyncReview,
} from '../storage/workspace-stage-review-records.js';

import {
  recordWorkspaceInputSnapshot,
  recordWorkspaceMaterializationRecord,
} from '../storage/workspace-materialization-records.js';
import { listWorkspaceSyncReviews } from '../storage/workspace-review-records.js';

export {
  getWorkspaceSyncReview,
  listWorkspaceSyncReviews,
  parseWorkspaceSyncReviewItem,
  type UpdateWorkspaceSyncReviewDecisionInput,
  updateWorkspaceSyncReviewDecision,
} from '../storage/workspace-review-records.js';

import {
  type BackendWorkspaceHandle,
  BackendWorkspaceHandleSchema,
  type StagedWorkspaceReview,
  type WorkerOutputManifest,
  WorkerOutputManifestReaderSchema,
  type WorkspaceChangeSet,
  WorkspaceChangeSetReaderSchema,
  type WorkspaceInputSnapshot,
  type WorkspaceMaterializationRecord,
  type WorkspaceSyncReviewPatchPayload,
} from '@openkit/app-api-schemas';
import type { WorkspaceDb } from '../storage/db.js';

/** Exported staged review row without duplicating its backing change set. */
export interface ExportedStagedWorkspaceReview {
  /** Artifact id that carries review artifacts. */
  readonly artifactId: string;
  /** Stored staged review payload. */
  readonly review: StagedWorkspaceReview;
  /** Optional redacted patch payload retained for review UX. */
  readonly patchPayload: WorkspaceSyncReviewPatchPayload | null;
}

/** Complete workspace sync row-family bundle for export. */
export interface ExportableWorkspaceSyncRecords {
  /** Durable input snapshots. */
  readonly inputSnapshots: readonly WorkspaceInputSnapshot[];
  /** Durable materialization records. */
  readonly materializationRecords: readonly WorkspaceMaterializationRecord[];
  /** Durable redacted backend workspace handles. */
  readonly backendWorkspaceHandles: readonly BackendWorkspaceHandle[];
  /** Durable worker output manifests. */
  readonly workerOutputManifests: readonly WorkerOutputManifest[];
  /** Durable worker-produced change sets. */
  readonly changeSets: readonly WorkspaceChangeSet[];
  /** Durable staged review rows. */
  readonly stagedReviews: readonly ExportedStagedWorkspaceReview[];
}

/**
 * Persists durable workspace input snapshots.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param snapshots Input snapshots to persist.
 * @returns Stored input snapshots.
 */
export function recordWorkspaceInputSnapshots(
  workspaceDb: Pick<WorkspaceDb, 'sqlite'>,
  snapshots: readonly WorkspaceInputSnapshot[]
): WorkspaceInputSnapshot[] {
  return snapshots.map((snapshot) => recordWorkspaceInputSnapshot(workspaceDb, snapshot));
}

/**
 * Persists durable workspace materialization records.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param records Materialization records to persist.
 * @returns Stored materialization records.
 */
export function recordWorkspaceMaterializationRecords(
  workspaceDb: WorkspaceDb,
  records: readonly WorkspaceMaterializationRecord[]
): WorkspaceMaterializationRecord[] {
  return workspaceDb.sqlite.transaction(() =>
    records.map((record) => recordWorkspaceMaterializationRecord(workspaceDb, record))
  )();
}

/**
 * Lists durable workspace change sets for one workspace.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Stored change sets in newest-first order.
 */
export function listWorkspaceChangeSets(
  workspaceDb: Pick<WorkspaceDb, 'sqlite'>,
  workspaceId: string
): WorkspaceChangeSet[] {
  return listPayloadRows(
    workspaceDb,
    'workspace_change_sets',
    workspaceId,
    WorkspaceChangeSetReaderSchema
  );
}

/**
 * Lists durable worker output manifests for one workspace.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Stored output manifests in newest-first order.
 */
export function listWorkerOutputManifests(
  workspaceDb: Pick<WorkspaceDb, 'sqlite'>,
  workspaceId: string
): WorkerOutputManifest[] {
  return listPayloadRows(
    workspaceDb,
    'worker_output_manifests',
    workspaceId,
    WorkerOutputManifestReaderSchema
  );
}

/**
 * Lists the full workspace synchronization row family in dependency order.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Exportable workspace sync row bundle.
 */
export function listExportableWorkspaceSyncRecords(
  workspaceDb: Pick<WorkspaceDb, 'sqlite'>,
  workspaceId: string
): ExportableWorkspaceSyncRecords {
  return {
    inputSnapshots: [...listWorkspaceInputSnapshots(workspaceDb, workspaceId)].reverse(),
    materializationRecords: [
      ...listWorkspaceMaterializationRecords(workspaceDb, workspaceId),
    ].reverse(),
    backendWorkspaceHandles: [...listBackendWorkspaceHandles(workspaceDb, workspaceId)].reverse(),
    workerOutputManifests: [...listWorkerOutputManifests(workspaceDb, workspaceId)].reverse(),
    changeSets: [...listWorkspaceChangeSets(workspaceDb, workspaceId)].reverse(),
    stagedReviews: [...listWorkspaceSyncReviews(workspaceDb, workspaceId)]
      .reverse()
      .map((item) => ({
        artifactId: item.artifactId,
        patchPayload: item.patchPayload,
        review: item.review,
      })),
  };
}

/**
 * Updates backend workspace handle cleanup status for one AEP package.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @param packageSnapshotId AEP package snapshot id stored on backend handles.
 * @param cleanupStatus New cleanup status.
 * @param updatedAt Update timestamp.
 * @returns Updated backend handles in stable order.
 */
export function updateBackendWorkspaceHandleCleanupStatus(
  workspaceDb: Pick<WorkspaceDb, 'sqlite'>,
  workspaceId: string,
  packageSnapshotId: string,
  cleanupStatus: BackendWorkspaceHandle['cleanupStatus'],
  updatedAt: string
): BackendWorkspaceHandle[] {
  const rows = workspaceDb.sqlite
    .prepare(
      `SELECT schema_version AS schemaVersion, payload_json
       FROM backend_workspace_handles
       WHERE workspace_id = ? AND package_snapshot_id = ?
       ORDER BY created_at ASC, backend_workspace_handle_id ASC`
    )
    .all(workspaceId, packageSnapshotId) as Array<{ schemaVersion: unknown; payload_json: string }>;
  const resolved = rows.map((row) => {
    const handle = BackendWorkspaceHandleReaderSchema.parse(
      readRetainedV1(row, () => JSON.parse(row.payload_json)) as unknown
    );
    const effectiveCleanupStatus =
      cleanupStatus === 'retained' && ['cleaned', 'failed'].includes(handle.cleanupStatus)
        ? handle.cleanupStatus
        : cleanupStatus;

    if (effectiveCleanupStatus === handle.cleanupStatus) {
      return { changed: false, handle, retained: row.payload_json };
    }

    return {
      changed: true,
      retained: row.payload_json,
      handle: BackendWorkspaceHandleSchema.parse({
        ...handle,
        cleanupStatus: effectiveCleanupStatus,
        updatedAt,
      }),
    };
  });

  for (const { changed, handle, retained } of resolved) {
    if (!changed) {
      continue;
    }
    workspaceDb.sqlite
      .prepare(
        `UPDATE backend_workspace_handles
         SET payload_json = ?, updated_at = ?
         WHERE workspace_id = ? AND backend_workspace_handle_id = ?`
      )
      .run(
        JSON.stringify({
          ...JSON.parse(retained),
          cleanupStatus: handle.cleanupStatus,
          updatedAt: handle.updatedAt,
        }),
        updatedAt,
        workspaceId,
        handle.id
      );
  }

  return resolved.map(({ handle }) => handle);
}

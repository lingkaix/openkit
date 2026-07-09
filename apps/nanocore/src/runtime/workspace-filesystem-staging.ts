import type { WorkspaceDb } from '../storage/db.js';
import type { FilesystemSnapshotManifest } from './filesystem-workspace-sync.js';

/** Input for recording one internal filesystem staging root. */
export interface RecordFilesystemWorkspaceStagingRootInput {
  /** Workspace that owns the staged review. */
  readonly workspaceId: string;
  /** Staged workspace review id. */
  readonly reviewId: string;
  /** Workspace change set staged for review. */
  readonly changeSetId: string;
  /** Internal host staging root path. */
  readonly stagingRootPath: string;
  /** Internal host target root path. */
  readonly targetRootPath: string;
  /** Snapshot captured before worker execution. */
  readonly before: FilesystemSnapshotManifest;
  /** Record creation timestamp. */
  readonly createdAt: string;
}

/** Internal filesystem staging root record. */
export interface FilesystemWorkspaceStagingRootRecord {
  /** Workspace that owns the staged review. */
  readonly workspaceId: string;
  /** Staged workspace review id. */
  readonly reviewId: string;
  /** Workspace change set staged for review. */
  readonly changeSetId: string;
  /** Internal host staging root path. */
  readonly stagingRootPath: string;
  /** Internal host target root path. */
  readonly targetRootPath: string;
  /** Snapshot captured before worker execution. */
  readonly before: FilesystemSnapshotManifest;
  /** Record creation timestamp. */
  readonly createdAt: string;
  /** Latest update timestamp. */
  readonly updatedAt: string;
}

interface FilesystemWorkspaceStagingRootRow {
  readonly workspace_id: string;
  readonly review_id: string;
  readonly change_set_id: string;
  readonly staging_root_path: string;
  readonly target_root_path: string;
  readonly before_manifest_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * Persists one internal filesystem staging root lookup.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Filesystem staging root input.
 * @returns Stored staging root record.
 */
export function recordFilesystemWorkspaceStagingRoot(
  workspaceDb: WorkspaceDb,
  input: RecordFilesystemWorkspaceStagingRootInput
): FilesystemWorkspaceStagingRootRecord {
  workspaceDb.sqlite
    .prepare(
      `INSERT INTO workspace_filesystem_staging_roots (
        workspace_id,
        review_id,
        change_set_id,
        staging_root_path,
        target_root_path,
        before_manifest_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, review_id) DO UPDATE SET
        change_set_id = excluded.change_set_id,
        staging_root_path = excluded.staging_root_path,
        target_root_path = excluded.target_root_path,
        before_manifest_json = excluded.before_manifest_json,
        updated_at = excluded.updated_at`
    )
    .run(
      input.workspaceId,
      input.reviewId,
      input.changeSetId,
      input.stagingRootPath,
      input.targetRootPath,
      JSON.stringify(input.before),
      input.createdAt,
      input.createdAt
    );

  const stored = getFilesystemWorkspaceStagingRoot(workspaceDb, input.workspaceId, input.reviewId);

  if (!stored) {
    throw new Error(`Filesystem workspace staging root was not recorded: ${input.reviewId}`);
  }

  return stored;
}

/**
 * Reads one internal filesystem staging root lookup.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @param reviewId Staged workspace review id.
 * @returns Stored staging root record, or null.
 */
export function getFilesystemWorkspaceStagingRoot(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  reviewId: string
): FilesystemWorkspaceStagingRootRecord | null {
  const row = workspaceDb.sqlite
    .prepare(
      `SELECT
        workspace_id,
        review_id,
        change_set_id,
        staging_root_path,
        target_root_path,
        before_manifest_json,
        created_at,
        updated_at
      FROM workspace_filesystem_staging_roots
      WHERE workspace_id = ? AND review_id = ?`
    )
    .get(workspaceId, reviewId) as FilesystemWorkspaceStagingRootRow | undefined;

  if (!row) {
    return null;
  }

  return {
    before: createFilesystemSnapshotManifestFromJson(row.before_manifest_json),
    changeSetId: row.change_set_id,
    createdAt: row.created_at,
    reviewId: row.review_id,
    stagingRootPath: row.staging_root_path,
    targetRootPath: row.target_root_path,
    updatedAt: row.updated_at,
    workspaceId: row.workspace_id,
  };
}

/**
 * Parses a stored filesystem manifest JSON payload.
 *
 * @param json Stored manifest JSON.
 * @returns Filesystem snapshot manifest.
 */
function createFilesystemSnapshotManifestFromJson(json: string): FilesystemSnapshotManifest {
  return JSON.parse(json) as FilesystemSnapshotManifest;
}

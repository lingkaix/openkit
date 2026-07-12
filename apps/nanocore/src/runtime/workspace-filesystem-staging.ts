import { realpathSync, statSync } from 'node:fs';
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
  /** Stable device and inode identity for the staging root. */
  readonly stagingRootIdentity: string;
  /** Internal host target root path. */
  readonly targetRootPath: string;
  /** Stable device and inode identity for the target root. */
  readonly targetRootIdentity: string;
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
  const stagingRoot = canonicalFilesystemRoot(input.stagingRootPath);
  const targetRoot = canonicalFilesystemRoot(input.targetRootPath);
  const existing = getFilesystemWorkspaceStagingRoot(
    workspaceDb,
    input.workspaceId,
    input.reviewId
  );
  if (existing) {
    const replay = {
      before: input.before,
      changeSetId: input.changeSetId,
      createdAt: input.createdAt,
      reviewId: input.reviewId,
      stagingRootIdentity: stagingRoot.identity,
      stagingRootPath: stagingRoot.path,
      targetRootIdentity: targetRoot.identity,
      targetRootPath: targetRoot.path,
      updatedAt: input.createdAt,
      workspaceId: input.workspaceId,
    } satisfies FilesystemWorkspaceStagingRootRecord;
    if (JSON.stringify(existing) !== JSON.stringify(replay)) {
      throw new Error(`Filesystem workspace staging replay conflict: ${input.reviewId}`);
    }
    return existing;
  }

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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.workspaceId,
      input.reviewId,
      input.changeSetId,
      stagingRoot.path,
      targetRoot.path,
      JSON.stringify({
        before: input.before,
        stagingRootIdentity: stagingRoot.identity,
        targetRootIdentity: targetRoot.identity,
      }),
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

  const payload = createFilesystemStagingPayloadFromJson(row.before_manifest_json);
  return {
    before: payload.before,
    changeSetId: row.change_set_id,
    createdAt: row.created_at,
    reviewId: row.review_id,
    stagingRootIdentity: payload.stagingRootIdentity,
    stagingRootPath: row.staging_root_path,
    targetRootIdentity: payload.targetRootIdentity,
    targetRootPath: row.target_root_path,
    updatedAt: row.updated_at,
    workspaceId: row.workspace_id,
  };
}

/**
 * Resolves one filesystem root and captures its stable directory identity.
 *
 * @param path Configured staging or target root path.
 * @returns Canonical root path plus device and inode identity.
 */
function canonicalFilesystemRoot(path: string): {
  readonly identity: string;
  readonly path: string;
} {
  const canonicalPath = realpathSync(path);
  const stats = statSync(canonicalPath, { bigint: true });
  if (!stats.isDirectory()) {
    throw new Error(`Filesystem workspace root is not a directory: ${path}`);
  }
  return { identity: `${stats.dev}:${stats.ino}`, path: canonicalPath };
}

/**
 * Parses a stored filesystem staging payload.
 *
 * @param json Stored manifest JSON.
 * @returns Filesystem snapshot plus root identities.
 */
function createFilesystemStagingPayloadFromJson(json: string): {
  readonly before: FilesystemSnapshotManifest;
  readonly stagingRootIdentity: string;
  readonly targetRootIdentity: string;
} {
  const payload = JSON.parse(json) as {
    before?: unknown;
    stagingRootIdentity?: unknown;
    targetRootIdentity?: unknown;
  };
  if (
    !payload.before ||
    typeof payload.before !== 'object' ||
    typeof payload.stagingRootIdentity !== 'string' ||
    typeof payload.targetRootIdentity !== 'string'
  ) {
    throw new Error('Stored filesystem staging payload is invalid.');
  }
  return {
    before: payload.before as FilesystemSnapshotManifest,
    stagingRootIdentity: payload.stagingRootIdentity,
    targetRootIdentity: payload.targetRootIdentity,
  };
}

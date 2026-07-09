import type { WorkspaceDb } from '../storage/db.js';
import type {
  WorkspaceRepositoryDiagnosticsStatus,
  WorkspaceRepositoryResourceType,
  WorkspaceRepositoryStagingStrategy,
} from '../storage/schema/index.js';
import type { RepositoryValidationResult } from './repository-validation.js';
import { validateRepositoryPath } from './repository-validation.js';

/**
 * Callback used by repository store helpers to confirm app-local workspace ownership.
 *
 * @param workspaceId Workspace id to check.
 * @returns True when the workspace exists in the caller-owned app-local store.
 */
export type WorkspaceRepositoryStoreWorkspaceExists = (workspaceId: string) => boolean;

/**
 * Git write behavior configured for one linked repository.
 */
export interface WorkspaceRepositoryGitConfig {
  /** Configured Git author email for OpenKit-created commits. */
  readonly authorEmail: string | null;
  /** Configured Git author name for OpenKit-created commits. */
  readonly authorName: string | null;
  /** Branches or patterns that may be pushed after explicit approval. */
  readonly allowedPushTargets: readonly string[];
  /** Whether accepted workspace reviews should create local commits. */
  readonly commitOnApply: boolean;
  /** Branch patterns treated as protected by OpenKit-side gates. */
  readonly protectedBranchPatterns: readonly string[];
  /** Whether push commits must link back to accepted workspace reviews. */
  readonly requireReviewLinkage: boolean;
  /** Git staging strategy for workspace reviews. */
  readonly stagingStrategy: WorkspaceRepositoryStagingStrategy;
  /** Vault grant used for host-side Git push credentials. */
  readonly vaultGrantRef: string | null;
}

/**
 * Stored workspace repository resource returned by repository store helpers.
 */
export interface WorkspaceRepositoryResourceRecord {
  /** Workspace identifier that owns the repository resource. */
  readonly workspaceId: string;
  /** Stable resource identifier within the workspace. */
  readonly resourceId: string;
  /** Repository resource type. */
  readonly type: WorkspaceRepositoryResourceType;
  /** Human-readable repository display name. */
  readonly displayName: string;
  /** Raw app-local repository path preserved for NanoCore storage only. */
  readonly localPath: string;
  /** Git write behavior configured for this linked repository. */
  readonly git: WorkspaceRepositoryGitConfig;
  /** Latest non-secret repository diagnostics state persisted in SQLite. */
  readonly diagnosticsStatus: WorkspaceRepositoryDiagnosticsStatus;
  /** ISO timestamp for resource creation. */
  readonly createdAt: string;
  /** ISO timestamp for the latest resource update. */
  readonly updatedAt: string;
  /** User-safe validation diagnostics from the latest upsert, when available. */
  readonly validation?: RepositoryValidationResult;
}

/**
 * Portable, non-secret repository metadata stored in workspace exports.
 */
export interface ExportableWorkspaceRepositoryResource {
  /** Stable resource identifier within the workspace. */
  readonly resourceId: string;
  /** Repository resource type. */
  readonly type: WorkspaceRepositoryResourceType;
  /** Human-readable repository display name. */
  readonly displayName: string;
  /** Git write behavior configured for this linked repository. */
  readonly git: WorkspaceRepositoryGitConfig;
  /** ISO timestamp for resource creation. */
  readonly createdAt: string;
  /** ISO timestamp for the latest resource update. */
  readonly updatedAt: string;
}

/**
 * Input used to create or update a workspace repository resource.
 */
export interface UpsertWorkspaceRepositoryResourceInput {
  /** App-local workspace existence callback. */
  readonly workspaceExists: WorkspaceRepositoryStoreWorkspaceExists;
  /** Workspace identifier that owns the repository resource. */
  readonly workspaceId: string;
  /** Optional stable resource identifier within the workspace. */
  readonly resourceId?: string;
  /** Human-readable repository display name. */
  readonly displayName: string;
  /** Raw local repository path to persist in NanoCore app-local storage. */
  readonly localPath: string;
  /** Optional Git write behavior for this linked repository. */
  readonly git?: Partial<WorkspaceRepositoryGitConfig>;
  /** Optional clock used by deterministic tests. */
  readonly now?: () => string;
}

const DEFAULT_REPOSITORY_RESOURCE_ID = 'repo_default';
const DEFAULT_REPOSITORY_GIT_CONFIG: WorkspaceRepositoryGitConfig = {
  authorEmail: null,
  authorName: null,
  allowedPushTargets: [],
  commitOnApply: false,
  protectedBranchPatterns: ['main', 'master', 'release/*', 'v*'],
  requireReviewLinkage: true,
  stagingStrategy: 'staging-root',
  vaultGrantRef: null,
};

interface WorkspaceRepositoryResourceRow {
  readonly workspace_id: string;
  readonly resource_id: string;
  readonly type: WorkspaceRepositoryResourceType;
  readonly display_name: string;
  readonly local_path: string;
  readonly commit_on_apply: 0 | 1;
  readonly git_author_email: string | null;
  readonly git_author_name: string | null;
  readonly staging_strategy: WorkspaceRepositoryStagingStrategy;
  readonly protected_branch_patterns_json: string;
  readonly allowed_push_targets_json: string;
  readonly require_review_linkage: 0 | 1;
  readonly git_push_vault_grant_ref: string | null;
  readonly diagnostics_status: WorkspaceRepositoryDiagnosticsStatus;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * Creates or updates one workspace repository resource.
 *
 * The helper persists the raw local path only in NanoCore SQLite storage and
 * stores the non-secret validation status separately for diagnostics. Missing
 * workspaces are rejected through the caller-supplied app-local ownership check.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Repository resource upsert input.
 * @returns Stored repository resource with user-safe validation diagnostics.
 * @throws Error when the workspace existence callback rejects the workspace id.
 */
export function upsertWorkspaceRepositoryResource(
  workspaceDb: WorkspaceDb,
  input: UpsertWorkspaceRepositoryResourceInput
): WorkspaceRepositoryResourceRecord {
  assertWorkspaceExists(input.workspaceExists, input.workspaceId);

  const timestamp = input.now?.() ?? new Date().toISOString();
  const resourceId = input.resourceId ?? DEFAULT_REPOSITORY_RESOURCE_ID;
  const validation = validateRepositoryPath(input.localPath);
  const git = { ...DEFAULT_REPOSITORY_GIT_CONFIG, ...input.git };

  workspaceDb.sqlite
    .prepare(
      `INSERT INTO workspace_repository_resources (
        workspace_id,
        resource_id,
        type,
        display_name,
        local_path,
        commit_on_apply,
        git_author_email,
        git_author_name,
        staging_strategy,
        protected_branch_patterns_json,
        allowed_push_targets_json,
        require_review_linkage,
        git_push_vault_grant_ref,
        diagnostics_status,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, resource_id) DO UPDATE SET
        type = excluded.type,
        display_name = excluded.display_name,
        local_path = excluded.local_path,
        commit_on_apply = excluded.commit_on_apply,
        git_author_email = excluded.git_author_email,
        git_author_name = excluded.git_author_name,
        staging_strategy = excluded.staging_strategy,
        protected_branch_patterns_json = excluded.protected_branch_patterns_json,
        allowed_push_targets_json = excluded.allowed_push_targets_json,
        require_review_linkage = excluded.require_review_linkage,
        git_push_vault_grant_ref = excluded.git_push_vault_grant_ref,
        diagnostics_status = excluded.diagnostics_status,
        updated_at = excluded.updated_at`
    )
    .run(
      input.workspaceId,
      resourceId,
      'git_repository',
      input.displayName,
      input.localPath,
      git.commitOnApply ? 1 : 0,
      git.authorEmail,
      git.authorName,
      git.stagingStrategy,
      JSON.stringify(git.protectedBranchPatterns),
      JSON.stringify(git.allowedPushTargets),
      git.requireReviewLinkage ? 1 : 0,
      git.vaultGrantRef,
      validation.status,
      timestamp,
      timestamp
    );

  const record = getWorkspaceRepositoryResource(workspaceDb, input.workspaceId, resourceId);

  if (!record) {
    throw new Error(`Repository resource was not written: ${input.workspaceId}/${resourceId}`);
  }

  return { ...record, validation };
}

/**
 * Lists repository resources for one workspace in deterministic default order.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id to list repository resources for.
 * @returns Stored repository resources sorted by creation timestamp and resource id.
 */
export function listWorkspaceRepositoryResources(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): WorkspaceRepositoryResourceRecord[] {
  return (
    workspaceDb.sqlite
      .prepare(
        `SELECT
          workspace_id,
          resource_id,
          type,
          display_name,
          local_path,
          commit_on_apply,
          git_author_email,
          git_author_name,
          staging_strategy,
          protected_branch_patterns_json,
          allowed_push_targets_json,
          require_review_linkage,
          git_push_vault_grant_ref,
          diagnostics_status,
          created_at,
          updated_at
        FROM workspace_repository_resources
        WHERE workspace_id = ?
        ORDER BY created_at ASC, resource_id ASC`
      )
      .all(workspaceId) as WorkspaceRepositoryResourceRow[]
  ).map(mapWorkspaceRepositoryResourceRow);
}

/**
 * Lists repository resources as portable workspace export records.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id to export repository resources for.
 * @returns Non-secret repository metadata without host-local paths.
 */
export function listExportableWorkspaceRepositoryResources(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): ExportableWorkspaceRepositoryResource[] {
  return listWorkspaceRepositoryResources(workspaceDb, workspaceId).map((record) => ({
    resourceId: record.resourceId,
    type: record.type,
    displayName: record.displayName,
    git: record.git,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }));
}

/**
 * Imports portable repository resource metadata as unbound local resources.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Target workspace id.
 * @param resources Portable repository metadata from one workspace export.
 */
export function importWorkspaceRepositoryResources(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  resources: readonly ExportableWorkspaceRepositoryResource[]
): void {
  for (const resource of resources) {
    workspaceDb.sqlite
      .prepare(
        `INSERT OR REPLACE INTO workspace_repository_resources (
          workspace_id,
          resource_id,
          type,
          display_name,
          local_path,
          commit_on_apply,
          git_author_email,
          git_author_name,
          staging_strategy,
          protected_branch_patterns_json,
          allowed_push_targets_json,
          require_review_linkage,
          git_push_vault_grant_ref,
          diagnostics_status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        workspaceId,
        resource.resourceId,
        resource.type,
        resource.displayName,
        '',
        resource.git.commitOnApply ? 1 : 0,
        resource.git.authorEmail,
        resource.git.authorName,
        resource.git.stagingStrategy,
        JSON.stringify(resource.git.protectedBranchPatterns),
        JSON.stringify(resource.git.allowedPushTargets),
        resource.git.requireReviewLinkage ? 1 : 0,
        resource.git.vaultGrantRef,
        'missing',
        resource.createdAt,
        resource.updatedAt
      );
  }
}

/**
 * Reads the default repository resource for one workspace.
 *
 * The current default is the first resource by creation timestamp and resource id.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id to read the default repository resource for.
 * @returns Stored repository resource, or null when the workspace has none.
 */
export function getDefaultWorkspaceRepositoryResource(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): WorkspaceRepositoryResourceRecord | null {
  return listWorkspaceRepositoryResources(workspaceDb, workspaceId)[0] ?? null;
}

/**
 * Reads one repository resource by workspace id and resource id.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id that owns the repository resource.
 * @param resourceId Repository resource id to read.
 * @returns Stored repository resource, or null when no matching row exists.
 */
function getWorkspaceRepositoryResource(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  resourceId: string
): WorkspaceRepositoryResourceRecord | null {
  const row = workspaceDb.sqlite
    .prepare(
      `SELECT
        workspace_id,
        resource_id,
        type,
        display_name,
        local_path,
        commit_on_apply,
        git_author_email,
        git_author_name,
        staging_strategy,
        protected_branch_patterns_json,
        allowed_push_targets_json,
        require_review_linkage,
        git_push_vault_grant_ref,
        diagnostics_status,
        created_at,
        updated_at
      FROM workspace_repository_resources
      WHERE workspace_id = ? AND resource_id = ?`
    )
    .get(workspaceId, resourceId) as WorkspaceRepositoryResourceRow | undefined;

  return row ? mapWorkspaceRepositoryResourceRow(row) : null;
}

/**
 * Confirms a workspace exists before repository resources are written.
 *
 * @param workspaceExists App-local workspace existence callback.
 * @param workspaceId Workspace id to check.
 * @throws Error when the workspace does not exist.
 */
function assertWorkspaceExists(
  workspaceExists: WorkspaceRepositoryStoreWorkspaceExists,
  workspaceId: string
): void {
  if (!workspaceExists(workspaceId)) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }
}

/**
 * Maps a Drizzle workspace repository row to the public helper record.
 *
 * @param row Workspace repository row from SQLite.
 * @returns Stored workspace repository resource record.
 */
function mapWorkspaceRepositoryResourceRow(
  row: WorkspaceRepositoryResourceRow
): WorkspaceRepositoryResourceRecord {
  return {
    workspaceId: row.workspace_id,
    resourceId: row.resource_id,
    type: row.type,
    displayName: row.display_name,
    localPath: row.local_path,
    git: {
      authorEmail: row.git_author_email,
      authorName: row.git_author_name,
      allowedPushTargets: parseStringArray(row.allowed_push_targets_json),
      commitOnApply: row.commit_on_apply === 1,
      protectedBranchPatterns: parseStringArray(row.protected_branch_patterns_json),
      requireReviewLinkage: row.require_review_linkage === 1,
      stagingStrategy: row.staging_strategy,
      vaultGrantRef: row.git_push_vault_grant_ref,
    },
    diagnosticsStatus: row.diagnostics_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Parses one stored JSON string array.
 *
 * @param value JSON string value to parse.
 * @returns Parsed string array.
 * @throws Error when the stored value is not a string array.
 */
function parseStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;

  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('Stored repository Git config array is invalid.');
  }

  return parsed;
}

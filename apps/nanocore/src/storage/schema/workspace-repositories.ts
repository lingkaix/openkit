import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Repository resource types that can be attached to a workspace.
 */
export type WorkspaceRepositoryResourceType = 'git_repository';

/**
 * Diagnostics states recorded for workspace repository resources.
 */
export type WorkspaceRepositoryDiagnosticsStatus =
  | 'unknown'
  | 'ready'
  | 'missing'
  | 'not_directory'
  | 'not_git'
  | 'inaccessible';

/**
 * Git staging strategy for workspace repository reviews.
 */
export type WorkspaceRepositoryStagingStrategy = 'staging-root' | 'review-branch';

/**
 * Stores local repository resources declared for a workspace.
 */
export const workspaceRepositoryResources = sqliteTable(
  'workspace_repository_resources',
  {
    /** Workspace identifier that owns the repository resource. */
    workspaceId: text('workspace_id').notNull(),
    /** Stable resource identifier within the workspace. */
    resourceId: text('resource_id').notNull(),
    /** Repository resource type. */
    type: text('type', { enum: ['git_repository'] })
      .$type<WorkspaceRepositoryResourceType>()
      .notNull(),
    /** Human-readable repository display name. */
    displayName: text('display_name').notNull(),
    /** Local filesystem path for the repository. */
    localPath: text('local_path').notNull(),
    /** Latest non-secret repository diagnostics state. */
    diagnosticsStatus: text('diagnostics_status', {
      enum: ['unknown', 'ready', 'missing', 'not_directory', 'not_git', 'inaccessible'],
    })
      .$type<WorkspaceRepositoryDiagnosticsStatus>()
      .notNull(),
    /** Whether accepted workspace reviews should create local commits. */
    commitOnApply: integer('commit_on_apply', { mode: 'boolean' }).notNull().default(false),
    /** Configured Git author name for OpenKit-created commits. */
    gitAuthorName: text('git_author_name'),
    /** Configured Git author email for OpenKit-created commits. */
    gitAuthorEmail: text('git_author_email'),
    /** Git staging strategy for workspace reviews. */
    stagingStrategy: text('staging_strategy')
      .$type<WorkspaceRepositoryStagingStrategy>()
      .notNull()
      .default('staging-root'),
    /** JSON array of protected branch patterns. */
    protectedBranchPatternsJson: text('protected_branch_patterns_json')
      .notNull()
      .default('["main","master","release/*","v*"]'),
    /** JSON array of branches or patterns that may be pushed after approval. */
    allowedPushTargetsJson: text('allowed_push_targets_json').notNull().default('[]'),
    /** Whether push commits must link back to accepted reviews. */
    requireReviewLinkage: integer('require_review_linkage', { mode: 'boolean' })
      .notNull()
      .default(true),
    /** Vault grant used for host-side Git push credentials. */
    gitPushVaultGrantRef: text('git_push_vault_grant_ref'),
    /** ISO timestamp for resource creation. */
    createdAt: text('created_at').notNull(),
    /** ISO timestamp for the latest resource update. */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.resourceId] })]
);

import { index, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Durable Git push attempt outcome.
 */
export type GitPushRecordOutcome =
  | 'pushed'
  | 'rejected-non-fast-forward'
  | 'rejected-protected'
  | 'auth-failed'
  | 'remote-unreachable'
  | 'refused-policy'
  | 'refused-linkage'
  | 'unsupported-provider';

/**
 * Durable, redacted Git push attempt records scoped by workspace.
 */
export const gitPushRecords = sqliteTable(
  'git_push_records',
  {
    /** Stable push record id. */
    pushRecordId: text('push_record_id').notNull(),
    /** Workspace that owns the push attempt. */
    workspaceId: text('workspace_id').notNull(),
    /** Linked repository resource used for the push attempt. */
    repositoryResourceId: text('repository_resource_id').notNull(),
    /** Action Center approval row id, when the attempt reached approval. */
    approvalRowId: text('approval_row_id'),
    /** Policy decision id, when the attempt reached policy evaluation. */
    policyDecisionId: text('policy_decision_id'),
    /** Product actor id that requested the push. */
    actorId: text('actor_id'),
    /** Redacted remote summary without credential material or host paths. */
    remoteSummary: text('remote_summary').notNull(),
    /** Local source ref used for the push attempt. */
    sourceRef: text('source_ref').notNull(),
    /** Target branch selected for the push attempt. */
    targetBranch: text('target_branch').notNull(),
    /** JSON array of commit ids included in the push attempt. */
    commitIdsJson: text('commit_ids_json').notNull(),
    /** JSON array of workspace review ids linked to the push attempt. */
    reviewIdsJson: text('review_ids_json').notNull(),
    /** Remote head observed before the attempt, when known. */
    remoteHeadBefore: text('remote_head_before'),
    /** Remote head observed after the attempt, when known. */
    remoteHeadAfter: text('remote_head_after'),
    /** Final typed push attempt outcome. */
    outcome: text('outcome').$type<GitPushRecordOutcome>().notNull(),
    /** Redacted error summary for failed attempts. */
    errorSummary: text('error_summary'),
    /** ISO timestamp for push record creation. */
    createdAt: text('created_at').notNull(),
    /** ISO timestamp for latest push record update. */
    updatedAt: text('updated_at').notNull(),
    /** Request id that created this push record. */
    requestId: text('request_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.pushRecordId] }),
    index('git_push_records_repository_idx').on(
      table.workspaceId,
      table.repositoryResourceId,
      table.createdAt,
      table.pushRecordId
    ),
  ]
);

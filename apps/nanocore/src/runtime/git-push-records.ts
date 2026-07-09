import { type GitPushRecord, GitPushRecordSchema } from '@openkit/app-api-schemas';
import { recordWorkspaceAuditEvent } from '../audit-events.js';
import type { WorkspaceDb } from '../storage/db.js';
import type { WorkspaceRepositoryGitConfig } from '../workspace/repository-store.js';
import { evaluateGitPushLinkage } from './git-push-linkage.js';
import { evaluateGitPushPolicy } from './git-push-policy.js';

/**
 * Input used to persist one Git push attempt record.
 */
export interface RecordGitPushRecordInput {
  /** Public Git push record. */
  readonly record: GitPushRecord;
  /** Request id that created the push record. */
  readonly requestId: string;
}

/** Exportable Git push record with storage-only request id. */
export interface ExportedGitPushRecord extends GitPushRecord {
  /** Request id that created this push record. */
  readonly requestId: string;
}

/** Input used to prepare one Git push attempt before remote mutation. */
export interface PrepareGitPushAttemptInput {
  /** Actor that requested the push, when available. */
  readonly actorId: string | null;
  /** Whether the approval row explicitly named this protected target. */
  readonly approvalNamesProtectedTarget: boolean;
  /** Approval row that authorized this push attempt, when available. */
  readonly approvalRowId: string | null;
  /** Commit ids requested for publication. */
  readonly commitIds: readonly string[];
  /** Linked repository Git config. */
  readonly git: WorkspaceRepositoryGitConfig;
  /** Clock used for deterministic records. */
  readonly now?: () => string;
  /** Policy decision that authorized this push attempt, when available. */
  readonly policyDecisionId: string | null;
  /** Durable Git push record id to use if preflight refuses the attempt. */
  readonly recordId: string;
  /** Redacted remote summary. */
  readonly remoteSummary: string;
  /** Linked repository resource id. */
  readonly repositoryResourceId: string;
  /** Request id for idempotency and audit linkage. */
  readonly requestId: string;
  /** Source ref requested for publication. */
  readonly sourceRef: string;
  /** Target branch requested by the push attempt. */
  readonly targetBranch: string;
  /** Workspace that owns the push attempt. */
  readonly workspaceId: string;
}

/** Successful Git push preflight result. */
export interface GitPushAttemptReady {
  /** Preflight status. */
  readonly status: 'ready';
  /** Whether the target matched protected branch patterns. */
  readonly protected: boolean;
  /** Review ids linked to the requested commits. */
  readonly reviewIds: string[];
}

/** Git push preflight refusal that was persisted as a terminal record. */
export interface GitPushAttemptRecordedRefusal {
  /** Preflight status. */
  readonly status: 'recorded-refusal';
  /** Durable refusal record. */
  readonly record: GitPushRecord;
}

/** Git push preflight result. */
export type GitPushAttemptPreparation = GitPushAttemptReady | GitPushAttemptRecordedRefusal;

interface GitPushRecordRow {
  readonly push_record_id: string;
  readonly workspace_id: string;
  readonly repository_resource_id: string;
  readonly approval_row_id: string | null;
  readonly policy_decision_id: string | null;
  readonly actor_id: string | null;
  readonly remote_summary: string;
  readonly source_ref: string;
  readonly target_branch: string;
  readonly commit_ids_json: string;
  readonly review_ids_json: string;
  readonly remote_head_before: string | null;
  readonly remote_head_after: string | null;
  readonly outcome: GitPushRecord['outcome'];
  readonly error_summary: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly request_id: string;
}

/**
 * Persists one durable, redacted Git push attempt record.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Push record persistence input.
 * @returns Stored public Git push record.
 */
export function recordGitPushRecord(
  workspaceDb: WorkspaceDb,
  input: RecordGitPushRecordInput
): GitPushRecord {
  const record = GitPushRecordSchema.parse(input.record);

  const inserted = workspaceDb.sqlite
    .prepare(
      `INSERT OR IGNORE INTO git_push_records (
        push_record_id,
        workspace_id,
        repository_resource_id,
        approval_row_id,
        policy_decision_id,
        actor_id,
        remote_summary,
        source_ref,
        target_branch,
        commit_ids_json,
        review_ids_json,
        remote_head_before,
        remote_head_after,
        outcome,
        error_summary,
        created_at,
        updated_at,
        request_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.id,
      record.workspaceId,
      record.repositoryResourceId,
      record.approvalRowId,
      record.policyDecisionId,
      record.actorId,
      record.remoteSummary,
      record.sourceRef,
      record.targetBranch,
      JSON.stringify(record.commitIds),
      JSON.stringify(record.reviewIds),
      record.remoteHeadBefore,
      record.remoteHeadAfter,
      record.outcome,
      record.errorSummary,
      record.createdAt,
      record.updatedAt,
      input.requestId
    );

  if (inserted.changes > 0) {
    recordWorkspaceAuditEvent({
      action: 'workspace.git.push.finish',
      category: 'command',
      errorCode: gitPushAuditErrorCode(record),
      now: new Date(record.createdAt),
      outcome: gitPushAuditOutcome(record.outcome),
      requestId: input.requestId,
      resource: `workspace-repository:${record.repositoryResourceId}`,
      severity: gitPushAuditSeverity(record.outcome),
      summary: gitPushAuditSummary(record),
      workspaceDb,
      workspaceId: record.workspaceId,
    });
  }

  return requireGitPushRecord(workspaceDb, record.workspaceId, record.id);
}

/**
 * Evaluates policy and review linkage before a Git push can touch a remote.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Push attempt input.
 * @returns Ready lineage details, or the stored refusal record.
 */
export function prepareGitPushAttempt(
  workspaceDb: WorkspaceDb,
  input: PrepareGitPushAttemptInput
): GitPushAttemptPreparation {
  const policy = evaluateGitPushPolicy({
    approvalNamesProtectedTarget: input.approvalNamesProtectedTarget,
    git: input.git,
    targetBranch: input.targetBranch,
  });

  if (!policy.allowed) {
    return {
      record: recordGitPushRefusal(
        workspaceDb,
        input,
        policy.outcome,
        policyRefusalSummary(policy.reason)
      ),
      status: 'recorded-refusal',
    };
  }

  const linkage = evaluateGitPushLinkage(workspaceDb, {
    commitIds: input.commitIds,
    requireReviewLinkage: input.git.requireReviewLinkage,
    workspaceId: input.workspaceId,
  });

  if (!linkage.allowed) {
    return {
      record: recordGitPushRefusal(
        workspaceDb,
        input,
        linkage.outcome,
        'Git push refused because commits are not linked to accepted workspace reviews.'
      ),
      status: 'recorded-refusal',
    };
  }

  return { protected: policy.protected, reviewIds: linkage.reviewIds, status: 'ready' };
}

/**
 * Reads one durable Git push record.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @param pushRecordId Push record id.
 * @returns Stored Git push record, or null.
 */
export function getGitPushRecord(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  pushRecordId: string
): GitPushRecord | null {
  const row = workspaceDb.sqlite
    .prepare(
      `SELECT
        push_record_id,
        workspace_id,
        repository_resource_id,
        approval_row_id,
        policy_decision_id,
        actor_id,
        remote_summary,
        source_ref,
        target_branch,
        commit_ids_json,
        review_ids_json,
        remote_head_before,
        remote_head_after,
        outcome,
        error_summary,
        created_at,
        updated_at,
        request_id
      FROM git_push_records
      WHERE workspace_id = ? AND push_record_id = ?`
    )
    .get(workspaceId, pushRecordId) as GitPushRecordRow | undefined;

  return row ? mapGitPushRecordRow(row) : null;
}

/**
 * Lists durable Git push records for one workspace.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Stored Git push records in stable newest-first order.
 */
export function listGitPushRecords(workspaceDb: WorkspaceDb, workspaceId: string): GitPushRecord[] {
  return (
    workspaceDb.sqlite
      .prepare(
        `SELECT
          push_record_id,
          workspace_id,
          repository_resource_id,
          approval_row_id,
          policy_decision_id,
          actor_id,
          remote_summary,
          source_ref,
          target_branch,
          commit_ids_json,
          review_ids_json,
          remote_head_before,
          remote_head_after,
          outcome,
          error_summary,
          created_at,
          updated_at,
          request_id
        FROM git_push_records
        WHERE workspace_id = ?
        ORDER BY created_at ASC, push_record_id ASC`
      )
      .all(workspaceId) as GitPushRecordRow[]
  )
    .map(mapGitPushRecordRow)
    .reverse();
}

/**
 * Lists Git push records for workspace export with the storage-only request id.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Exportable Git push records in stable oldest-first order.
 */
export function listExportableGitPushRecords(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): ExportedGitPushRecord[] {
  return (
    workspaceDb.sqlite
      .prepare(
        `SELECT
          push_record_id,
          workspace_id,
          repository_resource_id,
          approval_row_id,
          policy_decision_id,
          actor_id,
          remote_summary,
          source_ref,
          target_branch,
          commit_ids_json,
          review_ids_json,
          remote_head_before,
          remote_head_after,
          outcome,
          error_summary,
          created_at,
          updated_at,
          request_id
        FROM git_push_records
        WHERE workspace_id = ?
        ORDER BY created_at ASC, push_record_id ASC`
      )
      .all(workspaceId) as GitPushRecordRow[]
  ).map((row) => ({ ...mapGitPushRecordRow(row), requestId: row.request_id }));
}

/**
 * Replays exported Git push records into an imported workspace without emitting new push audits.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param records Exported Git push records already rewritten to the target workspace id.
 */
export function importWorkspaceGitPushRecords(
  workspaceDb: WorkspaceDb,
  records: readonly ExportedGitPushRecord[]
): void {
  const insert = workspaceDb.sqlite.prepare(
    `INSERT OR IGNORE INTO git_push_records (
      push_record_id,
      workspace_id,
      repository_resource_id,
      approval_row_id,
      policy_decision_id,
      actor_id,
      remote_summary,
      source_ref,
      target_branch,
      commit_ids_json,
      review_ids_json,
      remote_head_before,
      remote_head_after,
      outcome,
      error_summary,
      created_at,
      updated_at,
      request_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const record of records) {
    const { requestId, ...publicRecord } = record;
    const parsed = GitPushRecordSchema.parse(publicRecord);
    insert.run(
      parsed.id,
      parsed.workspaceId,
      parsed.repositoryResourceId,
      parsed.approvalRowId,
      parsed.policyDecisionId,
      parsed.actorId,
      parsed.remoteSummary,
      parsed.sourceRef,
      parsed.targetBranch,
      JSON.stringify(parsed.commitIds),
      JSON.stringify(parsed.reviewIds),
      parsed.remoteHeadBefore,
      parsed.remoteHeadAfter,
      parsed.outcome,
      parsed.errorSummary,
      parsed.createdAt,
      parsed.updatedAt,
      requestId
    );
  }
}

/**
 * Reads one durable Git push record or throws.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @param pushRecordId Push record id.
 * @returns Stored Git push record.
 * @throws Error when the record does not exist.
 */
function requireGitPushRecord(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  pushRecordId: string
): GitPushRecord {
  const record = getGitPushRecord(workspaceDb, workspaceId, pushRecordId);

  if (!record) {
    throw new Error(`Git push record not found: ${workspaceId}/${pushRecordId}`);
  }

  return record;
}

/**
 * Records a terminal Git push preflight refusal.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Push attempt input.
 * @param outcome Typed refusal outcome.
 * @param errorSummary Redacted public refusal summary.
 * @returns Stored refusal record.
 */
function recordGitPushRefusal(
  workspaceDb: WorkspaceDb,
  input: PrepareGitPushAttemptInput,
  outcome: GitPushRecord['outcome'],
  errorSummary: string
): GitPushRecord {
  const now = input.now?.() ?? new Date().toISOString();

  return recordGitPushRecord(workspaceDb, {
    requestId: input.requestId,
    record: {
      actorId: input.actorId,
      approvalRowId: input.approvalRowId,
      commitIds: [...input.commitIds],
      createdAt: now,
      errorSummary,
      id: input.recordId,
      outcome,
      policyDecisionId: input.policyDecisionId,
      remoteHeadAfter: null,
      remoteHeadBefore: null,
      remoteSummary: input.remoteSummary,
      repositoryResourceId: input.repositoryResourceId,
      reviewIds: [],
      sourceRef: input.sourceRef,
      targetBranch: input.targetBranch,
      updatedAt: now,
      workspaceId: input.workspaceId,
    },
  });
}

/**
 * Maps a stable policy refusal reason to a redacted public summary.
 *
 * @param reason Stable policy refusal reason.
 * @returns Public refusal summary.
 */
function policyRefusalSummary(reason: 'target_not_allowed' | 'protected_target_not_named'): string {
  return reason === 'protected_target_not_named'
    ? 'Git push refused because protected target was not explicitly approved.'
    : 'Git push refused by repository target policy.';
}

/**
 * Maps one database row to the public Git push record shape.
 *
 * @param row Git push record database row.
 * @returns Public Git push record.
 */
function mapGitPushRecordRow(row: GitPushRecordRow): GitPushRecord {
  return GitPushRecordSchema.parse({
    id: row.push_record_id,
    workspaceId: row.workspace_id,
    repositoryResourceId: row.repository_resource_id,
    approvalRowId: row.approval_row_id,
    policyDecisionId: row.policy_decision_id,
    actorId: row.actor_id,
    remoteSummary: row.remote_summary,
    sourceRef: row.source_ref,
    targetBranch: row.target_branch,
    commitIds: parseArray(row.commit_ids_json),
    reviewIds: parseArray(row.review_ids_json),
    remoteHeadBefore: row.remote_head_before,
    remoteHeadAfter: row.remote_head_after,
    outcome: row.outcome,
    errorSummary: row.error_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/**
 * Maps a Git push outcome to an audit outcome.
 *
 * @param outcome Git push record outcome.
 * @returns Audit outcome.
 */
function gitPushAuditOutcome(
  outcome: GitPushRecord['outcome']
): 'succeeded' | 'failed' | 'denied' | 'cancelled' {
  return outcome === 'pushed' ? 'succeeded' : 'failed';
}

/**
 * Maps a Git push outcome to an audit severity.
 *
 * @param outcome Git push record outcome.
 * @returns Audit severity.
 */
function gitPushAuditSeverity(outcome: GitPushRecord['outcome']): 'info' | 'warning' {
  return outcome === 'pushed' ? 'info' : 'warning';
}

/**
 * Maps a Git push outcome to a stable audit error code.
 *
 * @param record Git push record.
 * @returns Error code for failed outcomes, otherwise null.
 */
function gitPushAuditErrorCode(record: GitPushRecord): string | null {
  return record.outcome === 'pushed' ? null : `git_push_${record.outcome.replaceAll('-', '_')}`;
}

/**
 * Builds a redacted Git push audit summary.
 *
 * @param record Git push record.
 * @returns Redacted audit summary.
 */
function gitPushAuditSummary(record: GitPushRecord): string {
  return `Git push ${record.outcome}: ${record.commitIds.length} commit, ${record.reviewIds.length} review, target ${record.targetBranch}`;
}

/**
 * Parses one stored JSON array.
 *
 * @param value JSON string value to parse.
 * @returns Parsed JSON array.
 * @throws Error when the stored JSON is not an array.
 */
function parseArray(value: string): unknown[] {
  const parsed = JSON.parse(value) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error('Stored Git push record field is not an array.');
  }

  return parsed;
}

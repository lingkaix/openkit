import { type WorkspaceApplyResult, WorkspaceApplyResultSchema } from '@openkit/app-api-schemas';
import { recordWorkspaceAuditEvent } from '../audit-events.js';
import { recordWorkspaceEvidenceBundle } from '../evidence-bundles.js';
import type { WorkspaceDb } from '../storage/db.js';

/**
 * Input used to persist one review-gated workspace apply result.
 */
export interface RecordWorkspaceApplyResultInput {
  /** Public workspace apply result. */
  readonly result: WorkspaceApplyResult;
  /** Request id that created the apply result. */
  readonly requestId: string;
}

/** Exportable workspace apply result plus storage-only replay fields. */
export interface ExportedWorkspaceApplyResult extends WorkspaceApplyResult {
  /** Request id that created the original apply result. */
  readonly requestId: string;
}

interface WorkspaceApplyResultRow {
  readonly apply_result_id: string;
  readonly workspace_id: string;
  readonly review_id: string;
  readonly change_set_id: string;
  readonly status: WorkspaceApplyResult['status'];
  readonly applied_paths_json: string;
  readonly skipped_paths_json: string;
  readonly conflict_records_json: string;
  readonly verification_json: string;
  readonly commit_ids_json: string;
  readonly applied_at: string;
  readonly request_id: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * Persists one durable review-gated workspace apply result.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Apply result persistence input.
 * @returns Stored public workspace apply result.
 */
export function recordWorkspaceApplyResult(
  workspaceDb: WorkspaceDb,
  input: RecordWorkspaceApplyResultInput
): WorkspaceApplyResult {
  const result = WorkspaceApplyResultSchema.parse(input.result);
  const existing = getWorkspaceApplyResultRow(workspaceDb, result.workspaceId, result.id);
  if (existing) {
    return requireMatchingWorkspaceApplyResultReplay(existing, result, input.requestId);
  }

  const inserted = workspaceDb.sqlite
    .prepare(
      `INSERT INTO workspace_apply_results (
        apply_result_id,
        workspace_id,
        review_id,
        change_set_id,
        status,
        applied_paths_json,
        skipped_paths_json,
        conflict_records_json,
        verification_json,
        commit_ids_json,
        applied_at,
        request_id,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      result.id,
      result.workspaceId,
      result.reviewId,
      result.changeSetId,
      result.status,
      JSON.stringify(result.appliedPaths),
      JSON.stringify(result.skippedPaths),
      JSON.stringify(result.conflictRecords),
      JSON.stringify(result.verification),
      JSON.stringify(result.commitIds),
      result.appliedAt,
      input.requestId,
      result.appliedAt,
      result.appliedAt
    );

  if (inserted.changes > 0) {
    recordWorkspaceAuditEvent({
      action: 'workspace.apply.finish',
      category: 'artifact',
      errorCode: result.status === 'blocked' ? 'workspace_apply_blocked' : null,
      now: new Date(result.appliedAt),
      outcome: workspaceApplyAuditOutcome(result.status),
      requestId: input.requestId,
      resource: `workspace-review:${result.reviewId}`,
      severity: workspaceApplyAuditSeverity(result.status),
      summary: workspaceApplyAuditSummary(result),
      workspaceDb,
      workspaceId: result.workspaceId,
    });
    recordWorkspaceEvidenceBundle(workspaceDb, {
      id: `evb_workspace_apply_${result.id}`,
      workspaceId: result.workspaceId,
      threadId: null,
      goalId: null,
      turnId: null,
      agentSessionId: null,
      backendType: null,
      sourceKind: 'workspace-apply-result',
      summary: workspaceApplyAuditSummary(result),
      rawEvidenceRefs: [],
      redactedEvidenceRefs: [
        { kind: 'workspace-apply-result', ref: `workspace-apply-result:${result.id}` },
        { kind: 'workspace-review', ref: `workspace-review:${result.reviewId}` },
        { kind: 'workspace-change-set', ref: `workspace-change-set:${result.changeSetId}` },
      ],
      contentDigests: [],
      retentionClass: 'workspace-audit',
      sensitivityClass: 'product-safe',
      importStatus: 'promoted',
      requiredFeatures: ['evidence.bundle.v1'],
      createdAt: result.appliedAt,
    });
  }

  return requireWorkspaceApplyResult(workspaceDb, result.workspaceId, result.id);
}

/**
 * Maps a workspace apply status to audit outcome.
 *
 * @param status Workspace apply result status.
 * @returns Audit outcome.
 */
function workspaceApplyAuditOutcome(
  status: WorkspaceApplyResult['status']
): 'succeeded' | 'failed' | 'denied' | 'cancelled' {
  return status === 'applied' ? 'succeeded' : 'failed';
}

/**
 * Maps a workspace apply status to audit severity.
 *
 * @param status Workspace apply result status.
 * @returns Audit severity.
 */
function workspaceApplyAuditSeverity(status: WorkspaceApplyResult['status']): 'info' | 'warning' {
  return status === 'applied' ? 'info' : 'warning';
}

/**
 * Builds a redacted workspace apply audit summary.
 *
 * @param result Workspace apply result.
 * @returns Redacted audit summary.
 */
function workspaceApplyAuditSummary(result: WorkspaceApplyResult): string {
  return `Workspace apply result ${result.status}: ${result.appliedPaths.length} applied path, ${result.skippedPaths.length} skipped paths, ${result.conflictRecords.length} conflicts`;
}

/**
 * Reads one durable workspace apply result.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @param applyResultId Apply result id.
 * @returns Stored workspace apply result, or null.
 */
export function getWorkspaceApplyResult(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  applyResultId: string
): WorkspaceApplyResult | null {
  const row = getWorkspaceApplyResultRow(workspaceDb, workspaceId, applyResultId);

  return row ? mapWorkspaceApplyResultRow(row) : null;
}

/**
 * Lists durable workspace apply results for one workspace.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Stored workspace apply results in stable newest-first order.
 */
export function listWorkspaceApplyResults(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): WorkspaceApplyResult[] {
  return (
    workspaceDb.sqlite
      .prepare(
        `SELECT
          apply_result_id,
          workspace_id,
          review_id,
          change_set_id,
          status,
          applied_paths_json,
          skipped_paths_json,
          conflict_records_json,
          verification_json,
          commit_ids_json,
          applied_at,
          request_id,
          created_at,
          updated_at
        FROM workspace_apply_results
        WHERE workspace_id = ?
        ORDER BY applied_at ASC, apply_result_id ASC`
      )
      .all(workspaceId) as WorkspaceApplyResultRow[]
  )
    .map(mapWorkspaceApplyResultRow)
    .reverse();
}

/**
 * Lists durable workspace apply results for export in stable dependency order.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Exportable workspace apply results in oldest-first order.
 */
export function listExportableWorkspaceApplyResults(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): ExportedWorkspaceApplyResult[] {
  return (
    workspaceDb.sqlite
      .prepare(
        `SELECT
          apply_result_id,
          workspace_id,
          review_id,
          change_set_id,
          status,
          applied_paths_json,
          skipped_paths_json,
          conflict_records_json,
          verification_json,
          commit_ids_json,
          applied_at,
          request_id,
          created_at,
          updated_at
        FROM workspace_apply_results
        WHERE workspace_id = ?
        ORDER BY applied_at ASC, apply_result_id ASC`
      )
      .all(workspaceId) as WorkspaceApplyResultRow[]
  ).map((row) => ({ ...mapWorkspaceApplyResultRow(row), requestId: row.request_id }));
}

/**
 * Replays imported workspace apply results without emitting new apply-finish audit events.
 *
 * @param workspaceDb Open target workspace database handle.
 * @param results Exported workspace apply results to replay.
 */
export function importWorkspaceApplyResults(
  workspaceDb: WorkspaceDb,
  results: readonly ExportedWorkspaceApplyResult[]
): void {
  for (const record of results) {
    const { requestId, ...publicRecord } = record;
    const result = WorkspaceApplyResultSchema.parse(publicRecord);
    if (typeof requestId !== 'string' || requestId.length === 0) {
      throw new Error('Workspace apply result import record is missing requestId.');
    }
    const existing = getWorkspaceApplyResultRow(workspaceDb, result.workspaceId, result.id);
    if (existing) {
      requireMatchingWorkspaceApplyResultReplay(existing, result, requestId);
      continue;
    }

    workspaceDb.sqlite
      .prepare(
        `INSERT INTO workspace_apply_results (
          apply_result_id,
          workspace_id,
          review_id,
          change_set_id,
          status,
          applied_paths_json,
          skipped_paths_json,
          conflict_records_json,
          verification_json,
          commit_ids_json,
          applied_at,
          request_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        result.id,
        result.workspaceId,
        result.reviewId,
        result.changeSetId,
        result.status,
        JSON.stringify(result.appliedPaths),
        JSON.stringify(result.skippedPaths),
        JSON.stringify(result.conflictRecords),
        JSON.stringify(result.verification),
        JSON.stringify(result.commitIds),
        result.appliedAt,
        requestId,
        result.appliedAt,
        result.appliedAt
      );
  }
}

/**
 * Reads one durable workspace apply result or throws.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @param applyResultId Apply result id.
 * @returns Stored workspace apply result.
 * @throws Error when the result does not exist.
 */
export function requireWorkspaceApplyResult(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  applyResultId: string
): WorkspaceApplyResult {
  const result = getWorkspaceApplyResult(workspaceDb, workspaceId, applyResultId);

  if (!result) {
    throw new Error(`Workspace apply result not found: ${workspaceId}/${applyResultId}`);
  }

  return result;
}

/**
 * Reads one apply-result row by its globally unique storage id.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace that owns the result.
 * @param applyResultId Apply result id.
 * @returns Stored row, or undefined when absent.
 */
function getWorkspaceApplyResultRow(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  applyResultId: string
): WorkspaceApplyResultRow | undefined {
  return workspaceDb.sqlite
    .prepare(
      `SELECT
        apply_result_id,
        workspace_id,
        review_id,
        change_set_id,
        status,
        applied_paths_json,
        skipped_paths_json,
        conflict_records_json,
        verification_json,
        commit_ids_json,
        applied_at,
        request_id,
        created_at,
        updated_at
      FROM workspace_apply_results
      WHERE workspace_id = ? AND apply_result_id = ?`
    )
    .get(workspaceId, applyResultId) as WorkspaceApplyResultRow | undefined;
}

/**
 * Requires a same-id apply-result replay to match every durable field.
 *
 * @param row Existing durable row.
 * @param result Replayed public result.
 * @param requestId Replayed command request id.
 * @returns Existing public result when the replay is exact.
 * @throws Error when any durable field differs.
 */
function requireMatchingWorkspaceApplyResultReplay(
  row: WorkspaceApplyResultRow,
  result: WorkspaceApplyResult,
  requestId: string
): WorkspaceApplyResult {
  const existing = mapWorkspaceApplyResultRow(row);
  if (row.request_id !== requestId || JSON.stringify(existing) !== JSON.stringify(result)) {
    throw new Error(`Workspace apply result replay conflict: ${result.id}`);
  }
  return existing;
}

/**
 * Maps one database row to the public workspace apply result shape.
 *
 * @param row Workspace apply result database row.
 * @returns Public workspace apply result.
 */
function mapWorkspaceApplyResultRow(row: WorkspaceApplyResultRow): WorkspaceApplyResult {
  return WorkspaceApplyResultSchema.parse({
    id: row.apply_result_id,
    workspaceId: row.workspace_id,
    reviewId: row.review_id,
    changeSetId: row.change_set_id,
    status: row.status,
    appliedPaths: parseArray(row.applied_paths_json),
    skippedPaths: parseArray(row.skipped_paths_json),
    conflictRecords: parseArray(row.conflict_records_json),
    verification: parseArray(row.verification_json),
    commitIds: parseArray(row.commit_ids_json),
    appliedAt: row.applied_at,
  });
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
    throw new Error('Stored workspace apply result field is not an array.');
  }

  return parsed;
}

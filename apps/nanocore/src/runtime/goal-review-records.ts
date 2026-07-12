import { and, asc, eq } from 'drizzle-orm';

import { recordWorkspaceAuditEvent } from '../audit-events.js';
import {
  redactInternalAgentDiagnosticValue,
  redactInternalAgentText,
} from '../internal-agents/redaction.js';
import type { WorkspaceDb } from '../storage/db.js';
import { type GoalReviewVerdict, goalReviewRecords } from '../storage/schema/index.js';
import { getGoalRecord, listGoalTasks } from './goal-store.js';
import type { AdvanceGoalAfterReviewResult } from './goal-supervise-advance.js';

/**
 * JSON-compatible evidence captured for a review record after redaction.
 */
export type GoalReviewVerificationEvidence = unknown;

/**
 * Stored app-local review record for one goal task checkpoint.
 */
export interface GoalReviewRecord {
  /** Stable review id. */
  readonly reviewId: string;
  /** Workspace that owns the reviewed task. */
  readonly workspaceId: string;
  /** Thread that owns the reviewed task. */
  readonly threadId: string;
  /** Goal that owns the reviewed task. */
  readonly goalId: string;
  /** Goal task reviewed by this record. */
  readonly taskId: string;
  /** Optional worker or reviewer turn associated with the review. */
  readonly turnId: string | null;
  /** Item ids considered by the review. */
  readonly itemIds: readonly string[];
  /** Artifact ids considered by the review. */
  readonly artifactIds: readonly string[];
  /** Redacted verification evidence considered by the review. */
  readonly verificationEvidence: readonly GoalReviewVerificationEvidence[];
  /** Review verdict. */
  readonly verdict: GoalReviewVerdict;
  /** Redacted human-readable review reason. */
  readonly reason: string;
  /** ISO timestamp for review record creation. */
  readonly createdAt: string;
  /** ISO timestamp for latest review record update. */
  readonly updatedAt: string;
  /** ISO timestamp when the review was resolved through the Action Center. */
  readonly resolvedAt: string | null;
  /** Request id that resolved this review, if resolved. */
  readonly resolutionRequestId: string | null;
  /** Immutable first successful task-graph advance result. */
  readonly resolutionSnapshot: AdvanceGoalAfterReviewResult | null;
}

/**
 * Input used to create one goal review record.
 */
export interface CreateGoalReviewRecordInput {
  /** Stable review id. */
  readonly reviewId: string;
  /** Workspace that owns the reviewed task. */
  readonly workspaceId: string;
  /** Thread that owns the reviewed task. */
  readonly threadId: string;
  /** Goal that owns the reviewed task. */
  readonly goalId: string;
  /** Goal task reviewed by this record. */
  readonly taskId: string;
  /** Optional worker or reviewer turn associated with the review. */
  readonly turnId?: string | null;
  /** Item ids considered by the review. */
  readonly itemIds?: readonly string[];
  /** Artifact ids considered by the review. */
  readonly artifactIds?: readonly string[];
  /** Verification evidence considered by the review. */
  readonly verificationEvidence?: readonly GoalReviewVerificationEvidence[];
  /** Review verdict. */
  readonly verdict: GoalReviewVerdict;
  /** Human-readable review reason, redacted before storage. */
  readonly reason: string;
  /** Optional clock used by deterministic tests. */
  readonly now?: () => string;
}

/**
 * Input used to identify a goal task review record list.
 */
export interface GoalReviewRecordListInput {
  /** Workspace that owns the reviewed task. */
  readonly workspaceId: string;
  /** Thread that owns the reviewed task. */
  readonly threadId: string;
  /** Goal that owns the reviewed task. */
  readonly goalId: string;
  /** Goal task reviewed by the records. */
  readonly taskId: string;
}

/**
 * Input used to resolve one goal review record after applying its verdict.
 */
export interface ResolveGoalReviewRecordInput {
  /** Workspace that owns the reviewed task. */
  readonly workspaceId: string;
  /** Thread that owns the reviewed task. */
  readonly threadId: string;
  /** Goal that owns the reviewed task. */
  readonly goalId: string;
  /** Review record to resolve. */
  readonly reviewId: string;
  /** Request id that resolved the review. */
  readonly requestId: string;
  /** Immutable task-graph advance result to store with the first resolution. */
  readonly resolutionSnapshot: AdvanceGoalAfterReviewResult;
  /** Optional clock used by deterministic tests. */
  readonly now?: () => string;
}

/**
 * Creates one app-local goal review record after confirming goal task ownership.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Goal review record creation input.
 * @returns Stored goal review record.
 * @throws Error when the goal or task does not exist in the requested scope.
 */
export function createGoalReviewRecord(
  workspaceDb: WorkspaceDb,
  input: CreateGoalReviewRecordInput
): GoalReviewRecord {
  assertGoalTaskExists(workspaceDb, input);

  const timestamp = input.now?.() ?? new Date().toISOString();

  workspaceDb.db
    .insert(goalReviewRecords)
    .values({
      reviewId: input.reviewId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      goalId: input.goalId,
      taskId: input.taskId,
      turnId: input.turnId ?? null,
      itemIdsJson: JSON.stringify(input.itemIds ?? []),
      artifactIdsJson: JSON.stringify(input.artifactIds ?? []),
      verificationEvidenceJson: JSON.stringify(
        redactVerificationEvidence(input.verificationEvidence)
      ),
      verdict: input.verdict,
      reason: redactInternalAgentText(input.reason),
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .run();

  const record = requireGoalReviewRecord(
    workspaceDb,
    input.workspaceId,
    input.threadId,
    input.goalId,
    input.reviewId
  );
  recordGoalReviewAuditEvent(workspaceDb, record);
  return record;
}

/**
 * Reads one review record by workspace, thread, goal, and review id.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @param threadId Thread id.
 * @param goalId Goal id.
 * @param reviewId Review id.
 * @returns Stored review record, or null.
 */
export function getGoalReviewRecord(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  threadId: string,
  goalId: string,
  reviewId: string
): GoalReviewRecord | null {
  const row = workspaceDb.db
    .select()
    .from(goalReviewRecords)
    .where(
      and(
        eq(goalReviewRecords.workspaceId, workspaceId),
        eq(goalReviewRecords.threadId, threadId),
        eq(goalReviewRecords.goalId, goalId),
        eq(goalReviewRecords.reviewId, reviewId)
      )
    )
    .all()
    .at(0);

  return row ? mapGoalReviewRecordRow(row) : null;
}

/**
 * Lists review records for one goal task in deterministic order.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Goal task review list input.
 * @returns Stored review records.
 */
export function listGoalReviewRecordsForTask(
  workspaceDb: WorkspaceDb,
  input: GoalReviewRecordListInput
): GoalReviewRecord[] {
  return workspaceDb.db
    .select()
    .from(goalReviewRecords)
    .where(
      and(
        eq(goalReviewRecords.workspaceId, input.workspaceId),
        eq(goalReviewRecords.threadId, input.threadId),
        eq(goalReviewRecords.goalId, input.goalId),
        eq(goalReviewRecords.taskId, input.taskId)
      )
    )
    .orderBy(asc(goalReviewRecords.createdAt), asc(goalReviewRecords.reviewId))
    .all()
    .map(mapGoalReviewRecordRow);
}

/**
 * Lists all goal review records for one workspace in stable export order.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Goal review records in stable order.
 */
export function listExportableGoalReviewRecords(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): GoalReviewRecord[] {
  return workspaceDb.db
    .select()
    .from(goalReviewRecords)
    .where(eq(goalReviewRecords.workspaceId, workspaceId))
    .orderBy(
      asc(goalReviewRecords.createdAt),
      asc(goalReviewRecords.threadId),
      asc(goalReviewRecords.goalId),
      asc(goalReviewRecords.reviewId)
    )
    .all()
    .map(mapGoalReviewRecordRow);
}

/**
 * Replays imported goal review records without emitting review audit events.
 *
 * @param workspaceDb Open target workspace database handle.
 * @param records Goal review records to replay.
 */
export function importGoalReviewRecords(
  workspaceDb: WorkspaceDb,
  records: readonly GoalReviewRecord[]
): void {
  for (const record of records) {
    workspaceDb.db
      .insert(goalReviewRecords)
      .values({
        artifactIdsJson: JSON.stringify(record.artifactIds),
        createdAt: record.createdAt,
        goalId: record.goalId,
        itemIdsJson: JSON.stringify(record.itemIds),
        reason: record.reason,
        resolvedAt: record.resolvedAt,
        resolutionRequestId: record.resolutionRequestId,
        resolutionSnapshotJson: record.resolutionSnapshot
          ? JSON.stringify(record.resolutionSnapshot)
          : null,
        reviewId: record.reviewId,
        taskId: record.taskId,
        threadId: record.threadId,
        turnId: record.turnId,
        updatedAt: record.updatedAt,
        verdict: record.verdict,
        verificationEvidenceJson: JSON.stringify(record.verificationEvidence),
        workspaceId: record.workspaceId,
      })
      .onConflictDoNothing()
      .run();
  }
}

/**
 * Marks one goal review record as resolved after its verdict has been applied.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Scoped review resolution input.
 * @returns Resolved review record.
 * @throws Error when the review record does not exist in the requested scope.
 */
export function resolveGoalReviewRecord(
  workspaceDb: WorkspaceDb,
  input: ResolveGoalReviewRecordInput
): GoalReviewRecord {
  const existing = requireGoalReviewRecord(
    workspaceDb,
    input.workspaceId,
    input.threadId,
    input.goalId,
    input.reviewId
  );

  if (existing.resolvedAt) {
    return existing;
  }

  const timestamp = input.now?.() ?? new Date().toISOString();

  workspaceDb.db
    .update(goalReviewRecords)
    .set({
      resolvedAt: timestamp,
      resolutionRequestId: input.requestId,
      resolutionSnapshotJson: JSON.stringify(input.resolutionSnapshot),
      updatedAt: timestamp,
    })
    .where(
      and(
        eq(goalReviewRecords.workspaceId, input.workspaceId),
        eq(goalReviewRecords.threadId, input.threadId),
        eq(goalReviewRecords.goalId, input.goalId),
        eq(goalReviewRecords.reviewId, input.reviewId)
      )
    )
    .run();

  return requireGoalReviewRecord(
    workspaceDb,
    input.workspaceId,
    input.threadId,
    input.goalId,
    input.reviewId
  );
}

/**
 * Reads one review record or throws a scoped ownership error.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @param threadId Thread id.
 * @param goalId Goal id.
 * @param reviewId Review id.
 * @returns Stored review record.
 * @throws Error when the review record does not exist in the requested scope.
 */
function requireGoalReviewRecord(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  threadId: string,
  goalId: string,
  reviewId: string
): GoalReviewRecord {
  const record = getGoalReviewRecord(workspaceDb, workspaceId, threadId, goalId, reviewId);

  if (!record) {
    throw new Error(
      `Goal review record not found: ${workspaceId}/${threadId}/${goalId}/${reviewId}`
    );
  }

  return record;
}

/**
 * Records audit lineage for stored goal review evidence.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param record Stored review record.
 */
function recordGoalReviewAuditEvent(workspaceDb: WorkspaceDb, record: GoalReviewRecord): void {
  recordWorkspaceAuditEvent({
    action: 'goal.review.record',
    category: 'system',
    now: new Date(record.createdAt),
    outcome: goalReviewAuditOutcome(record.verdict),
    resource: `goal-review:${record.reviewId}`,
    severity: record.verdict === 'accept' ? 'info' : 'warning',
    summary: `Goal review ${record.verdict}: ${record.reason}`,
    threadId: record.threadId,
    turnId: record.turnId,
    workspaceDb,
    workspaceId: record.workspaceId,
  });
}

/**
 * Maps a goal review verdict to an audit outcome.
 *
 * @param verdict Stored goal review verdict.
 * @returns Audit event outcome.
 */
function goalReviewAuditOutcome(
  verdict: GoalReviewVerdict
): 'succeeded' | 'failed' | 'denied' | 'cancelled' {
  return verdict === 'accept' ? 'succeeded' : verdict === 'abort' ? 'cancelled' : 'failed';
}

/**
 * Confirms a goal task exists in the requested workspace, thread, and goal scope.
 *
 * @param coreDb Open Core database handles.
 * @param input Goal task scope.
 * @throws Error when the goal or task does not exist in the requested scope.
 */
function assertGoalTaskExists(workspaceDb: WorkspaceDb, input: GoalReviewRecordListInput): void {
  const goal = getGoalRecord(workspaceDb, input.workspaceId, input.threadId, input.goalId);

  if (!goal) {
    throw new Error(`Goal not found: ${input.workspaceId}/${input.threadId}/${input.goalId}`);
  }

  const task = listGoalTasks(workspaceDb, input).find(
    (candidate) => candidate.taskId === input.taskId
  );

  if (!task) {
    throw new Error(`Goal task not found: ${input.goalId}/${input.taskId}`);
  }
}

/**
 * Maps a goal review row to a store record.
 *
 * @param row Goal review row.
 * @returns Goal review store record.
 */
function mapGoalReviewRecordRow(row: typeof goalReviewRecords.$inferSelect): GoalReviewRecord {
  return {
    reviewId: row.reviewId,
    workspaceId: row.workspaceId,
    threadId: row.threadId,
    goalId: row.goalId,
    taskId: row.taskId,
    turnId: row.turnId,
    itemIds: parseStringArray(row.itemIdsJson),
    artifactIds: parseStringArray(row.artifactIdsJson),
    verificationEvidence: parseEvidenceArray(row.verificationEvidenceJson),
    verdict: row.verdict,
    reason: row.reason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    resolvedAt: row.resolvedAt,
    resolutionRequestId: row.resolutionRequestId,
    resolutionSnapshot: parseResolutionSnapshot(row.resolutionSnapshotJson),
  };
}

/**
 * Redacts review verification evidence before it is serialized for storage.
 *
 * @param evidence Verification evidence values.
 * @returns Redacted evidence array.
 */
function redactVerificationEvidence(
  evidence: readonly GoalReviewVerificationEvidence[] | undefined
): readonly GoalReviewVerificationEvidence[] {
  const redacted = redactInternalAgentDiagnosticValue(evidence ?? []);

  if (!Array.isArray(redacted)) {
    return [];
  }

  return redacted;
}

/**
 * Parses a stored JSON string array.
 *
 * @param value JSON string value to parse.
 * @returns Parsed string array.
 * @throws Error when the stored JSON is malformed.
 */
function parseStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;

  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    throw new Error('Stored goal review JSON field is not a string array.');
  }

  return parsed;
}

/**
 * Parses a stored JSON evidence array.
 *
 * @param value JSON string value to parse.
 * @returns Parsed evidence array.
 * @throws Error when the stored JSON is malformed.
 */
function parseEvidenceArray(value: string): GoalReviewVerificationEvidence[] {
  const parsed = JSON.parse(value) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error('Stored goal review evidence field is not an array.');
  }

  return parsed;
}

/**
 * Parses one stored Goal Review resolution snapshot.
 *
 * @param value Nullable JSON snapshot text.
 * @returns Parsed immutable resolution snapshot.
 * @throws Error when the stored JSON is malformed.
 */
function parseResolutionSnapshot(value: string | null): AdvanceGoalAfterReviewResult | null {
  if (value === null) {
    return null;
  }

  const parsed = JSON.parse(value) as unknown;

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    ![
      'complete_next_task',
      'complete_goal',
      'continue',
      'retry',
      'needs_revision',
      'decompose',
      'awaiting_human',
      'blocked',
      'aborted',
    ].includes(String((parsed as { outcome?: unknown }).outcome)) ||
    !(parsed as { task?: unknown }).task ||
    typeof (parsed as { task?: unknown }).task !== 'object' ||
    Array.isArray((parsed as { task?: unknown }).task) ||
    ((parsed as { goal?: unknown }).goal !== null &&
      (typeof (parsed as { goal?: unknown }).goal !== 'object' ||
        Array.isArray((parsed as { goal?: unknown }).goal))) ||
    ((parsed as { nextTask?: unknown }).nextTask !== null &&
      (typeof (parsed as { nextTask?: unknown }).nextTask !== 'object' ||
        Array.isArray((parsed as { nextTask?: unknown }).nextTask)))
  ) {
    throw new Error('Stored goal review resolution snapshot is malformed.');
  }

  return parsed as AdvanceGoalAfterReviewResult;
}

import {
  type GoalReviewResolutionSnapshot,
  GoalReviewResolutionSnapshotSchema,
  type GoalReviewVerdict,
} from '@openkit/app-api-schemas';
import { and, asc, eq, isNull } from 'drizzle-orm';

import { recordWorkspaceAuditEvent } from '../audit-events.js';
import {
  redactInternalAgentDiagnosticValue,
  redactInternalAgentText,
} from '../internal-agents/redaction.js';
import type { WorkspaceDb } from '../storage/db.js';
import { goalReviewRecords } from '../storage/schema/index.js';
import { getGoalRecord, listGoalTasks } from './goal-store.js';

/** JSON-compatible evidence captured for a Review record after redaction. */
export type GoalReviewVerificationEvidence = unknown;

/** Stable failures produced while claiming or replaying one Review resolution. */
export type GoalReviewResolutionErrorCode =
  | 'idempotency_key_conflict'
  | 'stale'
  | 'recovery_required';

/** Error raised when a Goal Review cannot be resolved or replayed safely. */
export class GoalReviewResolutionError extends Error {
  /** Stable App API error code. */
  public readonly code: GoalReviewResolutionErrorCode;
  /** HTTP conflict status shared by Review authority failures. */
  public readonly status = 409;

  /**
   * Creates one Goal Review authority error.
   *
   * @param code Stable error code.
   * @param message Product-safe error message.
   */
  public constructor(code: GoalReviewResolutionErrorCode, message: string) {
    super(message);
    this.name = 'GoalReviewResolutionError';
    this.code = code;
  }
}

/** Stored app-local Review record for one Goal Task checkpoint. */
export interface GoalReviewRecord {
  /** Stable Review id. */
  readonly reviewId: string;
  /** Workspace that owns the reviewed Task. */
  readonly workspaceId: string;
  /** Thread that owns the reviewed Task. */
  readonly threadId: string;
  /** Goal that owns the reviewed Task. */
  readonly goalId: string;
  /** Goal Task reviewed by this record. */
  readonly taskId: string;
  /** Worker Turn whose output is under review. */
  readonly turnId: string;
  /** Item ids considered by the Review. */
  readonly itemIds: readonly string[];
  /** Artifact ids considered by the Review. */
  readonly artifactIds: readonly string[];
  /** Redacted verification evidence considered by the Review. */
  readonly verificationEvidence: readonly GoalReviewVerificationEvidence[];
  /** Redacted human-facing decision prompt fixed at creation. */
  readonly prompt: string;
  /** Goal step request that created the Review. */
  readonly createdByRequestId: string;
  /** Human verdict, null while unresolved. */
  readonly verdict: GoalReviewVerdict | null;
  /** Redacted human-readable reason when supplied. */
  readonly reason: string | null;
  /** Redacted refinement instruction, only for a refine verdict. */
  readonly revisionInstruction: string | null;
  /** ISO timestamp for Review creation. */
  readonly createdAt: string;
  /** ISO timestamp for the latest Review update. */
  readonly updatedAt: string;
  /** ISO timestamp when the Review was resolved. */
  readonly resolvedAt: string | null;
  /** Request id that resolved the Review. */
  readonly resolutionRequestId: string | null;
  /** Authenticated actor that resolved the Review. */
  readonly resolvedByActorId: string | null;
  /** Immutable first successful Task and Goal result. */
  readonly resolutionSnapshot: GoalReviewResolutionSnapshot | null;
}

/** Input used to create one unresolved Goal Review record. */
export interface CreateGoalReviewRecordInput {
  /** Stable Review id. */
  readonly reviewId: string;
  /** Workspace that owns the reviewed Task. */
  readonly workspaceId: string;
  /** Thread that owns the reviewed Task. */
  readonly threadId: string;
  /** Goal that owns the reviewed Task. */
  readonly goalId: string;
  /** Goal Task reviewed by this record. */
  readonly taskId: string;
  /** Worker Turn whose output is under review. */
  readonly turnId: string;
  /** Item ids considered by the Review. */
  readonly itemIds?: readonly string[];
  /** Artifact ids considered by the Review. */
  readonly artifactIds?: readonly string[];
  /** Verification evidence considered by the Review. */
  readonly verificationEvidence?: readonly GoalReviewVerificationEvidence[];
  /** Human-facing Review prompt, redacted before storage. */
  readonly prompt: string;
  /** Goal step request that created the Review. */
  readonly createdByRequestId: string;
  /** Optional clock used by deterministic tests. */
  readonly now?: () => string;
}

/** Input used to identify a Goal Task Review list. */
export interface GoalReviewRecordListInput {
  /** Workspace that owns the reviewed Task. */
  readonly workspaceId: string;
  /** Thread that owns the reviewed Task. */
  readonly threadId: string;
  /** Goal that owns the reviewed Task. */
  readonly goalId: string;
  /** Goal Task reviewed by the records. */
  readonly taskId: string;
}

/** Input used to claim or replay one Goal Review resolution. */
export interface ResolveGoalReviewRecordInput {
  /** Workspace that owns the reviewed Task. */
  readonly workspaceId: string;
  /** Thread that owns the reviewed Task. */
  readonly threadId: string;
  /** Goal that owns the reviewed Task. */
  readonly goalId: string;
  /** Review record to resolve. */
  readonly reviewId: string;
  /** Request id claiming the Review. */
  readonly requestId: string;
  /** Authenticated actor claiming the Review. */
  readonly actorId: string;
  /** Human Review verdict. */
  readonly verdict: GoalReviewVerdict;
  /** Optional human-readable reason. */
  readonly reason?: string;
  /** Required instruction for a refine verdict. */
  readonly revisionInstruction?: string;
  /** Immutable Task and Goal result produced in the owning transaction. */
  readonly resolutionSnapshot: GoalReviewResolutionSnapshot;
  /** Optional clock used by deterministic tests. */
  readonly now?: () => string;
}

/**
 * Creates one unresolved Review after confirming Goal Task ownership.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Review creation input.
 * @returns Stored unresolved Review.
 * @throws Error when the Goal or Task does not exist in the requested scope.
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
      turnId: input.turnId,
      itemIdsJson: JSON.stringify(input.itemIds ?? []),
      artifactIdsJson: JSON.stringify(input.artifactIds ?? []),
      verificationEvidenceJson: JSON.stringify(
        redactVerificationEvidence(input.verificationEvidence)
      ),
      prompt: redactInternalAgentText(input.prompt),
      createdByRequestId: input.createdByRequestId,
      verdict: null,
      reason: null,
      revisionInstruction: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      resolvedAt: null,
      resolutionRequestId: null,
      resolvedByActorId: null,
      resolutionSnapshotJson: null,
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
 * Reads one Review by workspace, thread, Goal, and Review id.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @param threadId Thread id.
 * @param goalId Goal id.
 * @param reviewId Review id.
 * @returns Stored Review, or null.
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
 * Lists Reviews for one Goal Task in deterministic order.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Goal Task Review list input.
 * @returns Stored Reviews.
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
 * Lists all Goal Review records for one workspace in stable export order.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Goal Review records in stable order.
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
 * Replays imported Goal Review records without emitting audit events.
 *
 * @param workspaceDb Open target workspace database handle.
 * @param records Goal Review records to replay.
 */
export function importGoalReviewRecords(
  workspaceDb: WorkspaceDb,
  records: readonly GoalReviewRecord[]
): void {
  for (const record of records) {
    assertGoalReviewRecordConsistency(record);
    workspaceDb.db
      .insert(goalReviewRecords)
      .values({
        artifactIdsJson: JSON.stringify(record.artifactIds),
        createdAt: record.createdAt,
        createdByRequestId: record.createdByRequestId,
        goalId: record.goalId,
        itemIdsJson: JSON.stringify(record.itemIds),
        prompt: record.prompt,
        reason: record.reason,
        resolvedAt: record.resolvedAt,
        resolvedByActorId: record.resolvedByActorId,
        resolutionRequestId: record.resolutionRequestId,
        resolutionSnapshotJson: record.resolutionSnapshot
          ? JSON.stringify(record.resolutionSnapshot)
          : null,
        reviewId: record.reviewId,
        revisionInstruction: record.revisionInstruction,
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
 * Claims one unresolved Review or replays its winning request.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Scoped Review resolution input.
 * @returns Resolved Review record.
 * @throws GoalReviewResolutionError for conflict, stale, or contradictory state.
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
  const reason = input.reason ? redactInternalAgentText(input.reason) : null;
  const revisionInstruction = input.revisionInstruction
    ? redactInternalAgentText(input.revisionInstruction)
    : null;
  assertDecisionInput(input.verdict, reason, revisionInstruction);

  if (existing.resolvedAt !== null) {
    return replayResolvedGoalReview(existing, input, reason, revisionInstruction);
  }

  const parsedSnapshot = GoalReviewResolutionSnapshotSchema.safeParse(input.resolutionSnapshot);
  if (!parsedSnapshot.success) {
    throw recoveryRequired('Goal Review resolution snapshot is missing.');
  }
  const resolutionSnapshot = parsedSnapshot.data;
  assertResolutionMatchesReview(existing, input.verdict, resolutionSnapshot);
  const timestamp = input.now?.() ?? new Date().toISOString();
  const result = workspaceDb.db
    .update(goalReviewRecords)
    .set({
      verdict: input.verdict,
      reason,
      revisionInstruction,
      resolvedAt: timestamp,
      resolutionRequestId: input.requestId,
      resolvedByActorId: input.actorId,
      resolutionSnapshotJson: JSON.stringify(resolutionSnapshot),
      updatedAt: timestamp,
    })
    .where(
      and(
        eq(goalReviewRecords.workspaceId, input.workspaceId),
        eq(goalReviewRecords.threadId, input.threadId),
        eq(goalReviewRecords.goalId, input.goalId),
        eq(goalReviewRecords.reviewId, input.reviewId),
        isNull(goalReviewRecords.verdict),
        isNull(goalReviewRecords.reason),
        isNull(goalReviewRecords.revisionInstruction),
        isNull(goalReviewRecords.resolvedAt),
        isNull(goalReviewRecords.resolutionRequestId),
        isNull(goalReviewRecords.resolvedByActorId),
        isNull(goalReviewRecords.resolutionSnapshotJson)
      )
    )
    .run();

  const resolved = requireGoalReviewRecord(
    workspaceDb,
    input.workspaceId,
    input.threadId,
    input.goalId,
    input.reviewId
  );
  if (result.changes !== 1) {
    return replayResolvedGoalReview(resolved, input, reason, revisionInstruction);
  }
  return resolved;
}

/**
 * Returns the winning resolution for an identical request.
 *
 * @param record Resolved Review record.
 * @param input Attempted resolution input.
 * @param reason Redacted attempted reason.
 * @param revisionInstruction Redacted attempted refinement instruction.
 * @returns Existing winning Review.
 * @throws GoalReviewResolutionError for changed input or a competing request.
 */
function replayResolvedGoalReview(
  record: GoalReviewRecord,
  input: ResolveGoalReviewRecordInput,
  reason: string | null,
  revisionInstruction: string | null
): GoalReviewRecord {
  if (record.resolutionRequestId !== input.requestId) {
    throw new GoalReviewResolutionError(
      'stale',
      'Goal Review was already resolved by another request.'
    );
  }
  if (
    record.resolvedByActorId !== input.actorId ||
    record.verdict !== input.verdict ||
    record.reason !== reason ||
    record.revisionInstruction !== revisionInstruction
  ) {
    throw new GoalReviewResolutionError(
      'idempotency_key_conflict',
      'The requestId was already used for different Goal Review input.'
    );
  }
  return record;
}

/**
 * Reads one Review or throws a scoped ownership error.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @param threadId Thread id.
 * @param goalId Goal id.
 * @param reviewId Review id.
 * @returns Stored Review.
 * @throws Error when the Review does not exist in the requested scope.
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
 * Records audit lineage for one unresolved Review request.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param record Stored unresolved Review.
 */
function recordGoalReviewAuditEvent(workspaceDb: WorkspaceDb, record: GoalReviewRecord): void {
  recordWorkspaceAuditEvent({
    action: 'goal.review.record',
    category: 'system',
    now: new Date(record.createdAt),
    outcome: 'succeeded',
    resource: `goal-review:${record.reviewId}`,
    severity: 'info',
    summary: `Goal review requested: ${record.prompt}`,
    threadId: record.threadId,
    turnId: record.turnId,
    workspaceDb,
    workspaceId: record.workspaceId,
  });
}

/**
 * Confirms a Goal Task exists in the requested scope.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Goal Task scope.
 * @throws Error when the Goal or Task does not exist.
 */
function assertGoalTaskExists(workspaceDb: WorkspaceDb, input: GoalReviewRecordListInput): void {
  const goal = getGoalRecord(workspaceDb, input.workspaceId, input.threadId, input.goalId);
  if (!goal) {
    throw new Error(`Goal not found: ${input.workspaceId}/${input.threadId}/${input.goalId}`);
  }
  if (!listGoalTasks(workspaceDb, input).some((task) => task.taskId === input.taskId)) {
    throw new Error(`Goal task not found: ${input.goalId}/${input.taskId}`);
  }
}

/**
 * Maps a database row to a validated Review record.
 *
 * @param row Goal Review database row.
 * @returns Validated Review record.
 * @throws GoalReviewResolutionError when the stored decision tuple is contradictory.
 */
function mapGoalReviewRecordRow(row: typeof goalReviewRecords.$inferSelect): GoalReviewRecord {
  const record: GoalReviewRecord = {
    reviewId: row.reviewId,
    workspaceId: row.workspaceId,
    threadId: row.threadId,
    goalId: row.goalId,
    taskId: row.taskId,
    turnId: row.turnId,
    itemIds: parseStringArray(row.itemIdsJson),
    artifactIds: parseStringArray(row.artifactIdsJson),
    verificationEvidence: parseEvidenceArray(row.verificationEvidenceJson),
    prompt: row.prompt,
    createdByRequestId: row.createdByRequestId,
    verdict: row.verdict,
    reason: row.reason,
    revisionInstruction: row.revisionInstruction,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    resolvedAt: row.resolvedAt,
    resolutionRequestId: row.resolutionRequestId,
    resolvedByActorId: row.resolvedByActorId,
    resolutionSnapshot: parseResolutionSnapshot(row.resolutionSnapshotJson),
  };
  assertGoalReviewRecordConsistency(record);
  return record;
}

/**
 * Rejects partial or semantically inconsistent decision tuples.
 *
 * @param record Goal Review record to validate.
 * @throws GoalReviewResolutionError when the record is contradictory.
 */
export function assertGoalReviewRecordConsistency(record: GoalReviewRecord): void {
  const unresolved =
    record.verdict === null &&
    record.reason === null &&
    record.revisionInstruction === null &&
    record.resolvedAt === null &&
    record.resolutionRequestId === null &&
    record.resolvedByActorId === null &&
    record.resolutionSnapshot === null;
  if (unresolved) {
    return;
  }
  if (
    record.verdict === null ||
    record.resolvedAt === null ||
    record.resolutionRequestId === null ||
    record.resolvedByActorId === null ||
    record.resolutionSnapshot === null
  ) {
    throw recoveryRequired('Goal Review contains a partial decision tuple.');
  }
  assertDecisionInput(record.verdict, record.reason, record.revisionInstruction);
  assertResolutionMatchesReview(record, record.verdict, record.resolutionSnapshot);
}

/**
 * Validates conditional decision fields.
 *
 * @param verdict Human Review verdict.
 * @param reason Optional decision reason.
 * @param revisionInstruction Optional refinement instruction.
 * @throws GoalReviewResolutionError when required fields are absent or misplaced.
 */
function assertDecisionInput(
  verdict: GoalReviewVerdict,
  reason: string | null,
  revisionInstruction: string | null
): void {
  if ((verdict === 'retry' || verdict === 'abort') && reason === null) {
    throw recoveryRequired(`Goal Review ${verdict} decision is missing its reason.`);
  }
  if (verdict === 'refine' && revisionInstruction === null) {
    throw recoveryRequired('Goal Review refine decision is missing its revision instruction.');
  }
  if (verdict !== 'refine' && revisionInstruction !== null) {
    throw recoveryRequired('Goal Review revision instruction exists without a refine verdict.');
  }
}

/**
 * Validates resolution ownership and verdict mapping.
 *
 * @param record Review that owns the result.
 * @param verdict Human Review verdict.
 * @param snapshot Bounded resolution result.
 * @throws GoalReviewResolutionError when ids or outcome disagree with the Review.
 */
function assertResolutionMatchesReview(
  record: Pick<GoalReviewRecord, 'goalId' | 'taskId'>,
  verdict: GoalReviewVerdict,
  snapshot: GoalReviewResolutionSnapshot
): void {
  const expectedOutcomes =
    verdict === 'accept'
      ? ['complete_next_task', 'complete_goal']
      : verdict === 'abort'
        ? ['aborted']
        : [verdict];
  if (!expectedOutcomes.includes(snapshot.outcome)) {
    throw recoveryRequired('Goal Review verdict and resolution outcome are inconsistent.');
  }
  if (snapshot.task.taskId !== record.taskId || snapshot.goal.goalId !== record.goalId) {
    throw recoveryRequired('Goal Review resolution ownership does not match the Review record.');
  }
}

/**
 * Creates one recovery-required authority error.
 *
 * @param message Product-safe contradiction summary.
 * @returns Recovery-required error.
 */
function recoveryRequired(message: string): GoalReviewResolutionError {
  return new GoalReviewResolutionError('recovery_required', message);
}

/**
 * Redacts Review verification evidence before serialization.
 *
 * @param evidence Verification evidence values.
 * @returns Redacted evidence array.
 */
function redactVerificationEvidence(
  evidence: readonly GoalReviewVerificationEvidence[] | undefined
): readonly GoalReviewVerificationEvidence[] {
  const redacted = redactInternalAgentDiagnosticValue(evidence ?? []);
  return Array.isArray(redacted) ? redacted : [];
}

/**
 * Parses one stored JSON string array.
 *
 * @param value JSON string value.
 * @returns Parsed string array.
 * @throws Error when the value is malformed.
 */
function parseStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    throw new Error('Stored goal review JSON field is not a string array.');
  }
  return parsed;
}

/**
 * Parses one stored JSON evidence array.
 *
 * @param value JSON string value.
 * @returns Parsed evidence array.
 * @throws Error when the value is malformed.
 */
function parseEvidenceArray(value: string): GoalReviewVerificationEvidence[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('Stored goal review evidence field is not an array.');
  }
  return parsed;
}

/**
 * Parses one stored bounded resolution snapshot.
 *
 * @param value Nullable JSON snapshot text.
 * @returns Parsed snapshot, or null.
 * @throws GoalReviewResolutionError when the stored snapshot is malformed.
 */
function parseResolutionSnapshot(value: string | null): GoalReviewResolutionSnapshot | null {
  if (value === null) {
    return null;
  }
  try {
    return GoalReviewResolutionSnapshotSchema.parse(JSON.parse(value));
  } catch {
    throw recoveryRequired('Stored Goal Review resolution snapshot is malformed.');
  }
}

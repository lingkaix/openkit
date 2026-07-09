import { and, asc, eq } from 'drizzle-orm';

import { recordWorkspaceAuditEvent } from '../audit-events.js';
import { redactInternalAgentText } from '../internal-agents/redaction.js';
import type { WorkspaceDb } from '../storage/db.js';
import { type GoalVerificationStatus, goalVerificationRecords } from '../storage/schema/index.js';
import { getGoalRecord, listGoalTasks } from './goal-store.js';

/**
 * Stored app-local verification evidence record.
 */
export interface GoalVerificationRecord {
  /** Stable verification record id. */
  readonly verificationId: string;
  /** Workspace that owns the verification evidence. */
  readonly workspaceId: string;
  /** Thread that owns the verification evidence. */
  readonly threadId: string;
  /** Goal that owns the verification evidence. */
  readonly goalId: string;
  /** Optional goal task associated with the evidence. */
  readonly taskId: string | null;
  /** Optional turn associated with the evidence. */
  readonly turnId: string | null;
  /** Optional command id associated with command execution. */
  readonly commandId: string | null;
  /** Optional redacted command or manual check description. */
  readonly command: string | null;
  /** Verification status. */
  readonly status: GoalVerificationStatus;
  /** Redacted human-readable verification summary. */
  readonly summary: string;
  /** Item ids associated with the evidence. */
  readonly itemIds: readonly string[];
  /** Artifact ids associated with the evidence. */
  readonly artifactIds: readonly string[];
  /** Redacted output pointers associated with the evidence. */
  readonly outputPointers: readonly string[];
  /** ISO timestamp for verification record creation. */
  readonly createdAt: string;
  /** ISO timestamp for latest verification record update. */
  readonly updatedAt: string;
}

/**
 * Input used to create one verification record.
 */
export interface CreateGoalVerificationRecordInput {
  /** Stable verification record id. */
  readonly verificationId: string;
  /** Workspace that owns the verification evidence. */
  readonly workspaceId: string;
  /** Thread that owns the verification evidence. */
  readonly threadId: string;
  /** Goal that owns the verification evidence. */
  readonly goalId: string;
  /** Optional goal task associated with the evidence. */
  readonly taskId?: string | null;
  /** Optional turn associated with the evidence. */
  readonly turnId?: string | null;
  /** Optional command id associated with command execution. */
  readonly commandId?: string | null;
  /** Optional command or manual check description, redacted before storage. */
  readonly command?: string | null;
  /** Verification status. */
  readonly status: GoalVerificationStatus;
  /** Human-readable verification summary, redacted before storage. */
  readonly summary: string;
  /** Item ids associated with the evidence. */
  readonly itemIds?: readonly string[];
  /** Artifact ids associated with the evidence. */
  readonly artifactIds?: readonly string[];
  /** Output pointers associated with the evidence, redacted before storage. */
  readonly outputPointers?: readonly string[];
  /** Optional clock used by deterministic tests. */
  readonly now?: () => string;
}

/**
 * Input used to identify one goal verification record list.
 */
export interface GoalVerificationRecordListInput {
  /** Workspace that owns the verification evidence. */
  readonly workspaceId: string;
  /** Thread that owns the verification evidence. */
  readonly threadId: string;
  /** Goal that owns the verification evidence. */
  readonly goalId: string;
}

/**
 * Input used to identify one goal task verification record list.
 */
export interface GoalTaskVerificationRecordListInput extends GoalVerificationRecordListInput {
  /** Goal task associated with the evidence. */
  readonly taskId: string;
}

/**
 * Creates one app-local goal verification record after confirming ownership.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Verification record creation input.
 * @returns Stored verification record.
 * @throws Error when the goal or optional task does not exist in the requested scope.
 */
export function createGoalVerificationRecord(
  workspaceDb: WorkspaceDb,
  input: CreateGoalVerificationRecordInput
): GoalVerificationRecord {
  assertGoalExists(workspaceDb, input);

  if (input.taskId) {
    assertGoalTaskExists(workspaceDb, { ...input, taskId: input.taskId });
  }

  const timestamp = input.now?.() ?? new Date().toISOString();

  workspaceDb.db
    .insert(goalVerificationRecords)
    .values({
      verificationId: input.verificationId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      goalId: input.goalId,
      taskId: input.taskId ?? null,
      turnId: input.turnId ?? null,
      commandId: input.commandId ?? null,
      command: redactOptionalText(input.command),
      status: input.status,
      summary: redactInternalAgentText(input.summary),
      itemIdsJson: JSON.stringify(input.itemIds ?? []),
      artifactIdsJson: JSON.stringify(input.artifactIds ?? []),
      outputPointersJson: JSON.stringify(redactStringArray(input.outputPointers ?? [])),
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .run();

  const record = requireGoalVerificationRecord(
    workspaceDb,
    input.workspaceId,
    input.threadId,
    input.goalId,
    input.verificationId
  );
  recordGoalVerificationAuditEvent(workspaceDb, record);
  return record;
}

/**
 * Reads one verification record by workspace, thread, goal, and verification id.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @param threadId Thread id.
 * @param goalId Goal id.
 * @param verificationId Verification record id.
 * @returns Stored verification record, or null.
 */
export function getGoalVerificationRecord(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  threadId: string,
  goalId: string,
  verificationId: string
): GoalVerificationRecord | null {
  const row = workspaceDb.db
    .select()
    .from(goalVerificationRecords)
    .where(
      and(
        eq(goalVerificationRecords.workspaceId, workspaceId),
        eq(goalVerificationRecords.threadId, threadId),
        eq(goalVerificationRecords.goalId, goalId),
        eq(goalVerificationRecords.verificationId, verificationId)
      )
    )
    .all()
    .at(0);

  return row ? mapGoalVerificationRecordRow(row) : null;
}

/**
 * Lists verification records for one goal in deterministic order.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Goal verification list input.
 * @returns Stored verification records.
 */
export function listGoalVerificationRecordsForGoal(
  workspaceDb: WorkspaceDb,
  input: GoalVerificationRecordListInput
): GoalVerificationRecord[] {
  return workspaceDb.db
    .select()
    .from(goalVerificationRecords)
    .where(
      and(
        eq(goalVerificationRecords.workspaceId, input.workspaceId),
        eq(goalVerificationRecords.threadId, input.threadId),
        eq(goalVerificationRecords.goalId, input.goalId)
      )
    )
    .orderBy(asc(goalVerificationRecords.createdAt), asc(goalVerificationRecords.verificationId))
    .all()
    .map(mapGoalVerificationRecordRow);
}

/**
 * Lists verification records for one goal task in deterministic order.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Goal task verification list input.
 * @returns Stored verification records.
 */
export function listGoalVerificationRecordsForTask(
  workspaceDb: WorkspaceDb,
  input: GoalTaskVerificationRecordListInput
): GoalVerificationRecord[] {
  return workspaceDb.db
    .select()
    .from(goalVerificationRecords)
    .where(
      and(
        eq(goalVerificationRecords.workspaceId, input.workspaceId),
        eq(goalVerificationRecords.threadId, input.threadId),
        eq(goalVerificationRecords.goalId, input.goalId),
        eq(goalVerificationRecords.taskId, input.taskId)
      )
    )
    .orderBy(asc(goalVerificationRecords.createdAt), asc(goalVerificationRecords.verificationId))
    .all()
    .map(mapGoalVerificationRecordRow);
}

/**
 * Lists all goal verification records for one workspace in stable export order.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Goal verification records in stable order.
 */
export function listExportableGoalVerificationRecords(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): GoalVerificationRecord[] {
  return workspaceDb.db
    .select()
    .from(goalVerificationRecords)
    .where(eq(goalVerificationRecords.workspaceId, workspaceId))
    .orderBy(
      asc(goalVerificationRecords.createdAt),
      asc(goalVerificationRecords.threadId),
      asc(goalVerificationRecords.goalId),
      asc(goalVerificationRecords.verificationId)
    )
    .all()
    .map(mapGoalVerificationRecordRow);
}

/**
 * Replays imported goal verification records without emitting verification audit events.
 *
 * @param workspaceDb Open target workspace database handle.
 * @param records Goal verification records to replay.
 */
export function importGoalVerificationRecords(
  workspaceDb: WorkspaceDb,
  records: readonly GoalVerificationRecord[]
): void {
  for (const record of records) {
    workspaceDb.db
      .insert(goalVerificationRecords)
      .values({
        artifactIdsJson: JSON.stringify(record.artifactIds),
        command: record.command,
        commandId: record.commandId,
        createdAt: record.createdAt,
        goalId: record.goalId,
        itemIdsJson: JSON.stringify(record.itemIds),
        outputPointersJson: JSON.stringify(record.outputPointers),
        status: record.status,
        summary: record.summary,
        taskId: record.taskId,
        threadId: record.threadId,
        turnId: record.turnId,
        updatedAt: record.updatedAt,
        verificationId: record.verificationId,
        workspaceId: record.workspaceId,
      })
      .onConflictDoNothing()
      .run();
  }
}

/**
 * Reads one verification record or throws a scoped ownership error.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @param threadId Thread id.
 * @param goalId Goal id.
 * @param verificationId Verification record id.
 * @returns Stored verification record.
 * @throws Error when the verification record does not exist in the requested scope.
 */
function requireGoalVerificationRecord(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  threadId: string,
  goalId: string,
  verificationId: string
): GoalVerificationRecord {
  const record = getGoalVerificationRecord(
    workspaceDb,
    workspaceId,
    threadId,
    goalId,
    verificationId
  );

  if (!record) {
    throw new Error(
      `Goal verification record not found: ${workspaceId}/${threadId}/${goalId}/${verificationId}`
    );
  }

  return record;
}

/**
 * Records audit lineage for stored goal verification evidence.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param record Stored verification record.
 */
function recordGoalVerificationAuditEvent(
  workspaceDb: WorkspaceDb,
  record: GoalVerificationRecord
): void {
  recordWorkspaceAuditEvent({
    action: 'goal.verification.record',
    category: 'system',
    now: new Date(record.createdAt),
    outcome: record.status === 'passed' ? 'succeeded' : 'failed',
    resource: `goal-verification:${record.verificationId}`,
    severity: record.status === 'passed' ? 'info' : 'warning',
    summary: `Goal verification ${record.status}: ${record.summary}`,
    threadId: record.threadId,
    turnId: record.turnId,
    workspaceDb,
    workspaceId: record.workspaceId,
  });
}

/**
 * Confirms a goal exists in the requested workspace and thread scope.
 *
 * @param coreDb Open Core database handles.
 * @param input Goal scope.
 * @throws Error when the goal does not exist in the requested scope.
 */
function assertGoalExists(workspaceDb: WorkspaceDb, input: GoalVerificationRecordListInput): void {
  const goal = getGoalRecord(workspaceDb, input.workspaceId, input.threadId, input.goalId);

  if (!goal) {
    throw new Error(`Goal not found: ${input.workspaceId}/${input.threadId}/${input.goalId}`);
  }
}

/**
 * Confirms a goal task exists in the requested workspace, thread, and goal scope.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Goal task scope.
 * @throws Error when the goal or task does not exist in the requested scope.
 */
function assertGoalTaskExists(
  workspaceDb: WorkspaceDb,
  input: GoalTaskVerificationRecordListInput
): void {
  assertGoalExists(workspaceDb, input);

  const task = listGoalTasks(workspaceDb, input).find(
    (candidate) => candidate.taskId === input.taskId
  );

  if (!task) {
    throw new Error(`Goal task not found: ${input.goalId}/${input.taskId}`);
  }
}

/**
 * Maps a goal verification row to a store record.
 *
 * @param row Goal verification row.
 * @returns Goal verification store record.
 */
function mapGoalVerificationRecordRow(
  row: typeof goalVerificationRecords.$inferSelect
): GoalVerificationRecord {
  return {
    verificationId: row.verificationId,
    workspaceId: row.workspaceId,
    threadId: row.threadId,
    goalId: row.goalId,
    taskId: row.taskId,
    turnId: row.turnId,
    commandId: row.commandId,
    command: row.command,
    status: row.status,
    summary: row.summary,
    itemIds: parseStringArray(row.itemIdsJson),
    artifactIds: parseStringArray(row.artifactIdsJson),
    outputPointers: parseStringArray(row.outputPointersJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Redacts optional text before storage.
 *
 * @param value Optional text value.
 * @returns Redacted text, or null.
 */
function redactOptionalText(value: string | null | undefined): string | null {
  return value === undefined || value === null ? null : redactInternalAgentText(value);
}

/**
 * Redacts every entry in a string array.
 *
 * @param values String values to redact.
 * @returns Redacted string values.
 */
function redactStringArray(values: readonly string[]): string[] {
  return values.map((value) => redactInternalAgentText(value));
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
    throw new Error('Stored goal verification JSON field is not a string array.');
  }

  return parsed;
}

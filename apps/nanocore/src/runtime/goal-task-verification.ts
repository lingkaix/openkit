import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import type { GoalVerificationStatus } from '../storage/schema/index.js';
import type { GoalPlanVerificationCheck } from './goal-plan.js';
import { type GoalTaskRecord, listGoalTasks } from './goal-store.js';
import {
  createGoalVerificationRecord,
  type GoalVerificationRecord,
} from './goal-verification-records.js';

/**
 * Command execution result accepted by the conservative verification runner.
 */
export interface GoalTaskVerificationCommandResult {
  /** Verification command status. */
  readonly status: Extract<GoalVerificationStatus, 'passed' | 'failed'>;
  /** Human-readable command summary. */
  readonly summary: string;
  /** Redacted or redaction-ready output pointers. */
  readonly outputPointers?: readonly string[];
}

/**
 * Command execution callback used by tests or future host policies.
 *
 * @param command Command string configured on the goal task.
 * @param check Full verification check metadata.
 * @returns Command verification result.
 */
export type GoalTaskVerificationCommandRunner = (
  command: string,
  check: GoalPlanVerificationCheck
) => Promise<GoalTaskVerificationCommandResult>;

/**
 * Input used to run or record configured verification for one goal task.
 */
export interface RunGoalTaskVerificationInput {
  /** Open Core database handles. */
  readonly coreDb: CoreDb;
  /** Open workspace-scope database handle. */
  readonly workspaceDb: WorkspaceDb;
  /** Workspace that owns the task. */
  readonly workspaceId: string;
  /** Thread that owns the task. */
  readonly threadId: string;
  /** Goal that owns the task. */
  readonly goalId: string;
  /** Goal task to verify. */
  readonly taskId: string;
  /** Optional worker turn associated with verification. */
  readonly turnId?: string | null;
  /** Optional deterministic verification id prefix. */
  readonly idPrefix?: string;
  /** Optional command runner. */
  readonly runCommand?: GoalTaskVerificationCommandRunner;
  /** Optional item ids associated with verification. */
  readonly itemIds?: readonly string[];
  /** Optional artifact ids associated with verification. */
  readonly artifactIds?: readonly string[];
  /** Optional clock used by deterministic tests. */
  readonly now?: () => string;
}

/**
 * Result returned after task verification records are stored.
 */
export interface RunGoalTaskVerificationResult {
  /** Stored verification records. */
  readonly records: readonly GoalVerificationRecord[];
}

/**
 * Runs configured task verification where allowed and records unavailable checks otherwise.
 *
 * @param input Goal task verification input.
 * @returns Stored verification records.
 * @throws Error when the goal or task does not exist in the requested scope.
 */
export async function runGoalTaskVerification(
  input: RunGoalTaskVerificationInput
): Promise<RunGoalTaskVerificationResult> {
  const task = requireGoalTask(input);
  const checks =
    task.verificationChecks.length > 0
      ? task.verificationChecks
      : [{ kind: 'manual' as const, description: 'No verification checks configured.' }];
  const records: GoalVerificationRecord[] = [];

  for (const [index, check] of checks.entries()) {
    const verificationId = `${input.idPrefix ?? task.taskId}_${index + 1}`;

    records.push(await runOneVerificationCheck(input, task, check, verificationId));
  }

  return { records };
}

/**
 * Runs or records one configured verification check.
 *
 * @param input Goal task verification input.
 * @param task Stored goal task.
 * @param check Verification check to process.
 * @param verificationId Deterministic verification record id.
 * @returns Stored verification record.
 */
async function runOneVerificationCheck(
  input: RunGoalTaskVerificationInput,
  task: GoalTaskRecord,
  check: GoalPlanVerificationCheck,
  verificationId: string
): Promise<GoalVerificationRecord> {
  if (check.command && input.runCommand) {
    const result = await input.runCommand(check.command, check);

    return createGoalVerificationRecord(input.workspaceDb, {
      verificationId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      goalId: input.goalId,
      taskId: task.taskId,
      turnId: input.turnId ?? null,
      commandId: `${verificationId}_command`,
      command: check.command,
      status: result.status,
      summary: result.summary,
      ...(result.outputPointers ? { outputPointers: result.outputPointers } : {}),
      ...(input.itemIds ? { itemIds: input.itemIds } : {}),
      ...(input.artifactIds ? { artifactIds: input.artifactIds } : {}),
      ...(input.now ? { now: input.now } : {}),
    });
  }

  return createGoalVerificationRecord(input.workspaceDb, {
    verificationId,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    goalId: input.goalId,
    taskId: task.taskId,
    turnId: input.turnId ?? null,
    command: check.command ?? null,
    status: 'unavailable',
    summary: createUnavailableSummary(check),
    outputPointers: [],
    ...(input.itemIds ? { itemIds: input.itemIds } : {}),
    ...(input.artifactIds ? { artifactIds: input.artifactIds } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
}

/**
 * Reads a goal task in the requested scope.
 *
 * @param input Goal task verification input.
 * @returns Stored goal task.
 * @throws Error when the goal or task does not exist in the requested scope.
 */
function requireGoalTask(input: RunGoalTaskVerificationInput): GoalTaskRecord {
  const task = listGoalTasks(input.workspaceDb, {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    goalId: input.goalId,
  }).find((candidate) => candidate.taskId === input.taskId);

  if (!task) {
    throw new Error(`Goal task not found: ${input.goalId}/${input.taskId}`);
  }

  return task;
}

/**
 * Creates a deterministic unavailable verification summary.
 *
 * @param check Verification check that could not run.
 * @returns Human-readable unavailable summary.
 */
function createUnavailableSummary(check: GoalPlanVerificationCheck): string {
  if (check.kind === 'manual') {
    return `Manual verification unavailable: ${check.description}`;
  }

  return `Verification command unavailable: ${check.description}`;
}

import { createHash } from 'node:crypto';

import {
  ApproveThreadGoalPlanRequestSchema,
  ApproveThreadGoalPlanResponseSchema,
  CreateThreadGoalPlanRequestSchema,
  CreateThreadGoalPlanResponseSchema,
  type GoalPendingHumanAttention,
  type GoalTaskCounts,
  type GoalTerminalState,
  type GoalTerminalSummary,
  PauseThreadGoalRequestSchema,
  PauseThreadGoalResponseSchema,
  ResumeThreadGoalRequestSchema,
  ResumeThreadGoalResponseSchema,
  ReviseThreadGoalPlanRequestSchema,
  ReviseThreadGoalPlanResponseSchema,
  RunThreadGoalStepRequestSchema,
  RunThreadGoalStepResponseSchema,
  RunThreadGoalTestSuperviseStepRequestSchema,
  RunThreadGoalTestSuperviseStepResponseSchema,
  StartThreadGoalRequestSchema,
  StartThreadGoalResponseSchema,
  SubmitThreadGoalSteeringRequestSchema,
  type ThreadGoalCurrentTask,
  type ThreadGoalSummary,
  ThreadGoalSummaryResponseSchema,
} from '@openkit/app-api-schemas';
import type { TurnSchema } from '@openkit/protocol';
import type { Context, Hono } from 'hono';
import type { z } from 'zod';

import { asApiError, asCommandError, asInvalidRequestError } from './api-errors.js';
import type { AuthVariables } from './auth/middleware.js';
import type { CoreMode } from './config/mode.js';
import { serializeStructuredWorkerDelegationRequest } from './internal-agents/delegation.js';
import { redactInternalAgentText } from './internal-agents/redaction.js';
import {
  createWorkerCoordinatorDecision,
  createWorkerCoordinatorGoalPlanDraft,
  createWorkerCoordinatorGoalStopDecision,
  projectWorkerCoordinatorGoalPlanDraft,
  type WorkerCoordinatorCandidate,
  type WorkerCoordinatorDecision,
} from './internal-agents/worker-coordinator.js';
import type { CommandRequestRecord, FsStore } from './lib/store.js';
import { registerAppApiRoute } from './openapi.js';
import { recordGoalWorkerLaunchDecision } from './policy/permission-decisions.js';
import {
  approveGoalPlan,
  GoalPlanApprovalError,
  type ReviseGoalPlanResult,
  readGoalPlanRevision,
  reviseGoalPlan,
} from './runtime/goal-plan-approval.js';
import { createGoalPlan, readGoalPlanCreation } from './runtime/goal-planning.js';
import {
  createGoalReviewRecord,
  GoalReviewResolutionError,
  listGoalReviewRecordsForTask,
  resolveGoalReviewRecord,
} from './runtime/goal-review-records.js';
import {
  createGoalRecord,
  type GoalRecord,
  type GoalTaskRecord,
  getGoalPlanRecord,
  getGoalRecord,
  listGoalRecordsForThread,
  listGoalTasks,
  reserveGoalTaskForWorkerTurn,
  updateGoalStatus,
  updateGoalTask,
} from './runtime/goal-store.js';
import { advanceGoalAfterReview } from './runtime/goal-supervise-advance.js';
import { prepareGoalTaskDelegation } from './runtime/goal-task-delegation.js';
import { selectNextReadyGoalTask } from './runtime/goal-task-selector.js';
import {
  type GoalVerificationRecord,
  listGoalVerificationRecordsForGoal,
} from './runtime/goal-verification-records.js';
import { recordGoalTaskWorkerOutcome } from './runtime/goal-worker-outcome.js';
import { startGoalTaskWorkerTurn } from './runtime/goal-worker-start.js';
import {
  commandInputHash,
  IdempotencyKeyConflictError,
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './runtime/idempotent-command.js';
import { TurnStartValidationError } from './runtime/orchestrator.js';
import type { PreparedNextTurn } from './runtime/prepare-next-turn.js';
import {
  type StopAfterTurnDecision,
  shouldStopAfterTurn,
  stopReasonForTurnStatus,
} from './runtime/stop-after-turn.js';
import type { TurnExecutor } from './runtime/types.js';
import {
  getWorkerCheckpoint,
  parseWorkerCheckpointContextAssembly,
  parseWorkerCheckpointEvidence,
  type WorkerCheckpointContextAssemblySummary,
  type WorkerCheckpointRecord,
} from './runtime/worker-checkpoints.js';
import {
  clearWorkerCheckpointAfterTerminalState,
  recoverAcceptedWorkerCheckpointStopReason,
} from './runtime/worker-recovery.js';
import { workerTurnStageForStopReason } from './runtime/worker-stage.js';
import { runWorkerTurnLoop } from './runtime/worker-turn-loop.js';
import { completeSchedulerLeaseForTerminalTurn } from './scheduler-records.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';

/** Parsed turn read model used by Goal worker lifecycle guards. */
type TurnReadModel = z.infer<typeof TurnSchema>;

/** Durable item shape returned by the app-local store. */
type StoreItem = ReturnType<FsStore['listAllItems']>[number];

/**
 * Checks whether a Turn still owns non-terminal thread work.
 *
 * @param turn Turn read model to classify.
 * @returns True for pending, running, or human-gated Turns.
 */
function isNonTerminalTurn(turn: TurnReadModel): boolean {
  return turn.status === 'pending' || turn.status === 'running' || turn.status === 'awaiting_human';
}

/**
 * Builds an empty task count object for a goal read model.
 *
 * @returns Goal task counts initialized to zero.
 */
function emptyGoalTaskCounts(): GoalTaskCounts {
  return {
    pending: 0,
    ready: 0,
    running: 0,
    reviewing: 0,
    completed: 0,
    blocked: 0,
    failed: 0,
  };
}

/**
 * Counts goal tasks by lifecycle status.
 *
 * @param tasks Stored goal tasks.
 * @returns Goal task counts keyed by task status.
 */
function countGoalTasks(tasks: readonly GoalTaskRecord[]): GoalTaskCounts {
  const counts = emptyGoalTaskCounts();

  for (const task of tasks) {
    counts[task.status] += 1;
  }

  return counts;
}

/**
 * Finds the current task read model for one goal.
 *
 * @param goal Stored goal record.
 * @param tasks Stored goal tasks for the goal.
 * @returns Current task summary, or null when no current task is set.
 */
function findCurrentGoalTask(
  goal: GoalRecord,
  tasks: readonly GoalTaskRecord[]
): ThreadGoalCurrentTask | null {
  const task = goal.currentTaskId
    ? (tasks.find((candidate) => candidate.taskId === goal.currentTaskId) ?? null)
    : null;

  if (!task) {
    return null;
  }

  return {
    taskId: task.taskId,
    title: task.title,
    status: task.status,
    orderIndex: task.orderIndex,
  };
}

/**
 * Projects pending human attention for one goal.
 *
 * @param goal Stored goal record.
 * @returns Human attention summary for the goal read model.
 */
function projectGoalHumanAttention(goal: GoalRecord): GoalPendingHumanAttention {
  if (goal.status === 'awaiting_plan_approval') {
    return { required: true, reason: 'Goal plan needs approval.' };
  }

  if (goal.status === 'awaiting_user') {
    return { required: true, reason: 'Goal is awaiting user input.' };
  }

  if (goal.status === 'reviewing') {
    return { required: true, reason: 'Worker result needs review.' };
  }

  if (goal.status === 'blocked') {
    return { required: true, reason: 'Goal is blocked.' };
  }

  if (goal.status === 'failed') {
    return { required: true, reason: 'Goal step failed.' };
  }

  return { required: false, reason: null };
}

/**
 * Projects terminal state for one goal.
 *
 * @param goal Stored goal record.
 * @returns Terminal state summary, or null while the goal is still active.
 */
function projectGoalTerminalState(goal: GoalRecord): GoalTerminalState | null {
  switch (goal.status) {
    case 'completed':
    case 'blocked':
    case 'aborted':
    case 'failed':
      return { status: goal.status, stopReason: goal.terminalStopReason };
    default:
      return null;
  }
}

/**
 * Projects stored terminal evidence into a goal closeout read model.
 *
 * @param goal Stored goal record.
 * @param tasks Stored goal tasks for the goal.
 * @param verifications Stored verification evidence for the goal.
 * @returns Terminal summary, or null while the goal is active.
 */
function projectGoalTerminalSummary(
  goal: GoalRecord,
  tasks: readonly GoalTaskRecord[],
  verifications: readonly GoalVerificationRecord[]
): GoalTerminalSummary | null {
  if (!projectGoalTerminalState(goal)) {
    return null;
  }

  return {
    artifactIds: dedupeStrings(verifications.flatMap((verification) => verification.artifactIds)),
    blockedTaskIds: tasks
      .filter((task) => task.status === 'blocked' || task.status === 'failed')
      .map((task) => task.taskId),
    completedTaskIds: tasks
      .filter((task) => task.status === 'completed')
      .map((task) => task.taskId),
    risks: projectGoalTerminalRisks(tasks),
    suggestedNextWork: [],
    verificationEvidence: verifications.map((verification) => ({
      artifactIds: [...verification.artifactIds],
      command: verification.command,
      status: verification.status,
      summary: verification.summary,
      verificationId: verification.verificationId,
    })),
  };
}

/**
 * Projects terminal risks from task and verification state.
 *
 * @param tasks Stored goal tasks for the goal.
 * @returns User-facing terminal risk strings.
 */
function projectGoalTerminalRisks(tasks: readonly GoalTaskRecord[]): string[] {
  const risks: string[] = [];
  const blockedTaskCount = tasks.filter(
    (task) => task.status === 'blocked' || task.status === 'failed'
  ).length;
  const incompleteTaskCount = tasks.filter(
    (task) => !['completed', 'blocked', 'failed'].includes(task.status)
  ).length;

  if (blockedTaskCount > 0) {
    risks.push(`${blockedTaskCount} required task is blocked or failed.`);
  }

  if (incompleteTaskCount > 0) {
    risks.push(`${incompleteTaskCount} required task is not accepted.`);
  }

  return risks;
}

/**
 * Deduplicates strings while preserving first-seen order.
 *
 * @param values Values to deduplicate.
 * @returns Deduplicated values.
 */
function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Builds the latest thread goal summary read model from app-local goal storage.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @param threadId Thread id.
 * @param goalId Optional exact Goal id for command replay.
 * @returns Latest goal summary for the thread, or null when no goal exists.
 */
function buildThreadGoalSummary(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  threadId: string,
  goalId?: string
): ThreadGoalSummary | null {
  const goals = listGoalRecordsForThread(workspaceDb, { workspaceId, threadId });
  const goal = goalId
    ? (goals.find((candidate) => candidate.goalId === goalId) ?? null)
    : (goals.at(-1) ?? null);

  if (!goal) {
    return null;
  }

  const tasks = listGoalTasks(workspaceDb, { workspaceId, threadId, goalId: goal.goalId });
  const verifications = listGoalVerificationRecordsForGoal(workspaceDb, {
    workspaceId,
    threadId,
    goalId: goal.goalId,
  });

  return {
    goalId: goal.goalId,
    workspaceId: goal.workspaceId,
    threadId: goal.threadId,
    status: goal.status,
    title: goal.title,
    objective: goal.objective,
    currentTask: findCurrentGoalTask(goal, tasks),
    taskCounts: countGoalTasks(tasks),
    pendingHumanAttention: projectGoalHumanAttention(goal),
    terminalState: projectGoalTerminalState(goal),
    terminalSummary: projectGoalTerminalSummary(goal, tasks, verifications),
    updatedAt: goal.updatedAt,
  };
}

/** Public response returned by one Goal step command. */
type GoalStepResponse = z.output<typeof RunThreadGoalStepResponseSchema>;

/** Immutable result portion retained for exact Goal step replay. */
type GoalStepResult = GoalStepResponse['result'];

/** Bounded command snapshot that names the original Goal. */
type GoalStepSnapshot = GoalStepResult & { readonly goalId: string };

/**
 * Derives the reserved worker Turn from one authenticated Goal step command.
 *
 * @param input Actor store and command scope.
 * @returns Deterministic reserved Turn id.
 */
function goalStepTurnId(input: {
  readonly store: FsStore;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly requestId: string;
}): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        'goal.step',
        input.store.getUserId(),
        input.workspaceId,
        input.threadId,
        input.requestId,
      ])
    )
    .digest('hex')
    .slice(0, 24);
  return `tu_goal_step_${digest}`;
}

/**
 * Creates the stable fail-closed error for an unprovable Goal step tuple.
 *
 * @param message Product-safe recovery reason.
 * @returns Recovery-required validation error.
 */
function goalStepRecoveryError(message: string): TurnStartValidationError {
  return new TurnStartValidationError('recovery_required', message, 409);
}

/**
 * Parses the bounded snapshot from one completed Goal step receipt.
 *
 * @param record Completed command receipt.
 * @returns Validated Goal step snapshot.
 * @throws TurnStartValidationError when receipt identity or shape is contradictory.
 */
function parseGoalStepSnapshot(record: CommandRequestRecord): GoalStepSnapshot {
  const raw = record.response.snapshot;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw goalStepRecoveryError('Goal step receipt has no bounded result snapshot.');
  }
  const goalId = Reflect.get(raw, 'goalId');
  const result = RunThreadGoalStepResponseSchema.shape.result.safeParse(raw);
  if (
    typeof goalId !== 'string' ||
    goalId.length === 0 ||
    !result.success ||
    record.response.kind !== 'turn' ||
    record.response.id !== result.data.turnId
  ) {
    throw goalStepRecoveryError('Goal step receipt contradicts its result identity.');
  }

  return { goalId, ...result.data };
}

/**
 * Projects one bounded Goal step result through its durable Goal, Task, Turn, and Review owners.
 *
 * @param input Snapshot and exact command scope.
 * @returns Schema-valid result plus the original Goal's current projection.
 * @throws TurnStartValidationError when a named owner is missing or contradictory.
 */
function projectGoalStepResponse(input: {
  readonly store: FsStore;
  readonly workspaceDb: WorkspaceDb;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly snapshot: GoalStepSnapshot;
}): GoalStepResponse {
  const goal = buildThreadGoalSummary(
    input.workspaceDb,
    input.workspaceId,
    input.threadId,
    input.snapshot.goalId
  );
  const task = listGoalTasks(input.workspaceDb, {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    goalId: input.snapshot.goalId,
  }).find((candidate) => candidate.taskId === input.snapshot.taskId);
  let turnExists = false;
  try {
    input.store.getTurn(input.workspaceId, input.threadId, input.snapshot.turnId);
    turnExists = true;
  } catch {
    turnExists = false;
  }
  const review = input.snapshot.reviewId
    ? listGoalReviewRecordsForTask(input.workspaceDb, {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        goalId: input.snapshot.goalId,
        taskId: input.snapshot.taskId,
      }).find((candidate) => candidate.reviewId === input.snapshot.reviewId)
    : null;

  if (
    !goal ||
    !task ||
    !turnExists ||
    (input.snapshot.reviewId !== null &&
      (!review ||
        review.turnId !== input.snapshot.turnId ||
        review.taskId !== input.snapshot.taskId))
  ) {
    throw goalStepRecoveryError('Goal step result cannot prove its original owner tuple.');
  }

  return RunThreadGoalStepResponseSchema.parse({
    goal,
    result: {
      taskId: input.snapshot.taskId,
      turnId: input.snapshot.turnId,
      outcome: input.snapshot.outcome,
      shouldStop: input.snapshot.shouldStop,
      stopReason: input.snapshot.stopReason,
      evidence: input.snapshot.evidence,
      reviewId: input.snapshot.reviewId,
    },
  });
}

/**
 * Commits the one Goal-owned transaction after a worker Turn has terminal evidence.
 *
 * @param input Exact Goal, Task, Turn, request, evidence, and stop-decision owners.
 * @returns Schema-valid Goal step response after the owner transaction commits.
 * @throws Error when the durable Task graph contradicts the stop decision or persistence fails.
 */
function commitGoalStepOwnerOutcome(input: {
  readonly store: FsStore;
  readonly workspaceDb: WorkspaceDb;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly requestId: string;
  readonly goal: GoalRecord;
  readonly task: GoalTaskRecord;
  readonly tasks: readonly GoalTaskRecord[];
  readonly turnId: string;
  readonly stopDecision: StopAfterTurnDecision;
  readonly evidence: {
    readonly itemIds: readonly string[];
    readonly artifactIds: readonly string[];
  };
  readonly contextAssembly: WorkerCheckpointContextAssemblySummary;
}): GoalStepResponse {
  const decision = createWorkerCoordinatorGoalStopDecision({
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    requestId: input.requestId,
    goalId: input.goal.goalId,
    taskId: input.task.taskId,
    turnId: input.turnId,
    stopDecision: input.stopDecision,
    hasOtherIncompleteTasksAfterAddressedTaskCompletion: input.tasks.some(
      (candidate) => candidate.taskId !== input.task.taskId && candidate.status !== 'completed'
    ),
    evidence: input.evidence,
  });

  try {
    input.workspaceDb.sqlite.transaction(() => {
      recordGoalTaskWorkerOutcome(input.workspaceDb, {
        workspaceDb: input.workspaceDb,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        goalId: input.goal.goalId,
        taskId: input.task.taskId,
        turnId: input.turnId,
        stopReason: input.stopDecision.stopReason,
        itemIds: input.evidence.itemIds,
        artifactIds: input.evidence.artifactIds,
        contextAssembly: input.contextAssembly,
      });

      switch (decision.outcome) {
        case 'review':
          createGoalReviewRecord(input.workspaceDb, {
            reviewId: `review_${input.turnId}`,
            workspaceId: input.workspaceId,
            threadId: input.threadId,
            goalId: input.goal.goalId,
            taskId: input.task.taskId,
            turnId: input.turnId,
            itemIds: input.evidence.itemIds,
            artifactIds: input.evidence.artifactIds,
            prompt: 'Review the completed worker output before Goal Mode continues.',
            createdByRequestId: input.requestId,
          });
          updateGoalTask(input.workspaceDb, {
            workspaceId: input.workspaceId,
            threadId: input.threadId,
            goalId: input.goal.goalId,
            taskId: input.task.taskId,
            status: 'reviewing',
          });
          updateGoalStatus(input.workspaceDb, {
            workspaceId: input.workspaceId,
            threadId: input.threadId,
            goalId: input.goal.goalId,
            status: 'reviewing',
            currentTaskId: input.task.taskId,
            terminalStopReason: null,
          });
          break;
        case 'ask_user':
          updateGoalStatus(input.workspaceDb, {
            workspaceId: input.workspaceId,
            threadId: input.threadId,
            goalId: input.goal.goalId,
            status: 'awaiting_user',
            currentTaskId: input.task.taskId,
            terminalStopReason: null,
          });
          break;
        case 'block':
          if (decision.stopReason !== 'error') {
            updateGoalTask(input.workspaceDb, {
              workspaceId: input.workspaceId,
              threadId: input.threadId,
              goalId: input.goal.goalId,
              taskId: input.task.taskId,
              status: 'blocked',
            });
          }
          updateGoalStatus(input.workspaceDb, {
            workspaceId: input.workspaceId,
            threadId: input.threadId,
            goalId: input.goal.goalId,
            status: decision.stopReason === 'error' ? 'failed' : 'blocked',
            currentTaskId: null,
            terminalStopReason: decision.stopReason,
          });
          break;
        case 'abort':
          updateGoalStatus(input.workspaceDb, {
            workspaceId: input.workspaceId,
            threadId: input.threadId,
            goalId: input.goal.goalId,
            status: 'aborted',
            currentTaskId: null,
            terminalStopReason: 'aborted',
          });
          break;
        case 'complete':
        case 'continue': {
          const resolution = advanceGoalAfterReview(input.workspaceDb, {
            workspaceId: input.workspaceId,
            threadId: input.threadId,
            goalId: input.goal.goalId,
            taskId: input.task.taskId,
            verdict: 'accept',
          });
          const expectedOutcome =
            decision.outcome === 'complete' ? 'complete_goal' : 'complete_next_task';
          if (resolution.outcome !== expectedOutcome) {
            throw new Error('Goal stop decision contradicts the durable Task graph.');
          }
          break;
        }
      }
    })();
  } catch {
    throw new Error('Goal owner commit failed after the worker completed.');
  }

  const summary = buildThreadGoalSummary(
    input.workspaceDb,
    input.workspaceId,
    input.threadId,
    input.goal.goalId
  );
  if (!summary) {
    throw new Error('Goal summary is unavailable after the worker owner commit.');
  }

  return RunThreadGoalStepResponseSchema.parse({
    goal: summary,
    result: {
      taskId: input.task.taskId,
      turnId: input.turnId,
      outcome: decision.outcome,
      shouldStop: decision.shouldStop,
      stopReason: decision.stopReason,
      evidence: input.evidence,
      reviewId: decision.outcome === 'review' ? `review_${input.turnId}` : null,
    },
  });
}

/**
 * Reconstructs a missing Goal step receipt only from a complete checkpoint owner tuple.
 *
 * @param input Request-bound checkpoint and exact command scope.
 * @returns Schema-valid response reconstructed without another worker launch.
 * @throws TurnStartValidationError when the checkpoint or business owners are incomplete.
 */
function recoverGoalStepFromCheckpoint(input: {
  readonly coreDb: CoreDb;
  readonly store: FsStore;
  readonly workspaceDb: WorkspaceDb;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly requestId: string;
  readonly requestInputHash: string;
  readonly turnId: string;
  readonly checkpoint: WorkerCheckpointRecord;
}): GoalStepResponse {
  const { checkpoint } = input;
  if (
    checkpoint.requestId !== input.requestId ||
    checkpoint.requestInputHash !== input.requestInputHash ||
    checkpoint.turnId !== input.turnId ||
    !checkpoint.goalId ||
    !checkpoint.taskId
  ) {
    throw goalStepRecoveryError('Goal step checkpoint contradicts its command identity.');
  }
  const goal = getGoalRecord(
    input.workspaceDb,
    input.workspaceId,
    input.threadId,
    checkpoint.goalId
  );
  const tasks = listGoalTasks(input.workspaceDb, {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    goalId: checkpoint.goalId,
  });
  const task = tasks.find((candidate) => candidate.taskId === checkpoint.taskId);
  const reviews = task
    ? listGoalReviewRecordsForTask(input.workspaceDb, {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        goalId: checkpoint.goalId,
        taskId: task.taskId,
      })
    : [];
  const review = reviews.find(
    (candidate) =>
      candidate.turnId === checkpoint.turnId &&
      candidate.createdByRequestId === checkpoint.requestId
  );
  let outcome: GoalStepResult['outcome'] | null = null;

  if (!goal || !task) {
    throw goalStepRecoveryError('Goal step checkpoint is missing its business owner tuple.');
  }
  let turn: TurnReadModel;
  try {
    turn = input.store.getTurn(input.workspaceId, input.threadId, checkpoint.turnId);
  } catch {
    throw goalStepRecoveryError('Goal step checkpoint is missing its worker Turn.');
  }
  const recoveringAcceptedFinalStatus =
    checkpoint.stage === 'running_worker' && checkpoint.stopReason === null;
  let stopReason = checkpoint.stopReason;
  if (recoveringAcceptedFinalStatus) {
    try {
      stopReason = recoverAcceptedWorkerCheckpointStopReason(
        input.coreDb,
        input.store,
        input.workspaceDb,
        checkpoint
      );
    } catch {
      throw goalStepRecoveryError('Goal step checkpoint has no complete accepted worker closeout.');
    }
  }
  if (
    !stopReason ||
    (!recoveringAcceptedFinalStatus &&
      checkpoint.stage !== workerTurnStageForStopReason(stopReason))
  ) {
    throw goalStepRecoveryError('Goal step checkpoint contradicts its terminal outcome.');
  }
  const evidence =
    parseWorkerCheckpointEvidence(checkpoint.diagnosticsSummary) ??
    (recoveringAcceptedFinalStatus
      ? collectWorkerTurnEvidence(
          input.store.listThreadItems(input.workspaceId, input.threadId),
          checkpoint.turnId
        )
      : null);
  if (!evidence) {
    throw goalStepRecoveryError('Goal step checkpoint is missing its terminal evidence.');
  }
  const turnMatchesStopReason =
    ((stopReason === 'completed' || stopReason === 'length' || stopReason === 'budget_exhausted') &&
      turn.status === 'completed') ||
    (stopReason === 'error' && turn.status === 'failed') ||
    (stopReason === 'aborted' && turn.status === 'cancelled') ||
    (stopReason === 'ask_user' && turn.status === 'awaiting_human');
  if (!turnMatchesStopReason) {
    throw goalStepRecoveryError('Goal step Turn contradicts its canonical StopReason.');
  }
  if (
    goal.status === 'running' &&
    goal.currentTaskId === task.taskId &&
    task.status === 'running' &&
    reviews.length === 0
  ) {
    const contextAssembly = parseWorkerCheckpointContextAssembly(checkpoint.diagnosticsSummary);
    if (!contextAssembly) {
      throw goalStepRecoveryError('Goal step checkpoint is missing its context assembly proof.');
    }
    return commitGoalStepOwnerOutcome({
      store: input.store,
      workspaceDb: input.workspaceDb,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      requestId: input.requestId,
      goal,
      task,
      tasks,
      turnId: checkpoint.turnId,
      stopDecision: shouldStopAfterTurn({
        stopReason,
        reviewRequired: task.reviewPolicy.required,
        remainingWorkerIterations: 0,
      }),
      evidence,
      contextAssembly,
    });
  }
  if (
    checkpoint.stage === 'completed' &&
    checkpoint.stopReason === 'completed' &&
    goal.status === 'reviewing' &&
    goal.currentTaskId === task.taskId &&
    task.status === 'reviewing' &&
    review
  ) {
    outcome = 'review';
  } else if (
    checkpoint.stage === 'waiting_for_user' &&
    checkpoint.stopReason === 'ask_user' &&
    goal.status === 'awaiting_user' &&
    goal.currentTaskId === task.taskId &&
    task.status === 'running'
  ) {
    outcome = 'ask_user';
  } else if (
    checkpoint.stage === 'completed' &&
    checkpoint.stopReason === 'completed' &&
    task.status === 'completed' &&
    goal.currentTaskId === null &&
    (goal.status === 'running' || goal.status === 'completed')
  ) {
    outcome = goal.status === 'completed' ? 'complete' : 'continue';
  } else if (
    (stopReason === 'error' || stopReason === 'length' || stopReason === 'budget_exhausted') &&
    goal.status === (stopReason === 'error' ? 'failed' : 'blocked') &&
    goal.currentTaskId === null &&
    task.status === (stopReason === 'error' ? 'failed' : 'blocked')
  ) {
    outcome = 'block';
  } else if (
    checkpoint.stage === 'aborted' &&
    checkpoint.stopReason === 'aborted' &&
    goal.status === 'aborted' &&
    goal.currentTaskId === null
  ) {
    outcome = 'abort';
  }

  if (!outcome) {
    throw goalStepRecoveryError('Goal step checkpoint has no complete accepted closeout.');
  }
  return projectGoalStepResponse({
    store: input.store,
    workspaceDb: input.workspaceDb,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    snapshot: {
      goalId: checkpoint.goalId,
      taskId: task.taskId,
      turnId: checkpoint.turnId,
      outcome,
      shouldStop: outcome !== 'continue',
      stopReason,
      evidence: { itemIds: [...evidence.itemIds], artifactIds: [...evidence.artifactIds] },
      reviewId: outcome === 'review' ? (review?.reviewId ?? null) : null,
    },
  });
}

/**
 * Builds the public response from one complete request-owned Goal Plan tuple.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace that owns the Goal.
 * @param threadId Thread that owns the Goal.
 * @param created Validated approvable Plan owners.
 * @returns Schema-validated public Plan response.
 * @throws GoalPlanApprovalError when the deterministic Plan or Goal projection is contradictory.
 */
function buildGoalPlanCreationResponse(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  threadId: string,
  created: NonNullable<ReturnType<typeof readGoalPlanCreation>>
): z.output<typeof CreateThreadGoalPlanResponseSchema> {
  const goal = getGoalRecord(workspaceDb, workspaceId, threadId, created.goalId);
  if (!goal) {
    throw new GoalPlanApprovalError(
      'recovery_required',
      'Goal is unavailable for its request-owned Plan.'
    );
  }
  const planner = projectWorkerCoordinatorGoalPlanDraft(
    {
      workspaceId,
      threadId,
      goalId: goal.goalId,
      title: goal.title,
      objective: goal.objective,
    },
    created.plan
  );
  const summary = buildThreadGoalSummary(workspaceDb, workspaceId, threadId, created.goalId);
  if (!summary) {
    throw new GoalPlanApprovalError(
      'recovery_required',
      'Goal summary is unavailable for its request-owned Plan.'
    );
  }
  return CreateThreadGoalPlanResponseSchema.parse({
    status: created.status,
    goal: summary,
    planItemId: created.planItem.id,
    planner,
    plan: created.plan,
  });
}

/**
 * Builds the public response only after one Plan revision owner tuple is durable.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace that owns the Goal.
 * @param threadId Thread that owns the Goal.
 * @param revised Validated Plan revision owners.
 * @returns Schema-validated public revision response.
 * @throws GoalPlanApprovalError when the exact Goal read projection is unavailable.
 */
function buildGoalPlanRevisionResponse(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  threadId: string,
  revised: ReviseGoalPlanResult
): z.output<typeof ReviseThreadGoalPlanResponseSchema> {
  const summary = buildThreadGoalSummary(workspaceDb, workspaceId, threadId, revised.goalId);
  if (!summary) {
    throw new GoalPlanApprovalError(
      'recovery_required',
      'Goal summary is unavailable after Plan revision.'
    );
  }
  return ReviseThreadGoalPlanResponseSchema.parse({
    goal: summary,
    revisionItemId: revised.revisionItem.id,
    startsWorkerTurn: false,
  });
}

/**
 * Checks whether a goal status still represents active Goal Mode work.
 *
 * @param goal Stored goal record.
 * @returns True when the goal is not terminal.
 */
function isActiveGoal(goal: GoalRecord): boolean {
  switch (goal.status) {
    case 'completed':
    case 'blocked':
    case 'aborted':
    case 'failed':
      return false;
    default:
      return true;
  }
}

/**
 * Finds the latest active goal in a thread.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @param threadId Thread id.
 * @returns Latest active goal record.
 * @throws Error when no active goal exists.
 */
function requireLatestActiveGoal(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  threadId: string
): GoalRecord {
  const goal =
    listGoalRecordsForThread(workspaceDb, { workspaceId, threadId }).findLast(isActiveGoal) ?? null;

  if (!goal) {
    throw new Error('Thread does not have an active goal.');
  }

  return goal;
}

/**
 * Projects one accepted Goal lifecycle command from its exact original Goal.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace that owns the Goal.
 * @param threadId Thread that owns the Goal.
 * @param goalId Original Goal named by the command receipt.
 * @param command Lifecycle command whose historical outcome is returned.
 * @returns Schema-valid command outcome plus the Goal's current projection.
 * @throws TurnStartValidationError when the original Goal cannot be projected truthfully.
 */
function projectGoalLifecycleCommand(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  threadId: string,
  goalId: string,
  command: 'goal.pause' | 'goal.resume'
):
  | z.output<typeof PauseThreadGoalResponseSchema>
  | z.output<typeof ResumeThreadGoalResponseSchema> {
  try {
    const goal = buildThreadGoalSummary(workspaceDb, workspaceId, threadId, goalId);
    if (!goal) {
      throw new Error('Goal is unavailable.');
    }

    return command === 'goal.pause'
      ? PauseThreadGoalResponseSchema.parse({ outcome: 'paused', goal })
      : ResumeThreadGoalResponseSchema.parse({ outcome: 'resumed', goal });
  } catch {
    throw new TurnStartValidationError(
      'recovery_required',
      'Goal lifecycle command cannot project its original Goal.',
      409
    );
  }
}

/**
 * Atomically executes or replays one Goal pause or resume command.
 *
 * @param input Command scope, request identity, stores, and open Workspace database.
 * @returns Historical command outcome plus the current exact Goal projection.
 * @throws IdempotencyKeyConflictError when stored input identity conflicts.
 * @throws TurnStartValidationError when lifecycle authority is invalid or unavailable.
 */
function runGoalLifecycleCommand(input: {
  readonly store: FsStore;
  readonly workspaceDb: WorkspaceDb;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly requestId: string;
  readonly command: 'goal.pause' | 'goal.resume';
}):
  | z.output<typeof PauseThreadGoalResponseSchema>
  | z.output<typeof ResumeThreadGoalResponseSchema> {
  const scope = { workspaceId: input.workspaceId, threadId: input.threadId };
  const inputHash = commandInputHash({});

  return input.workspaceDb.sqlite.transaction(() => {
    const receipt = input.store.getCommandRequest(
      input.command,
      input.requestId,
      scope,
      input.workspaceDb
    );
    if (receipt) {
      if (receipt.inputHash !== inputHash) {
        throw new IdempotencyKeyConflictError();
      }
      if (
        receipt.command !== input.command ||
        receipt.requestId !== input.requestId ||
        receipt.scope.workspaceId !== input.workspaceId ||
        receipt.scope.threadId !== input.threadId ||
        Object.keys(receipt.scope).length !== 2 ||
        receipt.response.kind !== 'goal' ||
        receipt.response.snapshot !== undefined
      ) {
        throw new TurnStartValidationError(
          'recovery_required',
          'Goal lifecycle command receipt has invalid lineage.',
          409
        );
      }

      return projectGoalLifecycleCommand(
        input.workspaceDb,
        input.workspaceId,
        input.threadId,
        receipt.response.id,
        input.command
      );
    }

    const goal = requireLatestActiveGoal(input.workspaceDb, input.workspaceId, input.threadId);
    if (goal.currentTaskId !== null || goal.terminalStopReason !== null) {
      throw new TurnStartValidationError(
        'recovery_required',
        'Goal is not at a safe lifecycle boundary.',
        409
      );
    }

    const sourceStatus = input.command === 'goal.pause' ? 'running' : 'paused';
    if (goal.status !== sourceStatus) {
      throw new TurnStartValidationError(
        input.command === 'goal.pause' ? 'goal_not_running' : 'goal_not_paused',
        input.command === 'goal.pause' ? 'Goal is not running.' : 'Goal is not paused.',
        409
      );
    }

    if (input.store.listThreadTurns(input.workspaceId, input.threadId).some(isNonTerminalTurn)) {
      throw new TurnStartValidationError(
        input.command === 'goal.pause' ? 'goal_pause_active_turn' : 'goal_resume_active_turn',
        input.command === 'goal.pause'
          ? 'Goal cannot pause while a worker turn is active.'
          : 'Goal cannot resume while a worker turn is active.',
        409
      );
    }

    updateGoalStatus(input.workspaceDb, {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      goalId: goal.goalId,
      status: input.command === 'goal.pause' ? 'paused' : 'running',
    });
    const response = projectGoalLifecycleCommand(
      input.workspaceDb,
      input.workspaceId,
      input.threadId,
      goal.goalId,
      input.command
    );
    input.store.recordCommandRequest(
      {
        command: input.command,
        requestId: input.requestId,
        scope,
        inputHash,
        response: { kind: 'goal', id: goal.goalId },
      },
      input.workspaceDb
    );
    return response;
  })();
}

/**
 * Creates the minimal prepared worker payload used by deterministic supervise e2e routes.
 *
 * @param task Goal task selected for deterministic worker execution.
 * @returns Prepared worker payload with no provider-visible context.
 */
function createDeterministicPreparedGoalTask(task: GoalTaskRecord): PreparedNextTurn {
  return {
    contextPackageDigest: `deterministic:${task.taskId}`,
    delegationRequest: {
      objective: task.objective,
    } as PreparedNextTurn['delegationRequest'],
    repository: {
      resourceId: 'repo_deterministic',
    } as PreparedNextTurn['repository'],
  };
}

/**
 * Selects the task eligible for the next real Goal Mode worker step.
 *
 * @param tasks Goal tasks for one active goal.
 * @returns Running task when present, otherwise the next ready task.
 */
function selectNextGoalWorkerTask(tasks: readonly GoalTaskRecord[]): GoalTaskRecord | null {
  return (
    tasks
      .filter((task) => task.status === 'running')
      .sort((left, right) => left.orderIndex - right.orderIndex)[0] ??
    selectNextReadyGoalTask(tasks)
  );
}

const WORKER_TURN_AWAIT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Waits until a worker turn reaches a terminal stored state.
 *
 * @param store Durable turn store.
 * @param turnId Worker turn id to observe.
 * @returns Terminal turn read model.
 * @throws Error when the worker turn does not finish within the bounded wait window.
 */
async function waitForWorkerTurnTerminalState(
  store: FsStore,
  turnId: string
): Promise<TurnReadModel> {
  const initialTurn = store.getTurnById(turnId);

  if (isTerminalTurnStatus(initialTurn.status)) {
    return initialTurn;
  }

  return new Promise<TurnReadModel>((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      unsubscribe?.();
      reject(new Error(`Worker turn did not finish within ${WORKER_TURN_AWAIT_TIMEOUT_MS}ms.`));
    }, WORKER_TURN_AWAIT_TIMEOUT_MS);

    unsubscribe = store.addTurnListener(turnId, (event) => {
      if (event.event !== 'turn.completed' && event.event !== 'turn.updated') {
        return;
      }

      const turn = store.getTurnById(turnId);

      if (!isTerminalTurnStatus(turn.status) || settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      unsubscribe?.();
      resolve(turn);
    });

    const currentTurn = store.getTurnById(turnId);

    if (isTerminalTurnStatus(currentTurn.status) && !settled) {
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
      resolve(currentTurn);
    }
  });
}

/**
 * Checks whether a stored turn status can be used as a worker terminal outcome.
 *
 * @param status Stored turn status.
 * @returns True when the turn will not continue without a new human/API action.
 */
function isTerminalTurnStatus(status: TurnReadModel['status']): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'interrupted' ||
    status === 'awaiting_human'
  );
}

/**
 * Extracts terminal worker evidence from durable thread items.
 *
 * @param items Thread item history.
 * @param turnId Worker turn id.
 * @returns Item and artifact refs associated with the worker turn.
 */
function collectWorkerTurnEvidence(
  items: readonly StoreItem[],
  turnId: string
): { itemIds: string[]; artifactIds: string[] } {
  const turnItems = items.filter((item) => item.turnId === turnId);

  return {
    itemIds: turnItems.map((item) => item.id),
    artifactIds: turnItems.flatMap((item) =>
      item.type === 'artifact-reference' ? [item.artifactId] : []
    ),
  };
}

/**
 * Derives a readable goal title from request input.
 *
 * @param title Optional caller-supplied title.
 * @param objective Required goal objective.
 * @returns Title to persist on the goal record.
 */
function deriveThreadGoalTitle(title: string | undefined, objective: string): string {
  return title?.trim() || objective.trim().split(/\r?\n/, 1)[0] || objective.trim();
}

/** Commands allowed to own the Goal tuple created through the shared start path. */
type GoalStartOwningCommand = 'goal.start' | 'chat.start' | 'task.start';

/** Durable result returned by one complete Goal start owner tuple. */
type GoalStartResult = {
  readonly response: z.infer<typeof StartThreadGoalResponseSchema>;
  readonly turn: z.infer<typeof TurnSchema>;
};

/**
 * Derives Goal start owner ids from one authenticated command identity.
 *
 * @param input Command, actor store, and request scope.
 * @returns Deterministic Goal, Turn, and objective Item ids.
 */
export function goalStartOwnerIds(input: {
  readonly owningCommand: GoalStartOwningCommand;
  readonly requestId: string;
  readonly store: FsStore;
  readonly workspaceId: string;
  readonly threadId: string;
}): { readonly goalId: string; readonly turnId: string; readonly objectiveItemId: string } {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        input.owningCommand,
        input.store.getUserId(),
        input.workspaceId,
        input.threadId,
        input.requestId,
      ])
    )
    .digest('hex')
    .slice(0, 24);
  const turnId = `tu_goal_start_${digest}`;
  return {
    goalId: `goal_${digest}`,
    turnId,
    objectiveItemId: `it_goal_objective_${turnId}`,
  };
}

/**
 * Reads and validates the exact durable owners of one Goal start command.
 *
 * @param input Request identity, caller input, and owner stores.
 * @returns Complete Goal start result, or null when the request has no effects.
 * @throws TurnStartValidationError when owners are partial or contradictory.
 */
function readGoalStartOwners(input: {
  readonly owningCommand: GoalStartOwningCommand;
  readonly requestId: string;
  readonly store: FsStore;
  readonly workspaceDb: WorkspaceDb;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly objective: string;
  readonly title?: string | undefined;
}): GoalStartResult | null {
  const ids = goalStartOwnerIds(input);
  const turn = input.store
    .listThreadTurns(input.workspaceId, input.threadId)
    .find((candidate) => candidate.id === ids.turnId);
  const objectiveItem = input.store
    .listThreadItems(input.workspaceId, input.threadId)
    .find((candidate) => candidate.id === ids.objectiveItemId);
  const goal = getGoalRecord(input.workspaceDb, input.workspaceId, input.threadId, ids.goalId);

  if (!turn && !objectiveItem && !goal) {
    return null;
  }
  if (
    !turn ||
    turn.status !== 'completed' ||
    !turn.completedAt ||
    !objectiveItem ||
    objectiveItem.type !== 'user-message' ||
    objectiveItem.status !== 'completed' ||
    !objectiveItem.completedAt ||
    objectiveItem.turnId !== turn.id ||
    objectiveItem.causationId !== input.requestId ||
    objectiveItem.text !== input.objective ||
    !turn.items.some((candidate) => candidate.id === objectiveItem.id) ||
    !goal ||
    goal.createdByItemId !== objectiveItem.id ||
    goal.objective !== input.objective ||
    goal.title !== deriveThreadGoalTitle(input.title, input.objective)
  ) {
    throw new TurnStartValidationError(
      'recovery_required',
      'Goal start owners are incomplete or contradictory.',
      409
    );
  }

  try {
    const summary = buildThreadGoalSummary(
      input.workspaceDb,
      input.workspaceId,
      input.threadId,
      goal.goalId
    );
    return {
      response: StartThreadGoalResponseSchema.parse({
        goal: summary,
        objectiveItemId: objectiveItem.id,
      }),
      turn,
    };
  } catch {
    throw new TurnStartValidationError(
      'recovery_required',
      'Goal start projection is unavailable for its durable owners.',
      409
    );
  }
}

/**
 * Starts one durable Goal Mode objective on a thread.
 *
 * @param input Goal startup input.
 * @returns Started Goal Mode projection.
 */
export function startGoalModeObjective(input: {
  /** Optional Core database that enables Goal persistence. */
  readonly coreDb: CoreDb | undefined;
  /** Enforces project-only Goal startup. */
  readonly assertProjectWorkspace: (
    workspace: ReturnType<FsStore['getWorkspace']>,
    action: string
  ) => void;
  /** Opens the migrated workspace database. */
  readonly repositoryWorkspaceDb: (store: FsStore, workspaceId: string) => WorkspaceDb;
  /** Store that owns the workspace and thread. */
  readonly store: FsStore;
  /** Workspace that owns the goal. */
  readonly workspaceId: string;
  /** Thread that owns the goal. */
  readonly threadId: string;
  /** Outer command whose identity owns the created Goal tuple. */
  readonly owningCommand: GoalStartOwningCommand;
  /** Caller-supplied idempotency and correlation id. */
  readonly requestId: string;
  /** Goal objective supplied by the user or Coordinator. */
  readonly objective: string;
  /** Optional user-facing goal title. */
  readonly title?: string | undefined;
}): GoalStartResult {
  if (!input.coreDb) {
    throw new TurnStartValidationError(
      'goal_storage_unavailable',
      'Goal storage is unavailable for this NanoCore instance.',
      503
    );
  }

  input.assertProjectWorkspace(input.store.getWorkspace(input.workspaceId), 'start Goal Mode');

  const workspaceDb = input.repositoryWorkspaceDb(input.store, input.workspaceId);
  try {
    const existingOwners = readGoalStartOwners({ ...input, workspaceDb });
    if (existingOwners) {
      throw new TurnStartValidationError(
        'recovery_required',
        'Goal start owners exist without a matching command receipt.',
        409
      );
    }
    const existingGoals = listGoalRecordsForThread(workspaceDb, {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
    });

    if (existingGoals.some(isActiveGoal)) {
      throw new TurnStartValidationError(
        'goal_already_active',
        'Thread already has an active goal.',
        409
      );
    }

    const ids = goalStartOwnerIds(input);
    const turn = input.store.createTurn(input.workspaceId, input.threadId, input.objective, null, {
      turnId: ids.turnId,
    });
    const timestamp = turn.startedAt ?? new Date().toISOString();
    const objectiveItem = input.store.createItem({
      id: ids.objectiveItemId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId: turn.id,
      type: 'user-message',
      status: 'completed',
      causationId: input.requestId,
      text: input.objective,
      createdAt: timestamp,
      completedAt: timestamp,
    });

    input.store.updateTurn(turn.id, {
      status: 'completed',
      completedAt: timestamp,
      durationMs: 0,
    });

    const persistGoal = workspaceDb.sqlite.transaction(() => {
      if (
        listGoalRecordsForThread(workspaceDb, {
          workspaceId: input.workspaceId,
          threadId: input.threadId,
        }).some(isActiveGoal)
      ) {
        throw new TurnStartValidationError(
          'recovery_required',
          'Goal start lost the active-Goal transition fence.',
          409
        );
      }
      createGoalRecord(workspaceDb, {
        workspaceExists: (candidateWorkspaceId) => {
          try {
            input.store.getWorkspace(candidateWorkspaceId);
            return true;
          } catch {
            return false;
          }
        },
        goalId: ids.goalId,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        title: deriveThreadGoalTitle(input.title, input.objective),
        objective: input.objective,
        createdByItemId: objectiveItem.id,
        now: () => timestamp,
      });
    });
    persistGoal();

    const created = readGoalStartOwners({ ...input, workspaceDb });
    if (!created) {
      throw new TurnStartValidationError(
        'recovery_required',
        'Goal start did not persist its durable owners.',
        409
      );
    }
    return created;
  } finally {
    workspaceDb.sqlite.close();
  }
}

/**
 * Registers the Goal Mode lifecycle, planning, steering, execution, and local supervise routes.
 *
 * @param dependencies Goal route storage, runtime, repository, and coordinator dependencies.
 */
export function registerGoalRoutes({
  app,
  assertProjectWorkspace,
  coreDb,
  inflightCommands,
  mode,
  repositoryWorkspaceDb,
  requestStore,
  startModeWorkerTurn,
  turnExecutor,
  workerCoordinatorCandidates,
}: {
  /** Hono app that owns the public route catalog. */
  readonly app: Hono<{ Variables: AuthVariables }>;
  /** Enforces project-only Goal startup. */
  readonly assertProjectWorkspace: (
    workspace: ReturnType<FsStore['getWorkspace']>,
    action: string
  ) => void;
  /** Optional Core database that enables Goal persistence. */
  readonly coreDb: CoreDb | undefined;
  /** Process-local duplicate collapse for durable Goal commands. */
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  /** Deployment mode that gates deterministic local-only routes. */
  readonly mode: CoreMode;
  /** Opens the migrated workspace database. */
  readonly repositoryWorkspaceDb: (store: FsStore, workspaceId: string) => WorkspaceDb;
  /** Resolves request-scoped storage. */
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
  /** Starts one reserved worker turn through the durable scheduler. */
  readonly startModeWorkerTurn: (input: {
    readonly store: FsStore;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly prompt: string;
    readonly requestId: string;
    readonly requestedAgentId: string;
    readonly reservedTurnId: string;
  }) => Promise<z.infer<typeof TurnSchema>>;
  /** Starts and observes governed worker turns. */
  readonly turnExecutor: TurnExecutor;
  /** Projects the workspace agent catalog into Coordinator candidates. */
  readonly workerCoordinatorCandidates: (
    store: FsStore,
    workspaceId: string
  ) => WorkerCoordinatorCandidate[];
}): void {
  registerAppApiRoute(app, 'getThreadGoalSummary', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      store.getThread(workspaceId, threadId);

      if (!coreDb) {
        return c.json(ThreadGoalSummaryResponseSchema.parse({ goal: null }));
      }

      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        return c.json(
          ThreadGoalSummaryResponseSchema.parse({
            goal: buildThreadGoalSummary(workspaceDb, workspaceId, threadId),
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  registerAppApiRoute(app, 'startThreadGoal', async (c) => {
    const parsed = StartThreadGoalRequestSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const store = requestStore(c);
      const workspace = store.getWorkspace(workspaceId);

      assertProjectWorkspace(workspace, 'start Goal Mode');
      store.getThread(workspaceId, threadId);
      const ownerInput = {
        owningCommand: 'goal.start' as const,
        requestId: parsed.data.requestId,
        store,
        workspaceId,
        threadId,
        objective: parsed.data.objective,
        title: parsed.data.title,
      };
      /** Reads direct Goal start owners through one scoped database handle. */
      const readOwners = (): GoalStartResult | null => {
        const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
        try {
          return readGoalStartOwners({ ...ownerInput, workspaceDb });
        } finally {
          workspaceDb.sqlite.close();
        }
      };

      const response = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'goal.start',
        requestId: parsed.data.requestId,
        scope: { workspaceId, threadId },
        input: { objective: parsed.data.objective, title: parsed.data.title },
        responseKind: 'goal',
        execute: () =>
          startGoalModeObjective({
            ...ownerInput,
            assertProjectWorkspace,
            coreDb,
            repositoryWorkspaceDb,
          }).response,
        replay: (record) => {
          if (record.response.kind !== 'goal' || record.response.snapshot !== undefined) {
            throw new TurnStartValidationError(
              'recovery_required',
              'Goal start receipt has invalid response lineage.',
              409
            );
          }
          const owners = readOwners();
          if (!owners || owners.response.goal.goalId !== record.response.id) {
            throw new TurnStartValidationError(
              'recovery_required',
              'Goal start owners are missing or contradict the receipt.',
              409
            );
          }
          return owners.response;
        },
        responseId: (result) => result.goal.goalId,
      }).catch((error) => {
        if (
          error instanceof IdempotencyKeyConflictError ||
          error instanceof TurnStartValidationError
        ) {
          throw error;
        }
        if (readOwners()) {
          throw new TurnStartValidationError(
            'recovery_required',
            'Goal start owners exist without a matching command receipt.',
            409
          );
        }
        throw error;
      });
      return c.json(response);
    } catch (error) {
      if (error instanceof TurnStartValidationError) {
        return asApiError(error.message, error.code, error.status);
      }

      return asCommandError(error, 'goal_create_failed', 400);
    }
  });

  registerAppApiRoute(app, 'submitThreadGoalSteering', async (c) => {
    const parsed = SubmitThreadGoalSteeringRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      store.getThread(workspaceId, threadId);

      return asApiError(
        'Goal steering is unavailable until the real worker path can persist delivery proof.',
        'goal_steering_delivery_unavailable',
        503
      );
    } catch (error) {
      return asApiError((error as Error).message, 'goal_steering_failed', 400);
    }
  });

  registerAppApiRoute(app, 'createThreadGoalPlan', async (c) => {
    const parsed = CreateThreadGoalPlanRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      store.getThread(workspaceId, threadId);

      if (!coreDb) {
        return asApiError(
          'Goal storage is unavailable for this NanoCore instance.',
          'goal_storage_unavailable',
          503
        );
      }

      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const response = await runIdempotentCommand({
          store,
          inflightCommands,
          command: 'goal.plan',
          requestId: parsed.data.requestId,
          scope: { workspaceId, threadId },
          input: {},
          responseKind: 'goal_plan',
          execute: async () => {
            const existing = readGoalPlanCreation({
              workspaceDb,
              store,
              workspaceId,
              threadId,
              requestId: parsed.data.requestId,
            });
            if (existing) {
              return buildGoalPlanCreationResponse(workspaceDb, workspaceId, threadId, existing);
            }

            const goal = requireLatestActiveGoal(workspaceDb, workspaceId, threadId);
            if (goal.status !== 'planning' || goal.planItemId !== null) {
              throw new TurnStartValidationError(
                'goal_not_planning',
                'Goal is not ready for planning.',
                409
              );
            }
            const planner = createWorkerCoordinatorGoalPlanDraft({
              workspaceId,
              threadId,
              goalId: goal.goalId,
              title: goal.title,
              objective: goal.objective,
            });
            const result = await createGoalPlan({
              workspaceDb,
              store,
              workspaceId,
              threadId,
              goalId: goal.goalId,
              requestId: parsed.data.requestId,
              planner: () => planner.plan,
            });
            if (result.status !== 'awaiting_plan_approval') {
              throw new GoalPlanApprovalError(
                'recovery_required',
                'Goal Plan request produced owners that the public command cannot acknowledge.'
              );
            }
            return buildGoalPlanCreationResponse(workspaceDb, workspaceId, threadId, {
              goalId: goal.goalId,
              ...result,
            });
          },
          replay: (record) => {
            if (record.response.kind !== 'goal_plan' || record.response.snapshot !== undefined) {
              throw new GoalPlanApprovalError(
                'recovery_required',
                'Goal Plan receipt has invalid response lineage.'
              );
            }
            const existing = readGoalPlanCreation({
              workspaceDb,
              store,
              workspaceId,
              threadId,
              requestId: parsed.data.requestId,
            });
            if (!existing || existing.planItem.id !== record.response.id) {
              throw new GoalPlanApprovalError(
                'recovery_required',
                'Goal Plan owners are missing or contradict the receipt.'
              );
            }
            return buildGoalPlanCreationResponse(workspaceDb, workspaceId, threadId, existing);
          },
          responseId: (result) => result.planItemId,
        }).catch((error) => {
          if (
            error instanceof GoalPlanApprovalError ||
            error instanceof IdempotencyKeyConflictError ||
            error instanceof TurnStartValidationError
          ) {
            throw error;
          }
          const existing = readGoalPlanCreation({
            workspaceDb,
            store,
            workspaceId,
            threadId,
            requestId: parsed.data.requestId,
          });
          if (existing) {
            throw new GoalPlanApprovalError(
              'recovery_required',
              'Goal Plan owners exist without a matching command receipt.'
            );
          }
          throw error;
        });
        return c.json(response);
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      if (error instanceof GoalPlanApprovalError) {
        return asApiError(error.message, error.code, error.status);
      }
      return asCommandError(error, 'goal_plan_create_failed', 400);
    }
  });

  registerAppApiRoute(app, 'approveThreadGoalPlan', async (c) => {
    const parsed = ApproveThreadGoalPlanRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      store.getThread(workspaceId, threadId);

      if (!coreDb) {
        return asApiError(
          'Goal storage is unavailable for this NanoCore instance.',
          'goal_storage_unavailable',
          503
        );
      }

      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const response = await runIdempotentCommand({
          store,
          inflightCommands,
          command: 'goal.plan.approve',
          requestId: parsed.data.requestId,
          scope: { workspaceId, threadId },
          input: { planItemId: parsed.data.planItemId },
          responseKind: 'goal_plan',
          execute: () => {
            const goal = listGoalRecordsForThread(workspaceDb, { workspaceId, threadId }).find(
              (candidate) => candidate.planItemId === parsed.data.planItemId
            );
            if (!goal) {
              throw new GoalPlanApprovalError(
                'stale',
                'Goal Plan is not the active approval authority.'
              );
            }
            const approved = approveGoalPlan({
              workspaceDb,
              store,
              workspaceId,
              threadId,
              goalId: goal.goalId,
              planItemId: parsed.data.planItemId,
            });
            const summary = buildThreadGoalSummary(workspaceDb, workspaceId, threadId);
            if (!summary) {
              throw new GoalPlanApprovalError(
                'recovery_required',
                'Goal summary is unavailable after Plan approval.'
              );
            }
            return ApproveThreadGoalPlanResponseSchema.parse({
              goal: summary,
              readyTasks: approved.readyTasks,
              startsWorkerTurn: approved.startsWorkerTurn,
            });
          },
          replay: (record) => {
            if (
              record.response.kind !== 'goal_plan' ||
              record.response.id !== parsed.data.planItemId ||
              record.response.snapshot !== undefined
            ) {
              throw new GoalPlanApprovalError(
                'recovery_required',
                'Goal Plan approval receipt has invalid response lineage.'
              );
            }
            let plan: ReturnType<typeof getGoalPlanRecord>;
            try {
              plan = getGoalPlanRecord(workspaceDb, workspaceId, threadId, record.response.id);
            } catch {
              throw new GoalPlanApprovalError(
                'recovery_required',
                'Goal Plan approval authority failed its durable digest check.'
              );
            }
            const goal = plan
              ? getGoalRecord(workspaceDb, workspaceId, threadId, plan.goalId)
              : null;
            const planItem = store
              .listThreadItems(workspaceId, threadId)
              .find((item) => item.id === record.response.id && item.type === 'plan');
            const tasks = goal
              ? listGoalTasks(workspaceDb, { workspaceId, threadId, goalId: goal.goalId })
              : [];
            const exactTaskSet =
              plan !== null &&
              tasks.length === plan.tasks.length &&
              plan.tasks.every((plannedTask, index) => {
                const task = tasks.find((candidate) => candidate.taskId === plannedTask.taskId);
                return task?.planItemId === plan.planItemId && task.orderIndex === index;
              });
            const summary = goal
              ? buildThreadGoalSummary(workspaceDb, workspaceId, threadId, goal.goalId)
              : null;
            if (
              !goal ||
              goal.planItemId !== record.response.id ||
              goal.status === 'planning' ||
              goal.status === 'awaiting_plan_approval' ||
              !plan ||
              !planItem ||
              !exactTaskSet ||
              !summary
            ) {
              throw new GoalPlanApprovalError(
                'recovery_required',
                'Goal Plan approval owners are missing or contradictory.'
              );
            }
            return ApproveThreadGoalPlanResponseSchema.parse({
              goal: summary,
              readyTasks: plan.tasks
                .filter((task) => task.dependsOnTaskIds.length === 0)
                .map((task) => ({ taskId: task.taskId, status: 'ready' as const })),
              startsWorkerTurn: false,
            });
          },
          responseId: () => parsed.data.planItemId,
        });
        return c.json(response);
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      if (error instanceof GoalPlanApprovalError) {
        return asApiError(error.message, error.code, error.status);
      }
      return asCommandError(error, 'goal_plan_approve_failed', 400);
    }
  });

  registerAppApiRoute(app, 'reviseThreadGoalPlan', async (c) => {
    const parsed = ReviseThreadGoalPlanRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      store.getThread(workspaceId, threadId);

      if (!coreDb) {
        return asApiError(
          'Goal storage is unavailable for this NanoCore instance.',
          'goal_storage_unavailable',
          503
        );
      }

      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const revised = await runIdempotentCommand({
          store,
          inflightCommands,
          command: 'goal.plan.revise',
          requestId: parsed.data.requestId,
          scope: { workspaceId, threadId },
          input: { revision: parsed.data.revision },
          responseKind: 'goal',
          execute: () => {
            const existing = readGoalPlanRevision({
              workspaceDb,
              store,
              workspaceId,
              threadId,
              requestId: parsed.data.requestId,
            });
            if (existing) {
              if (existing.revisionItem.text !== parsed.data.revision) {
                throw new IdempotencyKeyConflictError();
              }
              throw new GoalPlanApprovalError(
                'recovery_required',
                'Goal Plan revision owners exist without a matching command receipt.'
              );
            }

            const goal = requireLatestActiveGoal(workspaceDb, workspaceId, threadId);
            if (goal.status !== 'awaiting_plan_approval' || !goal.planItemId) {
              throw new TurnStartValidationError(
                'goal_not_awaiting_plan_approval',
                'Goal is not awaiting plan approval.',
                409
              );
            }
            const revised = reviseGoalPlan({
              workspaceDb,
              store,
              workspaceId,
              threadId,
              goalId: goal.goalId,
              planItemId: goal.planItemId,
              requestId: parsed.data.requestId,
              revision: parsed.data.revision,
            });
            return buildGoalPlanRevisionResponse(workspaceDb, workspaceId, threadId, revised);
          },
          replay: (record) => {
            if (record.response.kind !== 'goal' || record.response.snapshot !== undefined) {
              throw new GoalPlanApprovalError(
                'recovery_required',
                'Goal Plan revision receipt has invalid response lineage.'
              );
            }
            const existing = readGoalPlanRevision({
              workspaceDb,
              store,
              workspaceId,
              threadId,
              requestId: parsed.data.requestId,
            });
            if (
              !existing ||
              existing.goalId !== record.response.id ||
              existing.revisionItem.text !== parsed.data.revision
            ) {
              throw new GoalPlanApprovalError(
                'recovery_required',
                'Goal Plan revision owners are missing or contradict the receipt.'
              );
            }
            return buildGoalPlanRevisionResponse(workspaceDb, workspaceId, threadId, existing);
          },
          responseId: (result) => result.goal.goalId,
        }).catch((error) => {
          if (
            error instanceof GoalPlanApprovalError ||
            error instanceof IdempotencyKeyConflictError ||
            error instanceof TurnStartValidationError
          ) {
            throw error;
          }
          const existing = readGoalPlanRevision({
            workspaceDb,
            store,
            workspaceId,
            threadId,
            requestId: parsed.data.requestId,
          });
          if (existing) {
            throw new GoalPlanApprovalError(
              'recovery_required',
              'Goal Plan revision owners exist without a matching command receipt.'
            );
          }
          throw error;
        });
        return c.json(revised);
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      if (error instanceof GoalPlanApprovalError) {
        return asApiError(error.message, error.code, error.status);
      }
      return asCommandError(error, 'goal_plan_revise_failed', 400);
    }
  });

  registerAppApiRoute(app, 'pauseThreadGoal', async (c) => {
    const parsed = PauseThreadGoalRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      store.getThread(workspaceId, threadId);

      if (!coreDb) {
        return asApiError(
          'Goal storage is unavailable for this NanoCore instance.',
          'goal_storage_unavailable',
          503
        );
      }

      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        return c.json(
          runGoalLifecycleCommand({
            store,
            workspaceDb,
            workspaceId,
            threadId,
            requestId: parsed.data.requestId,
            command: 'goal.pause',
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asCommandError(error, 'goal_pause_failed', 400);
    }
  });

  registerAppApiRoute(app, 'resumeThreadGoal', async (c) => {
    const parsed = ResumeThreadGoalRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      store.getThread(workspaceId, threadId);

      if (!coreDb) {
        return asApiError(
          'Goal storage is unavailable for this NanoCore instance.',
          'goal_storage_unavailable',
          503
        );
      }

      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        return c.json(
          runGoalLifecycleCommand({
            store,
            workspaceDb,
            workspaceId,
            threadId,
            requestId: parsed.data.requestId,
            command: 'goal.resume',
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asCommandError(error, 'goal_resume_failed', 400);
    }
  });

  registerAppApiRoute(app, 'runThreadGoalStep', async (c) => {
    const parsed = RunThreadGoalStepRequestSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    let workerLaunchFenced = false;
    let workerTurnTerminalized = false;

    try {
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      store.getThread(workspaceId, threadId);

      if (!coreDb) {
        return asApiError(
          'Goal storage is unavailable for this NanoCore instance.',
          'goal_storage_unavailable',
          503
        );
      }

      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const requestInputHash = commandInputHash({});
        const reservedTurnId = goalStepTurnId({
          store,
          workspaceId,
          threadId,
          requestId: parsed.data.requestId,
        });
        const response = await runIdempotentCommand({
          store,
          workspaceDb,
          inflightCommands,
          command: 'goal.step',
          requestId: parsed.data.requestId,
          scope: { workspaceId, threadId },
          input: {},
          responseKind: 'turn',
          responseId: (result) => result.result.turnId,
          responseSnapshot: (result) => ({ goalId: result.goal.goalId, ...result.result }),
          replay: (record) =>
            projectGoalStepResponse({
              store,
              workspaceDb,
              workspaceId,
              threadId,
              snapshot: parseGoalStepSnapshot(record),
            }),
          execute: async () => {
            const checkpoint = getWorkerCheckpoint(
              workspaceDb,
              workspaceId,
              threadId,
              reservedTurnId
            );
            if (checkpoint) {
              return recoverGoalStepFromCheckpoint({
                coreDb,
                store,
                workspaceDb,
                workspaceId,
                threadId,
                requestId: parsed.data.requestId,
                requestInputHash,
                turnId: reservedTurnId,
                checkpoint,
              });
            }
            const activeTurn = store.listThreadTurns(workspaceId, threadId).find(isNonTerminalTurn);
            if (activeTurn) {
              throw new TurnStartValidationError(
                'thread_busy',
                'Thread already has an active worker turn.',
                409
              );
            }
            const goal = requireLatestActiveGoal(workspaceDb, workspaceId, threadId);

            if (goal.status === 'paused') {
              throw new TurnStartValidationError('goal_paused', 'Goal is paused.', 409);
            }

            if (goal.status !== 'running') {
              throw new TurnStartValidationError('goal_not_running', 'Goal is not running.', 409);
            }

            const tasks = listGoalTasks(workspaceDb, {
              workspaceId,
              threadId,
              goalId: goal.goalId,
            });
            const task = selectNextGoalWorkerTask(tasks);

            if (!task) {
              throw new TurnStartValidationError(
                'goal_no_ready_task',
                'Goal does not have a ready task.',
                409
              );
            }

            let workerCoordinator: WorkerCoordinatorDecision | null = null;
            const reviewRequired = task.reviewPolicy.required;

            const loop = await runWorkerTurnLoop({
              workspaceDb,
              workspaceId,
              threadId,
              goalId: goal.goalId,
              taskId: task.taskId,
              requestId: parsed.data.requestId,
              requestInputHash,
              reviewRequired,
              remainingWorkerIterations: 0,
              prepare: () => {
                const preparedContext = prepareGoalTaskDelegation(coreDb!, workspaceDb, {
                  workspaceId,
                  userId: store.getUserId(),
                  threadId,
                  goalId: goal.goalId,
                  taskId: task.taskId,
                  threadItems: store.listThreadItems(workspaceId, threadId),
                });
                const coordinator = createWorkerCoordinatorDecision({
                  prompt: preparedContext.objective,
                  readiness: workerCoordinatorCandidates(store, workspaceId),
                  routingContext: 'goal_step',
                  threadState: { status: 'idle', threadId },
                  workspaceSummary: {
                    name: store.getWorkspace(workspaceId).name,
                    workspaceId,
                  },
                  contextRefs: preparedContext.contextRefs,
                  workerRequestDetails: preparedContext.workerRequestDetails,
                });

                if (
                  coordinator.decision !== 'worker_turn' ||
                  !coordinator.selectedWorkerCandidate ||
                  !coordinator.workerRequest ||
                  coordinator.requiredUserAction !== 'none'
                ) {
                  throw new Error(
                    `Goal step Coordinator did not select a worker: ${coordinator.explanation}`
                  );
                }

                workerCoordinator = coordinator;
                return {
                  repository: preparedContext.repository,
                  delegationRequest: coordinator.workerRequest,
                  contextPackageDigest: preparedContext.contextPackageDigest,
                };
              },
              reserveTurn: () => {
                const reservation = reserveGoalTaskForWorkerTurn(workspaceDb, {
                  workspaceId,
                  threadId,
                  goalId: goal.goalId,
                  taskId: task.taskId,
                });
                if (!reservation) {
                  throw new TurnStartValidationError(
                    'recovery_required',
                    'Goal or Task changed before worker-turn reservation.',
                    409
                  );
                }

                return { turnId: reservedTurnId };
              },
              startWorker: async ({ turnId, prepared }) => {
                workerLaunchFenced = true;
                const worker = workerCoordinator?.selectedWorkerCandidate;
                if (!worker) {
                  throw new Error(
                    'Goal step Coordinator decision is unavailable before worker start.'
                  );
                }

                await startModeWorkerTurn({
                  store,
                  workspaceId,
                  threadId,
                  prompt: serializeStructuredWorkerDelegationRequest(prepared.delegationRequest),
                  requestId: parsed.data.requestId,
                  requestedAgentId: worker.agentId,
                  reservedTurnId: turnId,
                });
                const session =
                  turnExecutor.getAgentSession?.(store, workspaceId, threadId) ?? null;

                return { workerSessionId: session?.id ?? null };
              },
              awaitWorker: async ({ turnId }) => {
                const turn = await waitForWorkerTurnTerminalState(store, turnId);
                completeSchedulerLeaseForTerminalTurn(coreDb, turn);
                const evidence = collectWorkerTurnEvidence(
                  store.listThreadItems(workspaceId, threadId),
                  turnId
                );
                const message =
                  turn.error?.message ??
                  (turn.status === 'completed' ? null : 'Worker turn ended without success.');

                return {
                  stopReason: stopReasonForTurnStatus(turn.status),
                  itemIds: evidence.itemIds,
                  artifactIds: evidence.artifactIds,
                  diagnosticsSummary: message,
                };
              },
            });

            workerTurnTerminalized = true;
            if (loop.stopDecision.outcome === 'continue') {
              throw new TurnStartValidationError(
                'goal_stop_decision_invalid',
                'Goal Mode does not permit lower-level worker continuation.',
                409
              );
            }
            if (!workerCoordinator) {
              throw new Error(
                'Goal step Coordinator decision is unavailable after worker completion.'
              );
            }
            return commitGoalStepOwnerOutcome({
              store,
              workspaceDb,
              workspaceId,
              threadId,
              requestId: parsed.data.requestId,
              goal,
              task,
              tasks,
              turnId: loop.turnId,
              stopDecision: loop.stopDecision,
              evidence: loop.evidence,
              contextAssembly: loop.contextAssembly,
            });
          },
        });
        if (response.result.outcome !== 'ask_user') {
          workerTurnTerminalized = true;
          const checkpoint = getWorkerCheckpoint(
            workspaceDb,
            workspaceId,
            threadId,
            response.result.turnId
          );
          if (!checkpoint) {
            return c.json(response);
          }
          const checkpointCleared = await clearWorkerCheckpointAfterTerminalState(workspaceDb, {
            workspaceId,
            threadId,
            turnId: response.result.turnId,
          });
          if (!checkpointCleared) {
            throw new Error('Goal worker checkpoint is not ready for terminal cleanup.');
          }
        }

        return c.json(response);
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      if (error instanceof GoalReviewResolutionError) {
        return asApiError(error.message, error.code, error.status);
      }
      const recoveryRequired = workerLaunchFenced || workerTurnTerminalized;
      if (error instanceof TurnStartValidationError && !recoveryRequired) {
        return asApiError(error.message, error.code, error.status);
      }
      return asApiError(
        redactInternalAgentText((error as Error).message),
        recoveryRequired ? 'recovery_required' : 'goal_step_failed',
        recoveryRequired ? 409 : 400
      );
    }
  });

  if (mode === 'local') {
    app.post(
      '/api/app/workspaces/:workspaceId/threads/:threadId/goal/test/supervise/step',
      async (c) => {
        const parsed = RunThreadGoalTestSuperviseStepRequestSchema.safeParse(
          await c.req.json().catch(() => ({}))
        );

        if (!parsed.success) {
          return asInvalidRequestError(parsed.error);
        }

        try {
          const workspaceId = c.req.param('workspaceId');
          const threadId = c.req.param('threadId');
          const store = requestStore(c);

          store.getWorkspace(workspaceId);
          store.getThread(workspaceId, threadId);

          if (!coreDb) {
            return asApiError(
              'Goal storage is unavailable for this NanoCore instance.',
              'goal_storage_unavailable',
              503
            );
          }

          const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
          try {
            const goal = requireLatestActiveGoal(workspaceDb, workspaceId, threadId);

            if (goal.status !== 'running') {
              return asApiError('Goal is not running.', 'goal_not_running', 409);
            }

            const task = selectNextReadyGoalTask(
              listGoalTasks(workspaceDb, { workspaceId, threadId, goalId: goal.goalId })
            );

            if (!task) {
              return asApiError('Goal does not have a ready task.', 'goal_no_ready_task', 409);
            }

            recordGoalWorkerLaunchDecision({
              workspaceDb,
              workspaceId,
              threadId,
              goalId: goal.goalId,
              taskId: task.taskId,
              enforcementPoint: 'goal.test.supervise.worker_start',
            });
            const worker = await startGoalTaskWorkerTurn({
              workspaceDb,
              store,
              workspaceId,
              threadId,
              goalId: goal.goalId,
              taskId: task.taskId,
              requestId: `goal-test-supervise:${goal.goalId}:${task.taskId}`,
              requestInputHash: commandInputHash(parsed.data),
              prepared: createDeterministicPreparedGoalTask(task),
              startWorker: () => ({ workerSessionId: null }),
            });
            const timestamp = worker.turn.startedAt ?? new Date().toISOString();
            const evidenceItem = store.createItem({
              id: `it_goal_worker_${goal.goalId}_${task.taskId}`,
              workspaceId,
              threadId,
              turnId: worker.turn.id,
              type: 'status',
              status: 'completed',
              level: 'info',
              title: 'Deterministic worker completed',
              summary: task.objective,
              createdAt: timestamp,
              completedAt: timestamp,
            });

            store.updateTurn(worker.turn.id, {
              status: 'completed',
              completedAt: timestamp,
              durationMs: 0,
            });

            const workerOutcome = recordGoalTaskWorkerOutcome(workspaceDb, {
              workspaceDb,
              workspaceId,
              threadId,
              goalId: goal.goalId,
              taskId: task.taskId,
              turnId: worker.turn.id,
              stopReason: 'completed',
              itemIds: [evidenceItem.id],
            });
            const requestId = `goal-test-supervise:${goal.goalId}:${task.taskId}`;
            const { review, advance } = workspaceDb.sqlite.transaction(() => {
              const unresolved = createGoalReviewRecord(workspaceDb, {
                reviewId: `review_${goal.goalId}_${task.taskId}`,
                workspaceId,
                threadId,
                goalId: goal.goalId,
                taskId: task.taskId,
                turnId: worker.turn.id,
                itemIds: [evidenceItem.id],
                prompt: 'Review the deterministic worker evidence.',
                createdByRequestId: requestId,
              });
              updateGoalTask(workspaceDb, {
                workspaceId,
                threadId,
                goalId: goal.goalId,
                taskId: task.taskId,
                status: 'reviewing',
              });
              updateGoalStatus(workspaceDb, {
                workspaceId,
                threadId,
                goalId: goal.goalId,
                status: 'reviewing',
                currentTaskId: task.taskId,
                terminalStopReason: null,
              });
              const advance = advanceGoalAfterReview(workspaceDb, {
                workspaceId,
                threadId,
                goalId: goal.goalId,
                taskId: task.taskId,
                verdict: parsed.data.verdict,
              });
              const review = resolveGoalReviewRecord(workspaceDb, {
                workspaceId,
                threadId,
                goalId: goal.goalId,
                reviewId: unresolved.reviewId,
                requestId,
                actorId: c.get('actor').userId,
                verdict: parsed.data.verdict,
                ...(parsed.data.verdict === 'retry' || parsed.data.verdict === 'abort'
                  ? { reason: 'Deterministic test decision.' }
                  : {}),
                ...(parsed.data.verdict === 'refine'
                  ? { revisionInstruction: 'Deterministic refinement instruction.' }
                  : {}),
                resolutionSnapshot: advance,
              });

              return { review, advance };
            })();
            const summary = buildThreadGoalSummary(workspaceDb, workspaceId, threadId);

            if (!summary) {
              return asApiError('Goal summary is unavailable.', 'goal_summary_unavailable', 500);
            }

            return c.json(
              RunThreadGoalTestSuperviseStepResponseSchema.parse({
                goal: summary,
                task: {
                  taskId: advance.task.taskId,
                  title: task.title,
                  status: advance.task.status,
                  orderIndex: task.orderIndex,
                },
                worker: {
                  turnId: worker.turn.id,
                  stopReason: 'completed',
                  checkpointStage: workerOutcome.checkpointStage,
                },
                review: {
                  reviewId: review.reviewId,
                  verdict: review.verdict,
                },
                advance: {
                  outcome: advance.outcome,
                  nextReadyTaskId: advance.nextReadyTaskId,
                },
              })
            );
          } finally {
            workspaceDb.sqlite.close();
          }
        } catch (error) {
          return asApiError((error as Error).message, 'goal_supervise_step_failed', 400);
        }
      }
    );
  }
}

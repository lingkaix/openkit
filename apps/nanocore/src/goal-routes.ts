import {
  ApproveThreadGoalPlanRequestSchema,
  ApproveThreadGoalPlanResponseSchema,
  CreateThreadGoalPlanResponseSchema,
  type GoalPendingHumanAttention,
  type GoalTaskCounts,
  type GoalTerminalState,
  type GoalTerminalSummary,
  PauseThreadGoalResponseSchema,
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
  SubmitThreadGoalSteeringResponseSchema,
  type TaskDelegationDecision,
  type ThreadGoalCurrentTask,
  type ThreadGoalSummary,
  ThreadGoalSummaryResponseSchema,
} from '@openkit/app-api-schemas';
import type { TurnSchema } from '@openkit/protocol';
import type { Context, Hono } from 'hono';
import type { z } from 'zod';

import { asApiError, asInvalidRequestError } from './api-errors.js';
import type { AuthVariables } from './auth/middleware.js';
import type { CoreMode } from './config/mode.js';
import type { RuntimeConfigSnapshot } from './config/runtime-config.js';
import { redactInternalAgentText } from './internal-agents/redaction.js';
import {
  createWorkerCoordinatorDecision,
  createWorkerCoordinatorGoalPlanDraft,
  createWorkerCoordinatorGoalStopDecision,
  type WorkerCoordinatorCandidate,
} from './internal-agents/worker-coordinator.js';
import type { FsStore } from './lib/store.js';
import { registerAppApiRoute } from './openapi.js';
import { recordGoalWorkerLaunchDecision } from './policy/permission-decisions.js';
import { approveGoalPlan, reviseGoalPlan } from './runtime/goal-plan-approval.js';
import { createGoalPlan } from './runtime/goal-planning.js';
import { createGoalReviewRecord } from './runtime/goal-review-records.js';
import { getGoalSteeringReadModel, recordActiveGoalSteering } from './runtime/goal-steering.js';
import {
  createGoalRecord,
  type GoalRecord,
  type GoalTaskRecord,
  listGoalRecordsForThread,
  listGoalTasks,
  updateGoalStatus,
  updateGoalTask,
} from './runtime/goal-store.js';
import { advanceGoalAfterReview } from './runtime/goal-supervise-advance.js';
import { prepareGoalTaskDelegation } from './runtime/goal-task-delegation.js';
import { persistApprovedGoalTasks } from './runtime/goal-task-persistence.js';
import { selectNextReadyGoalTask } from './runtime/goal-task-selector.js';
import {
  type GoalVerificationRecord,
  listGoalVerificationRecordsForGoal,
} from './runtime/goal-verification-records.js';
import { recordGoalTaskWorkerOutcome } from './runtime/goal-worker-outcome.js';
import { startGoalTaskWorkerTurn } from './runtime/goal-worker-start.js';
import { TurnStartValidationError } from './runtime/orchestrator.js';
import type { PreparedNextTurn } from './runtime/prepare-next-turn.js';
import { stopReasonForTurnStatus } from './runtime/stop-after-turn.js';
import {
  materializeWorkspaceRootsForTurn,
  resolveWorkspaceRepositoryForTurn,
  workspaceSourceContextForTurn,
} from './runtime/turn-workspace-context.js';
import type { TurnExecutor } from './runtime/types.js';
import { clearWorkerCheckpointAfterTerminalState } from './runtime/worker-recovery.js';
import { runWorkerTurnLoop } from './runtime/worker-turn-loop.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';

/** Parsed turn read model used by Goal worker lifecycle guards. */
type TurnReadModel = z.infer<typeof TurnSchema>;

/** Durable item shape returned by the app-local store. */
type StoreItem = ReturnType<FsStore['listAllItems']>[number];

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
    needsRevision: 0,
    completed: 0,
    blocked: 0,
    failed: 0,
    skipped: 0,
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
    if (task.status === 'needs_revision') {
      counts.needsRevision += 1;
      continue;
    }

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
 * @param threadItems Durable thread items associated with the goal thread.
 * @returns Human attention summary for the goal read model.
 */
function projectGoalHumanAttention(
  goal: GoalRecord,
  threadItems: readonly { readonly type: string; readonly status: string }[]
): GoalPendingHumanAttention {
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

  const hasPendingHumanItem = threadItems.some(
    (item) =>
      item.status === 'in_progress' &&
      (item.type === 'approval-request' || item.type === 'user-input-request')
  );

  if (hasPendingHumanItem) {
    return { required: true, reason: 'Goal has pending human input.' };
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
    skippedTaskIds: tasks.filter((task) => task.status === 'skipped').map((task) => task.taskId),
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
    (task) => !['completed', 'skipped', 'blocked', 'failed'].includes(task.status)
  ).length;

  if (blockedTaskCount > 0) {
    risks.push(`${blockedTaskCount} required task is blocked or failed.`);
  }

  if (incompleteTaskCount > 0) {
    risks.push(`${incompleteTaskCount} required task is not accepted or skipped.`);
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
 * @param threadItems Durable thread items for human attention projection.
 * @returns Latest goal summary for the thread, or null when no goal exists.
 */
function buildThreadGoalSummary(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  threadId: string,
  threadItems: readonly { readonly type: string; readonly status: string }[]
): ThreadGoalSummary | null {
  const goal = listGoalRecordsForThread(workspaceDb, { workspaceId, threadId }).at(-1) ?? null;

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
    pendingHumanAttention: projectGoalHumanAttention(goal, threadItems),
    terminalState: projectGoalTerminalState(goal),
    terminalSummary: projectGoalTerminalSummary(goal, tasks, verifications),
    steering: getGoalSteeringReadModel(workspaceDb, { workspaceId, threadId }),
    updatedAt: goal.updatedAt,
  };
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
    followUpInputs: [],
    repository: {
      resourceId: 'repo_deterministic',
    } as PreparedNextTurn['repository'],
    steeringMessages: [],
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
 * Creates a product-facing pending attention row from one stop decision.
 *
 * @param outcome Higher-level worker-loop outcome.
 * @param itemId Optional item id associated with the attention state.
 * @returns Pending attention row, or null when no human-visible attention is required.
 */
function pendingAttentionForGoalStep(
  outcome: 'continue' | 'review' | 'ask_user' | 'block' | 'abort' | 'complete',
  itemId: string | null
): {
  kind: 'review' | 'user_input' | 'blocked' | 'failed' | 'interrupted';
  reason: string;
  itemId: string | null;
} | null {
  switch (outcome) {
    case 'review':
      return { kind: 'review', reason: 'Worker result needs review.', itemId };
    case 'ask_user':
      return { kind: 'user_input', reason: 'Worker requested user input.', itemId };
    case 'block':
      return { kind: 'blocked', reason: 'Goal step is blocked.', itemId };
    case 'abort':
      return { kind: 'interrupted', reason: 'Goal step was aborted.', itemId };
    case 'continue':
    case 'complete':
      return null;
  }
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

/**
 * Creates a deterministic next goal id within one thread.
 *
 * @param existingGoals Existing goals already stored for the thread.
 * @returns Next goal id.
 */
function nextThreadGoalId(existingGoals: readonly GoalRecord[]): string {
  return `goal_${existingGoals.length + 1}`;
}

/**
 * Builds the V1 Goal Mode step delegation decision from the rule-based Worker Coordinator.
 *
 * @param input Goal Mode step context.
 * @returns Public Coordinator delegation decision for the selected worker step.
 */
function createGoalModeStepDelegation(input: {
  /** Store that owns workspace resources. */
  readonly store: FsStore;
  /** Workspace id for the goal. */
  readonly workspaceId: string;
  /** Thread id for the goal. */
  readonly threadId: string;
  /** Goal task selected for execution. */
  readonly task: GoalTaskRecord;
  /** Projects the workspace agent catalog into Coordinator candidates. */
  readonly workerCoordinatorCandidates: (
    store: FsStore,
    workspaceId: string
  ) => WorkerCoordinatorCandidate[];
}): TaskDelegationDecision {
  const coordinator = createWorkerCoordinatorDecision({
    prompt: `Run Goal Mode step: ${input.task.objective}`,
    readiness: input.workerCoordinatorCandidates(input.store, input.workspaceId),
    routingContext: 'goal_step',
    threadState: { status: 'idle', threadId: input.threadId },
    workspaceSummary: {
      name: input.store.getWorkspace(input.workspaceId).name,
      workspaceId: input.workspaceId,
    },
  });

  if (coordinator.decision !== 'worker_turn' || !coordinator.selectedWorkerCandidate) {
    throw new Error(`Goal step Coordinator did not select a worker: ${coordinator.explanation}`);
  }

  return {
    mode: 'goal',
    sourceAgentId: 'worker-coordinator',
    worker: {
      agentId: coordinator.selectedWorkerCandidate.agentId,
      displayName: coordinator.selectedWorkerCandidate.displayName,
      runtime: coordinator.selectedWorkerCandidate.runtime,
    },
    confidence: coordinator.confidence,
    rationale: coordinator.explanation,
    requiredApprovals:
      coordinator.requiredUserAction === 'none' ||
      coordinator.requiredUserAction === 'confirm_worker_turn'
        ? []
        : [coordinator.requiredUserAction],
    expectedStopCondition: 'one bounded worker turn',
    escalationRecommended: false,
    contextRefs: coordinator.workerRequest?.contextRefs ?? [
      { kind: 'workspace', id: input.workspaceId },
      { kind: 'thread', id: input.threadId },
    ],
  };
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
  /** Goal objective supplied by the user or Coordinator. */
  readonly objective: string;
  /** Optional user-facing goal title. */
  readonly title?: string | undefined;
}): {
  readonly response: z.infer<typeof StartThreadGoalResponseSchema>;
  readonly turn: z.infer<typeof TurnSchema>;
} {
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

    const goalId = nextThreadGoalId(existingGoals);
    const turn = input.store.createTurn(input.workspaceId, input.threadId, input.objective);
    const timestamp = turn.startedAt ?? new Date().toISOString();
    const objectiveItem = input.store.createItem({
      id: `it_goal_objective_${goalId}`,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId: turn.id,
      type: 'user-message',
      status: 'completed',
      text: input.objective,
      createdAt: timestamp,
      completedAt: timestamp,
    });

    input.store.updateTurn(turn.id, {
      status: 'completed',
      completedAt: timestamp,
      durationMs: 0,
    });

    createGoalRecord(workspaceDb, {
      workspaceExists: (candidateWorkspaceId) => {
        try {
          input.store.getWorkspace(candidateWorkspaceId);
          return true;
        } catch {
          return false;
        }
      },
      goalId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      title: deriveThreadGoalTitle(input.title, input.objective),
      objective: input.objective,
      createdByItemId: objectiveItem.id,
      now: () => timestamp,
    });

    const goal = buildThreadGoalSummary(
      workspaceDb,
      input.workspaceId,
      input.threadId,
      input.store.listThreadItems(input.workspaceId, input.threadId)
    );

    if (!goal) {
      throw new TurnStartValidationError('goal_create_failed', 'Goal was not created.', 500);
    }

    return {
      response: StartThreadGoalResponseSchema.parse({
        goal,
        objectiveItemId: objectiveItem.id,
      }),
      turn: input.store.getTurnById(turn.id),
    };
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
  mode,
  repositoryWorkspaceDb,
  requestStore,
  runtimeConfig,
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
  /** Deployment mode that gates deterministic local-only routes. */
  readonly mode: CoreMode;
  /** Opens the migrated workspace database. */
  readonly repositoryWorkspaceDb: (store: FsStore, workspaceId: string) => WorkspaceDb;
  /** Resolves request-scoped storage. */
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
  /** Returns the current runtime configuration snapshot. */
  readonly runtimeConfig: () => RuntimeConfigSnapshot;
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
            goal: buildThreadGoalSummary(
              workspaceDb,
              workspaceId,
              threadId,
              store.listThreadItems(workspaceId, threadId)
            ),
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

      return c.json(
        startGoalModeObjective({
          assertProjectWorkspace,
          coreDb,
          repositoryWorkspaceDb,
          store,
          workspaceId,
          threadId,
          objective: parsed.data.objective,
          title: parsed.data.title,
        }).response
      );
    } catch (error) {
      if (error instanceof TurnStartValidationError) {
        return asApiError(error.message, error.code, error.status);
      }

      return asApiError((error as Error).message, 'goal_create_failed', 400);
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
        const turn = store.createTurn(workspaceId, threadId, parsed.data.message);
        const timestamp = turn.startedAt ?? new Date().toISOString();
        const steeringItem = store.createItem({
          id: `it_goal_steering_${goal.goalId}_${parsed.data.requestId}`,
          workspaceId,
          threadId,
          turnId: turn.id,
          type: 'user-message',
          status: 'completed',
          text: parsed.data.message,
          createdAt: timestamp,
          completedAt: timestamp,
        });

        store.updateTurn(turn.id, {
          status: 'completed',
          completedAt: timestamp,
          durationMs: 0,
        });

        const recorded = recordActiveGoalSteering(workspaceDb, {
          workspaceId,
          threadId,
          goalId: goal.goalId,
          requestId: parsed.data.requestId,
          contentItemId: steeringItem.id,
          now: () => timestamp,
        });
        const summary = buildThreadGoalSummary(
          workspaceDb,
          workspaceId,
          threadId,
          store.listThreadItems(workspaceId, threadId)
        );

        if (!summary) {
          return asApiError('Goal summary is unavailable.', 'goal_summary_unavailable', 500);
        }

        return c.json(
          SubmitThreadGoalSteeringResponseSchema.parse({
            state: recorded.state === 'pending_steering' ? 'queued' : 'blocked',
            goal: summary,
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message, 'goal_steering_failed', 400);
    }
  });

  registerAppApiRoute(app, 'createThreadGoalPlan', async (c) => {
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

        if (goal.status !== 'planning') {
          return asApiError('Goal is not ready for planning.', 'goal_not_planning', 409);
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
        });

        if (result.status !== 'awaiting_plan_approval') {
          return asApiError(
            'Goal planner did not produce an approvable plan.',
            'goal_plan_failed',
            400
          );
        }

        const summary = buildThreadGoalSummary(
          workspaceDb,
          workspaceId,
          threadId,
          store.listThreadItems(workspaceId, threadId)
        );

        if (!summary) {
          return asApiError('Goal summary is unavailable.', 'goal_summary_unavailable', 500);
        }

        return c.json(
          CreateThreadGoalPlanResponseSchema.parse({
            status: result.status,
            goal: summary,
            planItemId: result.planItem.id,
            planner,
            plan: result.plan,
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message, 'goal_plan_create_failed', 400);
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
        const goal = requireLatestActiveGoal(workspaceDb, workspaceId, threadId);

        if (goal.status !== 'awaiting_plan_approval') {
          return asApiError(
            'Goal is not awaiting plan approval.',
            'goal_not_awaiting_plan_approval',
            409
          );
        }

        if (goal.planItemId !== parsed.data.planItemId) {
          return asApiError('Plan item does not match the active goal.', 'goal_plan_mismatch', 400);
        }

        const approved = approveGoalPlan({
          workspaceDb,
          workspaceId,
          threadId,
          goalId: goal.goalId,
          planItemId: parsed.data.planItemId,
          plan: parsed.data.plan,
        });
        persistApprovedGoalTasks({
          workspaceDb,
          workspaceId,
          threadId,
          goalId: goal.goalId,
          plan: parsed.data.plan,
        });

        const summary = buildThreadGoalSummary(
          workspaceDb,
          workspaceId,
          threadId,
          store.listThreadItems(workspaceId, threadId)
        );

        if (!summary) {
          return asApiError('Goal summary is unavailable.', 'goal_summary_unavailable', 500);
        }

        return c.json(
          ApproveThreadGoalPlanResponseSchema.parse({
            goal: summary,
            readyTasks: approved.readyTasks,
            startsWorkerTurn: approved.startsWorkerTurn,
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message, 'goal_plan_approve_failed', 400);
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
        const goal = requireLatestActiveGoal(workspaceDb, workspaceId, threadId);

        if (goal.status !== 'awaiting_plan_approval') {
          return asApiError(
            'Goal is not awaiting plan approval.',
            'goal_not_awaiting_plan_approval',
            409
          );
        }

        const revised = reviseGoalPlan({
          workspaceDb,
          store,
          workspaceId,
          threadId,
          goalId: goal.goalId,
          requestId: parsed.data.requestId,
          revision: parsed.data.revision,
        });

        const summary = buildThreadGoalSummary(
          workspaceDb,
          workspaceId,
          threadId,
          store.listThreadItems(workspaceId, threadId)
        );

        if (!summary) {
          return asApiError('Goal summary is unavailable.', 'goal_summary_unavailable', 500);
        }

        return c.json(
          ReviseThreadGoalPlanResponseSchema.parse({
            goal: summary,
            revisionItemId: revised.revisionItem.id,
            startsWorkerTurn: revised.startsWorkerTurn,
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message, 'goal_plan_revise_failed', 400);
    }
  });

  registerAppApiRoute(app, 'pauseThreadGoal', async (c) => {
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

      const activeTurn = store
        .listThreadTurns(workspaceId, threadId)
        .find((turn) => turn.status === 'running' || turn.status === 'awaiting_human');

      if (activeTurn) {
        return asApiError(
          'Goal cannot pause while a worker turn is active.',
          'goal_pause_active_turn',
          409
        );
      }

      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const goal = requireLatestActiveGoal(workspaceDb, workspaceId, threadId);

        if (goal.status !== 'running' && goal.status !== 'paused') {
          return asApiError('Goal is not running.', 'goal_not_running', 409);
        }

        if (goal.status !== 'paused') {
          updateGoalStatus(workspaceDb, {
            workspaceId,
            threadId,
            goalId: goal.goalId,
            status: 'paused',
          });
        }

        const summary = buildThreadGoalSummary(
          workspaceDb,
          workspaceId,
          threadId,
          store.listThreadItems(workspaceId, threadId)
        );

        if (!summary) {
          return asApiError('Goal summary is unavailable.', 'goal_summary_unavailable', 500);
        }

        return c.json(PauseThreadGoalResponseSchema.parse({ goal: summary }));
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message, 'goal_pause_failed', 400);
    }
  });

  registerAppApiRoute(app, 'resumeThreadGoal', async (c) => {
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

        if (goal.status !== 'paused') {
          return asApiError('Goal is not paused.', 'goal_not_paused', 409);
        }

        updateGoalStatus(workspaceDb, {
          workspaceId,
          threadId,
          goalId: goal.goalId,
          status: 'running',
        });

        const summary = buildThreadGoalSummary(
          workspaceDb,
          workspaceId,
          threadId,
          store.listThreadItems(workspaceId, threadId)
        );

        if (!summary) {
          return asApiError('Goal summary is unavailable.', 'goal_summary_unavailable', 500);
        }

        return c.json(ResumeThreadGoalResponseSchema.parse({ goal: summary }));
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message, 'goal_resume_failed', 400);
    }
  });

  registerAppApiRoute(app, 'runThreadGoalStep', async (c) => {
    const parsed = RunThreadGoalStepRequestSchema.safeParse(await c.req.json().catch(() => ({})));

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

      const activeTurn = store
        .listThreadTurns(workspaceId, threadId)
        .find((turn) => turn.status === 'running' || turn.status === 'awaiting_human');

      if (activeTurn) {
        return asApiError('Thread already has an active worker turn.', 'thread_busy', 409);
      }

      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const goal = requireLatestActiveGoal(workspaceDb, workspaceId, threadId);

        if (goal.status === 'paused') {
          return asApiError('Goal is paused.', 'goal_paused', 409);
        }

        if (goal.status !== 'running') {
          return asApiError('Goal is not running.', 'goal_not_running', 409);
        }

        const tasks = listGoalTasks(workspaceDb, { workspaceId, threadId, goalId: goal.goalId });
        const task = selectNextGoalWorkerTask(tasks);

        if (!task) {
          return asApiError('Goal does not have a ready task.', 'goal_no_ready_task', 409);
        }

        const repository = resolveWorkspaceRepositoryForTurn(
          coreDb,
          workspaceId,
          store.getUserId()
        );

        const coordinator = createGoalModeStepDelegation({
          store,
          workerCoordinatorCandidates,
          workspaceId,
          threadId,
          task,
        });
        const reviewRequired = parsed.data.reviewPolicyOverride !== 'none';

        const snapshot = runtimeConfig();
        const workspaceRoots = materializeWorkspaceRootsForTurn(
          snapshot,
          store,
          workspaceId,
          repository
        );
        const workspaceSourceContext = workspaceSourceContextForTurn(
          coreDb,
          snapshot,
          store,
          workspaceId,
          repository,
          workspaceRoots
        );

        const loop = await runWorkerTurnLoop({
          workspaceDb,
          workspaceId,
          threadId,
          goalId: goal.goalId,
          taskId: task.taskId,
          reviewRequired,
          remainingWorkerIterations: Math.max(
            0,
            tasks.filter((candidate) => candidate.status === 'ready').length - 1
          ),
          ...(parsed.data.followUpDrainMode
            ? { followUpDrainMode: parsed.data.followUpDrainMode }
            : {}),
          prepare: (queues) =>
            prepareGoalTaskDelegation(coreDb!, workspaceDb, {
              workspaceId,
              userId: store.getUserId(),
              threadId,
              goalId: goal.goalId,
              taskId: task.taskId,
              threadItems: store.listThreadItems(workspaceId, threadId),
              steeringMessages: queues.steeringMessages,
              followUpInputs: queues.followUpInputs,
            }),
          createTurn: ({ prepared }) => {
            const turn = store.createTurn(
              workspaceId,
              threadId,
              prepared.delegationRequest.objective
            );
            updateGoalTask(workspaceDb, {
              workspaceId,
              threadId,
              goalId: goal.goalId,
              taskId: task.taskId,
              status: 'running',
            });
            updateGoalStatus(workspaceDb, {
              workspaceId,
              threadId,
              goalId: goal.goalId,
              status: 'running',
              currentTaskId: task.taskId,
            });

            return { turnId: turn.id };
          },
          startWorker: async ({ turnId, prepared }) => {
            await turnExecutor.startTurn(store, turnId, prepared.delegationRequest.objective, {
              requestId: parsed.data.requestId,
              workspaceRoots,
              ...workspaceSourceContext,
              workspaceCwd: prepared.repository.localPath,
            });
            const session = turnExecutor.getAgentSession?.(store, workspaceId, threadId) ?? null;

            return { workerSessionId: session?.id ?? null };
          },
          awaitWorker: async ({ turnId }) => {
            const turn = await waitForWorkerTurnTerminalState(store, turnId);
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

        const workerOutcome = recordGoalTaskWorkerOutcome(workspaceDb, {
          workspaceDb,
          workspaceId,
          threadId,
          goalId: goal.goalId,
          taskId: task.taskId,
          turnId: loop.turnId,
          stopReason: loop.stopDecision.stopReason,
          itemIds: loop.evidence.itemIds,
          artifactIds: loop.evidence.artifactIds,
          contextAssembly: loop.contextAssembly,
        });
        const attentionItemId = loop.evidence.itemIds.at(-1) ?? null;
        let goalStepOutcome = loop.stopDecision.outcome;

        switch (goalStepOutcome) {
          case 'review':
            workspaceDb.sqlite.transaction(() => {
              createGoalReviewRecord(workspaceDb, {
                reviewId: `review_${loop.turnId}`,
                workspaceId,
                threadId,
                goalId: goal.goalId,
                taskId: task.taskId,
                turnId: loop.turnId,
                itemIds: loop.evidence.itemIds,
                artifactIds: loop.evidence.artifactIds,
                verdict: 'accept',
                reason: 'Accept the completed worker output before Goal Mode continues.',
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
              });
            })();
            break;
          case 'ask_user': {
            updateGoalStatus(workspaceDb, {
              workspaceId,
              threadId,
              goalId: goal.goalId,
              status: 'awaiting_user',
              currentTaskId: task.taskId,
              terminalStopReason: 'ask_user',
            });
            break;
          }
          case 'block':
            updateGoalStatus(workspaceDb, {
              workspaceId,
              threadId,
              goalId: goal.goalId,
              status: loop.stopDecision.stopReason === 'error' ? 'failed' : 'blocked',
              currentTaskId: task.taskId,
              terminalStopReason: loop.stopDecision.stopReason,
            });
            break;
          case 'abort':
            updateGoalStatus(workspaceDb, {
              workspaceId,
              threadId,
              goalId: goal.goalId,
              status: 'aborted',
              currentTaskId: task.taskId,
              terminalStopReason: 'aborted',
            });
            break;
          case 'complete':
            goalStepOutcome =
              advanceGoalAfterReview(workspaceDb, {
                workspaceId,
                threadId,
                goalId: goal.goalId,
                taskId: task.taskId,
                verdict: 'accept',
              }).outcome === 'complete_goal'
                ? 'complete'
                : 'continue';
            break;
          case 'continue':
            updateGoalStatus(workspaceDb, {
              workspaceId,
              threadId,
              goalId: goal.goalId,
              status: 'running',
              currentTaskId: null,
            });
            break;
        }

        const stopDecision = createWorkerCoordinatorGoalStopDecision({
          workspaceId,
          threadId,
          requestId: parsed.data.requestId,
          goalId: goal.goalId,
          taskId: task.taskId,
          turnId: loop.turnId,
          stopDecision: {
            ...loop.stopDecision,
            outcome: goalStepOutcome,
            shouldStop: goalStepOutcome !== 'continue',
          },
          evidence: loop.evidence,
        });

        clearWorkerCheckpointAfterTerminalState(workspaceDb, {
          workspaceId,
          threadId,
          turnId: loop.turnId,
          terminalStage: workerOutcome.checkpointStage,
        });
        const summary = buildThreadGoalSummary(
          workspaceDb,
          workspaceId,
          threadId,
          store.listThreadItems(workspaceId, threadId)
        );

        if (!summary) {
          return asApiError('Goal summary is unavailable.', 'goal_summary_unavailable', 500);
        }

        return c.json(
          RunThreadGoalStepResponseSchema.parse({
            goal: summary,
            worker: {
              turnId: loop.turnId,
              stopReason: stopDecision.stopReason,
              checkpointStage: workerOutcome.checkpointStage,
              workerSessionId: loop.workerSessionId,
              evidence: loop.evidence,
            },
            contextAssembly: loop.contextAssembly,
            coordinator,
            decision: stopDecision,
            pendingAttention: pendingAttentionForGoalStep(stopDecision.outcome, attentionItemId),
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      if (coreDb) {
        const workspaceId = c.req.param('workspaceId');
        const threadId = c.req.param('threadId');
        const store = requestStore(c);
        const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
        try {
          const goal =
            listGoalRecordsForThread(workspaceDb, { workspaceId, threadId }).findLast(
              isActiveGoal
            ) ?? null;

          if (goal) {
            updateGoalStatus(workspaceDb, {
              workspaceId,
              threadId,
              goalId: goal.goalId,
              status: 'failed',
              terminalStopReason: 'error',
            });
          }
        } finally {
          workspaceDb.sqlite.close();
        }
      }

      return asApiError(redactInternalAgentText((error as Error).message), 'goal_step_failed', 400);
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
            const review = createGoalReviewRecord(workspaceDb, {
              reviewId: `review_${goal.goalId}_${task.taskId}`,
              workspaceId,
              threadId,
              goalId: goal.goalId,
              taskId: task.taskId,
              turnId: worker.turn.id,
              itemIds: [evidenceItem.id],
              verdict: parsed.data.verdict,
              reason: 'Deterministic supervise e2e accepted the worker outcome.',
            });
            const advance = advanceGoalAfterReview(workspaceDb, {
              workspaceId,
              threadId,
              goalId: goal.goalId,
              taskId: task.taskId,
              verdict: parsed.data.verdict,
            });
            const summary = buildThreadGoalSummary(
              workspaceDb,
              workspaceId,
              threadId,
              store.listThreadItems(workspaceId, threadId)
            );

            if (!summary) {
              return asApiError('Goal summary is unavailable.', 'goal_summary_unavailable', 500);
            }

            return c.json(
              RunThreadGoalTestSuperviseStepResponseSchema.parse({
                goal: summary,
                task: {
                  taskId: advance.task.taskId,
                  title: advance.task.title,
                  status: advance.task.status,
                  orderIndex: advance.task.orderIndex,
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
                  nextTaskId: advance.nextTask?.taskId ?? null,
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

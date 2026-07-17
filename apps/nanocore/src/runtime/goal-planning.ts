import { createHash } from 'node:crypto';

import type { FsStore } from '../lib/store.js';
import type { WorkspaceDb } from '../storage/db.js';
import {
  createDeterministicGoalPlanFallback,
  type GoalPlanOutput,
  GoalPlanOutputSchema,
  selectGoalPlanPayload,
} from './goal-plan.js';
import { GoalPlanApprovalError } from './goal-plan-approval.js';
import {
  createGoalPlanRecord,
  type GoalRecord,
  getGoalPlanRecord,
  getGoalRecord,
  updateGoalStatus,
} from './goal-store.js';

type GoalPlanItem = ReturnType<FsStore['createItem']>;

/**
 * Planner input for one Goal Mode planning run.
 */
export interface GoalPlannerInput {
  /** Stored goal record to plan. */
  readonly goal: GoalRecord;
}

/**
 * Effect that creates one Goal Mode plan output.
 */
export type GoalPlanner = (input: GoalPlannerInput) => GoalPlanOutput | Promise<GoalPlanOutput>;

/**
 * Input used to create or request a plan for one goal.
 */
export interface CreateGoalPlanInput {
  /** Open workspace-scope database handle. */
  readonly workspaceDb: WorkspaceDb;
  /** App-local durable store. */
  readonly store: FsStore;
  /** Workspace that owns the goal. */
  readonly workspaceId: string;
  /** Thread that owns the goal. */
  readonly threadId: string;
  /** Goal to plan. */
  readonly goalId: string;
  /** Request that creates the immutable Plan authority. */
  readonly requestId: string;
  /** Optional planner effect; deterministic fallback is used when omitted. */
  readonly planner?: GoalPlanner;
}

/**
 * Successful goal planning result waiting for human plan approval.
 */
export interface GoalPlanAwaitingApprovalResult {
  /** Goal status after storing the plan. */
  readonly status: 'awaiting_plan_approval';
  /** Validated plan output. */
  readonly plan: GoalPlanOutput;
  /** Durable plan item linked from the goal. */
  readonly planItem: GoalPlanItem;
}

/**
 * Planning result that needs more human input before a plan can be approved.
 */
export interface GoalPlanAwaitingUserResult {
  /** Goal status after emitting bounded questions. */
  readonly status: 'awaiting_user';
  /** Validated plan output containing questions. */
  readonly plan: GoalPlanOutput;
  /** Durable user-input request item. */
  readonly questionItem: GoalPlanItem;
}

/**
 * Planning result after a planner failure.
 */
export interface GoalPlanFailedResult {
  /** Goal status after planner failure. */
  readonly status: 'failed';
  /** Redacted planner error message. */
  readonly errorMessage: string;
  /** Durable status item explaining the failure. */
  readonly errorItem: GoalPlanItem;
}

/**
 * Result of one Goal Mode planning run.
 */
export type GoalPlanResult =
  | GoalPlanAwaitingApprovalResult
  | GoalPlanAwaitingUserResult
  | GoalPlanFailedResult;

/**
 * Creates a reviewable plan item or human-input gate for one goal.
 *
 * @param input Planning input and effect dependencies.
 * @returns Planning result with the updated goal state reflected in storage.
 * @throws Error when the goal does not exist in the requested scope.
 */
export async function createGoalPlan(input: CreateGoalPlanInput): Promise<GoalPlanResult> {
  const goal = requirePlanningGoal(
    input.workspaceDb,
    input.workspaceId,
    input.threadId,
    input.goalId
  );
  const ids = goalPlanCreationIds(input);
  const turn = input.store.createTurn(
    input.workspaceId,
    input.threadId,
    `Plan goal: ${goal.title}`,
    null,
    { turnId: ids.turnId }
  );
  const timestamp = turn.startedAt ?? new Date().toISOString();

  let plan: GoalPlanOutput;
  try {
    plan = await runGoalPlanner(input.planner, goal);
  } catch {
    const errorMessage = 'Goal planner failed.';
    const errorItem = input.store.createItem({
      id: ids.errorItemId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId: turn.id,
      type: 'status',
      status: 'failed',
      causationId: input.requestId,
      level: 'error',
      title: 'Goal planning failed',
      summary: errorMessage,
      createdAt: timestamp,
      completedAt: timestamp,
    });

    input.store.updateTurn(turn.id, {
      status: 'failed',
      error: {
        code: 'goal_planner_failed',
        message: errorMessage,
      },
      completedAt: timestamp,
      durationMs: 0,
    });
    updateGoalStatus(input.workspaceDb, {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      goalId: goal.goalId,
      status: 'failed',
      terminalStopReason: 'error',
    });

    return { status: 'failed', errorMessage, errorItem };
  }

  if (plan.questions.length > 0) {
    const questionItem = input.store.createItem({
      id: ids.questionItemId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId: turn.id,
      type: 'user-input-request',
      status: 'in_progress',
      causationId: input.requestId,
      userInputRequestId: ids.userInputRequestId,
      prompt: 'Goal planning needs more information.',
      questions: plan.questions.slice(0, 5).map((question, index) => ({
        id: `plan_question_${index + 1}`,
        header: `Question ${index + 1}`,
        question,
        options: null,
        isOther: true,
        isSecret: false,
      })),
      createdAt: timestamp,
      completedAt: null,
    });

    input.store.updateTurn(turn.id, {
      status: 'awaiting_human',
      humanGate: {
        kind: 'user-input',
        userInputRequestId: ids.userInputRequestId,
        itemId: questionItem.id,
      },
    });
    updateGoalStatus(input.workspaceDb, {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      goalId: goal.goalId,
      status: 'awaiting_user',
    });

    return { status: 'awaiting_user', plan, questionItem };
  }

  const planItem = input.store.createItem({
    id: ids.planItemId,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    turnId: turn.id,
    type: 'plan',
    status: 'completed',
    causationId: input.requestId,
    title: goal.title,
    summary: plan.goalSummary,
    steps: plan.tasks.map((task) => ({
      id: task.taskId,
      title: task.title,
      status: 'pending',
    })),
    createdAt: timestamp,
    completedAt: timestamp,
  });

  input.store.updateTurn(turn.id, {
    status: 'completed',
    completedAt: timestamp,
    durationMs: 0,
  });
  const storePlanAuthority = input.workspaceDb.sqlite.transaction(() => {
    const current = getGoalRecord(
      input.workspaceDb,
      input.workspaceId,
      input.threadId,
      input.goalId
    );
    if (current?.status !== 'planning' || current.planItemId !== null) {
      throw new GoalPlanApprovalError(
        'recovery_required',
        'Goal Plan creation lost the planning transition fence.'
      );
    }
    createGoalPlanRecord(input.workspaceDb, {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      goalId: goal.goalId,
      planItemId: planItem.id,
      plan,
      createdByRequestId: input.requestId,
      now: () => timestamp,
    });
    updateGoalStatus(input.workspaceDb, {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      goalId: goal.goalId,
      status: 'awaiting_plan_approval',
      planItemId: planItem.id,
    });
  });
  storePlanAuthority();

  return { status: 'awaiting_plan_approval', plan, planItem };
}

/**
 * Reads the exact durable owners of one Goal Plan creation request.
 *
 * @param input Request scope and owner stores, without a mutable Goal selection.
 * @returns Complete approvable Plan owners, or null when the request has no effect.
 * @throws GoalPlanApprovalError when the request has partial or non-approvable owners.
 */
export function readGoalPlanCreation(
  input: Omit<CreateGoalPlanInput, 'goalId' | 'planner'>
): (GoalPlanAwaitingApprovalResult & { readonly goalId: string }) | null {
  const ids = goalPlanCreationIds(input);
  const turn = input.store
    .listThreadTurns(input.workspaceId, input.threadId)
    .find((candidate) => candidate.id === ids.turnId);
  const items = input.store.listThreadItems(input.workspaceId, input.threadId);
  const planItem = items.find((candidate) => candidate.id === ids.planItemId);
  const questionItem = items.find((candidate) => candidate.id === ids.questionItemId);
  const errorItem = items.find((candidate) => candidate.id === ids.errorItemId);
  let plan: ReturnType<typeof getGoalPlanRecord>;
  try {
    plan = getGoalPlanRecord(input.workspaceDb, input.workspaceId, input.threadId, ids.planItemId);
  } catch {
    throw new GoalPlanApprovalError(
      'recovery_required',
      'Goal Plan creation authority failed its durable digest check.'
    );
  }

  if (!turn && !planItem && !questionItem && !errorItem && !plan) {
    return null;
  }
  if (
    !turn ||
    turn.status !== 'completed' ||
    !turn.completedAt ||
    !planItem ||
    planItem.turnId !== turn.id ||
    planItem.type !== 'plan' ||
    planItem.status !== 'completed' ||
    !planItem.completedAt ||
    planItem.causationId !== input.requestId ||
    questionItem ||
    errorItem ||
    !plan ||
    plan.planItemId !== planItem.id ||
    plan.createdByRequestId !== input.requestId
  ) {
    throw new GoalPlanApprovalError(
      'recovery_required',
      'Goal Plan creation owners are incomplete or cannot be acknowledged.'
    );
  }

  const goal = getGoalRecord(input.workspaceDb, input.workspaceId, input.threadId, plan.goalId);
  const exactSteps =
    planItem.steps?.length === plan.tasks.length &&
    plan.tasks.every((task, index) => {
      const step = planItem.steps?.[index];
      return step?.id === task.taskId && step.title === task.title && step.status === 'pending';
    });
  if (
    !goal ||
    planItem.title !== goal.title ||
    planItem.summary !== plan.goalSummary ||
    !exactSteps
  ) {
    throw new GoalPlanApprovalError(
      'recovery_required',
      'Goal Plan creation lineage or visible Plan projection is contradictory.'
    );
  }

  return {
    goalId: goal.goalId,
    status: 'awaiting_plan_approval',
    plan: selectGoalPlanPayload(plan),
    planItem,
  };
}

/**
 * Reads a goal for planning or throws a scoped error.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @param threadId Thread id.
 * @param goalId Goal id.
 * @returns Stored goal record.
 * @throws Error when the goal is missing.
 */
function requirePlanningGoal(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  threadId: string,
  goalId: string
): GoalRecord {
  const goal = getGoalRecord(workspaceDb, workspaceId, threadId, goalId);

  if (!goal) {
    throw new Error(`Goal not found: ${workspaceId}/${threadId}/${goalId}`);
  }

  return goal;
}

/**
 * Derives deterministic planning owner ids from one immutable command identity.
 *
 * @param input Planning request scope and authenticated store owner.
 * @returns Request-owned Turn, Item, and gate ids.
 */
function goalPlanCreationIds(input: Omit<CreateGoalPlanInput, 'goalId' | 'planner'>): {
  readonly turnId: string;
  readonly planItemId: string;
  readonly questionItemId: string;
  readonly errorItemId: string;
  readonly userInputRequestId: string;
} {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        'goal.plan',
        input.store.getUserId(),
        input.workspaceId,
        input.threadId,
        input.requestId,
      ])
    )
    .digest('hex')
    .slice(0, 24);
  const turnId = `tu_goal_plan_${digest}`;
  return {
    turnId,
    planItemId: `it_goal_plan_${turnId}`,
    questionItemId: `it_goal_plan_questions_${turnId}`,
    errorItemId: `it_goal_plan_error_${turnId}`,
    userInputRequestId: `ui_goal_plan_questions_${turnId}`,
  };
}

/**
 * Runs the injected planner or deterministic fallback through one validation path.
 *
 * @param planner Optional planner effect.
 * @param goal Goal to plan.
 * @returns Validated plan output.
 */
async function runGoalPlanner(
  planner: GoalPlanner | undefined,
  goal: GoalRecord
): Promise<GoalPlanOutput> {
  const plan =
    planner?.({ goal }) ??
    createDeterministicGoalPlanFallback({
      goalTitle: goal.title,
      objective: goal.objective,
    });

  return GoalPlanOutputSchema.parse(await plan);
}

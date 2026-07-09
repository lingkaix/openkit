import type { FsStore } from '../lib/store.js';
import type { WorkspaceDb } from '../storage/db.js';
import {
  createDeterministicGoalPlanFallback,
  type GoalPlanOutput,
  GoalPlanOutputSchema,
} from './goal-plan.js';
import { type GoalRecord, getGoalRecord, updateGoalStatus } from './goal-store.js';

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
  const turn = input.store.createTurn(
    input.workspaceId,
    input.threadId,
    `Plan goal: ${goal.title}`
  );
  const timestamp = turn.startedAt ?? new Date().toISOString();

  try {
    const plan = await runGoalPlanner(input.planner, goal);

    if (plan.questions.length > 0) {
      const questionItem = input.store.createItem({
        id: `it_goal_plan_questions_${goal.goalId}`,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        turnId: turn.id,
        type: 'user-input-request',
        status: 'in_progress',
        userInputRequestId: `ui_goal_plan_questions_${goal.goalId}`,
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
          userInputRequestId: `ui_goal_plan_questions_${goal.goalId}`,
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
      id: `it_goal_plan_${goal.goalId}`,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId: turn.id,
      type: 'plan',
      status: 'completed',
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
    updateGoalStatus(input.workspaceDb, {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      goalId: goal.goalId,
      status: 'awaiting_plan_approval',
      planItemId: planItem.id,
    });

    return { status: 'awaiting_plan_approval', plan, planItem };
  } catch {
    const errorMessage = 'Goal planner failed.';
    const errorItem = input.store.createItem({
      id: `it_goal_plan_error_${goal.goalId}`,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId: turn.id,
      type: 'status',
      status: 'failed',
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

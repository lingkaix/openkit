import type { FsStore } from '../lib/store.js';
import type { WorkspaceDb } from '../storage/db.js';
import { type GoalPlanOutput, GoalPlanOutputSchema } from './goal-plan.js';
import { updateGoalStatus } from './goal-store.js';

type GoalPlanApprovalItem = ReturnType<FsStore['createItem']>;

/**
 * Input for approving one Goal Mode plan.
 */
export interface ApproveGoalPlanInput {
  /** Open workspace-scope database handle. */
  readonly workspaceDb: WorkspaceDb;
  /** Workspace that owns the goal. */
  readonly workspaceId: string;
  /** Thread that owns the goal. */
  readonly threadId: string;
  /** Goal being approved. */
  readonly goalId: string;
  /** Durable plan item id to link from the goal. */
  readonly planItemId: string;
  /** Validated plan output being approved. */
  readonly plan: GoalPlanOutput;
}

/**
 * Input for requesting one Goal Mode plan revision.
 */
export interface ReviseGoalPlanInput {
  /** Open workspace-scope database handle. */
  readonly workspaceDb: WorkspaceDb;
  /** App-local durable store. */
  readonly store: FsStore;
  /** Workspace that owns the goal. */
  readonly workspaceId: string;
  /** Thread that owns the goal. */
  readonly threadId: string;
  /** Goal being revised. */
  readonly goalId: string;
  /** Caller request id used to make revision items idempotent. */
  readonly requestId?: string | undefined;
  /** User revision request text. */
  readonly revision: string;
}

/**
 * Result returned after approving one plan.
 */
export interface ApproveGoalPlanResult {
  /** Approval result status. */
  readonly status: 'approved';
  /** Ready task summaries derived from the approved plan. */
  readonly readyTasks: readonly { readonly taskId: string; readonly status: 'ready' }[];
  /** True only when a worker turn was started by this helper. */
  readonly startsWorkerTurn: false;
}

/**
 * Result returned after requesting one plan revision.
 */
export interface ReviseGoalPlanResult {
  /** Goal status after revision request. */
  readonly status: 'planning';
  /** Durable user-message item containing the revision request. */
  readonly revisionItem: GoalPlanApprovalItem;
  /** True only when a worker turn was started by this helper. */
  readonly startsWorkerTurn: false;
}

/**
 * Approves one plan and derives ready task state without starting a worker.
 *
 * @param input Plan approval input.
 * @returns Ready task state derived from the approved plan.
 */
export function approveGoalPlan(input: ApproveGoalPlanInput): ApproveGoalPlanResult {
  const plan = GoalPlanOutputSchema.parse(input.plan);

  updateGoalStatus(input.workspaceDb, {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    goalId: input.goalId,
    status: 'running',
    planItemId: input.planItemId,
  });

  return {
    status: 'approved',
    readyTasks: plan.tasks.map((task) => ({ taskId: task.taskId, status: 'ready' })),
    startsWorkerTurn: false,
  };
}

/**
 * Records one plan revision request and returns the goal to planning.
 *
 * @param input Plan revision input.
 * @returns Revision result and durable user-message item.
 */
export function reviseGoalPlan(input: ReviseGoalPlanInput): ReviseGoalPlanResult {
  const turn = input.store.createTurn(input.workspaceId, input.threadId, 'Revise goal plan');
  const timestamp = turn.startedAt ?? new Date().toISOString();
  const revisionId = input.requestId ?? input.goalId;
  const revisionItem = input.store.createItem({
    id: `it_goal_plan_revision_${revisionId}`,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    turnId: turn.id,
    type: 'user-message',
    status: 'completed',
    text: input.revision,
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
    goalId: input.goalId,
    status: 'planning',
    planItemId: null,
    currentTaskId: null,
    terminalStopReason: null,
  });

  return { status: 'planning', revisionItem, startsWorkerTurn: false };
}

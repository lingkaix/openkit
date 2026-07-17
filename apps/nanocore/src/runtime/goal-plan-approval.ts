import { createHash } from 'node:crypto';

import type { FsStore } from '../lib/store.js';
import type { WorkspaceDb } from '../storage/db.js';
import { assertValidGoalPlanGraph, selectGoalPlanPayload } from './goal-plan.js';
import { getGoalPlanRecord, getGoalRecord, listGoalTasks, updateGoalStatus } from './goal-store.js';
import { persistApprovedGoalTasks } from './goal-task-persistence.js';

/** User-message Item that owns one Goal Plan revision request. */
type GoalPlanRevisionItem = Extract<
  ReturnType<FsStore['createItem']>,
  { readonly type: 'user-message' }
>;

/** Stable failure codes for Goal Plan approval authority checks. */
export type GoalPlanApprovalErrorCode = 'stale' | 'recovery_required' | 'goal_plan_invalid';

/** Error raised when Goal Plan approval cannot safely mutate authority state. */
export class GoalPlanApprovalError extends Error {
  /** Stable API error code. */
  public readonly code: GoalPlanApprovalErrorCode;
  /** HTTP response status. */
  public readonly status: 400 | 409;

  /**
   * Creates one Goal Plan approval error.
   *
   * @param code Stable failure code.
   * @param message Product-safe failure message.
   */
  public constructor(code: GoalPlanApprovalErrorCode, message: string) {
    super(message);
    this.name = 'GoalPlanApprovalError';
    this.code = code;
    this.status = code === 'goal_plan_invalid' ? 400 : 409;
  }
}

/**
 * Input for approving one Goal Mode plan.
 */
export interface ApproveGoalPlanInput {
  /** Open workspace-scope database handle. */
  readonly workspaceDb: WorkspaceDb;
  /** App-local store that owns the visible Plan Item projection. */
  readonly store: FsStore;
  /** Workspace that owns the goal. */
  readonly workspaceId: string;
  /** Thread that owns the goal. */
  readonly threadId: string;
  /** Goal being approved. */
  readonly goalId: string;
  /** Durable plan item id to link from the goal. */
  readonly planItemId: string;
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
  /** Immutable Plan Item that the revision replaces. */
  readonly planItemId: string;
  /** Caller request id used to make revision items idempotent. */
  readonly requestId: string;
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
  /** Goal whose Plan was revised. */
  readonly goalId: string;
  /** Durable user-message item containing the revision request. */
  readonly revisionItem: GoalPlanRevisionItem;
}

/**
 * Input for reading one request-owned Goal Plan revision effect.
 */
type ReadGoalPlanRevisionInput = Omit<ReviseGoalPlanInput, 'goalId' | 'planItemId' | 'revision'>;

/**
 * Approves one plan and derives ready task state without starting a worker.
 *
 * @param input Plan approval input.
 * @returns Ready task state derived from the approved plan.
 * @throws Error when the active Plan authority or its Item projection is invalid.
 */
export function approveGoalPlan(input: ApproveGoalPlanInput): ApproveGoalPlanResult {
  const goal = getGoalRecord(input.workspaceDb, input.workspaceId, input.threadId, input.goalId);
  if (!goal || goal.planItemId !== input.planItemId) {
    throw new GoalPlanApprovalError('stale', 'Goal Plan is not the active approval authority.');
  }
  if (goal.status !== 'awaiting_plan_approval') {
    throw new GoalPlanApprovalError(
      'recovery_required',
      'Goal Plan approval state is complete or contradictory without this command receipt.'
    );
  }
  let plan: ReturnType<typeof getGoalPlanRecord>;
  try {
    plan = getGoalPlanRecord(
      input.workspaceDb,
      input.workspaceId,
      input.threadId,
      input.planItemId
    );
  } catch {
    throw new GoalPlanApprovalError(
      'recovery_required',
      'Goal Plan authority failed its durable digest check.'
    );
  }
  if (!plan || plan.goalId !== input.goalId) {
    throw new GoalPlanApprovalError(
      'recovery_required',
      'Goal Plan authority is missing or belongs to another Goal.'
    );
  }
  const planItem = input.store
    .listThreadItems(input.workspaceId, input.threadId)
    .find((item) => item.id === input.planItemId);
  if (!planItem || planItem.type !== 'plan') {
    throw new GoalPlanApprovalError(
      'recovery_required',
      'Goal Plan Item projection is missing or has invalid lineage.'
    );
  }
  if (
    listGoalTasks(input.workspaceDb, {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      goalId: input.goalId,
    }).length > 0
  ) {
    throw new GoalPlanApprovalError(
      'recovery_required',
      'Goal Plan approval found a partial or contradictory Task set.'
    );
  }
  try {
    assertValidGoalPlanGraph(plan.tasks);
  } catch (error) {
    throw new GoalPlanApprovalError('goal_plan_invalid', (error as Error).message);
  }

  const approve = input.workspaceDb.sqlite.transaction((): ApproveGoalPlanResult => {
    const { tasks } = persistApprovedGoalTasks({
      workspaceDb: input.workspaceDb,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      goalId: input.goalId,
      planItemId: input.planItemId,
      plan: selectGoalPlanPayload(plan),
    });
    updateGoalStatus(input.workspaceDb, {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      goalId: input.goalId,
      status: 'running',
      planItemId: input.planItemId,
      currentTaskId: null,
      terminalStopReason: null,
    });
    return {
      status: 'approved',
      readyTasks: tasks
        .filter((task) => task.status === 'ready')
        .map((task) => ({ taskId: task.taskId, status: 'ready' as const })),
      startsWorkerTurn: false,
    };
  });

  return approve();
}

/**
 * Records one plan revision request and returns the goal to planning.
 *
 * @param input Plan revision input.
 * @returns Revision result and durable user-message item.
 */
export function reviseGoalPlan(input: ReviseGoalPlanInput): ReviseGoalPlanResult {
  const goal = getGoalRecord(input.workspaceDb, input.workspaceId, input.threadId, input.goalId);
  if (!goal || goal.planItemId !== input.planItemId) {
    throw new GoalPlanApprovalError('stale', 'Goal Plan is not the active revision authority.');
  }
  if (goal.status !== 'awaiting_plan_approval') {
    throw new GoalPlanApprovalError(
      'recovery_required',
      'Goal Plan revision state is complete or contradictory without this command receipt.'
    );
  }
  let plan: ReturnType<typeof getGoalPlanRecord>;
  try {
    plan = getGoalPlanRecord(
      input.workspaceDb,
      input.workspaceId,
      input.threadId,
      input.planItemId
    );
  } catch {
    throw new GoalPlanApprovalError(
      'recovery_required',
      'Goal Plan revision authority failed its durable digest check.'
    );
  }
  const planItem = input.store
    .listThreadItems(input.workspaceId, input.threadId)
    .find((candidate) => candidate.id === input.planItemId);
  if (
    !plan ||
    plan.goalId !== input.goalId ||
    !planItem ||
    planItem.type !== 'plan' ||
    planItem.status !== 'completed'
  ) {
    throw new GoalPlanApprovalError(
      'recovery_required',
      'Goal Plan revision authority is missing or has invalid lineage.'
    );
  }

  const ids = goalPlanRevisionIds(input);
  const turn = input.store.createTurn(input.workspaceId, input.threadId, 'Revise goal plan', null, {
    turnId: ids.turnId,
  });
  const timestamp = turn.startedAt ?? new Date().toISOString();
  const revisionItem = input.store.createItem({
    id: ids.itemId,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    turnId: turn.id,
    type: 'user-message',
    status: 'completed',
    parentItemId: input.planItemId,
    causationId: input.requestId,
    text: input.revision,
    createdAt: timestamp,
    completedAt: timestamp,
  }) as GoalPlanRevisionItem;

  input.store.updateTurn(turn.id, {
    status: 'completed',
    completedAt: timestamp,
    durationMs: 0,
  });
  const transition = input.workspaceDb.sqlite.transaction(() => {
    const current = getGoalRecord(
      input.workspaceDb,
      input.workspaceId,
      input.threadId,
      input.goalId
    );
    if (current?.status !== 'awaiting_plan_approval' || current.planItemId !== input.planItemId) {
      return false;
    }
    updateGoalStatus(input.workspaceDb, {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      goalId: input.goalId,
      status: 'planning',
      planItemId: null,
      currentTaskId: null,
      terminalStopReason: null,
    });
    return true;
  });
  let transitioned = false;
  try {
    transitioned = transition();
  } catch {
    throw new GoalPlanApprovalError(
      'recovery_required',
      'Goal Plan revision could not commit its active Plan transition.'
    );
  }
  if (!transitioned) {
    throw new GoalPlanApprovalError(
      'recovery_required',
      'Goal Plan revision lost the active Plan transition fence.'
    );
  }

  return {
    goalId: input.goalId,
    revisionItem,
  };
}

/**
 * Reads and validates the exact durable owners of one Goal Plan revision request.
 *
 * @param input Request identity and owner stores.
 * @returns Complete revision owners, or null when the command has no effect.
 * @throws GoalPlanApprovalError when only a partial or contradictory owner tuple exists.
 */
export function readGoalPlanRevision(
  input: ReadGoalPlanRevisionInput
): ReviseGoalPlanResult | null {
  const ids = goalPlanRevisionIds(input);
  const turn = input.store
    .listThreadTurns(input.workspaceId, input.threadId)
    .find((candidate) => candidate.id === ids.turnId);
  const threadItems = input.store.listThreadItems(input.workspaceId, input.threadId);
  const revisionItem = threadItems.find((candidate) => candidate.id === ids.itemId);

  if (!turn && !revisionItem) {
    return null;
  }
  if (
    !turn ||
    !revisionItem ||
    turn.status !== 'completed' ||
    !turn.completedAt ||
    revisionItem.turnId !== turn.id ||
    revisionItem.type !== 'user-message' ||
    revisionItem.status !== 'completed' ||
    !revisionItem.completedAt ||
    revisionItem.causationId !== input.requestId ||
    !revisionItem.parentItemId
  ) {
    throw new GoalPlanApprovalError(
      'recovery_required',
      'Goal Plan revision owners are incomplete or contradictory.'
    );
  }

  let plan: ReturnType<typeof getGoalPlanRecord>;
  try {
    plan = getGoalPlanRecord(
      input.workspaceDb,
      input.workspaceId,
      input.threadId,
      revisionItem.parentItemId
    );
  } catch {
    throw new GoalPlanApprovalError(
      'recovery_required',
      'Goal Plan revision lineage failed its durable digest check.'
    );
  }
  const goal = plan
    ? getGoalRecord(input.workspaceDb, input.workspaceId, input.threadId, plan.goalId)
    : null;
  const planItem = threadItems.find((candidate) => candidate.id === revisionItem.parentItemId);
  if (
    !plan ||
    !goal ||
    goal.planItemId === plan.planItemId ||
    !planItem ||
    planItem.type !== 'plan' ||
    planItem.status !== 'completed'
  ) {
    throw new GoalPlanApprovalError(
      'recovery_required',
      'Goal Plan revision lineage is missing or its Goal transition is incomplete.'
    );
  }
  return {
    goalId: goal.goalId,
    revisionItem,
  };
}

/**
 * Derives collision-resistant Turn and Item ids from one immutable revision command identity.
 *
 * @param input Revision request scope and authenticated store owner.
 * @returns Deterministic revision owner ids.
 */
function goalPlanRevisionIds(input: ReadGoalPlanRevisionInput): {
  readonly turnId: string;
  readonly itemId: string;
} {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        'goal.plan.revise',
        input.store.getUserId(),
        input.workspaceId,
        input.threadId,
        input.requestId,
      ])
    )
    .digest('hex')
    .slice(0, 24);
  return {
    turnId: `tu_goal_plan_revision_${digest}`,
    itemId: `it_goal_plan_revision_${digest}`,
  };
}

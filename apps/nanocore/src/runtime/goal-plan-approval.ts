import { createHash } from 'node:crypto';

import type { ActorRef } from '@openkit/protocol';

import type { FsStore } from '../lib/store.js';
import type { WorkspaceDb } from '../storage/db.js';
import {
  assertGoalPlanTaskDispositions,
  assertValidGoalPlanGraph,
  goalPlanItemSummary,
  selectGoalPlanPayload,
} from './goal-plan.js';
import {
  assertGoalPlanCompletedResultTreatment,
  captureGoalTaskEvidenceSnapshot,
  goalPlanSourceEvidenceDigest,
  resolveGoalPlanResourceEvidence,
} from './goal-source-evidence.js';
import {
  getGoalPlanRecord,
  getGoalRecord,
  isTerminalGoalStatus,
  listGoalTasks,
  updateGoalStatus,
} from './goal-store.js';
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
  /** Authenticated actor that owns the command identity. */
  readonly triggerActor: ActorRef;
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
function validateGoalPlanApproval(input: ApproveGoalPlanInput) {
  const goal = getGoalRecord(input.workspaceDb, input.workspaceId, input.threadId, input.goalId);
  if (!goal || goal.pendingPlanItemId !== input.planItemId) {
    throw new GoalPlanApprovalError('stale', 'Goal Plan is not the pending approval authority.');
  }
  if (isTerminalGoalStatus(goal.status)) {
    throw new GoalPlanApprovalError(
      'recovery_required',
      'Goal Plan approval state is terminal or contradictory without this command receipt.'
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
  if (plan.sourceIntentItemId !== goal.currentIntentItemId) {
    throw new GoalPlanApprovalError('stale', 'Pending Goal Plan addresses an older Goal intent.');
  }
  if (goal.planItemId) {
    let predecessorId = plan.predecessorPlanItemId;
    const visited = new Set<string>();
    while (predecessorId && predecessorId !== goal.planItemId && !visited.has(predecessorId)) {
      visited.add(predecessorId);
      const predecessor = getGoalPlanRecord(
        input.workspaceDb,
        input.workspaceId,
        input.threadId,
        predecessorId
      );
      if (
        !predecessor ||
        predecessor.goalId !== goal.goalId ||
        predecessor.sourceIntentItemId !== goal.currentIntentItemId
      )
        break;
      predecessorId = predecessor.predecessorPlanItemId;
    }
    if (predecessorId !== goal.planItemId) {
      throw new GoalPlanApprovalError('stale', 'Pending Goal Plan has an older predecessor.');
    }
  }
  if (!goal.planItemId && plan.predecessorPlanItemId) {
    const predecessor = getGoalPlanRecord(
      input.workspaceDb,
      input.workspaceId,
      input.threadId,
      plan.predecessorPlanItemId
    );
    if (
      !predecessor ||
      predecessor.goalId !== goal.goalId ||
      predecessor.sourceIntentItemId !== goal.currentIntentItemId
    ) {
      throw new GoalPlanApprovalError(
        'stale',
        'Pending Goal Plan has an invalid pre-approval predecessor.'
      );
    }
  }
  if (goal.planItemId) {
    if (goal.currentTaskId !== null) {
      throw new GoalPlanApprovalError(
        'stale',
        'A running Task must reach a safe point before Plan activation.'
      );
    }
    if (!plan.sourceTaskEvidenceDigest) {
      throw new GoalPlanApprovalError(
        'recovery_required',
        'Pending successor has no source Task snapshot.'
      );
    }
    let currentSnapshot: ReturnType<typeof captureGoalTaskEvidenceSnapshot>;
    try {
      currentSnapshot = captureGoalTaskEvidenceSnapshot(input.store, input.workspaceDb, {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        goalId: input.goalId,
        planItemId: goal.planItemId,
      });
    } catch {
      throw new GoalPlanApprovalError(
        'recovery_required',
        'Pending successor source Task or Review evidence is missing or contradictory.'
      );
    }
    let resources: ReturnType<typeof resolveGoalPlanResourceEvidence>;
    try {
      resources = resolveGoalPlanResourceEvidence(
        input.store,
        input.workspaceDb,
        {
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          goalId: input.goalId,
          planItemId: goal.planItemId,
        },
        plan,
        currentSnapshot
      );
    } catch {
      throw new GoalPlanApprovalError(
        'stale',
        'Pending successor resource evidence changed after proposal.'
      );
    }
    if (
      plan.sourceTaskEvidenceDigest !== goalPlanSourceEvidenceDigest(currentSnapshot, resources)
    ) {
      throw new GoalPlanApprovalError(
        'stale',
        'Pending successor was drafted from an older Task or evidence snapshot.'
      );
    }
    try {
      assertGoalPlanTaskDispositions(plan, currentSnapshot.facts);
      assertGoalPlanCompletedResultTreatment(plan, currentSnapshot);
    } catch (error) {
      throw new GoalPlanApprovalError('goal_plan_invalid', (error as Error).message);
    }
  } else if (plan.sourceTaskEvidenceDigest !== null) {
    throw new GoalPlanApprovalError(
      'recovery_required',
      'Initial Goal Plan has unexpected Task evidence.'
    );
  } else {
    try {
      assertGoalPlanTaskDispositions(plan, []);
    } catch (error) {
      throw new GoalPlanApprovalError('goal_plan_invalid', (error as Error).message);
    }
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
  if (!planItem.summary?.startsWith(`${goalPlanItemSummary(plan)}\nProposal reason: `)) {
    throw new GoalPlanApprovalError(
      'recovery_required',
      'Goal Plan Item omits its predecessor disposition proof.'
    );
  }
  const historicalTasks = listGoalTasks(input.workspaceDb, {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    goalId: input.goalId,
  });
  if (historicalTasks.some((task) => task.planItemId === input.planItemId)) {
    throw new GoalPlanApprovalError('recovery_required', 'Pending Goal Plan already has Tasks.');
  }
  const historicalTaskIds = new Set(historicalTasks.map((task) => task.taskId));
  if (plan.tasks.some((task) => historicalTaskIds.has(task.taskId))) {
    throw new GoalPlanApprovalError(
      'goal_plan_invalid',
      'Goal Plan Task ids must be unique across the Goal.'
    );
  }
  try {
    assertValidGoalPlanGraph(plan.tasks);
  } catch (error) {
    throw new GoalPlanApprovalError('goal_plan_invalid', (error as Error).message);
  }

  return { goal, plan };
}

/** Reports whether the exact pending candidate passes the same pre-mutation approval checks. */
export function canApproveGoalPlan(input: ApproveGoalPlanInput): boolean {
  try {
    validateGoalPlanApproval(input);
    return true;
  } catch (error) {
    if (error instanceof GoalPlanApprovalError) return false;
    throw error;
  }
}

/** Approves one exact validated Plan and creates only its newly authorized Tasks. */
export function approveGoalPlan(input: ApproveGoalPlanInput): ApproveGoalPlanResult {
  const { goal, plan } = validateGoalPlanApproval(input);
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
      status: goal.planItemId ? goal.status : 'running',
      planItemId: input.planItemId,
      pendingPlanItemId: null,
      currentAffectedTaskIds: [],
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
 * Records one plan revision request against the intact active Plan pointer.
 *
 * @param input Plan revision input.
 * @returns Revision result and durable user-message item.
 */
export function reviseGoalPlan(input: ReviseGoalPlanInput): ReviseGoalPlanResult {
  const goal = getGoalRecord(input.workspaceDb, input.workspaceId, input.threadId, input.goalId);
  if (
    !goal ||
    (goal.pendingPlanItemId !== input.planItemId &&
      !(
        goal.planItemId === input.planItemId &&
        (goal.pendingPlanItemId === null ||
          getGoalPlanRecord(
            input.workspaceDb,
            input.workspaceId,
            input.threadId,
            goal.pendingPlanItemId
          )?.sourceIntentItemId !== goal.currentIntentItemId)
      ))
  ) {
    throw new GoalPlanApprovalError('stale', 'Goal Plan is not the current revision predecessor.');
  }
  if (isTerminalGoalStatus(goal.status)) {
    throw new GoalPlanApprovalError(
      'recovery_required',
      'Goal Plan revision state is terminal or contradictory without this command receipt.'
    );
  }
  if (
    hasInFlightGoalPlanRevisionRequest(
      input.store,
      input.workspaceId,
      input.threadId,
      input.planItemId
    )
  ) {
    throw new GoalPlanApprovalError(
      'recovery_required',
      'A revision-request Item already exists for the active Plan.'
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
  const turn = input.store.createTurn(
    input.workspaceId,
    input.threadId,
    'Revise goal plan',
    input.triggerActor,
    null,
    { turnId: ids.turnId }
  );
  const timestamp = turn.startedAt ?? new Date().toISOString();
  const revisionItem = input.store.createItem({
    id: ids.itemId,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    turnId: turn.id,
    type: 'user-message',
    status: 'completed',
    actor: input.triggerActor,
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
    return (
      current !== null &&
      !isTerminalGoalStatus(current.status) &&
      (current.pendingPlanItemId === input.planItemId ||
        (current.pendingPlanItemId === null && current.planItemId === input.planItemId))
    );
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
    JSON.stringify(turn.triggerActor) !== JSON.stringify(input.triggerActor) ||
    revisionItem.turnId !== turn.id ||
    revisionItem.type !== 'user-message' ||
    revisionItem.status !== 'completed' ||
    JSON.stringify(revisionItem.actor) !== JSON.stringify(input.triggerActor) ||
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
  if (!plan || !goal || !planItem || planItem.type !== 'plan' || planItem.status !== 'completed') {
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
 * Returns whether a completed revision-request Item already names this Plan pointer.
 *
 * @param store App-local durable store.
 * @param workspaceId Workspace that owns the Thread.
 * @param threadId Thread that owns the Goal.
 * @param planItemId Active Plan Item the revision would replace.
 * @returns True when an in-flight revision-request Item exists for that pointer.
 */
function hasInFlightGoalPlanRevisionRequest(
  store: FsStore,
  workspaceId: string,
  threadId: string,
  planItemId: string
): boolean {
  const latest = store
    .listThreadItems(workspaceId, threadId)
    .filter(
      (item) =>
        item.type === 'user-message' &&
        item.status === 'completed' &&
        item.parentItemId === planItemId &&
        typeof item.text === 'string' &&
        item.text.trim().length > 0
    )
    .at(-1);
  if (!latest) return false;
  const turns = store.listThreadTurns(workspaceId, threadId);
  const instructionIndex = turns.findIndex((turn) => turn.id === latest.turnId);
  if (instructionIndex < 0) return true;
  const latestAttempt = turns
    .slice(instructionIndex + 1)
    .filter((turn) => turn.id.startsWith('tu_goal_plan_'))
    .at(-1);
  return !latestAttempt || !['completed', 'failed', 'interrupted'].includes(latestAttempt.status);
}

/**
 * Derives collision-resistant Turn and Item ids from one immutable revision command identity.
 *
 * @param input Revision request scope and authenticated actor.
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
        input.triggerActor.id,
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

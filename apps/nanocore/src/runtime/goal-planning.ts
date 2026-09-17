import { createHash } from 'node:crypto';

import { type ActorRef, responsibleUserIdForActor } from '@openkit/protocol';

import type { FsStore } from '../lib/store.js';
import type { WorkspaceDb } from '../storage/db.js';
import {
  computeGoalPlanDigest,
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
import type { InflightIdempotentCommand } from './idempotent-command.js';

type GoalPlanItem = ReturnType<FsStore['createItem']>;

/** Stable failure codes for pre-approval Goal Plan revision planning. */
export type GoalPlanRevisionErrorCode =
  | 'goal_plan_revision_unavailable'
  | 'goal_plan_revision_invalid'
  | 'stale'
  | 'recovery_required';

/** Error raised when a pre-approval revision cannot produce a new Plan. */
export class GoalPlanRevisionError extends Error {
  /** Stable API error code. */
  public readonly code: GoalPlanRevisionErrorCode;
  /** HTTP response status. */
  public readonly status: 400 | 409 | 503;

  /**
   * Creates one pre-approval revision planning error.
   *
   * @param code Stable failure code.
   * @param message Product-safe failure message.
   */
  public constructor(code: GoalPlanRevisionErrorCode, message: string) {
    super(message);
    this.name = 'GoalPlanRevisionError';
    this.code = code;
    this.status =
      code === 'goal_plan_revision_unavailable'
        ? 503
        : code === 'goal_plan_revision_invalid'
          ? 400
          : 409;
  }
}

/**
 * Durable pre-approval revision lineage used to assemble one semantic planning Turn.
 */
export interface PreApprovalGoalPlanRevision {
  /** Immutable prior Plan Item id. */
  readonly previousPlanItemId: string;
  /** Exact previous Plan payload. */
  readonly previousPlan: GoalPlanOutput;
  /** Recorded human revision instruction. */
  readonly revisionText: string;
}

/**
 * Planner input for one Goal Mode planning run.
 */
export interface GoalPlannerInput {
  /** Stored goal record to plan. */
  readonly goal: GoalRecord;
  /** Exact previous Plan when this run follows a recorded pre-approval revision. */
  readonly previousPlan?: GoalPlanOutput;
  /** Immutable prior Plan Item id for the recorded revision. */
  readonly previousPlanItemId?: string;
  /** Recorded human revision instruction. */
  readonly revisionText?: string;
}

/**
 * Effect that creates one Goal Mode plan output.
 */
export type GoalPlanner = (input: GoalPlannerInput) => GoalPlanOutput | Promise<GoalPlanOutput>;

/**
 * Input used to create or request a plan for one goal.
 */
export interface CreateGoalPlanInput {
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
  /** Goal to plan. */
  readonly goalId: string;
  /** Request that creates the immutable Plan authority. */
  readonly requestId: string;
  /** Optional planner effect; omitted initial drafts use the deterministic fallback. */
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
 * @throws GoalPlanRevisionError when a recorded revision cannot use the deterministic draft.
 */
export async function createGoalPlan(input: CreateGoalPlanInput): Promise<GoalPlanResult> {
  const goal = requirePlanningGoal(
    input.workspaceDb,
    input.workspaceId,
    input.threadId,
    input.goalId
  );
  const revision =
    goal.status === 'planning' && goal.planItemId === null
      ? readPreApprovalGoalPlanRevision({
          store: input.store,
          workspaceDb: input.workspaceDb,
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          goalId: input.goalId,
        })
      : null;
  const plannerInput: GoalPlannerInput = revision
    ? {
        goal,
        previousPlan: revision.previousPlan,
        previousPlanItemId: revision.previousPlanItemId,
        revisionText: revision.revisionText,
      }
    : { goal };
  const ids = goalPlanCreationIds(input);

  let plan: GoalPlanOutput;
  if (revision) {
    try {
      plan = await runGoalPlanner(input.planner, plannerInput, false);
    } catch (error) {
      if (error instanceof GoalPlanRevisionError) {
        throw error;
      }
      throw new GoalPlanRevisionError(
        'goal_plan_revision_unavailable',
        'Pre-approval Goal Plan revision planner failed.'
      );
    }
    assertApprovableGoalPlanRevision(plan, revision.previousPlan);
  } else {
    const turn = input.store.createTurn(
      input.workspaceId,
      input.threadId,
      `Plan goal: ${goal.title}`,
      input.triggerActor,
      null,
      { turnId: ids.turnId }
    );
    const timestamp = turn.startedAt ?? new Date().toISOString();
    try {
      plan = await runGoalPlanner(input.planner, plannerInput, true);
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
    return persistGoalPlanResult(input, goal, ids, turn, timestamp, plan);
  }

  const turn = input.store.createTurn(
    input.workspaceId,
    input.threadId,
    `Plan goal: ${goal.title}`,
    input.triggerActor,
    null,
    { turnId: ids.turnId }
  );
  const timestamp = turn.startedAt ?? new Date().toISOString();
  return persistGoalPlanResult(input, goal, ids, turn, timestamp, plan);
}

/**
 * Coalesces one Goal Plan requestId and rejects a distinct in-flight request for the same Goal.
 *
 * @param input Process-local inflight map, Goal identity, and the command body.
 * @returns The in-flight or freshly executed result.
 * @throws GoalPlanApprovalError when another Plan request for this Goal is already running.
 */
export async function runExclusiveGoalPlanCommand<T>(input: {
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly store: FsStore;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly actorId: string;
  readonly goalId: string;
  readonly requestId: string;
  readonly run: () => Promise<T>;
}): Promise<T> {
  const lockKey = `goal-plan-admission:${JSON.stringify([
    input.workspaceId,
    input.threadId,
    input.goalId,
  ])}`;
  const commandIdentity = JSON.stringify([input.actorId, input.requestId]);
  let storeInflight = input.inflightCommands.get(input.store);
  if (!storeInflight) {
    storeInflight = new Map<string, InflightIdempotentCommand>();
    input.inflightCommands.set(input.store, storeInflight);
  }
  const existing = storeInflight.get(lockKey);
  if (existing) {
    if (existing.inputHash === commandIdentity) {
      return (await existing.promise) as T;
    }
    throw new GoalPlanApprovalError('stale', 'The Goal already has an in-flight Plan request.');
  }
  const promise = Promise.resolve().then(input.run);
  storeInflight.set(lockKey, { inputHash: commandIdentity, promise });
  try {
    return await promise;
  } finally {
    if (storeInflight.get(lockKey)?.promise === promise) {
      storeInflight.delete(lockKey);
    }
  }
}

/**
 * Asserts that a revised Plan is approvable against the exact previous draft.
 *
 * @param plan Candidate revision Plan.
 * @param previousPlan Exact previous immutable Plan.
 * @throws GoalPlanRevisionError when the Plan has questions or repeats the previous digest.
 */
export function assertApprovableGoalPlanRevision(
  plan: GoalPlanOutput,
  previousPlan: GoalPlanOutput
): void {
  if (plan.questions.length > 0) {
    throw new GoalPlanRevisionError(
      'goal_plan_revision_invalid',
      'Pre-approval Goal Plan revision must propose an approvable draft.'
    );
  }
  if (computeGoalPlanDigest(plan) === computeGoalPlanDigest(previousPlan)) {
    throw new GoalPlanRevisionError(
      'goal_plan_revision_invalid',
      'Pre-approval Goal Plan revision cannot repeat the previous draft.'
    );
  }
}

/**
 * Persists questions or an approvable Plan after a successful planner run.
 *
 * @param input Planning command identity and stores.
 * @param goal Goal being planned.
 * @param ids Request-owned Turn and Item ids.
 * @param turn Created planning Turn.
 * @param timestamp Turn start timestamp.
 * @param plan Validated planner output.
 * @returns Planning result with durable owners.
 */
function persistGoalPlanResult(
  input: CreateGoalPlanInput,
  goal: GoalRecord,
  ids: ReturnType<typeof goalPlanCreationIds>,
  turn: ReturnType<FsStore['createTurn']>,
  timestamp: string,
  plan: GoalPlanOutput
): GoalPlanResult {
  if (plan.questions.length > 0) {
    const responsibleUserId = responsibleUserIdForActor(turn.triggerActor);
    if (responsibleUserId === null) {
      throw new GoalPlanApprovalError(
        'recovery_required',
        'Goal planning cannot assign its human-input responsibility.'
      );
    }
    const questionItem = input.store.createItem({
      id: ids.questionItemId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId: turn.id,
      type: 'user-input-request',
      status: 'completed',
      causationId: input.requestId,
      responsibleUserId,
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
      completedAt: timestamp,
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
    JSON.stringify(turn.triggerActor) !== JSON.stringify(input.triggerActor) ||
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
 * Reads the latest recorded pre-approval Plan revision for one Goal.
 *
 * @param input Goal scope and owner stores.
 * @returns Exact previous Plan and revision instruction, or null when none exists.
 * @throws GoalPlanRevisionError when revision lineage fails its durable digest check.
 */
export function readPreApprovalGoalPlanRevision(input: {
  readonly store: FsStore;
  readonly workspaceDb: WorkspaceDb;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly goalId: string;
}): PreApprovalGoalPlanRevision | null {
  const items = input.store.listThreadItems(input.workspaceId, input.threadId);
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (
      !item ||
      item.type !== 'user-message' ||
      item.status !== 'completed' ||
      !item.parentItemId ||
      typeof item.text !== 'string' ||
      item.text.trim().length === 0
    ) {
      continue;
    }
    let record: ReturnType<typeof getGoalPlanRecord>;
    try {
      record = getGoalPlanRecord(
        input.workspaceDb,
        input.workspaceId,
        input.threadId,
        item.parentItemId
      );
    } catch {
      throw new GoalPlanRevisionError(
        'recovery_required',
        'Pre-approval Goal Plan revision lineage failed its durable digest check.'
      );
    }
    if (!record || record.goalId !== input.goalId) {
      continue;
    }
    return {
      previousPlanItemId: item.parentItemId,
      previousPlan: selectGoalPlanPayload(record),
      revisionText: item.text,
    };
  }
  return null;
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
 * @param input Planning request scope and authenticated actor.
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
        input.triggerActor.id,
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
 * Runs the injected planner or, for an initial draft only, the deterministic fallback.
 *
 * @param planner Optional planner effect.
 * @param input Goal and optional recorded revision lineage.
 * @param allowDeterministicFallback Whether an omitted planner may synthesize the initial draft.
 * @returns Validated plan output.
 * @throws GoalPlanRevisionError when a revision run has no semantic planner.
 */
async function runGoalPlanner(
  planner: GoalPlanner | undefined,
  input: GoalPlannerInput,
  allowDeterministicFallback: boolean
): Promise<GoalPlanOutput> {
  if (!planner) {
    if (!allowDeterministicFallback) {
      throw new GoalPlanRevisionError(
        'goal_plan_revision_unavailable',
        'Pre-approval Goal Plan revision requires an admitted semantic planner.'
      );
    }
    return GoalPlanOutputSchema.parse(
      createDeterministicGoalPlanFallback({
        goalTitle: input.goal.title,
        objective: input.goal.objective,
      })
    );
  }

  return GoalPlanOutputSchema.parse(await planner(input));
}

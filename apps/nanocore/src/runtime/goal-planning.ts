import { createHash } from 'node:crypto';
import { type ActorRef, responsibleUserIdForActor } from '@openkit/protocol';
import { publishedErrorMessage } from '../api-errors.js';

import type { FsStore } from '../lib/store.js';
import { type ModelCaptureContext, withTurnModelCapture } from '../llm/model-capture.js';
import type { WorkspaceDb } from '../storage/db.js';
import {
  assertGoalPlanTaskDispositions,
  computeGoalPlanDigest,
  createDeterministicGoalPlanFallback,
  type GoalPlanOutput,
  GoalPlanOutputSchema,
  goalPlanItemSummary,
  selectGoalPlanPayload,
} from './goal-plan.js';
import { GoalPlanApprovalError } from './goal-plan-approval.js';
import {
  assertGoalPlanCompletedResultTreatment,
  captureGoalTaskEvidenceSnapshot,
  computeGoalTaskEvidenceDigest,
  goalPlanSourceEvidenceDigest,
  resolveGoalPlanResourceEvidence,
} from './goal-source-evidence.js';
import {
  createGoalPlanRecord,
  type GoalRecord,
  getGoalPlanRecord,
  getGoalRecord,
  isTerminalGoalStatus,
  listGoalRecordsForThread,
  listGoalTasks,
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
  /** Immutable instruction Item that admitted this planning revision. */
  readonly revisionItemId: string;
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
  /** Exact persisted planning Turn supplied before any model-based planner effect. */
  readonly capture?: Omit<ModelCaptureContext, 'corr'>;
  /** Stored goal record to plan. */
  readonly goal: GoalRecord;
  /** Exact previous Plan when this run follows a recorded pre-approval revision. */
  readonly previousPlan?: GoalPlanOutput;
  /** Immutable prior Plan Item id for the recorded revision. */
  readonly previousPlanItemId?: string;
  /** Recorded human revision instruction. */
  readonly revisionText?: string;
  /** Exact active-Plan Task and evidence facts fixed before model admission. */
  readonly sourceTaskEvidence?: ReturnType<typeof captureGoalTaskEvidenceSnapshot> | null;
  /** Exact answered planning Gate carried into a fresh model planning Turn. */
  readonly clarification?: {
    readonly requestItemId: string;
    readonly responseItemId: string;
    readonly questions: readonly { readonly id: string; readonly question: string }[];
    readonly answers: Readonly<Record<string, readonly string[]>>;
  } | null;
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
  const revision = readPreApprovalGoalPlanRevision({
    store: input.store,
    workspaceDb: input.workspaceDb,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    goalId: input.goalId,
  });
  let sourceTaskEvidence: ReturnType<typeof captureGoalTaskEvidenceSnapshot> | null = null;
  if (goal.planItemId) {
    try {
      sourceTaskEvidence = captureGoalTaskEvidenceSnapshot(input.store, input.workspaceDb, {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        goalId: input.goalId,
        planItemId: goal.planItemId,
      });
    } catch {
      throw new GoalPlanRevisionError(
        'recovery_required',
        'Goal planning source Task or Review evidence is missing or contradictory.'
      );
    }
  }
  const ids = goalPlanCreationIds(input);
  if (
    input.store
      .listThreadTurns(input.workspaceId, input.threadId)
      .some((candidate) => candidate.id === ids.turnId)
  ) {
    throw new GoalPlanRevisionError(
      'recovery_required',
      'Goal Plan request already has a Turn; inspect its retained result before retrying.'
    );
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
  const plannerInput: GoalPlannerInput = {
    goal,
    sourceTaskEvidence,
    clarification: readLatestGoalPlanningClarification(
      input.store,
      input.workspaceId,
      input.threadId,
      [goal.currentIntentItemId, revision?.previousPlanItemId].filter((id): id is string =>
        Boolean(id)
      ),
      [goal.currentIntentItemId, revision?.revisionItemId].filter((id): id is string => Boolean(id))
    ),
    ...(revision
      ? {
          previousPlan: revision.previousPlan,
          previousPlanItemId: revision.previousPlanItemId,
          revisionText: revision.revisionText,
        }
      : {}),
  };

  let plan: GoalPlanOutput;
  if (revision) {
    try {
      plan = await runGoalPlanner(
        input.planner,
        plannerInput,
        false,
        input.store,
        turn,
        input.workspaceDb
      );
      if (plan.questions.length === 0) {
        assertApprovableGoalPlanRevision(plan, revision.previousPlan);
      }
    } catch (error) {
      input.store.updateTurn(turn.id, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: {
          code: 'goal_plan_revision_failed',
          message: 'Goal Plan revision did not complete.',
        },
      });
      if (error instanceof GoalPlanRevisionError) {
        throw error;
      }
      throw new GoalPlanRevisionError(
        'goal_plan_revision_unavailable',
        'Pre-approval Goal Plan revision planner failed.'
      );
    }
  } else {
    try {
      plan = await runGoalPlanner(
        input.planner,
        plannerInput,
        true,
        input.store,
        turn,
        input.workspaceDb
      );
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
      return { status: 'failed', errorMessage, errorItem };
    }
    try {
      return persistGoalPlanResult(
        input,
        goal,
        ids,
        turn,
        timestamp,
        plan,
        null,
        sourceTaskEvidence
      );
    } catch (error) {
      failUnpublishedPlanningTurn(input.store, turn.id);
      throw error;
    }
  }

  try {
    return persistGoalPlanResult(
      input,
      goal,
      ids,
      turn,
      timestamp,
      plan,
      revision,
      sourceTaskEvidence
    );
  } catch (error) {
    failUnpublishedPlanningTurn(input.store, turn.id);
    throw error;
  }
}

/** Seals a rejected model output when it published neither a Plan nor a question Gate. */
function failUnpublishedPlanningTurn(store: FsStore, turnId: string): void {
  const current = store.getTurnById(turnId);
  if (current.status === 'running' && current.items.length === 0) {
    store.updateTurn(turnId, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: { code: 'goal_plan_output_rejected', message: 'Goal Plan output was rejected.' },
    });
  }
}

/** Reads the last exact answered planning Gate for a new request-bound planning Turn. */
function readLatestGoalPlanningClarification(
  store: FsStore,
  workspaceId: string,
  threadId: string,
  admittedParentItemIds: readonly string[],
  latestInstructionItemIds: readonly string[]
): NonNullable<GoalPlannerInput['clarification']> | null {
  const turns = store.listThreadTurns(workspaceId, threadId);
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn?.items.some((item) => latestInstructionItemIds.includes(item.id))) return null;
    if (!turn?.id.startsWith('tu_goal_plan_')) continue;
    const request = turn.items.find((item) => item.type === 'user-input-request');
    const response = turn.items.find((item) => item.type === 'user-input-response');
    if (
      turn.status === 'completed' &&
      request?.type === 'user-input-request' &&
      response?.type === 'user-input-response' &&
      request.userInputRequestId === response.userInputRequestId &&
      request.parentItemId &&
      admittedParentItemIds.includes(request.parentItemId)
    ) {
      return {
        requestItemId: request.id,
        responseItemId: response.id,
        questions: request.questions.map(({ id, question }) => ({ id, question })),
        answers: response.answers,
      };
    }
    if (turn.status === 'completed' && turn.items.some((item) => item.type === 'plan')) {
      return null;
    }
  }
  return null;
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
 * @param revision Admitted pre-approval revision, or null for initial planning.
 * @returns Planning result with durable owners.
 */
function persistGoalPlanResult(
  input: CreateGoalPlanInput,
  goal: GoalRecord,
  ids: ReturnType<typeof goalPlanCreationIds>,
  turn: ReturnType<FsStore['createTurn']>,
  timestamp: string,
  plan: GoalPlanOutput,
  revision: PreApprovalGoalPlanRevision | null,
  sourceTaskEvidence: ReturnType<typeof captureGoalTaskEvidenceSnapshot> | null
): GoalPlanResult {
  let sourceTaskEvidenceDigest: string | null = null;
  if (plan.questions.length === 0) {
    try {
      assertGoalPlanTaskDispositions(plan, sourceTaskEvidence?.facts ?? []);
      if (sourceTaskEvidence) assertGoalPlanCompletedResultTreatment(plan, sourceTaskEvidence);
      if (sourceTaskEvidence) {
        const resources = resolveGoalPlanResourceEvidence(
          input.store,
          input.workspaceDb,
          {
            workspaceId: input.workspaceId,
            threadId: input.threadId,
            goalId: goal.goalId,
            planItemId: goal.planItemId!,
          },
          plan,
          sourceTaskEvidence
        );
        sourceTaskEvidenceDigest = goalPlanSourceEvidenceDigest(sourceTaskEvidence, resources);
      }
    } catch (error) {
      throw new GoalPlanRevisionError('goal_plan_revision_invalid', publishedErrorMessage(error));
    }
    const historicalTaskIds = new Set(
      listGoalTasks(input.workspaceDb, {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        goalId: goal.goalId,
      }).map((task) => task.taskId)
    );
    if (plan.tasks.some((task) => historicalTaskIds.has(task.taskId))) {
      throw new GoalPlanRevisionError(
        'goal_plan_revision_invalid',
        'Goal Plan Task ids must be unique across the Goal.'
      );
    }
  }
  const current = getGoalRecord(input.workspaceDb, input.workspaceId, input.threadId, input.goalId);
  const sourceStillCurrent =
    current !== null &&
    !isTerminalGoalStatus(current.status) &&
    current?.currentIntentItemId === goal.currentIntentItemId &&
    (revision
      ? current?.pendingPlanItemId === revision.previousPlanItemId ||
        current?.planItemId === revision.previousPlanItemId
      : current?.status === 'planning' &&
        current.planItemId === null &&
        current.pendingPlanItemId === null);
  if (!sourceStillCurrent) {
    throw new GoalPlanRevisionError(
      'recovery_required',
      'Goal planning source changed before publication.'
    );
  }
  if (plan.questions.length > 0) {
    if (
      current.planItemId &&
      sourceTaskEvidence?.digest !==
        computeGoalTaskEvidenceDigest(input.store, input.workspaceDb, {
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          goalId: input.goalId,
          planItemId: current.planItemId,
        })
    ) {
      throw new GoalPlanRevisionError(
        'stale',
        'Goal Task evidence changed before its planning question.'
      );
    }
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
      parentItemId: revision?.previousPlanItemId ?? goal.currentIntentItemId,
      causationId: input.requestId,
      responsibleUserId,
      userInputRequestId: ids.userInputRequestId,
      prompt: 'Goal planning needs more information.',
      questions: plan.questions.map((question, index) => ({
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

    void questionItem;
    if (!revision) {
      updateGoalStatus(input.workspaceDb, {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        goalId: goal.goalId,
        status: 'awaiting_user',
      });
    }

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
    summary: goalPlanProposalSummary(
      plan,
      revision?.previousPlan ?? null,
      revision?.revisionText ?? goal.objective,
      sourceTaskEvidence,
      sourceTaskEvidenceDigest,
      goal.currentIntentItemId,
      input.planner ? 'goal-orchestrator' : 'deterministic-goal-planner'
    ),
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
    const admittedInitialPlanning =
      current?.status === 'planning' &&
      current.planItemId === null &&
      current.pendingPlanItemId === null;
    const admittedRevision =
      revision !== null &&
      current?.currentIntentItemId === goal.currentIntentItemId &&
      (current?.pendingPlanItemId === revision.previousPlanItemId ||
        current?.planItemId === revision.previousPlanItemId) &&
      !isTerminalGoalStatus(current.status);
    if (!admittedInitialPlanning && !admittedRevision) {
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
      predecessorPlanItemId: revision?.previousPlanItemId ?? current?.planItemId ?? null,
      sourceIntentItemId: current?.currentIntentItemId ?? goal.currentIntentItemId,
      sourceTaskEvidenceDigest,
      plan,
      createdByRequestId: input.requestId,
      now: () => timestamp,
    });
    updateGoalStatus(input.workspaceDb, {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      goalId: goal.goalId,
      status: current?.planItemId ? current.status : 'awaiting_plan_approval',
      pendingPlanItemId: planItem.id,
    });
  });
  storePlanAuthority();

  return { status: 'awaiting_plan_approval', plan, planItem };
}

/** Renders inspectable proposal provenance without copying a second Plan authority into the Item. */
function goalPlanProposalSummary(
  plan: GoalPlanOutput,
  predecessor: GoalPlanOutput | null,
  reason: string,
  sourceTaskEvidence: ReturnType<typeof captureGoalTaskEvidenceSnapshot> | null,
  sourceTaskEvidenceDigest: string | null,
  sourceIntentItemId: string,
  proposer: string
): string {
  const exactDiff = predecessor
    ? (
        [
          'goalSummary',
          'assumptions',
          'tasks',
          'taskDispositions',
          'risks',
          'verificationApproach',
        ] as const
      ).flatMap((field) =>
        JSON.stringify(predecessor[field]) === JSON.stringify(plan[field])
          ? []
          : [{ field, before: predecessor[field], after: plan[field] }]
      )
    : [{ field: 'initialPlan', before: null, after: plan }];
  const evidenceIds =
    sourceTaskEvidence?.facts.flatMap((task) => [
      ...task.reviews.flatMap((review) =>
        review.acceptedEvidence
          ? [
              ...review.acceptedEvidence.items.map((item) => item.id),
              ...review.acceptedEvidence.artifacts.map((artifact) => artifact.id),
            ]
          : []
      ),
      ...(task.acceptedOutcome?.items.map((item) => item.id) ?? []),
      ...(task.acceptedOutcome?.artifacts.map((artifact) => artifact.id) ?? []),
    ]) ?? [];
  const usedEvidenceIds = new Set(
    plan.tasks.flatMap((task) =>
      task.resources
        .filter((resource) => resource.kind === 'item' || resource.kind === 'artifact')
        .map((resource) => resource.reference)
    )
  );
  const completedResultTreatments =
    sourceTaskEvidence?.facts
      .filter((task) => task.status === 'completed')
      .map((task) => {
        const resultIds = [
          ...task.reviews.flatMap((review) =>
            review.acceptedEvidence
              ? [
                  ...review.acceptedEvidence.items.map((item) => item.id),
                  ...review.acceptedEvidence.artifacts.map((artifact) => artifact.id),
                ]
              : []
          ),
          ...(task.acceptedOutcome?.items.map((item) => item.id) ?? []),
          ...(task.acceptedOutcome?.artifacts.map((artifact) => artifact.id) ?? []),
        ];
        const carried = resultIds.filter((id) => usedEvidenceIds.has(id));
        return carried.length > 0
          ? `Completed Task ${task.taskId} result carried: ${carried.join(', ')}`
          : `Completed Task ${task.taskId} result excluded: ${plan.assumptions.find((assumption) => assumption.includes(task.taskId)) ?? 'missing reason'}`;
      }) ?? [];
  return [
    goalPlanItemSummary(plan),
    `Proposal reason: ${reason}`,
    `Proposer: ${proposer}`,
    `Source intent Item: ${sourceIntentItemId}`,
    `Source Task evidence digest: ${sourceTaskEvidenceDigest ?? 'none'}`,
    `Carried accepted evidence references: ${
      evidenceIds.some((id) => usedEvidenceIds.has(id))
        ? [...new Set(evidenceIds.filter((id) => usedEvidenceIds.has(id)))].join(', ')
        : 'none'
    }`,
    `Completed-result treatment: ${completedResultTreatments.length ? completedResultTreatments.join(' | ') : 'none'}`,
    `Exact predecessor diff: ${JSON.stringify(exactDiff)}`,
  ].join('\n');
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
    turn?.status === 'failed' &&
    turn.completedAt &&
    turn.error?.code === 'goal_plan_revision_failed' &&
    JSON.stringify(turn.triggerActor) === JSON.stringify(input.triggerActor) &&
    turn.items.length === 0 &&
    !planItem &&
    !questionItem &&
    !errorItem &&
    !plan
  ) {
    return null;
  }
  if (
    turn?.status === 'failed' &&
    turn.completedAt &&
    turn.error?.code === 'goal_planner_failed' &&
    JSON.stringify(turn.triggerActor) === JSON.stringify(input.triggerActor) &&
    turn.items.length === 1 &&
    turn.items[0]?.id === errorItem?.id &&
    errorItem?.type === 'status' &&
    errorItem.status === 'failed' &&
    errorItem.causationId === input.requestId &&
    !planItem &&
    !questionItem &&
    !plan
  ) {
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
    !planItem.summary?.startsWith(`${goalPlanItemSummary(plan)}\nProposal reason: `) ||
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

/** Reads one request-owned planning question Gate without treating it as an approvable Plan. */
export function readGoalPlanQuestionCreation(
  input: Omit<CreateGoalPlanInput, 'goalId' | 'planner'>
): {
  readonly goalId: string;
  readonly status: 'awaiting_user';
  readonly questionItem: GoalPlanItem;
} | null {
  const ids = goalPlanCreationIds(input);
  const turn = input.store
    .listThreadTurns(input.workspaceId, input.threadId)
    .find((candidate) => candidate.id === ids.turnId);
  const item = input.store
    .listThreadItems(input.workspaceId, input.threadId)
    .find((candidate) => candidate.id === ids.questionItemId);
  if (!item) return null;
  if (
    turn?.items.some((entry) => entry.type === 'plan' || entry.type === 'status') ||
    getGoalPlanRecord(input.workspaceDb, input.workspaceId, input.threadId, ids.planItemId)
  ) {
    throw new GoalPlanApprovalError(
      'recovery_required',
      'Goal planning question conflicts with another result owner.'
    );
  }
  if (
    !turn ||
    !item ||
    item.type !== 'user-input-request' ||
    item.status !== 'completed' ||
    item.turnId !== turn.id ||
    item.causationId !== input.requestId ||
    item.userInputRequestId !== ids.userInputRequestId ||
    !item.parentItemId ||
    JSON.stringify(turn.triggerActor) !== JSON.stringify(input.triggerActor) ||
    turn.status !== 'completed'
  ) {
    throw new GoalPlanApprovalError(
      'recovery_required',
      'Goal planning question owners are incomplete.'
    );
  }
  if (turn.status === 'completed') {
    const responses = turn.items.filter((entry) => entry.type === 'user-input-response');
    const response = responses[0];
    const questionIds = item.questions.map((question) => question.id);
    if (
      !turn.completedAt ||
      responses.length !== 1 ||
      response?.type !== 'user-input-response' ||
      response.status !== 'completed' ||
      response.userInputRequestId !== item.userInputRequestId ||
      Object.keys(response.answers).length !== questionIds.length ||
      questionIds.some(
        (id) => response.answers[id]?.length !== 1 || !response.answers[id]?.[0]?.trim()
      )
    ) {
      throw new GoalPlanApprovalError(
        'recovery_required',
        'Answered Goal planning question has an incomplete response tuple.'
      );
    }
  }
  const items = new Map(
    input.store.listThreadItems(input.workspaceId, input.threadId).map((entry) => [entry.id, entry])
  );
  const goals = listGoalRecordsForThread(input.workspaceDb, {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
  }).filter((goal) => {
    if (goal.planItemId === item.parentItemId || goal.pendingPlanItemId === item.parentItemId)
      return true;
    let cursor: string | null = goal.currentIntentItemId;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      if (cursor === item.parentItemId) return true;
      seen.add(cursor);
      const previous = items.get(cursor);
      if (!previous || previous.type !== 'user-message') break;
      cursor = previous.parentItemId ?? null;
    }
    const historicalPlan = getGoalPlanRecord(
      input.workspaceDb,
      input.workspaceId,
      input.threadId,
      item.parentItemId!
    );
    return historicalPlan?.goalId === goal.goalId;
  });
  if (goals.length !== 1) {
    throw new GoalPlanApprovalError(
      'recovery_required',
      'Goal planning question has no exact Goal lineage.'
    );
  }
  return {
    goalId: goals[0]!.goalId,
    status: 'awaiting_user',
    questionItem: item,
  };
}

/** Goal planning questions are unavailable until the Goal redesign. */
export function closeGoalPlanningQuestionGate(_input: {
  readonly store: FsStore;
  readonly workspaceDb: WorkspaceDb;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly requestId: string;
  readonly actorId: string;
  readonly answers: Readonly<Record<string, readonly string[]>>;
}): ReturnType<FsStore['getTurn']> {
  throw new GoalPlanApprovalError('recovery_required', 'Goal mode is unavailable.');
}

/**
 * Reads the in-flight pre-approval Plan revision admitted against the intact active pointer.
 *
 * @param input Goal scope and owner stores.
 * @returns Exact previous Plan and revision instruction, or null when none is admitted.
 * @throws GoalPlanRevisionError when revision lineage fails its durable digest check.
 */
export function readPreApprovalGoalPlanRevision(input: {
  readonly store: FsStore;
  readonly workspaceDb: WorkspaceDb;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly goalId: string;
}): PreApprovalGoalPlanRevision | null {
  const goal = getGoalRecord(input.workspaceDb, input.workspaceId, input.threadId, input.goalId);
  if (!goal || isTerminalGoalStatus(goal.status)) {
    return null;
  }
  const items = input.store.listThreadItems(input.workspaceId, input.threadId);
  const currentIntentIndex = items.findIndex((item) => item.id === goal.currentIntentItemId);
  const pendingIndex = goal.pendingPlanItemId
    ? items.findIndex((item) => item.id === goal.pendingPlanItemId)
    : -1;
  const predecessorIds = [goal.pendingPlanItemId, goal.planItemId].filter(
    (id): id is string => id !== null
  );
  for (
    let index = items.length - 1;
    index > Math.max(pendingIndex, currentIntentIndex);
    index -= 1
  ) {
    const item = items[index];
    if (
      !item ||
      item.type !== 'user-message' ||
      item.status !== 'completed' ||
      !item.parentItemId ||
      !predecessorIds.includes(item.parentItemId) ||
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
      revisionItemId: item.id,
      previousPlanItemId: item.parentItemId,
      previousPlan: selectGoalPlanPayload(record),
      revisionText: item.text,
    };
  }
  if (goal.planItemId) {
    const active = getGoalPlanRecord(
      input.workspaceDb,
      input.workspaceId,
      input.threadId,
      goal.planItemId
    );
    const intentItem = items.find((item) => item.id === goal.currentIntentItemId);
    if (
      active &&
      active.sourceIntentItemId !== goal.currentIntentItemId &&
      intentItem?.type === 'user-message' &&
      intentItem.status === 'completed' &&
      typeof intentItem.text === 'string'
    ) {
      return {
        revisionItemId: intentItem.id,
        previousPlanItemId: active.planItemId,
        previousPlan: selectGoalPlanPayload(active),
        revisionText: intentItem.text,
      };
    }
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
 * @param store Owner of the admitted planning Turn.
 * @param turn Exact planning Turn.
 * @param workspaceDb Borrowed Goal planning database.
 * @returns Validated plan output.
 * @throws GoalPlanRevisionError when a revision run has no semantic planner.
 */
async function runGoalPlanner(
  planner: GoalPlanner | undefined,
  input: GoalPlannerInput,
  allowDeterministicFallback: boolean,
  store: FsStore,
  turn: ReturnType<FsStore['createTurn']>,
  workspaceDb: WorkspaceDb
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

  return GoalPlanOutputSchema.parse(
    await withTurnModelCapture({ store, turn, workspaceDb }, (capture) =>
      Promise.resolve(planner({ ...input, capture }))
    )
  );
}

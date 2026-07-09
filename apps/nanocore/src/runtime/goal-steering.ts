import type { WorkspaceDb } from '../storage/db.js';
import type { GoalRecord } from './goal-store.js';
import { getGoalRecord } from './goal-store.js';
import type { PendingUserTurnRecord } from './pending-user-turns.js';
import { listPendingUserTurns } from './pending-user-turns.js';
import {
  drainSteeringForSafePoint,
  enqueueFollowUpInput,
  enqueueSteeringForSafePoint,
  type SafePointSteeringMessage,
} from './user-turn-queues.js';

/**
 * Stored steering state after active user input is accepted.
 */
export type RecordedGoalSteeringState = 'pending_steering' | 'pending_follow_up';

/**
 * Input used to record active goal steering.
 */
export interface RecordActiveGoalSteeringInput {
  /** Workspace that owns the goal. */
  readonly workspaceId: string;
  /** Thread that owns the goal. */
  readonly threadId: string;
  /** Goal that receives steering. */
  readonly goalId: string;
  /** Idempotency request id from the submitting command. */
  readonly requestId: string;
  /** Optional durable content item id for the submitted input. */
  readonly contentItemId?: string | null;
  /** Optional digest when the submitted content is represented indirectly. */
  readonly contentDigest?: string | null;
  /** Optional clock used by deterministic tests. */
  readonly now?: () => string;
}

/**
 * Result returned after active goal steering is recorded.
 */
export interface RecordActiveGoalSteeringResult {
  /** Steering state selected from current goal state. */
  readonly state: RecordedGoalSteeringState;
  /** Stored pending input row. */
  readonly pendingTurn: PendingUserTurnRecord;
}

/**
 * Input used to apply safe-point steering.
 */
export interface ApplyGoalSteeringAtSafePointInput {
  /** Workspace that owns the goal. */
  readonly workspaceId: string;
  /** Thread that owns the goal. */
  readonly threadId: string;
  /** Goal that receives steering. */
  readonly goalId: string;
}

/**
 * Result returned after safe-point steering is drained for a worker turn.
 */
export interface ApplyGoalSteeringAtSafePointResult {
  /** System-owned messages ready to pass into prepareNextTurn. */
  readonly messages: readonly SafePointSteeringMessage[];
}

/**
 * Input used to build a goal steering read model.
 */
export interface GetGoalSteeringReadModelInput {
  /** Workspace that owns the goal thread. */
  readonly workspaceId: string;
  /** Thread that owns the goal. */
  readonly threadId: string;
  /** Steering messages already applied to a prepared turn. */
  readonly appliedSteeringCount?: number;
}

/**
 * App-local steering summary suitable for a thread read model.
 */
export interface GoalSteeringReadModel {
  /** Pending safe-point steering rows. */
  readonly pendingSteeringCount: number;
  /** Pending follow-up rows. */
  readonly pendingFollowUpCount: number;
  /** Steering rows already drained into a prepared turn. */
  readonly appliedSteeringCount: number;
}

/**
 * Records active user input as safe-point steering or follow-up based on goal state.
 *
 * @param workspaceDb Open workspace-scope database handle for goal and pending input rows.
 * @param input Active steering input.
 * @returns Stored steering state.
 * @throws Error when the goal does not exist in the requested scope.
 */
export function recordActiveGoalSteering(
  workspaceDb: WorkspaceDb,
  input: RecordActiveGoalSteeringInput
): RecordActiveGoalSteeringResult {
  const goal = requireGoal(workspaceDb, input);
  const pendingInput = {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    requestId: input.requestId,
    ...(input.contentItemId ? { contentItemId: input.contentItemId } : {}),
    ...(input.contentDigest ? { contentDigest: input.contentDigest } : {}),
    ...(input.now ? { now: input.now } : {}),
  };

  if (shouldQueueAsSafePointSteering(goal)) {
    return {
      pendingTurn: enqueueSteeringForSafePoint(workspaceDb, pendingInput),
      state: 'pending_steering',
    };
  }

  return {
    pendingTurn: enqueueFollowUpInput(workspaceDb, pendingInput),
    state: 'pending_follow_up',
  };
}

/**
 * Drains pending safe-point steering into the next prepared-turn message shape.
 *
 * @param workspaceDb Open workspace-scope database handle for goal and pending input rows.
 * @param input Goal steering scope.
 * @returns Safe-point steering messages ready for prepareNextTurn.
 * @throws Error when the goal does not exist in the requested scope.
 */
export function applyGoalSteeringAtSafePoint(
  workspaceDb: WorkspaceDb,
  input: ApplyGoalSteeringAtSafePointInput
): ApplyGoalSteeringAtSafePointResult {
  requireGoal(workspaceDb, input);

  return {
    messages: drainSteeringForSafePoint(workspaceDb, input),
  };
}

/**
 * Builds the pending or applied steering state for a thread read model.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Steering read-model input.
 * @returns Steering state summary.
 */
export function getGoalSteeringReadModel(
  workspaceDb: WorkspaceDb,
  input: GetGoalSteeringReadModelInput
): GoalSteeringReadModel {
  const pendingTurns = listPendingUserTurns(workspaceDb, input);

  return {
    appliedSteeringCount: input.appliedSteeringCount ?? 0,
    pendingFollowUpCount: pendingTurns.filter((turn) => turn.queueMode === 'follow_up').length,
    pendingSteeringCount: pendingTurns.filter((turn) => turn.queueMode === 'safe_point_steering')
      .length,
  };
}

/**
 * Reads one goal in the requested scope.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Goal scope.
 * @returns Stored goal record.
 * @throws Error when the goal does not exist.
 */
function requireGoal(
  workspaceDb: WorkspaceDb,
  input: { readonly workspaceId: string; readonly threadId: string; readonly goalId: string }
): GoalRecord {
  const goal = getGoalRecord(workspaceDb, input.workspaceId, input.threadId, input.goalId);

  if (!goal) {
    throw new Error(`Goal not found: ${input.workspaceId}/${input.threadId}/${input.goalId}`);
  }

  return goal;
}

/**
 * Checks whether active input should wait for a worker safe point.
 *
 * @param goal Current goal record.
 * @returns True when input should be delivered as safe-point steering.
 */
function shouldQueueAsSafePointSteering(goal: GoalRecord): boolean {
  return goal.status === 'running' || goal.status === 'reviewing' || goal.status === 'verifying';
}

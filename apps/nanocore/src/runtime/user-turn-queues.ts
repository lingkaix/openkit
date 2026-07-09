import type { WorkspaceDb } from '../storage/db.js';
import {
  consumePendingUserTurn,
  type EnqueuePendingUserTurnInput,
  enqueuePendingUserTurn,
  listPendingUserTurns,
  type PendingUserTurnRecord,
} from './pending-user-turns.js';

/**
 * Follow-up queue drain modes.
 */
export type FollowUpDrainMode = 'one_at_a_time' | 'all';

/**
 * Common thread scope for user turn queue helpers.
 */
export interface UserTurnQueueScope {
  /** Workspace that owns the queued input. */
  readonly workspaceId: string;
  /** Thread that owns the queued input. */
  readonly threadId: string;
}

/**
 * Input used to drain queued follow-up inputs.
 */
export interface DrainFollowUpInputsInput extends UserTurnQueueScope {
  /** Drain mode for pending follow-up input. */
  readonly drainMode: FollowUpDrainMode;
}

/**
 * System-owned steering message delivered at a worker safe point.
 */
export interface SafePointSteeringMessage {
  /** Message kind for safe-point steering. */
  readonly kind: 'safe_point_steering_message';
  /** Safe-point steering is delivered by the system to the next worker context. */
  readonly owner: 'system';
  /** Queue helpers only prepare delivery and never start worker turns. */
  readonly startsWorkerTurn: false;
  /** Durable pending input row backing this steering message. */
  readonly pendingTurn: PendingUserTurnRecord;
}

/**
 * User-owned follow-up input prepared for a later worker turn.
 */
export interface QueuedFollowUpInput {
  /** Message kind for queued follow-up input. */
  readonly kind: 'queued_follow_up_input';
  /** Follow-up input remains user-owned. */
  readonly owner: 'user';
  /** Queue helpers only prepare delivery and never start worker turns. */
  readonly startsWorkerTurn: false;
  /** Durable pending input row backing this follow-up input. */
  readonly pendingTurn: PendingUserTurnRecord;
}

/**
 * Enqueues one user input item for system-owned safe-point steering.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Pending input fields.
 * @returns Stored pending user turn row.
 */
export function enqueueSteeringForSafePoint(
  workspaceDb: WorkspaceDb,
  input: Omit<EnqueuePendingUserTurnInput, 'queueMode'>
): PendingUserTurnRecord {
  return enqueuePendingUserTurn(workspaceDb, {
    ...input,
    queueMode: 'safe_point_steering',
  });
}

/**
 * Enqueues one user input item as a follow-up input.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Pending input fields.
 * @returns Stored pending user turn row.
 */
export function enqueueFollowUpInput(
  workspaceDb: WorkspaceDb,
  input: Omit<EnqueuePendingUserTurnInput, 'queueMode'>
): PendingUserTurnRecord {
  return enqueuePendingUserTurn(workspaceDb, {
    ...input,
    queueMode: 'follow_up',
  });
}

/**
 * Drains all safe-point steering messages for one thread.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Thread queue scope.
 * @returns Safe-point steering messages in deterministic order.
 */
export function drainSteeringForSafePoint(
  workspaceDb: WorkspaceDb,
  input: UserTurnQueueScope
): SafePointSteeringMessage[] {
  return drainSelectedPendingTurns(
    workspaceDb,
    listByMode(workspaceDb, input, 'safe_point_steering')
  ).map(createSafePointSteeringMessage);
}

/**
 * Drains follow-up inputs for one thread according to the requested drain mode.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Thread queue scope and follow-up drain mode.
 * @returns Queued follow-up inputs in deterministic order.
 */
export function drainFollowUpInputs(
  workspaceDb: WorkspaceDb,
  input: DrainFollowUpInputsInput
): QueuedFollowUpInput[] {
  const pendingTurns = listByMode(workspaceDb, input, 'follow_up');
  const selectedTurns =
    input.drainMode === 'one_at_a_time' ? pendingTurns.slice(0, 1) : pendingTurns;

  return drainSelectedPendingTurns(workspaceDb, selectedTurns).map(createQueuedFollowUpInput);
}

/**
 * Lists pending rows matching one queue mode for one thread.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Thread queue scope.
 * @param queueMode Queue mode to list.
 * @returns Matching pending rows in deterministic order.
 */
function listByMode(
  workspaceDb: WorkspaceDb,
  input: UserTurnQueueScope,
  queueMode: PendingUserTurnRecord['queueMode']
): PendingUserTurnRecord[] {
  return listPendingUserTurns(workspaceDb, input).filter(
    (pendingTurn) => pendingTurn.queueMode === queueMode
  );
}

/**
 * Consumes selected pending rows without starting worker turns.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param pendingTurns Pending rows selected for delivery.
 * @returns Consumed pending rows in the original selection order.
 */
function drainSelectedPendingTurns(
  workspaceDb: WorkspaceDb,
  pendingTurns: PendingUserTurnRecord[]
): PendingUserTurnRecord[] {
  for (const pendingTurn of pendingTurns) {
    consumePendingUserTurn(workspaceDb, {
      workspaceId: pendingTurn.workspaceId,
      threadId: pendingTurn.threadId,
      requestId: pendingTurn.requestId,
    });
  }

  return pendingTurns;
}

/**
 * Creates a safe-point steering message from a pending row.
 *
 * @param pendingTurn Pending input row.
 * @returns System-owned steering message.
 */
function createSafePointSteeringMessage(
  pendingTurn: PendingUserTurnRecord
): SafePointSteeringMessage {
  return {
    kind: 'safe_point_steering_message',
    owner: 'system',
    startsWorkerTurn: false,
    pendingTurn,
  };
}

/**
 * Creates a queued follow-up input from a pending row.
 *
 * @param pendingTurn Pending input row.
 * @returns User-owned follow-up input.
 */
function createQueuedFollowUpInput(pendingTurn: PendingUserTurnRecord): QueuedFollowUpInput {
  return {
    kind: 'queued_follow_up_input',
    owner: 'user',
    startsWorkerTurn: false,
    pendingTurn,
  };
}

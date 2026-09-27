import { createHash } from 'node:crypto';

import type { ActorRef } from '@openkit/protocol';

import type { FsStore } from '../lib/store.js';
import type { WorkspaceDb } from '../storage/db.js';
import {
  getGoalRecord,
  isTerminalGoalStatus,
  listGoalRecordsForThread,
  listGoalTasks,
  updateGoalIntent,
} from './goal-store.js';

type IntentItem = Extract<ReturnType<FsStore['createItem']>, { readonly type: 'user-message' }>;

/** Product-safe failure for a Goal intent transition. */
export class GoalIntentRevisionError extends Error {
  /** Stable App API error code. */
  public readonly code: 'stale' | 'goal_intent_invalid' | 'recovery_required';
  /** HTTP status for the error. */
  public readonly status: 400 | 409;

  /** Creates one typed intent revision failure. */
  public constructor(code: 'stale' | 'goal_intent_invalid' | 'recovery_required', message: string) {
    super(message);
    this.name = 'GoalIntentRevisionError';
    this.code = code;
    this.status = code === 'goal_intent_invalid' ? 400 : 409;
  }
}

/** One authenticated revision of the current objective in the same Goal. */
export interface ReviseGoalIntentInput {
  /** Actor recorded on the immutable instruction Item. */
  readonly triggerActor: ActorRef;
  /** App-local durable Item and Turn owner. */
  readonly store: FsStore;
  /** Open Goal workspace database. */
  readonly workspaceDb: WorkspaceDb;
  /** Workspace that owns the Goal. */
  readonly workspaceId: string;
  /** Thread that owns the Goal. */
  readonly threadId: string;
  /** Goal whose current objective changes. */
  readonly goalId: string;
  /** Caller request identity. */
  readonly requestId: string;
  /** Complete new objective. */
  readonly objective: string;
  /** User's explanation of the change. */
  readonly revision: string;
  /** Optional Task scope; omission conservatively holds all remaining work. */
  readonly affectedTaskIds?: readonly string[];
}

/** Durable intent effect returned to command routing. */
export interface ReviseGoalIntentResult {
  /** Unchanged Goal identity. */
  readonly goalId: string;
  /** New immutable user instruction Item. */
  readonly intentItem: IntentItem;
}

/** Revises one Goal's objective, preserving the immutable prior intent Item. */
export function reviseGoalIntent(input: ReviseGoalIntentInput): ReviseGoalIntentResult {
  const goal = getGoalRecord(input.workspaceDb, input.workspaceId, input.threadId, input.goalId);
  if (!goal || isTerminalGoalStatus(goal.status)) {
    throw new GoalIntentRevisionError('stale', 'Goal is not available for intent revision.');
  }
  const ids = intentRevisionIds(input);
  if (
    input.store
      .listThreadTurns(input.workspaceId, input.threadId)
      .some((turn) => turn.id === ids.turnId)
  ) {
    throw new GoalIntentRevisionError(
      'recovery_required',
      'Goal intent request already has durable owners.'
    );
  }
  if (!input.objective.trim() || !input.revision.trim()) {
    throw new GoalIntentRevisionError(
      'goal_intent_invalid',
      'Goal objective and revision are required.'
    );
  }
  const affectedTaskIds = input.affectedTaskIds === undefined ? null : [...input.affectedTaskIds];
  if (affectedTaskIds !== null) {
    const idsInScope = new Set(affectedTaskIds);
    const activeTasks = listGoalTasks(input.workspaceDb, input).filter(
      (task) => task.planItemId === goal.planItemId
    );
    const selectableIds = new Set(
      activeTasks
        .filter((task) => !['completed', 'blocked', 'failed'].includes(task.status))
        .map((task) => task.taskId)
    );
    if (
      idsInScope.size !== affectedTaskIds.length ||
      affectedTaskIds.some((id) => !selectableIds.has(id))
    ) {
      throw new GoalIntentRevisionError(
        'goal_intent_invalid',
        'Affected Tasks must be distinct, current, and nonterminal.'
      );
    }
  }
  const turn = input.store.createTurn(
    input.workspaceId,
    input.threadId,
    'Revise goal intent',
    input.triggerActor,
    null,
    { turnId: ids.turnId }
  );
  const timestamp = turn.startedAt ?? new Date().toISOString();
  const intentItem = input.store.createItem({
    id: ids.itemId,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    turnId: turn.id,
    type: 'user-message',
    status: 'completed',
    actor: input.triggerActor,
    parentItemId: goal.currentIntentItemId,
    causationId: input.requestId,
    text: formatGoalIntentText(input.objective, input.revision, affectedTaskIds),
    createdAt: timestamp,
    completedAt: timestamp,
  }) as IntentItem;
  input.store.updateTurn(turn.id, { status: 'completed', completedAt: timestamp, durationMs: 0 });
  try {
    updateGoalIntent(input.workspaceDb, {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      goalId: input.goalId,
      previousIntentItemId: goal.currentIntentItemId,
      intentItemId: intentItem.id,
      objective: input.objective.trim(),
      affectedTaskIds,
      now: () => timestamp,
    });
  } catch {
    throw new GoalIntentRevisionError(
      'recovery_required',
      'Goal intent Item could not commit its Goal transition.'
    );
  }
  return { goalId: goal.goalId, intentItem };
}

/** Formats the immutable, readable user intent and exact affected-work scope. */
export function formatGoalIntentText(
  objective: string,
  revision: string,
  affectedTaskIds: readonly string[] | null
): string {
  const scope =
    affectedTaskIds === null
      ? 'Hold all remaining approved work until it is reassessed.'
      : affectedTaskIds.length === 0
        ? 'Current approved work remains valid.'
        : `Hold these Tasks and their dependents: ${affectedTaskIds.join(', ')}.`;
  return `Objective: ${objective.trim()}\nRevision: ${revision.trim()}\n${scope}`;
}

/** Reads the exact request-owned intent effect for idempotent acknowledgement. */
export function readGoalIntentRevision(
  input: Pick<
    ReviseGoalIntentInput,
    'triggerActor' | 'store' | 'workspaceDb' | 'workspaceId' | 'threadId' | 'requestId'
  >
): ReviseGoalIntentResult | null {
  const ids = intentRevisionIds(input);
  const turn = input.store
    .listThreadTurns(input.workspaceId, input.threadId)
    .find((item) => item.id === ids.turnId);
  const item = input.store
    .listThreadItems(input.workspaceId, input.threadId)
    .find((entry) => entry.id === ids.itemId);
  if (!turn && !item) return null;
  if (
    !turn ||
    turn.status !== 'completed' ||
    !turn.completedAt ||
    JSON.stringify(turn.triggerActor) !== JSON.stringify(input.triggerActor) ||
    !item ||
    item.type !== 'user-message' ||
    item.status !== 'completed' ||
    item.turnId !== turn.id ||
    item.causationId !== input.requestId ||
    !item.parentItemId
  ) {
    throw new GoalIntentRevisionError(
      'recovery_required',
      'Goal intent revision owners are incomplete.'
    );
  }
  const items = new Map(
    input.store.listThreadItems(input.workspaceId, input.threadId).map((entry) => [entry.id, entry])
  );
  const goals = listGoalRecordsForThread(input.workspaceDb, {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
  }).filter((goal) => {
    let cursor: string | null = goal.currentIntentItemId;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      if (cursor === item.id) return true;
      seen.add(cursor);
      const previous = items.get(cursor);
      if (!previous || previous.type !== 'user-message') return false;
      cursor = previous.parentItemId ?? null;
    }
    return false;
  });
  if (goals.length !== 1) {
    throw new GoalIntentRevisionError(
      'recovery_required',
      'Goal intent Item does not own one current Goal transition.'
    );
  }
  return { goalId: goals[0]!.goalId, intentItem: item as IntentItem };
}

/** Derives deterministic Turn and Item IDs for one Goal intent command. */
function intentRevisionIds(
  input: Pick<ReviseGoalIntentInput, 'triggerActor' | 'workspaceId' | 'threadId' | 'requestId'>
): {
  readonly turnId: string;
  readonly itemId: string;
} {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        'goal.intent.revise',
        input.triggerActor.id,
        input.workspaceId,
        input.threadId,
        input.requestId,
      ])
    )
    .digest('hex')
    .slice(0, 24);
  return { turnId: `tu_goal_intent_${digest}`, itemId: `it_goal_intent_${digest}` };
}

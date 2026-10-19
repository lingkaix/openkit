import { readRetainedV1, writeRetainedV1 } from '@openkit/protocol';
import type { FsStore } from '../lib/store.js';
import type { WorkspaceDb } from '../storage/db.js';
import { advanceGoalRevision, GoalCommandError, goalPlanDigest } from './goal-owner.js';
import {
  StoredGoalCardTaskV1Schema,
  StoredGoalCardV1Schema,
  StoredGoalPlanVersionV1Schema,
  StoredGoalV1Schema,
} from './goal-retained-v1.js';

/** Current read and explicit Coordinator judgment, checked at ordinary Task reservation. */
export interface GoalTaskAdmission {
  readonly goalId: string;
  readonly cardId: string;
  readonly planVersionId: string;
  readonly cardRevision: number;
  readonly intentRevision: number;
  readonly withinCurrentIntent: boolean;
  readonly withinPermittedAdjustments: boolean;
  readonly rationale: string;
}
/** Records only a Task link, in the ordinary Task owner's reservation transaction. */
export function reserveGoalTask(
  store: FsStore,
  db: WorkspaceDb,
  input: GoalTaskAdmission,
  threadId: string
): void {
  if (!db.sqlite.inTransaction)
    throw new Error('Goal Task citation requires the ordinary reservation transaction.');
  const load = (table: string, key: string, id: string) =>
    db.sqlite
      .prepare(`SELECT schema_version AS schemaVersion,payload_json FROM ${table} WHERE ${key}=?`)
      .get(id) as { schemaVersion: unknown; payload_json: string } | undefined;
  const goalRow = load('goals', 'goal_id', input.goalId);
  const cardRow = load('goal_cards', 'card_id', input.cardId);
  const planRow = load('goal_plan_versions', 'plan_version_id', input.planVersionId);
  if (!goalRow || !cardRow || !planRow)
    throw new GoalCommandError('not_found', 'Goal admission records are unavailable.', 404);
  const goal = readRetainedV1(goalRow, () =>
    StoredGoalV1Schema.parse(JSON.parse(goalRow.payload_json))
  );
  const card = readRetainedV1(cardRow, () =>
    StoredGoalCardV1Schema.parse(JSON.parse(cardRow.payload_json))
  );
  const plan = readRetainedV1(planRow, () =>
    StoredGoalPlanVersionV1Schema.parse(JSON.parse(planRow.payload_json))
  );
  if (goalPlanDigest(plan.bytes) !== plan.digest || JSON.stringify(plan.commitment) !== plan.bytes)
    throw new GoalCommandError(
      'admission_conflict',
      'The immutable Plan bytes or digest are inconsistent.'
    );
  if (goal.disposition || card.cancelled)
    throw new GoalCommandError('goal_cancelled', 'Goal or card has ended.');
  if (
    goal.workspaceId !== db.workspaceId ||
    card.goalId !== goal.goalId ||
    plan.goalId !== goal.goalId ||
    goal.activePlanVersionId !== plan.planVersionId ||
    card.revision !== input.cardRevision ||
    goal.intentRevision !== input.intentRevision
  )
    throw new GoalCommandError(
      'admission_conflict',
      'Current intent, card or Plan changed before reservation.'
    );
  if (!input.withinCurrentIntent || !input.withinPermittedAdjustments || !input.rationale.trim())
    throw new GoalCommandError(
      'new_plan_required',
      'The contemplated work is not authorized by current intent and permitted adjustments.'
    );
  const thread = store.getThread(db.workspaceId, threadId);
  if (thread.visibility !== 'workspace')
    throw new GoalCommandError(
      'shared_thread_required',
      'Task admission requires an ordinary shared Thread.'
    );
  const missing = (
    db.sqlite
      .prepare(
        'SELECT schema_version AS schemaVersion,thread_id FROM goal_card_tasks WHERE card_id=?'
      )
      .all(card.cardId) as {
      schemaVersion: unknown;
      thread_id: string;
    }[]
  ).some((link) =>
    readRetainedV1(
      link,
      () => !store.listThreads(db.workspaceId).some((t) => t.id === link.thread_id)
    )
  );
  if (missing)
    throw new GoalCommandError(
      'missing_task',
      'A missing linked Task remains unresolved; it cannot authorize a duplicate.'
    );
  const link = StoredGoalCardTaskV1Schema.parse({
    goalId: goal.goalId,
    cardId: card.cardId,
    threadId,
    planVersionId: plan.planVersionId,
    cardRevision: card.revision,
  });
  db.sqlite
    .prepare(
      'INSERT INTO goal_card_tasks (thread_id,goal_id,card_id,payload_json,schema_version) VALUES (?,?,?,?,?)'
    )
    .run(
      threadId,
      goal.goalId,
      card.cardId,
      JSON.stringify(link),
      writeRetainedV1({}).schemaVersion
    );
  advanceGoalRevision(db, goal.goalId);
}

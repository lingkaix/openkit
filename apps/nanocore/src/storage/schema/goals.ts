import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
/** The Goal owner validates closed-core JSON payloads; SQL indexes only its stable identities. */
export const goals = sqliteTable('goals', {
  goalId: text('goal_id').primaryKey(),
  threadId: text('thread_id').notNull().unique(),
  payloadJson: text('payload_json').notNull(),
});
/** Work-intent cards contain no execution status. */
export const goalCards = sqliteTable(
  'goal_cards',
  {
    cardId: text('card_id').primaryKey(),
    goalId: text('goal_id').notNull(),
    payloadJson: text('payload_json').notNull(),
  },
  (table) => [index('goal_cards_goal').on(table.goalId)]
);
/** Plan versions are append-only exact bytes, never mutable plan Items. */
export const goalPlanVersions = sqliteTable(
  'goal_plan_versions',
  {
    planVersionId: text('plan_version_id').primaryKey(),
    goalId: text('goal_id').notNull(),
    payloadJson: text('payload_json').notNull(),
  },
  (table) => [index('goal_versions_goal').on(table.goalId)]
);
/** Ordinary Task links record the admission citation rather than a Goal Task lifecycle. */
export const goalCardTasks = sqliteTable(
  'goal_card_tasks',
  {
    threadId: text('thread_id').primaryKey(),
    goalId: text('goal_id').notNull(),
    cardId: text('card_id').notNull(),
    payloadJson: text('payload_json').notNull(),
  },
  (table) => [index('goal_tasks_goal').on(table.goalId)]
);
/** Minimal Task-owned terminal fact commits before canonical Turn file publication. */
export const taskTurnTerminalFacts = sqliteTable('task_turn_terminal_facts', {
  turnId: text('turn_id').primaryKey(),
  threadId: text('thread_id').notNull(),
  payloadJson: text('payload_json').notNull(),
});

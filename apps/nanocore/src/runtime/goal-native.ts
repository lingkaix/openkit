import { readRetainedV1, writeRetainedV1 } from '@openkit/protocol';
import { StoredGoalV1Schema } from './goal-retained-v1.js';

/** Shared Goal clock. Each call reads the live process Date as an ISO timestamp. */
export const now = () => new Date().toISOString();
/** Advances Goals addressed by this Thread or linked to its ordinary Task, inside the source commit. */
export function advanceGoalForThread(
  sqlite: import('better-sqlite3').Database,
  threadId: string
): void {
  for (const row of sqlite
    .prepare('SELECT schema_version AS schemaVersion FROM goal_card_tasks WHERE thread_id=?')
    .all(threadId)) {
    readRetainedV1(row, () => undefined);
  }
  for (const row of sqlite
    .prepare(
      'SELECT schema_version AS schemaVersion,goal_id,payload_json FROM goals WHERE thread_id=? OR goal_id IN (SELECT goal_id FROM goal_card_tasks WHERE thread_id=?)'
    )
    .all(threadId, threadId) as {
    schemaVersion: unknown;
    goal_id: string;
    payload_json: string;
  }[]) {
    const goal = readRetainedV1(row, () => StoredGoalV1Schema.parse(JSON.parse(row.payload_json)));
    sqlite
      .prepare('UPDATE goals SET payload_json=?,schema_version=? WHERE goal_id=?')
      .run(
        JSON.stringify({ ...goal, changeRevision: goal.changeRevision + 1, updatedAt: now() }),
        writeRetainedV1({}).schemaVersion,
        row.goal_id
      );
  }
}

import type Database from 'better-sqlite3';

/** Accepted Goal owners; payloads are validated by their domain owner on every read. */
export const GOAL_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS goals (goal_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS goal_cards (card_id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, payload_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS goal_cards_goal ON goal_cards(goal_id);
CREATE TABLE IF NOT EXISTS goal_plan_versions (plan_version_id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, payload_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS goal_versions_goal ON goal_plan_versions(goal_id);
CREATE TABLE IF NOT EXISTS goal_card_tasks (thread_id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, card_id TEXT NOT NULL, payload_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS goal_tasks_goal ON goal_card_tasks(goal_id);
CREATE TABLE IF NOT EXISTS task_turn_terminal_facts (turn_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, payload_json TEXT NOT NULL);
`;

/** One-way release cutover, preserving every shared owner and retiring only the named Goal families. */
export function applyGoalCutover(sqlite: Database.Database): void {
  const tables = new Set(
    (
      sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as {
        name: string;
      }[]
    ).map((row) => row.name)
  );
  const pendingShape = sqlite
    .prepare("SELECT sql FROM sqlite_schema WHERE name='pending_requests'")
    .get() as { sql: string } | undefined;
  const pendingColumns = sqlite.prepare('PRAGMA table_info(pending_requests)').all() as {
    name: string;
  }[];
  if (
    ![
      'goal_records',
      'goal_plan_records',
      'goal_tasks',
      'goal_review_records',
      'goal_verification_records',
      'pending_user_turn_records',
      'steering_terminal_outcomes',
    ].some((table) => tables.has(table)) &&
    [
      'goals',
      'goal_cards',
      'goal_plan_versions',
      'goal_card_tasks',
      'task_turn_terminal_facts',
    ].every((table) => tables.has(table)) &&
    pendingShape?.sql.includes("'coordinator'") &&
    pendingColumns.some((column) => column.name === 'deciding_actor_context_json')
  )
    return;
  sqlite.transaction(() => {
    const old = sqlite
      .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='goal_records'")
      .get();
    if (old) sqlite.prepare('DELETE FROM worker_turn_checkpoints WHERE goal_id IS NOT NULL').run();
    for (const table of [
      'goal_records',
      'goal_plan_records',
      'goal_tasks',
      'goal_review_records',
      'goal_verification_records',
      'pending_user_turn_records',
      'steering_terminal_outcomes',
    ])
      sqlite.exec(`DROP TABLE IF EXISTS ${table}`);
    sqlite.exec(GOAL_TABLES_SQL);
    const pendingColumns = sqlite.prepare('PRAGMA table_info(pending_requests)').all() as {
      name: string;
    }[];
    if (!pendingColumns.some((column) => column.name === 'deciding_actor_context_json'))
      sqlite.exec('ALTER TABLE pending_requests ADD COLUMN deciding_actor_context_json TEXT;');
    const pending = sqlite
      .prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='pending_requests'")
      .get() as { sql: string } | undefined;
    if (pending && !pending.sql.includes("'coordinator'")) {
      // Retain exact rows and indexes while extending the closed requester core once.
      const indices = sqlite
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name='pending_requests' AND sql IS NOT NULL"
        )
        .all() as { sql: string }[];
      sqlite.exec(
        pending.sql
          .replace('CREATE TABLE `pending_requests`', 'CREATE TABLE `pending_requests_cutover`')
          .replace('CREATE TABLE pending_requests', 'CREATE TABLE pending_requests_cutover')
          .replace(
            "'worker', 'assistant', 'person'",
            "'worker', 'assistant', 'coordinator', 'person'"
          )
      );
      sqlite.exec(
        'INSERT INTO pending_requests_cutover SELECT * FROM pending_requests; DROP TABLE pending_requests; ALTER TABLE pending_requests_cutover RENAME TO pending_requests;'
      );
      for (const index of indices) sqlite.exec(index.sql);
    }
  })();
}

/** Removes scheduler affinity without modifying retained scheduler or evidence rows. */
export function removeGoalSandboxPin(sqlite: Database.Database): void {
  const columns = sqlite.prepare('PRAGMA table_info(sandbox_runtime_records)').all() as {
    name: string;
  }[];
  if (columns.some((column) => column.name === 'pinned_goal_id'))
    sqlite.transaction(() => {
      sqlite.exec(
        'UPDATE sandbox_runtime_records SET pinned_goal_id = NULL; ALTER TABLE sandbox_runtime_records DROP COLUMN pinned_goal_id;'
      );
    })();
}

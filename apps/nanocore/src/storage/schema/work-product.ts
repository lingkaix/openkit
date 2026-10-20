import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/** Existing product metadata uses its retained v1 decoder, not the release-coupled wire schema. */
function metadata() {
  return {
    schemaVersion: integer('schema_version').notNull(),
    revision: integer('revision').notNull(),
    recordJson: text('record_json').notNull(),
  };
}

/** Workspace system metadata; authored configuration and other families keep their current owners. */
export const controlWorkspaces = sqliteTable('control_workspaces', {
  id: text('id').primaryKey().notNull(),
  ...metadata(),
});

/** Workspace and Server Thread metadata; a Server Thread has no invented Workspace. */
export const controlThreads = sqliteTable(
  'control_threads',
  {
    id: text('id').primaryKey().notNull(),
    workspaceId: text('workspace_id').references(() => controlWorkspaces.id),
    status: text('status').notNull(),
    ...metadata(),
  },
  (table) => [index('control_threads_workspace_idx').on(table.workspaceId, table.id)]
);

/** Existing AgentSession admission facts, including the explicitly NanoHost-specific retained representation. */
export const controlAgentSessions = sqliteTable('control_agent_sessions', {
  id: text('id').primaryKey().notNull(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => controlWorkspaces.id),
  threadId: text('thread_id').references(() => controlThreads.id),
  status: text('status').notNull(),
  ...metadata(),
});

/** Turn metadata and native single-flight constraints; payload bytes remain immutable content. */
export const controlTurns = sqliteTable(
  'control_turns',
  {
    id: text('id').primaryKey().notNull(),
    threadId: text('thread_id')
      .notNull()
      .references(() => controlThreads.id),
    agentSessionId: text('agent_session_id').references(() => controlAgentSessions.id),
    status: text('status').notNull(),
    ...metadata(),
  },
  (table) => [
    index('control_turns_thread_idx').on(table.threadId, table.id),
    uniqueIndex('control_turns_active_thread_idx')
      .on(table.threadId)
      .where(sql`${table.status} IN ('pending', 'running')`),
    uniqueIndex('control_turns_active_session_idx')
      .on(table.agentSessionId)
      .where(
        sql`${table.status} IN ('pending', 'running') AND ${table.agentSessionId} IS NOT NULL`
      ),
  ]
);

/** Ordered immutable Item revisions and event references; neither payloads nor another receipt ledger live here. */
export const controlProductEntries = sqliteTable(
  'control_product_entries',
  {
    kind: text('kind').$type<'item' | 'event'>().notNull(),
    turnId: text('turn_id')
      .notNull()
      .references(() => controlTurns.id),
    sequence: integer('sequence').notNull(),
    id: text('id').notNull(),
    revision: integer('revision').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    contentJson: text('content_json').notNull(),
    identityJson: text('identity_json').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.turnId, table.sequence] }),
    uniqueIndex('control_product_entries_revision_idx').on(table.kind, table.id, table.revision),
    check('control_product_entries_kind_check', sql`${table.kind} IN ('item', 'event')`),
    check(
      'control_product_entries_order_check',
      sql`${table.sequence} > 0 AND ${table.revision} > 0`
    ),
  ]
);

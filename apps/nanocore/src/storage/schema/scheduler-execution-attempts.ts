import { writeRetainedV1 } from '@openkit/protocol';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { schedulerAdmissionEntries } from './scheduler-admission-entries.js';

/** Execution authority has exactly these three durable phases. */
export type SchedulerExecutionAttemptPhase = 'open' | 'closing' | 'closed';

/** The exact outstanding operation's acceptance; unknown holds exclusion. */
export type SchedulerExecutionDisposition = 'not_accepted' | 'accepted' | 'unknown';

/** One attempt owns the original execution authority and its live scopes. */
export const schedulerExecutionAttempts = sqliteTable(
  'scheduler_execution_attempts',
  {
    /** Retained JSON payload format; native DDL versions scalar columns separately. */
    schemaVersion: integer('schema_version').notNull().default(writeRetainedV1({}).schemaVersion),
    /** Unique identity, never reused after closure. */
    attemptId: text('attempt_id').primaryKey().notNull(),
    /** Exact accepted queue entry and immutable preparation owner. */
    queueEntryId: text('queue_entry_id').notNull(),
    /** Exact product boundaries excluded by this attempt. */
    workspaceId: text('workspace_id').notNull(),
    threadId: text('thread_id').notNull(),
    turnId: text('turn_id').notNull(),
    /** Bound conditionally before AgentSession effects; queued work may be sessionless. */
    agentSessionId: text('agent_session_id'),
    /** Finalized immutable launch package and exact backend binding, once prepared. */
    inputRef: text('input_ref'),
    bindingRef: text('binding_ref'),
    /** Generic authority and exact outstanding operation. */
    phase: text('phase').$type<SchedulerExecutionAttemptPhase>().notNull(),
    disposition: text('disposition').$type<SchedulerExecutionDisposition>().notNull(),
    operationId: text('operation_id'),
    /** Fixed at submission; preparation and heartbeat never extend it. */
    deadline: text('deadline'),
    /** Keep the first terminal cause. */
    terminalCause: text('terminal_cause'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'scheduler_execution_attempts_admission_scope_fk',
      columns: [table.queueEntryId, table.workspaceId, table.threadId, table.turnId],
      foreignColumns: [
        schedulerAdmissionEntries.queueEntryId,
        schedulerAdmissionEntries.workspaceId,
        schedulerAdmissionEntries.threadId,
        schedulerAdmissionEntries.turnId,
      ],
    }),
    check(
      'scheduler_execution_attempts_phase_check',
      sql`${table.phase} IN ('open', 'closing', 'closed')`
    ),
    check(
      'scheduler_execution_attempts_disposition_check',
      sql`${table.disposition} IN ('not_accepted', 'accepted', 'unknown')`
    ),
    uniqueIndex('scheduler_execution_attempts_live_turn_idx')
      .on(table.turnId)
      .where(sql`${table.phase} <> 'closed'`),
    uniqueIndex('scheduler_execution_attempts_live_thread_idx')
      .on(table.workspaceId, table.threadId)
      .where(sql`${table.phase} <> 'closed'`),
    uniqueIndex('scheduler_execution_attempts_live_session_idx')
      .on(table.agentSessionId)
      .where(sql`${table.phase} <> 'closed' AND ${table.agentSessionId} IS NOT NULL`),
    index('scheduler_execution_attempts_queue_idx').on(table.queueEntryId),
    // Exact package lineage includes accepted closed attempts; live-only indexes cannot serve it.
    index('scheduler_execution_attempts_lineage_idx').on(
      table.workspaceId,
      table.threadId,
      table.turnId,
      table.agentSessionId,
      table.inputRef
    ),
    index('scheduler_execution_attempts_deadline_idx').on(table.phase, table.deadline),
  ]
);

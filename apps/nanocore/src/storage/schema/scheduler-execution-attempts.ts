import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Execution authority has exactly these three durable phases. */
export type SchedulerExecutionAttemptPhase = 'open' | 'closing' | 'closed';

/** The exact outstanding operation's acceptance; unknown holds exclusion. */
export type SchedulerExecutionDisposition = 'not_accepted' | 'accepted' | 'unknown';

/** One attempt owns generic execution authority; NanoHost proof columns are read only by its adapter. */
export const schedulerExecutionAttempts = sqliteTable(
  'scheduler_execution_attempts',
  {
    /** Unique identity, never reused after closure. */
    attemptId: text('attempt_id').primaryKey().notNull(),
    /** Exact accepted queue entry and immutable preparation owner. */
    queueEntryId: text('queue_entry_id').notNull(),
    /** Configured backend identity captured by admission. */
    backendId: text('backend_id').notNull(),
    /** Exact product boundaries excluded by this attempt. */
    workspaceId: text('workspace_id').notNull(),
    threadId: text('thread_id').notNull(),
    turnId: text('turn_id').notNull(),
    /** Bound conditionally before AgentSession effects; queued work may be sessionless. */
    agentSessionId: text('agent_session_id'),
    /** Immutable inputs persisted before any preparation effect. */
    preparationInputJson: text('preparation_input_json').notNull(),
    /** Finalized immutable launch package and exact backend binding, once prepared. */
    inputRef: text('input_ref'),
    bindingRef: text('binding_ref'),
    /** Generic authority and exact outstanding operation. */
    phase: text('phase').$type<SchedulerExecutionAttemptPhase>().notNull(),
    disposition: text('disposition').$type<SchedulerExecutionDisposition>().notNull(),
    operationId: text('operation_id'),
    /** Fixed at submission; preparation and heartbeat never extend it. */
    deadline: text('deadline'),
    /** First terminal cause and truthful actual result are never overwritten. */
    terminalCause: text('terminal_cause'),
    outcomeRef: text('outcome_ref'),
    fenceRef: text('fence_ref'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    /** Adapter-private compatibility and native liveness facts, not generic lifecycle phases. */
    sessionCompatibilityKey: text('session_compatibility_key'),
    heartbeatTimeoutMs: integer('heartbeat_timeout_ms').notNull().default(30_000),
    heartbeatDeadline: text('heartbeat_deadline'),
    startupDeadline: text('startup_deadline'),
    lastAcceptedHeartbeatAt: text('last_accepted_heartbeat_at'),
    lastWorkerSequence: integer('last_worker_sequence'),
    recoveryState: text('recovery_state'),
    recoveryDeadline: text('recovery_deadline'),
    workerProcessKeyHash: text('worker_process_key_hash'),
    workerControlTokenHash: text('worker_control_token_hash'),
    workerInferenceTokenHash: text('worker_inference_token_hash'),
    workerCapabilityTokenHash: text('worker_capability_token_hash'),
  },
  (table) => [
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
    index('scheduler_execution_attempts_deadline_idx').on(table.phase, table.deadline),
  ]
);

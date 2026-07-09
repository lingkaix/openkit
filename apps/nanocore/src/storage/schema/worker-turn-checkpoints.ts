import type { StopReason } from '@openkit/protocol';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import type { WorkerTurnStage } from '../../runtime/worker-stage.js';

/**
 * Worker checkpoint rows used for recovery and diagnostics.
 */
export const workerTurnCheckpoints = sqliteTable(
  'worker_turn_checkpoints',
  {
    /** Stable checkpoint id derived from workspace, thread, and turn ids. */
    checkpointId: text('checkpoint_id').primaryKey().notNull(),
    /** Workspace that owns the worker turn. */
    workspaceId: text('workspace_id').notNull(),
    /** Thread that owns the worker turn. */
    threadId: text('thread_id').notNull(),
    /** Turn represented by the checkpoint. */
    turnId: text('turn_id').notNull(),
    /** Optional goal id associated with the worker turn. */
    goalId: text('goal_id'),
    /** Optional goal task id associated with the worker turn. */
    taskId: text('task_id'),
    /** Recovery stage recorded for the worker turn. */
    stage: text('stage').$type<WorkerTurnStage>().notNull(),
    /** Worker iteration count at the checkpoint. */
    iteration: integer('iteration').notNull(),
    /** Optional host worker session id. */
    workerSessionId: text('worker_session_id'),
    /** Optional context package digest used by the worker. */
    contextDigest: text('context_digest'),
    /** Optional terminal stop reason when known. */
    stopReason: text('stop_reason').$type<StopReason | null>(),
    /** Redacted checkpoint diagnostics summary. */
    diagnosticsSummary: text('diagnostics_summary'),
    /** Whether this row is a replay instruction; V1 always stores false. */
    replayInstruction: integer('replay_instruction', { mode: 'boolean' }).notNull().default(false),
    /** ISO timestamp for checkpoint creation. */
    createdAt: text('created_at').notNull(),
    /** ISO timestamp for latest checkpoint update. */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('worker_turn_checkpoints_scope_idx').on(table.workspaceId, table.threadId, table.turnId),
    index('worker_turn_checkpoints_updated_idx').on(table.updatedAt),
  ]
);

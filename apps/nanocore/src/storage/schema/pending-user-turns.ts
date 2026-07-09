import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Pending user turn delivery modes while a thread is busy.
 */
export type PendingUserTurnQueueMode = 'safe_point_steering' | 'follow_up' | 'blocked_gate';

/**
 * Durable pending user input rows awaiting safe delivery.
 */
export const pendingUserTurns = sqliteTable(
  'pending_user_turns',
  {
    /** Stable pending row id derived from workspace, thread, and request id. */
    pendingTurnId: text('pending_turn_id').primaryKey().notNull(),
    /** Workspace that owns the pending input. */
    workspaceId: text('workspace_id').notNull(),
    /** Thread that owns the pending input. */
    threadId: text('thread_id').notNull(),
    /** Idempotency request id from the submitting command. */
    requestId: text('request_id').notNull(),
    /** Optional durable content item id for the submitted input. */
    contentItemId: text('content_item_id'),
    /** Optional digest when the submitted content is represented indirectly. */
    contentDigest: text('content_digest'),
    /** Queue mode that controls later steering or follow-up delivery. */
    queueMode: text('queue_mode', {
      enum: ['safe_point_steering', 'follow_up', 'blocked_gate'],
    })
      .$type<PendingUserTurnQueueMode>()
      .notNull(),
    /** ISO timestamp when NanoCore received the input. */
    receivedAt: text('received_at').notNull(),
    /** ISO timestamp when the pending row was first created. */
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('pending_user_turns_scope_idx').on(
      table.workspaceId,
      table.threadId,
      table.receivedAt,
      table.pendingTurnId
    ),
  ]
);

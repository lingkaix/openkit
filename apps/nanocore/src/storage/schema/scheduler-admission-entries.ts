import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Durable scheduler admission priority classes. */
export type SchedulerAdmissionPriorityClass = 'interactive' | 'automation' | 'maintenance';

/** Durable scheduler admission statuses. */
export type SchedulerAdmissionStatus = 'queued' | 'admitted' | 'denied' | 'cancelled' | 'expired';

/** Typed scheduler admission denial reasons. */
export type SchedulerAdmissionDenialReason =
  | 'queue-full'
  | 'no-compatible-pool'
  | 'no-healthy-target'
  | 'policy-cap'
  | 'budget-exhausted';

/** Server-scoped durable scheduler admission queue rows. */
export const schedulerAdmissionEntries = sqliteTable(
  'scheduler_admission_entries',
  {
    /** Stable queue entry id. */
    queueEntryId: text('queue_entry_id').primaryKey().notNull(),
    /** Original command request id used for event correlation. */
    requestId: text('request_id'),
    /** Store owner user id used to reopen the correct workspace store. */
    userId: text('user_id').notNull(),
    /** Workspace lineage id. */
    workspaceId: text('workspace_id').notNull(),
    /** Thread lineage id. */
    threadId: text('thread_id').notNull(),
    /** Turn lineage id. */
    turnId: text('turn_id').notNull(),
    /** Worker turn input captured when the entry is queued. */
    turnInput: text('turn_input').notNull(),
    /** Requested agent id. */
    requestedAgentId: text('requested_agent_id').notNull(),
    /** Requested agent profile reference. */
    profileRef: text('profile_ref').notNull(),
    /** Scheduler priority class. */
    priorityClass: text('priority_class').$type<SchedulerAdmissionPriorityClass>().notNull(),
    /** Entry enqueue timestamp. */
    enqueuedAt: text('enqueued_at').notNull(),
    /** Timestamp used for aging-aware queue ordering. */
    effectivePriorityAt: text('effective_priority_at').notNull(),
    /** First timestamp when a cap deferred dispatch. */
    firstCapDeferredAt: text('first_cap_deferred_at'),
    /** JSON array of required pool constraints. */
    requiredPoolConstraintsJson: text('required_pool_constraints_json').notNull(),
    /** Admission entry status. */
    status: text('status').$type<SchedulerAdmissionStatus>().notNull(),
    /** Typed denial reason when denied. */
    denialReason: text('denial_reason').$type<SchedulerAdmissionDenialReason>(),
  },
  (table) => [
    index('scheduler_admission_entries_queue_idx').on(
      table.status,
      table.priorityClass,
      table.effectivePriorityAt,
      table.enqueuedAt
    ),
    index('scheduler_admission_entries_workspace_idx').on(
      table.workspaceId,
      table.status,
      table.enqueuedAt
    ),
  ]
);

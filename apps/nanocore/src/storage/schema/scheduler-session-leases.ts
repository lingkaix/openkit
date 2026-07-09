import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Durable scheduler session lease statuses. */
export type SchedulerSessionLeaseStatus =
  | 'planned'
  | 'acquired'
  | 'starting'
  | 'active'
  | 'idle'
  | 'stale'
  | 'releasing'
  | 'released'
  | 'lost'
  | 'failed';

/** Server-scoped durable scheduler session lease rows. */
export const schedulerSessionLeases = sqliteTable(
  'scheduler_session_leases',
  {
    /** Stable session lease id. */
    leaseId: text('lease_id').primaryKey().notNull(),
    /** Linked placement plan id. */
    planId: text('plan_id').notNull(),
    /** Workspace lineage id. */
    workspaceId: text('workspace_id').notNull(),
    /** Thread lineage id. */
    threadId: text('thread_id').notNull(),
    /** Turn lineage id. */
    turnId: text('turn_id').notNull(),
    /** Agent session lineage id. */
    agentSessionId: text('agent_session_id').notNull(),
    /** Agent environment package snapshot id. */
    packageSnapshotId: text('package_snapshot_id').notNull(),
    /** Session workspace compatibility digest used by future reuse gates. */
    sessionCompatibilityKey: text('session_compatibility_key'),
    /** Scheduler pool id. */
    poolId: text('pool_id').notNull(),
    /** Scheduler target id. */
    targetId: text('target_id').notNull(),
    /** Lease lifecycle status. */
    status: text('status').$type<SchedulerSessionLeaseStatus>().notNull(),
    /** Lease acquisition timestamp. */
    acquiredAt: text('acquired_at').notNull(),
    /** Lease expiry timestamp. */
    expiresAt: text('expires_at').notNull(),
    /** Heartbeat deadline timestamp. */
    heartbeatDeadline: text('heartbeat_deadline').notNull(),
    /** Startup deadline timestamp. */
    startupDeadline: text('startup_deadline').notNull(),
    /** Last accepted heartbeat timestamp. */
    lastAcceptedHeartbeatAt: text('last_accepted_heartbeat_at'),
    /** Last worker sequence observed. */
    lastWorkerSequence: integer('last_worker_sequence'),
    /** Lease renewal count. */
    renewalCount: integer('renewal_count').notNull(),
    /** Scheduler epoch that owns this lease. */
    schedulerEpoch: integer('scheduler_epoch').notNull(),
    /** Non-secret sandbox binding reference. */
    sandboxBindingRef: text('sandbox_binding_ref').notNull(),
    /** Release reason for terminal leases. */
    releaseReason: text('release_reason'),
    /** Recovery state for terminal or takeover leases. */
    recoveryState: text('recovery_state'),
  },
  (table) => [
    index('scheduler_session_leases_plan_idx').on(table.planId, table.status),
    index('scheduler_session_leases_lineage_idx').on(
      table.workspaceId,
      table.threadId,
      table.turnId
    ),
    index('scheduler_session_leases_target_idx').on(table.poolId, table.targetId, table.status),
    index('scheduler_session_leases_deadline_idx').on(
      table.status,
      table.expiresAt,
      table.heartbeatDeadline
    ),
  ]
);

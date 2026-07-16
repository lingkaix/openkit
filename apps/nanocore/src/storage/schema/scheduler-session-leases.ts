import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
    /** Durable proof that the pre-effect backend anchor transaction completed. */
    backendAnchorState: text('backend_anchor_state')
      .$type<'unanchored' | 'anchored'>()
      .notNull()
      .default('unanchored'),
    /** Release reason for terminal leases. */
    releaseReason: text('release_reason'),
    /** Recovery state for terminal or takeover leases. */
    recoveryState: text('recovery_state'),
    /** Fixed deadline for a surviving worker process to reconnect after NanoCore restarts. */
    recoveryDeadline: text('recovery_deadline'),
    /** SHA-256 digest of the worker process's memory-only reconnect key. */
    workerProcessKeyHash: text('worker_process_key_hash'),
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
    index('scheduler_session_leases_recovery_idx').on(table.recoveryState, table.recoveryDeadline),
    uniqueIndex('scheduler_session_leases_binding_idx').on(table.sandboxBindingRef),
  ]
);

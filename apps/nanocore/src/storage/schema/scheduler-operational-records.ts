import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Durable scheduler worker pool statuses. */
export type SchedulerWorkerPoolStatus = 'active' | 'draining' | 'disabled';

/** Durable scheduler capacity observation sources. */
export type SchedulerCapacityObservationSource = 'probe' | 'report' | 'configured';

/** Durable scheduler target health states. */
export type SchedulerTargetHealthState =
  | 'healthy'
  | 'degraded'
  | 'quarantined'
  | 'probation'
  | 'unavailable';

/** Server-scoped durable scheduler worker pool rows. */
export const schedulerWorkerPools = sqliteTable(
  'scheduler_worker_pools',
  {
    /** Stable worker pool id. */
    poolId: text('pool_id').primaryKey().notNull(),
    /** JSON array of allowed backend kinds. */
    allowedBackendKindsJson: text('allowed_backend_kinds_json').notNull(),
    /** JSON array of allowed placements. */
    allowedPlacementsJson: text('allowed_placements_json').notNull(),
    /** Maximum concurrent sessions. */
    maxConcurrentSessions: integer('max_concurrent_sessions').notNull(),
    /** Queue entry limit for this pool. */
    queueLimit: integer('queue_limit').notNull(),
    /** Default timeout in milliseconds. */
    defaultTimeoutMs: integer('default_timeout_ms').notNull(),
    /** JSON array of allowed workspace scopes. */
    allowedWorkspaceScopesJson: text('allowed_workspace_scopes_json').notNull(),
    /** Budget class. */
    budgetClass: text('budget_class').notNull(),
    /** Redacted health summary. */
    healthSummary: text('health_summary').notNull(),
    /** Current admitted-session count. */
    currentAdmittedSessionCount: integer('current_admitted_session_count').notNull(),
    /** Current queue depth. */
    currentQueueDepth: integer('current_queue_depth').notNull(),
    /** Pool status. */
    status: text('status').$type<SchedulerWorkerPoolStatus>().notNull(),
    /** Reserved warm-session target. */
    warmSessionTarget: integer('warm_session_target'),
  },
  (table) => [index('scheduler_worker_pools_status_idx').on(table.status, table.budgetClass)]
);

/** Server-scoped durable scheduler capacity summary rows. */
export const schedulerCapacityRecords = sqliteTable(
  'scheduler_capacity_records',
  {
    /** Stable target id. */
    targetId: text('target_id').primaryKey().notNull(),
    /** Owning pool id. */
    poolId: text('pool_id').notNull(),
    /** Capacity class. */
    capacityClass: text('capacity_class').notNull(),
    /** Concurrency ceiling. */
    concurrencyCeiling: integer('concurrency_ceiling').notNull(),
    /** Sessions currently in use. */
    inUseCount: integer('in_use_count').notNull(),
    /** Queue depth attributable to this target. */
    queueDepth: integer('queue_depth').notNull(),
    /** Observation timestamp. */
    observedAt: text('observed_at').notNull(),
    /** Observation source. */
    observationSource: text('observation_source')
      .$type<SchedulerCapacityObservationSource>()
      .notNull(),
    /** Monotonic capacity record version. */
    version: integer('version').notNull(),
  },
  (table) => [index('scheduler_capacity_records_pool_idx').on(table.poolId, table.observedAt)]
);

/** Server-scoped durable scheduler target health rows. */
export const schedulerTargetHealthRecords = sqliteTable(
  'scheduler_target_health_records',
  {
    /** Stable target id. */
    targetId: text('target_id').primaryKey().notNull(),
    /** Target health state. */
    healthState: text('health_state').$type<SchedulerTargetHealthState>().notNull(),
    /** JSON array of per-surface check results. */
    checkResultsJson: text('check_results_json').notNull(),
    /** Consecutive required-check failure count. */
    consecutiveFailureCount: integer('consecutive_failure_count').notNull(),
    /** Consecutive required-check success count. */
    consecutiveSuccessCount: integer('consecutive_success_count').notNull(),
    /** Quarantine entry timestamp. */
    quarantineEnteredAt: text('quarantine_entered_at'),
    /** Probation deadline timestamp. */
    probationDeadline: text('probation_deadline'),
    /** Last probe timestamp. */
    lastProbeAt: text('last_probe_at').notNull(),
    /** Next scheduled probe timestamp. */
    nextProbeAt: text('next_probe_at').notNull(),
  },
  (table) => [
    index('scheduler_target_health_records_state_idx').on(table.healthState, table.nextProbeAt),
  ]
);

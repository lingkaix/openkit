import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Durable scheduler placement plan statuses. */
export type SchedulerPlacementPlanStatus =
  | 'planned'
  | 'executing'
  | 'superseded'
  | 'abandoned'
  | 'completed';

/** Server-scoped durable scheduler placement plan rows. */
export const schedulerPlacementPlans = sqliteTable(
  'scheduler_placement_plans',
  {
    /** Stable placement plan id. */
    planId: text('plan_id').primaryKey().notNull(),
    /** Linked scheduler admission queue entry id. */
    queueEntryId: text('queue_entry_id').notNull(),
    /** Workspace lineage id. */
    workspaceId: text('workspace_id').notNull(),
    /** Thread lineage id. */
    threadId: text('thread_id').notNull(),
    /** Turn lineage id. */
    turnId: text('turn_id').notNull(),
    /** Selected scheduler pool id. */
    selectedPoolId: text('selected_pool_id').notNull(),
    /** Selected target id. */
    selectedTargetId: text('selected_target_id').notNull(),
    /** Planned lease duration in milliseconds. */
    plannedLeaseDurationMs: integer('planned_lease_duration_ms').notNull(),
    /** Heartbeat interval in milliseconds. */
    heartbeatIntervalMs: integer('heartbeat_interval_ms').notNull(),
    /** Heartbeat timeout in milliseconds. */
    heartbeatTimeoutMs: integer('heartbeat_timeout_ms').notNull(),
    /** Expected worker control mode. */
    expectedControlMode: text('expected_control_mode').notNull(),
    /** Expected worker data-plane mode. */
    expectedDataPlaneMode: text('expected_data_plane_mode').notNull(),
    /** JSON array of degraded optional features accepted at plan time. */
    degradedOptionalFeaturesJson: text('degraded_optional_features_json').notNull(),
    /** Failover target id when policy allows one. */
    failoverTargetId: text('failover_target_id'),
    /** JSON array of policy decision ids consulted. */
    policyDecisionIdsJson: text('policy_decision_ids_json').notNull(),
    /** Capacity snapshot reference used by the decision. */
    capacitySnapshotRef: text('capacity_snapshot_ref'),
    /** Placement plan status. */
    status: text('status').$type<SchedulerPlacementPlanStatus>().notNull(),
    /** Creation timestamp. */
    createdAt: text('created_at').notNull(),
    /** Scheduler epoch that produced this plan. */
    schedulerEpoch: integer('scheduler_epoch').notNull(),
  },
  (table) => [
    index('scheduler_placement_plans_queue_idx').on(table.queueEntryId, table.status),
    index('scheduler_placement_plans_lineage_idx').on(
      table.workspaceId,
      table.threadId,
      table.turnId
    ),
    index('scheduler_placement_plans_target_idx').on(
      table.selectedPoolId,
      table.selectedTargetId,
      table.status
    ),
  ]
);

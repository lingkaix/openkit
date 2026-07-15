import { sql } from 'drizzle-orm';
import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Durable lifecycle states for one physical worker backend session. */
export type WorkerBackendSessionState =
  | 'materializing'
  | 'materialized'
  | 'launching'
  | 'cleanup-pending'
  | 'cleanup-failed'
  | 'physical-cleaned'
  | 'cleaned';

/** Runtime placements supported by the durable worker backend identity. */
export type WorkerBackendSessionPlacement = 'local' | 'remote';

/** Cross-database publication phase for workspace materialization handles. */
export type WorkerBackendWorkspaceHandoffState = 'pending' | 'complete';

/** Package-scoped physical worker sessions owned by scheduler leases. */
export const workerBackendSessions = sqliteTable(
  'worker_backend_sessions',
  {
    /** Scheduler lease that exclusively owns this physical session. */
    leaseId: text('lease_id').primaryKey().notNull(),
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
    /** Physical backend family. */
    backendKind: text('backend_kind').notNull(),
    /** Stable data-root deployment that owns every physical artifact. */
    deploymentId: text('deployment_id').notNull(),
    /** Backend implementation version captured before physical effects. */
    backendVersion: text('backend_version'),
    /** Immutable worker image reference captured from the package. */
    workerImage: text('worker_image').notNull(),
    /** Stable non-secret binding for the exact Cell lifecycle target. */
    cellTargetId: text('cell_target_id').notNull(),
    /** Local or remote backend placement. */
    placement: text('placement').$type<WorkerBackendSessionPlacement>().notNull(),
    /** Exact gateway name used for physical effects. */
    gatewayName: text('gateway_name').notNull(),
    /** Exact direct gateway endpoint, when configured. */
    gatewayEndpoint: text('gateway_endpoint'),
    /** Backend-native physical session id. */
    backendSessionId: text('backend_session_id').notNull(),
    /** Data-root-relative directory containing backend-private staging files. */
    stagingDirectoryRef: text('staging_directory_ref').notNull(),
    /** Exact transient backend provider removed with the physical Cell epoch. */
    transientProviderInstanceId: text('transient_provider_instance_id'),
    /** Whether the exact workspace handle set was durably published. */
    workspaceHandoffState: text('workspace_handoff_state')
      .$type<WorkerBackendWorkspaceHandoffState>()
      .notNull(),
    /** Durable physical lifecycle state. */
    state: text('state').$type<WorkerBackendSessionState>().notNull(),
    /** Stable physical cleanup completion time, set exactly once. */
    physicalCleanedAt: text('physical_cleaned_at'),
    /** Creation timestamp. */
    createdAt: text('created_at').notNull(),
    /** Last lifecycle transition timestamp. */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('worker_backend_sessions_lineage_idx').on(
      table.workspaceId,
      table.threadId,
      table.turnId,
      table.agentSessionId,
      table.packageSnapshotId
    ),
    index('worker_backend_sessions_state_idx').on(table.state, table.updatedAt),
    uniqueIndex('worker_backend_sessions_package_idx').on(table.packageSnapshotId),
    uniqueIndex('worker_backend_sessions_staging_idx').on(table.stagingDirectoryRef),
    uniqueIndex('worker_backend_sessions_named_target_idx')
      .on(table.backendKind, table.gatewayName, table.backendSessionId)
      .where(sql`${table.gatewayEndpoint} IS NULL`),
    uniqueIndex('worker_backend_sessions_endpoint_target_idx')
      .on(table.backendKind, table.gatewayEndpoint, table.backendSessionId)
      .where(sql`${table.gatewayEndpoint} IS NOT NULL`),
    uniqueIndex('worker_backend_sessions_named_provider_idx')
      .on(table.backendKind, table.gatewayName, table.transientProviderInstanceId)
      .where(
        sql`${table.gatewayEndpoint} IS NULL AND ${table.transientProviderInstanceId} IS NOT NULL`
      ),
    uniqueIndex('worker_backend_sessions_endpoint_provider_idx')
      .on(table.backendKind, table.gatewayEndpoint, table.transientProviderInstanceId)
      .where(
        sql`${table.gatewayEndpoint} IS NOT NULL AND ${table.transientProviderInstanceId} IS NOT NULL`
      ),
  ]
);

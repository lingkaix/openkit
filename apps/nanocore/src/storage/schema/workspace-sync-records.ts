import { index, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Durable workspace input snapshots scoped by workspace.
 */
export const workspaceInputSnapshots = sqliteTable(
  'workspace_input_snapshots',
  {
    /** Stable workspace input snapshot id. */
    inputSnapshotId: text('input_snapshot_id').notNull(),
    /** Workspace that owns the snapshot. */
    workspaceId: text('workspace_id').notNull(),
    /** Workspace resource represented by the snapshot. */
    resourceId: text('resource_id').notNull(),
    /** Synchronization strategy selected by NanoCore. */
    strategy: text('strategy').notNull(),
    /** Schema-validated public payload JSON. */
    payloadJson: text('payload_json').notNull(),
    /** ISO timestamp for record creation. */
    createdAt: text('created_at').notNull(),
    /** ISO timestamp for latest record update. */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.inputSnapshotId] }),
    index('workspace_input_snapshots_resource_idx').on(
      table.workspaceId,
      table.resourceId,
      table.createdAt,
      table.inputSnapshotId
    ),
  ]
);

/**
 * Durable workspace materialization records scoped by workspace.
 */
export const workspaceMaterializationRecords = sqliteTable(
  'workspace_materialization_records',
  {
    /** Stable materialization record id. */
    materializationRecordId: text('materialization_record_id').notNull(),
    /** Workspace that owns the materialization. */
    workspaceId: text('workspace_id').notNull(),
    /** Input snapshot used to create the materialization. */
    inputSnapshotId: text('input_snapshot_id').notNull(),
    /** Worker session associated with the materialization. */
    workerSessionId: text('worker_session_id').notNull(),
    /** Synchronization strategy selected by NanoCore. */
    strategy: text('strategy').notNull(),
    /** Schema-validated public payload JSON. */
    payloadJson: text('payload_json').notNull(),
    /** ISO timestamp for record creation. */
    createdAt: text('created_at').notNull(),
    /** ISO timestamp for latest record update. */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.materializationRecordId] }),
    index('workspace_materialization_records_input_idx').on(
      table.workspaceId,
      table.inputSnapshotId,
      table.createdAt,
      table.materializationRecordId
    ),
  ]
);

/**
 * Durable redacted backend workspace handles scoped by workspace.
 */
export const backendWorkspaceHandles = sqliteTable(
  'backend_workspace_handles',
  {
    /** Stable backend workspace handle id. */
    backendWorkspaceHandleId: text('backend_workspace_handle_id').notNull(),
    /** Workspace that owns the handle. */
    workspaceId: text('workspace_id').notNull(),
    /** Materialization record that produced this handle. */
    materializationRecordId: text('materialization_record_id').notNull(),
    /** Worker backend kind. */
    backendKind: text('backend_kind').notNull(),
    /** Worker session associated with the backend handle. */
    workerSessionId: text('worker_session_id').notNull(),
    /** Schema-validated redacted payload JSON. */
    payloadJson: text('payload_json').notNull(),
    /** ISO timestamp for record creation. */
    createdAt: text('created_at').notNull(),
    /** ISO timestamp for latest record update. */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.backendWorkspaceHandleId] }),
    index('backend_workspace_handles_materialization_idx').on(
      table.workspaceId,
      table.materializationRecordId,
      table.createdAt,
      table.backendWorkspaceHandleId
    ),
  ]
);

/**
 * Durable worker output manifests scoped by workspace.
 */
export const workerOutputManifests = sqliteTable(
  'worker_output_manifests',
  {
    /** Stable worker output manifest id. */
    workerOutputManifestId: text('worker_output_manifest_id').notNull(),
    /** Workspace that owns the manifest. */
    workspaceId: text('workspace_id').notNull(),
    /** Materialization record that produced this output. */
    materializationRecordId: text('materialization_record_id').notNull(),
    /** Input snapshot used to create the materialization. */
    inputSnapshotId: text('input_snapshot_id').notNull(),
    /** Worker session associated with the output. */
    workerSessionId: text('worker_session_id').notNull(),
    /** Worker backend kind. */
    backendKind: text('backend_kind').notNull(),
    /** Synchronization strategy selected by NanoCore. */
    strategy: text('strategy').notNull(),
    /** Schema-validated public payload JSON. */
    payloadJson: text('payload_json').notNull(),
    /** ISO timestamp for record creation. */
    createdAt: text('created_at').notNull(),
    /** ISO timestamp for latest record update. */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.workerOutputManifestId] }),
    index('worker_output_manifests_materialization_idx').on(
      table.workspaceId,
      table.materializationRecordId,
      table.createdAt,
      table.workerOutputManifestId
    ),
  ]
);

/**
 * Durable worker-produced workspace change sets scoped by workspace.
 */
export const workspaceChangeSets = sqliteTable(
  'workspace_change_sets',
  {
    /** Stable workspace change set id. */
    changeSetId: text('change_set_id').notNull(),
    /** Workspace that owns the change set. */
    workspaceId: text('workspace_id').notNull(),
    /** Input snapshot used for the worker materialization. */
    inputSnapshotId: text('input_snapshot_id').notNull(),
    /** Materialization record that produced the change set. */
    materializationRecordId: text('materialization_record_id').notNull(),
    /** Workspace resource changed by the worker. */
    resourceId: text('resource_id').notNull(),
    /** Synchronization strategy selected by NanoCore. */
    strategy: text('strategy').notNull(),
    /** Schema-validated public payload JSON. */
    payloadJson: text('payload_json').notNull(),
    /** ISO timestamp for record creation. */
    createdAt: text('created_at').notNull(),
    /** ISO timestamp for latest record update. */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.changeSetId] }),
    index('workspace_change_sets_materialization_idx').on(
      table.workspaceId,
      table.materializationRecordId,
      table.createdAt,
      table.changeSetId
    ),
  ]
);

/**
 * Durable staged workspace review records scoped by workspace.
 */
export const stagedWorkspaceReviews = sqliteTable(
  'staged_workspace_reviews',
  {
    /** Stable staged review id. */
    reviewId: text('review_id').notNull(),
    /** Workspace that owns the review. */
    workspaceId: text('workspace_id').notNull(),
    /** Change set staged for review. */
    changeSetId: text('change_set_id').notNull(),
    /** Artifact that currently exposes the review payload. */
    artifactId: text('artifact_id').notNull(),
    /** Current staged review status. */
    status: text('status').notNull(),
    /** Schema-validated public review payload JSON. */
    payloadJson: text('payload_json').notNull(),
    /** Optional schema-validated public patch payload JSON. */
    patchPayloadJson: text('patch_payload_json'),
    /** ISO timestamp for record creation. */
    createdAt: text('created_at').notNull(),
    /** ISO timestamp for latest record update. */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.reviewId] }),
    index('staged_workspace_reviews_change_set_idx').on(
      table.workspaceId,
      table.changeSetId,
      table.updatedAt,
      table.reviewId
    ),
  ]
);

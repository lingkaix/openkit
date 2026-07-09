import {
  type BackendWorkspaceHandle,
  BackendWorkspaceHandleSchema,
  type StagedWorkspaceReview,
  StagedWorkspaceReviewSchema,
  type StagedWorkspaceReviewStatus,
  type WorkerOutputManifest,
  WorkerOutputManifestSchema,
  type WorkspaceChangeSet,
  WorkspaceChangeSetSchema,
  type WorkspaceInputSnapshot,
  WorkspaceInputSnapshotSchema,
  type WorkspaceMaterializationRecord,
  WorkspaceMaterializationRecordSchema,
  type WorkspaceSyncReviewItem,
  type WorkspaceSyncReviewPatchPayload,
  WorkspaceSyncReviewPatchPayloadSchema,
} from '@openkit/app-api-schemas';
import { recordWorkspaceAuditEvent } from '../audit-events.js';
import { recordWorkspaceEvidenceBundle } from '../evidence-bundles.js';
import type { WorkspaceDb } from '../storage/db.js';
import { recordMaterializationRuntimeEvidence } from './runtime-evidence.js';

/** Durable workspace synchronization review persistence input. */
export interface RecordWorkspaceSyncReviewInput {
  /** Public workspace synchronization review item. */
  readonly item: WorkspaceSyncReviewItem;
}

/** Durable workspace synchronization review decision persistence input. */
export interface UpdateWorkspaceSyncReviewDecisionInput {
  /** Workspace that owns the staged review. */
  readonly workspaceId: string;
  /** Staged review id to resolve. */
  readonly reviewId: string;
  /** Terminal status selected by the human reviewer. */
  readonly status: Exclude<StagedWorkspaceReviewStatus, 'pending'>;
  /** Decision timestamp. */
  readonly updatedAt: string;
}

/** Exported staged review row without duplicating its backing change set. */
export interface ExportedStagedWorkspaceReview {
  /** Artifact id that carries review artifacts. */
  readonly artifactId: string;
  /** Stored staged review payload. */
  readonly review: StagedWorkspaceReview;
  /** Optional redacted patch payload retained for review UX. */
  readonly patchPayload: WorkspaceSyncReviewPatchPayload | null;
}

/** Complete workspace sync row-family bundle for export. */
export interface ExportableWorkspaceSyncRecords {
  /** Durable input snapshots. */
  readonly inputSnapshots: readonly WorkspaceInputSnapshot[];
  /** Durable materialization records. */
  readonly materializationRecords: readonly WorkspaceMaterializationRecord[];
  /** Durable redacted backend workspace handles. */
  readonly backendWorkspaceHandles: readonly BackendWorkspaceHandle[];
  /** Durable worker output manifests. */
  readonly workerOutputManifests: readonly WorkerOutputManifest[];
  /** Durable worker-produced change sets. */
  readonly changeSets: readonly WorkspaceChangeSet[];
  /** Durable staged review rows. */
  readonly stagedReviews: readonly ExportedStagedWorkspaceReview[];
}

/** Workspace sync row-family bundle to replay during import. */
export interface ImportWorkspaceSyncRecordsInput extends ExportableWorkspaceSyncRecords {}

interface WorkspaceChangeSetRow {
  readonly change_set_id: string;
  readonly workspace_id: string;
  readonly input_snapshot_id: string;
  readonly materialization_record_id: string;
  readonly resource_id: string;
  readonly strategy: string;
  readonly payload_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface StagedWorkspaceReviewRow {
  readonly review_id: string;
  readonly workspace_id: string;
  readonly change_set_id: string;
  readonly artifact_id: string;
  readonly status: string;
  readonly payload_json: string;
  readonly patch_payload_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface RecordWorkspaceMaterializationRecordOptions {
  readonly promoteEvidence?: boolean;
}

/**
 * Persists one staged workspace review and its backing change-set lineage records.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Workspace review persistence input.
 * @returns Stored public workspace review item.
 */
export function recordWorkspaceSyncReview(
  workspaceDb: WorkspaceDb,
  input: RecordWorkspaceSyncReviewInput
): WorkspaceSyncReviewItem {
  const item = input.item;
  const parsedChangeSet = WorkspaceChangeSetSchema.parse(item.changeSet);
  const changeSet = withMaterializationSourceId(workspaceDb, parsedChangeSet);
  const review = StagedWorkspaceReviewSchema.parse(item.review);
  const patchPayload = item.patchPayload
    ? WorkspaceSyncReviewPatchPayloadSchema.parse(item.patchPayload)
    : null;
  const inputSnapshot = inferWorkspaceInputSnapshot(changeSet);
  const materializationRecord = inferWorkspaceMaterializationRecord(changeSet);
  const reviewAlreadyExists = Boolean(
    getWorkspaceSyncReview(workspaceDb, review.workspaceId, review.id)
  );

  recordWorkspaceInputSnapshot(workspaceDb, inputSnapshot);
  recordWorkspaceMaterializationRecord(workspaceDb, materializationRecord);
  recordWorkerOutputManifest(workspaceDb, inferWorkerOutputManifest(workspaceDb, changeSet));
  recordWorkspaceChangeSet(workspaceDb, changeSet);
  workspaceDb.sqlite
    .prepare(
      `INSERT INTO staged_workspace_reviews (
        review_id,
        workspace_id,
        change_set_id,
        artifact_id,
        status,
        payload_json,
        patch_payload_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, review_id) DO UPDATE SET
        artifact_id = excluded.artifact_id,
        patch_payload_json = excluded.patch_payload_json,
        payload_json = excluded.payload_json,
        status = excluded.status,
        updated_at = excluded.updated_at`
    )
    .run(
      review.id,
      review.workspaceId,
      review.changeSetId,
      item.artifactId,
      review.status,
      JSON.stringify(review),
      patchPayload ? JSON.stringify(patchPayload) : null,
      review.createdAt,
      review.updatedAt
    );

  if (!reviewAlreadyExists) {
    recordWorkspaceAuditEvent({
      action: 'workspace.review.stage',
      category: 'artifact',
      now: new Date(review.createdAt),
      outcome: 'succeeded',
      resource: `workspace-review:${review.id}`,
      severity: 'info',
      summary: workspaceReviewAuditSummary(changeSet),
      workspaceDb,
      workspaceId: review.workspaceId,
    });
    recordWorkspaceEvidenceBundle(workspaceDb, {
      id: `evb_workspace_review_${review.id}`,
      workspaceId: review.workspaceId,
      threadId: null,
      goalId: null,
      turnId: null,
      agentSessionId: null,
      backendType: null,
      sourceKind: 'workspace-sync-review',
      summary: workspaceReviewAuditSummary(changeSet),
      rawEvidenceRefs: [],
      redactedEvidenceRefs: [
        ...changeSet.evidenceRefs,
        ...(changeSet.patch ? [{ kind: 'workspace-sync-patch', ref: changeSet.patch.ref }] : []),
      ],
      contentDigests: changeSet.patch ? [changeSet.patch.digest] : [],
      retentionClass: 'workspace-audit',
      sensitivityClass: 'product-safe',
      importStatus: 'promoted',
      requiredFeatures: ['evidence.bundle.v1'],
      createdAt: review.createdAt,
    });
  }

  return requireWorkspaceSyncReview(workspaceDb, review.workspaceId, review.id);
}

/**
 * Builds a redacted staged workspace review audit summary.
 *
 * @param changeSet Durable change set.
 * @returns Redacted audit summary.
 */
function workspaceReviewAuditSummary(changeSet: WorkspaceChangeSet): string {
  return `Workspace review staged: ${changeSet.changedPaths.length} changed path, strategy ${changeSet.strategy}`;
}

/**
 * Persists durable workspace input snapshots.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param snapshots Input snapshots to persist.
 * @returns Stored input snapshots.
 */
export function recordWorkspaceInputSnapshots(
  workspaceDb: WorkspaceDb,
  snapshots: readonly WorkspaceInputSnapshot[]
): WorkspaceInputSnapshot[] {
  for (const snapshot of snapshots) {
    recordWorkspaceInputSnapshot(workspaceDb, snapshot);
  }

  return snapshots.map((snapshot) => WorkspaceInputSnapshotSchema.parse(snapshot));
}

/**
 * Persists durable workspace materialization records.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param records Materialization records to persist.
 * @returns Stored materialization records.
 */
export function recordWorkspaceMaterializationRecords(
  workspaceDb: WorkspaceDb,
  records: readonly WorkspaceMaterializationRecord[]
): WorkspaceMaterializationRecord[] {
  for (const record of records) {
    recordWorkspaceMaterializationRecord(workspaceDb, record);
  }

  return records.map((record) => WorkspaceMaterializationRecordSchema.parse(record));
}

/**
 * Lists durable staged workspace reviews for one workspace.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Stored workspace review items in stable newest-first order.
 */
export function listWorkspaceSyncReviews(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): WorkspaceSyncReviewItem[] {
  return (
    workspaceDb.sqlite
      .prepare(
        `SELECT
          review_id,
          workspace_id,
          change_set_id,
          artifact_id,
          status,
          payload_json,
          patch_payload_json,
          created_at,
          updated_at
        FROM staged_workspace_reviews
        WHERE workspace_id = ?
        ORDER BY updated_at ASC, review_id ASC`
      )
      .all(workspaceId) as StagedWorkspaceReviewRow[]
  )
    .map((row) => mapWorkspaceReviewRow(workspaceDb, row))
    .reverse();
}

/**
 * Reads one durable staged workspace review.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @param reviewId Staged review id.
 * @returns Stored workspace review item, or null.
 */
export function getWorkspaceSyncReview(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  reviewId: string
): WorkspaceSyncReviewItem | null {
  const row = workspaceDb.sqlite
    .prepare(
      `SELECT
        review_id,
        workspace_id,
        change_set_id,
        artifact_id,
        status,
        payload_json,
        patch_payload_json,
        created_at,
        updated_at
      FROM staged_workspace_reviews
      WHERE workspace_id = ? AND review_id = ?`
    )
    .get(workspaceId, reviewId) as StagedWorkspaceReviewRow | undefined;

  return row ? mapWorkspaceReviewRow(workspaceDb, row) : null;
}

/**
 * Records one durable staged workspace review decision.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Review decision persistence input.
 * @returns Updated public workspace review item.
 * @throws Error when the review does not exist or is no longer pending.
 */
export function updateWorkspaceSyncReviewDecision(
  workspaceDb: WorkspaceDb,
  input: UpdateWorkspaceSyncReviewDecisionInput
): WorkspaceSyncReviewItem {
  const item = requireWorkspaceSyncReview(workspaceDb, input.workspaceId, input.reviewId);

  if (item.review.status !== 'pending') {
    throw new Error(`Workspace synchronization review is already resolved: ${input.reviewId}`);
  }

  const review = StagedWorkspaceReviewSchema.parse({
    ...item.review,
    status: input.status,
    updatedAt: input.updatedAt,
  });

  workspaceDb.sqlite
    .prepare(
      `UPDATE staged_workspace_reviews
       SET status = ?, payload_json = ?, updated_at = ?
      WHERE workspace_id = ? AND review_id = ?`
    )
    .run(
      review.status,
      JSON.stringify(review),
      review.updatedAt,
      input.workspaceId,
      input.reviewId
    );

  recordWorkspaceAuditEvent({
    action: 'workspace.review.decide',
    category: 'artifact',
    now: new Date(input.updatedAt),
    outcome: 'succeeded',
    resource: `workspace-review:${review.id}`,
    severity: 'info',
    summary: `Workspace review ${review.id} resolved as ${review.status}.`,
    workspaceDb,
    workspaceId: review.workspaceId,
  });

  return requireWorkspaceSyncReview(workspaceDb, input.workspaceId, input.reviewId);
}

/**
 * Lists durable workspace input snapshots for one workspace.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Stored input snapshots in newest-first order.
 */
export function listWorkspaceInputSnapshots(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): WorkspaceInputSnapshot[] {
  return listPayloadRows(
    workspaceDb,
    'workspace_input_snapshots',
    workspaceId,
    WorkspaceInputSnapshotSchema
  );
}

/**
 * Lists durable workspace materialization records for one workspace.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Stored materialization records in newest-first order.
 */
export function listWorkspaceMaterializationRecords(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): WorkspaceMaterializationRecord[] {
  return listPayloadRows(
    workspaceDb,
    'workspace_materialization_records',
    workspaceId,
    WorkspaceMaterializationRecordSchema
  );
}

/**
 * Lists durable workspace change sets for one workspace.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Stored change sets in newest-first order.
 */
export function listWorkspaceChangeSets(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): WorkspaceChangeSet[] {
  return listPayloadRows(
    workspaceDb,
    'workspace_change_sets',
    workspaceId,
    WorkspaceChangeSetSchema
  );
}

/**
 * Lists durable worker output manifests for one workspace.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Stored output manifests in newest-first order.
 */
export function listWorkerOutputManifests(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): WorkerOutputManifest[] {
  return listPayloadRows(
    workspaceDb,
    'worker_output_manifests',
    workspaceId,
    WorkerOutputManifestSchema
  );
}

/**
 * Lists the full workspace synchronization row family in dependency order.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Exportable workspace sync row bundle.
 */
export function listExportableWorkspaceSyncRecords(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): ExportableWorkspaceSyncRecords {
  return {
    inputSnapshots: [...listWorkspaceInputSnapshots(workspaceDb, workspaceId)].reverse(),
    materializationRecords: [
      ...listWorkspaceMaterializationRecords(workspaceDb, workspaceId),
    ].reverse(),
    backendWorkspaceHandles: [...listBackendWorkspaceHandles(workspaceDb, workspaceId)].reverse(),
    workerOutputManifests: [...listWorkerOutputManifests(workspaceDb, workspaceId)].reverse(),
    changeSets: [...listWorkspaceChangeSets(workspaceDb, workspaceId)].reverse(),
    stagedReviews: [...listWorkspaceSyncReviews(workspaceDb, workspaceId)]
      .reverse()
      .map((item) => ({
        artifactId: item.artifactId,
        patchPayload: item.patchPayload,
        review: item.review,
      })),
  };
}

/**
 * Replays imported workspace synchronization records without creating new stage-review audit events.
 *
 * @param workspaceDb Open target workspace database handle.
 * @param input Importable workspace sync row bundle.
 */
export function importWorkspaceSyncRecords(
  workspaceDb: WorkspaceDb,
  input: ImportWorkspaceSyncRecordsInput
): void {
  for (const snapshot of input.inputSnapshots) {
    recordWorkspaceInputSnapshot(workspaceDb, WorkspaceInputSnapshotSchema.parse(snapshot));
  }
  for (const record of input.materializationRecords) {
    recordWorkspaceMaterializationRecord(
      workspaceDb,
      WorkspaceMaterializationRecordSchema.parse(record),
      { promoteEvidence: false }
    );
  }
  for (const handle of input.backendWorkspaceHandles) {
    recordBackendWorkspaceHandle(workspaceDb, BackendWorkspaceHandleSchema.parse(handle));
  }
  for (const manifest of input.workerOutputManifests) {
    recordWorkerOutputManifest(workspaceDb, WorkerOutputManifestSchema.parse(manifest));
  }
  for (const changeSet of input.changeSets) {
    recordWorkspaceChangeSet(workspaceDb, WorkspaceChangeSetSchema.parse(changeSet));
  }
  for (const stagedReview of input.stagedReviews) {
    const review = StagedWorkspaceReviewSchema.parse(stagedReview.review);
    const patchPayload = stagedReview.patchPayload
      ? WorkspaceSyncReviewPatchPayloadSchema.parse(stagedReview.patchPayload)
      : null;

    workspaceDb.sqlite
      .prepare(
        `INSERT OR IGNORE INTO staged_workspace_reviews (
          review_id,
          workspace_id,
          change_set_id,
          artifact_id,
          status,
          payload_json,
          patch_payload_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        review.id,
        review.workspaceId,
        review.changeSetId,
        stagedReview.artifactId,
        review.status,
        JSON.stringify(review),
        patchPayload ? JSON.stringify(patchPayload) : null,
        review.createdAt,
        review.updatedAt
      );
  }
}

/**
 * Persists one workspace input snapshot.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param snapshot Input snapshot to persist.
 */
function recordWorkspaceInputSnapshot(
  workspaceDb: WorkspaceDb,
  snapshot: WorkspaceInputSnapshot
): void {
  workspaceDb.sqlite
    .prepare(
      `INSERT OR IGNORE INTO workspace_input_snapshots (
        input_snapshot_id,
        workspace_id,
        resource_id,
        strategy,
        payload_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      snapshot.id,
      snapshot.workspaceId,
      snapshot.resourceId,
      snapshot.strategy,
      JSON.stringify(snapshot),
      snapshot.createdAt,
      snapshot.createdAt
    );
}

/**
 * Persists one workspace materialization record.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param record Materialization record to persist.
 */
function recordWorkspaceMaterializationRecord(
  workspaceDb: WorkspaceDb,
  record: WorkspaceMaterializationRecord,
  options: RecordWorkspaceMaterializationRecordOptions = {}
): void {
  const inserted = workspaceDb.sqlite
    .prepare(
      `INSERT OR IGNORE INTO workspace_materialization_records (
        materialization_record_id,
        workspace_id,
        input_snapshot_id,
        worker_session_id,
        strategy,
        payload_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.id,
      record.workspaceId,
      record.inputSnapshotId,
      record.workerSessionId,
      record.strategy,
      JSON.stringify(record),
      record.createdAt,
      record.createdAt
    );
  if (inserted.changes === 0 || options.promoteEvidence === false) {
    return;
  }

  recordBackendWorkspaceHandle(workspaceDb, inferBackendWorkspaceHandle(record));
  recordWorkspaceEvidenceBundle(workspaceDb, {
    id: `evb_workspace_materialization_${record.id}`,
    workspaceId: record.workspaceId,
    threadId: null,
    goalId: null,
    turnId: null,
    agentSessionId: null,
    backendType: record.backendKind,
    sourceKind: 'workspace-materialization',
    summary: `Workspace materialization recorded: strategy ${record.strategy}, backend ${record.backendKind}`,
    rawEvidenceRefs: [],
    redactedEvidenceRefs: record.readinessEvidence,
    contentDigests: [record.policyDigest],
    retentionClass: 'workspace-audit',
    sensitivityClass: 'product-safe',
    importStatus: 'promoted',
    requiredFeatures: ['evidence.bundle.v1'],
    createdAt: record.createdAt,
  });
  recordMaterializationRuntimeEvidence(workspaceDb, record);
}

/**
 * Lists durable backend workspace handles for one workspace.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Stored backend handles in newest-first order.
 */
export function listBackendWorkspaceHandles(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): BackendWorkspaceHandle[] {
  return listPayloadRows(
    workspaceDb,
    'backend_workspace_handles',
    workspaceId,
    BackendWorkspaceHandleSchema
  );
}

/**
 * Updates backend workspace handle cleanup status for one worker session.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @param workerSessionId Worker session id stored on backend handles.
 * @param cleanupStatus New cleanup status.
 * @param updatedAt Update timestamp.
 * @returns Updated backend handles in stable order.
 */
export function updateBackendWorkspaceHandleCleanupStatus(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  workerSessionId: string,
  cleanupStatus: BackendWorkspaceHandle['cleanupStatus'],
  updatedAt: string
): BackendWorkspaceHandle[] {
  const rows = workspaceDb.sqlite
    .prepare(
      `SELECT payload_json
       FROM backend_workspace_handles
       WHERE workspace_id = ? AND worker_session_id = ?
       ORDER BY created_at ASC, backend_workspace_handle_id ASC`
    )
    .all(workspaceId, workerSessionId) as Array<{ payload_json: string }>;
  const updated = rows.map((row) => {
    const handle = BackendWorkspaceHandleSchema.parse(JSON.parse(row.payload_json) as unknown);
    const effectiveCleanupStatus =
      cleanupStatus === 'retained' && ['cleaned', 'failed'].includes(handle.cleanupStatus)
        ? handle.cleanupStatus
        : cleanupStatus;

    return BackendWorkspaceHandleSchema.parse({
      ...handle,
      cleanupStatus: effectiveCleanupStatus,
      updatedAt,
    });
  });

  for (const handle of updated) {
    workspaceDb.sqlite
      .prepare(
        `UPDATE backend_workspace_handles
         SET payload_json = ?, updated_at = ?
         WHERE workspace_id = ? AND backend_workspace_handle_id = ?`
      )
      .run(JSON.stringify(handle), updatedAt, workspaceId, handle.id);
  }

  return updated;
}

/**
 * Persists one redacted backend workspace handle.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param handle Backend handle to persist.
 */
function recordBackendWorkspaceHandle(
  workspaceDb: WorkspaceDb,
  handle: BackendWorkspaceHandle
): void {
  workspaceDb.sqlite
    .prepare(
      `INSERT OR IGNORE INTO backend_workspace_handles (
        backend_workspace_handle_id,
        workspace_id,
        materialization_record_id,
        backend_kind,
        worker_session_id,
        payload_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      handle.id,
      handle.workspaceId,
      handle.materializationRecordId,
      handle.backendKind,
      handle.workerSessionId,
      JSON.stringify(handle),
      handle.createdAt,
      handle.updatedAt
    );
}

/**
 * Persists one worker output manifest.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param manifest Worker output manifest to persist.
 */
function recordWorkerOutputManifest(
  workspaceDb: WorkspaceDb,
  manifest: WorkerOutputManifest
): void {
  workspaceDb.sqlite
    .prepare(
      `INSERT OR IGNORE INTO worker_output_manifests (
        worker_output_manifest_id,
        workspace_id,
        materialization_record_id,
        input_snapshot_id,
        worker_session_id,
        backend_kind,
        strategy,
        payload_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      manifest.id,
      manifest.workspaceId,
      manifest.materializationRecordId,
      manifest.inputSnapshotId,
      manifest.workerSessionId,
      manifest.backendKind,
      manifest.strategy,
      JSON.stringify(manifest),
      manifest.collectedAt,
      manifest.collectedAt
    );
}

/**
 * Derives the first recovery handle from a materialization record without exposing backend internals.
 *
 * @param record Durable workspace materialization record.
 * @returns Redacted backend workspace handle.
 */
function inferBackendWorkspaceHandle(
  record: WorkspaceMaterializationRecord
): BackendWorkspaceHandle {
  return BackendWorkspaceHandleSchema.parse({
    backendKind: record.backendKind,
    cleanupStatus: 'pending',
    createdAt: record.createdAt,
    id: `bwh_${record.id}`,
    materializationRecordId: record.id,
    retention: 'until-reconciliation',
    transportRefs: [{ kind: 'materialized-root', ref: record.materializedRootRef }],
    updatedAt: record.createdAt,
    workerSessionId: record.workerSessionId,
    workspaceId: record.workspaceId,
  });
}

/**
 * Derives the first worker output manifest from a verified change set without backend-private data.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param changeSet Durable change set.
 * @returns Product-safe worker output manifest.
 */
function inferWorkerOutputManifest(
  workspaceDb: WorkspaceDb,
  changeSet: WorkspaceChangeSet
): WorkerOutputManifest {
  const materialization = getWorkspaceMaterializationRecord(
    workspaceDb,
    changeSet.workspaceId,
    changeSet.materializationRecordId
  );

  return WorkerOutputManifestSchema.parse({
    artifactIds: changeSet.artifactIds,
    backendKind: materialization?.backendKind ?? 'openshell',
    changedPaths: changeSet.changedPaths,
    collectedAt: changeSet.createdAt,
    evidenceRefs: changeSet.evidenceRefs,
    id: `wom_${changeSet.id}`,
    ignoredOutputs: [],
    inputSnapshotId: changeSet.inputSnapshotId,
    logRefs: [],
    materializationRecordId: changeSet.materializationRecordId,
    strategy: changeSet.strategy,
    testOutputRefs: [],
    workerSessionId: materialization?.workerSessionId ?? changeSet.materializationRecordId,
    workspaceId: changeSet.workspaceId,
  });
}

/**
 * Reads one materialization record if it exists.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @param materializationRecordId Materialization record id.
 * @returns Stored materialization record, or null.
 */
function getWorkspaceMaterializationRecord(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  materializationRecordId: string
): WorkspaceMaterializationRecord | null {
  const row = workspaceDb.sqlite
    .prepare(
      `SELECT payload_json
       FROM workspace_materialization_records
       WHERE workspace_id = ? AND materialization_record_id = ?`
    )
    .get(workspaceId, materializationRecordId) as { payload_json: string } | undefined;

  return row
    ? WorkspaceMaterializationRecordSchema.parse(JSON.parse(row.payload_json) as unknown)
    : null;
}

/**
 * Persists one worker-produced workspace change set.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param changeSet Change set to persist.
 */
function recordWorkspaceChangeSet(workspaceDb: WorkspaceDb, changeSet: WorkspaceChangeSet): void {
  workspaceDb.sqlite
    .prepare(
      `INSERT OR IGNORE INTO workspace_change_sets (
        change_set_id,
        workspace_id,
        input_snapshot_id,
        materialization_record_id,
        resource_id,
        strategy,
        payload_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      changeSet.id,
      changeSet.workspaceId,
      changeSet.inputSnapshotId,
      changeSet.materializationRecordId,
      changeSet.resourceId,
      changeSet.strategy,
      JSON.stringify(changeSet),
      changeSet.createdAt,
      changeSet.createdAt
    );
}

/**
 * Infers a minimal input snapshot from legacy artifact-backed change sets.
 *
 * @param changeSet Change set carrying snapshot lineage ids.
 * @returns Product-safe input snapshot.
 */
function inferWorkspaceInputSnapshot(changeSet: WorkspaceChangeSet): WorkspaceInputSnapshot {
  return WorkspaceInputSnapshotSchema.parse({
    backend: {
      capabilitySummary: [],
      kind: 'openshell',
      label: 'legacy artifact-backed workspace sync',
    },
    base: changeSet.base,
    createdAt: changeSet.createdAt,
    generatedFiles: [],
    id: changeSet.inputSnapshotId,
    ignoredPaths: [],
    pathScope: [changeSet.resourceId],
    resourceId: changeSet.resourceId,
    ...(changeSet.sourceId ? { sourceId: changeSet.sourceId } : {}),
    resourceKind: changeSet.strategy === 'git' ? 'git_repository' : 'filesystem',
    strategy: changeSet.strategy,
    workspaceId: changeSet.workspaceId,
    writableRoots: [changeSet.resourceId],
  });
}

/**
 * Infers a minimal materialization record from legacy artifact-backed change sets.
 *
 * @param changeSet Change set carrying materialization lineage ids.
 * @returns Product-safe materialization record.
 */
function inferWorkspaceMaterializationRecord(
  changeSet: WorkspaceChangeSet
): WorkspaceMaterializationRecord {
  return WorkspaceMaterializationRecordSchema.parse({
    backendKind: 'openshell',
    base: changeSet.base,
    createdAt: changeSet.createdAt,
    id: changeSet.materializationRecordId,
    inputSnapshotId: changeSet.inputSnapshotId,
    ...(changeSet.sourceId ? { sourceId: changeSet.sourceId } : {}),
    materializedRootRef: `workspace://${changeSet.workspaceId}/${changeSet.resourceId}`,
    policyDigest: 'sha256:legacy-artifact-backed',
    readinessEvidence: changeSet.evidenceRefs,
    strategy: changeSet.strategy,
    workerSessionId: changeSet.materializationRecordId,
    workspaceId: changeSet.workspaceId,
  });
}

/**
 * Adds source lineage from the existing materialization record when the worker change-set omitted it.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param changeSet Parsed change-set payload.
 * @returns Change set with source lineage when available.
 */
function withMaterializationSourceId(
  workspaceDb: WorkspaceDb,
  changeSet: WorkspaceChangeSet
): WorkspaceChangeSet {
  if (changeSet.sourceId) {
    return changeSet;
  }

  const row = workspaceDb.sqlite
    .prepare(
      `SELECT payload_json
       FROM workspace_materialization_records
       WHERE workspace_id = ? AND materialization_record_id = ?`
    )
    .get(changeSet.workspaceId, changeSet.materializationRecordId) as
    | { payload_json: string }
    | undefined;

  if (!row) {
    return changeSet;
  }

  const materialization = WorkspaceMaterializationRecordSchema.parse(
    JSON.parse(row.payload_json) as unknown
  );

  return materialization.sourceId
    ? WorkspaceChangeSetSchema.parse({ ...changeSet, sourceId: materialization.sourceId })
    : changeSet;
}

/**
 * Reads one durable workspace review item or throws.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @param reviewId Review id.
 * @returns Stored workspace review item.
 * @throws Error when the review does not exist.
 */
function requireWorkspaceSyncReview(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  reviewId: string
): WorkspaceSyncReviewItem {
  const item = getWorkspaceSyncReview(workspaceDb, workspaceId, reviewId);

  if (!item) {
    throw new Error(`Workspace synchronization review not found: ${workspaceId}/${reviewId}`);
  }

  return item;
}

/**
 * Maps one staged review row to the public joined item.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param row Staged workspace review row.
 * @returns Public joined review item.
 */
function mapWorkspaceReviewRow(
  workspaceDb: WorkspaceDb,
  row: StagedWorkspaceReviewRow
): WorkspaceSyncReviewItem {
  const review = StagedWorkspaceReviewSchema.parse(JSON.parse(row.payload_json) as unknown);
  const changeSet = requireWorkspaceChangeSet(workspaceDb, row.workspace_id, review.changeSetId);
  const patchPayload = row.patch_payload_json
    ? WorkspaceSyncReviewPatchPayloadSchema.parse(JSON.parse(row.patch_payload_json) as unknown)
    : null;

  return {
    artifactId: row.artifact_id,
    changeSet,
    patchPayload,
    review,
  };
}

/**
 * Reads one durable change set or throws.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @param changeSetId Change set id.
 * @returns Stored change set.
 * @throws Error when the change set does not exist.
 */
function requireWorkspaceChangeSet(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  changeSetId: string
): WorkspaceChangeSet {
  const row = workspaceDb.sqlite
    .prepare(
      `SELECT
        change_set_id,
        workspace_id,
        input_snapshot_id,
        materialization_record_id,
        resource_id,
        strategy,
        payload_json,
        created_at,
        updated_at
      FROM workspace_change_sets
      WHERE workspace_id = ? AND change_set_id = ?`
    )
    .get(workspaceId, changeSetId) as WorkspaceChangeSetRow | undefined;

  if (!row) {
    throw new Error(`Workspace change set not found: ${workspaceId}/${changeSetId}`);
  }

  return WorkspaceChangeSetSchema.parse(JSON.parse(row.payload_json) as unknown);
}

/**
 * Lists JSON payload rows from one workspace sync table.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param tableName Workspace sync table name.
 * @param workspaceId Workspace id.
 * @param schema Payload schema parser.
 * @returns Parsed payloads in newest-first order.
 */
function listPayloadRows<T>(
  workspaceDb: WorkspaceDb,
  tableName:
    | 'workspace_input_snapshots'
    | 'workspace_materialization_records'
    | 'backend_workspace_handles'
    | 'worker_output_manifests'
    | 'workspace_change_sets',
  workspaceId: string,
  schema: { parse(value: unknown): T }
): T[] {
  return (
    workspaceDb.sqlite
      .prepare(
        `SELECT payload_json
        FROM ${tableName}
        WHERE workspace_id = ?
        ORDER BY created_at ASC`
      )
      .all(workspaceId) as Array<{ payload_json: string }>
  )
    .map((row) => schema.parse(JSON.parse(row.payload_json) as unknown))
    .reverse();
}

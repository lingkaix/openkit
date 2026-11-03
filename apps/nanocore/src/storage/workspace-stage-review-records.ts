import {
  StagedWorkspaceReviewSchema,
  type WorkerOutputManifest,
  WorkerOutputManifestReaderSchema,
  WorkerOutputManifestSchema,
  type WorkspaceChangeSet,
  WorkspaceChangeSetReaderSchema,
  WorkspaceChangeSetSchema,
  type WorkspaceInputSnapshot,
  WorkspaceInputSnapshotReaderSchema,
  type WorkspaceMaterializationRecord,
  WorkspaceMaterializationRecordReaderSchema,
  type WorkspaceSyncReviewItem,
} from '@openkit/app-api-schemas';
import { type AuditEvent, readRetainedV1, writeRetainedV1 } from '@openkit/protocol';
import { recordWorkspaceAuditEvent } from '../audit-events.js';
import type { WorkspaceDb } from './db.js';
import { recordWorkspaceEvidenceBundle } from './evidence-bundle-records.js';
import {
  getWorkspaceSyncReview,
  parseWorkspaceSyncReviewItem,
  requireWorkspaceSyncReview,
} from './workspace-review-records.js';
/** Durable workspace synchronization review persistence input. */
export interface RecordWorkspaceSyncReviewInput {
  /** Producing Worker actor and work lineage, captured by the runtime owner. */
  readonly producer?: Pick<
    AuditEvent,
    'actor' | 'agentId' | 'agentSessionId' | 'requestId' | 'threadId' | 'turnId'
  >;
  /** Public workspace synchronization review item. */
  readonly item: WorkspaceSyncReviewItem;
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
  const item = parseWorkspaceSyncReviewItem(input.item, true);
  const changeSet = withMaterializationSourceId(workspaceDb, item.changeSet);
  const review = item.review;
  const patchPayload = item.patchPayload;
  const existingInputSnapshot = getWorkspaceInputSnapshot(
    workspaceDb,
    changeSet.workspaceId,
    changeSet.inputSnapshotId
  );
  if (!existingInputSnapshot) {
    throw new Error(
      `Workspace synchronization input lineage is missing: ${changeSet.inputSnapshotId}`
    );
  }
  const inputSnapshot = existingInputSnapshot;
  const existingMaterializationRecord = getWorkspaceMaterializationRecord(
    workspaceDb,
    changeSet.workspaceId,
    changeSet.materializationRecordId
  );
  if (!existingMaterializationRecord) {
    throw new Error(
      `Workspace synchronization materialization lineage is missing: ${changeSet.materializationRecordId}`
    );
  }
  const materializationRecord = existingMaterializationRecord;
  if (
    inputSnapshot.workspaceId !== changeSet.workspaceId ||
    inputSnapshot.resourceId !== changeSet.resourceId ||
    inputSnapshot.strategy !== changeSet.strategy ||
    materializationRecord.workspaceId !== changeSet.workspaceId ||
    materializationRecord.inputSnapshotId !== changeSet.inputSnapshotId ||
    materializationRecord.strategy !== changeSet.strategy
  ) {
    throw new Error(`Workspace synchronization lineage conflict: ${changeSet.id}`);
  }
  const existingReview = getWorkspaceSyncReview(workspaceDb, review.workspaceId, review.id);
  if (existingReview) {
    const replayedReview = StagedWorkspaceReviewSchema.parse({
      ...review,
      status: existingReview.review.status,
      updatedAt: existingReview.review.updatedAt,
    });
    if (
      existingReview.artifactId !== item.artifactId ||
      JSON.stringify(existingReview.changeSet) !== JSON.stringify(changeSet) ||
      JSON.stringify(existingReview.patchPayload) !== JSON.stringify(patchPayload) ||
      JSON.stringify(existingReview.review) !== JSON.stringify(replayedReview)
    ) {
      throw new Error(`Workspace synchronization review replay conflict: ${review.id}`);
    }
    return existingReview;
  }

  recordWorkerOutputManifest(workspaceDb, inferWorkerOutputManifest(workspaceDb, changeSet));
  recordWorkspaceChangeSet(workspaceDb, changeSet);
  workspaceDb.sqlite
    .prepare(
      `INSERT INTO staged_workspace_reviews (
        schema_version,
        review_id,
        workspace_id,
        change_set_id,
        artifact_id,
        status,
        payload_json,
        patch_payload_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      writeRetainedV1({}).schemaVersion,
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

  recordWorkspaceAuditEvent({
    action: 'workspace.review.stage',
    ...input.producer,
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
 * Persists one worker output manifest.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param manifest Worker output manifest to persist.
 */
export function recordWorkerOutputManifest(
  workspaceDb: Pick<WorkspaceDb, 'sqlite'>,
  manifest: WorkerOutputManifest
): void {
  const parsed = WorkerOutputManifestSchema.parse(manifest);
  const existing = workspaceDb.sqlite
    .prepare(
      `SELECT schema_version AS schemaVersion, payload_json
       FROM worker_output_manifests
       WHERE workspace_id = ? AND worker_output_manifest_id = ?`
    )
    .get(parsed.workspaceId, parsed.id) as
    | { schemaVersion: unknown; payload_json: string }
    | undefined;
  if (existing) {
    const stored = WorkerOutputManifestReaderSchema.parse(
      readRetainedV1(existing, () => JSON.parse(existing.payload_json)) as unknown
    );
    if (JSON.stringify(stored) !== JSON.stringify(parsed)) {
      throw new Error(`Worker output manifest replay conflict: ${parsed.id}`);
    }
    return;
  }
  workspaceDb.sqlite
    .prepare(
      `INSERT INTO worker_output_manifests (
        schema_version,
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      writeRetainedV1({}).schemaVersion,
      parsed.id,
      parsed.workspaceId,
      parsed.materializationRecordId,
      parsed.inputSnapshotId,
      parsed.workerSessionId,
      parsed.backendKind,
      parsed.strategy,
      JSON.stringify(parsed),
      parsed.collectedAt,
      parsed.collectedAt
    );
}

/**
 * Derives the first worker output manifest from a verified change set without backend-private data.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param changeSet Durable change set.
 * @returns Product-safe worker output manifest.
 */
function inferWorkerOutputManifest(
  workspaceDb: Pick<WorkspaceDb, 'sqlite'>,
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
 * Reads one input snapshot if it exists.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @param inputSnapshotId Input snapshot id.
 * @returns Stored input snapshot, or null.
 */
function getWorkspaceInputSnapshot(
  workspaceDb: Pick<WorkspaceDb, 'sqlite'>,
  workspaceId: string,
  inputSnapshotId: string
): WorkspaceInputSnapshot | null {
  const row = workspaceDb.sqlite
    .prepare(
      `SELECT schema_version AS schemaVersion, payload_json
       FROM workspace_input_snapshots
       WHERE workspace_id = ? AND input_snapshot_id = ?`
    )
    .get(workspaceId, inputSnapshotId) as
    | { schemaVersion: unknown; payload_json: string }
    | undefined;

  return row
    ? WorkspaceInputSnapshotReaderSchema.parse(
        readRetainedV1(row, () => JSON.parse(row.payload_json)) as unknown
      )
    : null;
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
  workspaceDb: Pick<WorkspaceDb, 'sqlite'>,
  workspaceId: string,
  materializationRecordId: string
): WorkspaceMaterializationRecord | null {
  const row = workspaceDb.sqlite
    .prepare(
      `SELECT schema_version AS schemaVersion, payload_json
       FROM workspace_materialization_records
       WHERE workspace_id = ? AND materialization_record_id = ?`
    )
    .get(workspaceId, materializationRecordId) as
    | { schemaVersion: unknown; payload_json: string }
    | undefined;

  return row
    ? WorkspaceMaterializationRecordReaderSchema.parse(
        readRetainedV1(row, () => JSON.parse(row.payload_json)) as unknown
      )
    : null;
}

/**
 * Persists one worker-produced workspace change set.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param changeSet Change set to persist.
 */
function recordWorkspaceChangeSet(
  workspaceDb: Pick<WorkspaceDb, 'sqlite'>,
  changeSet: WorkspaceChangeSet
): void {
  const payloadJson = JSON.stringify(WorkspaceChangeSetSchema.parse(changeSet));
  const existing = workspaceDb.sqlite
    .prepare(
      `SELECT schema_version AS schemaVersion, payload_json
       FROM workspace_change_sets
       WHERE workspace_id = ? AND change_set_id = ?`
    )
    .get(changeSet.workspaceId, changeSet.id) as
    | { schemaVersion: unknown; payload_json: string }
    | undefined;
  if (existing) {
    const existingPayloadJson = JSON.stringify(
      WorkspaceChangeSetReaderSchema.parse(
        readRetainedV1(existing, () => JSON.parse(existing.payload_json)) as unknown
      )
    );
    if (existingPayloadJson !== payloadJson) {
      throw new Error(`Workspace change set replay conflict: ${changeSet.id}`);
    }
    return;
  }

  workspaceDb.sqlite
    .prepare(
      `INSERT INTO workspace_change_sets (
        schema_version,
        change_set_id,
        workspace_id,
        input_snapshot_id,
        materialization_record_id,
        resource_id,
        strategy,
        payload_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      writeRetainedV1({}).schemaVersion,
      changeSet.id,
      changeSet.workspaceId,
      changeSet.inputSnapshotId,
      changeSet.materializationRecordId,
      changeSet.resourceId,
      changeSet.strategy,
      payloadJson,
      changeSet.createdAt,
      changeSet.createdAt
    );
}

/**
 * Adds source lineage from the existing materialization record when the worker change-set omitted it.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param changeSet Parsed change-set payload.
 * @returns Change set with source lineage when available.
 */
function withMaterializationSourceId(
  workspaceDb: Pick<WorkspaceDb, 'sqlite'>,
  changeSet: WorkspaceChangeSet
): WorkspaceChangeSet {
  if (changeSet.sourceId) {
    return changeSet;
  }

  const row = workspaceDb.sqlite
    .prepare(
      `SELECT schema_version AS schemaVersion, payload_json
       FROM workspace_materialization_records
       WHERE workspace_id = ? AND materialization_record_id = ?`
    )
    .get(changeSet.workspaceId, changeSet.materializationRecordId) as
    | { schemaVersion: unknown; payload_json: string }
    | undefined;

  if (!row) {
    return changeSet;
  }

  const materialization = WorkspaceMaterializationRecordReaderSchema.parse(
    readRetainedV1(row, () => JSON.parse(row.payload_json)) as unknown
  );

  return materialization.sourceId
    ? WorkspaceChangeSetSchema.parse({ ...changeSet, sourceId: materialization.sourceId })
    : changeSet;
}

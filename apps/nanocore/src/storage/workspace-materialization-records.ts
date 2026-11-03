import {
  type BackendWorkspaceHandle,
  BackendWorkspaceHandleReaderSchema,
  BackendWorkspaceHandleSchema,
  type WorkspaceInputSnapshot,
  WorkspaceInputSnapshotReaderSchema,
  WorkspaceInputSnapshotSchema,
  type WorkspaceMaterializationRecord,
  WorkspaceMaterializationRecordReaderSchema,
  WorkspaceMaterializationRecordSchema,
} from '@openkit/app-api-schemas';
import { readRetainedV1, writeRetainedV1 } from '@openkit/protocol';
import { recordMaterializationRuntimeEvidence } from '../runtime/runtime-evidence.js';
import type { WorkspaceDb } from './db.js';
import { recordWorkspaceEvidenceBundle } from './evidence-bundle-records.js';
import { WorkspaceBackendHandoffRefusal } from './workspace-backend-handoff-codecs.js';

interface RecordWorkspaceMaterializationRecordOptions {
  readonly promoteEvidence?: boolean;
}

/** Persists one original input snapshot, preserving exact replay. */
export function recordWorkspaceInputSnapshot(
  workspaceDb: Pick<WorkspaceDb, 'sqlite'>,
  snapshot: WorkspaceInputSnapshot
): WorkspaceInputSnapshot {
  const parsed = WorkspaceInputSnapshotSchema.parse(snapshot);
  const existing = workspaceDb.sqlite
    .prepare(
      `SELECT schema_version AS schemaVersion, payload_json
       FROM workspace_input_snapshots
       WHERE workspace_id = ? AND input_snapshot_id = ?`
    )
    .get(parsed.workspaceId, parsed.id) as
    | { schemaVersion: unknown; payload_json: string }
    | undefined;
  if (existing) {
    const stored = WorkspaceInputSnapshotReaderSchema.parse(
      readRetainedV1(existing, () => JSON.parse(existing.payload_json)) as unknown
    );
    if (JSON.stringify(stored) !== JSON.stringify(parsed)) {
      throw new WorkspaceBackendHandoffRefusal('snapshot_conflict', parsed.id);
    }
    return stored;
  }
  workspaceDb.sqlite
    .prepare(
      `INSERT INTO workspace_input_snapshots (
        schema_version,
        input_snapshot_id,
        workspace_id,
        resource_id,
        strategy,
        payload_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      writeRetainedV1({}).schemaVersion,
      parsed.id,
      parsed.workspaceId,
      parsed.resourceId,
      parsed.strategy,
      JSON.stringify(parsed),
      parsed.createdAt,
      parsed.createdAt
    );
  return parsed;
}

/** Persists one original materialization with its handle and evidence. */
export function recordWorkspaceMaterializationRecord(
  workspaceDb: WorkspaceDb,
  record: WorkspaceMaterializationRecord,
  options: RecordWorkspaceMaterializationRecordOptions = {}
): WorkspaceMaterializationRecord {
  const parsed = WorkspaceMaterializationRecordSchema.parse(record);
  const existing = workspaceDb.sqlite
    .prepare(
      `SELECT schema_version AS schemaVersion, payload_json
       FROM workspace_materialization_records
       WHERE workspace_id = ? AND materialization_record_id = ?`
    )
    .get(parsed.workspaceId, parsed.id) as
    | { schemaVersion: unknown; payload_json: string }
    | undefined;
  if (existing) {
    const stored = WorkspaceMaterializationRecordReaderSchema.parse(
      readRetainedV1(existing, () => JSON.parse(existing.payload_json)) as unknown
    );
    if (JSON.stringify(stored) !== JSON.stringify(parsed)) {
      throw new WorkspaceBackendHandoffRefusal('materialization_conflict', parsed.id);
    }
  } else {
    const inserted = workspaceDb.sqlite
      .prepare(
        `INSERT INTO workspace_materialization_records (
        schema_version,
          materialization_record_id,
          workspace_id,
          input_snapshot_id,
          package_snapshot_id,
          worker_session_id,
          strategy,
          payload_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        writeRetainedV1({}).schemaVersion,
        parsed.id,
        parsed.workspaceId,
        parsed.inputSnapshotId,
        parsed.packageSnapshotId,
        parsed.workerSessionId,
        parsed.strategy,
        JSON.stringify(parsed),
        parsed.createdAt,
        parsed.createdAt
      );
    if (inserted.changes === 0) {
      throw new WorkspaceBackendHandoffRefusal('materialization_not_recorded', parsed.id);
    }
  }
  if (options.promoteEvidence === false) {
    return parsed;
  }

  recordBackendWorkspaceHandle(workspaceDb, inferBackendWorkspaceHandle(parsed), true);
  recordWorkspaceEvidenceBundle(workspaceDb, {
    id: `evb_workspace_materialization_${parsed.id}`,
    workspaceId: parsed.workspaceId,
    threadId: null,
    goalId: null,
    turnId: null,
    agentSessionId: null,
    backendType: parsed.backendKind,
    sourceKind: 'workspace-materialization',
    summary: `Workspace materialization recorded: strategy ${parsed.strategy}, backend ${parsed.backendKind}`,
    rawEvidenceRefs: [],
    redactedEvidenceRefs: parsed.readinessEvidence,
    contentDigests: [parsed.policyDigest],
    retentionClass: 'workspace-audit',
    sensitivityClass: 'product-safe',
    importStatus: 'promoted',
    requiredFeatures: ['evidence.bundle.v1'],
    createdAt: parsed.createdAt,
  });
  recordMaterializationRuntimeEvidence(workspaceDb, parsed);
  return parsed;
}

/** Persists one original backend handle, preserving mutable cleanup progress on exact replay. */
export function recordBackendWorkspaceHandle(
  workspaceDb: Pick<WorkspaceDb, 'sqlite'>,
  handle: BackendWorkspaceHandle,
  preserveCleanupProgress = false
): void {
  const parsed = BackendWorkspaceHandleSchema.parse(handle);
  const existing = workspaceDb.sqlite
    .prepare(
      `SELECT schema_version AS schemaVersion, payload_json
       FROM backend_workspace_handles
       WHERE workspace_id = ? AND backend_workspace_handle_id = ?`
    )
    .get(parsed.workspaceId, parsed.id) as
    | { schemaVersion: unknown; payload_json: string }
    | undefined;
  if (existing) {
    const stored = BackendWorkspaceHandleReaderSchema.parse(
      readRetainedV1(existing, () => JSON.parse(existing.payload_json)) as unknown
    );
    const replayed = preserveCleanupProgress
      ? { ...parsed, cleanupStatus: stored.cleanupStatus, updatedAt: stored.updatedAt }
      : parsed;
    if (JSON.stringify(stored) !== JSON.stringify(replayed)) {
      throw new WorkspaceBackendHandoffRefusal('handle_conflict', parsed.id);
    }
    return;
  }
  workspaceDb.sqlite
    .prepare(
      `INSERT INTO backend_workspace_handles (
        schema_version,
        backend_workspace_handle_id,
        workspace_id,
        materialization_record_id,
        backend_kind,
        package_snapshot_id,
        worker_session_id,
        payload_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      writeRetainedV1({}).schemaVersion,
      parsed.id,
      parsed.workspaceId,
      parsed.materializationRecordId,
      parsed.backendKind,
      parsed.packageSnapshotId,
      parsed.workerSessionId,
      JSON.stringify(parsed),
      parsed.createdAt,
      parsed.updatedAt
    );
}

/** Derives the original redacted handle from a materialization. */
function inferBackendWorkspaceHandle(
  record: WorkspaceMaterializationRecord
): BackendWorkspaceHandle {
  return BackendWorkspaceHandleSchema.parse({
    backendKind: record.backendKind,
    cleanupStatus: 'pending',
    createdAt: record.createdAt,
    id: `bwh_${record.id}`,
    materializationRecordId: record.id,
    packageSnapshotId: record.packageSnapshotId,
    retention: 'until-reconciliation',
    transportRefs: [{ kind: 'materialized-root', ref: record.materializedRootRef }],
    updatedAt: record.createdAt,
    workerSessionId: record.workerSessionId,
    workspaceId: record.workspaceId,
  });
}

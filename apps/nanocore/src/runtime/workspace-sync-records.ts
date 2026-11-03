export {
  type RecordWorkspaceSyncReviewInput,
  recordWorkerOutputManifest,
  recordWorkspaceSyncReview,
} from '../storage/workspace-stage-review-records.js';

import {
  recordWorkspaceInputSnapshot,
  recordWorkspaceMaterializationRecord,
} from '../storage/workspace-materialization-records.js';
import { listWorkspaceSyncReviews } from '../storage/workspace-review-records.js';

export {
  getWorkspaceSyncReview,
  listWorkspaceSyncReviews,
  parseWorkspaceSyncReviewItem,
  type UpdateWorkspaceSyncReviewDecisionInput,
  updateWorkspaceSyncReviewDecision,
} from '../storage/workspace-review-records.js';

import { isDeepStrictEqual } from 'node:util';
import {
  type BackendWorkspaceHandle,
  BackendWorkspaceHandleReaderSchema,
  BackendWorkspaceHandleSchema,
  type StagedWorkspaceReview,
  type WorkerOutputManifest,
  WorkerOutputManifestReaderSchema,
  type WorkspaceChangeSet,
  WorkspaceChangeSetReaderSchema,
  type WorkspaceInputSnapshot,
  WorkspaceInputSnapshotReaderSchema,
  type WorkspaceMaterializationRecord,
  WorkspaceMaterializationRecordReaderSchema,
  WorkspaceSynchronizationBackendKindSchema,
  type WorkspaceSyncReviewPatchPayload,
} from '@openkit/app-api-schemas';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { readRetainedV1 } from '@openkit/protocol';
import type { WorkspaceDb } from '../storage/db.js';
import {
  buildWorkspaceInputSnapshots,
  buildWorkspaceMaterializationRecords,
} from './workspace-materializer.js';
import { workspaceSnapshotAcceptedCommitIsKnown } from './workspace-snapshot-chain.js';

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

/**
 * Persists durable workspace input snapshots.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param snapshots Input snapshots to persist.
 * @returns Stored input snapshots.
 */
export function recordWorkspaceInputSnapshots(
  workspaceDb: Pick<WorkspaceDb, 'sqlite'>,
  snapshots: readonly WorkspaceInputSnapshot[]
): WorkspaceInputSnapshot[] {
  return snapshots.map((snapshot) => recordWorkspaceInputSnapshot(workspaceDb, snapshot));
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
  return workspaceDb.sqlite.transaction(() =>
    records.map((record) => recordWorkspaceMaterializationRecord(workspaceDb, record))
  )();
}

/**
 * Lists durable workspace input snapshots for one workspace.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Stored input snapshots in newest-first order.
 */
export function listWorkspaceInputSnapshots(
  workspaceDb: Pick<WorkspaceDb, 'sqlite'>,
  workspaceId: string
): WorkspaceInputSnapshot[] {
  return listPayloadRows(
    workspaceDb,
    'workspace_input_snapshots',
    workspaceId,
    WorkspaceInputSnapshotReaderSchema
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
  workspaceDb: Pick<WorkspaceDb, 'sqlite'>,
  workspaceId: string
): WorkspaceMaterializationRecord[] {
  return listPayloadRows(
    workspaceDb,
    'workspace_materialization_records',
    workspaceId,
    WorkspaceMaterializationRecordReaderSchema
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
  workspaceDb: Pick<WorkspaceDb, 'sqlite'>,
  workspaceId: string
): WorkspaceChangeSet[] {
  return listPayloadRows(
    workspaceDb,
    'workspace_change_sets',
    workspaceId,
    WorkspaceChangeSetReaderSchema
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
  workspaceDb: Pick<WorkspaceDb, 'sqlite'>,
  workspaceId: string
): WorkerOutputManifest[] {
  return listPayloadRows(
    workspaceDb,
    'worker_output_manifests',
    workspaceId,
    WorkerOutputManifestReaderSchema
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
  workspaceDb: Pick<WorkspaceDb, 'sqlite'>,
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
 * Lists durable backend workspace handles for one workspace.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Stored backend handles in newest-first order.
 */
export function listBackendWorkspaceHandles(
  workspaceDb: Pick<WorkspaceDb, 'sqlite'>,
  workspaceId: string
): BackendWorkspaceHandle[] {
  return listPayloadRows(
    workspaceDb,
    'backend_workspace_handles',
    workspaceId,
    BackendWorkspaceHandleReaderSchema
  );
}

/**
 * Requires an exact backend-handle handoff for every workspace input in one immutable package.
 *
 * @param workspaceDb Workspace database that owns the package.
 * @param environmentPackage Immutable package whose original inputs and logical slot define the expected handoff set.
 * @param expectedBackend Optional exact physical backend owner required by cleanup projection.
 * @returns Exact package-owned backend handles in storage order.
 * @throws Error when a declared input is missing, duplicated, or joined by an unexpected handle.
 */
export function requireCompleteBackendWorkspaceHandleHandoff(
  workspaceDb: WorkspaceDb,
  environmentPackage: AgentEnvironmentPackage,
  expectedBackend?: {
    /** Exact backend family persisted by the Core anchor. */
    readonly backendKind: string;
    /** Exact backend version persisted by the Core anchor. */
    readonly backendVersion: string | null;
    /** Exact physical worker session id persisted by the Core anchor. */
    readonly workerSessionId: string;
  }
): BackendWorkspaceHandle[] {
  const expectedRecordIds = new Set(
    environmentPackage.workspace.inputs.map(
      (input) => `wmr_${environmentPackage.snapshotId}_${input.id}`
    )
  );
  const handles = listBackendWorkspaceHandles(
    workspaceDb,
    environmentPackage.scope.workspaceId
  ).filter((handle) => handle.packageSnapshotId === environmentPackage.snapshotId);
  const actualRecordIds = handles.map((handle) => handle.materializationRecordId);
  const uniqueActualRecordIds = new Set(actualRecordIds);
  const materializationRecords = listWorkspaceMaterializationRecords(
    workspaceDb,
    environmentPackage.scope.workspaceId
  ).filter((record) => record.packageSnapshotId === environmentPackage.snapshotId);
  const materializationRecordsById = new Map(
    materializationRecords.map((record) => [record.id, record] as const)
  );
  const inputSnapshotsById = new Map(
    listWorkspaceInputSnapshots(workspaceDb, environmentPackage.scope.workspaceId).map(
      (snapshot) => [snapshot.id, snapshot] as const
    )
  );
  const packageInputsById = new Map(
    environmentPackage.workspace.inputs.map((input) => [input.id, input] as const)
  );

  if (
    actualRecordIds.length !== uniqueActualRecordIds.size ||
    uniqueActualRecordIds.size !== expectedRecordIds.size ||
    [...uniqueActualRecordIds].some((recordId) => !expectedRecordIds.has(recordId)) ||
    materializationRecordsById.size !== expectedRecordIds.size ||
    handles.some((handle) => {
      const record = materializationRecordsById.get(handle.materializationRecordId);
      const inputId = record?.id.replace(`wmr_${environmentPackage.snapshotId}_`, '') ?? '';
      const packageInput = packageInputsById.get(inputId);
      const expectedInputSnapshotId = `wis_${environmentPackage.snapshotId}_${inputId}`;
      const snapshot = inputSnapshotsById.get(expectedInputSnapshotId);
      const expectedSourceId =
        packageInput && typeof packageInput.source.sourceId === 'string'
          ? packageInput.source.sourceId
          : undefined;
      let canonicalSnapshot =
        packageInput && snapshot && expectedBackend
          ? buildWorkspaceInputSnapshots({
              backendCapabilities: snapshot.backend.capabilitySummary,
              backendKind: WorkspaceSynchronizationBackendKindSchema.parse(
                expectedBackend.backendKind
              ),
              createdAt: snapshot.createdAt,
              environmentPackage: {
                ...environmentPackage,
                workspace: { ...environmentPackage.workspace, inputs: [packageInput] },
              },
            })[0]
          : undefined;
      // The immutable AEP retains the original source identity; the slot cursor or a capture receipt proves a later accepted Core commit used as the materialized base.
      const workSlot = (
        environmentPackage.extensions.openkit as {
          workerStorage?: { workSlotRef?: string };
        }
      )?.workerStorage?.workSlotRef;
      if (
        canonicalSnapshot &&
        packageInput?.access === 'read-write' &&
        packageInput.source.kind === 'git' &&
        snapshot?.base.commit &&
        workSlot &&
        workspaceSnapshotAcceptedCommitIsKnown(
          workspaceDb,
          environmentPackage.scope.workspaceId,
          workSlot,
          environmentPackage.scope.threadId,
          snapshot.base.commit
        )
      ) {
        canonicalSnapshot = {
          ...canonicalSnapshot,
          base: { ...canonicalSnapshot.base, commit: snapshot.base.commit },
        };
      }
      const canonicalRecord =
        canonicalSnapshot && expectedBackend && packageInput && record
          ? buildWorkspaceMaterializationRecords({
              createdAt: record.createdAt,
              inputSnapshots: [canonicalSnapshot],
              materialization: {
                backendKind: WorkspaceSynchronizationBackendKindSchema.parse(
                  expectedBackend.backendKind
                ),
                ...(record.readinessEvidence.some((evidence) =>
                  evidence.kind.startsWith('backend.')
                )
                  ? {
                      backendStatus: {
                        health: 'ready' as const,
                        version: expectedBackend.backendVersion,
                      },
                    }
                  : {}),
                packageSnapshotId: environmentPackage.snapshotId,
                requiredCapabilities: environmentPackage.backend.requiredCapabilities,
                sandbox: { name: expectedBackend.workerSessionId, state: 'created' },
                workspaceInputs: [{ id: packageInput.id, target: packageInput.target }],
              },
            })[0]
          : undefined;
      return (
        !record ||
        !packageInput ||
        !snapshot ||
        handle.id !== `bwh_${record.id}` ||
        handle.workspaceId !== environmentPackage.scope.workspaceId ||
        handle.materializationRecordId !== record.id ||
        handle.packageSnapshotId !== environmentPackage.snapshotId ||
        handle.retention !== 'until-reconciliation' ||
        handle.createdAt !== record.createdAt ||
        record.workspaceId !== environmentPackage.scope.workspaceId ||
        record.packageSnapshotId !== environmentPackage.snapshotId ||
        record.inputSnapshotId !== expectedInputSnapshotId ||
        record.strategy !== snapshot.strategy ||
        !isDeepStrictEqual(record.base, snapshot.base) ||
        record.sourceId !== expectedSourceId ||
        record.backendKind !== handle.backendKind ||
        record.workerSessionId !== handle.workerSessionId ||
        snapshot.workspaceId !== environmentPackage.scope.workspaceId ||
        snapshot.resourceId !== inputId ||
        snapshot.sourceId !== expectedSourceId ||
        !isDeepStrictEqual(handle.transportRefs, [
          { kind: 'materialized-root', ref: record.materializedRootRef },
        ]) ||
        (expectedBackend !== undefined &&
          (!canonicalSnapshot ||
            !canonicalRecord ||
            !isDeepStrictEqual(snapshot, canonicalSnapshot) ||
            !isDeepStrictEqual(record, canonicalRecord) ||
            handle.backendKind !== expectedBackend.backendKind ||
            handle.workerSessionId !== expectedBackend.workerSessionId))
      );
    })
  ) {
    throw new Error(
      `Workspace backend handle handoff is incomplete for package ${environmentPackage.snapshotId}.`
    );
  }

  return handles;
}

/**
 * Updates backend workspace handle cleanup status for one AEP package.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @param packageSnapshotId AEP package snapshot id stored on backend handles.
 * @param cleanupStatus New cleanup status.
 * @param updatedAt Update timestamp.
 * @returns Updated backend handles in stable order.
 */
export function updateBackendWorkspaceHandleCleanupStatus(
  workspaceDb: Pick<WorkspaceDb, 'sqlite'>,
  workspaceId: string,
  packageSnapshotId: string,
  cleanupStatus: BackendWorkspaceHandle['cleanupStatus'],
  updatedAt: string
): BackendWorkspaceHandle[] {
  const rows = workspaceDb.sqlite
    .prepare(
      `SELECT schema_version AS schemaVersion, payload_json
       FROM backend_workspace_handles
       WHERE workspace_id = ? AND package_snapshot_id = ?
       ORDER BY created_at ASC, backend_workspace_handle_id ASC`
    )
    .all(workspaceId, packageSnapshotId) as Array<{ schemaVersion: unknown; payload_json: string }>;
  const resolved = rows.map((row) => {
    const handle = BackendWorkspaceHandleReaderSchema.parse(
      readRetainedV1(row, () => JSON.parse(row.payload_json)) as unknown
    );
    const effectiveCleanupStatus =
      cleanupStatus === 'retained' && ['cleaned', 'failed'].includes(handle.cleanupStatus)
        ? handle.cleanupStatus
        : cleanupStatus;

    if (effectiveCleanupStatus === handle.cleanupStatus) {
      return { changed: false, handle, retained: row.payload_json };
    }

    return {
      changed: true,
      retained: row.payload_json,
      handle: BackendWorkspaceHandleSchema.parse({
        ...handle,
        cleanupStatus: effectiveCleanupStatus,
        updatedAt,
      }),
    };
  });

  for (const { changed, handle, retained } of resolved) {
    if (!changed) {
      continue;
    }
    workspaceDb.sqlite
      .prepare(
        `UPDATE backend_workspace_handles
         SET payload_json = ?, updated_at = ?
         WHERE workspace_id = ? AND backend_workspace_handle_id = ?`
      )
      .run(
        JSON.stringify({
          ...JSON.parse(retained),
          cleanupStatus: handle.cleanupStatus,
          updatedAt: handle.updatedAt,
        }),
        updatedAt,
        workspaceId,
        handle.id
      );
  }

  return resolved.map(({ handle }) => handle);
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
  workspaceDb: Pick<WorkspaceDb, 'sqlite'>,
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
        `SELECT schema_version AS schemaVersion, payload_json
        FROM ${tableName}
        WHERE workspace_id = ?
        ORDER BY created_at ASC`
      )
      .all(workspaceId) as Array<{ schemaVersion: unknown; payload_json: string }>
  )
    .map((row) => schema.parse(readRetainedV1(row, () => JSON.parse(row.payload_json)) as unknown))
    .reverse();
}

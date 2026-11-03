import { isDeepStrictEqual } from 'node:util';
import {
  type BackendWorkspaceHandle,
  BackendWorkspaceHandleReaderSchema,
  type WorkspaceInputSnapshot,
  WorkspaceInputSnapshotReaderSchema,
  type WorkspaceMaterializationRecord,
  WorkspaceMaterializationRecordReaderSchema,
  WorkspaceSynchronizationBackendKindSchema,
} from '@openkit/app-api-schemas';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { readRetainedV1 } from '@openkit/protocol';
import {
  buildWorkspaceInputSnapshots,
  buildWorkspaceMaterializationRecords,
} from '../runtime/workspace-materializer.js';
import { workspaceSnapshotAcceptedCommitIsKnown } from '../runtime/workspace-snapshot-chain.js';
import type { WorkspaceDb } from './db.js';

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
 * Lists JSON payload rows from one workspace sync table.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param tableName Workspace sync table name.
 * @param workspaceId Workspace id.
 * @param schema Payload schema parser.
 * @returns Parsed payloads in newest-first order.
 */
export function listPayloadRows<T>(
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

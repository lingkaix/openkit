import type { BackendWorkspaceHandle, RuntimeEvidenceRecord } from '@openkit/app-api-schemas';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import type { WorkspaceDb } from '../storage/db.js';
import {
  type RecordWorkerBackendTeardownEvidenceInput,
  recordWorkerBackendTeardownEvidence,
} from './runtime-evidence.js';
import {
  listBackendWorkspaceHandles,
  listWorkspaceMaterializationRecords,
  requireCompleteBackendWorkspaceHandleHandoff,
  updateBackendWorkspaceHandleCleanupStatus,
} from './workspace-sync-records.js';

/** Final successful backend cleanup input accepted by the authoritative workspace projector. */
export type ProjectWorkerBackendCleanupInput = Omit<
  RecordWorkerBackendTeardownEvidenceInput,
  'outcome'
> & {
  /** Immutable package whose workspace handoff must be complete inside this transaction. */
  readonly environmentPackage: AgentEnvironmentPackage;
  /** Exact physical worker session id persisted by the Core anchor. */
  readonly backendSessionId: string;
  /** Only final physical success is authoritative workspace teardown evidence. */
  readonly outcome: 'succeeded';
  /** Durable Core proof of whether the workspace handoff transaction was published. */
  readonly workspaceHandoffState: 'pending' | 'complete';
};

/** Atomic workspace projection produced after one physical backend cleanup attempt. */
export interface WorkerBackendCleanupProjectionResult {
  /** Package workspace handles updated by the projection. */
  readonly handles: BackendWorkspaceHandle[];
  /** Package-level teardown evidence written even when the package has no workspace inputs. */
  readonly evidence: RuntimeEvidenceRecord;
  /** Whether Core may repair a pending handoff marker to complete. */
  readonly workspaceHandoffComplete: boolean;
}

/**
 * Atomically projects backend cleanup into workspace handles and package teardown evidence.
 *
 * @param workspaceDb Workspace database owned by the scheduler admission user.
 * @param input Complete package-level teardown evidence input.
 * @returns Updated handles and deterministic teardown evidence.
 * @throws Error when either projection fails; every workspace write is rolled back.
 */
export function projectWorkerBackendCleanup(
  workspaceDb: WorkspaceDb,
  input: ProjectWorkerBackendCleanupInput
): WorkerBackendCleanupProjectionResult {
  workspaceDb.sqlite.exec('BEGIN IMMEDIATE');
  try {
    const packageHandles = listBackendWorkspaceHandles(workspaceDb, input.workspaceId).filter(
      (handle) => handle.packageSnapshotId === input.packageSnapshotId
    );
    const packageMaterializations = listWorkspaceMaterializationRecords(
      workspaceDb,
      input.workspaceId
    ).filter((record) => record.packageSnapshotId === input.packageSnapshotId);
    const anyHandoffRows = packageHandles.length > 0 || packageMaterializations.length > 0;
    const workspaceHandoffComplete =
      input.workspaceHandoffState === 'complete' ||
      anyHandoffRows ||
      input.environmentPackage.workspace.inputs.length === 0;
    if (input.workspaceHandoffState === 'complete' || anyHandoffRows) {
      const verifiedHandles = requireCompleteBackendWorkspaceHandleHandoff(
        workspaceDb,
        input.environmentPackage,
        {
          backendKind: input.backendType,
          backendVersion: input.backendVersion,
          workerSessionId: input.backendSessionId,
        }
      );
      if (
        verifiedHandles.some(
          (handle) =>
            (handle.cleanupStatus === 'pending' && handle.updatedAt !== handle.createdAt) ||
            (handle.cleanupStatus === 'cleaned' && handle.updatedAt !== input.completedAt) ||
            !['pending', 'retained', 'cleaned'].includes(handle.cleanupStatus)
        )
      ) {
        throw new Error(
          `Workspace backend handle handoff is incomplete for package ${input.packageSnapshotId}.`
        );
      }
    }
    const handles = updateBackendWorkspaceHandleCleanupStatus(
      workspaceDb,
      input.workspaceId,
      input.packageSnapshotId,
      'cleaned',
      input.completedAt
    );
    const evidence = recordWorkerBackendTeardownEvidence(workspaceDb, input);
    workspaceDb.sqlite.exec('COMMIT');
    return { evidence, handles, workspaceHandoffComplete };
  } catch (error) {
    workspaceDb.sqlite.exec('ROLLBACK');
    throw error;
  }
}

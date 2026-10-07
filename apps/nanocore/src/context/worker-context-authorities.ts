import type { FsStore } from '../lib/store.js';
import { findNamedAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import {
  isSchedulerExecutionBusyRefusal,
  listSchedulerExecutionAttemptsForTurn,
} from '../runtime/execution-attempt-records.js';
import { getWorkerBackendSession } from '../runtime/worker-backend-sessions.js';
import {
  listWorkspaceInputSnapshots,
  listWorkspaceMaterializationRecords,
  requireCompleteBackendWorkspaceHandleHandoff,
} from '../runtime/workspace-sync-records.js';
import { listSchedulerAdmissionEntriesForWorkspace } from '../scheduler-records.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { getWorkspaceMaterial, getWorkspaceMaterialRevision } from '../workspace-materials.js';
import type { WorkerContextPackageAuthorityReader } from './worker-context-package.js';

/** Dependencies for the shared read-only S39 authority map. */
export interface WorkerContextPackageAuthorityReaderInput {
  /** Core database that owns scheduler and backend-session authority. */
  readonly coreDb: CoreDb;
  /** Product store that owns Turn, Item, and AgentSession authority. */
  readonly store: FsStore;
  /** Workspace database that owns package, Goal, Material, and handoff authority. */
  readonly workspaceDb: WorkspaceDb;
}

/**
 * Builds the one stateless authority reader used by S39 writers and read projections.
 *
 * @param input Existing Core, Workspace, and product-store owners for one request scope.
 * @returns Read-only callbacks consumed by the canonical Context Package verifier.
 * @throws Error when the supplied owners belong to different data roots or Workspace lineage.
 */
export function createWorkerContextPackageAuthorityReader(
  input: WorkerContextPackageAuthorityReaderInput
): WorkerContextPackageAuthorityReader {
  const { coreDb, store, workspaceDb } = input;
  const workspace = readOrNull(() => store.getWorkspace(workspaceDb.workspaceId));
  if (
    coreDb.dataRoot !== workspaceDb.dataRoot ||
    store.getDataRoot() !== coreDb.dataRoot ||
    workspace?.id !== workspaceDb.workspaceId
  ) {
    throw new Error('Worker Context Package authority owners have different scopes.');
  }

  // The trace names an immutable snapshot, including after a session's current pointer advances.
  // Read only that filename under retained session owners; export validation stays workspace-wide.
  const readAgentEnvironmentPackage: WorkerContextPackageAuthorityReader['readAgentEnvironmentPackage'] =
    (workspaceId, packageSnapshotId) =>
      readOrNull(() => {
        const records = store
          .listWorkspaceAgentSessions(workspaceId)
          .map((session) =>
            findNamedAgentEnvironmentPackageSnapshot(
              workspaceDb,
              workspaceId,
              session.id,
              packageSnapshotId
            )
          )
          .filter((record) => record !== null);
        return records.length === 1 ? records[0]!.snapshot : null;
      });

  return {
    readAdmission: (workspaceId, threadId, turnId) => {
      const matches = listSchedulerAdmissionEntriesForWorkspace(coreDb, {
        workspaceId,
        statuses: ['admitted'],
      }).filter((entry) => entry.threadId === threadId && entry.turnId === turnId);
      return matches.length === 1 ? matches[0]! : null;
    },
    readAgentEnvironmentPackage,
    readAgentSession: (workspaceId, agentSessionId) =>
      readOrNull(() => {
        const session = store.getAgentSession(agentSessionId);
        return session.workspaceId === workspaceId && session.threadId !== null
          ? {
              id: session.id,
              workspaceId: session.workspaceId,
              threadId: session.threadId,
              environmentPackageSnapshotId: session.environmentPackageSnapshotId,
              stale: session.stale,
            }
          : null;
      }),
    readBackendHandoff: (workspaceId, packageSnapshotId) =>
      readOrNull(() => {
        const environmentPackage = readAgentEnvironmentPackage(workspaceId, packageSnapshotId);
        if (!environmentPackage) {
          return null;
        }
        const leases = listSchedulerExecutionAttemptsForTurn(coreDb, {
          workspaceId,
          threadId: environmentPackage.scope.threadId,
          turnId: environmentPackage.scope.turnId,
        })
          .filter(
            (lease) =>
              lease.agentSessionId === environmentPackage.scope.agentSessionId &&
              lease.inputRef === packageSnapshotId
          )
          .filter((attempt) => !isSchedulerExecutionBusyRefusal(attempt));
        if (leases.length !== 1) {
          return null;
        }
        const session = getWorkerBackendSession(coreDb, leases[0]!.attemptId);
        if (
          !session ||
          session.workspaceId !== workspaceId ||
          session.threadId !== environmentPackage.scope.threadId ||
          session.turnId !== environmentPackage.scope.turnId ||
          session.agentSessionId !== environmentPackage.scope.agentSessionId ||
          session.packageSnapshotId !== packageSnapshotId ||
          session.workspaceHandoffState !== 'complete'
        ) {
          return null;
        }
        requireCompleteBackendWorkspaceHandleHandoff(workspaceDb, environmentPackage, {
          backendKind: session.backendKind,
          backendVersion: session.backendVersion,
          workerSessionId: session.backendSessionId,
        });
        const materialization = listWorkspaceMaterializationRecords(workspaceDb, workspaceId).find(
          (record) =>
            record.id === `wmr_${packageSnapshotId}_context_${environmentPackage.scope.turnId}`
        );
        return materialization
          ? {
              workspaceId,
              threadId: session.threadId,
              turnId: session.turnId,
              agentSessionId: session.agentSessionId,
              packageSnapshotId,
              backendKind: session.backendKind,
              backendSessionId: session.backendSessionId,
              workspaceHandoffState: session.workspaceHandoffState,
              readinessEvidence: materialization.readinessEvidence,
            }
          : null;
      }),
    readMaterialRevision: (workspaceId, materialId, revisionId) =>
      readOrNull(() => {
        if (workspaceId !== workspaceDb.workspaceId) {
          return null;
        }
        const revision = getWorkspaceMaterialRevision(workspaceDb, materialId, revisionId);
        const material = getWorkspaceMaterial(workspaceDb, materialId);
        return revision.materialId === material.materialId
          ? { ...revision, sensitivity: material.sensitivity }
          : null;
      }),
    readThreadItems: (workspaceId, threadId) =>
      readOrNull(() => store.listThreadItems(workspaceId, threadId)) ?? [],
    readTurn: (workspaceId, threadId, turnId) =>
      readOrNull(() => {
        const turn = store.getTurn(workspaceId, threadId, turnId);
        return { ...turn, agentSessionId: turn.agentSessionId ?? null };
      }),
    readWorkspaceImportedFrom: (workspaceId) =>
      readOrNull(() =>
        workspaceId === workspaceDb.workspaceId
          ? (store.getWorkspace(workspaceId).importedFrom ?? null)
          : null
      ),
    readWorkspaceInputSnapshot: (workspaceId, snapshotId) =>
      readOrNull(
        () =>
          listWorkspaceInputSnapshots(workspaceDb, workspaceId).find(
            (snapshot) => snapshot.id === snapshotId
          ) ?? null
      ),
    readWorkspaceMaterializationRecord: (workspaceId, recordId) =>
      readOrNull(
        () =>
          listWorkspaceMaterializationRecords(workspaceDb, workspaceId).find(
            (record) => record.id === recordId
          ) ?? null
      ),
  };
}

/** Executes one authority read and converts absence or invalid authority to null. */
function readOrNull<T>(read: () => T | null): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

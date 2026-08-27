import type { FsStore } from '../lib/store.js';
import { requireAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import { getGoalRecord, listGoalTasks } from '../runtime/goal-store.js';
import { latestGateContextRefs } from '../runtime/goal-task-delegation.js';
import { getWorkerBackendSession } from '../runtime/worker-backend-sessions.js';
import {
  listWorkspaceInputSnapshots,
  listWorkspaceMaterializationRecords,
  requireCompleteBackendWorkspaceHandleHandoff,
} from '../runtime/workspace-sync-records.js';
import {
  listSchedulerAdmissionEntriesForWorkspace,
  listSchedulerSessionLeasesForTurn,
} from '../scheduler-records.js';
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

  return {
    readAdmission: (workspaceId, threadId, turnId) => {
      const matches = listSchedulerAdmissionEntriesForWorkspace(coreDb, {
        workspaceId,
        statuses: ['admitted'],
      }).filter((entry) => entry.threadId === threadId && entry.turnId === turnId);
      return matches.length === 1 ? matches[0]! : null;
    },
    readAgentEnvironmentPackage: (workspaceId, packageSnapshotId) =>
      readOrNull(
        () =>
          requireAgentEnvironmentPackageSnapshot(workspaceDb, workspaceId, packageSnapshotId)
            .snapshot
      ),
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
        const environmentPackage = requireAgentEnvironmentPackageSnapshot(
          workspaceDb,
          workspaceId,
          packageSnapshotId
        ).snapshot;
        const leases = listSchedulerSessionLeasesForTurn(coreDb, {
          workspaceId,
          threadId: environmentPackage.scope.threadId,
          turnId: environmentPackage.scope.turnId,
        }).filter(
          (lease) =>
            lease.agentSessionId === environmentPackage.scope.agentSessionId &&
            lease.packageSnapshotId === packageSnapshotId
        );
        if (leases.length !== 1) {
          return null;
        }
        const session = getWorkerBackendSession(coreDb, leases[0]!.leaseId);
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
    readGoalTask: (workspaceId, threadId, goalId, taskId) =>
      readOrNull(() => {
        const goal = getGoalRecord(workspaceDb, workspaceId, threadId, goalId);
        const task = goal
          ? listGoalTasks(workspaceDb, { workspaceId, threadId, goalId }).find(
              (candidate) => candidate.taskId === taskId
            )
          : null;
        if (!goal || !task || goal.planItemId === null || task.planItemId !== goal.planItemId) {
          return null;
        }
        const gateContextItemIds = latestGateContextRefs(
          store,
          task,
          store.listThreadItems(workspaceId, threadId)
        ).map((reference) => reference.id);
        return { goal, task, gateContextItemIds };
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

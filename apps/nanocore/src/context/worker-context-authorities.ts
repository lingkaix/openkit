import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseReferenceScope } from '@openkit/protocol';
import { readAssistantTaskHandoffSourceSteps } from '../internal-agents/assistant-handoff-source.js';
import type { FsStore } from '../lib/store.js';
import { findNamedAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import {
  isSchedulerExecutionBusyRefusal,
  readSchedulerExecutionAttemptPagesForTurn,
  type SchedulerExecutionAttemptRecord,
} from '../runtime/execution-attempt-records.js';
import { getWorkerBackendSession } from '../runtime/worker-backend-session-records.js';
import {
  readSchedulerAdmissionPagesForWorkspace,
  type SchedulerAdmissionEntryRecord,
} from '../scheduler-records.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { verifyTurnFileInput } from '../storage/workspace-file-records.js';
import {
  readWorkspaceInputSnapshotsSteps,
  readWorkspaceMaterializationRecordsSteps,
  requireCompleteBackendWorkspaceHandleHandoffSteps,
} from '../storage/workspace-handoff-read.js';
import { getWorkspaceMaterial, getWorkspaceMaterialRevision } from '../workspace-materials.js';
import type {
  WorkerContextPackageAuthorityReader,
  WorkerContextPackageAuthorityStepReader,
} from './worker-context-package.js';

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
 * Builds the live stateless authority reader with fresh reads at each original callback.
 * Portable predicates share the lazy owner-step bodies; first-delivery original-source reads stay live.
 *
 * @param input Existing Core, Workspace and product-store owners for one request scope.
 * @returns Live read-only callbacks consumed by the canonical Context Package verifier.
 * @throws Error when the supplied owners have different data roots or Workspace lineage.
 */
export function createWorkerContextPackageAuthorityReader(
  input: WorkerContextPackageAuthorityReaderInput
): WorkerContextPackageAuthorityReader {
  const { coreDb, store, workspaceDb } = input;
  const steps = workerContextAuthoritySteps(coreDb, store, workspaceDb);
  return {
    readSourceFile: (source) =>
      readOrNull(() => {
        const scope = parseReferenceScope(source.source.reference.scopeId);
        if (!scope || !('workspaceId' in scope) || scope.workspaceId !== workspaceDb.workspaceId)
          return null;
        if (source.source.kind === 'artifact') {
          const { artifact } = store.getArtifactVersion(
            scope.workspaceId,
            source.source.reference.objectId,
            source.source.artifactVersion
          );
          return {
            originalDigest: artifact.contentDigest,
            byteLength:
              artifact.content.format === 'file'
                ? artifact.content.byteLength
                : Buffer.byteLength(artifact.content.body, 'utf8'),
            mediaType:
              artifact.content.format === 'file'
                ? artifact.content.mediaType
                : artifact.content.format === 'markdown'
                  ? 'text/markdown'
                  : artifact.content.format === 'json'
                    ? 'application/json'
                    : 'text/plain',
          };
        }
        if (source.source.kind === 'material') {
          if (
            getWorkspaceMaterial(workspaceDb, source.source.reference.objectId).sensitivity ===
            'restricted'
          )
            return null;
          const revision = getWorkspaceMaterialRevision(
            workspaceDb,
            source.source.reference.objectId,
            source.source.revisionId
          );
          if (
            `sha256:${createHash('sha256').update(revision.content, 'utf8').digest('hex')}` !==
            revision.contentDigest
          )
            return null;
          return {
            originalDigest: revision.contentDigest,
            byteLength: Buffer.byteLength(revision.content, 'utf8'),
            mediaType: revision.mediaType,
          };
        }
        if (scope.family !== 'input') return null;
        const ordinal = Number(source.source.reference.objectId);
        if (
          !Number.isSafeInteger(ordinal) ||
          ordinal < 0 ||
          String(ordinal) !== source.source.reference.objectId
        )
          return null;
        const turn = store.getTurn(scope.workspaceId, scope.threadId, scope.turnId);
        const original = turn.fileInputs?.[ordinal];
        if (!original) return null;
        verifyTurnFileInput(join(coreDb.dataRoot, 'workspaces', scope.workspaceId), turn, ordinal);
        return {
          originalDigest: original.contentDigest,
          byteLength: original.sizeBytes,
          mediaType: original.mediaType,
        };
      }),
    readAssistantTaskHandoffSource: (...args) =>
      completeAuthoritySteps(steps.readAssistantTaskHandoffSource!(...args)),
    readAdmission: (...args) => completeAuthoritySteps(steps.readAdmission(...args)),
    readAgentEnvironmentPackage: (...args) =>
      completeAuthoritySteps(steps.readAgentEnvironmentPackage(...args)),
    readAgentSession: (...args) => completeAuthoritySteps(steps.readAgentSession(...args)),
    readBackendHandoff: (...args) => completeAuthoritySteps(steps.readBackendHandoff(...args)),
    readMaterialRevision: (...args) => completeAuthoritySteps(steps.readMaterialRevision(...args)),
    readThreadParent: (...args) => completeAuthoritySteps(steps.readThreadParent(...args)),
    readThreadItems: (...args) => completeAuthoritySteps(steps.readThreadItems(...args)),
    readTurn: (...args) => completeAuthoritySteps(steps.readTurn(...args)),
    readWorkspaceImportedFrom: (...args) =>
      completeAuthoritySteps(steps.readWorkspaceImportedFrom(...args)),
    readWorkspaceInputSnapshot: (...args) =>
      completeAuthoritySteps(steps.readWorkspaceInputSnapshot(...args)),
    readWorkspaceMaterializationRecord: (...args) =>
      completeAuthoritySteps(steps.readWorkspaceMaterializationRecord(...args)),
  };
}

/**
 * Builds the same authority callbacks with lazy owner-step delegation at their original branches.
 * Construction performs only the original scope check. No collection, snapshot or allow decision is
 * captured; each invocation reads afresh. Cooperative callers must not hold an enclosing SQL cut.
 *
 * @param input The same existing Core, Workspace and product-store authority owners.
 * @returns Lazy callbacks that preserve each original branch, result and owner-error boundary.
 * @throws Error when the original construction-time scope check fails.
 */
export function createWorkerContextPackageAuthorityStepReader(
  input: WorkerContextPackageAuthorityReaderInput
): WorkerContextPackageAuthorityStepReader {
  const { coreDb, store, workspaceDb } = input;
  return workerContextAuthoritySteps(coreDb, store, workspaceDb);
}

/** Shares the original scope check and callback bodies without capturing any collection at creation. */
function workerContextAuthoritySteps(
  coreDb: CoreDb,
  store: FsStore,
  workspaceDb: WorkspaceDb
): WorkerContextPackageAuthorityStepReader {
  const workspace = readOrNull(() => store.getWorkspace(workspaceDb.workspaceId));
  if (
    coreDb.dataRoot !== workspaceDb.dataRoot ||
    store.getDataRoot() !== coreDb.dataRoot ||
    workspace?.id !== workspaceDb.workspaceId
  ) {
    throw new Error('Worker Context Package authority owners have different scopes.');
  }

  // The named snapshot lookup must inspect every retained Session, including definite absence.
  const readAgentEnvironmentPackage: WorkerContextPackageAuthorityStepReader['readAgentEnvironmentPackage'] =
    function* (workspaceId, packageSnapshotId) {
      try {
        const sessions = yield* store.listWorkspaceAgentSessionsSteps(workspaceId);
        const records: Array<ReturnType<typeof findNamedAgentEnvironmentPackageSnapshot>> = [];
        for (const session of sessions) {
          records.push(
            findNamedAgentEnvironmentPackageSnapshot(
              workspaceDb,
              workspaceId,
              session.id,
              packageSnapshotId
            )
          );
          yield;
        }
        const matches = records.filter((record) => record !== null);
        return matches.length === 1 ? matches[0]!.snapshot : null;
      } catch {
        return null;
      }
    };

  return {
    *readAssistantTaskHandoffSource(receiving) {
      return receiving.workspaceId === workspaceDb.workspaceId
        ? yield* readAssistantTaskHandoffSourceSteps(store, workspaceDb, {
            workspaceId: receiving.workspaceId,
            threadId: receiving.threadId,
            turnId: receiving.turnId,
            requestId: receiving.requestId,
            turnInput: receiving.workerRequest,
          })
        : null;
    },
    *readAdmission(workspaceId, threadId, turnId) {
      const entries: SchedulerAdmissionEntryRecord[] = [];
      for (const page of readSchedulerAdmissionPagesForWorkspace(coreDb, {
        workspaceId,
        statuses: ['admitted'],
      })) {
        entries.push(...page);
        yield;
      }
      const matches = entries.filter(
        (entry) => entry.threadId === threadId && entry.turnId === turnId
      );
      return matches.length === 1 ? matches[0]! : null;
    },
    readAgentEnvironmentPackage,
    *readAgentSession(workspaceId, agentSessionId) {
      try {
        const session = yield* store.getAgentSessionSteps(agentSessionId);
        return session.workspaceId === workspaceId && session.threadId !== null
          ? {
              id: session.id,
              workspaceId: session.workspaceId,
              threadId: session.threadId,
              environmentPackageSnapshotId: session.environmentPackageSnapshotId,
              stale: session.stale,
            }
          : null;
      } catch {
        return null;
      }
    },
    *readBackendHandoff(workspaceId, packageSnapshotId) {
      try {
        // Preserve the original second fresh AEP lookup instead of retaining the verifier's result.
        const environmentPackage = yield* readAgentEnvironmentPackage(
          workspaceId,
          packageSnapshotId
        );
        if (!environmentPackage) {
          return null;
        }
        const attempts: SchedulerExecutionAttemptRecord[] = [];
        for (const page of readSchedulerExecutionAttemptPagesForTurn(coreDb, {
          workspaceId,
          threadId: environmentPackage.scope.threadId,
          turnId: environmentPackage.scope.turnId,
        })) {
          attempts.push(...page);
          yield;
        }
        const leases = attempts
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
        yield* requireCompleteBackendWorkspaceHandleHandoffSteps(workspaceDb, environmentPackage, {
          backendKind: session.backendKind,
          backendVersion: session.backendVersion,
          workerSessionId: session.backendSessionId,
        });
        const materialization = (yield* readWorkspaceMaterializationRecordsSteps(
          workspaceDb,
          workspaceId
        )).find(
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
      } catch {
        return null;
      }
    },
    // biome-ignore lint/correctness/useYield: This original addressed owner read needs no collection or scheduling step.
    *readMaterialRevision(workspaceId, materialId, revisionId) {
      try {
        if (workspaceId !== workspaceDb.workspaceId) {
          return null;
        }
        const revision = getWorkspaceMaterialRevision(workspaceDb, materialId, revisionId);
        const material = getWorkspaceMaterial(workspaceDb, materialId);
        return revision.materialId === material.materialId
          ? { ...revision, sensitivity: material.sensitivity }
          : null;
      } catch {
        return null;
      }
    },
    // biome-ignore lint/correctness/useYield: This original addressed owner read needs no collection or scheduling step.
    *readThreadParent(workspaceId, threadId) {
      try {
        return store.getThread(workspaceId, threadId).parentThreadId ?? null;
      } catch {
        return null;
      }
    },
    *readThreadItems(workspaceId, threadId) {
      try {
        const turns = yield* store.listThreadTurnsSteps(workspaceId, threadId);
        return turns.flatMap((turn) => turn.items);
      } catch {
        return [];
      }
    },
    *readTurn(workspaceId, threadId, turnId) {
      try {
        const turn = yield* store.getTurnSteps(workspaceId, threadId, turnId);
        return { ...turn, agentSessionId: turn.agentSessionId ?? null };
      } catch {
        return null;
      }
    },
    // biome-ignore lint/correctness/useYield: This original addressed owner read needs no collection or scheduling step.
    *readWorkspaceImportedFrom(workspaceId) {
      try {
        return workspaceId === workspaceDb.workspaceId
          ? (store.getWorkspace(workspaceId).importedFrom ?? null)
          : null;
      } catch {
        return null;
      }
    },
    *readWorkspaceInputSnapshot(workspaceId, snapshotId) {
      try {
        return (
          (yield* readWorkspaceInputSnapshotsSteps(workspaceDb, workspaceId)).find(
            (snapshot) => snapshot.id === snapshotId
          ) ?? null
        );
      } catch {
        return null;
      }
    },
    *readWorkspaceMaterializationRecord(workspaceId, recordId) {
      try {
        return (
          (yield* readWorkspaceMaterializationRecordsSteps(workspaceDb, workspaceId)).find(
            (record) => record.id === recordId
          ) ?? null
        );
      } catch {
        return null;
      }
    },
  };
}

/** Completes this owner's shared steps without scheduling and closes an interrupted child. */
function completeAuthoritySteps<T>(steps: Generator<void, T, void>): T {
  let complete = false;
  try {
    for (;;) {
      const step = steps.next();
      if (step.done) {
        complete = true;
        return step.value;
      }
    }
  } finally {
    if (!complete) steps.return(undefined as never);
  }
}

/** Executes one authority read and converts absence or invalid authority to null. */
function readOrNull<T>(read: () => T | null): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

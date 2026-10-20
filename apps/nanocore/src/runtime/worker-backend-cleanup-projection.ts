import {
  type BackendWorkspaceHandle,
  BackendWorkspaceHandleSchema,
  type RuntimeEvidenceRecord,
  RuntimeEvidenceRecordSchema,
} from '@openkit/app-api-schemas';
import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
} from '@openkit/config-schema';
import { z } from 'zod';
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
  /** Exact failed preparation and successful cleanup prove no materialization was published; absence alone is insufficient. */
  readonly materializationNotPublished?: boolean | undefined;
};

/** Closed native cleanup request; package and scoped lineage are checked again by the whole SQL body. */
export const ProjectWorkerBackendCleanupInputSchema: z.ZodType<ProjectWorkerBackendCleanupInput> = z
  .object({
    agentSessionId: z.string().min(1),
    backendType: z.string().min(1),
    backendVersion: z.string().nullable(),
    completedAt: z.string().datetime(),
    outcome: z.literal('succeeded'),
    packageSnapshotId: z.string().min(1),
    placement: RuntimeEvidenceRecordSchema.shape.placement,
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    workerImage: z.string().nullable(),
    workspaceId: z.string().min(1),
    environmentPackage: AgentEnvironmentPackageSchema,
    backendSessionId: z.string().min(1),
    workspaceHandoffState: z.enum(['pending', 'complete']),
    materializationNotPublished: z.boolean().optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.packageSnapshotId === input.environmentPackage.snapshotId &&
      input.workspaceId === input.environmentPackage.scope.workspaceId &&
      input.threadId === input.environmentPackage.scope.threadId &&
      input.turnId === input.environmentPackage.scope.turnId &&
      input.agentSessionId === input.environmentPackage.scope.agentSessionId,
    'Native cleanup input must retain its exact admitted package lineage.'
  );

/** Closed durable acknowledgement projection, not a physical release or a second cleanup record. */
export const WorkerBackendCleanupProjectionResultSchema = z
  .object({
    handles: z.array(BackendWorkspaceHandleSchema),
    evidence: RuntimeEvidenceRecordSchema,
    workspaceHandoffComplete: z.boolean(),
  })
  .strict();

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
    const result = projectWorkerBackendCleanupInDb(workspaceDb, input);
    workspaceDb.sqlite.exec('COMMIT');
    return result;
  } catch (error) {
    workspaceDb.sqlite.exec('ROLLBACK');
    throw error;
  }
}

/** Applies the whole cleanup decision in the caller's owning transaction, without opening or committing a sibling body. */
export function projectWorkerBackendCleanupInDb(
  workspaceDb: WorkspaceDb,
  input: ProjectWorkerBackendCleanupInput
): WorkerBackendCleanupProjectionResult {
  if (!workspaceDb.sqlite.inTransaction)
    throw new Error('Backend cleanup projection requires its owning transaction.');
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
    input.environmentPackage.workspace.inputs.length === 0 ||
    input.materializationNotPublished === true;
  // Exact no-materialization proof survives the complete marker.
  // Any published row still requires the full handoff validator, even when the caller supplies that proof.
  if (
    anyHandoffRows ||
    (input.workspaceHandoffState === 'complete' && input.materializationNotPublished !== true)
  ) {
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
  return { evidence, handles, workspaceHandoffComplete };
}

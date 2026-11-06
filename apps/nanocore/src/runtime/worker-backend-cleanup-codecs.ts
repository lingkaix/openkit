import {
  BackendWorkspaceHandleSchema,
  RuntimeEvidenceRecordSchema,
} from '@openkit/app-api-schemas';
import { AgentEnvironmentPackageSchema } from '@openkit/config-schema';
import { z } from 'zod';
import type { ProjectWorkerBackendCleanupInput } from './worker-backend-cleanup-projection.js';

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

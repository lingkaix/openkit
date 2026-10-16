import { NativeEnvironmentRecordSchema } from '@openkit/config-schema/native-environment';
import {
  AgentSessionIdSchema,
  ThreadIdSchema,
  TimestampSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';

/** Product-safe redacted Agent Environment Package snapshot record. */
export const AgentEnvironmentPackageSnapshotRecordSchema = z
  .object({
    snapshotId: z.string().min(1),
    workspaceId: WorkspaceIdSchema,
    turnId: TurnIdSchema,
    threadId: ThreadIdSchema,
    agentSessionId: AgentSessionIdSchema,
    agentId: z.string().min(1),
    packageId: z.string().min(1),
    runtimeKind: z.string().min(1),
    backendKind: z.string().min(1),
    contentDigest: z.string().min(1),
    snapshot: z.record(z.string(), z.any()),
    createdAt: TimestampSchema,
  })
  .strip()
  .superRefine((value, ctx) => {
    const runtime = value.snapshot.runtime;
    if (runtime && typeof runtime === 'object' && runtime.environment !== undefined) {
      const publicEnvironment = NativeEnvironmentRecordSchema.safeParse(runtime.environment);
      if (!publicEnvironment.success) {
        ctx.addIssue({
          code: 'custom',
          message: 'Public native environment is invalid.',
          path: ['snapshot', 'runtime', 'environment'],
        });
        return;
      }
    }
  });

/** App API response listing durable redacted AEP snapshots for one workspace. */
export const ListAgentEnvironmentPackageSnapshotsResponseSchema = z
  .object({
    items: z.array(AgentEnvironmentPackageSnapshotRecordSchema),
  })
  .strict();

/** App API response reading one durable redacted AEP snapshot. */
export const GetAgentEnvironmentPackageSnapshotResponseSchema =
  AgentEnvironmentPackageSnapshotRecordSchema;

/** Product-safe redacted Agent Environment Package snapshot record. */
export type AgentEnvironmentPackageSnapshotRecord = z.infer<
  typeof AgentEnvironmentPackageSnapshotRecordSchema
>;
/** App API response listing durable redacted AEP snapshots for one workspace. */
export type ListAgentEnvironmentPackageSnapshotsResponse = z.infer<
  typeof ListAgentEnvironmentPackageSnapshotsResponseSchema
>;
/** App API response reading one durable redacted AEP snapshot. */
export type GetAgentEnvironmentPackageSnapshotResponse = z.infer<
  typeof GetAgentEnvironmentPackageSnapshotResponseSchema
>;

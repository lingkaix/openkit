import { NativeEnvironmentRecordSchema } from '@openkit/config-schema';
import { TimestampSchema } from '@openkit/protocol';
import { z } from 'zod';
import { addRawSecretIssues } from './raw-secrets.js';

/** Product-safe redacted Agent Environment Package snapshot record. */
export const AgentEnvironmentPackageSnapshotRecordSchema = z
  .object({
    snapshotId: z.string().min(1),
    workspaceId: z.string().min(1),
    turnId: z.string().min(1),
    threadId: z.string().min(1),
    agentSessionId: z.string().min(1),
    agentId: z.string().min(1),
    packageId: z.string().min(1),
    runtimeKind: z.string().min(1),
    backendKind: z.string().min(1),
    contentDigest: z.string().min(1),
    snapshot: z.record(z.string(), z.any()),
    createdAt: TimestampSchema,
  })
  .strict()
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
      // Validated public literals are never classified as credentials by string shape.
      addRawSecretIssues(
        {
          ...value,
          snapshot: {
            ...value.snapshot,
            runtime: { ...runtime, environment: { ...publicEnvironment.data, values: {} } },
          },
        },
        ctx,
        []
      );
      return;
    }
    addRawSecretIssues(value, ctx, []);
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

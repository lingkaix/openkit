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
    addRawSecretIssues(value, ctx, []);
  });

/** App API response listing durable redacted AEP snapshots for one workspace. */
export const ListAgentEnvironmentPackageSnapshotsResponseSchema = z
  .object({
    items: z.array(AgentEnvironmentPackageSnapshotRecordSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

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

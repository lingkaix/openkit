import { AgentSessionStatusSchema, TimestampSchema } from '@openkit/protocol';
import { z } from 'zod';
import { addRawSecretIssues } from './raw-secrets.js';

/** Last recorded current AgentSession status; terminal states are not Worker rows. */
export const WorkspaceWorkerStatusSchema = AgentSessionStatusSchema.exclude([
  'interrupted',
  'failed',
  'closed',
]);

/** Exact current work affiliation from a matching uncleared Worker checkpoint. */
export const WorkspaceWorkerWorkSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('none'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('unavailable'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('task'),
      turnId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('goal'),
      turnId: z.string().min(1),
      goalId: z.string().min(1),
      taskId: z.string().min(1),
    })
    .strict(),
]);

/** Allowlisted package policy default projected from known labels. */
export const WorkspaceWorkerPolicyDefaultSchema = z.enum(['allow', 'deny']);

/** Allowlisted package policy enforcement projected from known labels. */
export const WorkspaceWorkerPolicyEnforcementSchema = z.enum(['openshell', 'none']);

/** Product-safe filesystem, network, or process policy summary. */
export const WorkspaceWorkerPolicyDimensionSchema = z
  .object({
    default: WorkspaceWorkerPolicyDefaultSchema.nullable(),
    enforcement: WorkspaceWorkerPolicyEnforcementSchema.nullable(),
    ruleCount: z.number().int().nonnegative(),
  })
  .strict();

/** Package-selected Workspace MCP server names without runtime connection details. */
export const WorkspaceWorkerMcpServerSchema = z
  .object({
    id: z.string().min(1),
    allowedTools: z.array(z.string().min(1)),
    deniedTools: z.array(z.string().min(1)),
    approvalRequiredTools: z.array(z.string().min(1)),
  })
  .strict();

/** Current package snapshot details after exact Workspace, Thread, and AgentSession scope match. */
export const WorkspaceWorkerPackageDetailsSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('available'),
      preferredLogicalModelId: z.string().min(1),
      mcpServers: z.array(WorkspaceWorkerMcpServerSchema),
      filesystem: WorkspaceWorkerPolicyDimensionSchema.nullable(),
      network: WorkspaceWorkerPolicyDimensionSchema.nullable(),
      process: WorkspaceWorkerPolicyDimensionSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('unavailable'),
    })
    .strict(),
]);

/** Last attributed LLM usage for the current AgentSession, or an explicit restriction. */
export const WorkspaceWorkerLastUsedModelSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('available'),
      modelId: z.string().min(1),
      recordedAt: TimestampSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('unavailable'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('restricted'),
    })
    .strict(),
]);

/** One current Worker row keyed by Thread. */
export const WorkspaceWorkerSchema = z
  .object({
    threadId: z.string().min(1),
    threadTitle: z.string().min(1),
    agentId: z.string().min(1),
    agentName: z.string().min(1),
    status: WorkspaceWorkerStatusSchema,
    recordUpdatedAt: TimestampSchema,
    /** Existing setup/continuity staleness; does not describe read freshness or process liveness. */
    stale: z.boolean(),
    work: WorkspaceWorkerWorkSchema,
    packageDetails: WorkspaceWorkerPackageDetailsSchema,
    lastUsedModel: WorkspaceWorkerLastUsedModelSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Selected-Workspace current Worker inventory. */
export const WorkspaceWorkersResponseSchema = z
  .object({
    workspaceId: z.string().min(1),
    items: z.array(WorkspaceWorkerSchema),
  })
  .strict();

/** Last recorded current AgentSession status. */
export type WorkspaceWorkerStatus = z.infer<typeof WorkspaceWorkerStatusSchema>;
/** Exact current work affiliation. */
export type WorkspaceWorkerWork = z.infer<typeof WorkspaceWorkerWorkSchema>;
/** Allowlisted package policy default. */
export type WorkspaceWorkerPolicyDefault = z.infer<typeof WorkspaceWorkerPolicyDefaultSchema>;
/** Allowlisted package policy enforcement. */
export type WorkspaceWorkerPolicyEnforcement = z.infer<
  typeof WorkspaceWorkerPolicyEnforcementSchema
>;
/** Product-safe policy dimension summary. */
export type WorkspaceWorkerPolicyDimension = z.infer<typeof WorkspaceWorkerPolicyDimensionSchema>;
/** Package-selected MCP server summary. */
export type WorkspaceWorkerMcpServer = z.infer<typeof WorkspaceWorkerMcpServerSchema>;
/** Current package snapshot details. */
export type WorkspaceWorkerPackageDetails = z.infer<typeof WorkspaceWorkerPackageDetailsSchema>;
/** Last attributed LLM usage or restriction. */
export type WorkspaceWorkerLastUsedModel = z.infer<typeof WorkspaceWorkerLastUsedModelSchema>;
/** One current Worker row keyed by Thread. */
export type WorkspaceWorker = z.infer<typeof WorkspaceWorkerSchema>;
/** Selected-Workspace current Worker inventory. */
export type WorkspaceWorkersResponse = z.infer<typeof WorkspaceWorkersResponseSchema>;

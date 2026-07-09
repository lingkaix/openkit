import { z } from 'zod';
import { addRawSecretIssues } from './raw-secrets.js';

/** Non-secret workspace vault grant metadata exposed through the App API. */
export const WorkspaceVaultGrantSchema = z
  .object({
    grantId: z.string().min(1),
    vaultReferenceId: z.string().min(1),
    ownerScope: z.literal('workspace'),
    workspaceId: z.string().min(1),
    userId: z.null(),
    subjectSummary: z.string().min(1).nullable(),
    targetAgentId: z.string().min(1).nullable(),
    targetAgentSessionId: z.string().min(1).nullable(),
    targetCapabilityId: z.string().min(1).nullable(),
    allowedInjectionPaths: z.array(z.string().min(1)),
    lifetime: z.enum(['session', 'turn', 'capability-call', 'workspace', 'until-revoked']),
    policyDecisionId: z.string().min(1).nullable(),
    approvalId: z.string().min(1).nullable(),
    status: z.enum(['active', 'revoked', 'expired']),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime().nullable(),
  })
  .strict()
  .superRefine((value, ctx) => addRawSecretIssues(value, ctx, []));

/** Non-secret workspace injection plan metadata exposed through the App API. */
export const WorkspaceInjectionPlanSchema = z
  .object({
    planId: z.string().min(1),
    grantId: z.string().min(1),
    packageSnapshotId: z.string().min(1).nullable(),
    capabilityId: z.string().min(1).nullable(),
    injectionVisibility: z.enum(['gateway-only', 'backend-provider', 'runtime-file']),
    targetPath: z.string().min(1).nullable(),
    targetEnvVarName: z.string().min(1).nullable(),
    expirationBehavior: z.string().min(1),
    revocationBehavior: z.string().min(1),
    redactionRule: z.string().min(1),
    backendCapabilityRequirement: z.string().min(1),
    status: z.enum(['active', 'revoked', 'expired']),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((value, ctx) => addRawSecretIssues(value, ctx, []));

/** Non-secret workspace injection receipt metadata exposed through the App API. */
export const WorkspaceInjectionReceiptSchema = z
  .object({
    receiptId: z.string().min(1),
    planId: z.string().min(1),
    grantId: z.string().min(1),
    agentSessionId: z.string().min(1).nullable(),
    capabilityCallId: z.string().min(1).nullable(),
    backendSummary: z.string().min(1),
    injectedAt: z.string().datetime(),
    expiresAt: z.string().datetime().nullable(),
    revocationStatus: z.enum(['active', 'revoked', 'expired', 'stale-session']),
    auditEventId: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => addRawSecretIssues(value, ctx, []));

/** Workspace vault grant list response. */
export const ListWorkspaceVaultGrantsResponseSchema = z
  .object({
    workspaceId: z.string().min(1),
    items: z.array(WorkspaceVaultGrantSchema),
  })
  .strict()
  .superRefine((value, ctx) => addRawSecretIssues(value, ctx, []));

/** Workspace injection plan list response. */
export const ListWorkspaceInjectionPlansResponseSchema = z
  .object({
    workspaceId: z.string().min(1),
    items: z.array(WorkspaceInjectionPlanSchema),
  })
  .strict()
  .superRefine((value, ctx) => addRawSecretIssues(value, ctx, []));

/** Workspace injection receipt list response. */
export const ListWorkspaceInjectionReceiptsResponseSchema = z
  .object({
    workspaceId: z.string().min(1),
    items: z.array(WorkspaceInjectionReceiptSchema),
  })
  .strict()
  .superRefine((value, ctx) => addRawSecretIssues(value, ctx, []));

/** Non-secret workspace vault grant metadata. */
export type WorkspaceVaultGrant = z.infer<typeof WorkspaceVaultGrantSchema>;
/** Non-secret workspace injection plan metadata. */
export type WorkspaceInjectionPlan = z.infer<typeof WorkspaceInjectionPlanSchema>;
/** Non-secret workspace injection receipt metadata. */
export type WorkspaceInjectionReceipt = z.infer<typeof WorkspaceInjectionReceiptSchema>;
/** Workspace vault grant list response. */
export type ListWorkspaceVaultGrantsResponse = z.infer<
  typeof ListWorkspaceVaultGrantsResponseSchema
>;
/** Workspace injection plan list response. */
export type ListWorkspaceInjectionPlansResponse = z.infer<
  typeof ListWorkspaceInjectionPlansResponseSchema
>;
/** Workspace injection receipt list response. */
export type ListWorkspaceInjectionReceiptsResponse = z.infer<
  typeof ListWorkspaceInjectionReceiptsResponseSchema
>;

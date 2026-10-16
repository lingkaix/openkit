import {
  AgentSessionIdSchema,
  AuditEventIdSchema,
  CapabilityCallIdSchema,
  PermissionDecisionIdSchema,
  VaultGrantIdSchema,
  VaultReferenceIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import { addRawSecretIssues } from './raw-secrets.js';

/** Closed injection visibility classes shared by public, storage, and archive records. */
export const InjectionVisibilitySchema = z.enum([
  'gateway-only',
  'backend-provider',
  'runtime-file',
  'runtime-env',
  'runtime-token',
  'external-handle',
]);

/** Injection visibility inferred from the shared closed schema. */
export type InjectionVisibility = z.infer<typeof InjectionVisibilitySchema>;

/** Non-secret workspace vault grant metadata exposed through the App API. */
export const WorkspaceVaultGrantSchema = z
  .object({
    issuance: z.enum(['target', 'imported-history']),
    grantId: VaultGrantIdSchema,
    vaultReferenceId: VaultReferenceIdSchema,
    ownerScope: z.literal('workspace'),
    workspaceId: WorkspaceIdSchema,
    userId: z.null(),
    subjectSummary: z.string().min(1).nullable(),
    targetAgentId: z.string().min(1).nullable(),
    targetAgentSessionId: AgentSessionIdSchema.nullable(),
    targetCapabilityId: z.string().min(1).nullable(),
    allowedInjectionPaths: z.array(z.string().min(1)),
    lifetime: z.enum(['session', 'turn', 'capability-call', 'workspace', 'until-revoked']),
    policyDecisionId: PermissionDecisionIdSchema.nullable(),
    approvalId: z.string().min(1).nullable(),
    status: z.enum(['active', 'revoked', 'expired']),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime().nullable(),
  })
  .strict()
  .superRefine((value, ctx) => addRawSecretIssues(value, ctx, []));

/** Non-secret workspace injection plan metadata exposed through the App API. */
export const WorkspaceVaultInjectionPlanSchema = z
  .object({
    planId: z.string().min(1),
    grantId: VaultGrantIdSchema,
    packageSnapshotId: z.string().min(1).nullable(),
    capabilityId: z.string().min(1).nullable(),
    injectionVisibility: InjectionVisibilitySchema,
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
export const WorkspaceVaultInjectionReceiptSchema = z
  .object({
    receiptId: z.string().min(1),
    planId: z.string().min(1),
    grantId: VaultGrantIdSchema,
    agentSessionId: AgentSessionIdSchema.nullable(),
    capabilityCallId: CapabilityCallIdSchema.nullable(),
    backendSummary: z.string().min(1),
    injectedAt: z.string().datetime(),
    expiresAt: z.string().datetime().nullable(),
    revocationStatus: z.enum(['active', 'revoked', 'expired', 'stale-session']),
    auditEventId: AuditEventIdSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => addRawSecretIssues(value, ctx, []));

/** Workspace vault grant list response. */
export const ListWorkspaceVaultGrantsResponseSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    items: z.array(WorkspaceVaultGrantSchema),
  })
  .strict()
  .superRefine((value, ctx) => addRawSecretIssues(value, ctx, []));

/** Workspace injection plan list response. */
export const ListWorkspaceVaultInjectionPlansResponseSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    items: z.array(WorkspaceVaultInjectionPlanSchema),
  })
  .strict()
  .superRefine((value, ctx) => addRawSecretIssues(value, ctx, []));

/** Workspace injection receipt list response. */
export const ListWorkspaceVaultInjectionReceiptsResponseSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    items: z.array(WorkspaceVaultInjectionReceiptSchema),
  })
  .strict()
  .superRefine((value, ctx) => addRawSecretIssues(value, ctx, []));

/** Non-secret workspace vault grant metadata. */
export type WorkspaceVaultGrant = z.infer<typeof WorkspaceVaultGrantSchema>;
/** Non-secret workspace injection plan metadata. */
export type WorkspaceVaultInjectionPlan = z.infer<typeof WorkspaceVaultInjectionPlanSchema>;
/** Non-secret workspace injection receipt metadata. */
export type WorkspaceVaultInjectionReceipt = z.infer<typeof WorkspaceVaultInjectionReceiptSchema>;
/** Workspace vault grant list response. */
export type ListWorkspaceVaultGrantsResponse = z.infer<
  typeof ListWorkspaceVaultGrantsResponseSchema
>;
/** Workspace injection plan list response. */
export type ListWorkspaceVaultInjectionPlansResponse = z.infer<
  typeof ListWorkspaceVaultInjectionPlansResponseSchema
>;
/** Workspace injection receipt list response. */
export type ListWorkspaceVaultInjectionReceiptsResponse = z.infer<
  typeof ListWorkspaceVaultInjectionReceiptsResponseSchema
>;

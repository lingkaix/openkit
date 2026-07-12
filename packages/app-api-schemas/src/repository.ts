import { ApprovalRequestSchema, TimestampSchema } from '@openkit/protocol';
import { z } from 'zod';
import { addRawSecretIssues } from './raw-secrets.js';

const obviousAbsolutePathPattern = /^(?:\/|~\/|[A-Za-z]:[\\/]|\\\\|\/\/)/;
const embeddedAbsolutePathPattern = /(?:^|[\s"'`(])(?:\/|~\/|[A-Za-z]:[\\/]|\\\\|\/\/)\S*/;

/**
 * Checks whether a display name is shaped like an obvious host absolute path.
 *
 * @param value Candidate display name.
 * @returns True when the value appears to expose an absolute host path.
 */
function isObviousAbsolutePathDisplayName(value: string): boolean {
  return obviousAbsolutePathPattern.test(value.trim());
}

/**
 * Checks whether user-safe repository text appears to embed a host absolute path.
 *
 * @param value Candidate text from a stable App API payload.
 * @returns True when the text appears to contain an absolute host path.
 */
function hasEmbeddedAbsolutePath(value: string): boolean {
  return embeddedAbsolutePathPattern.test(value.trim());
}

/** User-safe repository text without obvious absolute host paths. */
const RepositorySafeTextSchema = z
  .string()
  .min(1)
  .refine((value) => !hasEmbeddedAbsolutePath(value), {
    message: 'text must not expose an absolute host path',
  });

/** User-safe repository display name without obvious absolute host paths. */
const RepositoryDisplayNameSchema = z
  .string()
  .min(1)
  .refine((value) => !isObviousAbsolutePathDisplayName(value), {
    message: 'displayName must not expose an absolute host path',
  })
  .refine((value) => !hasEmbeddedAbsolutePath(value), {
    message: 'displayName must not embed an absolute host path',
  });

/** App API repository resource type. */
export const WorkspaceRepositoryResourceTypeSchema = z.literal('git_repository');

/** App API repository diagnostics status. */
export const WorkspaceRepositoryDiagnosticsStatusSchema = z.enum([
  'unknown',
  'ready',
  'missing',
  'not_directory',
  'not_git',
  'inaccessible',
]);

/** User-safe repository validation diagnostics. */
export const WorkspaceRepositoryValidationSchema = z
  .object({
    ok: z.boolean(),
    resourceKind: WorkspaceRepositoryResourceTypeSchema,
    status: WorkspaceRepositoryDiagnosticsStatusSchema.exclude(['unknown']),
    summary: RepositorySafeTextSchema,
    pathSummary: RepositorySafeTextSchema,
  })
  .strict();

/** Git write behavior configured for one linked repository. */
export const WorkspaceRepositoryGitConfigSchema = z
  .object({
    authorEmail: z.string().email().nullable(),
    authorName: z.string().min(1).nullable(),
    allowedPushTargets: z.array(z.string().min(1)).default([]),
    commitOnApply: z.boolean(),
    protectedBranchPatterns: z
      .array(z.string().min(1))
      .default(['main', 'master', 'release/*', 'v*']),
    requireReviewLinkage: z.boolean().default(true),
    stagingStrategy: z.enum(['staging-root', 'review-branch']).default('staging-root'),
    vaultGrantRef: z.string().min(1).nullable().default(null),
  })
  .strict();

/** Durable Git push attempt outcome. */
export const GitPushRecordOutcomeSchema = z.enum([
  'pushed',
  'rejected-non-fast-forward',
  'rejected-protected',
  'auth-failed',
  'remote-unreachable',
  'refused-policy',
  'refused-linkage',
  'unsupported-provider',
]);

/** Durable, redacted Git push attempt read model. */
export const GitPushRecordSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    repositoryResourceId: z.string().min(1),
    approvalRowId: z.string().min(1).nullable(),
    policyDecisionId: z.string().min(1).nullable(),
    actorId: z.string().min(1).nullable(),
    remoteSummary: RepositorySafeTextSchema,
    sourceRef: z.string().min(1),
    targetBranch: z.string().min(1),
    commitIds: z.array(z.string().min(1)),
    reviewIds: z.array(z.string().min(1)),
    remoteHeadBefore: z.string().min(1).nullable(),
    remoteHeadAfter: z.string().min(1).nullable(),
    outcome: GitPushRecordOutcomeSchema,
    errorSummary: RepositorySafeTextSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Redacted workspace repository resource read model. */
export const WorkspaceRepositoryResourceSchema = z
  .object({
    workspaceId: z.string().min(1),
    resourceId: z.string().min(1),
    type: WorkspaceRepositoryResourceTypeSchema,
    displayName: RepositoryDisplayNameSchema,
    diagnosticsStatus: WorkspaceRepositoryDiagnosticsStatusSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    pathSummary: RepositorySafeTextSchema,
    git: WorkspaceRepositoryGitConfigSchema,
    validation: WorkspaceRepositoryValidationSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Redacted workspace repository diagnostics row. */
export const WorkspaceRepositoryDiagnosticSchema = z
  .object({
    workspaceId: z.string().min(1),
    resourceId: z.string().min(1),
    type: WorkspaceRepositoryResourceTypeSchema,
    displayName: RepositoryDisplayNameSchema,
    diagnosticsStatus: WorkspaceRepositoryDiagnosticsStatusSchema.exclude(['unknown']),
    ready: z.boolean(),
    summary: RepositorySafeTextSchema,
    pathSummary: RepositorySafeTextSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Response payload for listing one workspace's repository resources. */
export const ListWorkspaceRepositoriesResponseSchema = z
  .object({
    items: z.array(WorkspaceRepositoryResourceSchema),
    defaultResourceId: z.string().min(1).nullable(),
    defaultResource: WorkspaceRepositoryResourceSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Response payload for one workspace's redacted repository diagnostics. */
export const WorkspaceRepositoryDiagnosticsResponseSchema = z
  .object({
    workspaceId: z.string().min(1),
    defaultResourceId: z.string().min(1).nullable(),
    defaultResource: WorkspaceRepositoryDiagnosticSchema.nullable(),
    resources: z.array(WorkspaceRepositoryDiagnosticSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Response payload for listing one workspace's Git push records. */
export const ListGitPushRecordsResponseSchema = z
  .object({
    items: z.array(GitPushRecordSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Response payload for reading one Git push record. */
export const GetGitPushRecordResponseSchema = GitPushRecordSchema;

/** Request payload for opening one approval-gated Git push action. */
export const RequestGitPushApprovalRequestSchema = z
  .object({
    requestId: z.string().min(1),
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    sourceRef: z.string().min(1),
    targetBranch: z.string().min(1),
    commitIds: z.array(z.string().min(1)).min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Response payload for one opened Git push approval gate. */
export const RequestGitPushApprovalResponseSchema = z
  .object({
    approval: ApprovalRequestSchema,
    approvalItemId: z.string().min(1),
    policyDecisionId: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Request payload for executing one approved Git push. */
export const ExecuteGitPushRequestSchema = z
  .object({
    requestId: z.string().min(1),
    approvalRequestId: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Response payload for one approved Git push attempt. */
export const ExecuteGitPushResponseSchema = GitPushRecordSchema;

/** Request payload for creating or updating one workspace repository resource. */
export const SetWorkspaceRepositoryRequestSchema = z
  .object({
    resourceId: z.string().min(1).optional(),
    displayName: z.string().min(1),
    localPath: z.string().min(1),
    git: WorkspaceRepositoryGitConfigSchema.optional(),
  })
  .strict();

/** Response payload for creating or updating one workspace repository resource. */
export const SetWorkspaceRepositoryResponseSchema = z
  .object({
    repository: WorkspaceRepositoryResourceSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** App API repository resource type. */
export type WorkspaceRepositoryResourceType = z.infer<typeof WorkspaceRepositoryResourceTypeSchema>;
/** App API repository diagnostics status. */
export type WorkspaceRepositoryDiagnosticsStatus = z.infer<
  typeof WorkspaceRepositoryDiagnosticsStatusSchema
>;
/** User-safe repository validation diagnostics. */
export type WorkspaceRepositoryValidation = z.infer<typeof WorkspaceRepositoryValidationSchema>;
/** Git write behavior configured for one linked repository. */
export type WorkspaceRepositoryGitConfig = z.infer<typeof WorkspaceRepositoryGitConfigSchema>;
/** Durable Git push attempt outcome. */
export type GitPushRecordOutcome = z.infer<typeof GitPushRecordOutcomeSchema>;
/** Durable, redacted Git push attempt read model. */
export type GitPushRecord = z.infer<typeof GitPushRecordSchema>;
/** Redacted workspace repository resource read model. */
export type WorkspaceRepositoryResource = z.infer<typeof WorkspaceRepositoryResourceSchema>;
/** Redacted workspace repository diagnostics row. */
export type WorkspaceRepositoryDiagnostic = z.infer<typeof WorkspaceRepositoryDiagnosticSchema>;
/** Response payload for listing one workspace's Git push records. */
export type ListGitPushRecordsResponse = z.infer<typeof ListGitPushRecordsResponseSchema>;
/** Response payload for reading one Git push record. */
export type GetGitPushRecordResponse = z.infer<typeof GetGitPushRecordResponseSchema>;
/** Request payload for opening one approval-gated Git push action. */
export type RequestGitPushApprovalRequest = z.infer<typeof RequestGitPushApprovalRequestSchema>;
/** Response payload for one opened Git push approval gate. */
export type RequestGitPushApprovalResponse = z.infer<typeof RequestGitPushApprovalResponseSchema>;
/** Request payload for executing one approved Git push. */
export type ExecuteGitPushRequest = z.infer<typeof ExecuteGitPushRequestSchema>;
/** Response payload for one approved Git push attempt. */
export type ExecuteGitPushResponse = z.infer<typeof ExecuteGitPushResponseSchema>;
/** Response payload for listing one workspace's repository resources. */
export type ListWorkspaceRepositoriesResponse = z.infer<
  typeof ListWorkspaceRepositoriesResponseSchema
>;
/** Response payload for one workspace's redacted repository diagnostics. */
export type WorkspaceRepositoryDiagnosticsResponse = z.infer<
  typeof WorkspaceRepositoryDiagnosticsResponseSchema
>;
/** Request payload for creating or updating one workspace repository resource. */
export type SetWorkspaceRepositoryRequest = z.infer<typeof SetWorkspaceRepositoryRequestSchema>;
/** Response payload for creating or updating one workspace repository resource. */
export type SetWorkspaceRepositoryResponse = z.infer<typeof SetWorkspaceRepositoryResponseSchema>;

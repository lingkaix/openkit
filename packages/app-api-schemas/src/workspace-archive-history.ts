import { TimestampSchema } from '@openkit/protocol';
import { z } from 'zod';

/** Retired host records are archive history only; these codecs supply no resource or execution authority. */
const embeddedAbsolutePathPattern = /(?:^|[\s"'`(])(?:\/|~\/|[A-Za-z]:[\\/]|\\\\|\/\/)\S*/;

/** Detects host paths that must never leak through archived safe text. */
function hasEmbeddedAbsolutePath(value: string): boolean {
  return embeddedAbsolutePathPattern.test(value.trim());
}

const RepositorySafeTextSchema = z
  .string()
  .min(1)
  .refine((value) => !hasEmbeddedAbsolutePath(value), {
    message: 'text must not expose an absolute host path',
  });

/** Validates inert configuration metadata in pre-retirement Workspace archives. */
export const ArchivedWorkspaceRepositoryGitConfigSchema = z
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

const GitPushRecordOutcomeSchema = z.enum([
  'pushed',
  'rejected-non-fast-forward',
  'rejected-protected',
  'auth-failed',
  'remote-unreachable',
  'refused-policy',
  'refused-linkage',
  'unsupported-provider',
]);

/** Validates historical push evidence without supplying execution or resource authority. */
export const ArchivedGitPushRecordSchema = z
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
  .strict();

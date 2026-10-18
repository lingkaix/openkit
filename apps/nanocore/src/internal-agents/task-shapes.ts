import { PolicyResourceV1Schema } from '@openkit/protocol';
import { z } from 'zod';

/** Typed Policy selectors and descriptive references remain distinct in one Task request. */
export const TaskResourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.enum(['repository', 'file', 'item', 'artifact', 'knowledge', 'external']),
      reference: z.string().min(1).max(1_000),
      reason: z.string().min(1).max(1_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('policy'),
      resource: PolicyResourceV1Schema,
      reason: z.string().min(1).max(1_000),
    })
    .strict(),
]);

/** Expected artifact or output from one Task. */
export const TaskExpectedArtifactSchema = z
  .object({
    kind: z.enum(['code-change', 'test-result', 'document', 'artifact']),
    description: z.string().min(1).max(1_000),
  })
  .strict();

/** Verification check expected after one Task. */
export const TaskVerificationCheckSchema = z
  .object({
    kind: z.enum(['command', 'test', 'manual']),
    description: z.string().min(1).max(1_000),
    command: z.string().min(1).max(1_000).optional(),
  })
  .strict();

/** Review policy attached to one Task. */
export const TaskReviewPolicySchema = z
  .object({
    required: z.boolean(),
    reviewers: z.tuple([z.literal('human')]),
    instructions: z.string().min(1).max(2_000),
  })
  .strict();

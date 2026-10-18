import { MaterialIdSchema, MaterialRevisionIdSchema } from '@openkit/protocol';
import { z } from 'zod';

const contentDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/** Exact original-source UTF-16 range on one immutable Material proposal base. */
export const ArtifactReviewRangeFeedbackSchema = z
  .object({
    materialId: MaterialIdSchema,
    revisionId: MaterialRevisionIdSchema,
    contentDigest: contentDigestSchema,
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    originalText: z.string().min(1),
  })
  .strict()
  .refine((range) => range.start < range.end, {
    message: 'The range end must follow its start.',
    path: ['end'],
  });

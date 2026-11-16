import { ThreadSchema } from '@openkit/protocol';
import { z } from 'zod';

const { segment: _segment, segmentation: _segmentation, ...productFields } = ThreadSchema.shape;

/** Current product view excludes retained segmentation reservations from settled operation outputs. */
export const ProductThreadSchema = z.object(productFields).superRefine((thread, context) => {
  // Reuse the canonical owner and visibility checks; only the outward field inventory differs.
  const parsed = ThreadSchema.safeParse(thread);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      context.addIssue({ code: 'custom', path: issue.path, message: issue.message });
    }
  }
});

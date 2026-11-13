import { z } from 'zod';

/** Server-owned E3 sources; parsing neither selects defaults nor enables monitoring. */
export const SecurityFeedConfigSchema = z
  .object({
    id: z.string().refine((value) => value.trim().length > 0, 'Feed ID must not be blank.'),
    name: z.string().refine((value) => value.trim().length > 0, 'Feed name must not be blank.'),
    kind: z.enum(['osv-api', 'osv-records', 'kev', 'rss']),
    location: z
      .string()
      .refine((value) => value.trim().length > 0, 'Feed location must not be blank.'),
  })
  .strict()
  .superRefine((feed, context) => {
    const isUrl = /^[a-z][a-z0-9+.-]*:/i.test(feed.location.trim());
    let valid = feed.kind === 'osv-records' && !isUrl;
    if (isUrl) {
      try {
        const url = new URL(feed.location);
        valid = url.protocol === 'https:' && !url.username && !url.password && !url.hash;
      } catch {
        valid = false;
      }
    }
    if (!valid)
      context.addIssue({
        code: 'custom',
        path: ['location'],
        message: 'Feed location requires HTTPS; only OSV records also accept a local path.',
      });
  });

/** Authored feed choices only; the recurring trigger owns enablement and retained reports. */
export const SecurityConfigSchema = z
  .object({
    feeds: z.array(SecurityFeedConfigSchema).optional(),
  })
  .strict()
  .superRefine((security, context) => {
    const ids = new Set<string>();
    for (const [index, feed] of (security.feeds ?? []).entries()) {
      if (ids.has(feed.id))
        context.addIssue({
          code: 'custom',
          path: ['feeds', index, 'id'],
          message: 'Feed IDs must be unique.',
        });
      ids.add(feed.id);
    }
  });

/** A named administrator-selected endpoint; OSV API selection discloses component identities. */
export type SecurityFeedConfig = z.infer<typeof SecurityFeedConfigSchema>;
/** Server configuration projection without a second monitor state or implicit remote sources. */
export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;

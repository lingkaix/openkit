import { z } from 'zod';
import {
  KnowledgeContentDigestSchema,
  KnowledgeOwnerScopeSchema,
} from '../models/knowledge-notebook.js';
import { KnowledgeBaseIdSchema } from './ids.js';
import { RawContentReferenceSchema } from './object-reference.js';

/** Current byte/page coordinates; unsupported coordinate kinds require a producer and owner. */
export const ContentReferenceRangeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('bytes'),
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
    })
    .refine((range) => range.end >= range.start, { message: 'Byte range ends before its start.' }),
  z.object({ kind: z.literal('page'), page: z.number().int().positive() }),
]);

/**
 * Shared captured original-content identity; availability is an observation, never permission.
 *
 * The resolving owner must validate the Knowledge Base and declared mount against current scope configuration. Parsing creates no binding, reads no bytes and grants no access.
 */
export const ContentReferenceSchema = z
  .object({
    knowledgeBaseId: KnowledgeBaseIdSchema,
    contentDigest: KnowledgeContentDigestSchema,
    locator: z.object({
      ownerScope: KnowledgeOwnerScopeSchema,
      mount: z.string().min(1),
      path: z.string().min(1),
    }),
    range: ContentReferenceRangeSchema.nullable(),
    availability: z.enum(['available', 'unavailable']),
  })
  .superRefine((reference, context) => {
    const owner = reference.locator.ownerScope;
    const ownerPath =
      owner.kind === 'workspace'
        ? `workspace/${owner.workspaceId}`
        : owner.kind === 'user'
          ? `user/${owner.userId}`
          : 'server';
    if (
      !RawContentReferenceSchema.safeParse({
        scopeId: `raw/${ownerPath}/${reference.knowledgeBaseId}`,
        objectId: reference.locator.path,
      }).success
    ) {
      context.addIssue({
        code: 'custom',
        path: ['locator', 'path'],
        message: 'Invalid mount-relative content path.',
      });
    }
  });

/** Citable original-content projection; the existing owning record remains canonical. */
export type ContentReference = z.infer<typeof ContentReferenceSchema>;
/** Exact original-content coordinates with an explicit coordinate system. */
export type ContentReferenceRange = z.infer<typeof ContentReferenceRangeSchema>;

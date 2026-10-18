import { z } from 'zod';
import {
  KnowledgeContentDigestSchema,
  KnowledgeOwnerScopeSchema,
} from '../models/knowledge-notebook.js';
import { KnowledgeBaseIdSchema } from './ids.js';
import { RawContentReferenceSchema } from './object-reference.js';

/** Explicit source coordinates; no range implies a conversion between coordinate spaces. */
export const ContentReferenceRangeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('bytes'),
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
    })
    .refine((range) => range.end >= range.start, { message: 'Byte range ends before its start.' }),
  z.object({ kind: z.literal('page'), page: z.number().int().positive() }),
  z
    .object({
      kind: z.literal('time'),
      startSeconds: z.number().nonnegative(),
      endSeconds: z.number().nonnegative(),
    })
    .refine((range) => range.endSeconds >= range.startSeconds, {
      message: 'Time range ends before its start.',
    }),
  z
    .object({
      kind: z.literal('frame'),
      frame: z.number().int().nonnegative(),
      numbering: z.enum(['zero-based', 'one-based']),
      coordinateSpace: z.string().min(1),
    })
    .refine((range) => range.numbering === 'zero-based' || range.frame >= 1, {
      message: 'One-based frame numbering starts at one.',
    }),
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

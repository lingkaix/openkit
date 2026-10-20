import { z } from 'zod';
import {
  KnowledgeContentDigestSchema,
  KnowledgeOwnerScopeSchema,
} from '../models/knowledge-notebook.js';
import { WorkOwnerSchema } from '../models/work-owner.js';
import { KnowledgeBaseIdSchema } from './ids.js';
import { RawContentReferenceSchema } from './object-reference.js';

/** Half-open raw-byte coordinates shared by Knowledge and native work references. */
const byteRangeSchema = z
  .object({
    kind: z.literal('bytes'),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  })
  .refine((range) => range.end >= range.start, { message: 'Byte range ends before its start.' });

/** Current byte/page coordinates; unsupported coordinate kinds require a producer and owner. */
export const ContentReferenceRangeSchema = z.discriminatedUnion('kind', [
  byteRangeSchema,
  z.object({ kind: z.literal('page'), page: z.number().int().positive() }),
]);

/** Exact Knowledge case; Source pointers cannot substitute native work content for their base. */
export const KnowledgeContentReferenceSchema = z
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

/** Scoped retained work bytes in the existing backend-evidence root, without a Knowledge Base. */
export const NativeContentReferenceSchema = z
  .object({
    ...KnowledgeContentReferenceSchema.shape,
    knowledgeBaseId: z.null(),
    locator: z.object({
      ownerScope: WorkOwnerSchema,
      mount: z.literal('backend-evidence'),
      path: z.string().regex(/^sha256\/[a-f0-9]{64}$/),
    }),
    range: byteRangeSchema.nullable(),
  })
  .superRefine((reference, context) => {
    if (reference.locator.path !== `sha256/${reference.contentDigest.slice('sha256:'.length)}`) {
      context.addIssue({
        code: 'custom',
        path: ['locator', 'path'],
        message: 'Native content path does not match its digest.',
      });
    }
  });

/** Shared content identity; the current resolving owner and admission, not parsing, authorize access. */
export const ContentReferenceSchema = z.union([
  KnowledgeContentReferenceSchema,
  NativeContentReferenceSchema,
]);

/** Citable original-content projection; the existing owning record remains canonical. */
export type ContentReference = z.infer<typeof ContentReferenceSchema>;
/** Exact original-content coordinates with an explicit coordinate system. */
export type ContentReferenceRange = z.infer<typeof ContentReferenceRangeSchema>;

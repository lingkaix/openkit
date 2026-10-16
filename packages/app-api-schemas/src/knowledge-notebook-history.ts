import { ActorRefSchema } from '@openkit/protocol';
import { z } from 'zod';
import {
  KnowledgeNotebookPathSchema,
  UpdateKnowledgeNotebookRequestSchema,
  UpdateKnowledgeNotebookResponseSchema,
} from './knowledge-notebook.js';

const RevisionSchema = z.string().min(1);
const PageIdsSchema = z
  .array(z.string().refine((id) => KnowledgeNotebookPathSchema.safeParse(`${id}.md`).success))
  .min(1)
  .max(256)
  .refine((ids) => new Set(ids).size === ids.length, 'Notebook page IDs must be unique.');

/** Published ancestry cursor; current authorization applies to every returned revision. */
export const KnowledgeNotebookHistoryRequestSchema = z
  .object({
    revision: RevisionSchema.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

/** Unavailable rows retain commit identities but disclose no denied summary, producer or paths. */
export const KnowledgeNotebookHistoryResponseSchema = z
  .object({
    notebookRevision: RevisionSchema,
    revisions: z
      .array(
        z.discriminatedUnion('availability', [
          z
            .object({
              revision: RevisionSchema,
              parentRevision: RevisionSchema.nullable(),
              availability: z.literal('available'),
              summary: z.string(),
              producer: ActorRefSchema,
              changedPaths: z.array(KnowledgeNotebookPathSchema),
            })
            .strict(),
          z
            .object({
              revision: RevisionSchema,
              parentRevision: RevisionSchema.nullable(),
              availability: z.literal('unavailable'),
            })
            .strict(),
        ])
      )
      .max(100),
    nextRevision: RevisionSchema.nullable(),
  })
  .strict();

/** Exact published revisions and optional bounded selection; target bytes are compared against base. */
export const KnowledgeNotebookDiffRequestSchema = z
  .object({
    baseRevision: RevisionSchema,
    fromRevision: RevisionSchema,
    pageIds: PageIdsSchema.optional(),
    forRestore: z.literal(true).optional(),
  })
  .strict();

/** Complete selected file text, including absent paths; callers render their preferred text diff. */
export const KnowledgeNotebookDiffResponseSchema = z
  .object({
    baseRevision: RevisionSchema,
    fromRevision: RevisionSchema,
    forRestore: z.boolean(),
    changes: z
      .array(
        z
          .object({
            path: KnowledgeNotebookPathSchema,
            before: z.string().nullable(),
            after: z.string().nullable(),
          })
          .strict()
      )
      .max(256),
  })
  .strict();

/** Human restore binds its complete selected diff to immutable base and target revisions. */
export const RestoreKnowledgeNotebookRequestSchema = z
  .object({
    requestId: UpdateKnowledgeNotebookRequestSchema.shape.requestId,
    baseRevision: RevisionSchema,
    fromRevision: RevisionSchema,
    pageIds: PageIdsSchema,
    summary: UpdateKnowledgeNotebookRequestSchema.shape.summary,
    confirmRemoval: z.literal(true).optional(),
  })
  .strict();

/** Restore appends a normal publication with its own existing command receipt identity. */
export const RestoreKnowledgeNotebookResponseSchema = UpdateKnowledgeNotebookResponseSchema.extend({
  receiptRef: UpdateKnowledgeNotebookResponseSchema.shape.receiptRef.extend({
    operation: z.literal('knowledge.notebook.restore'),
  }),
});

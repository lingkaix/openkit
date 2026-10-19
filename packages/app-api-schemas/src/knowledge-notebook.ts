import {
  KnowledgeBaseIdSchema,
  KnowledgeNotebookPageSchema,
  RequestIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';

/** Bundle-relative Markdown path. Native Git and final-tree validation remain authoritative. */
export const KnowledgeNotebookPathSchema = z
  .string()
  .max(243)
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}(?:\/[a-z0-9][a-z0-9._-]{0,63})*\.md$/)
  .refine((path) => !path.slice(0, -3).endsWith('.md'));

/** Fixed-base explicit human edit; no actor, approval or filesystem root comes from this payload. */
export const UpdateKnowledgeNotebookRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    baseRevision: z.string().min(1),
    changes: z
      .array(
        z
          .object({
            path: KnowledgeNotebookPathSchema,
            content: z
              .string()
              .refine((text) => new TextEncoder().encode(text).length <= 2 * 1024 * 1024)
              .nullable(),
          })
          .strict()
      )
      .min(1)
      .max(256),
    summary: z.string().refine((text) => new TextEncoder().encode(text).length <= 4096),
  })
  .strict()
  .superRefine((input, context) => {
    const paths = new Set<string>();
    let bytes = 0;
    for (const [index, change] of input.changes.entries()) {
      if (paths.has(change.path))
        context.addIssue({
          code: 'custom',
          message: 'Changed notebook paths must be unique.',
          path: ['changes', index, 'path'],
        });
      paths.add(change.path);
      if (change.content !== null) bytes += new TextEncoder().encode(change.content).length;
    }
    if (bytes > 32 * 1024 * 1024)
      context.addIssue({
        code: 'custom',
        message: 'Notebook editing text exceeds its admitted bound.',
        path: ['changes'],
      });
  });

/** Exact existing Workspace content owner, repeated in the native command receipt. */
const WorkspaceNotebookOwnerSchema = z
  .object({ kind: z.literal('workspace'), workspaceId: WorkspaceIdSchema })
  .strict();

/** Completed publication evidence identifies one immutable commit and its existing command receipt. */
export const UpdateKnowledgeNotebookResponseSchema = z
  .object({
    outcome: z.literal('published'),
    ownerScope: WorkspaceNotebookOwnerSchema,
    baseRevision: z.string().min(1),
    notebookRevision: z.string().min(1),
    changedPageIds: z.array(z.string().min(1)).max(256),
    receiptRef: z
      .object({
        operation: z.enum([
          'knowledge.notebook.update',
          'knowledge.notebook.create',
          'knowledge.notebook.delete',
        ]),
        requestId: RequestIdSchema,
        ownerScope: WorkspaceNotebookOwnerSchema,
      })
      .strict(),
  })
  .strict();

/** One authorized snapshot; page content is complete OKF Markdown, never an entry projection. */
export const ListKnowledgeNotebookResponseSchema = z.object({
  knowledgeBaseId: KnowledgeBaseIdSchema,
  notebookRevision: z.string().min(1),
  pages: z.array(KnowledgeNotebookPageSchema),
});

/** Creates only a new path through the existing fixed-base Notebook publisher. */
export const CreateKnowledgeNotebookPageRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    baseRevision: UpdateKnowledgeNotebookRequestSchema.shape.baseRevision,
    path: KnowledgeNotebookPathSchema,
    content: UpdateKnowledgeNotebookRequestSchema.shape.changes.element.shape.content.unwrap(),
    summary: UpdateKnowledgeNotebookRequestSchema.shape.summary,
  })
  .strict();

/** Removes only the exact human-confirmed page bytes; Git history remains authoritative. */
export const DeleteKnowledgeNotebookPageRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    baseRevision: UpdateKnowledgeNotebookRequestSchema.shape.baseRevision,
    path: KnowledgeNotebookPathSchema,
    expectedContentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    confirmRemoval: z.literal(true),
    summary: UpdateKnowledgeNotebookRequestSchema.shape.summary,
  })
  .strict();

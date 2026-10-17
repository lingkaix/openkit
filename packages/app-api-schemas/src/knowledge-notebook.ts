import { RequestIdSchema, WorkspaceIdSchema } from '@openkit/protocol';
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
        operation: z.literal('knowledge.notebook.update'),
        requestId: RequestIdSchema,
        ownerScope: WorkspaceNotebookOwnerSchema,
      })
      .strict(),
  })
  .strict();

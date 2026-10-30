import { RequestIdSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';

/** Draft checking reuses the Notebook's existing two-MiB UTF-8 member limit. */
export const PreviewKnowledgeSchemaRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    requestId: RequestIdSchema,
    baseRevision: z.string().min(1),
    schemaText: z.string().refine((text) => {
      const bytes = new TextEncoder().encode(text);
      return bytes.length <= 2 * 1024 * 1024 && new TextDecoder().decode(bytes) === text;
    }),
  })
  .strict();

/** Content-free native validation feedback; authored values and process diagnostics stay private. */
const SchemaDiagnostic = z.object({ code: z.string(), field: z.string().optional() }).strict();

/** Notebook coverage is preparation, never a complete migration report or permission to activate. */
export const PreviewKnowledgeSchemaResponseSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    notebookRevision: z.string().min(1),
    baseSchemaDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    candidateSchemaDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    coverage: z.literal('notebook'),
    completeMigration: z.literal(false),
    schemaDiagnostics: z.array(SchemaDiagnostic),
    records: z.array(
      z
        .object({
          path: z.string(),
          status: z.enum(['valid', 'invalid-draft', 'needs-review']),
          diagnostics: z.array(SchemaDiagnostic),
        })
        .strict()
    ),
  })
  .strict();

/** Exact draft input and partial, non-authorizing inspection output. */
export type PreviewKnowledgeSchemaRequest = z.infer<typeof PreviewKnowledgeSchemaRequestSchema>;
export type PreviewKnowledgeSchemaResponse = z.infer<typeof PreviewKnowledgeSchemaResponseSchema>;

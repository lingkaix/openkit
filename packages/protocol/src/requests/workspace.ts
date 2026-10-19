import { z } from 'zod';

import { KnowledgeBaseIdSchema, RequestIdSchema } from '../common/ids.js';
import { KnowledgeEntrySchema } from '../models/knowledge.js';
import { WorkspaceKindSchema } from '../models/workspace.js';

/**
 * Create workspace payload.
 */
export const CreateWorkspaceRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    name: z.string().min(1),
  })
  .strict();

/**
 * Partial workspace update payload.
 */
export const UpdateWorkspaceRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    name: z.string().min(1).optional(),
    kind: WorkspaceKindSchema.optional(),
    status: z.enum(['active', 'archived']).optional(),
  })
  .strict();

/**
 * Create workspace knowledge payload.
 */
export const CreateKnowledgeEntryRequestSchema = z.object({
  requestId: RequestIdSchema,
  /** Exact published notebook revision selected by the editor. */
  baseRevision: z.string().min(1),
  /** Stable concept path; the native notebook path owner validates its admissible form. */
  knowledgePageId: z.string().min(1),
  kind: z.enum(['preference', 'project-context', 'task-summary']),
  title: z.string().min(1),
  content: z.string().min(1),
  sourceReferences: z.array(z.string().min(1)).optional(),
});

/**
 * Update workspace knowledge payload.
 */
export const UpdateKnowledgeEntryRequestSchema = z.object({
  requestId: RequestIdSchema,
  baseRevision: z.string().min(1),
  title: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
});

/**
 * Delete workspace knowledge payload.
 */
export const DeleteKnowledgeEntryRequestSchema = z.object({
  requestId: RequestIdSchema,
  baseRevision: z.string().min(1),
});

/**
 * Workspace knowledge list response.
 */
export const ListKnowledgeEntriesResponseSchema = z.object({
  /** Exact selected base; the collection can be empty without losing its identity. */
  knowledgeBaseId: KnowledgeBaseIdSchema,
  notebookRevision: z.string().min(1),
  items: z.array(
    KnowledgeEntrySchema.extend({
      /** Exact canonical page bytes at the response notebookRevision, for confirmed removal. */
      contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    })
  ),
});

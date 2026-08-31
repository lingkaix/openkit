import { z } from 'zod';

import { RequestIdSchema } from '../common/ids.js';
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
  title: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
});

/**
 * Delete workspace knowledge payload.
 */
export const DeleteKnowledgeEntryRequestSchema = z.object({
  requestId: RequestIdSchema,
});

/**
 * Workspace knowledge list response.
 */
export const ListKnowledgeEntriesResponseSchema = z.object({
  items: z.array(KnowledgeEntrySchema),
});

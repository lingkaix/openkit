import { z } from 'zod';

import { RequestIdSchema } from '../common/ids.js';
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

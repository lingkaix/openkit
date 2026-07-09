import { z } from 'zod';

import { KnowledgeEntryIdSchema } from '../common/ids.js';
import { TimestampSchema } from '../common/timestamps.js';

/**
 * A user-visible knowledge record scoped to a workspace.
 */
export const KnowledgeEntrySchema = z.object({
  id: KnowledgeEntryIdSchema,
  kind: z.enum(['preference', 'project-context', 'task-summary']),
  title: z.string().min(1),
  content: z.string().min(1),
  sourceReferences: z.array(z.string().min(1)).optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

/**
 * A skill reference visible in workspace configuration.
 */
export const SkillRefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean(),
});

/**
 * A model reference visible in workspace configuration.
 */
export const ModelRefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean(),
  isDefault: z.boolean(),
});

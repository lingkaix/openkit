import { z } from 'zod';

/** Exact canonical Notebook page bytes projected at one separately identified revision. */
export const KnowledgeNotebookPageSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  content: z.string(),
  contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
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

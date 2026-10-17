import { z } from 'zod';

/** Exact bundle-relative concept identity; these values select protected pages, never host paths. */
const NotebookPageIdSchema = z
  .string()
  .max(240)
  .refine(
    (value) =>
      value.split('/').every((part) => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(part)) &&
      !value.endsWith('.md') &&
      !value.split('/').some((part) => part === '.' || part === '..' || part === '.git'),
    'Expected a bundle-relative notebook page id.'
  );

/** Authored delegation and protected-page selection; native admission still verifies each exact publication. */
export const KnowledgeMaintenanceSchema = z
  .object({
    /** Delegates ordinary publication; this does not enable scheduled execution. */
    enabled: z.boolean(),
    /** Fixed daily execution is independent of publication delegation and stays off by default. */
    schedule: z
      .object({ enabled: z.boolean().default(false) })
      .strip()
      .default({ enabled: false }),
    reviewRequiredPageIds: z
      .array(NotebookPageIdSchema)
      .refine((ids) => new Set(ids).size === ids.length, 'Protected page ids must be unique.'),
  })
  .strip();

/** Existing User, Workspace and Server settings share this structural contract without sharing authority. */
export type KnowledgeMaintenance = z.infer<typeof KnowledgeMaintenanceSchema>;

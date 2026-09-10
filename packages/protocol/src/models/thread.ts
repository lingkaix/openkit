import { z } from 'zod';

import { ThreadIdSchema, WorkspaceIdSchema } from '../common/ids.js';
import { TimestampSchema } from '../common/timestamps.js';

/** Server-authored product entry that owns one Thread's continuation path. */
export const ThreadEntryPathSchema = z.enum(['conversation', 'administration']);

/**
 * A long-lived conversation/work container within a workspace.
 */
export const ThreadSchema = z.object({
  id: ThreadIdSchema,
  workspaceId: WorkspaceIdSchema,
  name: z.string().min(1).nullable(),
  preview: z.string().min(1),
  status: z.enum(['active', 'archived']),
  entryPath: ThreadEntryPathSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

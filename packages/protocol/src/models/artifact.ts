import { z } from 'zod';

import {
  ArtifactIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from '../common/ids.js';
import { TimestampSchema } from '../common/timestamps.js';

/**
 * Inline artifact content payload.
 */
export const ArtifactContentSchema = z.object({
  format: z.enum(['markdown', 'text', 'json']),
  body: z.string().min(1),
});

/**
 * Durable user-visible output attached to a workspace and optionally a thread or turn.
 */
export const ArtifactSchema = z.object({
  id: ArtifactIdSchema,
  workspaceId: WorkspaceIdSchema,
  threadId: ThreadIdSchema.nullable(),
  turnId: TurnIdSchema.nullable(),
  kind: z.enum(['report', 'diff', 'file', 'summary']),
  title: z.string().min(1),
  status: z.enum(['draft', 'ready', 'archived']),
  summary: z.string().nullable(),
  version: z.number().int().positive(),
  content: ArtifactContentSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

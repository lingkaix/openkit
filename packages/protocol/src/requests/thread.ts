import { z } from 'zod';

import { RequestIdSchema, ThreadIdSchema, WorkspaceIdSchema } from '../common/ids.js';
import { ItemSchema } from '../models/item.js';
import { ThreadSchema } from '../models/thread.js';

/**
 * Create thread payload.
 */
export const CreateThreadRequestSchema = z.object({
  requestId: RequestIdSchema,
  workspaceId: WorkspaceIdSchema,
  name: z.string().min(1),
});

/**
 * Update thread metadata payload.
 */
export const UpdateThreadRequestSchema = z.object({
  requestId: RequestIdSchema,
  workspaceId: WorkspaceIdSchema,
  threadId: ThreadIdSchema,
  name: z.string().min(1).nullable().optional(),
  status: z.enum(['active', 'archived']).optional(),
});

/**
 * Archive thread payload.
 */
export const ArchiveThreadRequestSchema = z.object({
  requestId: RequestIdSchema,
  workspaceId: WorkspaceIdSchema,
  threadId: ThreadIdSchema,
});

/**
 * List threads with cursor pagination.
 */
export const ListThreadsRequestSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100).optional(),
  status: z.enum(['active', 'archived']).optional(),
});

/**
 * Get a single thread by ID.
 */
export const GetThreadRequestSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  threadId: ThreadIdSchema,
  includeTurns: z.boolean().optional(),
});

/**
 * Paginated list-threads response.
 */
export const ListThreadsResponseSchema = z.object({
  items: z.array(ThreadSchema),
  nextCursor: z.string().min(1).nullable().optional(),
});

/**
 * Bare thread detail response.
 */
export const GetThreadResponseSchema = ThreadSchema;

/**
 * Durable thread item replay response.
 */
export const ListThreadItemsResponseSchema = z.object({
  items: z.array(ItemSchema),
  nextCursor: z.string().nullable(),
});

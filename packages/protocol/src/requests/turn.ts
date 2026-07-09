import { z } from 'zod';

import { RequestIdSchema, ThreadIdSchema, TurnIdSchema, WorkspaceIdSchema } from '../common/ids.js';

/**
 * Submit ordinary user input for a thread.
 * The core may attach this input to the active turn or start a new turn.
 */
export const SubmitTurnInputRequestSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema.optional(),
  requestId: RequestIdSchema,
  input: z.string().min(1),
  modelId: z.string().min(1).optional(),
});

/**
 * Interrupt turn payload.
 */
export const InterruptTurnRequestSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema,
  requestId: RequestIdSchema,
});

/**
 * Cancel turn payload.
 */
export const CancelTurnRequestSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema,
  requestId: RequestIdSchema,
});

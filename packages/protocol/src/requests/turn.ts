import { z } from 'zod';

import { RequestIdSchema, ThreadIdSchema, TurnIdSchema, WorkspaceIdSchema } from '../common/ids.js';

const OrdinaryTurnInputRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
    requestId: RequestIdSchema,
    input: z.string().min(1),
    modelId: z.string().min(1).optional(),
  })
  .strict();

const GateTurnInputRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
    turnId: TurnIdSchema,
    requestId: RequestIdSchema,
    answers: z.record(z.string().min(1), z.tuple([z.string().min(1)])),
  })
  .strict();

const TurnInputRequestScopeSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
    requestId: RequestIdSchema,
  })
  .passthrough();

/**
 * Submit either ordinary thread input or one exact structured user-input Gate response.
 */
export const SubmitTurnInputRequestSchema = TurnInputRequestScopeSchema.pipe(
  z.union([OrdinaryTurnInputRequestSchema, GateTurnInputRequestSchema])
);

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

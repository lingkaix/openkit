import { z } from 'zod';

import { RequestIdSchema, ThreadIdSchema, TurnIdSchema, WorkspaceIdSchema } from '../common/ids.js';
import { ProductTurnSchema, TurnSchema } from '../models/turn.js';

/** Strict release-coupled Turn read variants with accepted package delivery evidence. */
const StrictTurnReadProjectionSchema = z.union(
  TurnSchema.options.map((variant) =>
    variant
      .omit({ agentSessionId: true })
      .extend({
        contextPackageDigest: z
          .string()
          .regex(/^ctxpkg_sha256_[a-f0-9]{64}$/)
          .nullable(),
      })
      .strict()
  )
);

/**
 * Release-coupled ordinary Turn read projection with nullable accepted Context Package evidence.
 */
export const TurnReadProjectionSchema = z.intersection(
  StrictTurnReadProjectionSchema,
  ProductTurnSchema
);

const OrdinaryTurnInputRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
    requestId: RequestIdSchema,
    input: z.string().min(1),
    agentId: z.string().min(1).optional(),
    profileId: z.string().min(1).optional(),
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

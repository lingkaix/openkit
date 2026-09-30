import { z } from 'zod';

import { RequestIdSchema, ThreadIdSchema, TurnIdSchema, WorkspaceIdSchema } from '../common/ids.js';
import { ProductTurnSchema, TurnRecordSchema } from '../models/turn.js';

/** Strict release-coupled Turn read with accepted package delivery evidence. */
const StrictTurnReadProjectionSchema = TurnRecordSchema.omit({ agentSessionId: true })
  .extend({
    contextPackageDigest: z
      .string()
      .regex(/^ctxpkg_sha256_[a-f0-9]{64}$/)
      .nullable(),
  })
  .strict();

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

/**
 * Submit ordinary thread input. Pending user-input answers use their own command.
 */
export const SubmitTurnInputRequestSchema = OrdinaryTurnInputRequestSchema;

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

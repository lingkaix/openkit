import { RequestIdSchema } from '@openkit/protocol';
import { z } from 'zod';

import { SubmitConversationResponseSchema } from './chat-mode.js';

/** Request body for one turn in the current user's private administration entry. */
export const SubmitAdministrationConversationRequestSchema = z
  .object({
    input: z.string().min(1),
    logicalModelId: z.string().min(1).optional(),
    requestId: RequestIdSchema,
    threadId: z.string().min(1).optional(),
  })
  .strict();

/** Administration conversation response using the shared conversation projection. */
export const SubmitAdministrationConversationResponseSchema = SubmitConversationResponseSchema;

/** Request body for one private administration conversation turn. */
export type SubmitAdministrationConversationRequest = z.infer<
  typeof SubmitAdministrationConversationRequestSchema
>;
/** Response from one private administration conversation turn. */
export type SubmitAdministrationConversationResponse = z.infer<
  typeof SubmitAdministrationConversationResponseSchema
>;

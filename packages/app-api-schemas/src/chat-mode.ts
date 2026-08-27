import { ItemSchema, ProductTurnSchema } from '@openkit/protocol';
import { z } from 'zod';

/** Request body for one thread-scoped Chat Mode Assistant turn. */
export const StartChatModeRequestSchema = z
  .object({
    input: z.string().min(1),
    requestId: z.string().min(1),
  })
  .strict();

/** Terminal routing outcome selected by Core Assistant. */
export const ChatModeOutcomeSchema = z.enum([
  'answered',
  'clarification-needed',
  'task-handoff',
  'goal-handoff',
  'refused',
]);

/** App API projection for a Chat Mode handoff status item. */
export const ChatModeHandoffSchema = z.object({
  targetMode: z.enum(['task', 'goal']),
  reason: z.string().min(1),
  statusItemId: z.string().min(1),
});

/** Response returned after Core Assistant records one Chat Mode outcome. */
export const StartChatModeResponseSchema = z.object({
  outcome: ChatModeOutcomeSchema,
  explanation: z.string().min(1),
  turn: ProductTurnSchema,
  item: ItemSchema,
  handoff: ChatModeHandoffSchema.nullable(),
});

/** Request body for one thread-scoped Chat Mode Assistant turn. */
export type StartChatModeRequest = z.infer<typeof StartChatModeRequestSchema>;
/** Response returned after Core Assistant records one Chat Mode outcome. */
export type StartChatModeResponse = z.infer<typeof StartChatModeResponseSchema>;

import { z } from 'zod';

/** Quick chat request body for a completed non-streaming response. */
export const QuickChatRequestSchema = z.object({
  input: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  stream: z.literal(false).optional(),
});

/** Quick chat response payload. */
export const QuickChatResponseSchema = z.object({
  id: z.string().min(1),
  status: z.literal('completed'),
  workspaceId: z.string().min(1),
  providerId: z.string().min(1),
  model: z.string().min(1),
  content: z.string(),
});

/** Quick chat request body for a completed non-streaming response. */
export type QuickChatRequest = z.infer<typeof QuickChatRequestSchema>;
/** Quick chat response payload. */
export type QuickChatResponse = z.infer<typeof QuickChatResponseSchema>;

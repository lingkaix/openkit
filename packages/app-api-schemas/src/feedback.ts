import { z } from 'zod';

/** Turn feedback rating. */
export const TurnFeedbackRatingSchema = z.enum(['good', 'bad']).nullable();

/** Turn feedback submit request. */
export const SubmitTurnFeedbackRequestSchema = z.object({
  rating: TurnFeedbackRatingSchema,
  note: z.string().nullable(),
});

/** Turn feedback response payload. */
export const TurnFeedbackResponseSchema = z.object({
  turnId: z.string().min(1),
  agentId: z.string().min(1).nullable(),
  rating: TurnFeedbackRatingSchema,
  note: z.string().nullable(),
  createdAt: z.string().min(1),
});

/** Turn feedback submit request. */
export type SubmitTurnFeedbackRequest = z.infer<typeof SubmitTurnFeedbackRequestSchema>;
/** Turn feedback response payload. */
export type TurnFeedbackResponse = z.infer<typeof TurnFeedbackResponseSchema>;

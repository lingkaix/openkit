import { z } from 'zod';

/** Answer command for one pending user-input request. */
export const AnswerUserInputRequestSchema = z
  .object({
    userInputRequestId: z.string().min(1),
    workspaceId: z.string().min(1),
    threadId: z.string().min(1),
    requestId: z.string().min(1),
    answers: z.record(z.string().min(1), z.tuple([z.string().min(1)])),
  })
  .strip();

/** Withdrawal command for one pending request. */
export const WithdrawPendingRequestSchema = z
  .object({
    pendingRequestId: z.string().min(1),
    workspaceId: z.string().min(1),
    threadId: z.string().min(1),
    requestId: z.string().min(1),
  })
  .strip();

/** Command outcome returned by answer and withdraw. */
export const PendingRequestOutcomeSchema = z
  .object({
    requestId: z.string().min(1),
    workspaceId: z.string().min(1),
    threadId: z.string().min(1),
    state: z.enum(['pending', 'resolved', 'ended']),
    resolution: z.enum(['granted', 'denied', 'answered']).nullable(),
    ending: z.enum(['withdrawn', 'invalidated']).nullable(),
  })
  .strip();

/** Answer command body. */
export type AnswerUserInputRequest = z.infer<typeof AnswerUserInputRequestSchema>;
/** Withdrawal command body. */
export type WithdrawPendingRequest = z.infer<typeof WithdrawPendingRequestSchema>;
/** Answer or withdrawal outcome. */
export type PendingRequestOutcome = z.infer<typeof PendingRequestOutcomeSchema>;

/** Derived human disclosure; no preview state or argument copy is persisted. */
export const ApprovalEffectPreviewSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('available'), summary: z.string(), detail: z.string() }).strip(),
  z.object({ status: z.literal('unavailable'), reason: z.string() }).strip(),
]);
export type ApprovalEffectPreview = z.infer<typeof ApprovalEffectPreviewSchema>;

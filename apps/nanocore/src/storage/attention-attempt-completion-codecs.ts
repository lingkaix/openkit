import { RequestIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import type { AttentionAttemptCompletion } from '../notifications/attention.js';

/** Only the original completion fields; no source text, credential, callback or transport input. */
export const ControlAttentionAttemptCompletionSchema = z
  .object({
    deliveryId: RequestIdSchema,
    attemptId: z.number().int().positive(),
    status: z.enum(['sent', 'failed-no-send', 'delivery-unknown']),
    failureCode: z
      .enum(['authority-unavailable', 'transport-refused', 'transport-unknown', 'restart'])
      .nullable(),
    finishedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((value, context) => {
    const legal =
      (value.status === 'sent' && value.failureCode === null) ||
      (value.status === 'failed-no-send' &&
        (value.failureCode === 'authority-unavailable' ||
          value.failureCode === 'transport-refused')) ||
      (value.status === 'delivery-unknown' &&
        (value.failureCode === 'transport-unknown' || value.failureCode === 'restart'));
    if (!legal)
      context.addIssue({ code: 'custom', message: 'Invalid Attention completion outcome.' });
  }) satisfies z.ZodType<AttentionAttemptCompletion>;

/** Acknowledges the original statement's commit, not a new claim that its guarded row changed. */
export const ControlAttentionAttemptCompletionResultSchema = z
  .object({ kind: z.literal('attention-attempt-completion') })
  .strict();

export type ControlAttentionAttemptCompletion = z.infer<
  typeof ControlAttentionAttemptCompletionSchema
>;
export type ControlAttentionAttemptCompletionResult = z.infer<
  typeof ControlAttentionAttemptCompletionResultSchema
>;

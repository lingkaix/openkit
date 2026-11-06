import { z } from 'zod';
import {
  AttentionAttemptClaimSchema,
  AttentionClaimedDeliverySchema,
} from '../notifications/attention-codecs.js';

/** Main-prepared clock; null preserves clock refusal at the original insertion point. */
export const ControlAttentionAttemptClaimSchema = AttentionAttemptClaimSchema.extend({
  startedAt: z.string().datetime().nullable(),
});

/** Only the original claim's safe domain refusals, never dependency diagnostics. */
export const ControlAttentionAttemptClaimRefusalSchema = z.enum([
  'invalid_attention_input',
  'attention_not_found',
  'attention_attempt_conflict',
  'attention_channel_conflict',
  'attention_not_sendable',
  'attention_recovery_required',
]);

/** The original in-transaction snapshot or a fully rolled-back original refusal. */
export const ControlAttentionAttemptClaimResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      kind: z.literal('attention-attempt-claim'),
      status: z.literal('claimed'),
      delivery: AttentionClaimedDeliverySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('attention-attempt-claim'),
      status: z.literal('refused'),
      code: ControlAttentionAttemptClaimRefusalSchema,
    })
    .strict(),
]);

export type ControlAttentionAttemptClaim = z.infer<typeof ControlAttentionAttemptClaimSchema>;
export type ControlAttentionAttemptClaimResult = z.infer<
  typeof ControlAttentionAttemptClaimResultSchema
>;

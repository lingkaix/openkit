import { RequestIdSchema, TimestampSchema } from '@openkit/protocol';
import { z } from 'zod';
import {
  AttemptStatusSchema,
  ChannelSchema,
  DeliverSchema,
  EnqueueSchema,
  FailureCodeSchema,
  SourceSchema,
} from './attention-records.js';

/** Exact original stage inputs; no transport, authority boolean, callback or SQL crosses the wire. */
export const ControlAttentionSchema = z.discriminatedUnion('action', [
  z
    .object({ action: z.literal('enqueue'), timestamp: TimestampSchema, input: EnqueueSchema })
    .strict(),
  z
    .object({ action: z.literal('claim'), timestamp: TimestampSchema, input: DeliverSchema })
    .strict(),
  z.object({ action: z.literal('reconcile'), timestamp: TimestampSchema }).strict(),
  z
    .object({
      action: z.literal('settle'),
      timestamp: TimestampSchema,
      deliveryId: RequestIdSchema,
      attemptId: z.number().int().positive(),
      status: z.enum(['sent', 'failed-no-send', 'delivery-unknown']),
      failureCode: FailureCodeSchema.nullable(),
    })
    .strict(),
]);
export type ControlAttention = z.infer<typeof ControlAttentionSchema>;
/** The existing complete Attention projection, not another durable representation. */
const delivery = z
  .object({
    id: RequestIdSchema,
    source: SourceSchema,
    recipientUserId: EnqueueSchema.shape.recipientUserId,
    channel: ChannelSchema.nullable(),
    status: z.enum(['queued', ...AttemptStatusSchema.options]),
    createdAt: TimestampSchema,
    attempt: z
      .object({
        id: z.number().int().positive(),
        status: AttemptStatusSchema,
        failureCode: FailureCodeSchema.nullable(),
        startedAt: TimestampSchema,
        finishedAt: TimestampSchema.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
/** Validates the original readback or startup reconciliation count after FULL acknowledgement. */
export const ControlAttentionResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('delivery'), delivery }).strict(),
  z.object({ kind: z.literal('reconciled'), count: z.number().int().nonnegative() }).strict(),
]);
export type ControlAttentionResult = z.infer<typeof ControlAttentionResultSchema>;
/** Closed original domain codes; SQLite and transport diagnostics never enter this envelope. */
export const ControlAttentionRefusalSchema = z
  .object({
    operation: z.literal('attention'),
    code: z.enum([
      'invalid_attention_input',
      'attention_not_found',
      'attention_not_eligible',
      'attention_not_sendable',
      'attention_channel_conflict',
      'attention_recovery_required',
      'attention_attempt_conflict',
    ]),
  })
  .strict();

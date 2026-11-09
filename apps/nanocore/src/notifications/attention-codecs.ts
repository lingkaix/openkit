import {
  ApprovalRequestIdSchema,
  isThreadId,
  isUserId,
  isWorkspaceId,
  RequestIdSchema,
  UserInputRequestIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';

/** Closed channel values shared by existing Attention delivery parsing. */
const ChannelSchema = z.enum(['discord', 'email']);

/** Existing durable attempt states used by retained row parsing. */
const AttemptStatusSchema = z.enum(['sending', 'sent', 'failed-no-send', 'delivery-unknown']);

/** Existing failure observations accepted by retained attempt parsing. */
const FailureCodeSchema = z.enum([
  'authority-unavailable',
  'transport-refused',
  'transport-unknown',
  'restart',
]);

/** Structural Core request references shared by Attention input and retained rows. */
const SourceSchema = z
  .object({
    workspaceId: z.string().refine(isWorkspaceId),
    threadId: z.string().refine(isThreadId),
    kind: z.enum(['approval-request', 'user-input-request']),
    requestId: z.union([ApprovalRequestIdSchema, UserInputRequestIdSchema]),
  })
  .strict();

/** Original delivery selection and prior-attempt comparison input. */
const DeliverSchema = z
  .object({
    deliveryId: RequestIdSchema,
    recipientUserId: z.string().refine(isUserId),
    channel: ChannelSchema,
    retry: z.boolean().optional(),
    expectedAttemptId: z.number().int().positive().nullable(),
  })
  .strict();

/** Original retained Attention and latest-attempt row shape; unrelated SQL columns stay ignored. */
const RowSchema = z.object({
  id: RequestIdSchema,
  workspaceId: z.string().refine(isWorkspaceId),
  threadId: z.string().refine(isThreadId),
  sourceKind: SourceSchema.shape.kind,
  requestId: SourceSchema.shape.requestId,
  recipientUserId: z.string().refine(isUserId),
  channel: ChannelSchema.nullable(),
  createdAt: z.string().datetime(),
  attemptId: z.number().int().positive().nullable(),
  attemptChannel: ChannelSchema.nullable(),
  status: AttemptStatusSchema.nullable(),
  failureCode: FailureCodeSchema.nullable(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  invalidHistory: z.number().int(),
});

/** The existing admitted claim fields, shared with only the private native wire codec. */
export const AttentionAttemptClaimSchema = DeliverSchema;

/** Exact original in-transaction claim snapshot; request identities keep their existing unbounded semantics. */
export const AttentionClaimedDeliverySchema = z
  .object({
    id: RowSchema.shape.id,
    source: SourceSchema,
    recipientUserId: RowSchema.shape.recipientUserId,
    channel: ChannelSchema,
    status: z.literal('sending'),
    createdAt: RowSchema.shape.createdAt,
    attempt: z
      .object({
        id: RowSchema.shape.attemptId.unwrap(),
        status: z.literal('sending'),
        failureCode: z.null(),
        startedAt: RowSchema.shape.startedAt.unwrap(),
        finishedAt: z.null(),
      })
      .strict(),
  })
  .strict();

export {
  AttemptStatusSchema,
  ChannelSchema,
  DeliverSchema,
  FailureCodeSchema,
  RowSchema,
  SourceSchema,
};

/** Prepared startup clock, consumed only after all affected retained rows validate. */
export const AttentionReconciliationSchema = z
  .object({ finishedAt: z.string().datetime().nullable() })
  .strict();

/** Original count or safe refusal after the complete reconciliation transaction rolls back. */
export const AttentionReconciliationResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('reconciled'), changes: z.number().int().nonnegative() }).strict(),
  z
    .object({
      status: z.literal('refused'),
      code: z.enum(['invalid_attention_input', 'attention_recovery_required']),
    })
    .strict(),
]);

export type AttentionReconciliation = z.infer<typeof AttentionReconciliationSchema>;
export type AttentionReconciliationResult = z.infer<typeof AttentionReconciliationResultSchema>;

/** Original complete source/recipient enqueue input, with no request-identity size limit. */
export const AttentionEnqueueSchema = z
  .object({ source: SourceSchema, recipientUserId: z.string().refine(isUserId) })
  .strict();

/** Prepared clock is consumed at the original INSERT argument inside whole-operation rollback. */
export const AttentionEnqueueCommandSchema = AttentionEnqueueSchema.extend({
  createdAt: z.string().datetime().nullable(),
});

/** Exact original enqueue projection, including an existing attempt on deduplicated replay. */
export const AttentionDeliverySchema = AttentionClaimedDeliverySchema.extend({
  channel: ChannelSchema.nullable(),
  status: z.union([z.literal('queued'), AttemptStatusSchema]),
  attempt: AttentionClaimedDeliverySchema.shape.attempt
    .extend({
      status: AttemptStatusSchema,
      failureCode: FailureCodeSchema.nullable(),
      finishedAt: z.string().datetime().nullable(),
    })
    .nullable(),
}).superRefine((delivery, context) => {
  const attempt = delivery.attempt;
  const legal =
    attempt === null
      ? delivery.channel === null && delivery.status === 'queued'
      : delivery.channel !== null &&
        delivery.status === attempt.status &&
        ((attempt.status === 'sending' &&
          attempt.finishedAt === null &&
          attempt.failureCode === null) ||
          (attempt.status === 'sent' &&
            attempt.finishedAt !== null &&
            attempt.failureCode === null) ||
          (attempt.status === 'failed-no-send' &&
            attempt.finishedAt !== null &&
            (attempt.failureCode === 'authority-unavailable' ||
              attempt.failureCode === 'transport-refused')) ||
          (attempt.status === 'delivery-unknown' &&
            attempt.finishedAt !== null &&
            (attempt.failureCode === 'transport-unknown' || attempt.failureCode === 'restart')));
  if (!legal)
    context.addIssue({ code: 'custom', message: 'Invalid Attention delivery projection.' });
});

/** Original committed row or a safe domain refusal after complete enqueue rollback. */
export const AttentionEnqueueResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('enqueued'), delivery: AttentionDeliverySchema }).strict(),
  z
    .object({
      status: z.literal('refused'),
      code: z.enum(['invalid_attention_input', 'attention_recovery_required']),
    })
    .strict(),
]);

export type AttentionEnqueueCommand = z.infer<typeof AttentionEnqueueCommandSchema>;
export type AttentionEnqueueResult = z.infer<typeof AttentionEnqueueResultSchema>;

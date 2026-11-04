import {
  ApprovalRequestIdSchema,
  isThreadId,
  isUserId,
  isWorkspaceId,
  RequestIdSchema,
  UserInputRequestIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';

export const ChannelSchema = z.enum(['discord', 'email']);
export const AttemptStatusSchema = z.enum([
  'sending',
  'sent',
  'failed-no-send',
  'delivery-unknown',
]);
export const FailureCodeSchema = z.enum([
  'authority-unavailable',
  'transport-refused',
  'transport-unknown',
  'restart',
]);
export const SourceSchema = z
  .object({
    workspaceId: z.string().refine(isWorkspaceId),
    threadId: z.string().refine(isThreadId),
    kind: z.enum(['approval-request', 'user-input-request']),
    requestId: z.union([ApprovalRequestIdSchema, UserInputRequestIdSchema]),
  })
  .strict();
export const EnqueueSchema = z
  .object({ source: SourceSchema, recipientUserId: z.string().refine(isUserId) })
  .strict();
export const DeliverSchema = z
  .object({
    deliveryId: RequestIdSchema,
    recipientUserId: z.string().refine(isUserId),
    channel: ChannelSchema,
    retry: z.boolean().optional(),
    expectedAttemptId: z.number().int().positive().nullable(),
  })
  .strict();
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

/** Exact Core references; neither captured arguments nor source content are retained. */
export type AttentionSource = z.infer<typeof SourceSchema>;
/** Admitted transport selection, frozen by the first durable send attempt. */
export type AttentionChannel = z.infer<typeof ChannelSchema>;
/** Durable external-send outcome, independent of the referenced Core request. */
export type AttentionAttempt = {
  id: number;
  status: z.infer<typeof AttemptStatusSchema>;
  failureCode: z.infer<typeof FailureCodeSchema> | null;
  startedAt: string;
  finishedAt: string | null;
};
/** Current projection of one deduplicated source/recipient reference and latest attempt. */
export type AttentionDelivery = {
  id: string;
  source: AttentionSource;
  recipientUserId: string;
  channel: AttentionChannel | null;
  status: 'queued' | AttentionAttempt['status'];
  createdAt: string;
  attempt: AttentionAttempt | null;
};
/** Content-free attention link shared by Discord and future Email link transport. */
export type AttentionLink = { kind: 'attention-link'; deliveryId: string; appPath: string };
/** Transport must prove no message-send effect before it reports failed-no-send. */
export type AttentionTransport = (
  payload: AttentionLink
) => Promise<{ status: 'sent' | 'failed-no-send' | 'delivery-unknown' }>;
/** Synchronous current source, audience, recipient and channel-account admission. */
export type AttentionEligibility = (delivery: AttentionDelivery) => boolean;
/** Safe error code for operation adapters; dependency details are never published. */
export class AttentionError extends Error {
  constructor(
    public readonly code:
      | 'invalid_attention_input'
      | 'attention_not_found'
      | 'attention_not_eligible'
      | 'attention_not_sendable'
      | 'attention_channel_conflict'
      | 'attention_recovery_required'
      | 'attention_attempt_conflict'
  ) {
    super(code);
    this.name = 'AttentionError';
  }
}

export const SELECT = `SELECT a.id, a.workspace_id AS workspaceId, a.thread_id AS threadId,
  a.source_kind AS sourceKind, a.request_id AS requestId, a.recipient_user_id AS recipientUserId,
  a.channel, a.created_at AS createdAt, t.id AS attemptId, t.channel AS attemptChannel,
  t.status, t.failure_code AS failureCode, t.started_at AS startedAt, t.finished_at AS finishedAt,
  EXISTS (SELECT 1 FROM notification_delivery_attempts p WHERE p.attention_id = a.id
    AND (p.channel != a.channel OR (p.id < t.id AND (p.status != 'failed-no-send'
      OR p.finished_at IS NULL OR p.failure_code IS NULL
      OR p.failure_code NOT IN ('authority-unavailable', 'transport-refused'))))) AS invalidHistory
  FROM notification_attention a LEFT JOIN notification_delivery_attempts t
  ON t.id = (SELECT MAX(id) FROM notification_delivery_attempts WHERE attention_id = a.id)`;

/** Validates retained closed semantics while ignoring unrelated additive SQL columns. */
export function decodeRow(value: unknown): AttentionDelivery {
  const parsed = RowSchema.safeParse(value);
  if (!parsed.success) throw new AttentionError('attention_recovery_required');
  const row = parsed.data;
  const hasAttempt = row.attemptId !== null;
  const legal = !hasAttempt
    ? row.channel === null && row.status === null && row.startedAt === null
    : row.channel !== null &&
      row.channel === row.attemptChannel &&
      row.startedAt !== null &&
      ((row.status === 'sending' && row.finishedAt === null && row.failureCode === null) ||
        (row.status === 'sent' && row.finishedAt !== null && row.failureCode === null) ||
        (row.status === 'failed-no-send' &&
          row.finishedAt !== null &&
          (row.failureCode === 'authority-unavailable' ||
            row.failureCode === 'transport-refused')) ||
        (row.status === 'delivery-unknown' &&
          row.finishedAt !== null &&
          (row.failureCode === 'transport-unknown' || row.failureCode === 'restart')));
  if (!legal || row.invalidHistory !== 0) throw new AttentionError('attention_recovery_required');
  const attempt: AttentionAttempt | null = hasAttempt
    ? {
        id: row.attemptId!,
        status: row.status!,
        failureCode: row.failureCode,
        startedAt: row.startedAt!,
        finishedAt: row.finishedAt,
      }
    : null;
  return {
    id: row.id,
    source: {
      workspaceId: row.workspaceId,
      threadId: row.threadId,
      kind: row.sourceKind,
      requestId: row.requestId,
    },
    recipientUserId: row.recipientUserId,
    channel: row.channel,
    status: attempt?.status ?? 'queued',
    createdAt: row.createdAt,
    attempt,
  };
}

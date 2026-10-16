import { randomUUID } from 'node:crypto';
import { isThreadId, isUserId, isWorkspaceId } from '@openkit/protocol';
import type Database from 'better-sqlite3';
import { z } from 'zod';

export { ATTENTION_SCHEMA_SQL } from './schema.js';

const ChannelSchema = z.enum(['discord', 'email']);
const AttemptStatusSchema = z.enum(['sending', 'sent', 'failed-no-send', 'delivery-unknown']);
const FailureCodeSchema = z.enum([
  'authority-unavailable',
  'transport-refused',
  'transport-unknown',
  'restart',
]);
const SourceSchema = z
  .object({
    workspaceId: z.string().refine(isWorkspaceId),
    threadId: z.string().refine(isThreadId),
    kind: z.enum(['approval-request', 'user-input-request']),
    requestId: z.string().min(1),
  })
  .strict();
const EnqueueSchema = z
  .object({ source: SourceSchema, recipientUserId: z.string().refine(isUserId) })
  .strict();
const DeliverSchema = z
  .object({
    deliveryId: z.string().uuid(),
    recipientUserId: z.string().refine(isUserId),
    channel: ChannelSchema,
    retry: z.boolean().optional(),
    expectedAttemptId: z.number().int().positive().nullable(),
  })
  .strict();
const RowSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().refine(isWorkspaceId),
  threadId: z.string().refine(isThreadId),
  sourceKind: SourceSchema.shape.kind,
  requestId: z.string().min(1),
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

const SELECT = `SELECT a.id, a.workspace_id AS workspaceId, a.thread_id AS threadId,
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
function decodeRow(value: unknown): AttentionDelivery {
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

/** Owns attention delivery only; the injected Core database must already be migrated. */
export class AttentionNotifications {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly options: {
      now?: () => string;
      buildAppPath?: (source: AttentionSource) => string;
    } = {}
  ) {}

  /** Adds one exact source/recipient reference, returning the existing reference on replay. */
  enqueue(input: { source: AttentionSource; recipientUserId: string }): AttentionDelivery {
    const parsed = EnqueueSchema.safeParse(input);
    if (!parsed.success) throw new AttentionError('invalid_attention_input');
    const { source, recipientUserId } = parsed.data;
    return this.sqlite.transaction(() => {
      this.sqlite
        .prepare(`INSERT INTO notification_attention
          (id, workspace_id, thread_id, source_kind, request_id, recipient_user_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (workspace_id, thread_id, source_kind, request_id, recipient_user_id) DO NOTHING`)
        .run(
          randomUUID(),
          source.workspaceId,
          source.threadId,
          source.kind,
          source.requestId,
          recipientUserId,
          this.now()
        );
      return decodeRow(
        this.sqlite
          .prepare(`${SELECT} WHERE a.workspace_id = ? AND a.thread_id = ? AND a.source_kind = ?
            AND a.request_id = ? AND a.recipient_user_id = ?`)
          .get(source.workspaceId, source.threadId, source.kind, source.requestId, recipientUserId)
      );
    })();
  }

  /** Reads an internal reference; callers must use current admission before exposing it. */
  get(id: string): AttentionDelivery | null {
    if (!z.string().uuid().safeParse(id).success)
      throw new AttentionError('invalid_attention_input');
    const row = this.sqlite.prepare(`${SELECT} WHERE a.id = ?`).get(id);
    return row ? decodeRow(row) : null;
  }

  /** Returns an exact reference only for its current eligible recipient. */
  getForActor(
    id: string,
    userId: string,
    isEligible: AttentionEligibility
  ): AttentionDelivery | null {
    if (!z.string().uuid().safeParse(id).success)
      throw new AttentionError('invalid_attention_input');
    const row = this.sqlite
      .prepare(`${SELECT} WHERE a.id = ? AND a.recipient_user_id = ?`)
      .get(id, userId);
    if (!row) return null;
    const delivery = decodeRow(row);
    return isEligible(delivery) === true ? delivery : null;
  }

  /** Reads at most limit recipient rows before current source/audience filtering. */
  listForActor(
    userId: string,
    options: { limit?: number },
    isEligible: AttentionEligibility
  ): AttentionDelivery[] {
    const limit = options.limit ?? 50;
    if (!isUserId(userId) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new AttentionError('invalid_attention_input');
    }
    return this.sqlite
      .prepare(
        `${SELECT} WHERE a.recipient_user_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT ?`
      )
      .all(userId, limit)
      .map(decodeRow)
      .filter((delivery) => isEligible(delivery) === true);
  }

  /** Claims before contact; only explicit retry after proved no-send can create another attempt. */
  async deliver(
    input: {
      deliveryId: string;
      recipientUserId: string;
      channel: AttentionChannel;
      retry?: boolean;
      expectedAttemptId: number | null;
    },
    dependencies: { isEligible: AttentionEligibility; transport: AttentionTransport }
  ): Promise<AttentionDelivery> {
    const parsed = DeliverSchema.safeParse(input);
    if (!parsed.success) throw new AttentionError('invalid_attention_input');
    const admitted = parsed.data;
    const delivery = this.sqlite.transaction(() => {
      const row = this.sqlite
        .prepare(`${SELECT} WHERE a.id = ? AND a.recipient_user_id = ?`)
        .get(admitted.deliveryId, admitted.recipientUserId);
      if (!row) throw new AttentionError('attention_not_found');
      const current = decodeRow(row);
      if ((current.attempt?.id ?? null) !== admitted.expectedAttemptId) {
        throw new AttentionError('attention_attempt_conflict');
      }
      if (current.channel !== null && current.channel !== admitted.channel) {
        throw new AttentionError('attention_channel_conflict');
      }
      if (
        current.status !== 'queued' &&
        !(current.status === 'failed-no-send' && admitted.retry === true)
      ) {
        throw new AttentionError('attention_not_sendable');
      }
      this.sqlite
        .prepare('UPDATE notification_attention SET channel = ? WHERE id = ? AND channel IS NULL')
        .run(admitted.channel, current.id);
      this.sqlite
        .prepare(`INSERT INTO notification_delivery_attempts
          (attention_id, channel, status, started_at) VALUES (?, ?, 'sending', ?)`)
        .run(current.id, admitted.channel, this.now());
      return this.get(current.id)!;
    })();
    let appPath: string;
    try {
      appPath =
        this.options.buildAppPath?.(delivery.source) ??
        `/tasks/${encodeURIComponent(delivery.source.workspaceId)}/${encodeURIComponent(delivery.source.threadId)}?${new URLSearchParams({ requestId: delivery.source.requestId })}`;
      if (
        !appPath.startsWith('/') ||
        new URL(appPath, 'https://attention.invalid').origin !== 'https://attention.invalid' ||
        /[\\\r\n]/.test(appPath)
      ) {
        throw new Error('Invalid App path');
      }
    } catch {
      this.finish(delivery, 'failed-no-send', 'transport-refused');
      throw new AttentionError('invalid_attention_input');
    }
    let eligible = false;
    try {
      eligible = dependencies.isEligible(delivery) === true;
    } catch {
      // Current authority is unavailable before transport; no external contact occurred.
    }
    if (!eligible) {
      this.finish(delivery, 'failed-no-send', 'authority-unavailable');
      throw new AttentionError('attention_not_eligible');
    }
    // No await, mutable-source read, or external work occurs between admission and transport.
    let status: 'sent' | 'failed-no-send' | 'delivery-unknown';
    try {
      const result = await dependencies.transport({
        kind: 'attention-link',
        deliveryId: delivery.id,
        appPath,
      });
      status = z.enum(['sent', 'failed-no-send', 'delivery-unknown']).parse(result.status);
    } catch {
      // An adapter throw cannot prove whether the external system accepted the message.
      status = 'delivery-unknown';
    }
    return this.finish(
      delivery,
      status,
      status === 'sent'
        ? null
        : status === 'failed-no-send'
          ? 'transport-refused'
          : 'transport-unknown'
    );
  }

  /** At startup before serving, makes every unfinished send unknown without contacting a transport. */
  reconcileIncompleteAttempts(): number {
    return this.sqlite.transaction(() => {
      for (const row of this.sqlite
        .prepare(`${SELECT} WHERE EXISTS (SELECT 1 FROM notification_delivery_attempts pending
        WHERE pending.attention_id = a.id AND pending.status = 'sending')`)
        .iterate()) {
        decodeRow(row);
      }
      return this.sqlite
        .prepare(`UPDATE notification_delivery_attempts SET status = 'delivery-unknown',
          failure_code = 'restart', finished_at = ? WHERE status = 'sending'`)
        .run(this.now()).changes;
    })();
  }

  /** Settles only the exact live claim; an already-reconciled attempt can never become sent. */
  private finish(
    delivery: AttentionDelivery,
    status: Exclude<AttentionAttempt['status'], 'sending'>,
    failureCode: AttentionAttempt['failureCode']
  ): AttentionDelivery {
    this.sqlite
      .prepare(`UPDATE notification_delivery_attempts SET status = ?, failure_code = ?, finished_at = ?
        WHERE id = ? AND attention_id = ? AND status = 'sending'`)
      .run(status, failureCode, this.now(), delivery.attempt!.id, delivery.id);
    return this.get(delivery.id)!;
  }

  /** Refuses invalid clock input before it can enter the durable owner. */
  private now(): string {
    const parsed = z
      .string()
      .datetime()
      .safeParse(this.options.now?.() ?? new Date().toISOString());
    if (!parsed.success) throw new AttentionError('invalid_attention_input');
    return parsed.data;
  }
}

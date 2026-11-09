import { randomUUID } from 'node:crypto';
import { isUserId, RequestIdSchema } from '@openkit/protocol';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { CoreDb } from '../storage/db.js';
import {
  type AttemptStatusSchema,
  type ChannelSchema,
  DeliverSchema,
  type FailureCodeSchema,
  RowSchema,
  SourceSchema,
} from './attention-codecs.js';
import { AttentionError } from './attention-error.js';

const EnqueueSchema = z
  .object({ source: SourceSchema, recipientUserId: z.string().refine(isUserId) })
  .strict();

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

/** Original get primitive, also used inside the original claim transaction. */
function getAttentionDeliveryInDb(sqlite: Database.Database, id: string): AttentionDelivery | null {
  if (!RequestIdSchema.safeParse(id).success) throw new AttentionError('invalid_attention_input');
  const row = sqlite.prepare(`${SELECT} WHERE a.id = ?`).get(id);
  return row ? decodeRow(row) : null;
}

/** Owns the complete original claim transaction, including its guards, clock and final projection. */
export function claimAttentionAttemptInDb(
  sqlite: Database.Database,
  admitted: z.infer<typeof DeliverSchema>,
  now: () => string
): AttentionDelivery {
  return sqlite.transaction(() => {
    const row = sqlite
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
    sqlite
      .prepare('UPDATE notification_attention SET channel = ? WHERE id = ? AND channel IS NULL')
      .run(admitted.channel, current.id);
    sqlite
      .prepare(`INSERT INTO notification_delivery_attempts
          (attention_id, channel, status, started_at) VALUES (?, ?, 'sending', ?)`)
      .run(current.id, admitted.channel, now());
    return getAttentionDeliveryInDb(sqlite, current.id)!;
  })();
}

/** Exact original attempt outcome/pointer and completion clock, without transport or source content. */
export interface AttentionAttemptCompletion {
  readonly deliveryId: string;
  readonly attemptId: number;
  readonly status: Exclude<AttentionAttempt['status'], 'sending'>;
  readonly failureCode: AttentionAttempt['failureCode'];
  readonly finishedAt: string;
}

/** Owns the original single-statement completion commit; projection remains a later stage. */
export function completeAttentionAttemptInDb(
  sqlite: Database.Database,
  input: AttentionAttemptCompletion
): void {
  sqlite
    .prepare(`UPDATE notification_delivery_attempts SET status = ?, failure_code = ?, finished_at = ?
        WHERE id = ? AND attention_id = ? AND status = 'sending'`)
    .run(input.status, input.failureCode, input.finishedAt, input.attemptId, input.deliveryId);
}

/** Original whole startup transaction: validate every affected projection before changing any attempt. */
export function reconcileIncompleteAttentionAttemptsInDb(
  sqlite: Database.Database,
  now: () => string
): number {
  return sqlite.transaction(() => {
    for (const row of sqlite
      .prepare(`${SELECT} WHERE EXISTS (SELECT 1 FROM notification_delivery_attempts pending
        WHERE pending.attention_id = a.id AND pending.status = 'sending')`)
      .iterate()) {
      decodeRow(row);
    }
    return sqlite
      .prepare(`UPDATE notification_delivery_attempts SET status = 'delivery-unknown',
          failure_code = 'restart', finished_at = ? WHERE status = 'sending'`)
      .run(now()).changes;
  })();
}

/** Owns attention delivery only; the injected Core database must already be migrated. */
export class AttentionNotifications {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly options: {
      now?: () => string;
      buildAppPath?: (source: AttentionSource) => string;
      /** Canonical runtime binding for startup reconciliation, claim and completion commits. */
      nativeCoreDb?: CoreDb;
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
    return getAttentionDeliveryInDb(this.sqlite, id);
  }

  /** Returns an exact reference only for its current eligible recipient. */
  getForActor(
    id: string,
    userId: string,
    isEligible: AttentionEligibility
  ): AttentionDelivery | null {
    if (!RequestIdSchema.safeParse(id).success) throw new AttentionError('invalid_attention_input');
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
    options: { limit?: number | undefined },
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

  /** Reads one recipient-scoped page in descending (createdAt, id) order after current source/audience admission. */
  pageForActor(
    userId: string,
    options: {
      limit?: number | undefined;
      cursor?: { createdAt: string; id: string } | undefined;
    },
    isEligible: AttentionEligibility
  ): { items: AttentionDelivery[]; hasMore: boolean } {
    const limit = options.limit ?? 50;
    if (!isUserId(userId) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new AttentionError('invalid_attention_input');
    }
    const cursor = options.cursor;
    const rows = cursor
      ? this.sqlite
          .prepare(
            `${SELECT} WHERE a.recipient_user_id = ? AND (a.created_at < ? OR (a.created_at = ? AND a.id < ?)) ORDER BY a.created_at DESC, a.id DESC`
          )
          .all(userId, cursor.createdAt, cursor.createdAt, cursor.id)
      : this.sqlite
          .prepare(`${SELECT} WHERE a.recipient_user_id = ? ORDER BY a.created_at DESC, a.id DESC`)
          .all(userId);
    const items: AttentionDelivery[] = [];
    for (const raw of rows) {
      const delivery = decodeRow(raw);
      if (isEligible(delivery) !== true) continue;
      if (items.length < limit) {
        items.push(delivery);
      } else {
        return { items, hasMore: true };
      }
    }
    return { items, hasMore: false };
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
    const delivery = this.options.nativeCoreDb
      ? await this.claimNative(admitted)
      : claimAttentionAttemptInDb(this.sqlite, admitted, () => this.now());
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
      await this.finish(delivery, 'failed-no-send', 'transport-refused');
      throw new AttentionError('invalid_attention_input');
    }
    let eligible = false;
    try {
      eligible = dependencies.isEligible(delivery) === true;
    } catch {
      // Current authority is unavailable before transport; no external contact occurred.
    }
    if (!eligible) {
      await this.finish(delivery, 'failed-no-send', 'authority-unavailable');
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
  async reconcileIncompleteAttempts(): Promise<number> {
    const coreDb = this.options.nativeCoreDb;
    if (!coreDb) return reconcileIncompleteAttentionAttemptsInDb(this.sqlite, () => this.now());
    const { getControlStoreWorkerClient, ControlStoreWorkerError } = await import(
      '../storage/control-store-worker-client.js'
    );
    if (coreDb.sqlite !== this.sqlite)
      throw new ControlStoreWorkerError('invalid-request', 'not-committed');
    let finishedAt: string | null = null;
    let clockError: unknown;
    try {
      finishedAt = this.now();
    } catch (error) {
      clockError = error;
    }
    try {
      return await getControlStoreWorkerClient().attentionReconcileIncompleteAttempts(coreDb, {
        finishedAt,
      });
    } catch (error) {
      // Keep the original corruption-before-clock refusal inside whole-operation rollback.
      if (
        finishedAt === null &&
        error instanceof AttentionError &&
        error.code === 'invalid_attention_input'
      )
        throw clockError;
      throw error;
    }
  }

  /** Only a durable original claim snapshot may reach routing, fresh eligibility or transport. */
  private async claimNative(admitted: z.infer<typeof DeliverSchema>): Promise<AttentionDelivery> {
    const coreDb = this.options.nativeCoreDb!;
    const { getControlStoreWorkerClient, ControlStoreWorkerError } = await import(
      '../storage/control-store-worker-client.js'
    );
    if (coreDb.sqlite !== this.sqlite)
      throw new ControlStoreWorkerError('invalid-request', 'not-committed');
    let startedAt: string | null = null;
    let clockError: unknown;
    try {
      startedAt = this.now();
    } catch (error) {
      clockError = error;
    }
    try {
      return await getControlStoreWorkerClient().attentionAttemptClaim(coreDb, {
        ...admitted,
        startedAt,
      });
    } catch (error) {
      // A prepared invalid clock is consumed only at the original insertion point,
      // after the original lookup/CAS/channel/status guards and inside rollback.
      if (
        startedAt === null &&
        error instanceof AttentionError &&
        error.code === 'invalid_attention_input'
      )
        throw clockError;
      throw error;
    }
  }

  /** Settles only the exact live claim; an already-reconciled attempt can never become sent. */
  private async finish(
    delivery: AttentionDelivery,
    status: Exclude<AttentionAttempt['status'], 'sending'>,
    failureCode: AttentionAttempt['failureCode']
  ): Promise<AttentionDelivery> {
    const input: AttentionAttemptCompletion = {
      deliveryId: delivery.id,
      attemptId: delivery.attempt!.id,
      status,
      failureCode,
      finishedAt: this.now(),
    };
    const coreDb = this.options.nativeCoreDb;
    if (coreDb) {
      const { getControlStoreWorkerClient, ControlStoreWorkerError } = await import(
        '../storage/control-store-worker-client.js'
      );
      // Bind the actual owner connection before any native open/post. The client
      // independently binds the supplied Core scope and canonical physical path.
      if (coreDb.sqlite !== this.sqlite)
        throw new ControlStoreWorkerError('invalid-request', 'not-committed');
      await getControlStoreWorkerClient().attentionAttemptCompletion(coreDb, input);
    } else {
      // Original raw-database owners/fixtures retain their existing statement.
      completeAttentionAttemptInDb(this.sqlite, input);
    }
    // This was always a separate post-commit projection, never part of the UPDATE.
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

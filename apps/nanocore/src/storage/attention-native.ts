import { randomUUID } from 'node:crypto';
import type { ControlAttention, ControlAttentionResult } from './attention-codecs.js';
import { AttentionError, decodeRow, SELECT } from './attention-records.js';
import type { CoreDb } from './db.js';

/** Executes one original Attention stage inside the existing native savepoint and covering FULL commit. */
export function applyAttentionInDb(db: CoreDb, input: ControlAttention): ControlAttentionResult {
  const read = (id: string) => decodeRow(db.sqlite.prepare(`${SELECT} WHERE a.id = ?`).get(id));
  if (input.action === 'enqueue') {
    const { source, recipientUserId } = input.input;
    const delivery = (() => {
      db.sqlite
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
          input.timestamp
        );
      return decodeRow(
        db.sqlite
          .prepare(`${SELECT} WHERE a.workspace_id = ? AND a.thread_id = ? AND a.source_kind = ?
            AND a.request_id = ? AND a.recipient_user_id = ?`)
          .get(source.workspaceId, source.threadId, source.kind, source.requestId, recipientUserId)
      );
    })();
    return { kind: 'delivery', delivery };
  }
  if (input.action === 'claim') {
    const admitted = input.input;
    const delivery = (() => {
      const row = db.sqlite
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
      db.sqlite
        .prepare('UPDATE notification_attention SET channel = ? WHERE id = ? AND channel IS NULL')
        .run(admitted.channel, current.id);
      db.sqlite
        .prepare(`INSERT INTO notification_delivery_attempts
          (attention_id, channel, status, started_at) VALUES (?, ?, 'sending', ?)`)
        .run(current.id, admitted.channel, input.timestamp);
      return read(current.id);
    })();
    return { kind: 'delivery', delivery };
  }
  if (input.action === 'reconcile') {
    const count = (() => {
      for (const row of db.sqlite
        .prepare(`${SELECT} WHERE EXISTS (SELECT 1 FROM notification_delivery_attempts pending
        WHERE pending.attention_id = a.id AND pending.status = 'sending')`)
        .iterate()) {
        decodeRow(row);
      }
      return db.sqlite
        .prepare(`UPDATE notification_delivery_attempts SET status = 'delivery-unknown',
          failure_code = 'restart', finished_at = ? WHERE status = 'sending'`)
        .run(input.timestamp).changes;
    })();
    return { kind: 'reconciled', count };
  }
  const { status, failureCode } = input;
  const delivery = (() => {
    db.sqlite
      .prepare(`UPDATE notification_delivery_attempts SET status = ?, failure_code = ?, finished_at = ?
        WHERE id = ? AND attention_id = ? AND status = 'sending'`)
      .run(status, failureCode, input.timestamp, input.attemptId, input.deliveryId);
    return read(input.deliveryId);
  })();
  return { kind: 'delivery', delivery };
}

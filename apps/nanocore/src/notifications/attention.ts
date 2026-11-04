import { isUserId, RequestIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import type { ControlAttention, ControlAttentionResult } from '../storage/attention-codecs.js';
import {
  type AttentionAttempt,
  type AttentionChannel,
  type AttentionDelivery,
  type AttentionEligibility,
  AttentionError,
  type AttentionSource,
  type AttentionTransport,
  DeliverSchema,
  decodeRow,
  EnqueueSchema,
  SELECT,
} from '../storage/attention-records.js';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';

export {
  type AttentionAttempt,
  type AttentionChannel,
  type AttentionDelivery,
  type AttentionEligibility,
  AttentionError,
  type AttentionLink,
  type AttentionSource,
  type AttentionTransport,
} from '../storage/attention-records.js';

/** Owns attention delivery only; the injected Core database must already be migrated. */
export class AttentionNotifications {
  constructor(
    private readonly coreDb: CoreDb,
    private readonly options: {
      now?: () => string;
      buildAppPath?: (source: AttentionSource) => string;
    } = {}
  ) {}

  /** Adds one exact source/recipient reference, returning the existing reference on replay. */
  async enqueue(input: {
    source: AttentionSource;
    recipientUserId: string;
  }): Promise<AttentionDelivery> {
    const parsed = EnqueueSchema.safeParse(input);
    if (!parsed.success) throw new AttentionError('invalid_attention_input');
    return this.publishDelivery({ action: 'enqueue', timestamp: this.now(), input: parsed.data });
  }

  /** Reads an internal reference; callers must use current admission before exposing it. */
  get(id: string): AttentionDelivery | null {
    if (!RequestIdSchema.safeParse(id).success) throw new AttentionError('invalid_attention_input');
    const row = this.coreDb.sqlite.prepare(`${SELECT} WHERE a.id = ?`).get(id);
    return row ? decodeRow(row) : null;
  }

  /** Returns an exact reference only for its current eligible recipient. */
  getForActor(
    id: string,
    userId: string,
    isEligible: AttentionEligibility
  ): AttentionDelivery | null {
    if (!RequestIdSchema.safeParse(id).success) throw new AttentionError('invalid_attention_input');
    const row = this.coreDb.sqlite
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
    return this.coreDb.sqlite
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
    return getControlStoreWorkerClient().runOperation(async () => {
      const delivery = await this.publishDelivery({
        action: 'claim',
        timestamp: this.now(),
        input: parsed.data,
      });
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
    });
  }

  /** At startup before serving, makes every unfinished send unknown without contacting a transport. */
  async reconcileIncompleteAttempts(): Promise<number> {
    const result = await this.publish({ action: 'reconcile', timestamp: this.now() });
    if (result.kind !== 'reconciled')
      throw new Error('Native Attention returned no reconciliation.');
    return result.count;
  }

  /** Settles only the exact live claim; an already-reconciled attempt can never become sent. */
  private async finish(
    delivery: AttentionDelivery,
    status: Exclude<AttentionAttempt['status'], 'sending'>,
    failureCode: AttentionAttempt['failureCode']
  ): Promise<AttentionDelivery> {
    return this.publishDelivery({
      action: 'settle',
      timestamp: this.now(),
      deliveryId: delivery.id,
      attemptId: delivery.attempt!.id,
      status,
      failureCode,
    });
  }

  /** Opens the existing physical Core owner; no readiness promise or second connection owner is stored. */
  private async publish(input: ControlAttention): Promise<ControlAttentionResult> {
    const scope = nativeProductScope(this.coreDb.dataRoot, { kind: 'server' });
    const database = `core:${scope.path}`;
    const client = getControlStoreWorkerClient();
    return client.runOperation(async () => {
      await client.open({
        database,
        path: scope.path,
        dataRoot: this.coreDb.dataRoot,
        create: false,
        initialize: 'core',
        productOwner: scope.owner,
        contentMount: scope.contentMount,
      });
      try {
        return await client.attention(database, input);
      } catch (error) {
        if (
          error instanceof ControlStoreWorkerError &&
          error.commit === 'not-committed' &&
          error.domain?.operation === 'attention'
        )
          throw new AttentionError(error.domain.code);
        throw error;
      }
    });
  }

  /** Returns only the exact original readback for a publication stage. */
  private async publishDelivery(input: ControlAttention): Promise<AttentionDelivery> {
    const result = await this.publish(input);
    if (result.kind !== 'delivery') throw new Error('Native Attention returned no delivery.');
    return result.delivery;
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

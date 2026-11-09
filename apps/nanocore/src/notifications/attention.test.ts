import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRecord } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ChannelServices,
  createChannelOperationImplementations,
} from '../channel-services.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb } from '../storage/db.js';
import { applyNativeScopeMigrations } from '../storage/migrate.js';
import { testEntityId } from '../test-support/entity-ids.js';
import {
  type AttentionDelivery,
  AttentionNotifications,
  type AttentionSource,
  type AttentionTransport,
} from './attention.js';

// Hold only a genuine native post-commit ACK. SQLite and its Worker stay real.
const reconciliationAck = vi.hoisted(() => ({
  hold: false,
  arrived: undefined as (() => void) | undefined,
  release: undefined as (() => void) | undefined,
}));
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      override emit(event: string | symbol, ...args: unknown[]): boolean {
        const reply = args[0];
        if (
          reconciliationAck.hold &&
          event === 'message' &&
          isRecord(reply) &&
          reply.status === 'ok' &&
          reply.operation === 'attention-reconcile-incomplete-attempts' &&
          isRecord(reply.result) &&
          reply.result.status === 'reconciled'
        ) {
          reconciliationAck.release = () => super.emit(event, ...args);
          reconciliationAck.arrived?.();
          return true;
        }
        return super.emit(event, ...args);
      }
    },
  };
});

const aliceId = testEntityId('usr', 'attention-alice');
const bobId = testEntityId('usr', 'attention-bob');
const source: AttentionSource = {
  workspaceId: testEntityId('ws', 'attention'),
  threadId: testEntityId('th', 'attention-private'),
  kind: 'approval-request',
  requestId: 'apr_exact',
};
const now = () => '2026-10-16T12:00:00.000Z';
const dbs: Database.Database[] = [];
const directories: string[] = [];

/** Compares complete deliveries without printing megabytes if an identity differs. */
function compactDelivery(delivery: AttentionDelivery) {
  return {
    ...delivery,
    source: {
      ...delivery.source,
      requestId: {
        length: delivery.source.requestId.length,
        digest: createHash('sha256').update(delivery.source.requestId).digest('hex'),
      },
    },
  };
}

async function fixture(path = ':memory:') {
  const sqlite = new Database(path);
  dbs.push(sqlite);
  sqlite.pragma('foreign_keys = ON');
  applyNativeScopeMigrations(sqlite, 'core');
  const notifications = new AttentionNotifications(sqlite, { now });
  const delivery = await notifications.enqueue({ source, recipientUserId: aliceId });
  return { sqlite, notifications, delivery };
}

afterEach(async () => {
  reconciliationAck.hold = false;
  reconciliationAck.release?.();
  reconciliationAck.release = undefined;
  reconciliationAck.arrived = undefined;
  await shutdownControlStoreWorkerClient();
  for (const db of dbs.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('attention delivery owner', () => {
  it('does not run DDL in its constructor', () => {
    const sqlite = new Database(':memory:');
    dbs.push(sqlite);
    new AttentionNotifications(sqlite);
    expect(sqlite.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()).toEqual([]);
  });

  it('deduplicates the exact source and recipient and preserves other identities', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'attention-enqueue-restart-'));
    directories.push(directory);
    const path = join(directory, 'core.sqlite');
    const { sqlite, notifications, delivery } = await fixture(path);
    expect(await notifications.enqueue({ source, recipientUserId: aliceId })).toEqual(delivery);
    for (const changed of [
      { source, recipientUserId: bobId },
      { source: { ...source, requestId: 'apr_other' }, recipientUserId: aliceId },
      {
        source: { ...source, threadId: testEntityId('th', 'attention-other') },
        recipientUserId: aliceId,
      },
      {
        source: { ...source, workspaceId: testEntityId('ws', 'attention-other') },
        recipientUserId: aliceId,
      },
      {
        source: { ...source, kind: 'user-input-request' as const },
        recipientUserId: aliceId,
      },
    ]) {
      expect((await notifications.enqueue(changed)).id).not.toBe(delivery.id);
    }

    // Pending Request selectors have no public length cap. Include JSON escapes,
    // NUL, BOM and multibyte text beyond the ordinary 1 MiB native envelope.
    const requestId = `apr_${'"\\\n\u0000\uFEFF😀'.repeat(110_000)}`;
    expect(Buffer.byteLength(requestId)).toBeGreaterThan(1_048_576);
    const exactSource = { ...source, requestId };
    const exact = await notifications.enqueue({ source: exactSource, recipientUserId: aliceId });
    expect(compactDelivery(exact)).toEqual(
      compactDelivery({
        ...exact,
        source: exactSource,
        status: 'queued',
        channel: null,
        attempt: null,
        createdAt: now(),
      })
    );
    const later = new AttentionNotifications(sqlite, { now: () => '2026-10-19T00:00:00.000Z' });
    expect(
      compactDelivery(await later.enqueue({ source: exactSource, recipientUserId: aliceId }))
    ).toEqual(compactDelivery(exact));
    expect((await later.enqueue({ source: exactSource, recipientUserId: bobId })).id).not.toBe(
      exact.id
    );
    expect(
      (
        await later.enqueue({
          source: { ...exactSource, requestId: `${requestId}x` },
          recipientUserId: aliceId,
        })
      ).id
    ).not.toBe(exact.id);
    sqlite.close();

    const reopened = new Database(path);
    dbs.push(reopened);
    const restarted = new AttentionNotifications(reopened, { now });
    expect(compactDelivery(restarted.get(exact.id)!)).toEqual(compactDelivery(exact));
    expect(
      compactDelivery(await restarted.enqueue({ source: exactSource, recipientUserId: aliceId }))
    ).toEqual(compactDelivery(exact));
  });

  it('rolls back enqueue when its inserted projection is corrupt and retains no row after reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'attention-enqueue-rollback-'));
    directories.push(directory);
    const path = join(directory, 'core.sqlite');
    const { sqlite, notifications, delivery } = await fixture(path);
    const input = {
      source: { ...source, requestId: 'apr_corrupt_insert' },
      recipientUserId: aliceId,
    };
    // Inject corruption after valid INSERT admission and before its owning
    // projection decoder. Refusal must roll back that same complete transaction.
    sqlite.exec(`CREATE TRIGGER corrupt_attention_projection AFTER INSERT ON notification_attention
      BEGIN UPDATE notification_attention SET created_at = 'invalid' WHERE id = NEW.id; END`);
    await expect(Promise.resolve().then(() => notifications.enqueue(input))).rejects.toThrow(
      'attention_recovery_required'
    );
    expect(notifications.listForActor(aliceId, {}, () => true)).toEqual([delivery]);
    sqlite.exec('DROP TRIGGER corrupt_attention_projection');
    sqlite.close();

    const reopened = new Database(path);
    dbs.push(reopened);
    const restarted = new AttentionNotifications(reopened, { now });
    expect(restarted.listForActor(aliceId, {}, () => true)).toEqual([delivery]);
    const accepted = await restarted.enqueue(input);
    expect(accepted).toMatchObject({
      source: input.source,
      status: 'queued',
      attempt: null,
      createdAt: now(),
    });
  });

  it('natively enqueues and replays the exact large tuple with Main query-only across reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'attention-native-enqueue-'));
    directories.push(directory);
    const coreDb = openCoreDb(directory);
    dbs.push(coreDb.sqlite);
    applyNativeScopeMigrations(coreDb.sqlite, 'core');
    const notifications = new AttentionNotifications(coreDb.sqlite, { nativeCoreDb: coreDb, now });
    const requestId = `apr_${'"\\\n\u0000\uFEFF😀'.repeat(110_000)}`;
    const input = { source: { ...source, requestId }, recipientUserId: aliceId };
    coreDb.sqlite.exec(`CREATE TRIGGER corrupt_attention_projection AFTER INSERT ON notification_attention
      BEGIN UPDATE notification_attention SET created_at = 'invalid' WHERE id = NEW.id; END`);
    coreDb.sqlite.pragma('query_only = ON');
    await expect(notifications.enqueue(input)).rejects.toThrow('attention_recovery_required');
    expect(notifications.listForActor(aliceId, {}, () => true)).toEqual([]);
    coreDb.sqlite.pragma('query_only = OFF');
    coreDb.sqlite.exec('DROP TRIGGER corrupt_attention_projection');
    coreDb.sqlite.pragma('query_only = ON');

    const [first, concurrent] = await Promise.all([
      notifications.enqueue(input),
      notifications.enqueue(input),
    ]);
    expect(compactDelivery(first)).toEqual(
      compactDelivery({
        ...first,
        source: input.source,
        recipientUserId: aliceId,
        createdAt: now(),
        channel: null,
        attempt: null,
        status: 'queued',
      })
    );
    expect(compactDelivery(concurrent)).toEqual(compactDelivery(first));
    expect(notifications.listForActor(aliceId, {}, () => true)).toHaveLength(1);
    const transport = vi.fn<AttentionTransport>().mockResolvedValue({ status: 'sent' });
    const settled = await notifications.deliver(
      {
        deliveryId: first.id,
        recipientUserId: aliceId,
        channel: 'discord',
        expectedAttemptId: null,
      },
      { isEligible: () => true, transport }
    );
    expect(compactDelivery(await notifications.enqueue(input))).toEqual(compactDelivery(settled));
    expect(transport).toHaveBeenCalledTimes(1);
    expect(coreDb.sqlite.pragma('query_only', { simple: true })).toBe(1);
    await shutdownControlStoreWorkerClient();
    coreDb.sqlite.close();

    const reopened = openCoreDb(directory);
    dbs.push(reopened.sqlite);
    reopened.sqlite.pragma('query_only = ON');
    const restarted = new AttentionNotifications(reopened.sqlite, { nativeCoreDb: reopened, now });
    expect(compactDelivery(restarted.get(first.id)!)).toEqual(compactDelivery(settled));
    expect(compactDelivery(await restarted.enqueue(input))).toEqual(compactDelivery(settled));
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('bounds recipient reads and applies current source and audience admission', async () => {
    const { notifications, delivery } = await fixture();
    await notifications.enqueue({ source, recipientUserId: bobId });
    for (let index = 0; index < 4; index++) {
      await notifications.enqueue({
        source: { ...source, requestId: `apr_${index}` },
        recipientUserId: aliceId,
      });
    }
    const eligible = vi.fn(() => true);
    expect(notifications.listForActor(aliceId, { limit: 2 }, eligible)).toHaveLength(2);
    expect(eligible).toHaveBeenCalledTimes(2);
    expect(notifications.listForActor(aliceId, { limit: 2 }, () => false)).toEqual([]);
    expect(notifications.getForActor(delivery.id, bobId, eligible)).toBeNull();
    expect(notifications.getForActor(delivery.id, aliceId, () => false)).toBeNull();
    expect(notifications.getForActor(delivery.id, aliceId, () => true)).toEqual(delivery);
    for (const limit of [0, 101, 1.5]) {
      expect(() => notifications.listForActor(aliceId, { limit }, eligible)).toThrow(
        'invalid_attention_input'
      );
    }

    const firstPage = notifications.pageForActor(aliceId, { limit: 2 }, () => true);
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.hasMore).toBe(true);
    const secondPage = notifications.pageForActor(
      aliceId,
      {
        limit: 2,
        cursor: {
          createdAt: firstPage.items.at(-1)!.createdAt,
          id: firstPage.items.at(-1)!.id,
        },
      },
      () => true
    );
    expect(secondPage.items).toHaveLength(2);
    expect(secondPage.hasMore).toBe(true);
    const thirdPage = notifications.pageForActor(
      aliceId,
      {
        limit: 2,
        cursor: {
          createdAt: secondPage.items.at(-1)!.createdAt,
          id: secondPage.items.at(-1)!.id,
        },
      },
      () => true
    );
    expect(thirdPage.items).toHaveLength(1);
    expect(thirdPage.hasMore).toBe(false);
    const pagedIds = [...firstPage.items, ...secondPage.items, ...thirdPage.items].map(
      (item) => item.id
    );
    expect(new Set(pagedIds).size).toBe(5);
  });

  it('rejects malformed identities and captured source arguments at admission', async () => {
    const { notifications } = await fixture();
    for (const input of [
      { source: { ...source, workspaceId: 'bad' }, recipientUserId: aliceId },
      { source: { ...source, threadId: 'bad' }, recipientUserId: aliceId },
      { source, recipientUserId: 'bad' },
      { source: { ...source, arguments: { private: 'content' } }, recipientUserId: aliceId },
    ]) {
      await expect(Promise.resolve().then(() => notifications.enqueue(input))).rejects.toThrow(
        'invalid_attention_input'
      );
    }
  });

  it('claims durably before synchronous authority admission and sends only the App link', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'attention-claim-'));
    directories.push(directory);
    const path = join(directory, 'core.sqlite');
    const { notifications, delivery } = await fixture(path);
    const observerDb = new Database(path);
    dbs.push(observerDb);
    const observer = new AttentionNotifications(observerDb);
    const events: string[] = [];
    const result = await notifications.deliver(
      {
        deliveryId: delivery.id,
        recipientUserId: aliceId,
        expectedAttemptId: null,
        channel: 'discord',
      },
      {
        isEligible: (claimed) => {
          events.push('admission');
          expect(observer.get(delivery.id)?.status).toBe('sending');
          expect(claimed.channel).toBe('discord');
          return true;
        },
        transport: async (payload) => {
          events.push('transport');
          expect(observer.get(delivery.id)?.status).toBe('sending');
          expect(payload).toEqual({
            kind: 'attention-link',
            deliveryId: delivery.id,
            appPath: `/tasks/${source.workspaceId}/${source.threadId}?requestId=apr_exact`,
          });
          return { status: 'sent' };
        },
      }
    );
    expect(events).toEqual(['admission', 'transport']);
    expect(result).toMatchObject({
      status: 'sent',
      attempt: { status: 'sent', failureCode: null },
    });
    expect(await notifications.enqueue({ source, recipientUserId: aliceId })).toEqual(result);
  });

  it('makes no contact after authority loss or admission dependency failure', async () => {
    const { notifications, delivery } = await fixture();
    const transport = vi.fn<AttentionTransport>();
    for (const isEligible of [
      () => false,
      () => Promise.resolve(true) as never,
      () => {
        throw new Error('private dependency details');
      },
    ]) {
      await expect(
        notifications.deliver(
          {
            deliveryId: delivery.id,
            recipientUserId: aliceId,
            channel: 'discord',
            retry: true,
            expectedAttemptId: notifications.get(delivery.id)?.attempt?.id ?? null,
          },
          { isEligible, transport }
        )
      ).rejects.toThrow('attention_not_eligible');
      expect(notifications.get(delivery.id)).toMatchObject({
        status: 'failed-no-send',
        attempt: { failureCode: 'authority-unavailable' },
      });
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it('allows only explicit retry of definite no-send and keeps the original channel', async () => {
    const { notifications, delivery } = await fixture();
    const input = {
      deliveryId: delivery.id,
      recipientUserId: aliceId,
      expectedAttemptId: null,
      channel: 'email' as const,
    };
    const transport = vi.fn<AttentionTransport>().mockResolvedValue({ status: 'failed-no-send' });
    const dependencies = { isEligible: () => true, transport };
    expect(await notifications.deliver(input, dependencies)).toMatchObject({
      status: 'failed-no-send',
      attempt: { failureCode: 'transport-refused' },
    });
    await expect(notifications.deliver(input, dependencies)).rejects.toThrow(
      'attention_attempt_conflict'
    );
    await expect(
      notifications.deliver(
        { ...input, retry: true, expectedAttemptId: 1, channel: 'discord' },
        dependencies
      )
    ).rejects.toThrow('attention_channel_conflict');
    transport.mockResolvedValue({ status: 'sent' });
    expect(
      await notifications.deliver(
        {
          ...input,
          retry: true,
          expectedAttemptId: notifications.get(delivery.id)?.attempt?.id ?? null,
        },
        dependencies
      )
    ).toMatchObject({
      status: 'sent',
      attempt: { id: 2 },
    });
    await expect(
      notifications.deliver(
        {
          ...input,
          retry: true,
          expectedAttemptId: notifications.get(delivery.id)?.attempt?.id ?? null,
        },
        dependencies
      )
    ).rejects.toThrow('attention_not_sendable');
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('does not replay an explicit retry that also ends in definite no-send', async () => {
    const { notifications, delivery } = await fixture();
    const first = {
      deliveryId: delivery.id,
      recipientUserId: aliceId,
      channel: 'discord' as const,
      expectedAttemptId: null,
    };
    const transport = vi.fn<AttentionTransport>().mockResolvedValue({ status: 'failed-no-send' });
    const dependencies = { isEligible: () => true, transport };
    await notifications.deliver(first, dependencies);
    const retry = { ...first, retry: true, expectedAttemptId: 1 };
    expect((await notifications.deliver(retry, dependencies)).attempt?.id).toBe(2);
    await expect(notifications.deliver(retry, dependencies)).rejects.toThrow(
      'attention_attempt_conflict'
    );
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each(['throw', 'unknown', 'invalid'] as const)(
    'keeps %s transport results unknown and prevents retry or channel fallback',
    async (mode) => {
      const { notifications, delivery } = await fixture();
      const input = {
        deliveryId: delivery.id,
        expectedAttemptId: null,
        recipientUserId: aliceId,
        channel: 'discord' as const,
      };
      const transport = vi.fn<AttentionTransport>().mockImplementation(async () => {
        if (mode === 'throw') throw new Error('secret upstream details');
        if (mode === 'invalid') return { status: 'unexpected' } as never;
        return { status: 'delivery-unknown' };
      });
      const dependencies = { isEligible: () => true, transport };
      expect(await notifications.deliver(input, dependencies)).toMatchObject({
        status: 'delivery-unknown',
        attempt: { failureCode: 'transport-unknown' },
      });
      await expect(
        notifications.deliver(
          {
            ...input,
            retry: true,
            expectedAttemptId: notifications.get(delivery.id)?.attempt?.id ?? null,
          },
          dependencies
        )
      ).rejects.toThrow('attention_not_sendable');
      await expect(
        notifications.deliver(
          {
            ...input,
            channel: 'email',
            retry: true,
            expectedAttemptId: notifications.get(delivery.id)?.attempt?.id ?? null,
          },
          dependencies
        )
      ).rejects.toThrow('attention_channel_conflict');
      expect(transport).toHaveBeenCalledTimes(1);
    }
  );

  it('refuses concurrent and wrong-recipient sends before any additional contact', async () => {
    const { sqlite, notifications, delivery } = await fixture();
    const observer = new AttentionNotifications(sqlite);
    const input = {
      deliveryId: delivery.id,
      expectedAttemptId: null,
      recipientUserId: aliceId,
      channel: 'discord' as const,
    };
    let complete: ((result: { status: 'sent' }) => void) | undefined;
    const transport = vi.fn<AttentionTransport>(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const dependencies = { isEligible: () => true, transport };
    await expect(
      observer.deliver({ ...input, recipientUserId: bobId }, dependencies)
    ).rejects.toThrow('attention_not_found');
    const pending = notifications.deliver(input, dependencies);
    await expect(observer.deliver(input, dependencies)).rejects.toThrow(
      'attention_attempt_conflict'
    );
    complete!({ status: 'sent' });
    expect((await pending).status).toBe('sent');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('reopens persisted unfinished claims as unknown without retry', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'attention-restart-'));
    directories.push(directory);
    const path = join(directory, 'core.sqlite');
    const { sqlite, notifications, delivery } = await fixture(path);
    const terminal = [];
    for (const status of ['sent', 'failed-no-send', 'delivery-unknown'] as const) {
      const reference = await notifications.enqueue({
        source: { ...source, requestId: `apr_terminal_${status}` },
        recipientUserId: aliceId,
      });
      terminal.push(
        await notifications.deliver(
          {
            deliveryId: reference.id,
            expectedAttemptId: null,
            recipientUserId: aliceId,
            channel: 'discord',
          },
          { isEligible: () => true, transport: async () => ({ status }) }
        )
      );
    }
    const queued = await notifications.enqueue({
      source: { ...source, requestId: 'apr_still_queued' },
      recipientUserId: aliceId,
    });
    const second = await notifications.enqueue({ source, recipientUserId: bobId });
    const input = {
      deliveryId: delivery.id,
      expectedAttemptId: null,
      recipientUserId: aliceId,
      channel: 'discord' as const,
    };
    sqlite.exec(`CREATE TRIGGER refuse_attempt_settlement BEFORE UPDATE ON notification_delivery_attempts
      BEGIN SELECT RAISE(ABORT, 'simulated lost settlement'); END`);
    const transport = vi.fn<AttentionTransport>().mockResolvedValue({ status: 'sent' });
    await expect(
      notifications.deliver(input, { isEligible: () => true, transport })
    ).rejects.toThrow('simulated lost settlement');
    await expect(
      notifications.deliver(
        { ...input, deliveryId: second.id, recipientUserId: bobId },
        { isEligible: () => true, transport }
      )
    ).rejects.toThrow('simulated lost settlement');
    expect(notifications.get(delivery.id)?.status).toBe('sending');
    const sending = [notifications.get(delivery.id)!, notifications.get(second.id)!];
    sqlite.exec('DROP TRIGGER refuse_attempt_settlement');
    sqlite.close();
    const reopened = new Database(path);
    dbs.push(reopened);
    const restartTime = '2026-10-17T06:00:00.000Z';
    const restarted = new AttentionNotifications(reopened, { now: () => restartTime });
    expect(await restarted.reconcileIncompleteAttempts()).toBe(2);
    expect(await restarted.reconcileIncompleteAttempts()).toBe(0);
    for (const original of sending) {
      expect(restarted.get(original.id)).toEqual({
        ...original,
        status: 'delivery-unknown',
        attempt: {
          ...original.attempt!,
          status: 'delivery-unknown',
          failureCode: 'restart',
          finishedAt: restartTime,
        },
      });
    }
    for (const original of [...terminal, queued])
      expect(restarted.get(original.id)).toEqual(original);
    expect(restarted.get(delivery.id)).toMatchObject({
      status: 'delivery-unknown',
      attempt: { failureCode: 'restart' },
    });
    await expect(
      restarted.deliver(
        {
          ...input,
          retry: true,
          expectedAttemptId: restarted.get(delivery.id)?.attempt?.id ?? null,
        },
        { isEligible: () => true, transport }
      )
    ).rejects.toThrow('attention_not_sendable');
    expect(transport).toHaveBeenCalledTimes(2);
    const settled = [...sending, ...terminal, queued].map((row) => restarted.get(row.id));
    reopened.close();
    const durableDb = new Database(path);
    dbs.push(durableDb);
    const durable = new AttentionNotifications(durableDb, { now });
    expect([...sending, ...terminal, queued].map((row) => durable.get(row.id))).toEqual(settled);
    expect(await durable.reconcileIncompleteAttempts()).toBe(0);
  });

  it('refuses a corrupt affected row without reconciling any unfinished attempt', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'attention-restart-corrupt-'));
    directories.push(directory);
    const path = join(directory, 'core.sqlite');
    const { sqlite, notifications, delivery } = await fixture(path);
    const second = await notifications.enqueue({ source, recipientUserId: bobId });
    sqlite.exec(`CREATE TRIGGER refuse_attempt_settlement BEFORE UPDATE ON notification_delivery_attempts
      BEGIN SELECT RAISE(ABORT, 'simulated lost settlement'); END`);
    for (const reference of [delivery, second]) {
      await expect(
        notifications.deliver(
          {
            deliveryId: reference.id,
            recipientUserId: reference.recipientUserId,
            channel: 'discord',
            expectedAttemptId: null,
          },
          { isEligible: () => true, transport: async () => ({ status: 'sent' }) }
        )
      ).rejects.toThrow('simulated lost settlement');
    }
    sqlite.exec('DROP TRIGGER refuse_attempt_settlement');
    // Pending Requests requires unsupported core values to fail closed. Corrupt
    // the second valid claim only after both owner-created sends are unfinished.
    sqlite.pragma('ignore_check_constraints = ON');
    sqlite
      .prepare('UPDATE notification_attention SET channel = ? WHERE id = ?')
      .run('slack', second.id);
    const attempts = sqlite
      .prepare('SELECT * FROM notification_delivery_attempts ORDER BY id')
      .all();
    sqlite.close();

    const reopened = new Database(path);
    dbs.push(reopened);
    const restarted = new AttentionNotifications(reopened, { now });
    await expect(
      Promise.resolve().then(() => restarted.reconcileIncompleteAttempts())
    ).rejects.toThrow('attention_recovery_required');
    expect(restarted.get(delivery.id)?.status).toBe('sending');
    expect(
      reopened.prepare('SELECT * FROM notification_delivery_attempts ORDER BY id').all()
    ).toEqual(attempts);
    reopened.close();

    const durable = new Database(path);
    dbs.push(durable);
    expect(
      durable.prepare('SELECT * FROM notification_delivery_attempts ORDER BY id').all()
    ).toEqual(attempts);
  });

  it('reconciles through native Core with Main query-only and resolves only after the durable ACK', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'attention-native-restart-'));
    directories.push(directory);
    const coreDb = openCoreDb(directory);
    dbs.push(coreDb.sqlite);
    applyNativeScopeMigrations(coreDb.sqlite, 'core');
    const original = new AttentionNotifications(coreDb.sqlite, { now });
    const references = [
      await original.enqueue({ source, recipientUserId: aliceId }),
      await original.enqueue({ source, recipientUserId: bobId }),
    ];
    coreDb.sqlite.exec(`CREATE TRIGGER refuse_attempt_settlement BEFORE UPDATE ON notification_delivery_attempts
      BEGIN SELECT RAISE(ABORT, 'simulated lost settlement'); END`);
    const transport = vi.fn<AttentionTransport>().mockResolvedValue({ status: 'sent' });
    for (const reference of references) {
      await expect(
        original.deliver(
          {
            deliveryId: reference.id,
            recipientUserId: reference.recipientUserId,
            channel: 'discord',
            expectedAttemptId: null,
          },
          { isEligible: () => true, transport }
        )
      ).rejects.toThrow('simulated lost settlement');
    }
    coreDb.sqlite.exec('DROP TRIGGER refuse_attempt_settlement');
    const attempts = coreDb.sqlite
      .prepare('SELECT * FROM notification_delivery_attempts ORDER BY id')
      .all();
    // Inject one unsupported core value after valid owner setup. The native
    // operation must refuse the complete affected set, with no Main fallback.
    coreDb.sqlite.pragma('ignore_check_constraints = ON');
    coreDb.sqlite
      .prepare('UPDATE notification_attention SET channel = ? WHERE id = ?')
      .run('slack', references[1]!.id);
    coreDb.sqlite.pragma('query_only = ON');
    const restartTime = '2026-10-18T09:00:00.000Z';
    const restartClock = vi.fn(() => restartTime);
    const restarted = new AttentionNotifications(coreDb.sqlite, {
      nativeCoreDb: coreDb,
      now: restartClock,
    });
    await expect(restarted.reconcileIncompleteAttempts()).rejects.toThrow(
      'attention_recovery_required'
    );
    expect(
      coreDb.sqlite.prepare('SELECT * FROM notification_delivery_attempts ORDER BY id').all()
    ).toEqual(attempts);
    const clockFailure = new Error('simulated unavailable startup clock');
    const invalidClock = new AttentionNotifications(coreDb.sqlite, {
      nativeCoreDb: coreDb,
      now: () => {
        throw clockFailure;
      },
    });
    await expect(invalidClock.reconcileIncompleteAttempts()).rejects.toThrow(
      'attention_recovery_required'
    );

    coreDb.sqlite.pragma('query_only = OFF');
    coreDb.sqlite
      .prepare('UPDATE notification_attention SET channel = ? WHERE id = ?')
      .run('discord', references[1]!.id);
    coreDb.sqlite.pragma('query_only = ON');
    await expect(invalidClock.reconcileIncompleteAttempts()).rejects.toBe(clockFailure);
    expect(
      coreDb.sqlite.prepare('SELECT * FROM notification_delivery_attempts ORDER BY id').all()
    ).toEqual(attempts);
    restartClock.mockClear();
    reconciliationAck.hold = true;
    const committed = new Promise<void>((resolve) => {
      reconciliationAck.arrived = resolve;
    });
    let resolved = false;
    const reconciliation = restarted.reconcileIncompleteAttempts().then((count) => {
      resolved = true;
      return count;
    });
    try {
      await Promise.race([
        committed,
        reconciliation.then(() => {
          throw new Error('Reconciliation resolved before its native ACK was observed.');
        }),
      ]);
      const cold = new Database(coreDb.sqlite.name, { readonly: true });
      dbs.push(cold);
      const observer = new AttentionNotifications(cold);
      for (const reference of references) {
        expect(observer.get(reference.id)).toMatchObject({
          status: 'delivery-unknown',
          attempt: { failureCode: 'restart', finishedAt: restartTime, startedAt: now() },
        });
      }
      expect(coreDb.sqlite.pragma('query_only', { simple: true })).toBe(1);
      expect(restartClock).toHaveBeenCalledTimes(1);
      expect(resolved).toBe(false);
      expect(transport).toHaveBeenCalledTimes(2);
      reconciliationAck.hold = false;
      reconciliationAck.release!();
      reconciliationAck.release = undefined;
      await expect(reconciliation).resolves.toBe(2);
      expect(await restarted.reconcileIncompleteAttempts()).toBe(0);
    } finally {
      reconciliationAck.hold = false;
      reconciliationAck.release?.();
      reconciliationAck.release = undefined;
      await reconciliation;
    }
  });

  it('uses the injected App route and refuses an external link before contact', async () => {
    const { sqlite, delivery } = await fixture();
    const transport = vi.fn<AttentionTransport>().mockResolvedValue({ status: 'sent' });
    const notifications = new AttentionNotifications(sqlite, {
      now,
      buildAppPath: () => 'https://external.invalid/private',
    });
    await expect(
      notifications.deliver(
        {
          deliveryId: delivery.id,
          recipientUserId: aliceId,
          channel: 'discord',
          expectedAttemptId: null,
        },
        { isEligible: () => true, transport }
      )
    ).rejects.toThrow('invalid_attention_input');
    expect(transport).not.toHaveBeenCalled();
    const conversation = new AttentionNotifications(sqlite, {
      now,
      buildAppPath: (exact) =>
        `/chat/${exact.workspaceId}/${exact.threadId}?requestId=${exact.requestId}`,
    });
    await conversation.deliver(
      {
        deliveryId: delivery.id,
        recipientUserId: aliceId,
        channel: 'discord',
        expectedAttemptId: 1,
        retry: true,
      },
      { isEligible: () => true, transport }
    );
    expect(transport).toHaveBeenCalledWith({
      kind: 'attention-link',
      deliveryId: delivery.id,
      appPath: `/chat/${source.workspaceId}/${source.threadId}?requestId=apr_exact`,
    });
  });

  it('refuses a contradictory history instead of retrying a prior unknown send', async () => {
    const { sqlite, notifications, delivery } = await fixture();
    await notifications.deliver(
      {
        deliveryId: delivery.id,
        recipientUserId: aliceId,
        channel: 'discord',
        expectedAttemptId: null,
      },
      { isEligible: () => true, transport: async () => ({ status: 'delivery-unknown' }) }
    );
    sqlite
      .prepare(`INSERT INTO notification_delivery_attempts (attention_id, channel, status, failure_code, started_at, finished_at)
      VALUES (?, 'discord', 'failed-no-send', 'transport-refused', ?, ?)`)
      .run(delivery.id, now(), now());
    const transport = vi.fn<AttentionTransport>();
    await expect(
      notifications.deliver(
        {
          deliveryId: delivery.id,
          recipientUserId: aliceId,
          channel: 'discord',
          expectedAttemptId: 2,
          retry: true,
        },
        { isEligible: () => true, transport }
      )
    ).rejects.toThrow('attention_recovery_required');
    expect(transport).not.toHaveBeenCalled();
  });

  it('fails closed on unknown retained core values without transport', async () => {
    const { sqlite, notifications, delivery } = await fixture();
    sqlite.pragma('ignore_check_constraints = ON');
    sqlite
      .prepare('UPDATE notification_attention SET channel = ? WHERE id = ?')
      .run('slack', delivery.id);
    const transport = vi.fn<AttentionTransport>();
    await expect(
      notifications.deliver(
        {
          deliveryId: delivery.id,
          recipientUserId: aliceId,
          expectedAttemptId: null,
          channel: 'discord',
        },
        { isEligible: () => true, transport }
      )
    ).rejects.toThrow('attention_recovery_required');
    expect(transport).not.toHaveBeenCalled();
    expect(notifications.getForActor(delivery.id, bobId, () => true)).toBeNull();
    await expect(
      notifications.deliver(
        {
          deliveryId: delivery.id,
          recipientUserId: bobId,
          channel: 'discord',
          expectedAttemptId: null,
        },
        { isEligible: () => true, transport }
      )
    ).rejects.toThrow('attention_not_found');
  });

  it('paginates notification.list with an opaque recipient-scoped cursor and rejects foreign cursors', async () => {
    const { notifications } = await fixture();
    for (let index = 0; index < 3; index++) {
      await notifications.enqueue({
        source: { ...source, requestId: `apr_page_${index}` },
        recipientUserId: aliceId,
      });
    }
    const operations = createChannelOperationImplementations({
      notifications,
      readableDelivery: () => true,
      attentionPath: (exact) =>
        `/tasks/${exact.workspaceId}/${exact.threadId}?requestId=${exact.requestId}`,
    } as unknown as ChannelServices);
    const aliceContext = {
      actor: { kind: 'session' as const, userId: aliceId },
      actorRef: { kind: 'user' as const, id: aliceId },
    };
    const bobContext = {
      actor: { kind: 'session' as const, userId: bobId },
      actorRef: { kind: 'user' as const, id: bobId },
    };

    const page1 = operations['notification.list']({ limit: 2 }, aliceContext);
    expect(page1.items).toHaveLength(2);
    expect(typeof page1.nextCursor).toBe('string');

    const page2 = operations['notification.list'](
      { limit: 2, cursor: page1.nextCursor! },
      aliceContext
    );
    expect(page2.items).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();

    expect(() => operations['notification.list']({ cursor: 'not-a-cursor' }, aliceContext)).toThrow(
      'Invalid notification continuation.'
    );
    expect(() =>
      operations['notification.list']({ cursor: page1.nextCursor! }, bobContext)
    ).toThrow('Invalid notification continuation.');
  });
});

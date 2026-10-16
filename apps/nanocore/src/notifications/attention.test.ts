import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ATTENTION_SCHEMA_SQL,
  AttentionNotifications,
  type AttentionSource,
  type AttentionTransport,
} from './attention.js';

const source: AttentionSource = {
  workspaceId: 'ws_attention',
  threadId: 'th_private',
  kind: 'approval-request',
  requestId: 'apr_exact',
};
const now = () => '2026-10-16T12:00:00.000Z';
const dbs: Database.Database[] = [];
const directories: string[] = [];

function fixture(path = ':memory:') {
  const sqlite = new Database(path);
  dbs.push(sqlite);
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(ATTENTION_SCHEMA_SQL);
  const notifications = new AttentionNotifications(sqlite, { now });
  const delivery = notifications.enqueue({ source, recipientUserId: 'user_alice' });
  return { sqlite, notifications, delivery };
}

afterEach(() => {
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

  it('deduplicates the exact source and recipient and preserves other identities', () => {
    const { notifications, delivery } = fixture();
    expect(notifications.enqueue({ source, recipientUserId: 'user_alice' })).toEqual(delivery);
    for (const changed of [
      { source, recipientUserId: 'user_bob' },
      { source: { ...source, requestId: 'apr_other' }, recipientUserId: 'user_alice' },
      { source: { ...source, threadId: 'th_other' }, recipientUserId: 'user_alice' },
      { source: { ...source, workspaceId: 'ws_other' }, recipientUserId: 'user_alice' },
      {
        source: { ...source, kind: 'user-input-request' as const },
        recipientUserId: 'user_alice',
      },
    ]) {
      expect(notifications.enqueue(changed).id).not.toBe(delivery.id);
    }
  });

  it('bounds recipient reads and applies current source and audience admission', () => {
    const { notifications, delivery } = fixture();
    notifications.enqueue({ source, recipientUserId: 'user_bob' });
    for (let index = 0; index < 4; index++) {
      notifications.enqueue({
        source: { ...source, requestId: `apr_${index}` },
        recipientUserId: 'user_alice',
      });
    }
    const eligible = vi.fn(() => true);
    expect(notifications.listForActor('user_alice', { limit: 2 }, eligible)).toHaveLength(2);
    expect(eligible).toHaveBeenCalledTimes(2);
    expect(notifications.listForActor('user_alice', { limit: 2 }, () => false)).toEqual([]);
    expect(notifications.getForActor(delivery.id, 'user_bob', eligible)).toBeNull();
    expect(notifications.getForActor(delivery.id, 'user_alice', () => false)).toBeNull();
    expect(notifications.getForActor(delivery.id, 'user_alice', () => true)).toEqual(delivery);
    for (const limit of [0, 101, 1.5]) {
      expect(() => notifications.listForActor('user_alice', { limit }, eligible)).toThrow(
        'invalid_attention_input'
      );
    }
  });

  it('rejects malformed identities and captured source arguments at admission', () => {
    const { notifications } = fixture();
    for (const input of [
      { source: { ...source, workspaceId: 'bad' }, recipientUserId: 'user_alice' },
      { source: { ...source, threadId: 'bad' }, recipientUserId: 'user_alice' },
      { source, recipientUserId: 'bad' },
      { source: { ...source, arguments: { private: 'content' } }, recipientUserId: 'user_alice' },
    ]) {
      expect(() => notifications.enqueue(input)).toThrow('invalid_attention_input');
    }
  });

  it('claims durably before synchronous authority admission and sends only the App link', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'attention-claim-'));
    directories.push(directory);
    const path = join(directory, 'core.sqlite');
    const { notifications, delivery } = fixture(path);
    const observerDb = new Database(path);
    dbs.push(observerDb);
    const observer = new AttentionNotifications(observerDb);
    const events: string[] = [];
    const result = await notifications.deliver(
      {
        deliveryId: delivery.id,
        recipientUserId: 'user_alice',
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
            appPath: '/tasks/ws_attention/th_private?requestId=apr_exact',
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
    expect(notifications.enqueue({ source, recipientUserId: 'user_alice' })).toEqual(result);
  });

  it('makes no contact after authority loss or admission dependency failure', async () => {
    const { notifications, delivery } = fixture();
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
            recipientUserId: 'user_alice',
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
    const { notifications, delivery } = fixture();
    const input = {
      deliveryId: delivery.id,
      recipientUserId: 'user_alice',
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
    const { notifications, delivery } = fixture();
    const first = {
      deliveryId: delivery.id,
      recipientUserId: 'user_alice',
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

  it.each([
    'throw',
    'unknown',
    'invalid',
  ] as const)('keeps %s transport results unknown and prevents retry or channel fallback', async (mode) => {
    const { notifications, delivery } = fixture();
    const input = {
      deliveryId: delivery.id,
      expectedAttemptId: null,
      recipientUserId: 'user_alice',
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
  });

  it('refuses concurrent and wrong-recipient sends before any additional contact', async () => {
    const { sqlite, notifications, delivery } = fixture();
    const observer = new AttentionNotifications(sqlite);
    const input = {
      deliveryId: delivery.id,
      expectedAttemptId: null,
      recipientUserId: 'user_alice',
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
      observer.deliver({ ...input, recipientUserId: 'user_bob' }, dependencies)
    ).rejects.toThrow('attention_not_found');
    const pending = notifications.deliver(input, dependencies);
    await expect(observer.deliver(input, dependencies)).rejects.toThrow(
      'attention_attempt_conflict'
    );
    complete!({ status: 'sent' });
    expect((await pending).status).toBe('sent');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('reopens persisted unfinished claims as unknown without retry or a Core request mutation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'attention-restart-'));
    directories.push(directory);
    const path = join(directory, 'core.sqlite');
    const { sqlite, notifications, delivery } = fixture(path);
    sqlite.exec(
      "CREATE TABLE test_core_request (state TEXT); INSERT INTO test_core_request VALUES ('pending')"
    );
    const input = {
      deliveryId: delivery.id,
      expectedAttemptId: null,
      recipientUserId: 'user_alice',
      channel: 'discord' as const,
    };
    sqlite.exec(`CREATE TRIGGER refuse_attempt_settlement BEFORE UPDATE ON notification_delivery_attempts
      BEGIN SELECT RAISE(ABORT, 'simulated lost settlement'); END`);
    const transport = vi.fn<AttentionTransport>().mockResolvedValue({ status: 'sent' });
    await expect(
      notifications.deliver(input, { isEligible: () => true, transport })
    ).rejects.toThrow('simulated lost settlement');
    expect(notifications.get(delivery.id)?.status).toBe('sending');
    sqlite.exec('DROP TRIGGER refuse_attempt_settlement');
    sqlite.close();
    const reopened = new Database(path);
    dbs.push(reopened);
    const restarted = new AttentionNotifications(reopened, { now });
    expect(restarted.reconcileIncompleteAttempts()).toBe(1);
    expect(restarted.reconcileIncompleteAttempts()).toBe(0);
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
    expect(transport).toHaveBeenCalledTimes(1);
    expect(reopened.prepare('SELECT state FROM test_core_request').all()).toEqual([
      { state: 'pending' },
    ]);
  });

  it('uses the injected App route and refuses an external link before contact', async () => {
    const { sqlite, delivery } = fixture();
    const transport = vi.fn<AttentionTransport>().mockResolvedValue({ status: 'sent' });
    const notifications = new AttentionNotifications(sqlite, {
      now,
      buildAppPath: () => 'https://external.invalid/private',
    });
    await expect(
      notifications.deliver(
        {
          deliveryId: delivery.id,
          recipientUserId: 'user_alice',
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
        recipientUserId: 'user_alice',
        channel: 'discord',
        expectedAttemptId: 1,
        retry: true,
      },
      { isEligible: () => true, transport }
    );
    expect(transport).toHaveBeenCalledWith({
      kind: 'attention-link',
      deliveryId: delivery.id,
      appPath: '/chat/ws_attention/th_private?requestId=apr_exact',
    });
  });

  it('refuses a contradictory history instead of retrying a prior unknown send', async () => {
    const { sqlite, notifications, delivery } = fixture();
    await notifications.deliver(
      {
        deliveryId: delivery.id,
        recipientUserId: 'user_alice',
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
          recipientUserId: 'user_alice',
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
    const { sqlite, notifications, delivery } = fixture();
    sqlite.pragma('ignore_check_constraints = ON');
    sqlite
      .prepare('UPDATE notification_attention SET channel = ? WHERE id = ?')
      .run('slack', delivery.id);
    const transport = vi.fn<AttentionTransport>();
    await expect(
      notifications.deliver(
        {
          deliveryId: delivery.id,
          recipientUserId: 'user_alice',
          expectedAttemptId: null,
          channel: 'discord',
        },
        { isEligible: () => true, transport }
      )
    ).rejects.toThrow('attention_recovery_required');
    expect(transport).not.toHaveBeenCalled();
    expect(notifications.getForActor(delivery.id, 'user_bob', () => true)).toBeNull();
    await expect(
      notifications.deliver(
        {
          deliveryId: delivery.id,
          recipientUserId: 'user_bob',
          channel: 'discord',
          expectedAttemptId: null,
        },
        { isEligible: () => true, transport }
      )
    ).rejects.toThrow('attention_not_found');
  });
});

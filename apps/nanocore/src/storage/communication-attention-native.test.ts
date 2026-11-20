import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allocateEntityId } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimAttentionAttemptInDb, enqueueAttentionInDb } from '../notifications/attention.js';
import {
  observePublishedCommunicationAttention,
  sendCommunicationAttention,
} from './communication-attention.js';
import { readCommunicationBinding } from './communication-pairing-native.js';
import {
  applyCommunicationWriterCommand,
  type CommunicationWriterCommand,
  CommunicationWriterReplySchema,
} from './communication-writer.js';
import { configureOwnedSqlite } from './control-store.js';

const now = Date.parse('2026-11-20T10:00:00.000Z');
const userId = allocateEntityId('usr');
const workspaceId = allocateEntityId('ws');
const threadId = allocateEntityId('th');
const bindingRevision = randomUUID();
const clock = () => new Date(now).toISOString();

describe('communication Attention writer', () => {
  let root: string;
  let sqlite: Database.Database;

  function open() {
    const connection = new Database(join(root, 'state.sqlite'));
    configureOwnedSqlite(connection);
    return connection;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'communication-attention-'));
    sqlite = open();
    migrate(drizzle(sqlite), {
      migrationsFolder: fileURLToPath(
        new URL('../../drizzle/services/communication/', import.meta.url)
      ),
    });
    sqlite
      .prepare(`
        INSERT INTO channel_account_bindings(revision,channel_kind,external_account_id,user_id,paired_at)
        VALUES (?, 'discord', '302', ?, ?)
      `)
      .run(bindingRevision, userId, now);
  });

  afterEach(() => {
    if (sqlite.open) sqlite.close();
    rmSync(root, { force: true, recursive: true });
  });

  function enqueue(kind: 'approval-request' | 'security-notice' = 'approval-request') {
    return enqueueAttentionInDb(
      sqlite,
      { source: { workspaceId, threadId, kind, requestId: 'apr_exact' }, recipientUserId: userId },
      clock
    );
  }

  function write(command: CommunicationWriterCommand, milliseconds = now) {
    return CommunicationWriterReplySchema.parse(
      applyCommunicationWriterCommand(sqlite, 'attention-fixture', command, () => milliseconds)
    );
  }

  function claim(deliveryId: string) {
    return {
      deliveryId,
      recipientUserId: userId,
      channel: 'discord',
      expectedAttemptId: null,
      bindingRevision,
    } as const;
  }

  function sender(deliveryId: string) {
    const send = vi.fn<Parameters<typeof sendCommunicationAttention>[0]['send']>(async () => ({
      status: 'sent',
      externalMessageId: '501',
    }));
    const options: Parameters<typeof sendCommunicationAttention>[0] = {
      selection: { deliveryId, recipientUserId: userId, expectedAttemptId: null },
      withBinding: async (_user, effect) => effect(),
      readBinding: (user) => ({ state: 'ready', value: readCommunicationBinding(sqlite, user) }),
      isEligible: () => true,
      buildAppPath: () => '/tasks/fixture',
      send,
      now: clock,
      writer: {
        claim: async (input) => {
          const result = write({ stage: 'claim-attention', input });
          if (result.stage !== 'claim-attention') throw new Error('Expected the original claim.');
          return { state: 'ready', value: result.delivery };
        },
        settle: async (input) => {
          write({ stage: 'settle-attention', input });
          return { state: 'ready', value: undefined };
        },
      },
    };
    return { options, send };
  }

  it('enqueues only a current published source and keeps the original source/recipient row on replay', async () => {
    const record = {
      workspaceId,
      threadId,
      requestId: 'apr_published',
      responsibleUserId: userId,
      kind: 'approval',
      state: 'pending',
      requesterKind: 'person',
    } as const;
    let current = false;
    const enqueue = vi.fn<Parameters<typeof observePublishedCommunicationAttention>[1]['enqueue']>(
      async (input) => {
        const result = write({ stage: 'enqueue-attention', input });
        if (result.stage !== 'enqueue-attention')
          throw new Error('Expected enqueue acknowledgement.');
        return { state: 'ready', value: result.delivery };
      }
    );
    const dependencies = { isCurrent: () => current, enqueue };

    expect(await observePublishedCommunicationAttention(record, dependencies)).toEqual({
      state: 'ready',
      value: null,
    });
    expect(enqueue).not.toHaveBeenCalled();

    current = true;
    const original = await observePublishedCommunicationAttention(record, dependencies);
    expect(original).toMatchObject({
      state: 'ready',
      value: { recipientUserId: userId, source: { requestId: record.requestId }, status: 'queued' },
    });
    expect(await observePublishedCommunicationAttention(record, dependencies)).toEqual(original);
    expect(
      await observePublishedCommunicationAttention(
        { ...record, requesterKind: 'automation' },
        dependencies
      )
    ).toEqual({ state: 'ready', value: null });
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(sqlite.prepare('SELECT count(*) FROM notification_attention').pluck().get()).toBe(1);
  });

  it('makes no transport contact until its exact claim is acknowledged', async () => {
    const { id } = enqueue();
    const { options, send } = sender(id);
    const committed = Promise.withResolvers<void>();
    const acknowledge = Promise.withResolvers<void>();
    const operation = sendCommunicationAttention({
      ...options,
      writer: {
        ...options.writer,
        claim: async (input) => {
          await options.writer.claim(input);
          committed.resolve();
          await acknowledge.promise;
          return { state: 'unavailable', owner: 'communication', reason: 'recovery-required' };
        },
      },
    });
    await Promise.race([committed.promise, operation]);
    expect(send).not.toHaveBeenCalled();
    acknowledge.resolve();
    await expect(operation).rejects.toMatchObject({ code: 'channel_storage_unavailable' });
    expect(send).not.toHaveBeenCalled();
  });

  it('rechecks the current binding after asynchronous Discord preparation', async () => {
    const { id } = enqueue();
    const { options, send } = sender(id);
    const prepared = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const message = vi.fn();
    send.mockImplementationOnce(async ({ beforeSend }) => {
      prepared.resolve();
      await release.promise;
      if (!beforeSend()) return { status: 'failed-no-send', code: 'discord_recipient_unavailable' };
      message();
      return { status: 'sent', externalMessageId: '501' };
    });

    const operation = sendCommunicationAttention(options);
    await Promise.race([prepared.promise, operation]);
    sqlite
      .prepare('UPDATE channel_account_bindings SET revoked_at = ? WHERE revision = ?')
      .run(now, bindingRevision);
    release.resolve();
    expect(await operation).toMatchObject({
      id,
      status: 'failed-no-send',
      attempt: { status: 'failed-no-send', failureCode: 'transport-refused' },
    });
    expect(message).not.toHaveBeenCalled();
  });

  it('retains an interrupted transport acknowledgement as unknown with zero retries', async () => {
    const { id } = enqueue();
    const { options, send } = sender(id);
    send.mockRejectedValueOnce(new Error('Transport acknowledgement lost.'));
    const delivery = await sendCommunicationAttention(options);
    expect(delivery).toMatchObject({
      id,
      status: 'delivery-unknown',
      attempt: { status: 'delivery-unknown', failureCode: 'transport-unknown' },
    });
    await expect(
      sendCommunicationAttention({
        ...options,
        selection: { ...options.selection, expectedAttemptId: delivery.attempt!.id, retry: true },
      })
    ).rejects.toThrow('attention_not_sendable');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps the recipient, binding revision, channel and predecessor checks at the durable claim', () => {
    const { id } = enqueue();
    const input = claim(id);
    expect(() =>
      write({ stage: 'claim-attention', input: { ...input, bindingRevision: randomUUID() } })
    ).toThrow('attention_not_eligible');
    const otherUser = allocateEntityId('usr');
    const otherRevision = randomUUID();
    sqlite
      .prepare(`
        INSERT INTO channel_account_bindings(revision,channel_kind,external_account_id,user_id,paired_at)
        VALUES (?, 'discord', '303', ?, ?)
      `)
      .run(otherRevision, otherUser, now);
    expect(() =>
      write({
        stage: 'claim-attention',
        input: { ...input, recipientUserId: otherUser, bindingRevision: otherRevision },
      })
    ).toThrow('attention_not_found');

    const result = write({ stage: 'claim-attention', input });
    expect(result).toMatchObject({
      stage: 'claim-attention',
      delivery: { id, recipientUserId: userId, channel: 'discord', status: 'sending' },
    });
    expect(() => write({ stage: 'claim-attention', input })).toThrow('attention_attempt_conflict');
    expect(
      sqlite.prepare('SELECT count(*) FROM notification_delivery_attempts').pluck().get()
    ).toBe(1);
  });

  it('keeps the previously claimed channel frozen', () => {
    const { id } = enqueue();
    const previous = claimAttentionAttemptInDb(
      sqlite,
      { deliveryId: id, recipientUserId: userId, channel: 'email', expectedAttemptId: null },
      clock
    );
    expect(() =>
      write({
        stage: 'claim-attention',
        input: { ...claim(id), expectedAttemptId: previous.attempt!.id },
      })
    ).toThrow('attention_channel_conflict');
  });

  it('reconciles an unacknowledged claim to unknown after reopen and never grants a retry', () => {
    const { id } = enqueue();
    const input = claim(id);
    const original = write({ stage: 'claim-attention', input });
    if (original.stage !== 'claim-attention') throw new Error('Expected the original claim.');
    const { id: attemptId } = original.delivery.attempt;
    const recoveredAt = now + 1_000;
    sqlite.close();
    sqlite = open();

    expect(write({ stage: 'reconcile-attention' }, recoveredAt)).toEqual({
      stage: 'reconcile-attention',
      changes: 1,
    });
    expect(() =>
      write({
        stage: 'claim-attention',
        input: { ...input, expectedAttemptId: attemptId, retry: true },
      })
    ).toThrow('attention_not_sendable');
    expect(() =>
      write({
        stage: 'settle-attention',
        input: {
          deliveryId: id,
          attemptId,
          status: 'sent',
          failureCode: null,
          finishedAt: new Date(recoveredAt).toISOString(),
        },
      })
    ).toThrow();
    expect(
      sqlite
        .prepare('SELECT id,status,failure_code AS reason FROM notification_delivery_attempts')
        .all()
    ).toEqual([{ id: attemptId, status: 'delivery-unknown', reason: 'restart' }]);
  });

  it('acknowledges only the selected attempt and permits explicit retry after definite no-send', () => {
    const { id } = enqueue();
    const input = claim(id);
    const original = write({ stage: 'claim-attention', input });
    if (original.stage !== 'claim-attention') throw new Error('Expected the original claim.');
    const { id: attemptId } = original.delivery.attempt;
    const completion = {
      deliveryId: id,
      attemptId,
      status: 'failed-no-send',
      failureCode: 'transport-refused',
      finishedAt: clock(),
    } as const;

    expect(() =>
      write({ stage: 'settle-attention', input: { ...completion, attemptId: attemptId + 1 } })
    ).toThrow();
    expect(write({ stage: 'settle-attention', input: completion })).toEqual({
      stage: 'settle-attention',
    });
    expect(write({ stage: 'settle-attention', input: completion })).toEqual({
      stage: 'settle-attention',
    });
    expect(() =>
      write({ stage: 'claim-attention', input: { ...input, expectedAttemptId: attemptId } })
    ).toThrow();
    const retried = write({
      stage: 'claim-attention',
      input: { ...input, expectedAttemptId: attemptId, retry: true },
    });
    if (retried.stage !== 'claim-attention') throw new Error('Expected a new attempt.');
    expect(retried.delivery.attempt.id).toBeGreaterThan(attemptId);
  });

  it('rolls back any security-notice claim while the B3 publisher remains disabled', () => {
    const { id } = enqueue('security-notice');
    expect(() => write({ stage: 'claim-attention', input: claim(id) })).toThrow();
    expect(
      sqlite.prepare('SELECT channel FROM notification_attention WHERE id = ?').pluck().get(id)
    ).toBeNull();
    expect(
      sqlite.prepare('SELECT count(*) FROM notification_delivery_attempts').pluck().get()
    ).toBe(0);
  });
});

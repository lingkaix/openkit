import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { isRecord } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttentionNotifications } from '../notifications/attention.js';
import { testEntityId } from '../test-support/entity-ids.js';
import {
  type ControlAttentionAttemptCompletion,
  ControlAttentionAttemptCompletionSchema,
} from './attention-attempt-completion-codecs.js';
import { applyControlAttentionAttemptCompletion } from './attention-attempt-completion-native.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { isControlWorkerRequest } from './control-store-worker-protocol.js';
import { type CoreDb, openCoreDb } from './db.js';
import { applyNativeScopeMigrations } from './migrate.js';

// Reuse the real SQLite Worker and hold only
// its genuine post-commit completion ACK. No fake SQL result or reply is made.
const fault = vi.hoisted(() => ({
  hold: false,
  arrived: undefined as (() => void) | undefined,
  release: undefined as (() => void) | undefined,
  worker: undefined as NativeWorker | undefined,
  posts: [] as string[],
  requests: [] as number[],
  acknowledgements: 0,
}));

vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      override postMessage(...args: Parameters<NativeWorker['postMessage']>) {
        const message: unknown = args[0];
        if (isControlWorkerRequest(message)) {
          fault.posts.push(message.operation);
          if (message.operation === 'attention-attempt-completion') {
            fault.requests.push(message.id);
            fault.worker = this;
          }
        }
        return super.postMessage(...args);
      }
      override emit(event: string | symbol, ...args: unknown[]): boolean {
        const reply = args[0];
        if (
          event === 'message' &&
          isRecord(reply) &&
          reply.status === 'ok' &&
          reply.operation === 'attention-attempt-completion' &&
          fault.requests.includes(reply.id as number)
        ) {
          if (fault.hold) {
            fault.release = () => {
              fault.acknowledgements += 1;
              return super.emit(event, ...args);
            };
            fault.arrived?.();
            return true;
          }
          fault.acknowledgements += 1;
        }
        return super.emit(event, ...args);
      }
    },
  };
});

const finishedAt = '2026-11-05T06:00:00.000Z';
const recipientUserId = testEntityId('usr', 'completion-recipient');
const roots: string[] = [];
const databases: Database.Database[] = [];
const pending: Promise<unknown>[] = [];

function track<T>(promise: Promise<T>): Promise<T> {
  pending.push(promise);
  // Cleanup bookkeeping must not create an unhandled rejection while a gate is
  // inspected. Each test still asserts the unchanged original promise below.
  void promise.then(
    () => undefined,
    () => undefined
  );
  return promise;
}

function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-attention-completion-'));
  roots.push(dataRoot);
  const coreDb: CoreDb = openCoreDb(dataRoot);
  databases.push(coreDb.sqlite);
  applyNativeScopeMigrations(coreDb.sqlite, 'core');
  const options = {
    nativeCoreDb: coreDb,
    now: () => finishedAt,
    buildAppPath: () => '/tasks/completion?requestId=apr_completion_owner',
  };
  const notifications = new AttentionNotifications(coreDb.sqlite, options);
  const delivery = notifications.enqueue({
    source: {
      workspaceId: testEntityId('ws', 'completion-owner'),
      threadId: testEntityId('th', 'completion-owner'),
      kind: 'approval-request',
      requestId: 'apr_completion_owner',
    },
    recipientUserId,
  });
  return { coreDb, notifications, delivery, options };
}

type Fixture = ReturnType<typeof fixture>;

function cold(coreDb: CoreDb) {
  const reader = new Database(coreDb.sqlite.name, { readonly: true });
  databases.push(reader);
  return reader;
}

function outcome(f: Fixture) {
  return cold(f.coreDb)
    .prepare(
      'SELECT status, failure_code AS failureCode, finished_at AS finishedAt FROM notification_delivery_attempts WHERE attention_id = ?'
    )
    .get(f.delivery.id) as {
    status: string;
    failureCode: string | null;
    finishedAt: string | null;
  };
}

function count(f: Fixture) {
  return cold(f.coreDb)
    .prepare('SELECT COUNT(*) AS count FROM notification_delivery_attempts WHERE attention_id = ?')
    .get(f.delivery.id) as { count: number };
}

function input(f: Fixture): ControlAttentionAttemptCompletion {
  const active = f.notifications.get(f.delivery.id)!;
  if (!active.attempt) throw new Error('The original sending claim must exist.');
  return {
    deliveryId: f.delivery.id,
    attemptId: active.attempt.id,
    status: 'sent',
    failureCode: null,
    finishedAt,
  };
}

function send(
  f: Fixture,
  transport: () => Promise<{ status: 'sent' | 'failed-no-send' | 'delivery-unknown' }>
) {
  return track(
    f.notifications.deliver(
      {
        deliveryId: f.delivery.id,
        recipientUserId,
        channel: 'discord',
        retry: false,
        expectedAttemptId: null,
      },
      { isEligible: () => true, transport }
    )
  );
}

function holdAcknowledgement() {
  fault.hold = true;
  return new Promise<void>((resolve) => {
    fault.arrived = resolve;
  });
}

beforeEach(async () => {
  await shutdownControlStoreWorkerClient();
  fault.hold = false;
  fault.arrived = undefined;
  fault.release = undefined;
  fault.worker = undefined;
  fault.posts.length = 0;
  fault.requests.length = 0;
  fault.acknowledgements = 0;
});

afterEach(async () => {
  fault.hold = false;
  fault.release?.();
  fault.release = undefined;
  await Promise.allSettled(pending.splice(0));
  try {
    await shutdownControlStoreWorkerClient();
  } finally {
    for (const sqlite of databases.splice(0).reverse()) if (sqlite.open) sqlite.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }
});

describe('native Attention attempt completion', () => {
  it('commits the original completion after transport with Main readonly', async () => {
    const f = fixture();
    let sends = 0;
    const result = send(f, async () => {
      sends += 1;
      expect(f.notifications.get(f.delivery.id)?.status).toBe('sending');
      f.coreDb.sqlite.pragma('query_only = ON');
      return { status: 'sent' };
    });
    await expect(result).resolves.toMatchObject({
      id: f.delivery.id,
      status: 'sent',
      attempt: { status: 'sent', failureCode: null },
    });
    expect(sends).toBe(1);
    expect(outcome(f)).toEqual({ status: 'sent', failureCode: null, finishedAt });
    expect(count(f).count).toBe(1);
    expect(fault.requests).toHaveLength(1);
    expect(fault.acknowledgements).toBe(1);
  });

  it.each(['failed-no-send', 'delivery-unknown', 'throw', 'malformed'] as const)(
    'records the original transport outcome %s without a Main completion write',
    async (mode) => {
      const f = fixture();
      let sends = 0;
      const result = send(f, async () => {
        sends += 1;
        f.coreDb.sqlite.pragma('query_only = ON');
        if (mode === 'throw') throw new Error('Adapter acknowledgement unavailable.');
        if (mode === 'malformed') return { status: 'not-an-outcome' as 'sent' };
        return { status: mode };
      });
      const status = mode === 'failed-no-send' ? 'failed-no-send' : 'delivery-unknown';
      const failureCode = mode === 'failed-no-send' ? 'transport-refused' : 'transport-unknown';
      await expect(result).resolves.toMatchObject({ status, attempt: { status, failureCode } });
      expect(outcome(f)).toEqual({ status, failureCode, finishedAt });
      expect(sends).toBe(1);
      expect(fault.requests).toHaveLength(1);
      expect(count(f).count).toBe(1);
    }
  );

  it.each(['sent', 'invalid-path', 'ineligible'] as const)(
    'waits for the actual native completion ACK before publishing %s',
    async (mode) => {
      const f = fixture();
      const arrived = holdAcknowledgement();
      let sends = 0;
      if (mode === 'invalid-path')
        f.options.buildAppPath = () => {
          f.coreDb.sqlite.pragma('query_only = ON');
          return 'https://outside.invalid/';
        };
      const result = track(
        f.notifications.deliver(
          {
            deliveryId: f.delivery.id,
            recipientUserId,
            channel: 'discord',
            retry: false,
            expectedAttemptId: null,
          },
          {
            isEligible: () => {
              if (mode === 'ineligible') f.coreDb.sqlite.pragma('query_only = ON');
              return mode !== 'ineligible';
            },
            transport: async () => {
              sends += 1;
              f.coreDb.sqlite.pragma('query_only = ON');
              return { status: 'sent' };
            },
          }
        )
      );
      let settled = false;
      void result.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      await arrived;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(fault.acknowledgements).toBe(0);
      const status = mode === 'sent' ? 'sent' : 'failed-no-send';
      const failureCode =
        mode === 'sent'
          ? null
          : mode === 'invalid-path'
            ? 'transport-refused'
            : 'authority-unavailable';
      expect(outcome(f)).toEqual({ status, failureCode, finishedAt });
      expect(sends).toBe(mode === 'sent' ? 1 : 0);
      fault.hold = false;
      fault.release?.();
      fault.release = undefined;
      if (mode === 'sent') await expect(result).resolves.toMatchObject({ status: 'sent' });
      else
        await expect(result).rejects.toMatchObject({
          code: mode === 'invalid-path' ? 'invalid_attention_input' : 'attention_not_eligible',
        });
      expect(fault.requests).toHaveLength(1);
      expect(fault.acknowledgements).toBe(1);
    }
  );

  it('leaves the original sending attempt intact on a real native SQL rollback', async () => {
    const f = fixture();
    f.coreDb.sqlite.exec(`CREATE TRIGGER reject_attention_completion
      BEFORE UPDATE ON notification_delivery_attempts
      BEGIN SELECT RAISE(ABORT, 'completion-rejected'); END`);
    let sends = 0;
    await expect(
      send(f, async () => {
        sends += 1;
        f.coreDb.sqlite.pragma('query_only = ON');
        return { status: 'sent' };
      })
    ).rejects.toMatchObject({ commit: 'not-committed' });
    expect(outcome(f)).toEqual({ status: 'sending', failureCode: null, finishedAt: null });
    expect(count(f).count).toBe(1);
    expect(sends).toBe(1);
    expect(fault.requests).toHaveLength(1);
    expect(fault.acknowledgements).toBe(0);
  });

  it('does not publish, fallback or repost after a genuine committed ACK is lost', async () => {
    const f = fixture();
    const arrived = holdAcknowledgement();
    let sends = 0;
    const result = send(f, async () => {
      sends += 1;
      f.coreDb.sqlite.pragma('query_only = ON');
      return { status: 'sent' };
    });
    await arrived;
    expect(outcome(f)).toEqual({ status: 'sent', failureCode: null, finishedAt });
    fault.release = undefined;
    const worker = fault.worker;
    if (!worker) throw new Error('The real completion Worker must have posted.');
    await worker.terminate();
    await expect(result).rejects.toMatchObject({ commit: 'unknown' });
    expect(fault.requests).toHaveLength(1);
    expect(fault.acknowledgements).toBe(0);
    expect(sends).toBe(1);
    // Claim inspection now needs a live native owner. Recreate it explicitly
    // for this durable retry fence; production never retries the lost command.
    await shutdownControlStoreWorkerClient();
    await expect(
      f.notifications.deliver(
        {
          deliveryId: f.delivery.id,
          recipientUserId,
          channel: 'discord',
          retry: true,
          expectedAttemptId: input(f).attemptId,
        },
        {
          isEligible: () => true,
          transport: async () => {
            sends += 1;
            return { status: 'sent' };
          },
        }
      )
    ).rejects.toMatchObject({ code: 'attention_not_sendable' });
    expect(sends).toBe(1);
    expect(fault.requests).toHaveLength(1);
    expect(fault.acknowledgements).toBe(0);
    expect(count(f).count).toBe(1);
    expect(outcome(f)).toEqual({ status: 'sent', failureCode: null, finishedAt });
  });

  it.each(['connection', 'path', 'scope'] as const)(
    'refuses a mismatched physical Core %s before native open/post',
    async (mode) => {
      const f = fixture();
      const other = fixture();
      let sends = 0;
      let postsBefore: string[] = [];
      await expect(
        send(f, async () => {
          // Keep this completion-stage probe after the genuine native claim.
          postsBefore = fault.posts.slice();
          f.options.nativeCoreDb =
            mode === 'connection'
              ? other.coreDb
              : mode === 'path'
                ? { ...f.coreDb, dataRoot: other.coreDb.dataRoot }
                : ({ ...f.coreDb, scope: 'workspace' } as unknown as CoreDb);
          sends += 1;
          f.coreDb.sqlite.pragma('query_only = ON');
          return { status: 'sent' };
        })
      ).rejects.toMatchObject({ code: 'invalid-request', commit: 'not-committed' });
      expect(sends).toBe(1);
      expect(fault.posts).toEqual(postsBefore);
      expect(outcome(f)).toEqual({ status: 'sending', failureCode: null, finishedAt: null });
      expect(count(other).count).toBe(0);
      expect(other.notifications.get(other.delivery.id)?.status).toBe('queued');
    }
  );

  it('keeps the original sending predicate when startup reconciliation wins first', async () => {
    const f = fixture();
    await expect(
      send(f, async () => {
        expect(f.notifications.reconcileIncompleteAttempts()).toBe(1);
        f.coreDb.sqlite.pragma('query_only = ON');
        return { status: 'sent' };
      })
    ).resolves.toMatchObject({ status: 'delivery-unknown', attempt: { failureCode: 'restart' } });
    expect(outcome(f)).toEqual({ status: 'delivery-unknown', failureCode: 'restart', finishedAt });
    expect(count(f).count).toBe(1);
    expect(fault.requests).toHaveLength(1);
    expect(fault.acknowledgements).toBe(1);
  });

  it('rejects malformed private completion fields before any native frame', async () => {
    const f = fixture();
    await expect(
      send(f, async () => {
        const postsBefore = fault.posts.slice();
        const value = input(f);
        expect(
          ControlAttentionAttemptCompletionSchema.safeParse({ ...value, status: 'sending' }).success
        ).toBe(false);
        expect(
          ControlAttentionAttemptCompletionSchema.safeParse({
            ...value,
            failureCode: 'transport-unknown',
          }).success
        ).toBe(false);
        expect(
          ControlAttentionAttemptCompletionSchema.safeParse({ ...value, finishedAt: 'not-a-date' })
            .success
        ).toBe(false);
        await expect(
          getControlStoreWorkerClient().attentionAttemptCompletion(f.coreDb, {
            ...value,
            callback: 'not-a-program',
          } as ControlAttentionAttemptCompletion)
        ).rejects.toThrow();
        expect(fault.posts).toEqual(postsBefore);
        expect(outcome(f).status).toBe('sending');
        f.coreDb.sqlite.pragma('query_only = ON');
        return { status: 'sent' };
      })
    ).resolves.toMatchObject({ status: 'sent' });
    expect(fault.requests).toHaveLength(1);
  });

  it('refuses the native owner on a real Main connection before its SQL effects', async () => {
    const f = fixture();
    await expect(
      send(f, async () => {
        const postsBefore = fault.posts.slice();
        expect(() => applyControlAttentionAttemptCompletion(f.coreDb, input(f))).toThrow();
        expect(outcome(f)).toEqual({ status: 'sending', failureCode: null, finishedAt: null });
        expect(fault.posts).toEqual(postsBefore);
        f.coreDb.sqlite.pragma('query_only = ON');
        return { status: 'sent' };
      })
    ).resolves.toMatchObject({ status: 'sent' });
    expect(fault.requests).toHaveLength(1);
  });

  it('retains the commit when the original post-ACK projection encounters real corrupt data', async () => {
    const f = fixture();
    // Warm the same admitted physical Core through another genuine enqueue,
    // claim and completion, not an invented receipt or an off-domain command.
    const warm = f.notifications.enqueue({
      source: { ...f.delivery.source, requestId: 'apr_completion_warm' },
      recipientUserId,
    });
    await f.notifications.deliver(
      {
        deliveryId: warm.id,
        recipientUserId,
        channel: 'discord',
        retry: false,
        expectedAttemptId: null,
      },
      { isEligible: () => true, transport: async () => ({ status: 'sent' }) }
    );
    const before = fault.requests.length;
    let sends = 0;
    await expect(
      send(f, async () => {
        sends += 1;
        // Deliberate retained-row corruption is a fault, never accepted history.
        f.coreDb.sqlite
          .prepare('UPDATE notification_attention SET created_at = ? WHERE id = ?')
          .run('not-a-date', f.delivery.id);
        f.coreDb.sqlite.pragma('query_only = ON');
        return { status: 'sent' };
      })
    ).rejects.toMatchObject({ code: 'attention_recovery_required' });
    expect(fault.requests).toHaveLength(before + 1);
    expect(fault.acknowledgements).toBe(before + 1);
    expect(sends).toBe(1);
    expect(count(f).count).toBe(1);
    expect(outcome(f)).toEqual({ status: 'sent', failureCode: null, finishedAt });
  });
});

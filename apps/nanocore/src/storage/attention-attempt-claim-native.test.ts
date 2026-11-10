import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { isRecord } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import {
  AttentionNotifications,
  type AttentionSource,
  enqueueAttentionInDb,
} from '../notifications/attention.js';
import { AttentionError } from '../notifications/attention-error.js';
import { testEntityId } from '../test-support/entity-ids.js';
import {
  type ControlAttentionAttemptClaim,
  ControlAttentionAttemptClaimSchema,
} from './attention-attempt-claim-codecs.js';
import { applyControlAttentionAttemptClaim } from './attention-attempt-claim-native.js';
import { CONTROL_PRODUCT_LIMITS } from './control-store-product-records.js';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { isControlWorkerRequest } from './control-store-worker-protocol.js';
import { type CoreDb, openCoreDb } from './db.js';
import { applyNativeScopeMigrations } from './migrate.js';

// Real Worker/SQLite throughout: only hold or corrupt its genuine committed claim ACK.
const fault = vi.hoisted(() => ({
  hold: false,
  arrived: undefined as (() => void) | undefined,
  release: undefined as (() => void) | undefined,
  worker: undefined as NativeWorker | undefined,
  replyId: undefined as string | undefined,
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
          if (message.operation === 'attention-attempt-claim') {
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
          reply.operation === 'attention-attempt-claim' &&
          fault.requests.includes(reply.id as number) &&
          isRecord(reply.result) &&
          reply.result.status === 'claimed'
        ) {
          if (fault.replyId && isRecord(reply.result.delivery)) {
            args[0] = {
              ...reply,
              result: {
                ...reply.result,
                delivery: { ...reply.result.delivery, id: fault.replyId },
              },
            };
          }
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

const startedAt = '2026-11-05T14:00:00.000Z';
const recipientUserId = testEntityId('usr', 'claim-recipient');
const roots: string[] = [];
const databases: Database.Database[] = [];
const pending: Promise<unknown>[] = [];
function track<T>(promise: Promise<T>): Promise<T> {
  pending.push(promise);
  void promise.then(
    () => undefined,
    () => undefined
  );
  return promise;
}
function fixture(requestId = 'apr_claim_owner') {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-attention-claim-'));
  roots.push(dataRoot);
  const coreDb: CoreDb = openCoreDb(dataRoot);
  databases.push(coreDb.sqlite);
  applyNativeScopeMigrations(coreDb.sqlite, 'core');
  const counters = { routes: 0, eligible: 0, sends: 0 };
  const options = {
    nativeCoreDb: coreDb,
    now: () => startedAt,
    buildAppPath: (_source: AttentionSource) => {
      counters.routes += 1;
      return '/tasks/claim?requestId=apr_claim_owner';
    },
  };
  const notifications = new AttentionNotifications(coreDb.sqlite, options);
  // Isolated pre-open fixture setup retains the original owner; the subject starts its native scope.
  const delivery = enqueueAttentionInDb(
    coreDb.sqlite,
    {
      source: {
        workspaceId: testEntityId('ws', 'claim-owner'),
        threadId: testEntityId('th', 'claim-owner'),
        kind: 'approval-request',
        requestId,
      },
      recipientUserId,
    },
    () => startedAt
  );
  return { coreDb, notifications, delivery, options, counters };
}
type Fixture = ReturnType<typeof fixture>;
function cold(f: Fixture) {
  const reader = new Database(f.coreDb.sqlite.name, { readonly: true });
  databases.push(reader);
  return reader;
}
function count(f: Fixture) {
  return (
    cold(f)
      .prepare(
        'SELECT COUNT(*) AS count FROM notification_delivery_attempts WHERE attention_id = ?'
      )
      .get(f.delivery.id) as { count: number }
  ).count;
}
function expectUnclaimed(f: Fixture) {
  expect(count(f)).toBe(0);
  expect(
    cold(f)
      .prepare('SELECT channel, created_at AS createdAt FROM notification_attention WHERE id = ?')
      .get(f.delivery.id)
  ).toEqual({ channel: null, createdAt: startedAt });
  expect(f.counters).toEqual({ routes: 0, eligible: 0, sends: 0 });
}
function send(
  f: Fixture,
  overrides: Partial<Parameters<AttentionNotifications['deliver']>[0]> = {},
  dependencies?: Parameters<AttentionNotifications['deliver']>[1]
) {
  return track(
    f.notifications.deliver(
      {
        deliveryId: f.delivery.id,
        recipientUserId,
        channel: 'discord',
        retry: false,
        expectedAttemptId: null,
        ...overrides,
      },
      dependencies ?? {
        isEligible: () => {
          f.counters.eligible += 1;
          return true;
        },
        transport: async () => {
          f.counters.sends += 1;
          return { status: 'sent' };
        },
      }
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
  fault.replyId = undefined;
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

// F3 pre-reset ruling: channel storage is extensible; connector admission remains closed in code.
it.each(['notification_attention', 'notification_delivery_attempts'] as const)(
  'F3 stores a future channel in migrated %s and preserves it on cold reopen',
  async (table) => {
    const f = fixture();
    await expect(send(f)).resolves.toMatchObject({ status: 'sent', channel: 'discord' });
    await shutdownControlStoreWorkerClient();
    const sqlite = f.coreDb.sqlite;
    expect(sqlite.prepare(`UPDATE ${table} SET channel = ?`).run('future-connector').changes).toBe(
      1
    );
    sqlite.close();
    const reopened = cold(f);
    expect(reopened.prepare(`SELECT channel FROM ${table}`).all()).toEqual([
      { channel: 'future-connector' },
    ]);
    const other =
      table === 'notification_attention'
        ? 'notification_delivery_attempts'
        : 'notification_attention';
    expect(reopened.prepare(`SELECT channel FROM ${other}`).all()).toEqual([
      { channel: 'discord' },
    ]);
    const notifications = new AttentionNotifications(reopened);
    expect(() => notifications.get(f.delivery.id)).toThrowError(
      expect.objectContaining({ name: 'AttentionError', code: 'attention_recovery_required' })
    );
  }
);

it('F3 preserves Attention nullability, source and attempt checks, indices and cascading ownership', async () => {
  const f = fixture();
  const sqlite = f.coreDb.sqlite;
  const reject = (operation: () => unknown, code: string) => {
    expect(operation).toThrowError(expect.objectContaining({ code }));
  };
  expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
  for (const [table, notnull] of [
    ['notification_attention', 0],
    ['notification_delivery_attempts', 1],
  ] as const) {
    expect(
      (sqlite.pragma(`table_info(${table})`) as { name: string }[]).find(
        (column) => column.name === 'channel'
      )
    ).toMatchObject({ type: 'TEXT', notnull });
  }
  expect(sqlite.prepare('SELECT channel FROM notification_attention').get()).toEqual({
    channel: null,
  });
  reject(
    () => sqlite.prepare('UPDATE notification_attention SET source_kind = ?').run('future-source'),
    'SQLITE_CONSTRAINT_CHECK'
  );
  reject(
    () =>
      sqlite
        .prepare(`INSERT INTO notification_attention
    (id, workspace_id, thread_id, source_kind, request_id, recipient_user_id, created_at)
    SELECT ?, workspace_id, thread_id, source_kind, request_id, recipient_user_id, created_at
    FROM notification_attention`)
        .run(randomUUID()),
    'SQLITE_CONSTRAINT_UNIQUE'
  );
  const insert = sqlite.prepare(`INSERT INTO notification_delivery_attempts
    (attention_id, channel, status, started_at) VALUES (?, ?, 'sending', ?)`);
  reject(() => insert.run(f.delivery.id, null, startedAt), 'SQLITE_CONSTRAINT_NOTNULL');
  reject(
    () => insert.run('missing-attention', 'discord', startedAt),
    'SQLITE_CONSTRAINT_FOREIGNKEY'
  );
  insert.run(f.delivery.id, 'discord', startedAt);
  reject(() => insert.run(f.delivery.id, 'email', startedAt), 'SQLITE_CONSTRAINT_UNIQUE');
  for (const update of [
    "UPDATE notification_delivery_attempts SET status = 'future-state'",
    "UPDATE notification_delivery_attempts SET failure_code = 'future-failure'",
    "UPDATE notification_delivery_attempts SET status = 'sent'",
    "UPDATE notification_delivery_attempts SET finished_at = '2026-11-05T14:00:01.000Z'",
  ])
    reject(() => sqlite.prepare(update).run(), 'SQLITE_CONSTRAINT_CHECK');
  expect(
    sqlite
      .prepare('SELECT status, failure_code, finished_at FROM notification_delivery_attempts')
      .all()
  ).toEqual([{ status: 'sending', failure_code: null, finished_at: null }]);
  const indices = [
    ['notification_attention_recipient', ['recipient_user_id', 'created_at', 'id']],
    ['notification_attempt_attention', ['attention_id', 'id']],
    ['notification_one_active_attempt', ['attention_id']],
  ] as const;
  for (const [index, columns] of indices) {
    expect(
      (sqlite.pragma(`index_info(${index})`) as { name: string }[]).map((column) => column.name)
    ).toEqual(columns);
  }
  expect(
    sqlite.prepare('DELETE FROM notification_attention WHERE id = ?').run(f.delivery.id).changes
  ).toBe(1);
  expect(
    sqlite.prepare('SELECT COUNT(*) AS count FROM notification_delivery_attempts').get()
  ).toEqual({ count: 0 });
});

it('F3 refuses a future channel through Attention and native claim admission before any write or contact', async () => {
  const f = fixture();
  const channel = 'future-connector' as Parameters<AttentionNotifications['deliver']>[0]['channel'];
  const refused = send(f, { channel });
  await expect(refused).rejects.toBeInstanceOf(AttentionError);
  await expect(refused).rejects.toMatchObject({ code: 'invalid_attention_input' });
  await expect(
    getControlStoreWorkerClient().attentionAttemptClaim(f.coreDb, {
      deliveryId: f.delivery.id,
      recipientUserId,
      channel,
      retry: false,
      expectedAttemptId: null,
      startedAt,
    })
  ).rejects.toBeInstanceOf(ZodError);
  expect(fault.posts).toEqual([]);
  expectUnclaimed(f);
});

it('commits the original sending claim with Main readonly before fresh eligibility and transport', async () => {
  const f = fixture();
  f.coreDb.sqlite.pragma('query_only = ON');
  let sends = 0;
  let admissions = 0;
  const result = f.notifications
    .deliver(
      {
        deliveryId: f.delivery.id,
        recipientUserId,
        channel: 'discord',
        retry: false,
        expectedAttemptId: null,
      },
      {
        isEligible: (claimed) => {
          admissions += 1;
          expect(claimed).toMatchObject({
            id: f.delivery.id,
            channel: 'discord',
            status: 'sending',
            attempt: { status: 'sending' },
          });
          expect(f.notifications.get(f.delivery.id)?.status).toBe('sending');
          return true;
        },
        transport: async () => {
          sends += 1;
          return { status: 'sent' };
        },
      }
    )
    .catch((error: unknown) => {
      const details =
        typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
      const output = process.env.OPENKIT_PRIVATE_CLAIM_OBSERVATION;
      if (output) {
        const observation = {
          code:
            typeof details.code === 'string'
              ? (details.code.match(/^SQLITE_[A-Z_]+$/)?.[0] ?? 'unclassified')
              : 'unclassified',
          ownerLocations:
            typeof details.stack === 'string' ? details.stack.match(/attention\.ts:\d+:\d+/g) : [],
          admissions,
          sends,
        };
        try {
          writeFileSync(output, JSON.stringify(observation));
        } catch {
          /* Never replace the original error. */
        }
      }
      throw error;
    });
  await expect(result).resolves.toMatchObject({
    id: f.delivery.id,
    channel: 'discord',
    status: 'sent',
    attempt: { status: 'sent', failureCode: null },
  });
  expect(admissions).toBe(1);
  expect(sends).toBe(1);
  const reader = new Database(f.coreDb.sqlite.name, { readonly: true });
  databases.push(reader);
  expect(
    reader
      .prepare(
        'SELECT COUNT(*) AS count FROM notification_delivery_attempts WHERE attention_id = ?'
      )
      .get(f.delivery.id)
  ).toEqual({ count: 1 });
  expect(
    reader.prepare('SELECT channel FROM notification_attention WHERE id = ?').get(f.delivery.id)
  ).toEqual({ channel: 'discord' });
});

it('withholds routing, eligibility, transport and publication until the genuine FULL claim ACK', async () => {
  const f = fixture();
  const arrived = holdAcknowledgement();
  let published = false;
  const result = send(f);
  void result.then(
    () => {
      published = true;
    },
    () => undefined
  );
  await arrived;
  expect(
    cold(f).prepare('SELECT channel FROM notification_attention WHERE id = ?').get(f.delivery.id)
  ).toEqual({ channel: 'discord' });
  expect(f.notifications.get(f.delivery.id)).toMatchObject({
    status: 'sending',
    attempt: { startedAt },
  });
  expect(count(f)).toBe(1);
  expect(f.counters).toEqual({ routes: 0, eligible: 0, sends: 0 });
  expect(published).toBe(false);
  await expect(send(f)).rejects.toMatchObject({ code: 'attention_attempt_conflict' });
  expect(count(f)).toBe(1);
  fault.hold = false;
  fault.release?.();
  fault.release = undefined;
  await expect(result).resolves.toMatchObject({ status: 'sent' });
  expect(f.counters).toEqual({ routes: 1, eligible: 1, sends: 1 });
  expect(fault.acknowledgements).toBe(1);
});

it('rechecks the original eligibility callback after held claim ACK and makes no contact after revocation', async () => {
  const f = fixture();
  const arrived = holdAcknowledgement();
  let allowed = true;
  const result = send(
    f,
    {},
    {
      isEligible: () => {
        f.counters.eligible += 1;
        return allowed;
      },
      transport: async () => {
        f.counters.sends += 1;
        return { status: 'sent' };
      },
    }
  );
  await arrived;
  expect(f.counters.eligible).toBe(0);
  allowed = false;
  fault.hold = false;
  fault.release?.();
  fault.release = undefined;
  await expect(result).rejects.toMatchObject({ code: 'attention_not_eligible' });
  expect(f.counters.eligible).toBe(1);
  expect(f.counters.sends).toBe(0);
  expect(f.notifications.get(f.delivery.id)).toMatchObject({
    status: 'failed-no-send',
    attempt: { failureCode: 'authority-unavailable' },
  });
  expect(count(f)).toBe(1);
});

it('makes no route, eligibility, contact, fallback or repost after a genuine committed claim ACK is lost', async () => {
  const f = fixture();
  f.coreDb.sqlite.pragma('query_only = ON');
  const arrived = holdAcknowledgement();
  const result = send(f);
  await arrived;
  expect(f.notifications.get(f.delivery.id)?.status).toBe('sending');
  expect(count(f)).toBe(1);
  fault.release = undefined;
  if (!fault.worker) throw new Error('The actual claim Worker must exist.');
  await fault.worker.terminate();
  await expect(result).rejects.toMatchObject({ commit: 'unknown' });
  expect(fault.requests).toHaveLength(1);
  expect(fault.acknowledgements).toBe(0);
  expect(f.counters).toEqual({ routes: 0, eligible: 0, sends: 0 });
  fault.hold = false;
  const postsBefore = fault.posts.slice();
  await expect(
    send(f, { retry: true, expectedAttemptId: f.notifications.get(f.delivery.id)!.attempt!.id })
  ).rejects.toBeInstanceOf(ControlStoreWorkerError);
  expect(fault.posts).toEqual(postsBefore);
  // Explicitly recreate the native owner to inspect the durable no-resend fence;
  // the production path neither replaces the failed Worker nor retries a claim.
  await shutdownControlStoreWorkerClient();
  await expect(
    send(f, { retry: true, expectedAttemptId: f.notifications.get(f.delivery.id)!.attempt!.id })
  ).rejects.toMatchObject({ code: 'attention_not_sendable' });
  expect(count(f)).toBe(1);
  expect(f.counters.sends).toBe(0);
  // Startup reconciliation remains the separate original Main owner, not a fallback.
  f.coreDb.sqlite.pragma('query_only = OFF');
  expect(await f.notifications.reconcileIncompleteAttempts()).toBe(1);
  expect(f.notifications.get(f.delivery.id)).toMatchObject({
    status: 'delivery-unknown',
    attempt: { failureCode: 'restart' },
  });
});

it('rolls back the original channel freeze and attempt on a real native INSERT failure', async () => {
  const f = fixture();
  f.coreDb.sqlite.exec(
    "CREATE TRIGGER reject_attention_claim BEFORE INSERT ON notification_delivery_attempts BEGIN SELECT RAISE(ABORT, 'claim-rejected'); END"
  );
  f.coreDb.sqlite.pragma('query_only = ON');
  await expect(send(f)).rejects.toMatchObject({ commit: 'not-committed' });
  expectUnclaimed(f);
  expect(fault.requests).toHaveLength(1);
  expect(fault.acknowledgements).toBe(0);
});

it('rolls back both writes when the original in-transaction get encounters real corrupt data', async () => {
  const f = fixture();
  f.coreDb.sqlite.exec(
    "CREATE TRIGGER corrupt_attention_claim AFTER INSERT ON notification_delivery_attempts BEGIN UPDATE notification_attention SET created_at = 'not-a-date' WHERE id = NEW.attention_id; END"
  );
  f.coreDb.sqlite.pragma('query_only = ON');
  await expect(send(f)).rejects.toMatchObject({ code: 'attention_recovery_required' });
  expectUnclaimed(f);
});

it.each(['queued', 'missing', 'stale-attempt'] as const)(
  'preserves the original guard/invalid-clock precedence and rollback: %s',
  async (mode) => {
    const f = fixture();
    f.options.now = () => 'not-a-date';
    f.coreDb.sqlite.pragma('query_only = ON');
    await expect(
      send(
        f,
        mode === 'missing'
          ? { deliveryId: randomUUID() }
          : mode === 'stale-attempt'
            ? { expectedAttemptId: 1 }
            : {}
      )
    ).rejects.toMatchObject({
      code:
        mode === 'missing'
          ? 'attention_not_found'
          : mode === 'stale-attempt'
            ? 'attention_attempt_conflict'
            : 'invalid_attention_input',
    });
    expectUnclaimed(f);
  }
);

it('preserves a local clock exception without serializing its details or leaving a frozen channel', async () => {
  const f = fixture();
  const error = new Error('test-clock-refusal');
  f.options.now = () => {
    throw error;
  };
  await expect(send(f)).rejects.toBe(error);
  expectUnclaimed(f);
});

it('uses the original in-transaction snapshot, not a post-ACK Main source re-read', async () => {
  const f = fixture();
  let routed = '';
  let admitted = '';
  f.options.buildAppPath = (source) => {
    routed = source.requestId;
    return '/tasks/claim';
  };
  const arrived = holdAcknowledgement();
  const result = send(
    f,
    {},
    {
      isEligible: (delivery) => {
        admitted = delivery.source.requestId;
        return true;
      },
      transport: async () => {
        f.counters.sends += 1;
        return { status: 'sent' };
      },
    }
  );
  await arrived;
  // A deliberate after-commit observation fault, not authority to retarget a source.
  f.coreDb.sqlite
    .prepare('UPDATE notification_attention SET request_id = ? WHERE id = ?')
    .run('apr_after_claim_commit', f.delivery.id);
  fault.hold = false;
  fault.release?.();
  fault.release = undefined;
  await expect(result).resolves.toMatchObject({
    status: 'sent',
    source: { requestId: 'apr_after_claim_commit' },
  });
  expect(routed).toBe('apr_claim_owner');
  expect(admitted).toBe('apr_claim_owner');
  expect(f.counters.sends).toBe(1);
});

it('preserves a legal opaque request identity larger than the native command payload budget', async () => {
  const requestId = `apr_${'x'.repeat(CONTROL_PRODUCT_LIMITS.payloadBytes + 1)}`;
  const expectedDigest = createHash('sha256').update(requestId).digest('hex');
  const f = fixture(requestId);
  let selectedLength = 0;
  let selectedDigest = '';
  f.options.buildAppPath = (source) => {
    selectedLength = source.requestId.length;
    selectedDigest = createHash('sha256').update(source.requestId).digest('hex');
    return '/tasks/claim';
  };
  f.coreDb.sqlite.pragma('query_only = ON');
  const result = await send(f);
  expect(result.status).toBe('sent');
  expect(selectedLength).toBe(requestId.length);
  expect(selectedDigest).toBe(expectedDigest);
  expect(result.source.requestId.length).toBe(requestId.length);
  expect(createHash('sha256').update(result.source.requestId).digest('hex')).toBe(expectedDigest);
  expect(count(f)).toBe(1);
});

it('keeps exact prior-attempt CAS, channel freeze and explicit same-channel retry with concurrent callers', async () => {
  const f = fixture();
  const noSend = {
    isEligible: () => {
      f.counters.eligible += 1;
      return true;
    },
    transport: async () => {
      f.counters.sends += 1;
      return { status: 'failed-no-send' as const };
    },
  };
  const first = await send(f, {}, noSend);
  const expectedAttemptId = first.attempt!.id;
  await expect(send(f, { expectedAttemptId })).rejects.toMatchObject({
    code: 'attention_not_sendable',
  });
  await expect(send(f, { retry: true, channel: 'email', expectedAttemptId })).rejects.toMatchObject(
    { code: 'attention_channel_conflict' }
  );
  await expect(send(f, { retry: true })).rejects.toMatchObject({
    code: 'attention_attempt_conflict',
  });
  expect(count(f)).toBe(1);
  expect(f.counters.sends).toBe(1);
  const results = await Promise.allSettled([
    send(f, { retry: true, expectedAttemptId }, noSend),
    send(f, { retry: true, expectedAttemptId }, noSend),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const rejected = results.find((r) => r.status === 'rejected');
  expect(rejected).toMatchObject({
    status: 'rejected',
    reason: { code: 'attention_attempt_conflict' },
  });
  expect(count(f)).toBe(2);
  expect(f.counters.sends).toBe(2);
  expect(f.counters.eligible).toBe(2);
  expect(f.notifications.get(f.delivery.id)?.channel).toBe('discord');
});

it.each(['sent', 'delivery-unknown'] as const)(
  'never retries an original terminal %s delivery',
  async (status) => {
    const f = fixture();
    const first = await send(
      f,
      {},
      {
        isEligible: () => true,
        transport: async () => {
          f.counters.sends += 1;
          return { status };
        },
      }
    );
    await expect(
      send(f, { retry: true, expectedAttemptId: first.attempt!.id })
    ).rejects.toMatchObject({ code: 'attention_not_sendable' });
    expect(count(f)).toBe(1);
    expect(f.counters.sends).toBe(1);
  }
);

it.each(['connection', 'path', 'scope'] as const)(
  'refuses the wrong physical Core %s before any native frame, route or contact',
  async (mode) => {
    const f = fixture();
    const other = fixture();
    f.options.nativeCoreDb =
      mode === 'connection'
        ? other.coreDb
        : mode === 'path'
          ? { ...f.coreDb, dataRoot: other.coreDb.dataRoot }
          : ({ ...f.coreDb, scope: 'workspace' } as unknown as CoreDb);
    await expect(send(f)).rejects.toMatchObject({
      code: 'invalid-request',
      commit: 'not-committed',
    });
    expect(fault.posts).toHaveLength(0);
    expectUnclaimed(f);
    expectUnclaimed(other);
  }
);

it('checks the genuine cached opening binding before posting another claim', async () => {
  const f = fixture();
  await send(f);
  const queued = await f.notifications.enqueue({
    source: { ...f.delivery.source, requestId: 'apr_claim_cached' },
    recipientUserId,
  });
  const target = { ...f, delivery: queued };
  f.counters.routes = 0;
  f.counters.eligible = 0;
  f.counters.sends = 0;
  const client = getControlStoreWorkerClient();
  const openings = (
    client as unknown as { openings: Map<string, { command: { dataRoot: string } }> }
  ).openings;
  const key = `core:${f.coreDb.sqlite.name}`;
  const original = openings.get(key);
  if (!original) throw new Error('The genuine completed command must admit its physical Core.');
  const postsBefore = fault.posts.slice();
  openings.set(key, {
    ...original,
    command: { ...original.command, dataRoot: join(f.coreDb.dataRoot, 'wrong-root') },
  });
  try {
    await expect(send(target)).rejects.toMatchObject({
      code: 'invalid-request',
      commit: 'not-committed',
    });
    expect(fault.posts).toEqual(postsBefore);
    expectUnclaimed(target);
  } finally {
    openings.set(key, original);
  }
});

it('rejects closed malformed claim fields before posting and refuses a real Main writer role before SQL', async () => {
  const f = fixture();
  const input: ControlAttentionAttemptClaim = {
    deliveryId: f.delivery.id,
    recipientUserId,
    channel: 'discord',
    retry: false,
    expectedAttemptId: null,
    startedAt,
  };
  expect(
    ControlAttentionAttemptClaimSchema.safeParse({ ...input, startedAt: 'not-a-date' }).success
  ).toBe(false);
  expect(
    ControlAttentionAttemptClaimSchema.safeParse({ ...input, callback: 'not-a-program' }).success
  ).toBe(false);
  await expect(
    getControlStoreWorkerClient().attentionAttemptClaim(f.coreDb, {
      ...input,
      sql: 'not-a-program',
    } as ControlAttentionAttemptClaim)
  ).rejects.toThrow();
  expect(() =>
    f.coreDb.sqlite.transaction(() => applyControlAttentionAttemptClaim(f.coreDb, input))()
  ).toThrow();
  expect(fault.posts).toHaveLength(0);
  expectUnclaimed(f);
});

it('rejects a mismatched genuine committed snapshot without routing, admission or transport', async () => {
  const f = fixture();
  fault.replyId = randomUUID();
  await expect(send(f)).rejects.toMatchObject({ code: 'invalid-request', commit: 'unknown' });
  expect(f.counters).toEqual({ routes: 0, eligible: 0, sends: 0 });
  expect(count(f)).toBe(1);
  expect(f.notifications.get(f.delivery.id)?.status).toBe('sending');
  expect(fault.requests).toHaveLength(1);
});

// openkit-test-platform: posix
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay, setImmediate as nextTurn } from 'node:timers/promises';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { allocateEntityId } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import { createBetterAuth } from '../auth/better-auth.js';
import {
  consumeServerBootstrapToken,
  ensureServerBootstrapToken,
  isServerBootstrapComplete,
  writeServerBootstrapTokenEmission,
} from '../auth/bootstrap-token.js';
import { armCommit, releaseCommit } from '../test-support/control-native-transport.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { type CoreDb, openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';
import { nativeProductScope } from './workspace-file-records.js';

const interception = vi.hoisted(() => ({
  begin: new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT),
  workers: [] as NativeWorker[],
}));

// Real SQLite BEGIN and covering FULL COMMIT remain the deciding physical effects.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  const { createRequire } = await import('node:module');
  const { nativeCommitWorker } = await import('../test-support/control-native-transport.js');
  const require = createRequire(import.meta.url);
  class BeginObservedWorker extends actual.Worker {
    constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
      const prelude = `
        {
        const Database = require(require('node:worker_threads').workerData.consumeSqlModule);
        const beginGate = require('node:worker_threads').workerData.consumeBegin;
        const exec = Database.prototype.exec;
        Database.prototype.exec = function(sql) {
          if (/^BEGIN(?:\\s|$)/i.test(sql) && Atomics.compareExchange(beginGate, 2, 1, 0) === 1) {
            Atomics.store(beginGate, 0, 1);
            Atomics.notify(beginGate, 0);
            Atomics.wait(beginGate, 1, 0);
          }
          return exec.call(this, sql);
        };
        }
      `;
      const entry = options?.eval
        ? String(filename)
        : `import(${JSON.stringify(String(filename))});`;
      super(prelude + entry, {
        ...options,
        eval: true,
        workerData: {
          ...options?.workerData,
          consumeSqlModule: require.resolve('better-sqlite3'),
          consumeBegin: new Int32Array(interception.begin),
        },
      });
      interception.workers.push(this);
    }
  }
  return { ...actual, Worker: nativeCommitWorker(BeginObservedWorker) };
});

/** Releases only the test's real native transaction-entry hold. */
function releaseBegin() {
  const gate = new Int32Array(interception.begin);
  Atomics.store(gate, 2, 0);
  Atomics.store(gate, 1, 1);
  Atomics.notify(gate, 1);
}

/** Keeps generated credentials and failure payloads out of every assertion and raw log. */
function observed(work: Promise<Awaited<ReturnType<typeof consumeServerBootstrapToken>>>) {
  return work.then(
    (value) => ({ failed: false, status: value.status }),
    () => ({ failed: true, status: 'refused' })
  );
}

/** Opens the real physical writer before issuing fresh pending bootstrap authority. */
async function fixture(ttlMs?: number) {
  await shutdownControlStoreWorkerClient();
  releaseBegin();
  releaseCommit();
  interception.workers.length = 0;
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-consume-native-'));
  const db = openCoreDb(root);
  const handles = [db];
  const pending: Promise<unknown>[] = [];
  onTestFinished(async () => {
    releaseBegin();
    releaseCommit();
    await Promise.allSettled(pending);
    await shutdownControlStoreWorkerClient();
    for (const handle of handles) if (handle.sqlite.open) handle.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  applyMigrations(db);
  const scope = nativeProductScope(root, { kind: 'server' });
  await getControlStoreWorkerClient().open({
    database: `core:${scope.path}`,
    path: scope.path,
    dataRoot: root,
    create: false,
    initialize: 'core',
    productOwner: scope.owner,
    contentMount: scope.contentMount,
  });
  const issued = ensureServerBootstrapToken(db, { ...(ttlMs === undefined ? {} : { ttlMs }) });
  if (!issued) throw new Error('Fresh bootstrap authority was not issued.');
  const emission = writeServerBootstrapTokenEmission(root, issued);
  const input = {
    displayName: 'Bootstrap owner',
    email: 'owner@example.test',
    ownerUserId: allocateEntityId('usr'),
    password: 'synthetic-bootstrap-password',
    token: issued.token,
    tokenExpiresAt: '2999-01-01T00:00:00.000Z',
  };
  const start = () => {
    let finished = false;
    const result = observed(consumeServerBootstrapToken(db, input)).then((value) => {
      finished = true;
      return value;
    });
    pending.push(result);
    return { result, finished: () => finished };
  };
  const reopen = async () => {
    await shutdownControlStoreWorkerClient();
    if (db.sqlite.open) db.sqlite.close();
    const cold = openCoreDb(root);
    handles.push(cold);
    return cold;
  };
  return { root, db, input, issued, emission, pending, start, reopen };
}

/** Observes only non-secret counts in the original atomic SQL tuple. */
function counts(db: CoreDb) {
  return ['users', 'account', 'openkit_access_tokens'].map(
    (table) => db.sqlite.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number
  );
}

/** Waits finitely for a real hold, also detecting the OLD Main-only completion safely. */
async function reached(gate: Int32Array, work: { finished(): boolean }) {
  await vi.waitFor(() => expect(Atomics.load(gate, 0) === 1 || work.finished()).toBe(true), {
    timeout: 5000,
  });
  await nextTurn();
  expect(Atomics.load(gate, 0)).toBe(1);
  expect(work.finished()).toBe(false);
}

it('concurrent consumers create exactly one owner, login account and first administrator Token', async () => {
  const f = await fixture();
  const other = { ...f.input, ownerUserId: allocateEntityId('usr'), email: 'other@example.test' };
  const attempts = [f.input, other].map((input) => consumeServerBootstrapToken(f.db, input));
  f.pending.push(...attempts);
  // Password preparation must not retain a synchronous Main SQL transaction across await.
  expect(f.db.sqlite.inTransaction).toBe(false);
  const results = await Promise.all(attempts);
  expect(results.map((result) => result.status).sort()).toEqual(['consumed', 'unavailable']);
  expect(counts(f.db)).toEqual([1, 1, 1]);
  const winner = results.find((result) => result.status === 'consumed');
  const loser = results.find((result) => result.status !== 'consumed');
  expect(winner?.status === 'consumed' && typeof winner.secret === 'string').toBe(true);
  expect(loser !== undefined && !('secret' in loser)).toBe(true);
  const id = f.db.sqlite.prepare('SELECT id FROM users').pluck().get();
  expect([f.input.ownerUserId, other.ownerUserId].includes(id as string)).toBe(true);
  expect(f.db.sqlite.prepare('SELECT user_id FROM account').pluck().get() === id).toBe(true);
  expect(
    f.db.sqlite.prepare('SELECT owner_user_id FROM openkit_access_tokens').pluck().get() === id
  ).toBe(true);
  expect(isServerBootstrapComplete(await f.reopen())).toBe(true);
});

it('rolls back the entire tuple after real late Token SQL refusal and retains that state after reopen', async () => {
  const f = await fixture();
  // Physical fault only after genuine User/account/consumed-setting progress in the same transaction.
  f.db.sqlite.exec(`CREATE TRIGGER reject_bootstrap_first_token BEFORE INSERT ON openkit_access_tokens
    WHEN (SELECT COUNT(*) FROM users) = 1 AND (SELECT COUNT(*) FROM account) = 1
      AND json_extract((SELECT value FROM server_settings WHERE key='auth.bootstrap_token'), '$.consumedAt') IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'Synthetic late first-token SQL refusal'); END`);
  const before = f.db.sqlite.prepare('SELECT value FROM server_settings').pluck().get();
  expect((await f.start().result).failed).toBe(true);
  expect(counts(f.db)).toEqual([0, 0, 0]);
  expect(f.db.sqlite.prepare('SELECT value FROM server_settings').pluck().get() === before).toBe(
    true
  );
  // Remote Bootstrap owns file-before-SQL ordering, not cross-resource atomic rollback.
  expect(existsSync(f.emission.path) && readFileSync(f.emission.path, 'utf8').length === 0).toBe(
    true
  );
  const cold = await f.reopen();
  expect(counts(cold)).toEqual([0, 0, 0]);
  expect(isServerBootstrapComplete(cold)).toBe(false);
  expect(cold.sqlite.prepare('SELECT value FROM server_settings').pluck().get() === before).toBe(
    true
  );
});

it('consumes with Main query-only and withholds its result until the actual covering FULL acknowledgement', async () => {
  const f = await fixture();
  f.db.sqlite.pragma('query_only = ON');
  const gate = armCommit(2);
  const work = f.start();
  await reached(gate, work);
  expect(Atomics.load(gate, 5)).toBe(2);
  expect(counts(f.db)).toEqual([1, 1, 1]);
  expect(isServerBootstrapComplete(f.db)).toBe(true);
  expect(f.db.sqlite.inTransaction).toBe(false);
  expect(f.db.sqlite.pragma('query_only', { simple: true })).toBe(1);
  releaseCommit();
  expect((await work.result).status).toBe('consumed');
});

it.each(['bootstrap', 'administrator'] as const)(
  'rechecks current %s expiry after preparation and native waiting before any owner effect',
  async (kind) => {
    const f = await fixture(kind === 'bootstrap' ? 3000 : undefined);
    const expiresAt = kind === 'bootstrap' ? Date.parse(f.issued.expiresAt) : Date.now() + 3000;
    if (kind === 'administrator') f.input.tokenExpiresAt = new Date(expiresAt).toISOString();
    const before = readFileSync(f.emission.path, 'utf8');
    const gate = new Int32Array(interception.begin);
    Atomics.store(gate, 0, 0);
    Atomics.store(gate, 1, 0);
    Atomics.store(gate, 2, 1);
    const work = f.start();
    await reached(gate, work);
    expect(Date.now() < expiresAt).toBe(true);
    await delay(Math.max(0, expiresAt - Date.now()) + 20);
    releaseBegin();
    expect((await work.result).status).toBe(kind === 'bootstrap' ? 'invalid' : 'admin_expiry');
    expect(counts(f.db)).toEqual([0, 0, 0]);
    expect(isServerBootstrapComplete(f.db)).toBe(false);
    expect(readFileSync(f.emission.path, 'utf8') === before).toBe(true);
  }
);

it('retains a lost consume result across reopen, real sign-in and a refused repeat without reminting', async () => {
  const f = await fixture();
  const gate = armCommit(2);
  const work = f.start();
  await reached(gate, work);
  expect(Atomics.load(gate, 5)).toBe(2);
  expect(counts(f.db)).toEqual([1, 1, 1]);
  const worker = interception.workers[0];
  if (!worker) throw new Error('The actual native writer was not observed.');
  await worker.terminate();
  expect((await work.result).failed).toBe(true);
  releaseCommit();
  const cold = await f.reopen();
  const auth = createBetterAuth(cold, {
    mode: 'server',
    env: {
      BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
      BETTER_AUTH_URL: 'http://localhost:3000',
    },
  });
  const context = await auth.$context;
  vi.spyOn(context.logger, 'error').mockImplementation(() => {});
  vi.spyOn(context.logger, 'warn').mockImplementation(() => {});
  const response = await auth.handler(
    new Request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: f.input.email, password: f.input.password }),
    })
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.user?.id === f.input.ownerUserId).toBe(true);
  const repeat = await observed(consumeServerBootstrapToken(cold, f.input));
  expect(repeat.status).toBe('unavailable');
  expect(counts(cold)).toEqual([1, 1, 1]);
  expect(isServerBootstrapComplete(cold)).toBe(true);
  expect(ensureServerBootstrapToken(cold) === null).toBe(true);
});

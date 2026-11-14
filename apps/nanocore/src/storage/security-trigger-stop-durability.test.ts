// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { allocateEntityId } from '@openkit/protocol';
import { describe, it, onTestFinished, vi } from 'vitest';
import { createAccessTokenOperationImplementations } from '../auth/access-token-operations.js';
import { verifyOpenKitAccessTokenRecord } from '../auth/access-token-verification.js';
import { createBetterAuth } from '../auth/better-auth.js';
import { ensureServerBootstrapTokenForStartup } from '../auth/bootstrap-ensure.js';
import { writeServerBootstrapTokenEmission } from '../auth/bootstrap-token.js';
import { type Actor, actorFromSession } from '../auth/identity.js';
import { FsStore } from '../lib/store.js';
import type { AdmittedOperationContext } from '../operation-contract.js';
import { SecurityTriggerStore } from '../security/trigger.js';
import { closeWorkspaceProductReadHandles } from './control-store-product-records.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';

const observation = vi.hoisted(() => ({
  gate: undefined as SharedArrayBuffer | undefined,
  records: undefined as SharedArrayBuffer | undefined,
}));

// ORIGINAL capability coalescing gate + ORIGINAL client COMMIT interception: real entry/SQL/transport.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        if (!observation.gate || !observation.records) {
          super(filename, options);
          return;
        }
        const prelude = `
          const { workerData, parentPort } = require('node:worker_threads');
          const gate = new Int32Array(workerData.coalescingGate);
          const records = new Int32Array(workerData.commitRecords);
          const schedule = globalThis.setTimeout;
          const cancel = globalThis.clearTimeout;
          const held = new Map();
          globalThis.setTimeout = function(callback, delay, ...args) {
            if (delay !== 5 || Atomics.load(gate, 0) !== 1)
              return schedule(callback, delay, ...args);
            const timer = schedule(() => {}, 2147483647);
            held.set(timer, () => callback(...args));
            Atomics.add(gate, 1, 1);
            return timer;
          };
          globalThis.clearTimeout = function(timer) {
            held.delete(timer);
            return cancel(timer);
          };
          setInterval(() => {
            if (Atomics.load(gate, 0) === 1) return;
            const callbacks = [...held];
            held.clear();
            for (const [timer, callback] of callbacks) {
              cancel(timer);
              Atomics.add(gate, 2, 1);
              callback();
            }
          }, 1).unref();
          const selected = () => String.fromCharCode(...records.subarray(65, 65 + Atomics.load(records, 64)));
          parentPort.on('message', value => {
            if (Atomics.load(records, 0) === 1 && value && value.operation === 'security-trigger')
              Atomics.add(records, 1, 1);
          });
          const Database = require(workerData.databaseModule);
          const exec = Database.prototype.exec;
          Database.prototype.exec = function(sql) {
            const observe = Atomics.load(records, 0) === 1 && this.name === selected() && /^COMMIT$/i.test(sql);
            let synchronous = -1;
            if (observe) {
              try { synchronous = Number(this.pragma('synchronous', { simple: true })); }
              catch { Atomics.store(records, 3, 1); }
            }
            const result = exec.call(this, sql); // REAL original COMMIT, unchanged; throws are not caught/replaced.
            if (observe) {
              try {
                const state = this.prepare('SELECT state FROM security_trigger_state WHERE singleton=1').get();
                const failure = this.prepare("SELECT count(*) AS n FROM security_trigger_alarms WHERE rule='R8' AND recipient_count=0 AND failure='no-current-administrator'").get();
                const index = Atomics.load(records, 2);
                if (index >= 8) Atomics.store(records, 3, 2);
                else {
                  const at = 4 + index * 4;
                  Atomics.store(records, at, state.state === 'stopping' ? 1 : state.state === 'off' ? 2 : 3);
                  Atomics.store(records, at + 1, synchronous);
                  Atomics.store(records, at + 2, Number(failure.n));
                  Atomics.store(records, at + 3, Atomics.load(records, 1));
                }
                Atomics.store(records, 2, index + 1);
              } catch { Atomics.store(records, 3, 3); }
            }
            return result;
          };
        `;
        const entry = options?.eval
          ? String(filename)
          : `import(${JSON.stringify(String(filename))});`;
        super(prelude + entry, {
          ...options,
          eval: true,
          workerData: {
            ...options?.workerData,
            databaseModule: createRequire(import.meta.url).resolve('better-sqlite3'),
            coalescingGate: observation.gate,
            commitRecords: observation.records,
          },
        });
      }
    },
  };
});

const EXPIRY = '2099-01-01T00:00:00.000Z';
const context = (actor: Actor): AdmittedOperationContext => ({
  kind: 'public',
  actor,
  actorRef: { kind: 'user', id: actor.userId },
  scope: { kind: 'server' },
});
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const wire = (
  value: unknown
): value is Record<string, unknown> & { operation: string; id: number } =>
  object(value) && typeof value.operation === 'string' && typeof value.id === 'number';

/** Call-through Worker observations never replace an owner, result or commit. */
function observeNative() {
  const sent = vi.spyOn(Worker.prototype, 'postMessage');
  const emitted = vi.spyOn(Worker.prototype, 'emit');
  return {
    checkpoint() {
      return sent.mock.calls.length;
    },
    ack(since: number, operation: 'security-trigger' | 'publication') {
      const calls = sent.mock.calls
        .slice(since)
        .map(([message]) => message)
        .filter(wire)
        .filter((message) =>
          operation === 'security-trigger'
            ? message.operation === 'security-trigger'
            : ['pending', 'terminal'].includes(message.operation) &&
              typeof message.database === 'string' &&
              message.database.startsWith('workspace:') &&
              Object.values(message)
                .filter(object)
                .map((value) => (object(value.terminal) ? value.terminal : value))
                .some(
                  (value) =>
                    object(value.turn) && Array.isArray(value.pending) && value.pending.length > 0
                )
        );
      assert.ok(calls.length > 0, `actual ${operation} owner entry must be invoked`);
      assert.ok(
        emitted.mock.calls.some(
          ([event, reply]) =>
            event === 'message' &&
            wire(reply) &&
            reply.status === 'ok' &&
            calls.some((call) => call.id === reply.id && call.operation === reply.operation)
        ),
        'actual matching native FULL acknowledgement, not callback success'
      );
    },
    restore() {
      emitted.mockRestore();
      sent.mockRestore();
    },
  };
}

/** Actual original producers own all fixture state; physical fixtures remain under Storage. */
async function fixture() {
  await shutdownControlStoreWorkerClient();
  const trace = observeNative();
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-security-alarm-publication-'));
  let coreDb = openCoreDb(dataRoot);
  let store: FsStore;
  async function close() {
    closeWorkspaceProductReadHandles(dataRoot);
    if (coreDb.sqlite.open && coreDb.sqlite.readonly) coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
  }
  onTestFinished(async () => {
    try {
      await close();
      rmSync(dataRoot, { recursive: true, force: true });
    } finally {
      trace.restore();
    }
  });
  applyMigrations(coreDb);
  store = new FsStore({ dataRoot });
  return {
    dataRoot,
    trace,
    get db() {
      return coreDb;
    },
    get store() {
      return store;
    },
    get trigger() {
      return new SecurityTriggerStore(coreDb);
    },
    tokens() {
      return createAccessTokenOperationImplementations({ coreDb, mode: 'server' });
    },
    async reopen() {
      await close();
      coreDb = openCoreDb(dataRoot);
      store = new FsStore({ dataRoot });
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function tokenActor(f: Fixture, secret: string): Promise<Actor> {
  const record = await verifyOpenKitAccessTokenRecord(f.db, secret);
  assert.ok(record);
  return {
    kind: 'token',
    userId: record.ownerUserId,
    tokenId: record.tokenId,
    tokenScope: record.scope,
    tokenWorkspaceIds: record.workspaceIds,
  };
}

/** Genuine bootstrap, Better Auth session, Token issuance and verifier create two actual administrators. */
async function server() {
  const f = await fixture();
  const bootstrap = await ensureServerBootstrapTokenForStartup(f.db);
  assert.ok(bootstrap);
  writeServerBootstrapTokenEmission(f.dataRoot, bootstrap);
  const owner = await f.tokens()['bootstrap.consume']({
    token: bootstrap.token,
    ownerUserId: allocateEntityId('usr'),
    displayName: 'Publication enabler',
    email: [randomUUID(), 'example.invalid'].join('@'),
    password: randomUUID(),
    tokenExpiresAt: EXPIRY,
  });
  const admin = await tokenActor(f, owner.token);
  const auth = createBetterAuth(f.db, {
    mode: 'local',
    env: { BETTER_AUTH_URL: 'https://auth.example.invalid' },
  });
  const created = await auth.api.signUpEmail({
    returnHeaders: true,
    body: {
      name: 'Publication recipient',
      email: [randomUUID(), 'example.invalid'].join('@'),
      password: randomUUID(),
    },
  });
  const cookies = created.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');
  const session = await auth.api.getSession({ headers: new Headers({ cookie: cookies }) });
  assert.ok(session);
  const human = actorFromSession(session);
  const issued = await f
    .tokens()
    ['token.create'](
      { ownerUserId: human.userId, scope: 'server-admin', workspaceIds: [], expiresAt: EXPIRY },
      context(admin)
    );
  const backup = await tokenActor(f, issued.token);
  return {
    f,
    admin,
    backup,
    adminTokenId: owner.record.tokenId,
    backupTokenId: issued.record.tokenId,
  };
}

describe('N3 stopping durability across actual native sibling current requests', () => {
  it('FULL-commits the original zero-admin stopping/R8 before a sibling current can FULL-commit off', async () => {
    observation.gate = new SharedArrayBuffer(12);
    observation.records = new SharedArrayBuffer((65 + 4096) * 4);
    const gate = new Int32Array(observation.gate);
    const records = new Int32Array(observation.records);
    const { f, admin, backupTokenId, adminTokenId } = await server();
    await f.trigger.enable(admin);
    await f.tokens()['token.revoke']({ tokenId: backupTokenId }, context(admin));
    await f.tokens()['token.revoke']({ tokenId: adminTokenId }, context(admin));
    const path = f.db.sqlite.name;
    assert.ok(path.length <= 4096);
    for (let i = 0; i < path.length; i++) Atomics.store(records, 65 + i, path.charCodeAt(i));
    Atomics.store(records, 64, path.length);
    Atomics.store(gate, 0, 1);
    Atomics.store(records, 0, 1);
    const concurrent = Promise.allSettled([f.trigger.current(), f.trigger.current()]);
    try {
      // Original scheduling seam only; both real messages enter the actual Worker. No invented cohort.
      await vi.waitFor(() => assert.equal(Atomics.load(records, 1), 2));
      Atomics.store(gate, 0, 0);
      const results = await concurrent;
      assert.deepEqual(
        results.map((result) => result.status),
        ['fulfilled', 'fulfilled']
      );
      Atomics.store(records, 0, 0);
      assert.equal(
        Atomics.load(records, 3),
        0,
        'observer errors are prerequisites, never invented native outcomes'
      );
      const count = Atomics.load(records, 2);
      const commits = Array.from({ length: Math.min(count, 8) }, (_, i) => ({
        state:
          Atomics.load(records, 4 + i * 4) === 1
            ? 'stopping'
            : Atomics.load(records, 4 + i * 4) === 2
              ? 'off'
              : 'other',
        synchronous: Atomics.load(records, 5 + i * 4),
        originalFailedR8: Atomics.load(records, 6 + i * 4),
      }));
      assert.deepEqual(
        commits,
        [
          { state: 'stopping', synchronous: 2, originalFailedR8: 1 },
          { state: 'off', synchronous: 2, originalFailedR8: 1 },
        ],
        'two REAL outer FULL commits: one coalesced off commit is not a durable stopping prefix'
      );
      assert.equal(
        count,
        2,
        'count actual SQLite COMMITs, never native reply callbacks/savepoints'
      );
      const snapshots = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : []
      );
      assert.deepEqual(
        snapshots.map((state) => state.state),
        ['stopping', 'off']
      );
      assert.ok(snapshots.every((state) => state.failedOutcome === 'no-current-administrator'));
      assert.deepEqual(await f.trigger.readAlarms(), []);
      const failed = f.db.sqlite
        .prepare(
          'SELECT rule,recipient_count AS recipientCount,failure FROM security_trigger_alarms ORDER BY created_at,id'
        )
        .all();
      assert.deepEqual(failed, [
        { rule: 'R8', recipientCount: 0, failure: 'no-current-administrator' },
      ]);
    } finally {
      Atomics.store(gate, 0, 0);
      Atomics.store(records, 0, 0);
      await concurrent;
      observation.gate = undefined;
      observation.records = undefined;
    }
  });
});

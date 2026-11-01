import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker as NativeWorker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { afterEach, expect, vi } from 'vitest';
import { createBetterAuth } from '../../auth/better-auth.js';
import { shutdownControlStoreWorkerClient } from '../control-store-worker-client.js';
import { openCoreDb } from '../db.js';
import { applyMigrations } from '../migrate.js';

const interception = vi.hoisted(() => ({
  workers: [] as NativeWorker[],
  gate: undefined as SharedArrayBuffer | undefined,
}));

// The existing native harness pattern intercepts actual SQLite boundaries in the real Worker.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        const require = createRequire(import.meta.url);
        const prelude = `
          const {workerData} = require('node:worker_threads');
          const Database = require(workerData.databaseModule);
          const originalExec = Database.prototype.exec;
          const gate = workerData.gate;
          function hold(point, ordinal) {
            if (Atomics.load(gate, 3) === point && Atomics.load(gate, 4) === ordinal &&
                Atomics.compareExchange(gate, 0, 0, 1) === 0)
              Atomics.wait(gate, 1, 0);
          }
          Database.prototype.exec = function(sql) {
            const ordinal = Atomics.load(gate, 2) + 1;
            if (/^BEGIN(?:\\s|$)/i.test(sql)) hold(3, ordinal);
            if (/^COMMIT$/i.test(sql)) {
              Atomics.store(gate, 5, this.pragma('synchronous', {simple: true}));
              hold(1, ordinal);
            }
            const result = originalExec.call(this, sql);
            if (/^COMMIT$/i.test(sql)) {
              Atomics.add(gate, 2, 1);
              hold(2, ordinal);
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
            databaseModule: require.resolve('better-sqlite3'),
            gate: new Int32Array(interception.gate!),
          },
        });
        interception.workers.push(this);
      }
    },
  };
});

/** The storage cases also observe and terminate the actual intercepted native thread. */
export const nativeInterception = interception;

const fixtures: Array<{ close(): void; mainWrites(): number }> = [];
export const baseURL = 'http://127.0.0.1:3000';
export const password = 'synthetic-password-for-native-auth';
/** Creates the configured SDK and actual Core store; fixture SQL never enters the product wire. */
export async function fixture(options: Parameters<typeof createBetterAuth>[1] = {}) {
  const root = mkdtempSync(join(tmpdir(), 'better-auth-native-'));
  const db = openCoreDb(root);
  applyMigrations(db);
  interception.gate = new SharedArrayBuffer(24);
  const gate = new Int32Array(interception.gate);
  const originalPrepare = Database.prototype.prepare;
  const originalExec = Database.prototype.exec;
  let mainWrites = 0;
  const deny = (sql: string) => {
    if (
      /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(sql) &&
      /\b(?:users|account|session|verification)\b/iu.test(sql)
    ) {
      mainWrites++;
      throw new Error('Browser authentication mutation executed on Main.');
    }
  };
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    deny(sql);
    return originalPrepare.call(this, sql);
  });
  vi.spyOn(Database.prototype, 'exec').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    deny(sql);
    return originalExec.call(this, sql);
  });
  const auth = createBetterAuth(db, {
    env: { BETTER_AUTH_URL: baseURL },
    ...options,
  });
  const context = await auth.$context;
  // Expected SDK failures must not publish private request or credential values.
  vi.spyOn(context.logger, 'error').mockImplementation(() => {});
  vi.spyOn(context.logger, 'warn').mockImplementation(() => {});
  const request = (path: string, body?: unknown, cookie = '') =>
    auth.handler(
      new Request(`${baseURL}/api/auth${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', cookie },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    );
  const signUp = async (email = `${randomUUID()}@example.test`) => {
    const response = await request('/sign-up/email', { email, name: 'Synthetic User', password });
    expect(response.status).toBe(200);
    const value = await response.json();
    return { id: String(value.user.id), email, cookie: cookies(response) };
  };
  fixtures.push({
    mainWrites: () => mainWrites,
    close() {
      db.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    },
  });
  return {
    auth,
    context,
    db,
    gate,
    request,
    signUp,
    // This storage-owner fixture seeds retained artifacts and deliberate post-setup faults only.
    fixtureSql: (sql: string): Database.Statement => originalPrepare.call(db.sqlite, sql),
    count: (table: 'users' | 'account' | 'session' | 'verification') =>
      db.sqlite.prepare(`SELECT count(*) FROM "${table}"`).pluck().get() as number,
    commits: () => Atomics.load(gate, 2),
  };
}

/** Exposes the real callback fixture with fixed observations and no database or SQL handle. */
export async function callbackFixture() {
  const f = await fixture();
  return {
    context: { secret: f.context.secret },
    request: f.request,
    signUp: f.signUp,
    count: (table: 'session') => f.count(table),
    readEmailVerification(userId: string): { email: string; email_verified: number } | undefined {
      return f.db.sqlite
        .prepare('SELECT email, email_verified FROM users WHERE id = ?')
        .get(userId) as { email: string; email_verified: number } | undefined;
    },
  };
}

/** Keeps synthetic cookies only in memory; no assertion prints their contents. */
export function cookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}

/** Releases only this fixture's native thread. */
export function release(gate: Int32Array): void {
  Atomics.store(gate, 1, 1);
  Atomics.notify(gate, 1);
}

afterEach(async () => {
  if (interception.gate) release(new Int32Array(interception.gate));
  await shutdownControlStoreWorkerClient();
  for (const worker of interception.workers.splice(0)) await worker.terminate();
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    const writes = f.mainWrites();
    f.close();
    expect(writes).toBe(0);
  }
  interception.gate = undefined;
});

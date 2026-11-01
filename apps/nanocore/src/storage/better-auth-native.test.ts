import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { allocateEntityId } from '@openkit/protocol';
import { createEmailVerificationToken } from 'better-auth/api';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBetterAuth } from '../auth/better-auth.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';

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

const fixtures: Array<{ close(): void; mainWrites(): number }> = [];
const baseURL = 'http://127.0.0.1:3000';
const password = 'synthetic-password-for-native-auth';
const replacementPassword = 'synthetic-replacement-for-native-auth';

/** Creates the configured SDK and actual Core store; fixture SQL never enters the product wire. */
async function fixture(options: Parameters<typeof createBetterAuth>[1] = {}) {
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
    fixtureSql: (sql: string) => originalPrepare.call(db.sqlite, sql),
    count: (table: 'users' | 'account' | 'session' | 'verification') =>
      db.sqlite.prepare(`SELECT count(*) FROM "${table}"`).pluck().get() as number,
    commits: () => Atomics.load(gate, 2),
  };
}

/** Keeps synthetic cookies only in memory; no assertion prints their contents. */
function cookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}

/** Arms one real SQLite boundary after the already acknowledged prefix. */
function arm(gate: Int32Array, point: 1 | 2 | 3, ordinal = Atomics.load(gate, 2) + 1): void {
  Atomics.store(gate, 0, 0);
  Atomics.store(gate, 1, 0);
  Atomics.store(gate, 3, point);
  Atomics.store(gate, 4, ordinal);
}

/** Releases only this fixture's native thread. */
function release(gate: Int32Array): void {
  Atomics.store(gate, 1, 1);
  Atomics.notify(gate, 1);
}

/** Observes a request without an unhandled rejection and detects failure to reach the real hold. */
async function held<T>(f: Awaited<ReturnType<typeof fixture>>, work: () => Promise<T>) {
  let settled = false;
  const result = Promise.resolve()
    .then(work)
    .then(
      (response) => {
        settled = true;
        return response;
      },
      () => {
        settled = true;
        return null;
      }
    );
  while (Atomics.load(f.gate, 0) === 0 && !settled) await nextTurn();
  expect(Atomics.load(f.gate, 0)).toBe(1);
  expect(settled).toBe(false);
  return { result };
}

/** Seeds a retained, non-credential account in the table owned by this storage test. */
function retainedAccount(f: Awaited<ReturnType<typeof fixture>>, userId: string) {
  const id = allocateEntityId('acct');
  const accountId = randomUUID();
  const now = Date.now();
  f.fixtureSql(`INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at)
    VALUES (?, ?, 'retained-provider', ?, 'inert-retained-value', ?, ?)`).run(
    id,
    accountId,
    userId,
    now,
    now
  );
  return { id, accountId };
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

describe('configured BetterAuth native writer', () => {
  it('preserves signup stages, SQLite profile conversions, password change and exact session ownership', async () => {
    const f = await fixture();
    const user = await f.signUp();
    // Installed SDK transaction:false keeps User, account and session as three durable stages.
    expect(f.commits()).toBe(3);
    expect(Atomics.load(f.gate, 5)).toBe(2);
    expect(
      f.db.sqlite
        .prepare(
          'SELECT kind, status, email_verified, image, typeof(created_at) AS created_type FROM users WHERE id = ?'
        )
        .get(user.id)
    ).toEqual({
      kind: 'human',
      status: 'active',
      email_verified: 0,
      image: null,
      created_type: 'integer',
    });
    expect((await f.request('/update-user', { name: 42, image: 99 }, user.cookie)).status).toBe(
      200
    );
    // Original configured SDK + SQLite TEXT affinity, not JavaScript String conversion.
    expect(
      f.db.sqlite.prepare('SELECT display_name, image FROM users WHERE id = ?').get(user.id)
    ).toEqual({ display_name: '42.0', image: '99.0' });
    expect((await f.request('/update-user', { image: null }, user.cookie)).status).toBe(200);
    expect(
      f.db.sqlite.prepare('SELECT display_name, image FROM users WHERE id = ?').get(user.id)
    ).toEqual({ display_name: '42.0', image: null });
    const other = await f.signUp();
    await f.request('/sign-in/email', { email: user.email, password });
    const beforeChange = f.commits();
    const changed = await f.request(
      '/change-password',
      {
        currentPassword: password,
        newPassword: replacementPassword,
        revokeOtherSessions: true,
      },
      user.cookie
    );
    expect(changed.status).toBe(200);
    expect(f.commits() - beforeChange).toBe(3);
    const currentCookie = cookies(changed);
    const foreignToken = f.db.sqlite
      .prepare('SELECT token FROM session WHERE user_id = ?')
      .pluck()
      .get(other.id) as string;
    expect(
      (await f.request('/revoke-session', { token: foreignToken }, currentCookie)).status
    ).toBe(200);
    expect(f.count('session')).toBe(2);
    await f.request('/sign-in/email', { email: user.email, password: replacementPassword });
    expect((await f.request('/revoke-other-sessions', {}, currentCookie)).status).toBe(200);
    expect(f.count('session')).toBe(2);
    expect((await f.request('/revoke-sessions', {}, currentCookie)).status).toBe(200);
    expect(f.db.sqlite.prepare('SELECT user_id FROM session').all()).toEqual([
      { user_id: other.id },
    ]);
    expect((await f.request('/sign-out', {}, other.cookie)).status).toBe(200);
    expect(f.count('session')).toBe(0);
  });

  it('refreshes and expires only the addressed session through the native owner', async () => {
    const f = await fixture();
    const user = await f.signUp();
    const other = await f.signUp();
    const due = Date.now() + 60_000;
    f.fixtureSql('UPDATE session SET expires_at = ? WHERE user_id = ?').run(due, user.id);
    expect((await f.request('/get-session', undefined, user.cookie)).status).toBe(200);
    const refreshed = f.db.sqlite
      .prepare('SELECT expires_at FROM session WHERE user_id = ?')
      .pluck()
      .get(user.id) as number;
    expect(refreshed).toBeGreaterThan(due);
    f.fixtureSql('UPDATE session SET expires_at = ? WHERE user_id = ?').run(
      Date.now() - 1,
      user.id
    );
    const expired = await f.request('/get-session', undefined, user.cookie);
    expect(await expired.json()).toBeNull();
    expect(f.db.sqlite.prepare('SELECT user_id FROM session').all()).toEqual([
      { user_id: other.id },
    ]);
  });

  it('refuses to refresh a session that expires during its native wait', async () => {
    const f = await fixture();
    const user = await f.signUp();
    f.fixtureSql('UPDATE session SET expires_at = ? WHERE user_id = ?').run(
      Date.now() + 60_000,
      user.id
    );
    arm(f.gate, 3);
    const { result } = await held(f, () => f.request('/get-session', undefined, user.cookie));
    const expired = Date.now() - 1;
    try {
      f.fixtureSql('UPDATE session SET expires_at = ? WHERE user_id = ?').run(expired, user.id);
    } finally {
      release(f.gate);
    }
    const response = await result;
    const body = await response?.json();
    expect.soft(body === null || body?.code === 'FAILED_TO_GET_SESSION').toBe(true);
    expect
      .soft(response?.headers.getSetCookie().every((value) => value.includes('Max-Age=0')))
      .toBe(true);
    expect(
      f.db.sqlite.prepare('SELECT expires_at FROM session WHERE user_id = ?').pluck().get(user.id)
    ).toBe(expired);
  });

  it('preserves a session renewed while expired-session cleanup waits for native execution', async () => {
    const f = await fixture();
    const user = await f.signUp();
    f.fixtureSql('UPDATE session SET expires_at = ? WHERE user_id = ?').run(
      Date.now() - 1,
      user.id
    );
    arm(f.gate, 3);
    const { result } = await held(f, () => f.request('/get-session', undefined, user.cookie));
    const renewed = Date.now() + 60_000;
    try {
      f.fixtureSql('UPDATE session SET expires_at = ? WHERE user_id = ?').run(renewed, user.id);
    } finally {
      release(f.gate);
    }
    const response = await result;
    expect(await response?.json()).toBeNull();
    expect(response?.headers.getSetCookie().every((value) => value.includes('Max-Age=0'))).toBe(
      true
    );
    expect(
      f.db.sqlite.prepare('SELECT expires_at FROM session WHERE user_id = ?').pluck().get(user.id)
    ).toBe(renewed);
  });

  it('preserves signout cookie clearing when the SDK swallows a native delete failure', async () => {
    const f = await fixture();
    const user = await f.signUp();
    f.fixtureSql(`CREATE TRIGGER reject_signout BEFORE DELETE ON session
      BEGIN SELECT RAISE(ABORT, 'synthetic signout fault'); END`).run();
    const response = await f.request('/sign-out', {}, user.cookie);
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie().some((value) => value.includes('Max-Age=0'))).toBe(true);
    expect(f.count('session')).toBe(1);
  });

  it('keeps valid older sessions usable for profile, password and session revocation', async () => {
    const f = await fixture();
    const user = await f.signUp();
    const signedIn = await f.request('/sign-in/email', { email: user.email, password });
    expect(signedIn.status).toBe(200);
    const { token } = await signedIn.json();
    f.fixtureSql('UPDATE session SET created_at = ? WHERE user_id = ?').run(
      Date.now() - (f.context.sessionConfig.freshAge + 60) * 1000,
      user.id
    );
    expect(
      (await f.request('/update-user', { name: 'Valid older session' }, user.cookie)).status
    ).toBe(200);
    expect(
      (
        await f.request(
          '/change-password',
          { currentPassword: password, newPassword: replacementPassword },
          user.cookie
        )
      ).status
    ).toBe(200);
    expect((await f.request('/revoke-session', { token }, user.cookie)).status).toBe(200);
    expect(f.count('session')).toBe(1);
  });

  it.each([
    false,
    true,
  ])('consumes a valid retained reset with missing credential account: %s', async (missing) => {
    const f = await fixture();
    const user = await f.signUp();
    const other = await f.signUp();
    const retained = retainedAccount(f, user.id);
    if (missing) f.fixtureSql('DELETE FROM account WHERE user_id = ?').run(user.id);
    const reset = randomUUID();
    const identifier = `reset-password:${reset}`;
    const now = Date.now();
    for (const [key, value, expiry] of [
      [identifier, user.id, now + 60_000],
      ['expired-fixture', user.id, now - 1],
      ['unrelated-fixture', other.id, now + 60_000],
    ] as const) {
      f.fixtureSql(`INSERT INTO verification (id, identifier, value, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(allocateEntityId('verif'), key, value, expiry, now, now);
    }
    expect(
      (await f.request('/reset-password', { token: reset, newPassword: replacementPassword }))
        .status
    ).toBe(200);
    expect(f.db.sqlite.prepare('SELECT identifier FROM verification').all()).toEqual([
      { identifier: 'unrelated-fixture' },
    ]);
    expect(
      (await f.request('/sign-in/email', { email: user.email, password: replacementPassword }))
        .status
    ).toBe(200);
    expect((await f.request('/sign-in/email', { email: user.email, password })).status).toBe(401);
    expect((await f.request('/sign-in/email', { email: other.email, password })).status).toBe(200);
    expect(f.count('account')).toBe(missing ? 2 : 3);
    if (!missing) {
      expect(
        f.db.sqlite.prepare('SELECT password FROM account WHERE id = ?').pluck().get(retained.id)
      ).toBe('inert-retained-value');
    }
  });

  it.each([
    'password',
    'verification-delete',
  ] as const)('preserves completed retained-reset stages when %s fails', async (stage) => {
    const f = await fixture();
    const user = await f.signUp();
    const reset = randomUUID();
    const identifier = `reset-password:${reset}`;
    const now = Date.now();
    for (const [key, expiry] of [
      [identifier, now + 60_000],
      ['expired-fixture', now - 1],
    ] as const) {
      f.fixtureSql(`INSERT INTO verification (id, identifier, value, expires_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)`).run(
        allocateEntityId('verif'),
        key,
        user.id,
        expiry,
        now,
        now
      );
    }
    f.fixtureSql(
      stage === 'password'
        ? `CREATE TRIGGER reject_reset BEFORE UPDATE ON account
              BEGIN SELECT RAISE(ABORT, 'synthetic password fault'); END`
        : `CREATE TRIGGER reject_reset BEFORE DELETE ON verification
              WHEN OLD.identifier LIKE 'reset-password:%'
              BEGIN SELECT RAISE(ABORT, 'synthetic verification fault'); END`
    ).run();
    const response = await f.request('/reset-password', {
      token: reset,
      newPassword: replacementPassword,
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(f.db.sqlite.prepare('SELECT identifier FROM verification').all()).toEqual([
      { identifier },
    ]);
    const hash = f.db.sqlite.prepare('SELECT password FROM account').pluck().get() as string;
    expect(
      await f.context.password.verify({
        hash,
        password: stage === 'password' ? password : replacementPassword,
      })
    ).toBe(true);
    expect(f.count('session')).toBe(1);
  });

  it.each([
    'reset',
    'oauth',
  ])('cleans expired verification state even when %s cannot authenticate', async (route) => {
    const f = await fixture();
    const now = Date.now();
    f.fixtureSql(`INSERT INTO verification (id, identifier, value, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      allocateEntityId('verif'),
      'expired-fixture',
      'inert',
      now - 1,
      now,
      now
    );
    const response =
      route === 'reset'
        ? await f.request('/reset-password', {
            token: 'absent-fixture',
            newPassword: replacementPassword,
          })
        : await f.request('/callback/absent-provider?state=absent-fixture&code=inert');
    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(f.count('verification')).toBe(0);
    expect(f.count('session')).toBe(0);
  });

  it.each([
    'verify',
    'replace-unverified',
    'replace-verified',
  ] as const)('retains the signed callback stage: %s', async (branch) => {
    const f = await fixture();
    const user = await f.signUp();
    const replacement = `${randomUUID()}@example.test`;
    const token = await createEmailVerificationToken(
      f.context.secret,
      user.email.toUpperCase(),
      branch === 'verify' ? undefined : replacement,
      3600,
      branch === 'replace-verified' ? { requestType: 'change-email-verification' } : undefined
    );
    const response = await f.request(`/verify-email?token=${encodeURIComponent(token)}`);
    expect(response.status).toBe(200);
    const row = f.db.sqlite
      .prepare('SELECT email, email_verified FROM users WHERE id = ?')
      .get(user.id);
    expect(row).toEqual({
      email: branch === 'verify' ? user.email : replacement,
      email_verified: branch === 'replace-unverified' ? 0 : 1,
    });
    expect(f.count('session')).toBe(branch === 'verify' ? 1 : 2);
  });

  it('consumes exact retained OAuth state before the unavailable provider refusal', async () => {
    const f = await fixture();
    const state = randomUUID();
    const now = Date.now();
    const value = JSON.stringify({
      callbackURL: baseURL,
      codeVerifier: 'synthetic-retained-verifier',
      expiresAt: now + 60_000,
      oauthState: state,
    });
    for (const identifier of [state, 'unrelated-state']) {
      f.fixtureSql(`INSERT INTO verification (id, identifier, value, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(
        allocateEntityId('verif'),
        identifier,
        value,
        now + 60_000,
        now,
        now
      );
    }
    const signature = createHmac('sha256', f.context.secret).update(state).digest('base64');
    const cookie = `${f.context.createAuthCookie('state').name}=${encodeURIComponent(`${state}.${signature}`)}`;
    const response = await f.request(
      `/callback/absent-provider?state=${state}&code=inert`,
      undefined,
      cookie
    );
    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(f.db.sqlite.prepare('SELECT identifier FROM verification').all()).toEqual([
      { identifier: 'unrelated-state' },
    ]);
    expect(f.count('session')).toBe(0);
  });

  it('unlinks only the owned account through the actual hook context after FULL acknowledgement', async () => {
    const f = await fixture();
    const user = await f.signUp();
    const other = await f.signUp();
    const selected = retainedAccount(f, user.id);
    const foreign = retainedAccount(f, other.id);
    const hook = f.context.options.databaseHooks!.account!.delete!;
    const before = hook.before!;
    const observations: Array<{ contextMatches: boolean; result: unknown; retained: number }> = [];
    const after = vi.fn(async () => {});
    hook.after = after;
    hook.before = async (account, context) => {
      const contextMatches =
        context?.path === '/unlink-account' &&
        context.context.session?.user.id === user.id &&
        account.id === selected.id;
      const result = await before(account, context);
      const retained = f.db.sqlite
        .prepare('SELECT count(*) FROM account WHERE id = ?')
        .pluck()
        .get(selected.id) as number;
      observations.push({ contextMatches, result, retained });
      return result;
    };
    // An already absent row invokes neither delete hook and needs no endpoint context.
    const prior = f.commits();
    await f.context.internalAdapter.deleteAccount(allocateEntityId('acct'));
    expect(f.commits()).toBe(prior);
    expect(observations).toEqual([]);
    expect(after).not.toHaveBeenCalled();
    expect(
      (
        await f.request(
          '/unlink-account',
          {
            providerId: 'retained-provider',
            accountId: foreign.accountId,
          },
          user.cookie
        )
      ).status
    ).toBe(400);
    arm(f.gate, 1);
    const { result } = await held(f, () =>
      f.request(
        '/unlink-account',
        {
          providerId: 'retained-provider',
          accountId: selected.accountId,
        },
        user.cookie
      )
    );
    try {
      expect(observations).toEqual([]);
      expect(f.count('account')).toBe(4);
      expect(Atomics.load(f.gate, 5)).toBe(2);
    } finally {
      release(f.gate);
    }
    expect((await result)?.status).toBe(200);
    expect(observations).toEqual([{ contextMatches: true, result: false, retained: 0 }]);
    expect(after).not.toHaveBeenCalled();
    expect(f.count('account')).toBe(3);
    expect(
      (await f.request('/unlink-account', { providerId: 'credential' }, user.cookie)).status
    ).toBe(400);
  });

  it.each([
    'absent',
    'owner',
    'last-account',
    'revoked-session',
    'stale-session',
  ] as const)('rechecks unlink authority after native admission waits: %s', async (change) => {
    const f = await fixture();
    const user = await f.signUp();
    const other = await f.signUp();
    const selected = retainedAccount(f, user.id);
    arm(f.gate, 3);
    const { result } = await held(f, () =>
      f.request(
        '/unlink-account',
        {
          providerId: 'retained-provider',
          accountId: selected.accountId,
        },
        user.cookie
      )
    );
    try {
      if (change === 'absent') f.fixtureSql('DELETE FROM account WHERE id = ?').run(selected.id);
      if (change === 'owner')
        f.fixtureSql('UPDATE account SET user_id = ? WHERE id = ?').run(other.id, selected.id);
      if (change === 'last-account')
        f.fixtureSql("DELETE FROM account WHERE user_id = ? AND provider_id = 'credential'").run(
          user.id
        );
      if (change === 'revoked-session')
        f.fixtureSql('DELETE FROM session WHERE user_id = ?').run(user.id);
      if (change === 'stale-session')
        f.fixtureSql('UPDATE session SET created_at = ? WHERE user_id = ?').run(
          Date.now() - (f.context.sessionConfig.freshAge + 1) * 1000,
          user.id
        );
    } finally {
      release(f.gate);
    }
    const response = await result;
    expect(response?.status).toBe(
      change === 'absent'
        ? 200
        : change === 'revoked-session'
          ? 401
          : change === 'stale-session'
            ? 403
            : 400
    );
    if (change !== 'absent') {
      expect(await response?.json()).toMatchObject({
        code:
          change === 'owner'
            ? 'ACCOUNT_NOT_FOUND'
            : change === 'last-account'
              ? 'FAILED_TO_UNLINK_LAST_ACCOUNT'
              : change === 'revoked-session'
                ? 'UNAUTHORIZED'
                : 'SESSION_NOT_FRESH',
      });
    }
    expect(
      f.db.sqlite.prepare('SELECT count(*) FROM account WHERE id = ?').pluck().get(selected.id)
    ).toBe(change === 'absent' ? 0 : 1);
  });

  it.each([
    'password',
    'delete-sessions',
    'replacement-session',
  ] as const)('retains prior password stages when %s fails', async (stage) => {
    const f = await fixture();
    const user = await f.signUp();
    await f.request('/sign-in/email', { email: user.email, password });
    const event =
      stage === 'password'
        ? 'UPDATE ON account'
        : stage === 'delete-sessions'
          ? 'DELETE ON session'
          : 'INSERT ON session';
    f.fixtureSql(`CREATE TRIGGER reject_password_stage BEFORE ${event}
        BEGIN SELECT RAISE(ABORT, 'Synthetic password stage failure'); END`).run();
    const response = await f.request(
      '/change-password',
      {
        currentPassword: password,
        newPassword: replacementPassword,
        revokeOtherSessions: true,
      },
      user.cookie
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(cookies(response).length).toBe(0);
    const hash = f.db.sqlite
      .prepare("SELECT password FROM account WHERE user_id = ? AND provider_id = 'credential'")
      .pluck()
      .get(user.id) as string;
    expect(
      await f.context.password.verify({
        hash,
        password: stage === 'password' ? password : replacementPassword,
      })
    ).toBe(true);
    expect(f.count('session')).toBe(stage === 'replacement-session' ? 0 : 2);
  });

  it('refuses unconfigured mutation and predicate shapes without a Main fallback', async () => {
    const f = await fixture();
    const user = await f.signUp();
    const now = new Date();
    const attempts = [
      () =>
        f.context.adapter.create({
          model: 'verification',
          data: {
            identifier: 'unissued',
            value: 'inert',
            expiresAt: now,
          },
        }),
      () =>
        f.context.adapter.update({
          model: 'verification',
          where: [{ field: 'identifier', value: 'unissued' }],
          update: { value: 'changed' },
        }),
      () => f.context.adapter.delete({ model: 'user', where: [{ field: 'id', value: user.id }] }),
      () =>
        f.context.adapter.delete({
          model: 'account',
          where: [{ field: 'userId', value: user.id }],
        }),
      () =>
        f.context.adapter.update({
          model: 'user',
          where: [{ field: 'id', value: user.id }],
          update: { status: 'disabled' },
        }),
      () =>
        f.context.adapter.deleteMany({
          model: 'session',
          where: [{ field: 'userId', value: user.id, operator: 'ne' }],
        }),
      () =>
        f.context.adapter.updateMany({
          model: 'account',
          where: [
            { field: 'userId', value: user.id },
            { field: 'providerId', value: 'retained-provider' },
          ],
          update: { password: 'inert', updatedAt: now },
        }),
    ];
    const commits = f.commits();
    for (const attempt of attempts) await expect(attempt()).rejects.toThrow();
    expect(f.commits()).toBe(commits);
    expect([
      f.count('users'),
      f.count('account'),
      f.count('session'),
      f.count('verification'),
    ]).toEqual([1, 1, 1, 0]);
  });

  it.each([
    'profile',
    'password',
    'revoke-one',
    'revoke-all',
    'revoke-other',
  ] as const)('refuses an authenticated effect after its initiating session is revoked during a native wait: %s', async (operation) => {
    const f = await fixture();
    const user = await f.signUp();
    const initiating = f.db.sqlite
      .prepare('SELECT token FROM session WHERE user_id = ?')
      .pluck()
      .get(user.id) as string;
    await f.request('/sign-in/email', { email: user.email, password });
    const target = f.db.sqlite
      .prepare('SELECT token FROM session WHERE user_id = ? AND token != ?')
      .pluck()
      .get(user.id, initiating) as string;
    const path =
      operation === 'profile'
        ? '/update-user'
        : operation === 'password'
          ? '/change-password'
          : operation === 'revoke-one'
            ? '/revoke-session'
            : operation === 'revoke-all'
              ? '/revoke-sessions'
              : '/revoke-other-sessions';
    const body =
      operation === 'profile'
        ? { name: 'Unauthorized profile' }
        : operation === 'password'
          ? { currentPassword: password, newPassword: replacementPassword }
          : operation === 'revoke-one'
            ? { token: target }
            : {};
    arm(f.gate, 3);
    const { result } = await held(f, () => f.request(path, body, user.cookie));
    try {
      // Revoke only the initiating session after SDK admission, before native SQL begins.
      f.fixtureSql('DELETE FROM session WHERE token = ?').run(initiating);
    } finally {
      release(f.gate);
    }
    const response = await result;
    expect.soft(response?.status).toBeGreaterThanOrEqual(400);
    expect.soft(response && cookies(response).length).toBe(0);
    expect
      .soft(f.db.sqlite.prepare('SELECT display_name FROM users WHERE id = ?').pluck().get(user.id))
      .toBe('Synthetic User');
    expect.soft(f.count('session')).toBe(1);
    const hash = f.db.sqlite
      .prepare("SELECT password FROM account WHERE user_id = ? AND provider_id = 'credential'")
      .pluck()
      .get(user.id) as string;
    expect(await f.context.password.verify({ hash, password })).toBe(true);
  });

  it('refuses password replacement when the selected account changes owner during a native wait', async () => {
    const f = await fixture();
    const user = await f.signUp();
    const other = await f.signUp();
    const accountId = f.db.sqlite
      .prepare('SELECT id FROM account WHERE user_id = ?')
      .pluck()
      .get(user.id) as string;
    arm(f.gate, 3);
    const { result } = await held(f, () =>
      f.request(
        '/change-password',
        {
          currentPassword: password,
          newPassword: replacementPassword,
        },
        user.cookie
      )
    );
    try {
      f.fixtureSql('UPDATE account SET user_id = ? WHERE id = ?').run(other.id, accountId);
    } finally {
      release(f.gate);
    }
    expect.soft((await result)?.status).toBeGreaterThanOrEqual(400);
    const hash = f.db.sqlite
      .prepare('SELECT password FROM account WHERE id = ?')
      .pluck()
      .get(accountId) as string;
    expect(await f.context.password.verify({ hash, password })).toBe(true);
  });

  it.each([
    'revoked-session',
    'competing-password',
    'empty-password',
  ] as const)('rechecks actual virtual setPassword authority after the native wait: %s', async (change) => {
    const f = await fixture();
    const user = await f.signUp();
    const existing = f.db.sqlite
      .prepare('SELECT id, password FROM account WHERE user_id = ?')
      .get(user.id) as { id: string; password: string };
    f.fixtureSql('UPDATE account SET password = NULL WHERE id = ?').run(existing.id);
    arm(f.gate, 3);
    const { result } = await held(f, () =>
      f.auth.api.setPassword({
        headers: new Headers({ cookie: user.cookie }),
        body: { newPassword: replacementPassword },
        asResponse: true,
      })
    );
    try {
      if (change === 'revoked-session')
        f.fixtureSql('DELETE FROM session WHERE user_id = ?').run(user.id);
      else
        f.fixtureSql('UPDATE account SET password = ? WHERE id = ?').run(
          change === 'competing-password' ? existing.password : '',
          existing.id
        );
    } finally {
      release(f.gate);
    }
    const response = await result;
    expect
      .soft(response?.status)
      .toBe(change === 'empty-password' ? 200 : change === 'revoked-session' ? 401 : 400);
    expect.soft(f.count('account')).toBe(change === 'empty-password' ? 2 : 1);
    if (change === 'empty-password') {
      const hash = f.db.sqlite
        .prepare('SELECT password FROM account WHERE user_id = ? AND id != ?')
        .pluck()
        .get(user.id, existing.id) as string;
      expect(await f.context.password.verify({ hash, password: replacementPassword })).toBe(true);
    } else {
      expect(await response?.json()).toMatchObject({
        code: change === 'revoked-session' ? 'UNAUTHORIZED' : 'PASSWORD_ALREADY_SET',
      });
    }
  });

  it('preserves configured SDK profile input above one MiB within the existing pending budget', async () => {
    const f = await fixture();
    const user = await f.signUp();
    const length = 1024 * 1024 + 1;
    const response = await f.request('/update-user', { name: 'x'.repeat(length) }, user.cookie);
    expect.soft(response.status).toBe(200);
    expect(
      f.db.sqlite
        .prepare('SELECT length(display_name) FROM users WHERE id = ?')
        .pluck()
        .get(user.id)
    ).toBe(length);
  });

  it('keeps exact selected SDK fields and missing-row results on the configured adapter', async () => {
    const f = await fixture();
    const user = await f.signUp();
    const updated = await f.context.adapter.update({
      model: 'user',
      where: [{ field: 'id', value: user.id }],
      update: { name: 'Selected profile' },
    });
    expect(updated).toMatchObject({ id: user.id, name: 'Selected profile', image: null });
    expect(updated?.createdAt instanceof Date).toBe(true);
    expect(updated?.updatedAt instanceof Date).toBe(true);
    const selected = await f.context.adapter.findOne({
      model: 'user',
      where: [{ field: 'id', value: user.id }],
      select: ['id', 'name'],
    });
    expect(selected).toEqual({ id: user.id, name: 'Selected profile' });
    expect(
      await f.context.adapter.update({
        model: 'user',
        where: [{ field: 'id', value: allocateEntityId('usr') }],
        update: { name: 'Absent profile' },
      })
    ).toBeNull();
  });

  it('returns the exact committed full row when a later write precedes acknowledgement', async () => {
    const f = await fixture();
    const user = await f.signUp();
    arm(f.gate, 2);
    const { result } = await held(f, () =>
      f.context.adapter.update({
        model: 'user',
        where: [{ field: 'id', value: user.id }],
        update: { name: 'Committed profile' },
      })
    );
    try {
      // Fault injection between the real commit and reply exposes any post-ACK reread.
      f.fixtureSql('UPDATE users SET display_name = ? WHERE id = ?').run('Later profile', user.id);
    } finally {
      release(f.gate);
    }
    expect(await result).toMatchObject({ id: user.id, name: 'Committed profile', image: null });
    expect(
      f.db.sqlite.prepare('SELECT display_name FROM users WHERE id = ?').pluck().get(user.id)
    ).toBe('Later profile');
  });

  it.each([
    1, 2, 3,
  ])('withholds signup cookies and result before FULL commit %s', async (ordinal) => {
    const f = await fixture();
    arm(f.gate, 1, ordinal);
    let settled = false;
    const result = f
      .request('/sign-up/email', {
        email: `${randomUUID()}@example.test`,
        name: 'Synthetic User',
        password,
      })
      .finally(() => {
        settled = true;
      });
    try {
      while (Atomics.load(f.gate, 0) === 0 && !settled) await nextTurn();
      expect(Atomics.load(f.gate, 0)).toBe(1);
      expect(settled).toBe(false);
      expect(Atomics.load(f.gate, 5)).toBe(2);
      expect([f.count('users'), f.count('account'), f.count('session')]).toEqual([
        Number(ordinal > 1),
        Number(ordinal > 2),
        0,
      ]);
    } finally {
      release(f.gate);
    }
    const response = await result;
    expect(response.status).toBe(200);
    expect(cookies(response).length > 0).toBe(true);
    expect(f.commits()).toBe(3);
  });

  it.each([
    'users',
    'account',
    'session',
  ] as const)('retains only earlier signup commits when %s insertion fails', async (table) => {
    const f = await fixture();
    f.fixtureSql(`CREATE TRIGGER reject_signup BEFORE INSERT ON "${table}"
        BEGIN SELECT RAISE(ABORT, 'Synthetic signup stage failure'); END`).run();
    const response = await f.request('/sign-up/email', {
      email: `${randomUUID()}@example.test`,
      name: 'Synthetic User',
      password,
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(cookies(response).length).toBe(0);
    expect([f.count('users'), f.count('account'), f.count('session')]).toEqual([
      Number(table !== 'users'),
      Number(table === 'session'),
      0,
    ]);
  });

  it('refuses a new session when its User is disabled during awaited provisioning', async () => {
    const entered = Promise.withResolvers<string>();
    const finish = Promise.withResolvers<void>();
    const f = await fixture({
      onActiveUserSession: async (id) => {
        entered.resolve(id);
        await finish.promise;
      },
    });
    const result = f.request('/sign-up/email', {
      email: `${randomUUID()}@example.test`,
      name: 'Synthetic User',
      password,
    });
    try {
      const id = await entered.promise;
      f.fixtureSql("UPDATE users SET status = 'disabled', disabled_at = ? WHERE id = ?").run(
        new Date().toISOString(),
        id
      );
    } finally {
      finish.resolve();
    }
    const response = await result;
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(cookies(response).length).toBe(0);
    expect([f.count('users'), f.count('account'), f.count('session')]).toEqual([1, 1, 0]);
  });

  it('rechecks the active User after the native session stage waits to begin', async () => {
    const f = await fixture();
    arm(f.gate, 3, 3);
    const { result } = await held(f, () =>
      f.request('/sign-up/email', {
        email: `${randomUUID()}@example.test`,
        name: 'Synthetic User',
        password,
      })
    );
    try {
      expect([f.count('users'), f.count('account'), f.count('session')]).toEqual([1, 1, 0]);
      f.fixtureSql("UPDATE users SET status = 'disabled', disabled_at = ?").run(
        new Date().toISOString()
      );
    } finally {
      release(f.gate);
    }
    const response = await result;
    expect(response?.status).toBeGreaterThanOrEqual(400);
    expect(response && cookies(response).length).toBe(0);
    expect([f.count('users'), f.count('account'), f.count('session')]).toEqual([1, 1, 0]);
  });

  it('keeps a committed signup prefix after acknowledgement loss without automatic retry', async () => {
    const f = await fixture();
    arm(f.gate, 2, 1);
    let settled = false;
    const result = f
      .request('/sign-up/email', {
        email: `${randomUUID()}@example.test`,
        name: 'Synthetic User',
        password,
      })
      .finally(() => {
        settled = true;
      });
    while (Atomics.load(f.gate, 0) === 0 && !settled) await nextTurn();
    expect(Atomics.load(f.gate, 0)).toBe(1);
    expect(settled).toBe(false);
    expect([f.count('users'), f.count('account'), f.count('session')]).toEqual([1, 0, 0]);
    await interception.workers[0]!.terminate();
    const response = await result;
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(cookies(response).length).toBe(0);
    expect(interception.workers).toHaveLength(1);
    expect([f.count('users'), f.count('account'), f.count('session')]).toEqual([1, 0, 0]);
  });
});

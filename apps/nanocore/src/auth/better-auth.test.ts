import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';

import { describe, expect, it, vi } from 'vitest';

import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { revokeOpenKitAccessTokenRecord } from './access-token-store.js';
import { verifyOpenKitAccessTokenRecord } from './access-token-verification.js';
import { createBetterAuth, resolveBetterAuthSecret } from './better-auth.js';
import {
  consumeServerBootstrapToken,
  ensureServerBootstrapToken,
  writeServerBootstrapTokenEmission,
} from './bootstrap-token.js';

describe('createBetterAuth', () => {
  it.each([
    'boundary',
    'name-overflow',
    'email-overflow',
    'password-minimum',
    'password-maximum',
    'password-underflow',
    'password-overflow',
  ] as const)(
    'enforces common Human creation bounds through actual server signup after bootstrap: %s',
    async (scenario) => {
      const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-signup-boundary-'));
      const coreDb = openCoreDb(dataRoot);
      try {
        applyMigrations(coreDb);
        const issue = ensureServerBootstrapToken(coreDb)!;
        const owner = await consumeServerBootstrapToken(coreDb, {
          token: issue.token,
          ownerUserId: allocateEntityId('usr'),
          displayName: 'Initial owner',
          email: 'initial-owner@example.test',
          password: 'synthetic-owner-password',
          tokenExpiresAt: '2999-01-01T00:00:00.000Z',
        });
        expect(owner.status).toBe('consumed');
        const auth = createBetterAuth(coreDb, {
          mode: 'server',
          env: {
            BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
            BETTER_AUTH_URL: 'http://127.0.0.1:3000',
          },
          openKitConfig: { auth: { signup: { enabled: true } } },
        });
        const context = await auth.$context;
        vi.spyOn(context.logger, 'error').mockImplementation(() => {});
        vi.spyOn(context.logger, 'warn').mockImplementation(() => {});
        const name = '😀'.repeat(scenario === 'name-overflow' ? 257 : 256);
        const email = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(scenario === 'email-overflow' ? 62 : 61)}`;
        // SDK creation limits count UTF-16 units: four astral scalars are eight units.
        const password =
          scenario === 'password-minimum'
            ? '🧪'.repeat(4)
            : scenario === 'password-maximum'
              ? '🧪'.repeat(64)
              : scenario === 'password-underflow'
                ? `${'🧪'.repeat(3)}x`
                : scenario === 'password-overflow'
                  ? `${'🧪'.repeat(64)}x`
                  : 'synthetic-signup-password';
        const response = await auth.handler(
          new Request('http://127.0.0.1:3000/api/auth/sign-up/email', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email, name, password }),
          })
        );
        const text = await response.text();
        const admitted = ['boundary', 'password-minimum', 'password-maximum'].includes(scenario);
        expect.soft(response.status).toBe(admitted ? 200 : 400);
        expect.soft(text.includes(password)).toBe(false);
        expect.soft(text.includes(issue.token)).toBe(false);
        if (!admitted) {
          expect.soft(response.headers.getSetCookie().length).toBe(0);
          expect.soft(text.includes(email)).toBe(false);
          expect
            .soft(
              text
                .toLowerCase()
                .includes(
                  scenario === 'name-overflow'
                    ? 'name'
                    : scenario === 'email-overflow'
                      ? 'email'
                      : 'password'
                )
            )
            .toBe(true);
        }
        const counts = ['users', 'account', 'session'].map((table) =>
          coreDb.sqlite.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()
        );
        expect.soft(counts).toEqual(admitted ? [2, 2, 1] : [1, 1, 0]);
        if (admitted) {
          const stored = coreDb.sqlite
            .prepare('SELECT display_name FROM users WHERE email = ?')
            .pluck()
            .get(email);
          expect(stored === name).toBe(true);
        }
      } finally {
        await shutdownControlStoreWorkerClient();
        coreDb.sqlite.close();
        rmSync(dataRoot, { recursive: true, force: true });
      }
    }
  );

  it('keeps real browser auth admission on configured origins despite environment overrides', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-better-auth-origin-'));
    const coreDb = openCoreDb(dataRoot);
    const baseURL = 'http://127.0.0.1:3000';
    const configuredOrigin = 'https://console.openkit.example';
    const ambientOrigin = 'https://ambient-origin.example.test';
    const suppliedOrigin = 'https://supplied-origin.example.test';
    vi.stubEnv('BETTER_AUTH_TRUSTED_ORIGINS', ambientOrigin);
    try {
      applyMigrations(coreDb);
      const auth = createBetterAuth(coreDb, {
        env: { BETTER_AUTH_URL: baseURL, BETTER_AUTH_TRUSTED_ORIGINS: suppliedOrigin },
        openKitConfig: { server: { cors: { origins: [configuredOrigin] } } },
      });
      // The SDK skips origin checks under its test environment by default. Use
      // its production check here without changing any other environment key.
      (await auth.$context).skipOriginCheck = false;
      for (const { name, origin, status } of [
        { name: 'configured', origin: configuredOrigin, status: 200 },
        { name: 'same-origin', origin: baseURL, status: 200 },
        { name: 'ambient override', origin: ambientOrigin, status: 403 },
        { name: 'supplied override', origin: suppliedOrigin, status: 403 },
        { name: 'unconfigured', origin: 'https://unconfigured-origin.example.test', status: 403 },
      ]) {
        const response = await auth.handler(
          new Request(`${baseURL}/api/auth/sign-out`, {
            body: '{}',
            headers: { 'content-type': 'application/json', cookie: '', origin },
            method: 'POST',
          })
        );
        // Cookie presence activates the real browser origin boundary; no
        // account, session credential or secret input is needed for sign-out.
        expect.soft(response.status, name).toBe(status);
      }
    } finally {
      vi.unstubAllEnvs();
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('keeps concurrent browser auth admission isolated from another request origin refresh', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-better-auth-concurrent-origin-'));
    const coreDb = openCoreDb(dataRoot);
    const baseURL = 'http://127.0.0.1:3000';
    const ambientOrigin = 'https://ambient-origin.example.test';
    const bodyRead = Promise.withResolvers<void>();
    const releaseBody = Promise.withResolvers<void>();
    const providerRead = Promise.withResolvers<void>();
    const releaseProvider = Promise.withResolvers<void>();
    const pending: Promise<Response>[] = [];
    vi.stubEnv('BETTER_AUTH_TRUSTED_ORIGINS', ambientOrigin);
    try {
      applyMigrations(coreDb);
      const auth = createBetterAuth(coreDb, {
        env: { BETTER_AUTH_URL: baseURL },
        openKitConfig: { server: { cors: { origins: ['https://console.openkit.example'] } } },
      });
      const context = await auth.$context;
      context.skipOriginCheck = false;
      const originalAccount = context.options.account;
      try {
        const init: RequestInit & { duplex: 'half' } = {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: '', origin: ambientOrigin },
          duplex: 'half',
          body: new ReadableStream(
            {
              async pull(controller) {
                bodyRead.resolve();
                await releaseBody.promise;
                controller.enqueue(new TextEncoder().encode('{}'));
                controller.close();
              },
            },
            { highWaterMark: 0 }
          ),
        };
        const first = auth.handler(new Request(`${baseURL}/api/auth/sign-out`, init));
        pending.push(first);
        // Body consumption follows SDK onRequest hooks. Early refusal is also valid.
        const earlyResponse = await Promise.race([bodyRead.promise.then(() => null), first]);
        if (!earlyResponse) {
          // Pause only external provider resolution, after the second request's
          // SDK origin refresh but before its router and onRequest hooks.
          context.options.account = {
            ...originalAccount,
            accountLinking: {
              ...originalAccount?.accountLinking,
              trustedProviders: async () => {
                providerRead.resolve();
                await releaseProvider.promise;
                return [];
              },
            },
          };
        }
        const second = auth.handler(
          new Request(`${baseURL}/api/auth/sign-out`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: '', origin: baseURL },
            body: '{}',
          })
        );
        pending.push(second);
        if (!earlyResponse) await providerRead.promise;
        releaseBody.resolve();
        expect.soft((await first).status, 'unconfigured concurrent origin').toBe(403);
        releaseProvider.resolve();
        expect((await second).status, 'same-origin concurrent control').toBe(200);
      } finally {
        releaseBody.resolve();
        releaseProvider.resolve();
        await Promise.allSettled(pending);
        context.options.account = originalAccount;
      }
    } finally {
      vi.unstubAllEnvs();
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it.each(
    [
      { signup: 'default', enabled: undefined },
      { signup: 'enabled', enabled: true },
      { signup: 'disabled', enabled: false },
    ].flatMap((policy) =>
      (['expired', 'revoked'] as const).map((tokenState) => ({ ...policy, tokenState }))
    )
  )(
    'protects bootstrap and retains $signup signup after the administrator Token is $tokenState',
    async ({ enabled, tokenState }) => {
      const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-better-auth-bootstrap-'));
      const coreDb = openCoreDb(dataRoot);
      const now = new Date('2026-10-30T00:00:00.000Z');
      const tokenExpiresAt = new Date(now.getTime() + 60_000);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(now);
      try {
        applyMigrations(coreDb);
        const issued = ensureServerBootstrapToken(coreDb, { now });
        expect(issued !== null).toBe(true);
        writeServerBootstrapTokenEmission(dataRoot, issued!);
        const baseURL = 'https://core.openkit.example';
        const auth = createBetterAuth(coreDb, {
          env: { BETTER_AUTH_SECRET: randomBytes(32).toString('hex') },
          mode: 'server',
          openKitConfig: {
            server: { publicBaseUrl: baseURL },
            ...(enabled === undefined ? {} : { auth: { signup: { enabled } } }),
          },
        });
        const signUp = () =>
          auth.handler(
            new Request(`${baseURL}/api/auth/sign-up/email`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                email: `${randomUUID()}@example.test`,
                name: 'Signup fixture',
                password: randomBytes(24).toString('base64url'),
              }),
            })
          );
        const userCount = () =>
          (
            coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM users').get() as {
              count: number;
            }
          ).count;

        const before = await signUp();
        // #542: an incomplete ceremony refuses signup without making its issued bootstrap unusable.
        expect.soft(before.status >= 400 && before.status < 500).toBe(true);
        expect.soft(userCount()).toBe(0);
        for (const table of ['account', 'session']) {
          const row = coreDb.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
            count: number;
          };
          expect.soft(row.count).toBe(0);
        }
        const consumed = await consumeServerBootstrapToken(coreDb, {
          token: issued!.token,
          ownerUserId: allocateEntityId('usr'),
          displayName: 'Bootstrap owner',
          email: `${randomUUID()}@example.test`,
          password: randomBytes(24).toString('base64url'),
          tokenExpiresAt: tokenExpiresAt.toISOString(),
          now,
        });
        expect(consumed.status).toBe('consumed');
        if (consumed.status !== 'consumed') throw new Error('Bootstrap consumption failed.');
        expect(userCount()).toBe(1);
        expect(
          (await verifyOpenKitAccessTokenRecord(coreDb, consumed.secret, { now })) !== null
        ).toBe(true);

        const permitted = enabled !== false;
        const after = await signUp();
        expect(after.status === 200).toBe(permitted);
        if (!permitted) expect(after.status >= 400 && after.status < 500).toBe(true);
        expect(userCount()).toBe(permitted ? 2 : 1);

        if (tokenState === 'expired') vi.setSystemTime(tokenExpiresAt.getTime() + 1);
        else revokeOpenKitAccessTokenRecord(coreDb, consumed.record.tokenId, now);
        expect(
          (await verifyOpenKitAccessTokenRecord(coreDb, consumed.secret, { now: new Date() })) ===
            null
        ).toBe(true);
        // Ceremony completion survives credential lifecycle changes on this same auth instance.
        const afterCredentialEnds = await signUp();
        expect(afterCredentialEnds.status === 200).toBe(permitted);
        if (!permitted)
          expect(afterCredentialEnds.status >= 400 && afterCredentialEnds.status < 500).toBe(true);
        expect(userCount()).toBe(permitted ? 3 : 1);
      } finally {
        vi.useRealTimers();
        await shutdownControlStoreWorkerClient();
        coreDb.sqlite.close();
        rmSync(dataRoot, { recursive: true, force: true });
      }
    }
  );

  it('resolves the local fallback and validates server secrets without opening storage', () => {
    expect(resolveBetterAuthSecret({}, 'local')).toContain('local-development-secret');
    expect(() => resolveBetterAuthSecret({}, 'server')).toThrow('BETTER_AUTH_SECRET');
    expect(
      resolveBetterAuthSecret(
        { BETTER_AUTH_SECRET: 'server-secret-that-is-at-least-32-characters' },
        'server'
      )
    ).toBe('server-secret-that-is-at-least-32-characters');
  });

  it('uses listener port validation for the local fallback URL', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-better-auth-port-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);

      expect(() => createBetterAuth(coreDb, { env: { PORT: 'invalid' } })).toThrow('PORT');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('requires an explicit strong secret in server mode', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-better-auth-secret-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);

      expect(() => createBetterAuth(coreDb, { env: {}, mode: 'server' })).toThrow(
        'BETTER_AUTH_SECRET'
      );
      expect(() =>
        createBetterAuth(coreDb, {
          env: { BETTER_AUTH_SECRET: 'too-short' },
          mode: 'server',
        })
      ).toThrow('BETTER_AUTH_SECRET');
      expect(() =>
        createBetterAuth(coreDb, {
          env: { BETTER_AUTH_SECRET: '                                        ' },
          mode: 'server',
        })
      ).toThrow('BETTER_AUTH_SECRET');
      const auth = createBetterAuth(coreDb, {
        env: { BETTER_AUTH_SECRET: 'server-secret-that-is-at-least-32-characters' },
        mode: 'server',
        openKitConfig: { server: { bind: { host: '10.0.0.8', port: 4310 } } },
      });

      expect(auth.options.baseURL).toBe('http://10.0.0.8:4310');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('returns the incomplete bootstrap refusal while sign-up is disabled, then keeps sign-up disabled', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-better-auth-signup-disabled-'));
    const coreDb = openCoreDb(dataRoot);
    const now = new Date('2026-10-30T00:00:00.000Z');

    try {
      applyMigrations(coreDb);
      const issued = ensureServerBootstrapToken(coreDb, { now });
      expect(issued).not.toBeNull();
      if (!issued) throw new Error('Bootstrap token was not issued.');
      const baseURL = 'https://core.openkit.example';
      const auth = createBetterAuth(coreDb, {
        env: { BETTER_AUTH_SECRET: randomBytes(32).toString('hex') },
        mode: 'server',
        openKitConfig: {
          auth: { signup: { enabled: false } },
          server: { publicBaseUrl: baseURL },
        },
      });
      const signUp = () =>
        auth.handler(
          new Request(`${baseURL}/api/auth/sign-up/email`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              email: `${randomUUID()}@example.test`,
              name: 'Signup fixture',
              password: randomBytes(24).toString('base64url'),
            }),
          })
        );
      const userCount = () =>
        (coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number })
          .count;

      const pending = await signUp();
      expect(pending.status).toBe(403);
      expect(((await pending.json()) as { message?: string }).message).toBe(
        'Server bootstrap is incomplete.'
      );
      expect(userCount()).toBe(0);

      const consumed = await consumeServerBootstrapToken(coreDb, {
        token: issued.token,
        ownerUserId: allocateEntityId('usr'),
        displayName: 'Bootstrap owner',
        email: `${randomUUID()}@example.test`,
        password: randomBytes(24).toString('base64url'),
        tokenExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
        now,
      });
      expect(consumed.status).toBe('consumed');
      expect(userCount()).toBe(1);

      const disabled = await signUp();
      const disabledBody = (await disabled.json()) as { code?: string; message?: string };
      expect(disabled.status).toBe(400);
      expect(disabledBody.code).toBe('EMAIL_PASSWORD_SIGN_UP_DISABLED');
      expect(disabledBody.message).toBe('Email and password sign up is not enabled');
      expect(userCount()).toBe(1);
    } finally {
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('derives base URL, trusted origins, and sign-up policy from server config', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-better-auth-config-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      const auth = createBetterAuth(coreDb, {
        env: { BETTER_AUTH_SECRET: 'server-secret-that-is-at-least-32-characters' },
        mode: 'server',
        openKitConfig: {
          auth: { signup: { enabled: false } },
          server: {
            cors: { origins: ['https://console.openkit.example'] },
            publicBaseUrl: 'https://core.openkit.example',
          },
        },
      });
      const response = await auth.handler(
        new Request('https://core.openkit.example/api/auth/sign-up/email', {
          body: JSON.stringify({
            email: 'disabled@example.com',
            name: 'Disabled User',
            password: 'password123456',
          }),
          headers: {
            'content-type': 'application/json',
            origin: 'https://console.openkit.example',
          },
          method: 'POST',
        })
      );

      expect(auth.options.baseURL).toBe('https://core.openkit.example');
      expect(auth.options.trustedOrigins).toEqual(['https://console.openkit.example']);
      expect(auth.options.emailAndPassword?.disableSignUp).toBe(true);
      expect(response.status).toBe(403);
      expect(((await response.json()) as { message?: string }).message).toBe(
        'Server bootstrap is incomplete.'
      );
      expect(
        coreDb.sqlite.prepare('SELECT id FROM users WHERE email = ?').get('disabled@example.com')
      ).toBeUndefined();
    } finally {
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
    }
  });

  it('boots against migrated server-scope Core SQLite with Better Auth tables', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-better-auth-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      applyMigrations(coreDb);

      const auth = createBetterAuth(coreDb);
      const tables = ['users', 'session', 'account', 'verification'];

      expect(auth).toBeDefined();

      for (const table of tables) {
        const row = coreDb.sqlite
          .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(table) as { count: number };

        expect(row.count).toBe(1);
      }

      const legacyUserTable = coreDb.sqlite
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('user') as { count: number };

      expect(legacyUserTable.count).toBe(0);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('stores signed-up Better Auth users in the canonical OpenKit users table', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-better-auth-users-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      const auth = createBetterAuth(coreDb);
      const response = await auth.handler(
        new Request('http://127.0.0.1:3000/api/auth/sign-up/email', {
          body: JSON.stringify({
            email: 'canonical@example.com',
            name: 'Canonical User',
            password: 'password123456',
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        })
      );
      const row = coreDb.sqlite
        .prepare(
          `SELECT display_name, email, email_verified, kind
           FROM users
           WHERE email = ?`
        )
        .get('canonical@example.com') as
        | { display_name: string; email: string; email_verified: number; kind: string }
        | undefined;

      expect(response.status).toBe(200);
      expect(row).toEqual({
        display_name: 'Canonical User',
        email: 'canonical@example.com',
        email_verified: 0,
        kind: 'human',
      });
    } finally {
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
    }
  });

  it('keeps lifecycle fields server-owned and blocks new sessions for disabled users', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-better-auth-disabled-user-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      const auth = createBetterAuth(coreDb);
      const rejectedOverride = await auth.handler(
        new Request('http://127.0.0.1:3000/api/auth/sign-up/email', {
          body: JSON.stringify({
            disabledAt: 'caller-owned',
            email: 'lifecycle@example.com',
            name: 'Lifecycle User',
            password: 'password123456',
            status: 'disabled',
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        })
      );
      const signUp = await auth.handler(
        new Request('http://127.0.0.1:3000/api/auth/sign-up/email', {
          body: JSON.stringify({
            email: 'lifecycle@example.com',
            name: 'Lifecycle User',
            password: 'password123456',
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        })
      );
      const user = coreDb.sqlite
        .prepare('SELECT id, status, disabled_at AS disabledAt FROM users WHERE email = ?')
        .get('lifecycle@example.com') as {
        id: string;
        status: string;
        disabledAt: string | null;
      };

      expect(rejectedOverride.status).toBe(400);
      expect(signUp.status).toBe(200);
      expect(user).toMatchObject({ disabledAt: null, status: 'active' });
      expect(auth.options.user?.additionalFields?.status?.input).toBe(false);
      expect(auth.options.user?.additionalFields?.disabledAt?.input).toBe(false);

      coreDb.sqlite.prepare('DELETE FROM session WHERE user_id = ?').run(user.id);
      coreDb.sqlite
        .prepare("UPDATE users SET status = 'disabled', disabled_at = ? WHERE id = ?")
        .run('2026-07-19T01:02:03.000Z', user.id);

      const signIn = await auth.handler(
        new Request('http://127.0.0.1:3000/api/auth/sign-in/email', {
          body: JSON.stringify({
            email: 'lifecycle@example.com',
            password: 'password123456',
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        })
      );

      expect(signIn.status).toBe(403);
      expect(
        coreDb.sqlite
          .prepare('SELECT COUNT(*) AS count FROM session WHERE user_id = ?')
          .get(user.id)
      ).toEqual({ count: 0 });
    } finally {
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
    }
  });
});

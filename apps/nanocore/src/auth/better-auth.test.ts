import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';

import { describe, expect, it, vi } from 'vitest';

import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  revokeOpenKitAccessTokenRecord,
  verifyOpenKitAccessTokenRecord,
} from './access-token-store.js';
import { createBetterAuth, resolveBetterAuthSecret } from './better-auth.js';
import {
  consumeServerBootstrapToken,
  ensureServerBootstrapToken,
  writeServerBootstrapTokenEmission,
} from './bootstrap-token.js';

describe('createBetterAuth', () => {
  it.each(
    [
      { signup: 'default', enabled: undefined },
      { signup: 'enabled', enabled: true },
      { signup: 'disabled', enabled: false },
    ].flatMap((policy) =>
      (['expired', 'revoked'] as const).map((tokenState) => ({ ...policy, tokenState }))
    )
  )('protects bootstrap and retains $signup signup after the administrator Token is $tokenState', async ({
    enabled,
    tokenState,
  }) => {
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
      expect(verifyOpenKitAccessTokenRecord(coreDb, consumed.secret, { now }) !== null).toBe(true);

      const permitted = enabled !== false;
      const after = await signUp();
      expect(after.status === 200).toBe(permitted);
      if (!permitted) expect(after.status >= 400 && after.status < 500).toBe(true);
      expect(userCount()).toBe(permitted ? 2 : 1);

      if (tokenState === 'expired') vi.setSystemTime(tokenExpiresAt.getTime() + 1);
      else revokeOpenKitAccessTokenRecord(coreDb, consumed.record.tokenId, now);
      expect(
        verifyOpenKitAccessTokenRecord(coreDb, consumed.secret, { now: new Date() }) === null
      ).toBe(true);
      // Ceremony completion survives credential lifecycle changes on this same auth instance.
      const afterCredentialEnds = await signUp();
      expect(afterCredentialEnds.status === 200).toBe(permitted);
      if (!permitted)
        expect(afterCredentialEnds.status >= 400 && afterCredentialEnds.status < 500).toBe(true);
      expect(userCount()).toBe(permitted ? 3 : 1);
    } finally {
      vi.useRealTimers();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

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
      expect(response.status).toBe(400);
      expect(
        coreDb.sqlite.prepare('SELECT id FROM users WHERE email = ?').get('disabled@example.com')
      ).toBeUndefined();
    } finally {
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
      coreDb.sqlite.close();
    }
  });
});

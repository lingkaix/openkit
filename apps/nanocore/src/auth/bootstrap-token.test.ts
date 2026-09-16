import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { verifyOpenKitAccessTokenRecord } from './access-token-store.js';
import {
  consumeServerBootstrapToken,
  ensureServerBootstrapToken,
  writeServerBootstrapTokenEmission,
} from './bootstrap-token.js';

describe('server bootstrap token', () => {
  it('emits once, creates a login-capable owner, and issues the owner server-admin token', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-bootstrap-token-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);

      const issued = ensureServerBootstrapToken(coreDb, {
        now: new Date('2026-07-06T00:00:00.000Z'),
      });
      const secondIssue = ensureServerBootstrapToken(coreDb, {
        now: new Date('2026-07-06T00:01:00.000Z'),
      });
      const emission = writeServerBootstrapTokenEmission(dataRoot, issued!);
      const consumed = await consumeServerBootstrapToken(coreDb, {
        displayName: 'Owner',
        email: 'owner@example.com',
        ownerUserId: 'user_owner',
        password: 'password123456',
        token: issued!.token,
        tokenExpiresAt: '2026-07-07T00:00:00.000Z',
        now: new Date('2026-07-06T00:02:00.000Z'),
      });
      const secondConsume = await consumeServerBootstrapToken(coreDb, {
        displayName: 'Owner',
        email: 'owner@example.com',
        ownerUserId: 'user_owner',
        password: 'password123456',
        token: issued!.token,
        tokenExpiresAt: '2026-07-07T00:00:00.000Z',
        now: new Date('2026-07-06T00:03:00.000Z'),
      });
      const userCount = coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM users').get() as {
        count: number;
      };
      const user = coreDb.sqlite
        .prepare('SELECT display_name, email, email_verified, kind FROM users WHERE id = ?')
        .get('user_owner') as {
        display_name: string;
        email: string;
        email_verified: number;
        kind: string;
      };
      const credentialAccount = coreDb.sqlite
        .prepare(
          `SELECT account_id, provider_id
           FROM account
           WHERE user_id = ?`
        )
        .get('user_owner') as { account_id: string; provider_id: string };

      expect(issued?.token).toMatch(/^okt_/);
      expect(secondIssue).toBeNull();
      expect(statSync(emission.path).mode & 0o777).toBe(0o600);
      expect(consumed).toMatchObject({
        record: { ownerUserId: 'user_owner', scope: 'server-admin' },
      });
      expect(
        verifyOpenKitAccessTokenRecord(coreDb, consumed?.secret ?? '', {
          now: new Date('2026-07-06T00:02:30.000Z'),
        })?.scope
      ).toBe('server-admin');
      expect(secondConsume?.status).toBe('unavailable');
      expect(userCount.count).toBe(1);
      expect(user).toEqual({
        display_name: 'Owner',
        email: 'owner@example.com',
        email_verified: 0,
        kind: 'human',
      });
      expect(credentialAccount).toEqual({ account_id: 'user_owner', provider_id: 'credential' });
      expect(JSON.stringify(emission)).not.toContain(consumed?.secret);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects consume after hashing when the bootstrap token expired during the wait', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-bootstrap-token-expiry-'));
    const coreDb = openCoreDb(dataRoot);
    vi.useFakeTimers({ toFake: ['Date'] });

    try {
      applyMigrations(coreDb);
      const issuedAt = new Date('2026-07-06T00:00:00.000Z');
      vi.setSystemTime(issuedAt);
      const issued = ensureServerBootstrapToken(coreDb, {
        now: issuedAt,
        ttlMs: 60_000,
      });
      const pending = consumeServerBootstrapToken(coreDb, {
        displayName: 'Owner',
        email: 'owner@example.com',
        ownerUserId: 'user_owner',
        password: 'password123456',
        token: issued!.token,
        tokenExpiresAt: '2026-07-07T00:00:00.000Z',
      });
      vi.setSystemTime(new Date('2026-07-06T00:02:00.000Z'));
      const consumed = await pending;
      const users = coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM users').get() as {
        count: number;
      };
      const accounts = coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM account').get() as {
        count: number;
      };
      const tokens = coreDb.sqlite
        .prepare('SELECT COUNT(*) AS count FROM openkit_access_tokens')
        .get() as { count: number };
      const setting = JSON.parse(
        (
          coreDb.sqlite
            .prepare('SELECT value FROM server_settings WHERE key = ?')
            .get('auth.bootstrap_token') as { value: string }
        ).value
      ) as { consumedAt: string | null };

      expect(consumed).toEqual({ status: 'invalid' });
      expect(users.count).toBe(0);
      expect(accounts.count).toBe(0);
      expect(tokens.count).toBe(0);
      expect(setting.consumedAt).toBeNull();
    } finally {
      vi.useRealTimers();
      coreDb.sqlite.close();
    }
  });
});

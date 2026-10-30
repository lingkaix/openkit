import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { verifyOpenKitAccessTokenRecord } from './access-token-store.js';
import {
  consumeServerBootstrapToken,
  ensureServerBootstrapToken,
  writeServerBootstrapTokenEmission,
} from './bootstrap-token.js';

describe('server bootstrap token', () => {
  it('announces completed one-time delivery without material or location and keeps the file header truthful', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-bootstrap-notice-'));
    onTestFinished(() => rmSync(dataRoot, { recursive: true, force: true }));
    const coreDb = openCoreDb(dataRoot);
    const notices = (['info', 'log', 'warn', 'error'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined)
    );
    try {
      applyMigrations(coreDb);
      const issued = ensureServerBootstrapToken(coreDb, {
        now: new Date('2026-07-06T00:00:00.000Z'),
      });
      expect(issued !== null).toBe(true);
      const emission = writeServerBootstrapTokenEmission(dataRoot, issued!);
      const notice = notices.flatMap((spy) => spy.mock.calls.flat().map(String)).join(' ');

      // Server-mode bootstrap ceremony: the notice states lifetime and recovery limits safely.
      expect.soft(/one[- ]time/i.test(notice)).toBe(true);
      expect.soft(/expir/i.test(notice)).toBe(true);
      expect.soft(/cannot be recovered/i.test(notice)).toBe(true);
      for (const privateValue of [issued!.token, emission.path, dataRoot])
        expect(notice.includes(privateValue)).toBe(false);
      const contents = readFileSync(emission.path, 'utf8');
      expect(contents.includes(issued!.token)).toBe(true);
      expect.soft(/never stored in plaintext/i.test(contents.split('\n')[0] ?? '')).toBe(false);
      expect(statSync(emission.path).mode & 0o777).toBe(0o600);

      rmSync(emission.path);
      mkdirSync(emission.path);
      for (const spy of notices) spy.mockClear();
      expect(() => writeServerBootstrapTokenEmission(dataRoot, issued!)).toThrow();
      expect(notices.flatMap((spy) => spy.mock.calls)).toEqual([]);
    } finally {
      for (const spy of notices) spy.mockRestore();
      coreDb.sqlite.close();
    }
  });

  it('writes a v1 bootstrap setting and preserves descriptive additions through consumption', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-bootstrap-setting-v1-'));
    onTestFinished(() => rmSync(dataRoot, { recursive: true, force: true }));
    const coreDb = openCoreDb(dataRoot);
    try {
      applyMigrations(coreDb);
      const issued = ensureServerBootstrapToken(coreDb, {
        now: new Date('2026-07-06T00:00:00.000Z'),
      });
      expect(
        coreDb.sqlite
          .prepare('SELECT schema_version AS schemaVersion FROM server_settings WHERE key = ?')
          .get('auth.bootstrap_token')
      ).toEqual({ schemaVersion: 1 });
      const row = coreDb.sqlite
        .prepare('SELECT value FROM server_settings WHERE key = ?')
        .get('auth.bootstrap_token') as { value: string };
      const value = JSON.stringify({ ...JSON.parse(row.value), futureNote: 'retained' });
      coreDb.sqlite
        .prepare('UPDATE server_settings SET value = ? WHERE key = ?')
        .run(value, 'auth.bootstrap_token');

      const secondIssue = ensureServerBootstrapToken(coreDb, {
        now: new Date('2026-07-06T00:01:00.000Z'),
      });
      expect(secondIssue === null).toBe(true);
      const retained = coreDb.sqlite
        .prepare('SELECT value FROM server_settings WHERE key = ?')
        .get('auth.bootstrap_token') as { value: string };
      expect(retained.value === value).toBe(true);
      const consumed = await consumeServerBootstrapToken(coreDb, {
        displayName: 'Owner',
        email: 'owner@example.com',
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        password: 'password123456',
        token: issued!.token,
        tokenExpiresAt: '2026-07-07T00:00:00.000Z',
        now: new Date('2026-07-06T00:02:00.000Z'),
      });
      expect(consumed.status).toBe('consumed');
      const consumedRow = coreDb.sqlite
        .prepare('SELECT value FROM server_settings WHERE key = ?')
        .get('auth.bootstrap_token') as { value: string };
      const consumedSetting = JSON.parse(consumedRow.value);
      expect(consumedSetting.futureNote).toBe('retained');
      expect(consumedSetting.consumedAt).toBe('2026-07-06T00:02:00.000Z');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('refuses an unknown bootstrap format before malformed payload decoding or replacement', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-bootstrap-setting-version-'));
    onTestFinished(() => rmSync(dataRoot, { recursive: true, force: true }));
    const coreDb = openCoreDb(dataRoot);
    try {
      applyMigrations(coreDb);
      ensureServerBootstrapToken(coreDb, { now: new Date('2026-07-06T00:00:00.000Z') });
      coreDb.sqlite
        .prepare('UPDATE server_settings SET schema_version = 2, value = ? WHERE key = ?')
        .run('{', 'auth.bootstrap_token');

      expect(() =>
        ensureServerBootstrapToken(coreDb, { now: new Date('2026-07-06T00:01:00.000Z') })
      ).toThrow('Unsupported retained record format.');
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT schema_version AS schemaVersion, value FROM server_settings WHERE key = ?'
          )
          .get('auth.bootstrap_token')
      ).toEqual({ schemaVersion: 2, value: '{' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    false,
    true,
  ])('emits once and preserves atomic owner creation with cleanup blocked=%s', async (cleanupBlocked) => {
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
      expect(statSync(emission.path).mode & 0o777).toBe(0o600);
      const consumeInput = {
        displayName: 'Owner',
        email: 'owner@example.com',
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        password: 'password123456',
        token: issued!.token,
        tokenExpiresAt: '2026-07-07T00:00:00.000Z',
        now: new Date('2026-07-06T00:02:00.000Z'),
      };

      if (cleanupBlocked) {
        // Fault the delivered destination; failed cleanup must not consume authority or create an owner.
        rmSync(emission.path);
        mkdirSync(emission.path);
        const status = await consumeServerBootstrapToken(coreDb, consumeInput).then(
          (result) => result.status,
          () => 'refused'
        );
        expect.soft(status === 'consumed').toBe(false);
        for (const table of ['users', 'account', 'openkit_access_tokens']) {
          const row = coreDb.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
            count: number;
          };
          expect.soft(row.count).toBe(0);
        }
        const setting = coreDb.sqlite
          .prepare('SELECT value FROM server_settings WHERE key = ?')
          .get('auth.bootstrap_token') as { value: string };
        expect.soft(JSON.parse(setting.value).consumedAt === null).toBe(true);
        return;
      }
      const consumed = await consumeServerBootstrapToken(coreDb, consumeInput);
      const secondConsume = await consumeServerBootstrapToken(coreDb, {
        displayName: 'Owner',
        email: 'owner@example.com',
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
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
        .get('usr_00000000-0000-7011-88df-c2b1e8466b6f') as {
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
        .get('usr_00000000-0000-7011-88df-c2b1e8466b6f') as {
        account_id: string;
        provider_id: string;
      };

      expect(issued?.token).toMatch(/^okt_/);
      expect(secondIssue).toBeNull();
      expect.soft(existsSync(emission.path)).toBe(false);
      expect(consumed).toMatchObject({
        record: { ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f', scope: 'server-admin' },
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
      expect(credentialAccount).toEqual({
        account_id: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        provider_id: 'credential',
      });
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
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
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

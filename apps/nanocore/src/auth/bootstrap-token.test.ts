import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { verifyOpenKitAccessTokenRecord } from './access-token-store.js';
import {
  consumeServerBootstrapToken,
  ensureServerBootstrapToken,
  writeServerBootstrapTokenEmission,
} from './bootstrap-token.js';

describe('server bootstrap token', () => {
  it('emits once, consumes once, and issues the owner server-admin token', () => {
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
      const consumed = consumeServerBootstrapToken(coreDb, {
        displayName: 'Owner',
        ownerUserId: 'user_owner',
        token: issued!.token,
        tokenExpiresAt: '2026-07-07T00:00:00.000Z',
        now: new Date('2026-07-06T00:02:00.000Z'),
      });
      const secondConsume = consumeServerBootstrapToken(coreDb, {
        displayName: 'Owner',
        ownerUserId: 'user_owner',
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
        email: 'user_owner@bootstrap.openkit.invalid',
        email_verified: 0,
        kind: 'human',
      });
      expect(JSON.stringify(emission)).not.toContain(consumed?.secret);
    } finally {
      coreDb.sqlite.close();
    }
  });
});

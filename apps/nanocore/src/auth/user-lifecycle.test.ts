import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
  rotateOpenKitAccessTokenRecord,
} from './access-token-store.js';
import { disableCanonicalUser, isCanonicalUserActive } from './user-lifecycle.js';

/** Inserts one active canonical user for lifecycle tests. */
function insertUser(coreDb: ReturnType<typeof openCoreDb>): void {
  const now = Date.now();
  coreDb.sqlite
    .prepare(
      `INSERT INTO users (
        id, display_name, email, email_verified, image, created_at, updated_at, kind, last_seen_at
      ) VALUES ('user_target', 'Target', 'target@example.com', false, NULL, ?, ?, 'human', NULL)`
    )
    .run(now, now);
}

describe('canonical user lifecycle', () => {
  it('fails closed for missing and disabled canonical users', () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-user-active-')));

    try {
      applyMigrations(coreDb);
      insertUser(coreDb);

      expect(isCanonicalUserActive(coreDb, 'user_target')).toBe(true);
      expect(isCanonicalUserActive(coreDb, 'user_missing')).toBe(false);

      coreDb.sqlite
        .prepare("UPDATE users SET status = 'disabled', disabled_at = ? WHERE id = ?")
        .run('2026-07-19T01:02:03.000Z', 'user_target');

      expect(isCanonicalUserActive(coreDb, 'user_target')).toBe(false);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('disables once inside the caller transaction and invalidates sessions and tokens', () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-user-disable-')));

    try {
      applyMigrations(coreDb);
      insertUser(coreDb);
      coreDb.sqlite
        .prepare(
          `INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id)
           VALUES ('session_1', ?, 'session-secret', ?, ?, 'user_target')`
        )
        .run(Date.now() + 60_000, Date.now(), Date.now());
      const active = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2026-07-20T00:00:00.000Z',
        now: new Date('2026-07-19T00:00:00.000Z'),
        ownerUserId: 'user_target',
        scope: 'server-admin',
        workspaceIds: [],
      });
      const predecessor = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2026-07-20T00:00:00.000Z',
        now: new Date('2026-07-19T00:00:00.000Z'),
        ownerUserId: 'user_target',
        scope: 'workspace',
        workspaceIds: ['ws_demo'],
      });
      const rotation = rotateOpenKitAccessTokenRecord(coreDb, predecessor.tokenId, {
        graceSeconds: 60,
        now: new Date('2026-07-19T00:01:00.000Z'),
      });
      const alreadyRevoked = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2026-07-20T00:00:00.000Z',
        now: new Date('2026-07-19T00:00:00.000Z'),
        ownerUserId: 'user_target',
        scope: 'server-admin',
        workspaceIds: [],
      });
      revokeOpenKitAccessTokenRecord(
        coreDb,
        alreadyRevoked.tokenId,
        new Date('2026-07-19T00:02:00.000Z')
      );

      expect(() =>
        disableCanonicalUser(coreDb, 'user_target', new Date('2026-07-19T01:02:03.000Z'))
      ).toThrow('Core transaction');

      const first = coreDb.sqlite.transaction(() =>
        disableCanonicalUser(coreDb, 'user_target', new Date('2026-07-19T01:02:03.000Z'))
      )();
      const second = coreDb.sqlite.transaction(() =>
        disableCanonicalUser(coreDb, 'user_target', new Date('2026-07-19T02:03:04.000Z'))
      )();
      const tokens = coreDb.sqlite
        .prepare(
          `SELECT token_id AS tokenId, status, revoked_at AS revokedAt
           FROM openkit_access_tokens
           WHERE owner_user_id = ?
           ORDER BY token_id`
        )
        .all('user_target') as Array<{
        tokenId: string;
        status: string;
        revokedAt: string | null;
      }>;

      expect(first).toEqual({
        changed: true,
        user: {
          disabledAt: '2026-07-19T01:02:03.000Z',
          status: 'disabled',
          userId: 'user_target',
        },
      });
      expect(second).toEqual({ ...first, changed: false });
      expect(coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM session').get()).toEqual({
        count: 0,
      });
      expect(tokens).toHaveLength(4);
      expect(tokens).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ tokenId: active.tokenId, status: 'revoked' }),
          expect.objectContaining({ tokenId: predecessor.tokenId, status: 'revoked' }),
          expect.objectContaining({ tokenId: rotation?.tokenId, status: 'revoked' }),
          {
            revokedAt: '2026-07-19T00:02:00.000Z',
            status: 'revoked',
            tokenId: alreadyRevoked.tokenId,
          },
        ])
      );
      expect(coreDb.sqlite.prepare('SELECT id FROM users WHERE id = ?').get('user_target')).toEqual(
        {
          id: 'user_target',
        }
      );
    } finally {
      coreDb.sqlite.close();
    }
  });
});

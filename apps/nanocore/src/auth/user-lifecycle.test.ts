import { mkdtempSync, rmSync } from 'node:fs';
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
      ) VALUES ('usr_00000000-0000-745a-abae-746e1401d9c4', 'Target', 'target@example.com', false, NULL, ?, ?, 'human', NULL)`
    )
    .run(now, now);
}

describe('canonical user lifecycle', () => {
  it.each([
    'user_legacy',
    'ws_00000000-0000-7000-8000-000000000001',
    'usr_00000000-0000-5000-8000-000000000001',
  ])('does not authorize a malformed retained User identity %s', (userId) => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-user-kind-'));
    const coreDb = openCoreDb(root);
    try {
      applyMigrations(coreDb);
      insertUser(coreDb);
      coreDb.sqlite.prepare('UPDATE users SET id = ?').run(userId);
      expect(isCanonicalUserActive(coreDb, userId)).toBe(false);
      expect(coreDb.sqlite.prepare('SELECT status FROM users WHERE id = ?').get(userId)).toEqual({
        status: 'active',
      });
    } finally {
      coreDb.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed for missing and disabled canonical users', () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-user-active-')));

    try {
      applyMigrations(coreDb);
      insertUser(coreDb);

      expect(isCanonicalUserActive(coreDb, 'usr_00000000-0000-745a-abae-746e1401d9c4')).toBe(true);
      expect(isCanonicalUserActive(coreDb, 'usr_00000000-0000-7241-80d8-0d46cb74b40d')).toBe(false);

      coreDb.sqlite
        .prepare("UPDATE users SET status = 'disabled', disabled_at = ? WHERE id = ?")
        .run('2026-07-19T01:02:03.000Z', 'usr_00000000-0000-745a-abae-746e1401d9c4');

      expect(isCanonicalUserActive(coreDb, 'usr_00000000-0000-745a-abae-746e1401d9c4')).toBe(false);
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
           VALUES ('auth_00000000-0000-7000-8000-000000000001', ?, 'session-secret', ?, ?, 'usr_00000000-0000-745a-abae-746e1401d9c4')`
        )
        .run(Date.now() + 60_000, Date.now(), Date.now());
      const active = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2026-07-20T00:00:00.000Z',
        now: new Date('2026-07-19T00:00:00.000Z'),
        ownerUserId: 'usr_00000000-0000-745a-abae-746e1401d9c4',
        scope: 'server-admin',
        workspaceIds: [],
      });
      const predecessor = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2026-07-20T00:00:00.000Z',
        now: new Date('2026-07-19T00:00:00.000Z'),
        ownerUserId: 'usr_00000000-0000-745a-abae-746e1401d9c4',
        scope: 'workspace',
        workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
      });
      const rotation = rotateOpenKitAccessTokenRecord(coreDb, predecessor.tokenId, {
        graceSeconds: 60,
        now: new Date('2026-07-19T00:01:00.000Z'),
      });
      const alreadyRevoked = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2026-07-20T00:00:00.000Z',
        now: new Date('2026-07-19T00:00:00.000Z'),
        ownerUserId: 'usr_00000000-0000-745a-abae-746e1401d9c4',
        scope: 'server-admin',
        workspaceIds: [],
      });
      revokeOpenKitAccessTokenRecord(
        coreDb,
        alreadyRevoked.tokenId,
        new Date('2026-07-19T00:02:00.000Z')
      );

      expect(() =>
        disableCanonicalUser(
          coreDb,
          'usr_00000000-0000-745a-abae-746e1401d9c4',
          new Date('2026-07-19T01:02:03.000Z')
        )
      ).toThrow('Core transaction');

      const first = coreDb.sqlite.transaction(() =>
        disableCanonicalUser(
          coreDb,
          'usr_00000000-0000-745a-abae-746e1401d9c4',
          new Date('2026-07-19T01:02:03.000Z')
        )
      )();
      const second = coreDb.sqlite.transaction(() =>
        disableCanonicalUser(
          coreDb,
          'usr_00000000-0000-745a-abae-746e1401d9c4',
          new Date('2026-07-19T02:03:04.000Z')
        )
      )();
      const tokens = coreDb.sqlite
        .prepare(
          `SELECT token_id AS tokenId, status, revoked_at AS revokedAt
           FROM openkit_access_tokens
           WHERE owner_user_id = ?
           ORDER BY token_id`
        )
        .all('usr_00000000-0000-745a-abae-746e1401d9c4') as Array<{
        tokenId: string;
        status: string;
        revokedAt: string | null;
      }>;

      expect(first).toEqual({
        changed: true,
        user: {
          disabledAt: '2026-07-19T01:02:03.000Z',
          status: 'disabled',
          userId: 'usr_00000000-0000-745a-abae-746e1401d9c4',
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
      expect(
        coreDb.sqlite
          .prepare('SELECT id FROM users WHERE id = ?')
          .get('usr_00000000-0000-745a-abae-746e1401d9c4')
      ).toEqual({
        id: 'usr_00000000-0000-745a-abae-746e1401d9c4',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });
});

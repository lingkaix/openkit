import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  createOpenKitAccessTokenRecord,
  rotateOpenKitAccessTokenRecord,
  verifyOpenKitAccessTokenRecord,
} from './access-token-store.js';

/**
 * Inserts the canonical owner user used by direct access-token store tests.
 *
 * @param coreDb Open Core database handles.
 */
function insertTokenOwnerUser(coreDb: ReturnType<typeof openCoreDb>): void {
  const now = Date.now();
  coreDb.sqlite
    .prepare(
      `INSERT INTO users (
        id,
        display_name,
        email,
        email_verified,
        image,
        created_at,
        updated_at,
        kind,
        last_seen_at
      )
       VALUES ('user_owner', 'Owner', 'owner@example.com', false, NULL, ?, ?, 'human', NULL)`
    )
    .run(now, now);
}

describe('OpenKit access token store', () => {
  it('stores only a hashed token secret and verifies active server-admin tokens', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-token-store-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);

      const issued = createOpenKitAccessTokenRecord(coreDb, {
        ownerUserId: 'user_owner',
        scope: 'server-admin',
        workspaceIds: [],
        expiresAt: '2026-07-07T00:00:00.000Z',
        now: new Date('2026-07-06T00:00:00.000Z'),
      });
      const rows = coreDb.sqlite.prepare('SELECT * FROM openkit_access_tokens').all() as Array<{
        token_hash: string;
      }>;
      const verified = verifyOpenKitAccessTokenRecord(coreDb, issued.secret, {
        now: new Date('2026-07-06T00:00:00.000Z'),
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]?.token_hash).toMatch(/^sha256:/);
      expect(JSON.stringify(rows)).not.toContain(issued.secret);
      expect(verified).toMatchObject({
        ownerUserId: 'user_owner',
        scope: 'server-admin',
        tokenId: issued.tokenId,
      });
      expect(verifyOpenKitAccessTokenRecord(coreDb, 'okt_wrong')).toBeNull();
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('updates the redacted last-used summary after successful verification', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-token-store-last-used-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);

      const issued = createOpenKitAccessTokenRecord(coreDb, {
        ownerUserId: 'user_owner',
        scope: 'workspace',
        workspaceIds: ['ws_demo'],
        expiresAt: '2026-07-07T00:00:00.000Z',
        now: new Date('2026-07-06T00:00:00.000Z'),
      });
      const verified = verifyOpenKitAccessTokenRecord(coreDb, issued.secret, {
        channel: 'mcp',
        now: new Date('2026-07-06T01:02:03.000Z'),
        source: 'desktop-agent',
      });

      expect(verified).toMatchObject({
        lastUsedAt: '2026-07-06T01:02:03.000Z',
        lastUsedChannel: 'mcp',
        lastUsedSource: 'desktop-agent',
        tokenId: issued.tokenId,
      });
      expect(JSON.stringify(verified)).not.toContain(issued.secret);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rotates tokens with grace and returns only the new plaintext secret', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-token-store-rotate-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);

      const issued = createOpenKitAccessTokenRecord(coreDb, {
        ownerUserId: 'user_owner',
        scope: 'workspace',
        workspaceIds: ['ws_demo'],
        expiresAt: '2026-07-07T00:00:00.000Z',
        now: new Date('2026-07-06T00:00:00.000Z'),
      });
      const rotated = rotateOpenKitAccessTokenRecord(coreDb, issued.tokenId, {
        graceSeconds: 60,
        now: new Date('2026-07-06T01:00:00.000Z'),
      });

      expect(rotated).toMatchObject({
        record: {
          predecessorTokenId: issued.tokenId,
          scope: 'workspace',
          workspaceIds: ['ws_demo'],
        },
        rotatedRecord: {
          rotatedGraceExpiresAt: '2026-07-06T01:01:00.000Z',
          status: 'rotated',
          tokenId: issued.tokenId,
        },
      });
      expect(rotated?.secret).toMatch(/^okt_/);
      expect(rotated?.secret).not.toBe(issued.secret);
      expect(JSON.stringify(rotated)).not.toContain(issued.secret);
      expect(
        verifyOpenKitAccessTokenRecord(coreDb, issued.secret, {
          now: new Date('2026-07-06T01:00:30.000Z'),
        })?.tokenId
      ).toBe(issued.tokenId);
      expect(
        verifyOpenKitAccessTokenRecord(coreDb, issued.secret, {
          now: new Date('2026-07-06T01:01:01.000Z'),
        })
      ).toBeNull();
      expect(
        verifyOpenKitAccessTokenRecord(coreDb, rotated?.secret ?? '', {
          now: new Date('2026-07-06T01:01:01.000Z'),
        })?.tokenId
      ).toBe(rotated?.tokenId);
      expect(
        rotateOpenKitAccessTokenRecord(coreDb, issued.tokenId, {
          graceSeconds: 60,
          now: new Date('2026-07-06T01:00:30.000Z'),
        })
      ).toBeNull();
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('requires token owners to exist in canonical users', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-token-store-owner-fk-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);

      expect(() =>
        createOpenKitAccessTokenRecord(coreDb, {
          ownerUserId: 'missing_user',
          scope: 'server-admin',
          workspaceIds: [],
          expiresAt: '2026-07-07T00:00:00.000Z',
          now: new Date('2026-07-06T00:00:00.000Z'),
        })
      ).toThrow(/FOREIGN KEY/);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects an otherwise usable token when its canonical owner is disabled', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-token-store-disabled-owner-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);
      const issued = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2026-07-20T00:00:00.000Z',
        now: new Date('2026-07-19T00:00:00.000Z'),
        ownerUserId: 'user_owner',
        scope: 'server-admin',
        workspaceIds: [],
      });

      coreDb.sqlite
        .prepare("UPDATE users SET status = 'disabled', disabled_at = ? WHERE id = ?")
        .run('2026-07-19T01:00:00.000Z', 'user_owner');

      expect(
        verifyOpenKitAccessTokenRecord(coreDb, issued.secret, {
          now: new Date('2026-07-19T02:00:00.000Z'),
        })
      ).toBeNull();
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT last_used_at AS lastUsedAt FROM openkit_access_tokens WHERE token_id = ?'
          )
          .get(issued.tokenId)
      ).toEqual({ lastUsedAt: null });
    } finally {
      coreDb.sqlite.close();
    }
  });
});

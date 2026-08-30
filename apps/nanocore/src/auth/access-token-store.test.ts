import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  createOpenKitAccessTokenRecord,
  listOwnedServerAdminAccessTokens,
  resolveSessionDeploymentAdminTokenId,
  revokeOpenKitAccessTokenRecord,
  rotateOpenKitAccessTokenRecord,
  setDefaultServerAdminTokenId,
  verifyOpenKitAccessTokenRecord,
} from './access-token-store.js';

/**
 * Inserts one canonical human user used by direct access-token store tests.
 *
 * @param coreDb Open Core database handles.
 * @param userId Canonical user id.
 * @param displayName Display name.
 * @param email Email address.
 */
function insertCanonicalUser(
  coreDb: ReturnType<typeof openCoreDb>,
  userId: string,
  displayName: string,
  email: string
): void {
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
       VALUES (?, ?, ?, false, NULL, ?, ?, 'human', NULL)`
    )
    .run(userId, displayName, email, now, now);
}

/**
 * Inserts the canonical owner user used by direct access-token store tests.
 *
 * @param coreDb Open Core database handles.
 */
function insertTokenOwnerUser(coreDb: ReturnType<typeof openCoreDb>): void {
  insertCanonicalUser(coreDb, 'user_owner', 'Owner', 'owner@example.com');
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

  it('selects a sole usable server-admin token and falls back when the default is revoked', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-token-default-fallback-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);
      const first = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2026-07-20T00:00:00.000Z',
        now: new Date('2026-07-19T00:00:00.000Z'),
        ownerUserId: 'user_owner',
        scope: 'server-admin',
        tokenId: 'tok_first',
        workspaceIds: [],
      });
      expect(
        resolveSessionDeploymentAdminTokenId(
          coreDb,
          'user_owner',
          new Date('2026-07-19T01:00:00.000Z')
        )
      ).toBe(first.tokenId);

      const second = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2026-07-20T00:00:00.000Z',
        now: new Date('2026-07-19T00:01:00.000Z'),
        ownerUserId: 'user_owner',
        scope: 'server-admin',
        tokenId: 'tok_second',
        workspaceIds: [],
      });
      expect(
        setDefaultServerAdminTokenId(
          coreDb,
          'user_owner',
          first.tokenId,
          new Date('2026-07-19T01:00:00.000Z')
        )
      ).toBe(true);
      expect(
        resolveSessionDeploymentAdminTokenId(
          coreDb,
          'user_owner',
          new Date('2026-07-19T01:00:00.000Z')
        )
      ).toBe(first.tokenId);

      revokeOpenKitAccessTokenRecord(coreDb, first.tokenId, new Date('2026-07-19T02:00:00.000Z'));
      expect(
        resolveSessionDeploymentAdminTokenId(
          coreDb,
          'user_owner',
          new Date('2026-07-19T02:00:00.000Z')
        )
      ).toBe(second.tokenId);

      coreDb.sqlite
        .prepare("UPDATE users SET status = 'disabled', disabled_at = ? WHERE id = ?")
        .run('2026-07-19T03:00:00.000Z', 'user_owner');
      expect(
        resolveSessionDeploymentAdminTokenId(
          coreDb,
          'user_owner',
          new Date('2026-07-19T03:00:00.000Z')
        )
      ).toBeNull();
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('ignores other owners and non-admin scopes when resolving derived administration', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-token-scoped-resolve-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);
      insertCanonicalUser(coreDb, 'user_other', 'Other', 'other@example.com');
      const owned = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2026-07-20T00:00:00.000Z',
        now: new Date('2026-07-19T00:00:00.000Z'),
        ownerUserId: 'user_owner',
        scope: 'server-admin',
        tokenId: 'tok_owned_admin',
        workspaceIds: [],
      });
      createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2026-07-20T00:00:00.000Z',
        now: new Date('2026-07-19T00:02:00.000Z'),
        ownerUserId: 'user_other',
        scope: 'server-admin',
        tokenId: 'tok_other_admin',
        workspaceIds: [],
      });
      createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2026-07-20T00:00:00.000Z',
        now: new Date('2026-07-19T00:03:00.000Z'),
        ownerUserId: 'user_owner',
        scope: 'workspace',
        tokenId: 'tok_owned_workspace',
        workspaceIds: ['ws_demo'],
      });

      expect(
        resolveSessionDeploymentAdminTokenId(
          coreDb,
          'user_owner',
          new Date('2026-07-19T01:00:00.000Z')
        )
      ).toBe(owned.tokenId);
      expect(
        listOwnedServerAdminAccessTokens(coreDb, 'user_owner', new Date('2026-07-19T01:00:00.000Z'))
      ).toMatchObject({
        defaultTokenId: owned.tokenId,
        items: [{ tokenId: owned.tokenId, ownerUserId: 'user_owner', scope: 'server-admin' }],
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('keeps a rotated default usable during grace then falls back after grace expires', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-token-rotation-grace-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);
      const predecessor = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2026-07-20T00:00:00.000Z',
        now: new Date('2026-07-19T00:00:00.000Z'),
        ownerUserId: 'user_owner',
        scope: 'server-admin',
        tokenId: 'tok_rotated_default',
        workspaceIds: [],
      });
      expect(
        setDefaultServerAdminTokenId(
          coreDb,
          'user_owner',
          predecessor.tokenId,
          new Date('2026-07-19T00:30:00.000Z')
        )
      ).toBe(true);
      const rotated = rotateOpenKitAccessTokenRecord(coreDb, predecessor.tokenId, {
        graceSeconds: 60,
        now: new Date('2026-07-19T01:00:00.000Z'),
      });

      expect(
        resolveSessionDeploymentAdminTokenId(
          coreDb,
          'user_owner',
          new Date('2026-07-19T01:00:30.000Z')
        )
      ).toBe(predecessor.tokenId);
      expect(
        resolveSessionDeploymentAdminTokenId(
          coreDb,
          'user_owner',
          new Date('2026-07-19T01:01:01.000Z')
        )
      ).toBe(rotated?.tokenId);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('does not grant derived administration from an expired default token', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-token-expired-default-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);
      const expired = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2026-07-19T02:00:00.000Z',
        now: new Date('2026-07-19T00:00:00.000Z'),
        ownerUserId: 'user_owner',
        scope: 'server-admin',
        tokenId: 'tok_expired_default',
        workspaceIds: [],
      });
      expect(
        setDefaultServerAdminTokenId(
          coreDb,
          'user_owner',
          expired.tokenId,
          new Date('2026-07-19T01:00:00.000Z')
        )
      ).toBe(true);
      expect(
        resolveSessionDeploymentAdminTokenId(
          coreDb,
          'user_owner',
          new Date('2026-07-19T03:00:00.000Z')
        )
      ).toBeNull();
    } finally {
      coreDb.sqlite.close();
    }
  });
});

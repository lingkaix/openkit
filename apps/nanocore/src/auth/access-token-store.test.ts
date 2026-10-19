import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  createOpenKitAccessTokenRecord,
  listOpenKitAccessTokenRecords,
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
  insertCanonicalUser(
    coreDb,
    'usr_00000000-0000-7011-88df-c2b1e8466b6f',
    'Owner',
    'owner@example.com'
  );
}

describe('OpenKit access token store', () => {
  it('writes v1 workspace bindings and reads them through native verification', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-token-bindings-v1-'));
    onTestFinished(() => rmSync(dataRoot, { recursive: true, force: true }));
    const coreDb = openCoreDb(dataRoot);
    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);
      const workspaceIds = ['ws_00000000-0000-7000-8000-000000000001'];
      const issued = createOpenKitAccessTokenRecord(coreDb, {
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        scope: 'workspace',
        workspaceIds,
        expiresAt: '2026-07-07T00:00:00.000Z',
        now: new Date('2026-07-06T00:00:00.000Z'),
      });
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT schema_version AS schemaVersion, workspace_ids_json FROM openkit_access_tokens'
          )
          .get()
      ).toEqual({ schemaVersion: 1, workspace_ids_json: JSON.stringify(workspaceIds) });
      expect(
        verifyOpenKitAccessTokenRecord(coreDb, issued.secret, {
          now: new Date('2026-07-06T00:01:00.000Z'),
        })?.workspaceIds
      ).toEqual(workspaceIds);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('refuses unknown binding formats before malformed JSON and token metadata effects', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-token-bindings-version-'));
    onTestFinished(() => rmSync(dataRoot, { recursive: true, force: true }));
    const coreDb = openCoreDb(dataRoot);
    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);
      const issued = createOpenKitAccessTokenRecord(coreDb, {
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        scope: 'workspace',
        workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
        expiresAt: '2026-07-07T00:00:00.000Z',
        now: new Date('2026-07-06T00:00:00.000Z'),
      });
      coreDb.sqlite
        .prepare('UPDATE openkit_access_tokens SET schema_version = 2, workspace_ids_json = ?')
        .run('{');

      expect(() => listOpenKitAccessTokenRecords(coreDb)).toThrow(
        'Unsupported retained record format.'
      );
      expect(() =>
        verifyOpenKitAccessTokenRecord(coreDb, issued.secret, {
          now: new Date('2026-07-06T00:01:00.000Z'),
        })
      ).toThrow('Unsupported retained record format.');
      expect(() => revokeOpenKitAccessTokenRecord(coreDb, issued.tokenId)).toThrow(
        'Unsupported retained record format.'
      );
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT schema_version AS schemaVersion, workspace_ids_json, status, last_used_at, revoked_at FROM openkit_access_tokens'
          )
          .get()
      ).toEqual({
        schemaVersion: 2,
        workspace_ids_json: '{',
        status: 'active',
        last_used_at: null,
        revoked_at: null,
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('writes and resolves a v1 per-user default setting with descriptive additions', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-token-default-v1-'));
    onTestFinished(() => rmSync(dataRoot, { recursive: true, force: true }));
    const coreDb = openCoreDb(dataRoot);
    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);
      const ownerUserId = 'usr_00000000-0000-7011-88df-c2b1e8466b6f';
      const now = new Date('2026-07-06T00:00:00.000Z');
      const issued = createOpenKitAccessTokenRecord(coreDb, {
        ownerUserId,
        scope: 'server-admin',
        workspaceIds: [],
        expiresAt: '2026-07-07T00:00:00.000Z',
        now,
      });
      expect(setDefaultServerAdminTokenId(coreDb, ownerUserId, issued.tokenId, now)).toBe(true);
      const key = `auth.default_server_admin_token.${ownerUserId}`;
      expect(
        coreDb.sqlite
          .prepare('SELECT schema_version AS schemaVersion FROM server_settings WHERE key = ?')
          .get(key)
      ).toEqual({ schemaVersion: 1 });
      const value = JSON.stringify({ tokenId: issued.tokenId, futureNote: 'retained' });
      coreDb.sqlite.prepare('UPDATE server_settings SET value = ? WHERE key = ?').run(value, key);

      expect(
        resolveSessionDeploymentAdminTokenId(coreDb, ownerUserId, now) === issued.tokenId
      ).toBe(true);
      const retained = coreDb.sqlite
        .prepare('SELECT value FROM server_settings WHERE key = ?')
        .get(key) as {
        value: string;
      };
      expect(retained.value === value).toBe(true);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('refuses an unknown default format before malformed JSON or token fallback and replacement', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-token-default-version-'));
    onTestFinished(() => rmSync(dataRoot, { recursive: true, force: true }));
    const coreDb = openCoreDb(dataRoot);
    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);
      const ownerUserId = 'usr_00000000-0000-7011-88df-c2b1e8466b6f';
      const now = new Date('2026-07-06T00:00:00.000Z');
      const issued = createOpenKitAccessTokenRecord(coreDb, {
        ownerUserId,
        scope: 'server-admin',
        workspaceIds: [],
        expiresAt: '2026-07-07T00:00:00.000Z',
        now,
      });
      setDefaultServerAdminTokenId(coreDb, ownerUserId, issued.tokenId, now);
      const key = `auth.default_server_admin_token.${ownerUserId}`;
      coreDb.sqlite
        .prepare('UPDATE server_settings SET schema_version = 2, value = ? WHERE key = ?')
        .run('{', key);

      expect(() => resolveSessionDeploymentAdminTokenId(coreDb, ownerUserId, now)).toThrow(
        'Unsupported retained record format.'
      );
      expect(() => setDefaultServerAdminTokenId(coreDb, ownerUserId, issued.tokenId, now)).toThrow(
        'Unsupported retained record format.'
      );
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT schema_version AS schemaVersion, value FROM server_settings WHERE key = ?'
          )
          .get(key)
      ).toEqual({ schemaVersion: 2, value: '{' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('stores only a hashed token secret and verifies active server-admin tokens', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-token-store-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);

      const issued = createOpenKitAccessTokenRecord(coreDb, {
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
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
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
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
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        scope: 'workspace',
        workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
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
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        scope: 'workspace',
        workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
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
          workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
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
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        scope: 'server-admin',
        workspaceIds: [],
      });

      coreDb.sqlite
        .prepare("UPDATE users SET status = 'disabled', disabled_at = ? WHERE id = ?")
        .run('2026-07-19T01:00:00.000Z', 'usr_00000000-0000-7011-88df-c2b1e8466b6f');

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
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        scope: 'server-admin',
        tokenId: 'tok_00000000-0000-7fa0-9bc0-c08437888ae6',
        workspaceIds: [],
      });
      expect(
        resolveSessionDeploymentAdminTokenId(
          coreDb,
          'usr_00000000-0000-7011-88df-c2b1e8466b6f',
          new Date('2026-07-19T01:00:00.000Z')
        )
      ).toBe(first.tokenId);

      const second = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2026-07-20T00:00:00.000Z',
        now: new Date('2026-07-19T00:01:00.000Z'),
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        scope: 'server-admin',
        tokenId: 'tok_00000000-0000-7126-868e-eff87c2f1527',
        workspaceIds: [],
      });
      expect(
        setDefaultServerAdminTokenId(
          coreDb,
          'usr_00000000-0000-7011-88df-c2b1e8466b6f',
          first.tokenId,
          new Date('2026-07-19T01:00:00.000Z')
        )
      ).toBe(true);
      expect(
        resolveSessionDeploymentAdminTokenId(
          coreDb,
          'usr_00000000-0000-7011-88df-c2b1e8466b6f',
          new Date('2026-07-19T01:00:00.000Z')
        )
      ).toBe(first.tokenId);

      revokeOpenKitAccessTokenRecord(coreDb, first.tokenId, new Date('2026-07-19T02:00:00.000Z'));
      expect(
        resolveSessionDeploymentAdminTokenId(
          coreDb,
          'usr_00000000-0000-7011-88df-c2b1e8466b6f',
          new Date('2026-07-19T02:00:00.000Z')
        )
      ).toBe(second.tokenId);

      coreDb.sqlite
        .prepare("UPDATE users SET status = 'disabled', disabled_at = ? WHERE id = ?")
        .run('2026-07-19T03:00:00.000Z', 'usr_00000000-0000-7011-88df-c2b1e8466b6f');
      expect(
        resolveSessionDeploymentAdminTokenId(
          coreDb,
          'usr_00000000-0000-7011-88df-c2b1e8466b6f',
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
      insertCanonicalUser(
        coreDb,
        'usr_00000000-0000-73d4-904a-d4c4b905df7c',
        'Other',
        'other@example.com'
      );
      const owned = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2026-07-20T00:00:00.000Z',
        now: new Date('2026-07-19T00:00:00.000Z'),
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        scope: 'server-admin',
        tokenId: 'tok_00000000-0000-7f81-8336-f719a9275d51',
        workspaceIds: [],
      });
      createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2026-07-20T00:00:00.000Z',
        now: new Date('2026-07-19T00:02:00.000Z'),
        ownerUserId: 'usr_00000000-0000-73d4-904a-d4c4b905df7c',
        scope: 'server-admin',
        tokenId: 'tok_00000000-0000-7838-8e03-7dbb4662f1bc',
        workspaceIds: [],
      });
      createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2026-07-20T00:00:00.000Z',
        now: new Date('2026-07-19T00:03:00.000Z'),
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        scope: 'workspace',
        tokenId: 'tok_00000000-0000-7333-aa83-da8dbcad317a',
        workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
      });

      expect(
        resolveSessionDeploymentAdminTokenId(
          coreDb,
          'usr_00000000-0000-7011-88df-c2b1e8466b6f',
          new Date('2026-07-19T01:00:00.000Z')
        )
      ).toBe(owned.tokenId);
      expect(
        listOwnedServerAdminAccessTokens(
          coreDb,
          'usr_00000000-0000-7011-88df-c2b1e8466b6f',
          new Date('2026-07-19T01:00:00.000Z')
        )
      ).toMatchObject({
        defaultTokenId: owned.tokenId,
        items: [
          {
            tokenId: owned.tokenId,
            ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
            scope: 'server-admin',
          },
        ],
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
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        scope: 'server-admin',
        tokenId: 'tok_00000000-0000-740c-8a46-0b008fe77362',
        workspaceIds: [],
      });
      expect(
        setDefaultServerAdminTokenId(
          coreDb,
          'usr_00000000-0000-7011-88df-c2b1e8466b6f',
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
          'usr_00000000-0000-7011-88df-c2b1e8466b6f',
          new Date('2026-07-19T01:00:30.000Z')
        )
      ).toBe(predecessor.tokenId);
      expect(
        resolveSessionDeploymentAdminTokenId(
          coreDb,
          'usr_00000000-0000-7011-88df-c2b1e8466b6f',
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
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        scope: 'server-admin',
        tokenId: 'tok_00000000-0000-7b45-bea8-c8ed5db0e0f4',
        workspaceIds: [],
      });
      expect(
        setDefaultServerAdminTokenId(
          coreDb,
          'usr_00000000-0000-7011-88df-c2b1e8466b6f',
          expired.tokenId,
          new Date('2026-07-19T01:00:00.000Z')
        )
      ).toBe(true);
      expect(
        resolveSessionDeploymentAdminTokenId(
          coreDb,
          'usr_00000000-0000-7011-88df-c2b1e8466b6f',
          new Date('2026-07-19T03:00:00.000Z')
        )
      ).toBeNull();
    } finally {
      coreDb.sqlite.close();
    }
  });
});

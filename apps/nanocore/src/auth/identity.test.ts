import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  actorFromRequest,
  actorFromSession,
  ensureLocalUser,
  isDeploymentAdminActor,
} from './identity.js';

describe('actorFromRequest', () => {
  it('returns the recorded canonical User in local mode', () => {
    const actor = actorFromRequest(
      new Request('http://localhost/api/meta'),
      'local',
      'usr_00000000-0000-7000-8000-000000000001'
    );

    expect(actor).toEqual({ userId: 'usr_00000000-0000-7000-8000-000000000001', kind: 'local' });
  });
});

describe('actorFromSession', () => {
  it('preserves the canonical non-secret authentication session record id', () => {
    const id = 'usr_01890f3e-0000-7000-8000-000000000001';
    const sessionId = 'auth_01890f3e-0000-7000-8000-000000000001';
    expect(actorFromSession({ user: { id }, session: { id: sessionId } })).toEqual({
      userId: id,
      kind: 'session',
      sessionId,
    });
  });
  it('keeps the exact canonical recorded User and refuses another identity kind', () => {
    const id = 'usr_01890f3e-0000-7000-8000-000000000001';
    expect(actorFromSession({ user: { id } })).toEqual({ userId: id, kind: 'session' });
    for (const invalid of [
      'user_local',
      'usr_01890f3e-0000-4000-8000-000000000001',
      'auth_01890f3e-0000-7000-8000-000000000001',
    ]) {
      expect(() => actorFromSession({ user: { id: invalid } })).toThrow(
        'Canonical session User authority is unavailable.'
      );
    }
  });
});

describe('isDeploymentAdminActor', () => {
  it('allows the local actor, server-admin bearer tokens, and sessions with a resolved admin token id', () => {
    expect(
      isDeploymentAdminActor({ userId: 'usr_00000000-0000-7000-8000-000000000001', kind: 'local' })
    ).toBe(true);
    expect(
      isDeploymentAdminActor({
        userId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        kind: 'token',
        tokenScope: 'server-admin',
      })
    ).toBe(true);
    expect(
      isDeploymentAdminActor({
        userId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        kind: 'session',
        adminTokenId: 'tok_00000000-0000-75c5-b4dc-6661b8eac629',
      })
    ).toBe(true);
    expect(
      isDeploymentAdminActor({
        userId: 'usr_00000000-0000-7d56-82f8-ec994b63859b',
        kind: 'session',
      })
    ).toBe(false);
    expect(
      isDeploymentAdminActor({
        userId: 'usr_00000000-0000-7d56-82f8-ec994b63859b',
        kind: 'token',
        tokenScope: 'workspace',
      })
    ).toBe(false);
    expect(
      isDeploymentAdminActor({
        userId: 'usr_00000000-0000-7d56-82f8-ec994b63859b',
        kind: 'token',
        tokenScope: 'workspace-readonly',
      })
    ).toBe(false);
    expect(isDeploymentAdminActor(undefined)).toBe(false);
  });
});

describe('ensureLocalUser', () => {
  it('allocates once and returns the same recorded local User', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-local-user-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      const localUserId = ensureLocalUser(coreDb);
      expect(localUserId).toMatch(
        /^usr_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
      expect(ensureLocalUser(coreDb)).toBe(localUserId);

      const row = coreDb.sqlite
        .prepare('SELECT COUNT(*) AS count FROM users WHERE id = ?')
        .get(localUserId) as {
        count: number;
      };
      const user = coreDb.sqlite
        .prepare('SELECT kind, display_name, email, email_verified, image FROM users WHERE id = ?')
        .get(localUserId) as {
        display_name: string;
        email: string;
        email_verified: number;
        image: string | null;
        kind: string;
      };

      expect(row.count).toBe(1);
      const { email: _fixtureAddress, ...metadata } = user;
      expect(metadata).toEqual({
        display_name: 'Local User',
        email_verified: 0,
        image: null,
        kind: 'local',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });
});

const roots: string[] = [];
const databases: ReturnType<typeof openCoreDb>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.sqlite.open) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
/** Opens a fresh owned SQLite fixture with the real migration and identity owners. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'openkit-id-local-'));
  roots.push(root);
  const db = openCoreDb(root);
  databases.push(db);
  applyMigrations(db);
  return { root, db };
}

describe('canonical local User authority', () => {
  it('allocates once, reuses the row after reopen and preserves a disabled identity', () => {
    const { root, db } = fixture();
    const id = ensureLocalUser(db);
    expect(id).toMatch(/^usr_[0-9a-f-]{14}7[0-9a-f-]{21}$/);
    expect(ensureLocalUser(db)).toBe(id);
    db.sqlite.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(id);
    db.sqlite.close();
    const reopened = openCoreDb(root);
    databases.push(reopened);
    applyMigrations(reopened);
    expect(ensureLocalUser(reopened)).toBe(id);
    expect(reopened.sqlite.prepare('SELECT id, status FROM users').all()).toEqual([
      { id, status: 'disabled' },
    ]);
  });
  it('does not recreate missing local authority in the same initialized connection', () => {
    const { db } = fixture();
    ensureLocalUser(db);
    db.sqlite.prepare("DELETE FROM users WHERE kind = 'local'").run();
    expect(() => ensureLocalUser(db)).toThrow();
    expect(db.sqlite.prepare('SELECT id FROM users').all()).toEqual([]);
  });
  it('does not recreate missing local authority after reopen', () => {
    const { root, db } = fixture();
    ensureLocalUser(db);
    db.sqlite.prepare("DELETE FROM users WHERE kind = 'local'").run();
    db.sqlite.close();
    const reopened = openCoreDb(root);
    databases.push(reopened);
    applyMigrations(reopened);
    expect(() => ensureLocalUser(reopened)).toThrow();
    expect(reopened.sqlite.prepare('SELECT id FROM users').all()).toEqual([]);
  });
  it('refuses ambiguous local authority without mutating either recorded identity', () => {
    const { db } = fixture();
    const id = ensureLocalUser(db);
    db.sqlite
      .prepare(`INSERT INTO users (id, kind, display_name, email, email_verified, created_at, updated_at, status)
      SELECT ?, kind, display_name, 'second-local@example.invalid', email_verified, created_at, updated_at, status FROM users WHERE id = ?`)
      .run('usr_01890f3e-0000-7000-8000-000000000002', id);
    const before = db.sqlite.serialize();
    expect(() => ensureLocalUser(db)).toThrow();
    expect(db.sqlite.serialize().equals(before)).toBe(true);
  });
  it('does not treat an empty lookup on an existing database as fresh initialization', () => {
    const { root, db } = fixture();
    db.sqlite.close();
    const reopened = openCoreDb(root);
    databases.push(reopened);
    applyMigrations(reopened);
    expect(() => ensureLocalUser(reopened)).toThrow();
    expect(reopened.sqlite.prepare('SELECT id FROM users').all()).toEqual([]);
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { ensureLocalUser } from './identity.js';

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

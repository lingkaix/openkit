import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createBetterAuth } from './better-auth.js';

describe('createBetterAuth', () => {
  it('boots against migrated server-scope Core SQLite with Better Auth tables', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-better-auth-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      applyMigrations(coreDb);

      const auth = createBetterAuth(coreDb);
      const tables = ['users', 'session', 'account', 'verification'];

      expect(auth).toBeDefined();

      for (const table of tables) {
        const row = coreDb.sqlite
          .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(table) as { count: number };

        expect(row.count).toBe(1);
      }

      const legacyUserTable = coreDb.sqlite
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('user') as { count: number };

      expect(legacyUserTable.count).toBe(0);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('stores signed-up Better Auth users in the canonical OpenKit users table', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-better-auth-users-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      const auth = createBetterAuth(coreDb);
      const response = await auth.handler(
        new Request('http://127.0.0.1:3000/api/auth/sign-up/email', {
          body: JSON.stringify({
            email: 'canonical@example.com',
            name: 'Canonical User',
            password: 'password123456',
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        })
      );
      const row = coreDb.sqlite
        .prepare(
          `SELECT display_name, email, email_verified, kind
           FROM users
           WHERE email = ?`
        )
        .get('canonical@example.com') as
        | { display_name: string; email: string; email_verified: number; kind: string }
        | undefined;

      expect(response.status).toBe(200);
      expect(row).toEqual({
        display_name: 'Canonical User',
        email: 'canonical@example.com',
        email_verified: 0,
        kind: 'human',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });
});

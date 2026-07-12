import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { actorFromRequest, ensureLocalUser, isDeploymentAdminActor } from './identity.js';

describe('actorFromRequest', () => {
  it('returns the implicit local actor in local mode', () => {
    const actor = actorFromRequest(new Request('http://localhost/api/meta'), 'local');

    expect(actor).toEqual({ userId: 'user_local', kind: 'local' });
  });
});

describe('isDeploymentAdminActor', () => {
  it('allows only the local actor and server-admin bearer tokens', () => {
    expect(isDeploymentAdminActor({ userId: 'user_local', kind: 'local' })).toBe(true);
    expect(
      isDeploymentAdminActor({
        userId: 'user_owner',
        kind: 'token',
        tokenScope: 'server-admin',
      })
    ).toBe(true);
    expect(isDeploymentAdminActor({ userId: 'user_member', kind: 'session' })).toBe(false);
    expect(
      isDeploymentAdminActor({
        userId: 'user_member',
        kind: 'token',
        tokenScope: 'workspace',
      })
    ).toBe(false);
    expect(
      isDeploymentAdminActor({
        userId: 'user_member',
        kind: 'token',
        tokenScope: 'workspace-readonly',
      })
    ).toBe(false);
    expect(isDeploymentAdminActor(undefined)).toBe(false);
  });
});

describe('ensureLocalUser', () => {
  it('upserts user_local idempotently', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-local-user-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      ensureLocalUser(coreDb);
      ensureLocalUser(coreDb);

      const row = coreDb.sqlite
        .prepare('SELECT COUNT(*) AS count FROM users WHERE id = ?')
        .get('user_local') as {
        count: number;
      };
      const user = coreDb.sqlite
        .prepare('SELECT kind, display_name, email, email_verified, image FROM users WHERE id = ?')
        .get('user_local') as {
        display_name: string;
        email: string;
        email_verified: number;
        image: string | null;
        kind: string;
      };

      expect(row.count).toBe(1);
      expect(user).toEqual({
        display_name: 'Local User',
        email: 'user_local@local.openkit.invalid',
        email_verified: 0,
        image: null,
        kind: 'local',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });
});

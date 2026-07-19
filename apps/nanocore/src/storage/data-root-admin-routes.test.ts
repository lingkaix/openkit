import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataRootBackupCreateResponseSchema } from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { ensureLocalUser } from '../auth/identity.js';
import { openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';

describe('data-root admin routes', () => {
  it('reserves every data-root administration route for deployment administrators', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-data-root-admin-authority-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    coreDb.sqlite
      .prepare(
        `INSERT INTO users
          (id, display_name, email, email_verified, created_at, updated_at, kind)
         VALUES ('user_data_root_admin', 'Data Root User',
                 'data-root-user@example.com', false, ?, ?, 'human')`
      )
      .run(Date.now(), Date.now());
    const serverAdmin = createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2999-01-01T00:00:00.000Z',
      ownerUserId: 'user_local',
      scope: 'server-admin',
      workspaceIds: [],
    });
    const workspace = createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2999-01-01T00:00:00.000Z',
      ownerUserId: 'user_local',
      scope: 'workspace',
      workspaceIds: ['ws_demo'],
    });
    const readonly = createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2999-01-01T00:00:00.000Z',
      ownerUserId: 'user_local',
      scope: 'workspace-readonly',
      workspaceIds: ['ws_demo'],
    });
    const app = createApp({
      auth: {
        api: {
          getSession: async () => ({
            session: { id: 'session_data_root_admin' },
            user: { id: 'user_data_root_admin' },
          }),
        },
        handler: async () => Response.json({ status: 'auth-ok' }),
      },
      coreDb,
      dataRoot,
      mode: 'server',
    });

    try {
      const adminHeaders = { authorization: `Bearer ${serverAdmin.secret}` };
      const adminLayout = await app.request('/api/app/storage/layout-report', {
        headers: adminHeaders,
      });
      const adminCreate = await app.request('/api/app/data-root/backups', {
        method: 'POST',
        headers: adminHeaders,
      });
      expect(adminCreate.status).toBe(200);
      const { backupId } = DataRootBackupCreateResponseSchema.parse(await adminCreate.json());
      const adminVerify = await app.request(`/api/app/data-root/backups/${backupId}/verify`, {
        method: 'POST',
        headers: adminHeaders,
      });

      expect(adminLayout.status).toBe(200);
      expect(adminVerify.status).toBe(200);

      const sessionResponses = await Promise.all([
        app.request('/api/app/storage/layout-report'),
        app.request('/api/app/data-root/backups', { method: 'POST' }),
        app.request(`/api/app/data-root/backups/${backupId}/verify`, { method: 'POST' }),
      ]);
      for (const response of sessionResponses) {
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({
          code: 'data_root_admin_forbidden',
        });
      }

      for (const token of [workspace, readonly]) {
        const headers = { authorization: `Bearer ${token.secret}` };
        const responses = await Promise.all([
          app.request('/api/app/storage/layout-report', { headers }),
          app.request('/api/app/data-root/backups', { method: 'POST', headers }),
          app.request(`/api/app/data-root/backups/${backupId}/verify`, {
            method: 'POST',
            headers,
          }),
        ]);

        for (const response of responses) {
          expect(response.status).toBe(403);
        }
        await expect(responses[0]?.json()).resolves.toMatchObject({
          code: 'data_root_admin_forbidden',
        });
      }
    } finally {
      coreDb.sqlite.close();
    }
  });
});

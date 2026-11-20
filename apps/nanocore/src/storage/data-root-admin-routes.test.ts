import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { createAppWithLocalIdentity as createApp } from '../test-support/app.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { getControlStoreWorkerClient } from './control-store-worker-client.js';
import { createDataRootAdminOperationImplementations } from './data-root-admin-operations.js';
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
         VALUES ('usr_00000000-0000-7a32-be12-523efe7f4c43', 'Data Root User',
                 'data-root-user@example.com', false, ?, ?, 'human')`
      )
      .run(Date.now(), Date.now());
    const serverAdmin = createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2999-01-01T00:00:00.000Z',
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      scope: 'server-admin',
      workspaceIds: [],
    });
    const workspace = createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2999-01-01T00:00:00.000Z',
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      scope: 'workspace',
      workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
    });
    const readonly = createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2999-01-01T00:00:00.000Z',
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      scope: 'workspace-readonly',
      workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
    });
    const { backupId } = await createDataRootAdminOperationImplementations(
      dataRoot,
      undefined,
      async () => () => {}
    )['backup.create']();
    const app = createApp({
      auth: {
        api: {
          getSession: async () => ({
            session: { id: 'session_data_root_admin' },
            user: { id: 'usr_00000000-0000-7a32-be12-523efe7f4c43' },
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
      const adminLayout = await app.request(
        ...operationRequest(
          'storage.layout-report',
          {},
          {
            headers: adminHeaders,
          }
        )
      );
      const adminCreate = await app.request(
        ...operationRequest(
          'backup.create',
          {},
          {
            method: 'POST',
            headers: adminHeaders,
          }
        )
      );
      expect(adminCreate.status).toBe(503);
      await expect(adminCreate.json()).resolves.toMatchObject({
        code: 'data_root_backup_unavailable',
      });
      expect(readdirSync(`${dataRoot}.backups`)).toEqual([backupId]);
      const adminVerify = await app.request(
        ...operationRequest(
          'backup.verify',
          { backupId: backupId },
          {
            method: 'POST',
            headers: adminHeaders,
          }
        )
      );

      expect(adminLayout.status).toBe(200);
      expect(adminVerify.status).toBe(200);

      const sessionResponses = await Promise.all([
        app.request(...operationRequest('storage.layout-report', {})),
        app.request(...operationRequest('backup.create', {}, { method: 'POST' })),
        app.request(
          ...operationRequest('backup.verify', { backupId: backupId }, { method: 'POST' })
        ),
      ]);
      for (const response of sessionResponses) {
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({
          code: 'deployment_admin_required',
        });
      }

      for (const token of [workspace, readonly]) {
        const headers = { authorization: `Bearer ${token.secret}` };
        const responses = await Promise.all([
          app.request(...operationRequest('storage.layout-report', {}, { headers })),
          app.request(...operationRequest('backup.create', {}, { method: 'POST', headers })),
          app.request(
            ...operationRequest(
              'backup.verify',
              { backupId: backupId },
              {
                method: 'POST',
                headers,
              }
            )
          ),
        ]);

        for (const response of responses) {
          expect(response.status).toBe(403);
        }
        await expect(responses[0]?.json()).resolves.toMatchObject({
          code: 'deployment_admin_required',
        });
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('waits for an accepted file publisher before holding SQLite and keeps it sealed through capture', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-data-root-file-drain-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    coreDb.sqlite.close();

    await expect(
      createDataRootAdminOperationImplementations(dataRoot, undefined, async () => null)[
        'backup.create'
      ]()
    ).rejects.toMatchObject({ code: 'data_root_backup_unavailable', status: 503 });
    expect(existsSync(`${dataRoot}.backups`)).toBe(false);

    const publisherEntered = Promise.withResolvers<void>();
    const finishPublication = Promise.withResolvers<void>();
    const original = 'One complete original file publication.\r\n';
    const publication = finishPublication.promise.then(() =>
      writeFileSync(join(dataRoot, 'server', 'publisher-output.txt'), original)
    );
    const writer = getControlStoreWorkerClient();
    const nativePause = vi.spyOn(writer, 'pauseForDataRootBackup');
    const resumePublisher = vi.fn(() => {
      const [backup] = readdirSync(`${dataRoot}.backups`);
      expect(
        readFileSync(join(`${dataRoot}.backups`, backup!, 'server', 'publisher-output.txt'), 'utf8')
      ).toBe(original);
    });
    const operations = createDataRootAdminOperationImplementations(
      dataRoot,
      undefined,
      async (root) => {
        expect(root).toBe(dataRoot);
        publisherEntered.resolve();
        await publication;
        return resumePublisher;
      }
    );

    const pending = operations['backup.create']();
    try {
      await publisherEntered.promise;
      expect(nativePause).not.toHaveBeenCalled();
      expect(existsSync(`${dataRoot}.backups`)).toBe(false);
      finishPublication.resolve();
      const result = await pending;
      expect(result.checkedFiles).toContain('server/publisher-output.txt');
      expect(nativePause).toHaveBeenCalledTimes(1);
      expect(resumePublisher).toHaveBeenCalledTimes(1);
    } finally {
      finishPublication.resolve();
      await Promise.allSettled([publication, pending]);
      nativePause.mockRestore();
    }
  });

  it('preserves the HTTP 500 body on an unexpected storage read failure without changing retained bytes or Core users', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-data-root-unexpected-failure-'));
    const coreDb = openCoreDb(dataRoot);
    try {
      applyMigrations(coreDb);
      ensureLocalUser(coreDb);
      const admin = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        scope: 'server-admin',
        workspaceIds: [],
      });
      const app = createApp({ coreDb, dataRoot, mode: 'server' });
      // Corruption is introduced after startup so the real request reaches the layout reader's SQLite failure.
      const damagedDbDirectory = join(
        dataRoot,
        'users',
        'usr_00000000-0000-7605-b21c-e43512128d3c',
        'db'
      );
      mkdirSync(damagedDbDirectory, { recursive: true });
      const damagedDb = join(damagedDbDirectory, 'user.sqlite');
      const damagedBytes = Buffer.from('retained malformed SQLite fixture');
      writeFileSync(damagedDb, damagedBytes);
      const usersBefore = coreDb.sqlite.prepare('SELECT * FROM users').all();
      const response = await app.request(
        ...operationRequest(
          'storage.layout-report',
          {},
          { headers: { authorization: `Bearer ${admin.secret}` } }
        )
      );
      expect(response.status).toBe(500);
      expect(await response.text()).toBe('Internal Server Error');
      expect(readFileSync(damagedDb)).toEqual(damagedBytes);
      expect(readdirSync(damagedDbDirectory)).toEqual(['user.sqlite']);
      expect(coreDb.sqlite.prepare('SELECT * FROM users').all()).toEqual(usersBefore);
      expect(existsSync(`${dataRoot}.backups`)).toBe(false);
    } finally {
      coreDb.sqlite.close();
    }
  });
});

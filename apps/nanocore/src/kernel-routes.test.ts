import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ensureLocalUser } from './auth/identity.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const SCHEMA = {
  format: 'openkit.light-app',
  schemaVersion: 1,
  title: 'Membership CRM map',
  purpose: 'Local membership-to-CRM mappings.',
  collections: [
    {
      name: 'mappings',
      type: 'base',
      description: 'Mappings.',
      fields: [
        {
          name: 'membership_id',
          type: 'text',
          required: true,
          description: 'Membership id.',
        },
        {
          name: 'crm_id',
          type: 'text',
          required: true,
          description: 'CRM id.',
        },
        {
          name: 'annotation',
          type: 'text',
          required: false,
          description: 'Local note.',
        },
        {
          name: 'active',
          type: 'bool',
          required: true,
          description: 'Whether the mapping is active.',
        },
      ],
      indexes: [{ fields: ['membership_id', 'crm_id'], unique: true }],
    },
  ],
};

describe('Kernel App API', () => {
  it('creates an app and record through the public routes', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-kernel-routes-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: 'ws_demo',
    });
    const store = createDemoStore({ dataRoot });
    const app = createApp({ coreDb, dataRoot, store });

    try {
      const createResponse = await app.request('/api/app/workspaces/ws_demo/light-apps', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-openkit-request-id': randomUUID(),
        },
        body: JSON.stringify(SCHEMA),
      });
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as {
        appId: string;
        schemaRevision: number;
      };
      const recordResponse = await app.request(
        `/api/app/workspaces/ws_demo/light-apps/${created.appId}/collections/mappings/records`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-openkit-request-id': randomUUID(),
          },
          body: JSON.stringify({
            schemaRevision: created.schemaRevision,
            data: {
              membership_id: 'mem_1',
              crm_id: 'crm_1',
              annotation: 'note',
              active: true,
            },
          }),
        }
      );
      expect(recordResponse.status).toBe(201);
      const listed = await app.request(
        `/api/app/workspaces/ws_demo/light-apps/${created.appId}/collections/mappings/records?schemaRevision=${created.schemaRevision}`
      );
      expect(listed.status).toBe(200);
      await expect(listed.json()).resolves.toMatchObject({
        completeResult: true,
        totalItems: 1,
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('denies a non-member Workspace Light App list', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-kernel-routes-deny-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: 'ws_demo',
    });
    const store = createDemoStore({ dataRoot });
    const app = createApp({ coreDb, dataRoot, store });

    try {
      const response = await app.request('/api/app/workspaces/ws_other/light-apps');
      expect(response.status).toBeGreaterThanOrEqual(400);
    } finally {
      coreDb.sqlite.close();
    }
  });
});

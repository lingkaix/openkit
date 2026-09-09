import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GENERATIVE_UI_NATIVE_CATALOG_ID,
  GENERATIVE_UI_PROTOCOL_VERSION,
} from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';

import { ensureLocalUser } from './auth/identity.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/**
 * Builds native createSurface plus updateComponents messages.
 *
 * @param surfaceId Shared surface id.
 * @param components Complete component set.
 * @returns Producer messages.
 */
function nativeMessages(surfaceId: string, components: unknown[]) {
  return [
    {
      version: GENERATIVE_UI_PROTOCOL_VERSION,
      createSurface: {
        surfaceId,
        catalogId: GENERATIVE_UI_NATIVE_CATALOG_ID,
        sendDataModel: false,
      },
    },
    {
      version: GENERATIVE_UI_PROTOCOL_VERSION,
      updateComponents: { surfaceId, components },
    },
  ];
}

describe('Generative UI App API', () => {
  it('publishes, reads, and refreshes one item-source presentation', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-generative-ui-routes-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: 'ws_demo',
    });
    const store = createDemoStore({ dataRoot });
    const turn = store.createTurn('ws_demo', 'th_demo', 'Publish a generated view', {
      kind: 'user',
      id: 'user_local',
    });
    const sourceItem = store.createItem({
      id: `it_${turn.id}_source`,
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: turn.id,
      type: 'assistant-message',
      status: 'completed',
      text: 'Membership 1 maps to CRM 1.',
      createdAt: turn.startedAt ?? new Date().toISOString(),
      completedAt: turn.startedAt ?? new Date().toISOString(),
    });
    const app = createApp({ coreDb, dataRoot, store });

    try {
      const publishResponse = await app.request(
        '/api/app/workspaces/ws_demo/generative-presentations',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-openkit-request-id': randomUUID(),
          },
          body: JSON.stringify({
            threadId: 'th_demo',
            turnId: turn.id,
            title: 'Mapping view',
            fallbackText: 'Membership 1 maps to CRM 1.',
            messages: nativeMessages('surface-item', [
              {
                id: 'root',
                component: 'Column',
                children: ['body', 'refresh'],
              },
              { id: 'body', component: 'Text', text: { path: '/text' } },
              {
                id: 'refresh',
                component: 'Button',
                child: 'refreshLabel',
                action: { event: { name: 'refreshNow' } },
              },
              {
                id: 'refreshLabel',
                component: 'Text',
                text: 'Refresh',
              },
            ]),
            source: {
              kind: 'item',
              itemId: sourceItem.id,
              contentDigest: `sha256:${createHash('sha256').update(sourceItem.text, 'utf8').digest('hex')}`,
            },
            actions: [{ name: 'refreshNow', componentId: 'refresh', kind: 'refresh' }],
          }),
        }
      );
      expect(publishResponse.status).toBe(201);
      const published = (await publishResponse.json()) as { id: string; publication: string };
      expect(published.publication).toBe('published');
      const getResponse = await app.request(
        `/api/app/workspaces/ws_demo/generative-presentations/${published.id}`
      );
      expect(getResponse.status).toBe(200);
      const refreshResponse = await app.request(
        `/api/app/workspaces/ws_demo/generative-presentations/${published.id}/refresh`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            version: GENERATIVE_UI_PROTOCOL_VERSION,
            action: {
              name: 'refreshNow',
              surfaceId: 'surface-item',
              sourceComponentId: 'refresh',
              timestamp: new Date().toISOString(),
            },
          }),
        }
      );
      expect(refreshResponse.status).toBe(200);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('denies a non-member Workspace presentation read', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-generative-ui-deny-'));
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
      const response = await app.request(
        `/api/app/workspaces/ws_other/generative-presentations/${randomUUID()}`
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
    } finally {
      coreDb.sqlite.close();
    }
  });
});

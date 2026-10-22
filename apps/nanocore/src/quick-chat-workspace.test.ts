import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ListAuthorizedWorkspacesResponseSchema } from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createAppWithLocalIdentity as createApp } from './test-support/app.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { createTestStore } from './test-support/store.js';
import { ensureUserQuickChatWorkspace } from './workspace-membership.js';

describe('personal Workspace mode', () => {
  it('provisions the ordinary owner-only personal Workspace', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-personal-workspace-'));
    const coreDb = openCoreDb(dataRoot);
    try {
      applyMigrations(coreDb);
      const userId = ensureLocalUser(coreDb);
      const store = createTestStore({ dataRoot });
      await ensureUserQuickChatWorkspace({ coreDb, store, userId });
      const app = createApp({ coreDb, dataRoot, store });
      const res = await app.request('/api/app/operations/workspace.list', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = ListAuthorizedWorkspacesResponseSchema.parse(await res.json());

      expect(body.items.map((entry) => entry.workspace)).toContainEqual(
        expect.objectContaining({
          id: 'ws_7d54f339-a119-5221-bbbf-bfbf3e8a3f28',
          name: 'Personal',
          kind: 'personal',
        })
      );
    } finally {
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});

import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createAppWithLocalIdentity as createApp } from '../test-support/app.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { openCoreDb } from './db.js';
import { coreDbPath } from './fs-layout.js';
import { applyMigrations } from './migrate.js';

/**
 * Creates an isolated data root for NanoCore startup layout tests.
 *
 * @returns Absolute temporary data-root path.
 */
function createDataRoot(): string {
  return mkdtempSync(join(tmpdir(), 'openkit-startup-layout-'));
}

describe('NanoCore startup storage layout', () => {
  it('boots the app on the ownership-scoped storage tree', async () => {
    const dataRoot = createDataRoot();
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      ensureLocalUser(coreDb);

      const app = createApp({ coreDb, dataRoot });
      const res = await app.request('/api/app/operations/workspace.list', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      expect(statSync(coreDbPath(dataRoot)).isFile()).toBe(true);
      expect(existsSync(join(dataRoot, 'core.sqlite'))).toBe(false);

      for (const path of [
        join(dataRoot, 'server', 'db'),
        join(dataRoot, 'server', 'evidence'),
        join(dataRoot, 'server', 'exports'),
        join(dataRoot, 'users', 'usr_00000000-0000-7000-8000-000000000001', 'db'),
        join(
          dataRoot,
          'workspaces',
          'ws_7d54f339-a119-5221-bbbf-bfbf3e8a3f28',
          'workspace-record.json'
        ),
        join(
          dataRoot,
          'workspaces',
          'ws_7d54f339-a119-5221-bbbf-bfbf3e8a3f28',
          'config',
          'workspace.jsonc'
        ),
        join(dataRoot, 'workspaces', 'ws_7d54f339-a119-5221-bbbf-bfbf3e8a3f28', 'knowledge'),
        join(dataRoot, 'workspaces', 'ws_7d54f339-a119-5221-bbbf-bfbf3e8a3f28', 'sources'),
        join(dataRoot, 'workspaces', 'ws_7d54f339-a119-5221-bbbf-bfbf3e8a3f28', 'indexes'),
      ]) {
        expect(existsSync(path)).toBe(true);
      }

      expect(
        existsSync(
          join(dataRoot, 'workspaces', 'ws_7d54f339-a119-5221-bbbf-bfbf3e8a3f28', 'memory')
        )
      ).toBe(false);
    } finally {
      coreDb.sqlite.close();
    }
  });
});

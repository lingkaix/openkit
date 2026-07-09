import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { ensureLocalUser } from '../auth/identity.js';
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
      const res = await app.request('/api/workspaces');

      expect(res.status).toBe(200);
      expect(statSync(coreDbPath(dataRoot)).isFile()).toBe(true);
      expect(existsSync(join(dataRoot, 'core.sqlite'))).toBe(false);

      for (const path of [
        join(dataRoot, 'server', 'db'),
        join(dataRoot, 'server', 'evidence'),
        join(dataRoot, 'server', 'exports'),
        join(dataRoot, 'users', 'user_local', 'db'),
        join(dataRoot, 'users', 'user_local', 'workspaces', 'ws_quick_chat', 'workspace.json'),
        join(dataRoot, 'users', 'user_local', 'workspaces', 'ws_quick_chat', 'knowledge'),
        join(dataRoot, 'users', 'user_local', 'workspaces', 'ws_quick_chat', 'sources'),
        join(dataRoot, 'users', 'user_local', 'workspaces', 'ws_quick_chat', 'indexes'),
      ]) {
        expect(existsSync(path)).toBe(true);
      }

      expect(
        existsSync(join(dataRoot, 'users', 'user_local', 'workspaces', 'ws_quick_chat', 'memory'))
      ).toBe(false);
    } finally {
      coreDb.sqlite.close();
    }
  });
});

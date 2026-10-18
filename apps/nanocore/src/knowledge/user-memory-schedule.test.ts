import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import type { RuntimeConfigManager } from '../config/runtime-config.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { scanUserMemoryMaintenance } from './user-memory-schedule.js';

it('keeps User scheduling off by default and never inherits an unpresented administrator credential', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'memory-daily-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: userId,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  const store = new FsStore({ dataRoot });
  let schedule: { enabled: boolean } | undefined;
  const runtimeConfigManager = {
    current: () => ({
      userConfigs: [
        {
          userId,
          config: { knowledgeMaintenance: { enabled: true, schedule, reviewRequiredPageIds: [] } },
        },
      ],
    }),
  } as unknown as RuntimeConfigManager;
  const dependencies = vi.fn(() => {
    throw new Error('Unpresented credentials must not start a run.');
  });
  const scan = (now: string) =>
    scanUserMemoryMaintenance({ now, coreDb, store, runtimeConfigManager, dependencies });
  const turns = () =>
    store
      .listWorkspaces()
      .flatMap((workspace) =>
        store
          .listThreads(workspace.id)
          .flatMap((thread) => store.listThreadTurns(workspace.id, thread.id))
      );
  onTestFinished(() => {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  scan('2026-10-18T00:00:00.000Z');
  expect(turns()).toEqual([]);
  schedule = { enabled: true };
  scan('2026-10-18T00:00:00.000Z');
  expect(dependencies).not.toHaveBeenCalled();
  expect(turns()).toHaveLength(1);
  expect(turns()[0]).toMatchObject({
    status: 'failed',
    error: { code: 'memory_maintenance_unavailable' },
  });
  const turn = turns()[0]!;
  expect(store.getThread(turn.workspaceId, turn.threadId)).toMatchObject({
    entryPath: 'knowledge-manager',
    visibility: 'private',
    privateOwnerUserId: userId,
  });
  expect(
    turn.items.some(
      (item) => item.type === 'status' && item.summary.includes('Current User authority')
    )
  ).toBe(true);
  scan('2026-10-18T23:59:59.000Z');
  expect(turns()).toHaveLength(1);
});

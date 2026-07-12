import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openCoreDb, openUserDb, openWorkspaceDb } from './db.js';
import { createStorageLayoutReport } from './layout-report.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';

/**
 * Creates a temporary NanoCore data root for storage report tests.
 *
 * @returns Temporary data root path.
 */
function createDataRoot(): string {
  return mkdtempSync(join(tmpdir(), 'openkit-storage-report-'));
}

describe('storage layout report', () => {
  it('reports target database ledgers', () => {
    const dataRoot = createDataRoot();
    const coreDb = openCoreDb(dataRoot);
    const userDb = openUserDb(dataRoot, 'user_1');
    const workspaceDb = openWorkspaceDb(dataRoot, 'user_1', 'ws_1');

    try {
      applyMigrations(coreDb);
      applyScopedMigrations(userDb);
      applyScopedMigrations(workspaceDb);

      const report = createStorageLayoutReport(dataRoot);

      expect(report.serverDb.exists).toBe(true);
      expect(report.serverDb.appliedMigrations).toEqual(['core_0000_baseline']);
      expect(report.users).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            userId: 'user_1',
            userDb: expect.objectContaining({
              exists: true,
              appliedMigrations: ['user_0000_baseline'],
            }),
            workspaces: [
              expect.objectContaining({
                workspaceId: 'ws_1',
                workspaceDb: expect.objectContaining({
                  exists: true,
                  appliedMigrations: [
                    'workspace_0000_baseline',
                    'workspace_0001_goal_review_resolution_snapshot',
                  ],
                }),
                indexesDir: expect.objectContaining({ exists: true, entryCount: 0 }),
              }),
            ],
          }),
        ])
      );
    } finally {
      workspaceDb.sqlite.close();
      userDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('reports quarantined storage files for operator inspection', () => {
    const dataRoot = createDataRoot();
    mkdirSync(join(dataRoot, 'server', 'quarantine'), { recursive: true });
    mkdirSync(join(dataRoot, 'users', 'user_1', 'quarantine'), { recursive: true });
    mkdirSync(join(dataRoot, 'users', 'user_1', 'workspaces', 'ws_1', 'quarantine'), {
      recursive: true,
    });
    writeFileSync(join(dataRoot, 'server', 'quarantine', '1-core.sqlite'), 'server');
    writeFileSync(join(dataRoot, 'users', 'user_1', 'quarantine', '2-user.sqlite'), 'user');
    writeFileSync(
      join(dataRoot, 'users', 'user_1', 'workspaces', 'ws_1', 'quarantine', '3-workspace.sqlite'),
      'workspace'
    );

    const report = createStorageLayoutReport(dataRoot);

    expect(report.quarantineEntries).toEqual([
      {
        bytes: 6,
        path: 'server/quarantine/1-core.sqlite',
        scope: 'server',
      },
      {
        bytes: 4,
        path: 'users/user_1/quarantine/2-user.sqlite',
        scope: 'user',
        userId: 'user_1',
      },
      {
        bytes: 9,
        path: 'users/user_1/workspaces/ws_1/quarantine/3-workspace.sqlite',
        scope: 'workspace',
        userId: 'user_1',
        workspaceId: 'ws_1',
      },
    ]);
  });
});

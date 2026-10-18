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
    const userDb = openUserDb(dataRoot, 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b');
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-73c3-900f-8d310e4ba201');

    try {
      applyMigrations(coreDb);
      applyScopedMigrations(userDb);
      applyScopedMigrations(workspaceDb);

      const report = createStorageLayoutReport(dataRoot);

      expect(report.serverDb.exists).toBe(true);
      expect(report.serverDb.appliedMigrations).toEqual([
        'core_0000_setup',
        'core_0001_concurrent_turn_capacity',
        'core_0002_durable_recurring_schedules',
        'core_0003_notebook_admission',
        'core_0004_equal_workspace_members',
        'core_0005_audit_authentication',
      ]);
      expect(report.users).toEqual(
        expect.arrayContaining([
          {
            userId: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b',
            userDb: expect.objectContaining({
              exists: true,
              appliedMigrations: [
                'user_0000_setup',
                'user_0001_thread_read_receipts',
                'user_0002_notebook_admission',
                'user_0003_audit_authentication',
              ],
            }),
          },
        ])
      );
      expect(report.users.every((user) => !Object.hasOwn(user, 'workspaces'))).toBe(true);
      expect(report.workspaces).toEqual([
        {
          workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
          workspaceDb: expect.objectContaining({
            exists: true,
            appliedMigrations: [
              'workspace_0000_setup',
              'workspace_0001_assistant_handoff',
              'workspace_0002_notebook_admission',
              'workspace_0003_exact_review_feedback',
              'workspace_0004_audit_authentication',
            ],
          }),
          indexesDir: expect.objectContaining({ exists: true, entryCount: 0 }),
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
      userDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('reports quarantined storage files for operator inspection', () => {
    const dataRoot = createDataRoot();
    mkdirSync(join(dataRoot, 'server', 'quarantine'), { recursive: true });
    mkdirSync(join(dataRoot, 'users', 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b', 'quarantine'), {
      recursive: true,
    });
    mkdirSync(
      join(dataRoot, 'workspaces', 'ws_00000000-0000-73c3-900f-8d310e4ba201', 'quarantine'),
      { recursive: true }
    );
    writeFileSync(join(dataRoot, 'server', 'quarantine', '1-core.sqlite'), 'server');
    writeFileSync(
      join(
        dataRoot,
        'users',
        'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b',
        'quarantine',
        '2-user.sqlite'
      ),
      'user'
    );
    writeFileSync(
      join(
        dataRoot,
        'workspaces',
        'ws_00000000-0000-73c3-900f-8d310e4ba201',
        'quarantine',
        '3-workspace.sqlite'
      ),
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
        path: 'users/usr_00000000-0000-7e68-8ab1-8dcac1be1b5b/quarantine/2-user.sqlite',
        scope: 'user',
        userId: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b',
      },
      {
        bytes: 9,
        path: 'workspaces/ws_00000000-0000-73c3-900f-8d310e4ba201/quarantine/3-workspace.sqlite',
        scope: 'workspace',
        workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
      },
    ]);
  });
});

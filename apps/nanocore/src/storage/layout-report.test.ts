import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { openCoreDb, openUserDb, openWorkspaceDb } from './db.js';
import { createStorageLayoutReport } from './layout-report.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';

const dataRoots: string[] = [];

afterEach(() => {
  for (const dataRoot of dataRoots.splice(0)) {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

/**
 * Creates a temporary NanoCore data root for storage report tests.
 *
 * @returns Temporary data root path.
 */
function createDataRoot(): string {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-storage-report-'));
  dataRoots.push(dataRoot);
  return dataRoot;
}

describe('storage layout report', () => {
  it('T1 reports each current baseline only for its native owner without changing bytes', async () => {
    const root = createDataRoot();
    const core = openCoreDb(root);
    const workspaceId = 'ws_00000000-0000-73c3-900f-8d310e4ba201';
    const workspace = openWorkspaceDb(root, workspaceId);
    try {
      applyMigrations(core);
      applyScopedMigrations(workspace);
      const tables = workspace.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('control_executions', 'control_execution_steps') ORDER BY name"
        )
        .all();
      expect(tables).toEqual([{ name: 'control_execution_steps' }, { name: 'control_executions' }]);
      const before = workspace.sqlite.serialize();
      const report = await createStorageLayoutReport(root);
      expect(report.workspaces).toHaveLength(1);
      expect(report.workspaces[0]?.workspaceId).toBe(workspaceId);
      expect(report.workspaces[0]?.workspaceDb.appliedMigrations).toEqual([
        'workspace_0000_baseline',
      ]);
      expect(report.serverDb.appliedMigrations).toEqual(['core_0000_baseline']);
      expect(report.serverDb.appliedMigrations).not.toContain('workspace_0000_baseline');
      expect(workspace.sqlite.serialize().equals(before)).toBe(true);
    } finally {
      workspace.sqlite.close();
      core.sqlite.close();
    }
  });

  it('reports target database ledgers', async () => {
    const dataRoot = createDataRoot();
    const coreDb = openCoreDb(dataRoot);
    const userDb = openUserDb(dataRoot, 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b');
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-73c3-900f-8d310e4ba201');

    try {
      applyMigrations(coreDb);
      applyScopedMigrations(userDb);
      applyScopedMigrations(workspaceDb);

      const report = await createStorageLayoutReport(dataRoot);

      expect(report.serverDb.exists).toBe(true);
      expect(report.serverDb.appliedMigrations).toEqual(['core_0000_baseline']);
      expect(report.users).toEqual(
        expect.arrayContaining([
          {
            userId: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b',
            userDb: expect.objectContaining({
              exists: true,
              appliedMigrations: ['user_0000_baseline'],
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
            appliedMigrations: ['workspace_0000_baseline'],
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

  it('reports quarantined storage files for operator inspection', async () => {
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

    const report = await createStorageLayoutReport(dataRoot);

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

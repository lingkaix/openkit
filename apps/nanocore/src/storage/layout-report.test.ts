import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  it('T1 reports Workspace0012 only for its native owner and leaves Core0014 intact', ({
    skip,
  }) => {
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
      if (
        tables.length === 0 &&
        !existsSync(new URL('../../drizzle/workspace/0012_execution_journal.sql', import.meta.url))
      )
        skip('schema-pending: Workspace0012 execution journal');
      expect(tables).toEqual([{ name: 'control_execution_steps' }, { name: 'control_executions' }]);
      const before = workspace.sqlite.serialize();
      const report = createStorageLayoutReport(root);
      expect(report.workspaces).toHaveLength(1);
      expect(report.workspaces[0]?.workspaceId).toBe(workspaceId);
      expect(report.workspaces[0]?.workspaceDb.appliedMigrations.slice(-3)).toEqual([
        'workspace_0011_workspace_capture_protection',
        'workspace_0012_execution_journal',
        'workspace_0013_work_observations',
      ]);
      expect(report.serverDb.appliedMigrations.slice(-2)).toEqual([
        'core_0014_execution_journal',
        'core_0015_work_observations',
      ]);
      expect(report.serverDb.appliedMigrations).not.toContain('workspace_0012_execution_journal');
      expect(workspace.sqlite.serialize().equals(before)).toBe(true);
    } finally {
      workspace.sqlite.close();
      core.sqlite.close();
    }
  });

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

        'core_0005_channel_notifications',
        'core_0006_external_trigger_admissions',
        'core_0007_discord_capture_origin',
        'core_0008_server_capability_usage',
        'core_0009_policy_audit_v1',
        'core_0010_retained_record_formats',
        'core_0011_audit_authentication',
        'core_0012_quarantined_workspace_retirement',
        'core_0013_control_store',
        'core_0014_execution_journal',
        'core_0015_work_observations',
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
                'user_0003_policy_audit_v1',
                'user_0004_retained_record_formats',
                'user_0005_audit_authentication',
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
              'workspace_0004_policy_audit_v1',
              'workspace_0005_retained_record_formats',
              'workspace_0006_audit_authentication',
              'workspace_0007_evaluation_candidates',
              'workspace_0008_evaluation_judgements',
              'workspace_0009_review_selection_judgements',
              'workspace_0010_product_control',
              'workspace_0011_workspace_capture_protection',
              'workspace_0012_execution_journal',
              'workspace_0013_work_observations',
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

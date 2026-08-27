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
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_1');

    try {
      applyMigrations(coreDb);
      applyScopedMigrations(userDb);
      applyScopedMigrations(workspaceDb);

      const report = createStorageLayoutReport(dataRoot);

      expect(report.serverDb.exists).toBe(true);
      expect(report.serverDb.appliedMigrations).toEqual([
        'core_0000_baseline',
        'core_0001_workspace_sharing',
        'core_0002_scheduler_trigger_actor',
        'core_0003_lifecycle_authority',
        'core_0004_nanohost_transport_tokens',
        'core_0005_nanohost_runtime_target',
        'core_0006_nanohost_harness_runtime',
        'core_0007_nanohost_capacity_authority',
        'core_0008_drop_session_snapshots',
        'core_0009_retire_workspace_readwrite',
        'core_0010_nanohost_last_fresh_ready',
      ]);
      expect(report.users).toEqual(
        expect.arrayContaining([
          {
            userId: 'user_1',
            userDb: expect.objectContaining({
              exists: true,
              appliedMigrations: ['user_0000_baseline', 'user_0001_idempotency_requests'],
            }),
          },
        ])
      );
      expect(report.users.every((user) => !Object.hasOwn(user, 'workspaces'))).toBe(true);
      expect(report.workspaces).toEqual([
        {
          workspaceId: 'ws_1',
          workspaceDb: expect.objectContaining({
            exists: true,
            appliedMigrations: [
              'workspace_0000_baseline',
              'workspace_0001_goal_review_resolution_snapshot',
              'workspace_0002_idempotency_requests',
              'workspace_0003_drop_sync_evidence_bundles',
              'workspace_0004_capability_runtime_correlation',
              'workspace_0005_material_authority',
              'workspace_0006_goal_steering_authority',
              'workspace_0007_artifact_review_authority',
              'workspace_0008_shared_attribution',
              'workspace_0009_usage_responsible_user',
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
    mkdirSync(join(dataRoot, 'users', 'user_1', 'quarantine'), { recursive: true });
    mkdirSync(join(dataRoot, 'workspaces', 'ws_1', 'quarantine'), { recursive: true });
    writeFileSync(join(dataRoot, 'server', 'quarantine', '1-core.sqlite'), 'server');
    writeFileSync(join(dataRoot, 'users', 'user_1', 'quarantine', '2-user.sqlite'), 'user');
    writeFileSync(
      join(dataRoot, 'workspaces', 'ws_1', 'quarantine', '3-workspace.sqlite'),
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
        path: 'workspaces/ws_1/quarantine/3-workspace.sqlite',
        scope: 'workspace',
        workspaceId: 'ws_1',
      },
    ]);
  });
});

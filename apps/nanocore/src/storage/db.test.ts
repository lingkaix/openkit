import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startCapabilityCall } from '../capability/usage-ledger.js';
import {
  openCoreDbWithIntegrityRecovery,
  openUserDb,
  openWorkspaceDb,
  recoverExistingScopedDatabases,
} from './db.js';
import { coreDbPath, userDbPath, workspaceDbPath } from './fs-layout.js';
import { applyScopedMigrations } from './migrate.js';

/**
 * Creates an isolated data root for scoped database tests.
 *
 * @returns Absolute temporary data-root path.
 */
function createDataRoot(): string {
  return mkdtempSync(join(tmpdir(), 'openkit-scoped-db-'));
}

describe('scoped storage databases', () => {
  it('opens and migrates a user-scoped SQLite database with only scope metadata', () => {
    const dataRoot = createDataRoot();
    const userDb = openUserDb(dataRoot, 'user_1');

    try {
      applyScopedMigrations(userDb);
      applyScopedMigrations(userDb);

      const tables = listTables(userDb.sqlite);

      expect(statSync(userDbPath(dataRoot, 'user_1')).isFile()).toBe(true);
      expect(tables).toEqual(['idempotency_requests', 'schema_migrations']);
      expect(listMigrationIds(userDb.sqlite)).toEqual([
        'user_0000_baseline',
        'user_0001_idempotency_requests',
      ]);
    } finally {
      userDb.sqlite.close();
    }
  });

  it('opens and migrates a workspace-scoped SQLite database', () => {
    const dataRoot = createDataRoot();
    const workspaceDb = openWorkspaceDb(dataRoot, 'user_1', 'ws_1');

    try {
      applyScopedMigrations(workspaceDb);
      applyScopedMigrations(workspaceDb);

      const tables = listTables(workspaceDb.sqlite);

      expect(statSync(workspaceDbPath(dataRoot, 'user_1', 'ws_1')).isFile()).toBe(true);
      expect(tables).toEqual([
        'audit_events',
        'backend_workspace_handles',
        'capability_calls',
        'evidence_bundles',
        'git_push_records',
        'goal_plan_records',
        'goal_records',
        'goal_review_records',
        'goal_tasks',
        'goal_verification_records',
        'idempotency_requests',
        'mcp_tool_schema_snapshots',
        'permission_decisions',
        'resolved_agent_setups',
        'runtime_evidence',
        'schema_migrations',
        'staged_workspace_reviews',
        'usage_records',
        'vault_use_records',
        'worker_output_manifests',
        'worker_turn_checkpoints',
        'workspace_apply_plans',
        'workspace_apply_results',
        'workspace_change_sets',
        'workspace_filesystem_staging_roots',
        'workspace_input_snapshots',
        'workspace_materialization_records',
        'workspace_quarantine_records',
        'workspace_reconciliation_records',
        'workspace_repository_resources',
      ]);
      expect(listMigrationIds(workspaceDb.sqlite)).toEqual([
        'workspace_0000_baseline',
        'workspace_0001_goal_review_resolution_snapshot',
        'workspace_0002_idempotency_requests',
        'workspace_0003_drop_sync_evidence_bundles',
        'workspace_0004_capability_runtime_correlation',
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rejects scoped database path escapes', () => {
    const dataRoot = createDataRoot();

    expect(() => userDbPath(dataRoot, '../user_1')).toThrow(/parent-directory escapes/);
    expect(() => workspaceDbPath(dataRoot, 'user_1', '../ws_1')).toThrow(
      /parent-directory escapes/
    );
  });

  it('quarantines a corrupt server database before reopening it during boot', () => {
    const dataRoot = createDataRoot();
    const dbPath = coreDbPath(dataRoot);
    mkdirSync(join(dataRoot, 'server', 'db'), { recursive: true });
    writeFileSync(dbPath, 'not sqlite');

    const result = openCoreDbWithIntegrityRecovery(dataRoot);

    try {
      expect(result.recoveryEvents).toHaveLength(1);
      expect(result.recoveryEvents[0]).toMatchObject({
        scope: 'server',
        originalPath: dbPath,
        reason: 'database_integrity_check_failed',
      });
      expect(result.recoveryEvents[0].contentDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(existsSync(result.recoveryEvents[0].quarantinePath)).toBe(true);
      expect(readdirSync(join(dataRoot, 'server', 'quarantine'))).toHaveLength(1);
      expect(result.coreDb.sqlite.prepare('PRAGMA quick_check').pluck().get()).toBe('ok');
    } finally {
      result.coreDb.sqlite.close();
    }
  });

  it('quarantines corrupt user and workspace databases during boot scan', () => {
    const dataRoot = createDataRoot();
    const userPath = userDbPath(dataRoot, 'user_1');
    const workspacePath = workspaceDbPath(dataRoot, 'user_1', 'ws_1');
    mkdirSync(join(dataRoot, 'users', 'user_1', 'db'), { recursive: true });
    mkdirSync(join(dataRoot, 'users', 'user_1', 'workspaces', 'ws_1', 'db'), {
      recursive: true,
    });
    writeFileSync(userPath, 'not sqlite');
    writeFileSync(workspacePath, 'not sqlite');

    const events = recoverExistingScopedDatabases(dataRoot);

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.scope).sort()).toEqual(['user', 'workspace']);
    expect(events.every((event) => existsSync(event.quarantinePath))).toBe(true);
    expect(readdirSync(join(dataRoot, 'users', 'user_1', 'quarantine'))).toHaveLength(1);
    expect(
      readdirSync(join(dataRoot, 'users', 'user_1', 'workspaces', 'ws_1', 'quarantine'))
    ).toHaveLength(1);

    const userDb = openUserDb(dataRoot, 'user_1');
    const workspaceDb = openWorkspaceDb(dataRoot, 'user_1', 'ws_1');

    try {
      expect(listMigrationIds(userDb.sqlite)).toEqual([
        'user_0000_baseline',
        'user_0001_idempotency_requests',
      ]);
      expect(listMigrationIds(workspaceDb.sqlite)).toContain('workspace_0000_baseline');
    } finally {
      userDb.sqlite.close();
      workspaceDb.sqlite.close();
    }
  });

  it('migrates healthy existing scoped databases during boot scan', () => {
    const dataRoot = createDataRoot();
    mkdirSync(join(dataRoot, 'users', 'user_1', 'db'), { recursive: true });
    mkdirSync(join(dataRoot, 'users', 'user_1', 'workspaces', 'ws_1', 'db'), {
      recursive: true,
    });

    expect(recoverExistingScopedDatabases(dataRoot)).toEqual([]);

    const userDb = openUserDb(dataRoot, 'user_1');
    const workspaceDb = openWorkspaceDb(dataRoot, 'user_1', 'ws_1');

    try {
      expect(listMigrationIds(userDb.sqlite)).toEqual([
        'user_0000_baseline',
        'user_0001_idempotency_requests',
      ]);
      expect(listMigrationIds(workspaceDb.sqlite)).toContain('workspace_0000_baseline');
    } finally {
      userDb.sqlite.close();
      workspaceDb.sqlite.close();
    }
  });

  it('recovers running capability calls during boot workspace scan', () => {
    const dataRoot = createDataRoot();
    const workspaceDb = openWorkspaceDb(dataRoot, 'user_1', 'ws_1');

    try {
      applyScopedMigrations(workspaceDb);
      startCapabilityCall({
        callId: 'cap_boot_recovery',
        capabilityId: 'llm.responses',
        family: 'llm',
        operation: 'responses.create',
        redactionClass: 'metadata-only',
        requestId: '00000000-0000-4000-8000-000000000005',
        workspaceDb,
        workspaceId: 'ws_1',
      });
    } finally {
      workspaceDb.sqlite.close();
    }

    expect(recoverExistingScopedDatabases(dataRoot)).toEqual([]);

    const restartedDb = openWorkspaceDb(dataRoot, 'user_1', 'ws_1');

    try {
      const row = restartedDb.sqlite
        .prepare('SELECT status, error_code FROM capability_calls WHERE call_id = ?')
        .get('cap_boot_recovery') as Record<string, unknown>;

      expect(row).toEqual({
        error_code: 'capability_call_recovered_after_restart',
        status: 'cancelled',
      });
    } finally {
      restartedDb.sqlite.close();
    }
  });
});

/**
 * Lists SQLite user tables in stable order.
 *
 * @param sqlite Open SQLite database.
 * @returns Table names sorted by SQLite name.
 */
function listTables(sqlite: { prepare: (sql: string) => { all: () => unknown[] } }): string[] {
  const rows = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;

  return rows.map((row) => row.name);
}

/**
 * Lists recorded migration ids in stable order.
 *
 * @param sqlite Open SQLite database.
 * @returns Migration ids sorted by id.
 */
function listMigrationIds(sqlite: {
  prepare: (sql: string) => { all: () => unknown[] };
}): string[] {
  const rows = sqlite.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{
    id: string;
  }>;

  return rows.map((row) => row.id);
}

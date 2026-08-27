import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startCapabilityCall } from '../capability/usage-ledger.js';
import {
  openBootVerifiedWorkspaceDb,
  openCoreDb,
  openCoreDbWithIntegrityCheck,
  openUserDb,
  openWorkspaceDb,
  verifyAndMigrateExistingScopedDatabases,
} from './db.js';
import { coreDbPath, userDbPath, workspaceDbPath } from './fs-layout.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';

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
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_1');
    const expectedPath = join(dataRoot, 'workspaces', 'ws_1', 'db', 'workspace.sqlite');

    try {
      applyScopedMigrations(workspaceDb);
      applyScopedMigrations(workspaceDb);

      const tables = listTables(workspaceDb.sqlite);

      expect(workspaceDbPath(dataRoot, 'ws_1')).toBe(expectedPath);
      expect(statSync(expectedPath).isFile()).toBe(true);
      expect(workspaceDb).not.toHaveProperty('userId');
      expect(
        existsSync(
          join(dataRoot, 'users', 'user_1', 'workspaces', 'ws_1', 'db', 'workspace.sqlite')
        )
      ).toBe(false);
      expect(tables).toEqual([
        'artifact_reviews',
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
        'pending_user_turn_records',
        'permission_decisions',
        'resolved_agent_setups',
        'runtime_evidence',
        'schema_migrations',
        'staged_workspace_reviews',
        'steering_terminal_outcomes',
        'thread_material_bindings',
        'usage_records',
        'vault_use_records',
        'worker_output_manifests',
        'worker_turn_checkpoints',
        'workspace_apply_plans',
        'workspace_apply_results',
        'workspace_change_sets',
        'workspace_filesystem_staging_roots',
        'workspace_input_snapshots',
        'workspace_material_revisions',
        'workspace_materialization_records',
        'workspace_materials',
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
        'workspace_0005_material_authority',
        'workspace_0006_goal_steering_authority',
        'workspace_0007_artifact_review_authority',
        'workspace_0008_shared_attribution',
        'workspace_0009_usage_responsible_user',
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('reopens only an existing boot-verified Workspace database without creating layout', () => {
    const dataRoot = createDataRoot();
    const created = openWorkspaceDb(dataRoot, 'ws_1');
    created.sqlite.close();

    const reopened = openBootVerifiedWorkspaceDb(dataRoot, 'ws_1');
    reopened.sqlite.close();

    expect(() => openBootVerifiedWorkspaceDb(dataRoot, 'ws_missing')).toThrow();
    expect(existsSync(join(dataRoot, 'workspaces', 'ws_missing'))).toBe(false);
  });

  it('stores the three Material authorities with their native graph and binding uniqueness', () => {
    const dataRoot = createDataRoot();
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_1');

    try {
      applyScopedMigrations(workspaceDb);

      expect(
        workspaceDb.sqlite
          .prepare('PRAGMA table_info(workspace_materials)')
          .all()
          .map((column) => (column as { name: string }).name)
      ).toEqual([
        'workspace_id',
        'material_id',
        'title',
        'kind',
        'current_revision_id',
        'sensitivity',
        'last_mutation_request_id',
        'created_at',
        'updated_at',
      ]);
      expect(
        workspaceDb.sqlite
          .prepare('PRAGMA table_info(workspace_material_revisions)')
          .all()
          .map((column) => (column as { name: string }).name)
      ).toEqual([
        'workspace_id',
        'material_id',
        'revision_id',
        'parent_revision_id',
        'media_type',
        'content_digest',
        'content',
        'author_id',
        'created_by_request_id',
        'created_at',
      ]);
      expect(
        workspaceDb.sqlite
          .prepare('PRAGMA table_info(thread_material_bindings)')
          .all()
          .map((column) => (column as { name: string }).name)
      ).toEqual([
        'workspace_id',
        'thread_id',
        'material_id',
        'binding_state',
        'latest_queued_revision_id',
        'inclusion_state',
        'last_mutation_request_id',
        'created_at',
        'updated_at',
      ]);

      const insertMaterial = workspaceDb.sqlite.prepare(
        `INSERT INTO workspace_materials (
           workspace_id, material_id, title, kind, current_revision_id, sensitivity,
           last_mutation_request_id, created_at, updated_at
         ) VALUES (?, ?, ?, 'markdown', NULL, 'internal', ?, ?, ?)`
      );
      const timestamp = '2026-07-18T00:00:00.000Z';
      for (const materialId of ['mat_1', 'mat_2', 'mat_3', 'mat_4']) {
        insertMaterial.run(
          'ws_1',
          materialId,
          materialId,
          `req_${materialId}`,
          timestamp,
          timestamp
        );
      }

      const insertRevision = workspaceDb.sqlite.prepare(
        `INSERT INTO workspace_material_revisions (
           workspace_id, material_id, revision_id, parent_revision_id, media_type,
           content_digest, content, author_id, created_by_request_id, created_at
         ) VALUES (?, 'mat_1', ?, ?, 'text/markdown', ?, ?, 'user_1', ?, ?)`
      );
      insertRevision.run(
        'ws_1',
        'rev_root',
        null,
        `sha256:${'a'.repeat(64)}`,
        'root',
        'req_root',
        timestamp
      );
      expect(() =>
        insertRevision.run(
          'ws_1',
          'rev_other_root',
          null,
          `sha256:${'b'.repeat(64)}`,
          'other root',
          'req_other_root',
          timestamp
        )
      ).toThrow(/UNIQUE constraint failed/);
      insertRevision.run(
        'ws_1',
        'rev_child',
        'rev_root',
        `sha256:${'c'.repeat(64)}`,
        'child',
        'req_child',
        timestamp
      );
      expect(() =>
        insertRevision.run(
          'ws_1',
          'rev_other_child',
          'rev_root',
          `sha256:${'d'.repeat(64)}`,
          'other child',
          'req_other_child',
          timestamp
        )
      ).toThrow(/UNIQUE constraint failed/);

      const insertBinding = workspaceDb.sqlite.prepare(
        `INSERT INTO thread_material_bindings (
           workspace_id, thread_id, material_id, binding_state, latest_queued_revision_id,
           inclusion_state, last_mutation_request_id, created_at, updated_at
         ) VALUES ('ws_1', 'th_1', ?, ?, NULL, 'included', ?, ?, ?)`
      );
      insertBinding.run('mat_1', 'unbound', 'req_unbound_1', timestamp, timestamp);
      insertBinding.run('mat_2', 'unbound', 'req_unbound_2', timestamp, timestamp);
      insertBinding.run('mat_3', 'bound', 'req_bound_1', timestamp, timestamp);
      expect(() =>
        insertBinding.run('mat_4', 'bound', 'req_bound_2', timestamp, timestamp)
      ).toThrow(/UNIQUE constraint failed/);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('stores only the two bounded Goal steering authority families', () => {
    const dataRoot = createDataRoot();
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_1');

    try {
      applyScopedMigrations(workspaceDb);

      expect(tableColumns(workspaceDb.sqlite, 'pending_user_turn_records')).toEqual([
        'workspace_id',
        'thread_id',
        'pending_turn_id',
        'goal_id',
        'active_turn_id',
        'request_id',
        'content_item_id',
        'input_kind',
        'material_id',
        'revision_id',
        'content_digest',
        'queue_mode',
        'received_at',
        'terminal_claim_kind',
        'terminal_claim_id',
        'terminal_claimed_at',
      ]);
      expect(tableColumns(workspaceDb.sqlite, 'steering_terminal_outcomes')).toEqual([
        'workspace_id',
        'thread_id',
        'pending_turn_id',
        'outcome_id',
        'state',
        'send_request_id',
        'terminal_request_id',
        'content_item_id',
        'goal_id',
        'active_turn_id',
        'input_kind',
        'material_id',
        'revision_id',
        'content_digest',
        'follow_up_turn_id',
        'follow_up_item_id',
        'accepted_at',
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rejects scoped database path escapes', () => {
    const dataRoot = createDataRoot();

    expect(() => userDbPath(dataRoot, '../user_1')).toThrow(/parent-directory escapes/);
    expect(() => workspaceDbPath(dataRoot, '../ws_1')).toThrow(/parent-directory escapes/);
  });

  it.each([
    {
      scope: 'Core',
      path: (dataRoot: string) => coreDbPath(dataRoot),
      quarantine: (dataRoot: string) => join(dataRoot, 'server', 'quarantine'),
      verify: (dataRoot: string) => openCoreDbWithIntegrityCheck(dataRoot).sqlite.close(),
    },
    {
      scope: 'User',
      path: (dataRoot: string) => userDbPath(dataRoot, 'user_1'),
      quarantine: (dataRoot: string) => join(dataRoot, 'users', 'user_1', 'quarantine'),
      verify: (dataRoot: string) => verifyAndMigrateExistingScopedDatabases(dataRoot),
    },
    {
      scope: 'Workspace',
      path: (dataRoot: string) => workspaceDbPath(dataRoot, 'ws_1'),
      quarantine: (dataRoot: string) => join(dataRoot, 'workspaces', 'ws_1', 'quarantine'),
      verify: (dataRoot: string) => verifyAndMigrateExistingScopedDatabases(dataRoot),
    },
  ])('fails boot closed when the $scope database is corrupt', ({ path, quarantine, verify }) => {
    const dataRoot = createDataRoot();
    const dbPath = path(dataRoot);
    const originalBytes = Buffer.from(`not sqlite: ${dbPath}`);
    mkdirSync(dirname(dbPath), { recursive: true });
    writeFileSync(dbPath, originalBytes);

    expect(() => verify(dataRoot)).toThrow(/SQLite integrity check failed/);
    expect(readFileSync(dbPath)).toEqual(originalBytes);
    expect(readdirSync(dirname(dbPath))).toEqual([basename(dbPath)]);
    expect(existsSync(quarantine(dataRoot))).toBe(false);
  });

  it('recovers a valid hot rollback journal before checking Core database integrity', () => {
    const dataRoot = createDataRoot();
    const dbPath = coreDbPath(dataRoot);
    const initialized = openCoreDb(dataRoot);
    applyMigrations(initialized);
    const originalAppliedAt = initialized.sqlite
      .prepare('SELECT applied_at FROM schema_migrations WHERE id = ?')
      .pluck()
      .get('core_0000_baseline');
    initialized.sqlite.close();
    const crashed = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import Database from 'better-sqlite3';
const sqlite = new Database(process.argv[1]);
sqlite.exec('BEGIN IMMEDIATE');
sqlite.prepare('UPDATE schema_migrations SET applied_at = ? WHERE id = ?').run(
  'uncommitted-crash-write',
  'core_0000_baseline'
);
process.kill(process.pid, 'SIGKILL');`,
        dbPath,
      ],
      { cwd: process.cwd(), encoding: 'utf8' }
    );

    expect(crashed.signal).toBe('SIGKILL');
    expect(existsSync(`${dbPath}-journal`)).toBe(true);

    const coreDb = openCoreDbWithIntegrityCheck(dataRoot);
    try {
      expect(
        coreDb.sqlite
          .prepare('SELECT applied_at FROM schema_migrations WHERE id = ?')
          .pluck()
          .get('core_0000_baseline')
      ).toBe(originalAppliedAt);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('migrates healthy existing scoped databases during boot scan', () => {
    const dataRoot = createDataRoot();
    mkdirSync(join(dataRoot, 'users', 'user_1', 'db'), { recursive: true });
    mkdirSync(join(dataRoot, 'workspaces', 'ws_1', 'db'), { recursive: true });

    verifyAndMigrateExistingScopedDatabases(dataRoot);

    const userDb = openUserDb(dataRoot, 'user_1');
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_1');

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
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_1');

    try {
      applyScopedMigrations(workspaceDb);
      startCapabilityCall({
        authorityActor: { kind: 'user', id: 'user_1' },
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

    verifyAndMigrateExistingScopedDatabases(dataRoot);

    const restartedDb = openWorkspaceDb(dataRoot, 'ws_1');

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
 * Lists one SQLite table's columns in declaration order.
 *
 * @param sqlite Open SQLite database.
 * @param tableName Exact trusted table name from the test.
 * @returns Column names in declaration order.
 */
function tableColumns(
  sqlite: { prepare: (sql: string) => { all: () => unknown[] } },
  tableName: string
): string[] {
  return sqlite
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .map((column) => (column as { name: string }).name);
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

// openkit-test-platform: posix
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startCapabilityCall } from '../capability/usage-ledger.js';
import {
  listExistingWorkspaceDatabaseScopes,
  openBootVerifiedWorkspaceDb,
  openCoreDb,
  openCoreDbWithIntegrityCheck,
  openUserDb,
  openWorkspaceDb,
  verifyAndMigrateExistingScopedDatabases,
} from './db.js';
import { coreDbPath, ensureLayout, userDbPath, workspaceDbPath } from './fs-layout.js';
import {
  applyMigrations,
  applyScopedMigrations,
  listAppliedNativeMigrationIds,
} from './migrate.js';

/**
 * Creates an isolated data root for scoped database tests.
 *
 * @returns Absolute temporary data-root path.
 */
function createDataRoot(): string {
  return mkdtempSync(join(tmpdir(), 'openkit-scoped-db-'));
}

describe('scoped storage databases', () => {
  it('opens and migrates a user-scoped SQLite database with User command and Audit authority', () => {
    const dataRoot = createDataRoot();
    const userDb = openUserDb(dataRoot, 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b');

    try {
      applyScopedMigrations(userDb);
      applyScopedMigrations(userDb);

      const tables = listTables(userDb.sqlite);

      expect(
        statSync(userDbPath(dataRoot, 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b')).isFile()
      ).toBe(true);
      expect(tables).toEqual([
        '__drizzle_migrations',
        'audit_events',
        'idempotency_requests',
        'thread_read_receipts',
      ]);
      expect(listMigrationIds(userDb.sqlite, 'user')).toEqual([
        'user_0000_setup',
        'user_0001_thread_read_receipts',
        'user_0002_notebook_admission',
      ]);
    } finally {
      userDb.sqlite.close();
    }
  });

  it('opens and migrates a workspace-scoped SQLite database', () => {
    const dataRoot = createDataRoot();
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-73c3-900f-8d310e4ba201');
    const expectedPath = join(
      dataRoot,
      'workspaces',
      'ws_00000000-0000-73c3-900f-8d310e4ba201',
      'db',
      'workspace.sqlite'
    );

    try {
      applyScopedMigrations(workspaceDb);
      applyScopedMigrations(workspaceDb);

      const tables = listTables(workspaceDb.sqlite);

      expect(workspaceDbPath(dataRoot, 'ws_00000000-0000-73c3-900f-8d310e4ba201')).toBe(
        expectedPath
      );
      expect(statSync(expectedPath).isFile()).toBe(true);
      expect(workspaceDb).not.toHaveProperty('userId');
      expect(
        existsSync(
          join(
            dataRoot,
            'users',
            'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b',
            'workspaces',
            'ws_00000000-0000-73c3-900f-8d310e4ba201',
            'db',
            'workspace.sqlite'
          )
        )
      ).toBe(false);
      expect(tables).toEqual([
        '__drizzle_migrations',
        'artifact_reviews',
        'audit_events',
        'backend_workspace_handles',
        'capability_calls',
        'evidence_bundles',
        'generative_presentations',

        'goal_card_tasks',
        'goal_cards',
        'goal_plan_versions',
        'goals',
        'idempotency_requests',
        'mcp_tool_schema_snapshots',
        'pending_requests',
        'permission_decisions',
        'resolved_agent_setups',
        'runtime_evidence',
        'staged_workspace_reviews',
        'task_turn_terminal_facts',
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

        'workspace_snapshot_collections',
        'workspace_snapshot_cursors',
      ]);
      expect(listMigrationIds(workspaceDb.sqlite, 'workspace')).toEqual([
        'workspace_0000_setup',
        'workspace_0001_assistant_handoff',
        'workspace_0002_notebook_admission',
        'workspace_0003_exact_review_feedback',
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it.each([
    'workspaces',
    'workspace-root',
  ] as const)('refuses a linked %s boundary on Workspace open', (boundary) => {
    const dataRoot = createDataRoot();
    const outside = createDataRoot();
    const workspaces = join(dataRoot, 'workspaces');
    if (boundary === 'workspace-root') mkdirSync(workspaces);
    symlinkSync(
      outside,
      boundary === 'workspaces'
        ? workspaces
        : join(workspaces, 'ws_00000000-0000-73c3-900f-8d310e4ba201'),
      'dir'
    );
    expect(() => openWorkspaceDb(dataRoot, 'ws_00000000-0000-73c3-900f-8d310e4ba201')).toThrow(
      /symbolic link/
    );
    expect(readdirSync(outside)).toEqual([]);
  });

  it.each([
    'workspaces',
    'workspace-root',
  ] as const)('refuses a non-directory %s boundary on Workspace open', (boundary) => {
    const dataRoot = createDataRoot();
    const workspaces = join(dataRoot, 'workspaces');
    if (boundary === 'workspace-root') mkdirSync(workspaces);
    writeFileSync(
      boundary === 'workspaces'
        ? workspaces
        : join(workspaces, 'ws_00000000-0000-73c3-900f-8d310e4ba201'),
      'retained bytes'
    );
    expect(() => openWorkspaceDb(dataRoot, 'ws_00000000-0000-73c3-900f-8d310e4ba201')).toThrow(
      /must be a directory/
    );
  });

  it('opens a Workspace without repeating boot verification of unrelated records', () => {
    const dataRoot = createDataRoot();
    ensureLayout(dataRoot);
    const violation = join(
      dataRoot,
      'users',
      'usr_00000000-0000-700b-b58e-9990ce93a2d2',
      'workspaces'
    );
    mkdirSync(violation, { recursive: true });
    expect(() => ensureLayout(dataRoot)).toThrow(/Unsupported owner-nested Workspace tree/);
    const db = openWorkspaceDb(dataRoot, 'ws_00000000-0000-73c3-900f-8d310e4ba201');
    try {
      expect(db.sqlite.prepare('SELECT 1 AS ready').get()).toEqual({ ready: 1 });
    } finally {
      db.sqlite.close();
    }
    expect(() => ensureLayout(dataRoot)).toThrow(/Unsupported owner-nested Workspace tree/);
  });

  it('reopens only an existing boot-verified Workspace database without creating layout', () => {
    const dataRoot = createDataRoot();
    const created = openWorkspaceDb(dataRoot, 'ws_00000000-0000-73c3-900f-8d310e4ba201');
    created.sqlite.close();

    const reopened = openBootVerifiedWorkspaceDb(
      dataRoot,
      'ws_00000000-0000-73c3-900f-8d310e4ba201'
    );
    reopened.sqlite.close();

    expect(() =>
      openBootVerifiedWorkspaceDb(dataRoot, 'ws_00000000-0000-7490-845b-dcfa3ee49925')
    ).toThrow();
    expect(
      existsSync(join(dataRoot, 'workspaces', 'ws_00000000-0000-7490-845b-dcfa3ee49925'))
    ).toBe(false);
  });

  it('discovers only published Workspace scopes and preserves staging bytes', () => {
    const dataRoot = createDataRoot();
    const created = openWorkspaceDb(dataRoot, 'ws_00000000-0000-73c3-900f-8d310e4ba201');
    created.sqlite.close();
    const stagingRoot = join(dataRoot, 'workspaces', '.staging');
    const stagedChild = join(stagingRoot, 'ws_00000000-0000-7a13-853c-5d52c0c5884f');
    const sentinel = Buffer.from([0, 1, 127, 255]);
    mkdirSync(stagedChild, { recursive: true });
    writeFileSync(join(stagedChild, 'sentinel'), sentinel);

    const scopes = listExistingWorkspaceDatabaseScopes(dataRoot);
    expect(scopes).toEqual([{ workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201' }]);
    for (const { workspaceId } of scopes) {
      const reopened = openBootVerifiedWorkspaceDb(dataRoot, workspaceId);
      reopened.sqlite.close();
    }

    expect(readdirSync(stagingRoot)).toEqual(['ws_00000000-0000-7a13-853c-5d52c0c5884f']);
    expect(readdirSync(stagedChild)).toEqual(['sentinel']);
    expect(readFileSync(join(stagedChild, 'sentinel'))).toEqual(sentinel);
    expect(existsSync(join(stagingRoot, 'db'))).toBe(false);
  });

  it('keeps a real Workspace with a missing database discoverable and refuses its open', () => {
    const dataRoot = createDataRoot();
    const workspaceRoot = join(dataRoot, 'workspaces', 'ws_00000000-0000-7490-845b-dcfa3ee49925');
    mkdirSync(workspaceRoot, { recursive: true });

    expect(listExistingWorkspaceDatabaseScopes(dataRoot)).toEqual([
      { workspaceId: 'ws_00000000-0000-7490-845b-dcfa3ee49925' },
    ]);
    expect(() =>
      openBootVerifiedWorkspaceDb(dataRoot, 'ws_00000000-0000-7490-845b-dcfa3ee49925')
    ).toThrow();
    expect(readdirSync(workspaceRoot)).toEqual([]);
  });

  it('migrates real scoped databases without treating Workspace staging as a scope', () => {
    const dataRoot = createDataRoot();
    const created = openWorkspaceDb(dataRoot, 'ws_00000000-0000-73c3-900f-8d310e4ba201');
    created.sqlite.close();
    const stagingRoot = join(dataRoot, 'workspaces', '.staging');
    const stagedChild = join(stagingRoot, 'ws_00000000-0000-7a13-853c-5d52c0c5884f');
    const sentinel = Buffer.from([0, 1, 127, 255]);
    mkdirSync(stagedChild, { recursive: true });
    writeFileSync(join(stagedChild, 'sentinel'), sentinel);
    // The reserved container name applies only to Workspace discovery.
    const userDb = openUserDb(dataRoot, '.staging');
    userDb.sqlite.close();

    verifyAndMigrateExistingScopedDatabases(dataRoot);

    expect(readdirSync(stagingRoot)).toEqual(['ws_00000000-0000-7a13-853c-5d52c0c5884f']);
    expect(readdirSync(stagedChild)).toEqual(['sentinel']);
    expect(readFileSync(join(stagedChild, 'sentinel'))).toEqual(sentinel);
    expect(existsSync(join(stagingRoot, 'db'))).toBe(false);
    const workspaceDb = openBootVerifiedWorkspaceDb(
      dataRoot,
      'ws_00000000-0000-73c3-900f-8d310e4ba201'
    );
    const migratedUserDb = openUserDb(dataRoot, '.staging');
    try {
      expect(listMigrationIds(workspaceDb.sqlite, 'workspace')).toEqual([
        'workspace_0000_setup',
        'workspace_0001_assistant_handoff',
        'workspace_0002_notebook_admission',
        'workspace_0003_exact_review_feedback',
      ]);
      expect(listMigrationIds(migratedUserDb.sqlite, 'user')).toEqual([
        'user_0000_setup',
        'user_0001_thread_read_receipts',
        'user_0002_notebook_admission',
      ]);
    } finally {
      workspaceDb.sqlite.close();
      migratedUserDb.sqlite.close();
    }
  });

  it('stores the three Material authorities with their native graph and binding uniqueness', () => {
    const dataRoot = createDataRoot();
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-73c3-900f-8d310e4ba201');

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
      for (const materialId of [
        'mat_00000000-0000-780b-aa01-5f7fb6dd4093',
        'mat_00000000-0000-7ab0-b20c-4dc5a61a957a',
        'mat_00000000-0000-7f5d-9d10-61611f2ff771',
        'mat_00000000-0000-767f-bbad-a40ec391166e',
      ]) {
        insertMaterial.run(
          'ws_00000000-0000-73c3-900f-8d310e4ba201',
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
         ) VALUES (?, 'mat_00000000-0000-780b-aa01-5f7fb6dd4093', ?, ?, 'text/markdown', ?, ?, 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b', ?, ?)`
      );
      insertRevision.run(
        'ws_00000000-0000-73c3-900f-8d310e4ba201',
        'rev_root',
        null,
        `sha256:${'a'.repeat(64)}`,
        'root',
        'req_root',
        timestamp
      );
      expect(() =>
        insertRevision.run(
          'ws_00000000-0000-73c3-900f-8d310e4ba201',
          'rev_other_root',
          null,
          `sha256:${'b'.repeat(64)}`,
          'other root',
          'req_other_root',
          timestamp
        )
      ).toThrow(/UNIQUE constraint failed/);
      insertRevision.run(
        'ws_00000000-0000-73c3-900f-8d310e4ba201',
        'rev_child',
        'rev_root',
        `sha256:${'c'.repeat(64)}`,
        'child',
        'req_child',
        timestamp
      );
      expect(() =>
        insertRevision.run(
          'ws_00000000-0000-73c3-900f-8d310e4ba201',
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
         ) VALUES ('ws_00000000-0000-73c3-900f-8d310e4ba201', 'th_00000000-0000-7267-800d-a65e1b6a22d7', ?, ?, NULL, 'included', ?, ?, ?)`
      );
      insertBinding.run(
        'mat_00000000-0000-780b-aa01-5f7fb6dd4093',
        'unbound',
        'req_unbound_1',
        timestamp,
        timestamp
      );
      insertBinding.run(
        'mat_00000000-0000-7ab0-b20c-4dc5a61a957a',
        'unbound',
        'req_unbound_2',
        timestamp,
        timestamp
      );
      insertBinding.run(
        'mat_00000000-0000-7f5d-9d10-61611f2ff771',
        'bound',
        'req_bound_1',
        timestamp,
        timestamp
      );
      expect(() =>
        insertBinding.run(
          'mat_00000000-0000-767f-bbad-a40ec391166e',
          'bound',
          'req_bound_2',
          timestamp,
          timestamp
        )
      ).toThrow(/UNIQUE constraint failed/);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('stores current Goal shapes and no retired steering authority', () => {
    const workspaceDb = openWorkspaceDb(
      createDataRoot(),
      'ws_00000000-0000-73c3-900f-8d310e4ba201'
    );
    try {
      applyScopedMigrations(workspaceDb);
      expect(tableColumns(workspaceDb.sqlite, 'pending_user_turn_records')).toEqual([]);
      expect(tableColumns(workspaceDb.sqlite, 'steering_terminal_outcomes')).toEqual([]);
      expect(tableColumns(workspaceDb.sqlite, 'goals')).toEqual([
        'goal_id',
        'thread_id',
        'payload_json',
      ]);
      expect(tableColumns(workspaceDb.sqlite, 'goal_cards')).toEqual([
        'card_id',
        'goal_id',
        'payload_json',
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rejects scoped database path escapes', () => {
    const dataRoot = createDataRoot();

    expect(() => userDbPath(dataRoot, '../usr_00000000-0000-7e68-8ab1-8dcac1be1b5b')).toThrow(
      /parent-directory escapes/
    );
    expect(() => workspaceDbPath(dataRoot, '../ws_00000000-0000-73c3-900f-8d310e4ba201')).toThrow(
      /parent-directory escapes/
    );
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
      path: (dataRoot: string) => userDbPath(dataRoot, 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b'),
      quarantine: (dataRoot: string) =>
        join(dataRoot, 'users', 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b', 'quarantine'),
      verify: (dataRoot: string) => verifyAndMigrateExistingScopedDatabases(dataRoot),
    },
    {
      scope: 'Workspace',
      path: (dataRoot: string) =>
        workspaceDbPath(dataRoot, 'ws_00000000-0000-73c3-900f-8d310e4ba201'),
      quarantine: (dataRoot: string) =>
        join(dataRoot, 'workspaces', 'ws_00000000-0000-73c3-900f-8d310e4ba201', 'quarantine'),
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
    const originalHash = initialized.sqlite
      .prepare('SELECT hash FROM __drizzle_migrations')
      .pluck()
      .get();
    initialized.sqlite.close();
    const crashed = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import Database from 'better-sqlite3';
const sqlite = new Database(process.argv[1]);
sqlite.exec('BEGIN IMMEDIATE');
sqlite.prepare('UPDATE __drizzle_migrations SET hash = ?').run('uncommitted-crash-write');
process.kill(process.pid, 'SIGKILL');`,
        dbPath,
      ],
      { cwd: process.cwd(), encoding: 'utf8' }
    );

    expect(crashed.signal).toBe('SIGKILL');
    expect(existsSync(`${dbPath}-journal`)).toBe(true);

    const coreDb = openCoreDbWithIntegrityCheck(dataRoot);
    try {
      expect(coreDb.sqlite.prepare('SELECT hash FROM __drizzle_migrations').pluck().get()).toBe(
        originalHash
      );
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('migrates healthy existing scoped databases during boot scan', () => {
    const dataRoot = createDataRoot();
    mkdirSync(join(dataRoot, 'users', 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b', 'db'), {
      recursive: true,
    });
    mkdirSync(join(dataRoot, 'workspaces', 'ws_00000000-0000-73c3-900f-8d310e4ba201', 'db'), {
      recursive: true,
    });

    verifyAndMigrateExistingScopedDatabases(dataRoot);

    const userDb = openUserDb(dataRoot, 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b');
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-73c3-900f-8d310e4ba201');

    try {
      expect(listMigrationIds(userDb.sqlite, 'user')).toEqual([
        'user_0000_setup',
        'user_0001_thread_read_receipts',
        'user_0002_notebook_admission',
      ]);
      expect(listMigrationIds(workspaceDb.sqlite, 'workspace')).toEqual([
        'workspace_0000_setup',
        'workspace_0001_assistant_handoff',
        'workspace_0002_notebook_admission',
        'workspace_0003_exact_review_feedback',
      ]);
    } finally {
      userDb.sqlite.close();
      workspaceDb.sqlite.close();
    }
  });

  it('recovers running capability calls during boot workspace scan', () => {
    const dataRoot = createDataRoot();
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-73c3-900f-8d310e4ba201');

    try {
      applyScopedMigrations(workspaceDb);
      startCapabilityCall({
        authorityActor: { kind: 'user', id: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b' },
        callId: 'cap_00000000-0000-7800-b75d-def690d8fb88',
        capabilityId: 'llm.responses',
        family: 'llm',
        operation: 'responses.create',
        redactionClass: 'metadata-only',
        requestId: '00000000-0000-4000-8000-000000000005',
        workspaceDb,
        workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
      });
    } finally {
      workspaceDb.sqlite.close();
    }

    verifyAndMigrateExistingScopedDatabases(dataRoot);

    const restartedDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-73c3-900f-8d310e4ba201');

    try {
      const row = restartedDb.sqlite
        .prepare('SELECT status, error_code FROM capability_calls WHERE call_id = ?')
        .get('cap_00000000-0000-7800-b75d-def690d8fb88') as Record<string, unknown>;

      expect(row).toEqual({
        error_code: 'capability_call_recovered_after_restart',
        status: 'unknown',
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
 * Lists recorded native migration ids in stable order.
 *
 * @param sqlite Open SQLite database.
 * @param scope Journal scope.
 * @returns Migration ids sorted by id.
 */
function listMigrationIds(
  sqlite: import('better-sqlite3').Database,
  scope: 'core' | 'user' | 'workspace'
): string[] {
  return listAppliedNativeMigrationIds(sqlite, scope);
}

import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openCoreDb, openUserDb, openWorkspaceDb } from './db';
import { coreDbPath, workspaceDbPath } from './fs-layout';
import { applyMigrations, applyScopedMigrations } from './migrate';

const CORE_TABLES = [
  'account',
  'audit_events',
  'boot_audit_events',
  'injection_plans',
  'injection_receipts',
  'openkit_access_tokens',
  'permission_decisions',
  'scheduler_admission_entries',
  'scheduler_capacity_records',
  'scheduler_orphan_worker_evidence',
  'scheduler_placement_plans',
  'scheduler_session_leases',
  'scheduler_supply_refresh_declarations',
  'scheduler_target_health_records',
  'scheduler_worker_pools',
  'schema_migrations',
  'server_settings',
  'session',
  'session_snapshots',
  'users',
  'vault_admin_audit_events',
  'vault_grants',
  'vault_references',
  'vault_use_records',
  'verification',
  'worker_control_commands',
  'worker_control_records',
  'worker_control_rejected_evidence',
  'worker_control_sequence_fingerprints',
  'workspace_members',
  'workspace_registry',
];

const WORKSPACE_TABLES = [
  'audit_events',
  'backend_workspace_handles',
  'capability_calls',
  'evidence_bundles',
  'git_push_records',
  'goal_records',
  'goal_review_records',
  'goal_tasks',
  'goal_verification_records',
  'idempotency_requests',
  'mcp_tool_schema_snapshots',
  'pending_user_turns',
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
];

/**
 * Creates an isolated data root for storage migration tests.
 *
 * @returns Absolute temporary data-root path.
 */
function createDataRoot(): string {
  return mkdtempSync(join(tmpdir(), 'openkit-migrate-'));
}

/**
 * Recursively lists repository source files under one directory.
 *
 * @param root Root directory to scan.
 * @returns Absolute file paths.
 */
function listSourceFiles(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(root, entry.name);

    if (entry.isDirectory()) {
      files.push(...listSourceFiles(path));
      continue;
    }

    if (entry.isFile() && path.endsWith('.ts')) {
      files.push(path);
    }
  }

  return files;
}

/**
 * Lists non-SQLite-internal table names in stable order.
 *
 * @param db Database wrapper with a raw SQLite connection.
 * @returns Table names.
 */
function listTableNames(db: { sqlite: { prepare: (sql: string) => { all: () => unknown[] } } }) {
  return db.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => (row as { name: string }).name)
    .sort();
}

/**
 * Lists applied migration ids in stable order.
 *
 * @param db Database wrapper with a raw SQLite connection.
 * @returns Applied migration ids.
 */
function listMigrationIds(db: { sqlite: { prepare: (sql: string) => { all: () => unknown[] } } }) {
  return db.sqlite
    .prepare('SELECT id FROM schema_migrations ORDER BY id')
    .all()
    .map((row) => (row as { id: string }).id);
}

/**
 * Lists column names for one table.
 *
 * @param db Database wrapper with a raw SQLite connection.
 * @param tableName Table to inspect.
 * @returns Column names.
 */
function listColumnNames(
  db: { sqlite: { prepare: (sql: string) => { all: () => unknown[] } } },
  tableName: string
) {
  return db.sqlite
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .map((row) => (row as { name: string }).name);
}

describe('storage migrations', () => {
  it('applies the server baseline idempotently', () => {
    const dataRoot = createDataRoot();
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      applyMigrations(coreDb);

      expect(listMigrationIds(coreDb)).toEqual(['core_0000_baseline']);
      expect(listTableNames(coreDb)).toEqual(CORE_TABLES);
      expect(listColumnNames(coreDb, 'users')).toEqual([
        'id',
        'display_name',
        'email',
        'email_verified',
        'image',
        'created_at',
        'updated_at',
        'kind',
        'last_seen_at',
      ]);
      expect(listColumnNames(coreDb, 'openkit_access_tokens')).toEqual([
        'token_id',
        'token_hash',
        'owner_user_id',
        'scope',
        'workspace_ids_json',
        'status',
        'issued_at',
        'expires_at',
        'revoked_at',
        'predecessor_token_id',
        'rotated_grace_expires_at',
        'last_used_at',
        'last_used_channel',
        'last_used_source',
      ]);
      expect(listColumnNames(coreDb, 'session_snapshots')).toEqual([
        'snapshot_id',
        'agent_session_id',
        'workspace_id',
        'thread_id',
        'turn_id',
        'aep_snapshot_id',
        'snapshot_kind',
        'backend_handle_ref',
        'session_compatibility_key',
        'content_digest',
        'created_at',
        'expires_at',
        'status',
      ]);
      expect(listTableNames(coreDb)).not.toContain('workspace_repository_resources');
      expect(coreDbPath(dataRoot)).toMatch(/server\/db\/core\.sqlite$/);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('applies user and workspace baselines idempotently', () => {
    const dataRoot = createDataRoot();
    const userDb = openUserDb(dataRoot, 'user_1');
    const workspaceDb = openWorkspaceDb(dataRoot, 'user_1', 'workspace_1');

    try {
      applyScopedMigrations(userDb);
      applyScopedMigrations(userDb);
      applyScopedMigrations(workspaceDb);
      applyScopedMigrations(workspaceDb);

      expect(listMigrationIds(userDb)).toEqual([
        'user_0000_baseline',
        'user_0001_idempotency_requests',
      ]);
      expect(listTableNames(userDb)).toEqual(['idempotency_requests', 'schema_migrations']);
      expect(listMigrationIds(workspaceDb)).toEqual([
        'workspace_0000_baseline',
        'workspace_0001_goal_review_resolution_snapshot',
        'workspace_0002_idempotency_requests',
        'workspace_0003_drop_sync_evidence_bundles',
        'workspace_0004_capability_runtime_correlation',
      ]);
      expect(listTableNames(workspaceDb)).toEqual(WORKSPACE_TABLES);
      const idempotencyRequestColumns = [
        'request_key',
        'command_name',
        'request_id',
        'scope_json',
        'input_hash',
        'response_kind',
        'response_id',
        'created_at',
        'expires_at',
      ];
      expect(listColumnNames(userDb, 'idempotency_requests')).toEqual(idempotencyRequestColumns);
      expect(listColumnNames(workspaceDb, 'idempotency_requests')).toEqual(
        idempotencyRequestColumns
      );
      expect(listColumnNames(workspaceDb, 'capability_calls')).toEqual([
        'call_id',
        'workspace_id',
        'thread_id',
        'turn_id',
        'item_id',
        'agent_id',
        'agent_session_id',
        'request_id',
        'source_ids_json',
        'capability_id',
        'family',
        'operation',
        'status',
        'summary',
        'provider_ref',
        'service_ref',
        'redaction_class',
        'error_code',
        'started_at',
        'completed_at',
        'package_snapshot_id',
        'runtime_origin_ref',
        'runtime_cache_lineage_ref',
      ]);
      expect(listColumnNames(workspaceDb, 'goal_review_records')).toEqual([
        'review_id',
        'workspace_id',
        'thread_id',
        'goal_id',
        'task_id',
        'turn_id',
        'item_ids_json',
        'artifact_ids_json',
        'verification_evidence_json',
        'verdict',
        'reason',
        'created_at',
        'updated_at',
        'resolved_at',
        'resolution_request_id',
        'resolution_snapshot_json',
      ]);
      expect(listColumnNames(workspaceDb, 'workspace_repository_resources')).toEqual([
        'workspace_id',
        'resource_id',
        'type',
        'display_name',
        'local_path',
        'diagnostics_status',
        'created_at',
        'updated_at',
        'commit_on_apply',
        'git_author_name',
        'git_author_email',
        'staging_strategy',
        'protected_branch_patterns_json',
        'allowed_push_targets_json',
        'require_review_linkage',
        'git_push_vault_grant_ref',
      ]);
      expect(listColumnNames(workspaceDb, 'worker_turn_checkpoints')).toEqual([
        'checkpoint_id',
        'workspace_id',
        'thread_id',
        'turn_id',
        'goal_id',
        'task_id',
        'stage',
        'iteration',
        'worker_session_id',
        'context_digest',
        'stop_reason',
        'diagnostics_summary',
        'replay_instruction',
        'created_at',
        'updated_at',
      ]);
      expect(listTableNames(workspaceDb)).not.toContain('session');
      expect(workspaceDbPath(dataRoot, 'user_1', 'workspace_1')).toMatch(
        /users\/user_1\/workspaces\/workspace_1\/db\/workspace\.sqlite$/
      );
    } finally {
      workspaceDb.sqlite.close();
      userDb.sqlite.close();
    }
  });

  it('links access-token owners to canonical users', () => {
    const dataRoot = createDataRoot();
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);

      const foreignKeys = coreDb.sqlite
        .prepare('PRAGMA foreign_key_list(openkit_access_tokens)')
        .all() as Array<{ from: string; on_delete: string; table: string; to: string }>;

      expect(foreignKeys).toContainEqual(
        expect.objectContaining({
          from: 'owner_user_id',
          on_delete: 'CASCADE',
          table: 'users',
          to: 'id',
        })
      );
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('keeps schema mutation SQL inside committed drizzle migrations', () => {
    const sourceRoot = join(process.cwd(), 'src');
    const schemaMutationPattern = new RegExp(
      `\\b(?:${['CREATE', 'ALTER', 'DROP'].join('|')})\\s+TABLE\\b`,
      'i'
    );
    const offenders = listSourceFiles(sourceRoot)
      .filter((path) => !path.endsWith('migrate.test.ts'))
      .filter((path) => schemaMutationPattern.test(readFileSync(path, 'utf8')))
      .map((path) => relative(process.cwd(), path));

    expect(offenders).toEqual([]);
  });
});

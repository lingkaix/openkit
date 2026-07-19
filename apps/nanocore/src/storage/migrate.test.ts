import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { ActorRefSchema } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';

import { recordWorkspaceOwnerMembership } from '../workspace-membership';
import { openCoreDb, openUserDb, openWorkspaceDb } from './db';
import { coreDbPath, workspaceDbPath } from './fs-layout';
import { applyMigrations, applyScopedMigrations } from './migrate';

const CORE_TABLES = [
  'account',
  'audit_events',
  'boot_audit_events',
  'idempotency_requests',
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
  'worker_backend_sessions',
  'worker_control_commands',
  'worker_control_records',
  'worker_control_rejected_evidence',
  'worker_control_sequence_fingerprints',
  'workspace_invitations',
  'workspace_members',
  'workspace_registry',
];

const WORKSPACE_TABLES = [
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

/**
 * Creates the predecessor scheduler admission table used by focused Core migration fixtures.
 *
 * @param coreDb Open Core database handle.
 */
function createLegacySchedulerAdmissionTable(coreDb: ReturnType<typeof openCoreDb>): void {
  coreDb.sqlite.exec(`
    CREATE TABLE scheduler_admission_entries (
      queue_entry_id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      thread_id text NOT NULL,
      turn_id text NOT NULL,
      turn_input text NOT NULL,
      requested_agent_id text NOT NULL,
      profile_ref text NOT NULL,
      priority_class text NOT NULL,
      enqueued_at text NOT NULL,
      effective_priority_at text NOT NULL,
      first_cap_deferred_at text,
      required_pool_constraints_json text NOT NULL,
      status text NOT NULL,
      denial_reason text,
      user_id text NOT NULL,
      workspace_cwd text,
      workspace_roots_json text NOT NULL,
      request_id text
    );
    CREATE UNIQUE INDEX scheduler_admission_entries_non_terminal_turn_idx
      ON scheduler_admission_entries (turn_id)
      WHERE status IN ('queued', 'admitted');
    CREATE INDEX scheduler_admission_entries_queue_idx
      ON scheduler_admission_entries (
        status, priority_class, effective_priority_at, enqueued_at
      );
    CREATE INDEX scheduler_admission_entries_workspace_idx
      ON scheduler_admission_entries (workspace_id, status, enqueued_at);
  `);
}

describe('storage migrations', () => {
  it('applies the server baseline idempotently', () => {
    const dataRoot = createDataRoot();
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      applyMigrations(coreDb);

      expect(listMigrationIds(coreDb)).toEqual([
        'core_0000_baseline',
        'core_0001_workspace_sharing',
        'core_0002_scheduler_trigger_actor',
        'core_0003_lifecycle_authority',
      ]);
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
        'status',
        'disabled_at',
      ]);
      expect(listColumnNames(coreDb, 'audit_events')).toEqual(
        expect.arrayContaining(['actor_json', 'subject_json', 'resource_revision'])
      );
      expect(listColumnNames(coreDb, 'idempotency_requests')).toEqual([
        'request_key',
        'command_name',
        'request_id',
        'scope_json',
        'input_hash',
        'response_kind',
        'response_id',
        'response_json',
        'created_at',
        'expires_at',
      ]);
      expect(listColumnNames(coreDb, 'workspace_registry')).toEqual([
        'workspace_id',
        'owner_user_id',
        'status',
        'revision',
        'created_at',
        'updated_at',
      ]);
      expect(listColumnNames(coreDb, 'workspace_members')).toEqual([
        'workspace_id',
        'user_id',
        'status',
        'access_level',
        'invitation_id',
        'joined_at',
        'removed_at',
        'revision',
        'created_at',
        'updated_at',
      ]);
      expect(listColumnNames(coreDb, 'workspace_invitations')).toEqual([
        'invitation_id',
        'workspace_id',
        'invitee_user_id',
        'proposed_access_level',
        'inviter_user_id',
        'status',
        'expires_at',
        'accepted_at',
        'declined_at',
        'revoked_at',
        'revision',
        'created_at',
        'updated_at',
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
      expect(listColumnNames(coreDb, 'scheduler_admission_entries')).toEqual([
        'queue_entry_id',
        'request_id',
        'trigger_actor_json',
        'workspace_cwd',
        'workspace_roots_json',
        'workspace_id',
        'thread_id',
        'turn_id',
        'turn_input',
        'requested_agent_id',
        'profile_ref',
        'priority_class',
        'enqueued_at',
        'effective_priority_at',
        'first_cap_deferred_at',
        'required_pool_constraints_json',
        'status',
        'denial_reason',
      ]);
      expect(listColumnNames(coreDb, 'worker_backend_sessions')).toEqual([
        'lease_id',
        'workspace_id',
        'thread_id',
        'turn_id',
        'agent_session_id',
        'package_snapshot_id',
        'backend_kind',
        'deployment_id',
        'backend_version',
        'worker_image',
        'cell_target_id',
        'placement',
        'gateway_name',
        'gateway_endpoint',
        'backend_session_id',
        'staging_directory_ref',
        'transient_provider_instance_id',
        'workspace_handoff_state',
        'state',
        'physical_cleaned_at',
        'created_at',
        'updated_at',
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
    const workspaceDb = openWorkspaceDb(dataRoot, 'workspace_1');

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
        'workspace_0005_material_authority',
        'workspace_0006_goal_steering_authority',
        'workspace_0007_artifact_review_authority',
        'workspace_0008_shared_attribution',
        'workspace_0009_usage_responsible_user',
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
        'response_json',
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
      expect(listColumnNames(workspaceDb, 'usage_records')).toEqual([
        'usage_id',
        'workspace_id',
        'thread_id',
        'turn_id',
        'item_id',
        'capability_call_id',
        'request_id',
        'agent_id',
        'agent_session_id',
        'source_ids_json',
        'category',
        'unit',
        'quantity',
        'model_id',
        'provider_ref',
        'source',
        'recorded_at',
        'responsible_user_id',
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
        'prompt',
        'created_by_request_id',
        'verdict',
        'reason',
        'revision_instruction',
        'created_at',
        'updated_at',
        'resolved_at',
        'resolution_request_id',
        'resolved_by_actor_id',
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
        'request_id',
        'request_input_hash',
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
      expect(workspaceDbPath(dataRoot, 'workspace_1')).toMatch(
        /workspaces\/workspace_1\/db\/workspace\.sqlite$/
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

  it.each([
    ['workspace_registry', 'owner_user_id'],
    ['workspace_members', 'user_id'],
  ] as const)('restricts user deletion through %s.%s', (tableName, columnName) => {
    const dataRoot = createDataRoot();
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);

      const foreignKeys = coreDb.sqlite
        .prepare(`PRAGMA foreign_key_list(${tableName})`)
        .all() as Array<{
        from: string;
        on_delete: string;
        table: string;
        to: string;
      }>;

      expect(foreignKeys).toContainEqual(
        expect.objectContaining({
          from: columnName,
          on_delete: 'RESTRICT',
          table: 'users',
          to: 'id',
        })
      );
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('enforces invitation lifecycle, invitee retention, and lookup indexes', () => {
    const dataRoot = createDataRoot();
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      const now = Date.now();
      const createdAt = '2026-07-19T00:00:00.000Z';
      coreDb.sqlite
        .prepare(
          `INSERT INTO users (
            id, display_name, email, email_verified, created_at, updated_at, kind
          ) VALUES
            ('user_owner', 'Owner', 'owner@example.com', false, ?, ?, 'human'),
            ('user_invitee', 'Invitee', 'invitee@example.com', false, ?, ?, 'human')`
        )
        .run(now, now, now, now);
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'user_owner',
        workspaceId: 'ws_invitation_constraints',
      });
      const insertInvitation = coreDb.sqlite.prepare(
        `INSERT INTO workspace_invitations (
          invitation_id, workspace_id, invitee_user_id, proposed_access_level,
          inviter_user_id, status, expires_at, accepted_at, declined_at, revoked_at,
          revision, created_at, updated_at
        ) VALUES (
          ?, 'ws_invitation_constraints', 'user_invitee', 'editor', 'user_owner', ?,
          '2026-07-26T00:00:00.000Z', ?, NULL, NULL, 1, ?, ?
        )`
      );

      expect(() =>
        insertInvitation.run('inv_invalid', 'accepted', null, createdAt, createdAt)
      ).toThrow();

      insertInvitation.run('inv_pending', 'pending', null, createdAt, createdAt);

      expect(() =>
        insertInvitation.run('inv_duplicate', 'pending', null, createdAt, createdAt)
      ).toThrow();
      expect(() =>
        coreDb.sqlite.prepare('DELETE FROM users WHERE id = ?').run('user_invitee')
      ).toThrow();
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT name
             FROM sqlite_master
             WHERE type = 'index'
               AND tbl_name = 'workspace_invitations'
               AND sql IS NOT NULL
             ORDER BY name`
          )
          .all()
          .map((row) => (row as { name: string }).name)
      ).toEqual([
        'workspace_invitations_invitee_idx',
        'workspace_invitations_pending_idx',
        'workspace_invitations_workspace_idx',
      ]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('upgrades existing owner and membership rows without changing their authority', () => {
    const dataRoot = createDataRoot();
    const coreDb = openCoreDb(dataRoot);

    try {
      coreDb.sqlite.exec(`
        CREATE TABLE schema_migrations (id text PRIMARY KEY NOT NULL, applied_at text NOT NULL);
        CREATE TABLE users (id text PRIMARY KEY NOT NULL);
        CREATE TABLE audit_events (audit_event_id text PRIMARY KEY NOT NULL);
        CREATE TABLE workspace_registry (
          workspace_id text PRIMARY KEY NOT NULL,
          owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          status text NOT NULL,
          created_at text NOT NULL,
          updated_at text NOT NULL
        );
        CREATE TABLE workspace_members (
          workspace_id text NOT NULL REFERENCES workspace_registry(workspace_id) ON DELETE CASCADE,
          user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          status text NOT NULL,
          created_at text NOT NULL,
          updated_at text NOT NULL,
          PRIMARY KEY (workspace_id, user_id)
        );
      `);
      createLegacySchedulerAdmissionTable(coreDb);
      coreDb.sqlite
        .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run('core_0000_baseline', '2026-07-18T00:00:00.000Z');
      coreDb.sqlite
        .prepare('INSERT INTO users (id) VALUES (?), (?)')
        .run('user_owner', 'user_removed');
      coreDb.sqlite
        .prepare(
          `INSERT INTO workspace_registry
            (workspace_id, owner_user_id, status, created_at, updated_at)
           VALUES (?, ?, 'active', ?, ?)`
        )
        .run('ws_existing', 'user_owner', '2026-07-18T00:00:00.000Z', '2026-07-18T01:00:00.000Z');
      coreDb.sqlite
        .prepare(
          `INSERT INTO workspace_members
            (workspace_id, user_id, status, created_at, updated_at)
           VALUES
            (?, ?, 'active', ?, ?),
            (?, ?, 'removed', ?, ?)`
        )
        .run(
          'ws_existing',
          'user_owner',
          '2026-07-18T00:00:00.000Z',
          '2026-07-18T01:00:00.000Z',
          'ws_existing',
          'user_removed',
          '2026-07-18T00:30:00.000Z',
          '2026-07-18T02:00:00.000Z'
        );

      applyMigrations(coreDb);

      expect(
        coreDb.sqlite
          .prepare(
            `SELECT workspace_id, owner_user_id, status, revision, created_at, updated_at
             FROM workspace_registry`
          )
          .get()
      ).toEqual({
        workspace_id: 'ws_existing',
        owner_user_id: 'user_owner',
        status: 'active',
        revision: 1,
        created_at: '2026-07-18T00:00:00.000Z',
        updated_at: '2026-07-18T01:00:00.000Z',
      });
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT user_id, status, access_level, invitation_id, joined_at, removed_at, revision
             FROM workspace_members
             ORDER BY user_id`
          )
          .all()
      ).toEqual([
        {
          user_id: 'user_owner',
          status: 'active',
          access_level: 'editor',
          invitation_id: null,
          joined_at: '2026-07-18T00:00:00.000Z',
          removed_at: null,
          revision: 1,
        },
        {
          user_id: 'user_removed',
          status: 'removed',
          access_level: 'editor',
          invitation_id: null,
          joined_at: '2026-07-18T00:30:00.000Z',
          removed_at: '2026-07-18T02:00:00.000Z',
          revision: 1,
        },
      ]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('replaces the scheduler storage owner with an exact trigger actor', () => {
    const dataRoot = createDataRoot();
    const coreDb = openCoreDb(dataRoot);

    try {
      coreDb.sqlite.exec(`
        CREATE TABLE schema_migrations (id text PRIMARY KEY NOT NULL, applied_at text NOT NULL);
        CREATE TABLE users (id text PRIMARY KEY NOT NULL);
        CREATE TABLE audit_events (audit_event_id text PRIMARY KEY NOT NULL);
        INSERT INTO schema_migrations (id, applied_at) VALUES
          ('core_0000_baseline', '2026-07-19T00:00:00.000Z'),
          ('core_0001_workspace_sharing', '2026-07-19T00:00:01.000Z');
      `);
      createLegacySchedulerAdmissionTable(coreDb);
      coreDb.sqlite
        .prepare(
          `INSERT INTO scheduler_admission_entries (
            queue_entry_id, workspace_id, thread_id, turn_id, turn_input,
            requested_agent_id, profile_ref, priority_class, enqueued_at,
            effective_priority_at, first_cap_deferred_at,
            required_pool_constraints_json, status, denial_reason, user_id,
            workspace_cwd, workspace_roots_json, request_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'queue_legacy',
          'ws_legacy',
          'thread_legacy',
          'turn_legacy',
          'Continue legacy work',
          'agent_legacy',
          'profile_legacy',
          'interactive',
          '2026-07-19T00:00:00.000Z',
          '2026-07-19T00:00:00.000Z',
          null,
          '[]',
          'queued',
          null,
          'user_"quoted"',
          null,
          '[]',
          'request_legacy'
        );

      applyMigrations(coreDb);

      const row = coreDb.sqlite
        .prepare(
          `SELECT trigger_actor_json AS triggerActorJson
           FROM scheduler_admission_entries
           WHERE queue_entry_id = ?`
        )
        .get('queue_legacy') as { triggerActorJson: string };
      expect(ActorRefSchema.parse(JSON.parse(row.triggerActorJson))).toEqual({
        kind: 'user',
        id: 'user_"quoted"',
      });
      expect(listColumnNames(coreDb, 'scheduler_admission_entries')).not.toContain('user_id');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rolls back schema changes when migration-ledger publication fails', () => {
    const dataRoot = createDataRoot();
    const coreDb = openCoreDb(dataRoot);

    try {
      coreDb.sqlite.exec(
        readFileSync(join(process.cwd(), 'drizzle', '0000_core_baseline.sql'), 'utf8')
      );
      coreDb.sqlite
        .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run('core_0000_baseline', '2026-07-18T00:00:00.000Z');
      coreDb.sqlite.exec(`
        CREATE TRIGGER reject_workspace_sharing_migration_ledger
        BEFORE INSERT ON schema_migrations
        WHEN NEW.id = 'core_0001_workspace_sharing'
        BEGIN
          SELECT RAISE(ABORT, 'injected_ledger_failure');
        END;
      `);

      expect(() => applyMigrations(coreDb)).toThrow('injected_ledger_failure');
      expect(listMigrationIds(coreDb)).toEqual(['core_0000_baseline']);
      expect(listColumnNames(coreDb, 'workspace_registry')).toEqual([
        'workspace_id',
        'owner_user_id',
        'status',
        'created_at',
        'updated_at',
      ]);
      expect(listTableNames(coreDb)).not.toContain('workspace_invitations');
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

import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import { recordWorkspaceOwnerMembership } from '../workspace-membership';
import { openCoreDb, openUserDb, openWorkspaceDb } from './db';
import { coreDbPath, workspaceDbPath } from './fs-layout';
import { applyMigrations, applyScopedMigrations } from './migrate';

const CORE_TABLES = [
  'account',
  'agent_session_runtime_bindings',
  'audit_events',
  'boot_audit_events',
  'harness_instance_records',
  'idempotency_requests',
  'nanohost_integration_identities',
  'nanohost_runtime_targets',
  'nanohost_transport_tokens',
  'openkit_access_tokens',
  'permission_decisions',
  'sandbox_runtime_records',
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
  'users',
  'vault_admin_audit_events',
  'vault_grants',
  'vault_injection_plans',
  'vault_injection_receipts',
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
 * Creates an isolated data root for database setup tests.
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
 * Lists applied setup ids in stable order.
 *
 * @param db Database wrapper with a raw SQLite connection.
 * @returns Applied setup ids.
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

describe('database setup', () => {
  it('applies the Core setup idempotently', () => {
    const dataRoot = createDataRoot();
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      applyMigrations(coreDb);

      expect(
        readdirSync(join(process.cwd(), 'drizzle')).filter((name) => name.endsWith('.sql'))
      ).toEqual(['0000_setup.sql']);
      expect(listMigrationIds(coreDb)).toEqual(['core_0000_setup']);
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
      /**
       * S-2b-1 Unit 2: durable NanoHost transport Token metadata projection.
       * Covered by the current Core setup.
       */
      expect(listColumnNames(coreDb, 'nanohost_transport_tokens')).toEqual([
        'token_id',
        'token_hash',
        'owner_nanohost_identity_id',
        'token_type',
        'scope',
        'deployment_id',
        'status',
        'issued_at',
        'expires_at',
        'revoked_at',
        'predecessor_token_id',
        'rotation_overlap_expires_at',
        'responsible_server_admin_actor_id',
        'last_used_at',
        'last_used_channel',
        'last_used_source',
      ]);
      expect(listColumnNames(coreDb, 'nanohost_integration_identities')).toEqual([
        'identity_id',
        'deployment_id',
        'status',
        'created_at',
        'decommissioned_at',
      ]);
      expect(listColumnNames(coreDb, 'nanohost_runtime_targets')).toEqual([
        'target_id',
        'identity_id',
        'deployment_id',
        'connection_generation',
        'predecessor_fenced',
        'ready',
        'fresh_empty',
        'observed_at',
        'slot_count',
        'last_fresh_ready_at',
      ]);
      expect(listColumnNames(coreDb, 'sandbox_runtime_records')).toEqual([
        'sandbox_runtime_id',
        'runtime_target_id',
        'sandbox_binding_ref',
        'sandbox_integration_binding_ref',
        'sandbox_compatibility_key',
        'image_digest',
        'environment_class',
        'max_open_sessions',
        'max_harnesses',
        'max_active_turns',
        'lifecycle_state',
        'health_state',
        'drain_state',
        'cleanup_state',
        'created_at',
        'updated_at',
        'pinned_goal_id',
      ]);
      expect(listColumnNames(coreDb, 'harness_instance_records')).toEqual([
        'harness_instance_id',
        'sandbox_runtime_id',
        'harness_binding_ref',
        'harness_compatibility_key',
        'runtime_family',
        'adapter_id',
        'adapter_version',
        'protocol_version',
        'capabilities_json',
        'max_open_sessions',
        'max_active_turns',
        'open_session_count',
        'active_turn_count',
        'lifecycle_state',
        'drain_state',
        'next_sequence',
        'operation_state',
        'operation_id',
        'operation_sequence',
        'operation',
        'command_body_json',
        'command_fingerprint',
        'result_json',
        'result_fingerprint',
        'created_at',
        'updated_at',
      ]);
      expect(listColumnNames(coreDb, 'agent_session_runtime_bindings')).toEqual([
        'agent_session_runtime_binding_id',
        'harness_instance_id',
        'agent_session_id',
        'workspace_id',
        'thread_id',
        'agent_session_compatibility_key',
        'effective_setup_generation',
        'native_handle_state',
        'native_handle_digest',
        'lifecycle_state',
        'current_turn_id',
        'current_lease_id',
        'next_turn_sequence',
        'cleanup_state',
        'created_at',
        'updated_at',
      ]);
      const leaseTokenColumns = coreDb.sqlite
        .prepare('PRAGMA table_info(scheduler_session_leases)')
        .all()
        .filter(({ name }: { name: string }) => name.includes('token'))
        .map(({ name, notnull }: { name: string; notnull: 0 | 1 }) => ({ name, notnull }));
      expect(leaseTokenColumns).toEqual([
        { name: 'worker_control_token_hash', notnull: 0 },
        { name: 'worker_inference_token_hash', notnull: 0 },
        { name: 'worker_capability_token_hash', notnull: 0 },
      ]);
      expect(listColumnNames(coreDb, 'scheduler_session_leases')).not.toEqual(
        expect.arrayContaining(['worker_control_token', 'worker_inference_token'])
      );
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
        'model_id',
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
        'runtime_target_id',
        'backend_lineage_json',
        'sandbox_binding_ref',
      ]);
      const backendProjectionColumns = coreDb.sqlite
        .prepare('PRAGMA table_info(worker_backend_sessions)')
        .all() as Array<{ name: string; notnull: 0 | 1 }>;
      expect(
        Object.fromEntries(
          backendProjectionColumns
            .filter(({ name }) =>
              [
                'runtime_target_id',
                'backend_lineage_json',
                'sandbox_binding_ref',
                'worker_image',
                'cell_target_id',
                'placement',
                'gateway_name',
                'gateway_endpoint',
              ].includes(name)
            )
            .map(({ name, notnull }) => [name, notnull === 0])
        )
      ).toEqual({
        backend_lineage_json: true,
        cell_target_id: true,
        gateway_endpoint: true,
        gateway_name: true,
        placement: true,
        runtime_target_id: true,
        sandbox_binding_ref: true,
        worker_image: true,
      });
      coreDb.sqlite
        .prepare(
          `INSERT INTO worker_backend_sessions (
             lease_id, workspace_id, thread_id, turn_id, agent_session_id,
             package_snapshot_id, backend_kind, deployment_id, backend_version,
             worker_image, cell_target_id, placement, gateway_name, gateway_endpoint,
             backend_session_id, staging_directory_ref, transient_provider_instance_id,
             workspace_handoff_state, state, created_at, updated_at
           ) VALUES (
             'lease-setup-writer', 'ws-setup-writer', 'thread-setup-writer',
             'turn-setup-writer', 'session-setup-writer', 'aepsnap-setup-writer',
             'openshell', 'deployment-setup-writer', '0.0.80',
             'openkit/worker:test', 'cell-setup-writer', 'local', 'openshell', NULL,
             'sandbox-setup-writer', 'server/runtime/setup-writer', NULL,
             'pending', 'materializing',
             '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'
           )`
        )
        .run();
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT runtime_target_id AS runtimeTargetId,
                    backend_lineage_json AS backendLineageJson,
                    sandbox_binding_ref AS sandboxBindingRef
             FROM worker_backend_sessions
             WHERE lease_id = 'lease-setup-writer'`
          )
          .get()
      ).toEqual({
        backendLineageJson: null,
        runtimeTargetId: null,
        sandboxBindingRef: null,
      });
      expect(listTableNames(coreDb)).not.toContain('workspace_repository_resources');
      expect(coreDbPath(dataRoot)).toMatch(/server\/db\/core\.sqlite$/);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('applies the User and Workspace setup sections idempotently', () => {
    const dataRoot = createDataRoot();
    const userDb = openUserDb(dataRoot, 'user_1');
    const workspaceDb = openWorkspaceDb(dataRoot, 'workspace_1');

    try {
      applyScopedMigrations(userDb);
      applyScopedMigrations(userDb);
      applyScopedMigrations(workspaceDb);
      applyScopedMigrations(workspaceDb);

      expect(listMigrationIds(userDb)).toEqual(['user_0000_setup']);
      expect(listTableNames(userDb)).toEqual(['idempotency_requests', 'schema_migrations']);
      expect(listMigrationIds(workspaceDb)).toEqual(['workspace_0000_setup']);
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
        'schema_snapshot_id',
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

  it('does not upgrade a predecessor migration ledger', () => {
    const dataRoot = createDataRoot();
    const coreDb = openCoreDb(dataRoot);

    try {
      coreDb.sqlite.exec(
        'CREATE TABLE schema_migrations (id text PRIMARY KEY NOT NULL, applied_at text NOT NULL)'
      );
      coreDb.sqlite
        .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run('core_predecessor_setup', '2026-08-29T00:00:00.000Z');

      expect(() => applyMigrations(coreDb)).toThrow(/schema_migrations.*already exists/);
      expect(listTableNames(coreDb)).toEqual(['schema_migrations']);
      expect(listMigrationIds(coreDb)).toEqual(['core_predecessor_setup']);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('keeps schema mutation SQL inside the committed database setup', () => {
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

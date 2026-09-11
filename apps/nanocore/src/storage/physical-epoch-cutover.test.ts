import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { acquireDataRootLock, DataRootLockError } from '../bootstrap/lock.js';
import { verifyDataRootBackupManifest } from './data-root-backup.js';
import {
  migratePhysicalEpochs,
  parsePhysicalEpochMigrationArgs,
  runPhysicalEpochMigrationCli,
} from './physical-epoch-cutover.js';

const timestamp = '2026-09-11T00:00:00.000Z';

interface PhysicalEpochFixture {
  readonly dataRoot: string;
  readonly databasePath: string;
}

function createPhysicalEpochFixture(
  options: {
    readonly sandboxOpenCapacityMinimum?: 1 | 2;
    readonly splitPinnedGoalIdentifier?: boolean;
  } = {}
): PhysicalEpochFixture {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-physical-epoch-cutover-'));
  const databasePath = join(dataRoot, 'server', 'db', 'core.sqlite');

  mkdirSync(join(dataRoot, 'server', 'db'), { recursive: true });
  mkdirSync(join(dataRoot, 'server', 'runtime'), { recursive: true });
  mkdirSync(join(dataRoot, 'server', 'migrations'), { recursive: true });
  writeFileSync(
    join(dataRoot, 'server', 'layout.json'),
    `${JSON.stringify({ schemaVersion: 1, layoutVersion: 2, deploymentId: 'dep_cutover' })}\n`
  );
  writeFileSync(join(dataRoot, 'preserved.txt'), 'preserved predecessor bytes\n');

  const sqlite = new Database(databasePath);
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (
      id text PRIMARY KEY NOT NULL,
      applied_at text NOT NULL
    );
    CREATE TABLE nanohost_runtime_targets (
      target_id text PRIMARY KEY NOT NULL,
      identity_id text NOT NULL,
      deployment_id text NOT NULL,
      connection_generation integer NOT NULL,
      predecessor_fenced integer NOT NULL,
      ready integer NOT NULL,
      fresh_empty integer NOT NULL,
      observed_at text NOT NULL,
      slot_count integer NOT NULL,
      last_fresh_ready_at text
    );
    CREATE TABLE sandbox_runtime_records (
      sandbox_runtime_id text PRIMARY KEY NOT NULL,
      runtime_target_id text NOT NULL REFERENCES nanohost_runtime_targets(target_id) ON DELETE RESTRICT,
      sandbox_binding_ref text NOT NULL,
      sandbox_integration_binding_ref text NOT NULL,
      sandbox_compatibility_key text NOT NULL,
      image_digest text NOT NULL,
      environment_class text NOT NULL,
      max_open_sessions integer NOT NULL,
      max_harnesses integer NOT NULL,
      max_active_turns integer NOT NULL,
      lifecycle_state text NOT NULL,
      health_state text NOT NULL,
      drain_state text NOT NULL,
      cleanup_state text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      ${options.splitPinnedGoalIdentifier ? 'pinned_goal_ id' : 'pinned_goal_id text'},
      CONSTRAINT sandbox_runtime_records_open_capacity_check CHECK (max_open_sessions >= ${options.sandboxOpenCapacityMinimum ?? 2}),
      CONSTRAINT sandbox_runtime_records_harness_capacity_check CHECK (max_harnesses >= 2),
      CONSTRAINT sandbox_runtime_records_turn_capacity_check CHECK (max_active_turns = 1)
    );
    CREATE UNIQUE INDEX sandbox_runtime_records_binding_idx
      ON sandbox_runtime_records (sandbox_binding_ref);
    CREATE UNIQUE INDEX sandbox_runtime_records_integration_binding_idx
      ON sandbox_runtime_records (sandbox_integration_binding_ref);
    CREATE INDEX sandbox_runtime_records_target_idx
      ON sandbox_runtime_records (runtime_target_id, lifecycle_state);
    CREATE TABLE harness_instance_records (
      harness_instance_id text PRIMARY KEY NOT NULL,
      sandbox_runtime_id text NOT NULL REFERENCES sandbox_runtime_records(sandbox_runtime_id) ON DELETE CASCADE,
      lifecycle_state text NOT NULL,
      cleanup_state text NOT NULL
    );
    CREATE TABLE agent_session_runtime_bindings (
      agent_session_runtime_binding_id text PRIMARY KEY NOT NULL,
      harness_instance_id text NOT NULL REFERENCES harness_instance_records(harness_instance_id) ON DELETE CASCADE,
      lifecycle_state text NOT NULL,
      cleanup_state text NOT NULL
    );
    CREATE TABLE worker_backend_sessions (
      lease_id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      thread_id text NOT NULL,
      turn_id text NOT NULL,
      agent_session_id text NOT NULL,
      package_snapshot_id text NOT NULL,
      backend_kind text NOT NULL,
      deployment_id text NOT NULL,
      backend_version text,
      worker_image text,
      cell_target_id text,
      placement text,
      gateway_name text,
      gateway_endpoint text,
      backend_session_id text NOT NULL,
      staging_directory_ref text NOT NULL,
      transient_provider_instance_id text,
      workspace_handoff_state text NOT NULL,
      state text NOT NULL,
      physical_cleaned_at text,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      runtime_target_id text,
      backend_lineage_json text,
      sandbox_binding_ref text
    );
    CREATE INDEX worker_backend_sessions_lineage_idx
      ON worker_backend_sessions (workspace_id, thread_id, turn_id, agent_session_id, package_snapshot_id);
    CREATE INDEX worker_backend_sessions_state_idx
      ON worker_backend_sessions (state, updated_at);
    CREATE UNIQUE INDEX worker_backend_sessions_package_idx
      ON worker_backend_sessions (package_snapshot_id);
    CREATE UNIQUE INDEX worker_backend_sessions_staging_idx
      ON worker_backend_sessions (staging_directory_ref);
    CREATE UNIQUE INDEX worker_backend_sessions_backend_session_idx
      ON worker_backend_sessions (backend_session_id);
    CREATE UNIQUE INDEX worker_backend_sessions_sandbox_binding_idx
      ON worker_backend_sessions (sandbox_binding_ref) WHERE sandbox_binding_ref IS NOT NULL;
    CREATE UNIQUE INDEX worker_backend_sessions_transient_provider_idx
      ON worker_backend_sessions (transient_provider_instance_id)
      WHERE transient_provider_instance_id IS NOT NULL;
    CREATE UNIQUE INDEX worker_backend_sessions_named_target_idx
      ON worker_backend_sessions (backend_kind, gateway_name, backend_session_id)
      WHERE gateway_endpoint IS NULL;
    CREATE UNIQUE INDEX worker_backend_sessions_endpoint_target_idx
      ON worker_backend_sessions (backend_kind, gateway_endpoint, backend_session_id)
      WHERE gateway_endpoint IS NOT NULL;
    CREATE UNIQUE INDEX worker_backend_sessions_named_provider_idx
      ON worker_backend_sessions (backend_kind, gateway_name, transient_provider_instance_id)
      WHERE gateway_endpoint IS NULL AND transient_provider_instance_id IS NOT NULL;
    CREATE UNIQUE INDEX worker_backend_sessions_endpoint_provider_idx
      ON worker_backend_sessions (backend_kind, gateway_endpoint, transient_provider_instance_id)
      WHERE gateway_endpoint IS NOT NULL AND transient_provider_instance_id IS NOT NULL;
    CREATE TABLE preserved_records (
      id text PRIMARY KEY NOT NULL,
      state text NOT NULL,
      payload_json text NOT NULL
    );
    INSERT INTO schema_migrations (id, applied_at)
      VALUES ('core_0000_setup', '2026-09-10T00:00:00.000Z');
    INSERT INTO nanohost_runtime_targets VALUES (
      'target_1', 'identity_1', 'dep_cutover', 7, 1, 1, 1,
      '2026-09-10T01:00:00.000Z', 2, '2026-09-10T01:00:00.000Z'
    );
    INSERT INTO sandbox_runtime_records VALUES (
      'sandbox_1', 'target_1', 'sandbox-binding-1', 'integration-binding-1',
      'compatibility-1', 'sha256:image', 'shared', 2, 2, 1, 'ready', 'healthy',
      'draining', 'cleanup-pending', '2026-09-10T01:00:00.000Z',
      '2026-09-10T02:00:00.000Z', 'goal_1'
    );
    INSERT INTO harness_instance_records VALUES (
      'harness_1', 'sandbox_1', 'ready', 'cleanup-pending'
    );
    INSERT INTO agent_session_runtime_bindings VALUES (
      'binding_1', 'harness_1', 'open', 'cleanup-pending'
    );
    INSERT INTO worker_backend_sessions VALUES (
      'lease_1', 'workspace_1', 'thread_1', 'turn_1', 'session_1', 'snapshot_1',
      'openshell', 'dep_cutover', '1.2.3', 'sha256:image', 'cell_1', 'remote',
      'gateway_1', NULL, 'backend_1', 'server/runtime/backend-1', 'provider_1',
      'complete', 'cleanup-pending', NULL, '2026-09-10T01:00:00.000Z',
      '2026-09-10T02:00:00.000Z', 'target_1', '{"kind":"reference"}',
      'sandbox-binding-1'
    );
    INSERT INTO preserved_records VALUES ('record_1', 'pending', '{"lease":"lease_1"}');
  `);
  sqlite.close();

  return { dataRoot, databasePath };
}

function columnInfo(
  databasePath: string,
  table: string
): Array<{
  readonly dflt_value: string | null;
  readonly name: string;
  readonly notnull: 0 | 1;
}> {
  const sqlite = new Database(databasePath, { fileMustExist: true, readonly: true });
  try {
    return sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      dflt_value: string | null;
      name: string;
      notnull: 0 | 1;
    }>;
  } finally {
    sqlite.close();
  }
}

describe('physical Epoch cutover', () => {
  it('converts the three schemas atomically after retaining a complete predecessor backup', () => {
    const fixture = createPhysicalEpochFixture();
    const backupRoot = join(
      mkdtempSync(join(tmpdir(), 'openkit-physical-epoch-backup-')),
      'backup'
    );

    const result = migratePhysicalEpochs({
      backupRoot,
      dataRoot: fixture.dataRoot,
      now: () => timestamp,
    });

    expect(result).toEqual({
      backendSessionCount: 1,
      backupId: expect.stringMatching(/^backup_physical_epoch_/),
      outcome: 'succeeded',
      runtimeTargetCount: 1,
      sandboxCount: 1,
    });
    expect(verifyDataRootBackupManifest({ backupRoot }).checkedFiles).toContain(
      'server/db/core.sqlite'
    );
    expect(readFileSync(join(backupRoot, 'preserved.txt'), 'utf8')).toBe(
      'preserved predecessor bytes\n'
    );
    expect(existsSync(join(backupRoot, 'server', 'runtime', 'nanocore.lock'))).toBe(false);
    expect(existsSync(join(fixture.dataRoot, 'server', 'runtime', 'nanocore.lock'))).toBe(false);

    const predecessor = new Database(join(backupRoot, 'server', 'db', 'core.sqlite'), {
      fileMustExist: true,
      readonly: true,
    });
    const sqlite = new Database(fixture.databasePath, { fileMustExist: true, readonly: true });
    try {
      const predecessorTarget = predecessor
        .prepare('SELECT * FROM nanohost_runtime_targets WHERE target_id = ?')
        .get('target_1') as Record<string, unknown>;
      const { physical_epoch: targetEpoch, ...convertedTarget } = sqlite
        .prepare('SELECT * FROM nanohost_runtime_targets WHERE target_id = ?')
        .get('target_1') as Record<string, unknown>;
      expect(targetEpoch).toBeNull();
      expect(convertedTarget).toEqual({ ...predecessorTarget, fresh_empty: 0, ready: 0 });

      const predecessorSandbox = predecessor
        .prepare('SELECT * FROM sandbox_runtime_records WHERE sandbox_runtime_id = ?')
        .get('sandbox_1');
      const { origin_physical_epoch: sandboxOrigin, ...convertedSandbox } = sqlite
        .prepare('SELECT * FROM sandbox_runtime_records WHERE sandbox_runtime_id = ?')
        .get('sandbox_1') as Record<string, unknown>;
      expect(sandboxOrigin).toBe('pre-witness');
      expect(convertedSandbox).toEqual(predecessorSandbox);
      expect(sqlite.prepare('SELECT * FROM harness_instance_records').all()).toEqual(
        predecessor.prepare('SELECT * FROM harness_instance_records').all()
      );
      expect(sqlite.prepare('SELECT * FROM agent_session_runtime_bindings').all()).toEqual(
        predecessor.prepare('SELECT * FROM agent_session_runtime_bindings').all()
      );

      const predecessorBackend = predecessor
        .prepare('SELECT * FROM worker_backend_sessions WHERE lease_id = ?')
        .get('lease_1');
      const { origin_physical_epoch: backendOrigin, ...convertedBackend } = sqlite
        .prepare('SELECT * FROM worker_backend_sessions WHERE lease_id = ?')
        .get('lease_1') as Record<string, unknown>;
      expect(backendOrigin).toBe('pre-witness');
      expect(convertedBackend).toEqual(predecessorBackend);
      expect(sqlite.prepare('SELECT * FROM preserved_records').all()).toEqual(
        predecessor.prepare('SELECT * FROM preserved_records').all()
      );
      expect(sqlite.prepare('SELECT id FROM schema_migrations ORDER BY id').pluck().all()).toEqual([
        'core_0000_setup',
        'core_0001_physical_epoch_cutover',
      ]);
      expect(userIndexNames(sqlite, 'sandbox_runtime_records')).toEqual([
        'sandbox_runtime_records_binding_idx',
        'sandbox_runtime_records_integration_binding_idx',
        'sandbox_runtime_records_target_idx',
      ]);
      expect(userIndexNames(sqlite, 'worker_backend_sessions')).toHaveLength(11);
      expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(sqlite.prepare('PRAGMA quick_check').pluck().get()).toBe('ok');
    } finally {
      sqlite.close();
      predecessor.close();
    }

    expect(
      columnInfo(fixture.databasePath, 'nanohost_runtime_targets').find(
        ({ name }) => name === 'physical_epoch'
      )
    ).toMatchObject({
      dflt_value: null,
      name: 'physical_epoch',
      notnull: 0,
    });
    for (const table of ['sandbox_runtime_records', 'worker_backend_sessions']) {
      expect(
        columnInfo(fixture.databasePath, table).find(({ name }) => name === 'origin_physical_epoch')
      ).toMatchObject({
        dflt_value: null,
        name: 'origin_physical_epoch',
        notnull: 1,
      });
    }
    expect(
      existsSync(join(fixture.dataRoot, 'server', 'migrations', 'physical-epoch-cutover.json'))
    ).toBe(true);
  });

  it('holds the existing data-root lock through backup and database conversion', () => {
    const fixture = createPhysicalEpochFixture();
    const backupRoot = join(
      mkdtempSync(join(tmpdir(), 'openkit-physical-epoch-backup-')),
      'backup'
    );
    let clockReads = 0;
    let contenderError: unknown;

    migratePhysicalEpochs({
      backupRoot,
      dataRoot: fixture.dataRoot,
      now: () => {
        clockReads += 1;
        if (clockReads === 4) {
          try {
            acquireDataRootLock(fixture.dataRoot, { bootId: 'competing-core' });
          } catch (error) {
            contenderError = error;
          }
        }
        return timestamp;
      },
    });

    expect(contenderError).toBeInstanceOf(DataRootLockError);
    expect(existsSync(join(backupRoot, 'server', 'runtime', 'nanocore.lock'))).toBe(false);
    expect(existsSync(join(fixture.dataRoot, 'server', 'runtime', 'nanocore.lock'))).toBe(false);
  });

  it('rolls back every schema, row, and ledger change when the transaction fails', () => {
    const fixture = createPhysicalEpochFixture();
    const backupRoot = join(
      mkdtempSync(join(tmpdir(), 'openkit-physical-epoch-backup-')),
      'backup'
    );
    const sqlite = new Database(fixture.databasePath);
    sqlite.exec(`
      CREATE TRIGGER reject_physical_epoch_cutover
      BEFORE INSERT ON schema_migrations
      BEGIN
        SELECT RAISE(ABORT, 'injected cutover failure');
      END;
    `);
    sqlite.close();

    expect(() =>
      migratePhysicalEpochs({ backupRoot, dataRoot: fixture.dataRoot, now: () => timestamp })
    ).toThrow(/injected cutover failure/);

    expect(
      columnInfo(fixture.databasePath, 'nanohost_runtime_targets').map(({ name }) => name)
    ).not.toContain('physical_epoch');
    expect(
      columnInfo(fixture.databasePath, 'sandbox_runtime_records').map(({ name }) => name)
    ).not.toContain('origin_physical_epoch');
    const verify = new Database(fixture.databasePath, { readonly: true });
    try {
      expect(
        verify.prepare('SELECT ready, fresh_empty FROM nanohost_runtime_targets').get()
      ).toEqual({
        fresh_empty: 1,
        ready: 1,
      });
      expect(verify.prepare('SELECT id FROM schema_migrations ORDER BY id').pluck().all()).toEqual([
        'core_0000_setup',
      ]);
    } finally {
      verify.close();
    }
    expect(verifyDataRootBackupManifest({ backupRoot }).checkedFiles).toContain(
      'server/db/core.sqlite'
    );
  });

  it('refuses a repeat conversion before creating another backup', () => {
    const fixture = createPhysicalEpochFixture();
    const parent = mkdtempSync(join(tmpdir(), 'openkit-physical-epoch-backup-'));
    migratePhysicalEpochs({
      backupRoot: join(parent, 'first'),
      dataRoot: fixture.dataRoot,
      now: () => timestamp,
    });

    const secondBackup = join(parent, 'second');
    expect(() =>
      migratePhysicalEpochs({
        backupRoot: secondBackup,
        dataRoot: fixture.dataRoot,
        now: () => timestamp,
      })
    ).toThrow(/already completed|already exists|predecessor schema/i);
    expect(existsSync(secondBackup)).toBe(false);
  });

  it('refuses a same-named altered predecessor index before backup or mutation', () => {
    const fixture = createPhysicalEpochFixture();
    const backupRoot = join(
      mkdtempSync(join(tmpdir(), 'openkit-physical-epoch-backup-')),
      'backup'
    );
    const sqlite = new Database(fixture.databasePath);
    sqlite.exec(`
      DROP INDEX sandbox_runtime_records_target_idx;
      CREATE UNIQUE INDEX sandbox_runtime_records_target_idx
        ON sandbox_runtime_records (lifecycle_state, runtime_target_id);
    `);
    sqlite.close();

    expect(() =>
      migratePhysicalEpochs({ backupRoot, dataRoot: fixture.dataRoot, now: () => timestamp })
    ).toThrow(/exact predecessor index sandbox_runtime_records_target_idx/);
    expect(existsSync(backupRoot)).toBe(false);
    expect(
      columnInfo(fixture.databasePath, 'nanohost_runtime_targets').map(({ name }) => name)
    ).not.toContain('physical_epoch');
  });

  it('refuses an altered predecessor table constraint before backup or mutation', () => {
    const fixture = createPhysicalEpochFixture({ sandboxOpenCapacityMinimum: 1 });
    const backupRoot = join(
      mkdtempSync(join(tmpdir(), 'openkit-physical-epoch-backup-')),
      'backup'
    );
    expect(() =>
      migratePhysicalEpochs({ backupRoot, dataRoot: fixture.dataRoot, now: () => timestamp })
    ).toThrow(/exact predecessor schema for sandbox_runtime_records/);
    expect(existsSync(backupRoot)).toBe(false);
    expect(
      columnInfo(fixture.databasePath, 'sandbox_runtime_records').map(({ name }) => name)
    ).not.toContain('origin_physical_epoch');
  });

  it('does not erase SQL token boundaries while validating predecessor DDL', () => {
    const fixture = createPhysicalEpochFixture({ splitPinnedGoalIdentifier: true });
    const backupRoot = join(
      mkdtempSync(join(tmpdir(), 'openkit-physical-epoch-backup-')),
      'backup'
    );

    expect(() =>
      migratePhysicalEpochs({ backupRoot, dataRoot: fixture.dataRoot, now: () => timestamp })
    ).toThrow(/exact predecessor schema for sandbox_runtime_records/);
    expect(existsSync(backupRoot)).toBe(false);
  });

  it('refuses a running Core before creating a backup', () => {
    const fixture = createPhysicalEpochFixture();
    const backupRoot = join(
      mkdtempSync(join(tmpdir(), 'openkit-physical-epoch-backup-')),
      'backup'
    );
    writeFileSync(join(fixture.dataRoot, 'server', 'runtime', 'nanocore.lock'), 'running\n');

    expect(() =>
      migratePhysicalEpochs({ backupRoot, dataRoot: fixture.dataRoot, now: () => timestamp })
    ).toThrow(/NanoCore appears to be running/);
    expect(existsSync(backupRoot)).toBe(false);
  });

  it('refuses an incomplete predecessor backup before database mutation', () => {
    const fixture = createPhysicalEpochFixture();
    const backupRoot = join(
      mkdtempSync(join(tmpdir(), 'openkit-physical-epoch-backup-')),
      'backup'
    );
    let clockReads = 0;

    expect(() =>
      migratePhysicalEpochs({
        backupRoot,
        dataRoot: fixture.dataRoot,
        now: () => {
          clockReads += 1;
          if (clockReads === 2) {
            writeFileSync(join(fixture.dataRoot, 'preserved.txt'), 'changed during backup\n');
          }
          return timestamp;
        },
      })
    ).toThrow(/backup.*predecessor/i);
    expect(
      columnInfo(fixture.databasePath, 'nanohost_runtime_targets').map(({ name }) => name)
    ).not.toContain('physical_epoch');
    expect(
      columnInfo(fixture.databasePath, 'worker_backend_sessions').map(({ name }) => name)
    ).not.toContain('origin_physical_epoch');
  });

  it('parses the closed CLI and emits a path-free success summary', () => {
    const fixture = createPhysicalEpochFixture();
    const backupRoot = join(
      mkdtempSync(join(tmpdir(), 'openkit-physical-epoch-backup-')),
      'backup'
    );
    const output: string[] = [];

    expect(
      parsePhysicalEpochMigrationArgs([
        '--data-root',
        fixture.dataRoot,
        '--backup-root',
        backupRoot,
      ])
    ).toEqual({
      backupRoot,
      dataRoot: fixture.dataRoot,
    });
    runPhysicalEpochMigrationCli(
      ['--data-root', fixture.dataRoot, '--backup-root', backupRoot],
      (line) => output.push(line),
      () => timestamp
    );

    expect(output).toHaveLength(1);
    expect(output[0]).not.toContain(fixture.dataRoot);
    expect(output[0]).not.toContain(backupRoot);
    expect(JSON.parse(output[0]!)).toMatchObject({ outcome: 'succeeded' });
    expect(() => parsePhysicalEpochMigrationArgs(['--data-root', fixture.dataRoot])).toThrow(
      /--backup-root/
    );
  });
});

function userIndexNames(sqlite: Database.Database, table: string): string[] {
  return (
    sqlite.prepare(`PRAGMA index_list(${table})`).all() as Array<{
      name: string;
      origin: string;
    }>
  )
    .filter(({ origin }) => origin === 'c')
    .map(({ name }) => name)
    .sort();
}

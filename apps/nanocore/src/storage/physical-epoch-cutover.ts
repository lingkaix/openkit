import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import Database from 'better-sqlite3';

import { acquireDataRootLock, DataRootLockError } from '../bootstrap/lock.js';
import {
  assertBackupMatchesPredecessor,
  assertExternalColdBackupDestination,
  copyColdDataRoot,
  inventoryRegularFiles,
  type RegularFileInventoryEntry,
  writeColdDataRootBackupManifest,
  writeStorageJsonAtomically,
} from './data-root-backup.js';
import { coreDbPath, readDataRootLayoutMarker, resolveDataRootPath } from './fs-layout.js';

/** Reserved provenance assigned only to rows converted from the pre-witness database. */
const PRE_WITNESS_ORIGIN = 'pre-witness';

/** Private ledger id committed atomically with the one supported cutover. */
const PHYSICAL_EPOCH_CUTOVER_ID = 'core_0001_physical_epoch_cutover';

/** Fixed evidence-only report emitted after a successful cutover. */
const PHYSICAL_EPOCH_REPORT_FILE = 'physical-epoch-cutover.json';

const PREDECESSOR_TARGET_SQL = `
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
  )
`;

const PREDECESSOR_SANDBOX_SQL = `
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
    pinned_goal_id text,
    CONSTRAINT sandbox_runtime_records_open_capacity_check CHECK (max_open_sessions >= 2),
    CONSTRAINT sandbox_runtime_records_harness_capacity_check CHECK (max_harnesses >= 2),
    CONSTRAINT sandbox_runtime_records_turn_capacity_check CHECK (max_active_turns = 1)
  )
`;

const PREDECESSOR_BACKEND_SQL = `
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
  )
`;

const SUCCESSOR_TARGET_SQL = PREDECESSOR_TARGET_SQL.replace(
  'fresh_empty integer NOT NULL,',
  'fresh_empty integer NOT NULL, physical_epoch text,'
);
const SUCCESSOR_SANDBOX_SQL = PREDECESSOR_SANDBOX_SQL.replace(
  'runtime_target_id text NOT NULL REFERENCES nanohost_runtime_targets(target_id) ON DELETE RESTRICT,',
  'runtime_target_id text NOT NULL REFERENCES nanohost_runtime_targets(target_id) ON DELETE RESTRICT, origin_physical_epoch text NOT NULL,'
);
const SUCCESSOR_BACKEND_SQL = PREDECESSOR_BACKEND_SQL.replace(
  'runtime_target_id text,',
  'runtime_target_id text, origin_physical_epoch text NOT NULL,'
);

const SANDBOX_INDEX_SQL: Readonly<Record<string, string>> = {
  sandbox_runtime_records_binding_idx:
    'CREATE UNIQUE INDEX sandbox_runtime_records_binding_idx ON sandbox_runtime_records (sandbox_binding_ref)',
  sandbox_runtime_records_integration_binding_idx:
    'CREATE UNIQUE INDEX sandbox_runtime_records_integration_binding_idx ON sandbox_runtime_records (sandbox_integration_binding_ref)',
  sandbox_runtime_records_target_idx:
    'CREATE INDEX sandbox_runtime_records_target_idx ON sandbox_runtime_records (runtime_target_id, lifecycle_state)',
};

const BACKEND_INDEX_SQL: Readonly<Record<string, string>> = {
  worker_backend_sessions_backend_session_idx:
    'CREATE UNIQUE INDEX worker_backend_sessions_backend_session_idx ON worker_backend_sessions (backend_session_id)',
  worker_backend_sessions_endpoint_provider_idx:
    'CREATE UNIQUE INDEX worker_backend_sessions_endpoint_provider_idx ON worker_backend_sessions (backend_kind, gateway_endpoint, transient_provider_instance_id) WHERE gateway_endpoint IS NOT NULL AND transient_provider_instance_id IS NOT NULL',
  worker_backend_sessions_endpoint_target_idx:
    'CREATE UNIQUE INDEX worker_backend_sessions_endpoint_target_idx ON worker_backend_sessions (backend_kind, gateway_endpoint, backend_session_id) WHERE gateway_endpoint IS NOT NULL',
  worker_backend_sessions_lineage_idx:
    'CREATE INDEX worker_backend_sessions_lineage_idx ON worker_backend_sessions (workspace_id, thread_id, turn_id, agent_session_id, package_snapshot_id)',
  worker_backend_sessions_named_provider_idx:
    'CREATE UNIQUE INDEX worker_backend_sessions_named_provider_idx ON worker_backend_sessions (backend_kind, gateway_name, transient_provider_instance_id) WHERE gateway_endpoint IS NULL AND transient_provider_instance_id IS NOT NULL',
  worker_backend_sessions_named_target_idx:
    'CREATE UNIQUE INDEX worker_backend_sessions_named_target_idx ON worker_backend_sessions (backend_kind, gateway_name, backend_session_id) WHERE gateway_endpoint IS NULL',
  worker_backend_sessions_package_idx:
    'CREATE UNIQUE INDEX worker_backend_sessions_package_idx ON worker_backend_sessions (package_snapshot_id)',
  worker_backend_sessions_sandbox_binding_idx:
    'CREATE UNIQUE INDEX worker_backend_sessions_sandbox_binding_idx ON worker_backend_sessions (sandbox_binding_ref) WHERE sandbox_binding_ref IS NOT NULL',
  worker_backend_sessions_staging_idx:
    'CREATE UNIQUE INDEX worker_backend_sessions_staging_idx ON worker_backend_sessions (staging_directory_ref)',
  worker_backend_sessions_state_idx:
    'CREATE INDEX worker_backend_sessions_state_idx ON worker_backend_sessions (state, updated_at)',
  worker_backend_sessions_transient_provider_idx:
    'CREATE UNIQUE INDEX worker_backend_sessions_transient_provider_idx ON worker_backend_sessions (transient_provider_instance_id) WHERE transient_provider_instance_id IS NOT NULL',
};

/** Input for the stopped, one-way physical Epoch cutover. */
export interface MigratePhysicalEpochsInput {
  /** External destination for the complete predecessor cold backup. */
  readonly backupRoot: string;
  /** Pre-witness data root to convert in place. */
  readonly dataRoot: string;
  /** Optional timestamp source for deterministic tests. */
  readonly now?: () => string;
}

/** Evidence-safe summary returned by a successful physical Epoch cutover. */
export interface PhysicalEpochMigrationResult {
  /** Number of converted backend-session origins. */
  readonly backendSessionCount: number;
  /** Verified predecessor backup identity. */
  readonly backupId: string;
  /** Successful terminal outcome. */
  readonly outcome: 'succeeded';
  /** Number of RuntimeTargets made non-ready. */
  readonly runtimeTargetCount: number;
  /** Number of converted Sandbox origins. */
  readonly sandboxCount: number;
}

/** Parsed arguments for the stopped-process physical Epoch migration CLI. */
export interface PhysicalEpochMigrationCliArgs {
  /** External destination for the complete predecessor cold backup. */
  readonly backupRoot: string;
  /** Pre-witness data root to convert. */
  readonly dataRoot: string;
}

/** Internal row counts captured before and verified after conversion. */
interface PhysicalEpochRowCounts {
  readonly agentSessionBindingCount: number;
  readonly backendSessionCount: number;
  readonly harnessInstanceCount: number;
  readonly runtimeTargetCount: number;
  readonly sandboxCount: number;
}

/** Evidence-only record written after the ledger transaction commits. */
interface PhysicalEpochMigrationReport extends PhysicalEpochMigrationResult {
  readonly backup: {
    readonly contentDigest: string;
    readonly inventoryFileCount: number;
  };
  readonly completedAt: string;
  readonly migrationId: typeof PHYSICAL_EPOCH_CUTOVER_ID;
  readonly recordType: 'physical-epoch-cutover';
  readonly schemaVersion: 1;
  readonly startedAt: string;
}

/**
 * Converts the stopped pre-witness Core database to the closed physical Epoch schema.
 *
 * The operator-owned predecessor effect-domain fence is an external precondition. This local
 * converter proves only that NanoCore is stopped and that a complete predecessor backup exists.
 *
 * @param input Data root, external backup destination, and optional clock.
 * @returns Evidence-safe successful conversion summary.
 * @throws Error when the Core is running, backup is incomplete, schema is not the predecessor,
 * or the single database transaction fails.
 */
export function migratePhysicalEpochs(
  input: MigratePhysicalEpochsInput
): PhysicalEpochMigrationResult {
  const now = input.now ?? (() => new Date().toISOString());
  assertExternalColdBackupDestination(input.dataRoot, input.backupRoot);
  const lock = acquireCutoverLock(input.dataRoot);

  try {
    const startedAt = now();
    const reportPath = resolveDataRootPath(
      input.dataRoot,
      'server',
      'migrations',
      PHYSICAL_EPOCH_REPORT_FILE
    );

    const marker = readDataRootLayoutMarker(input.dataRoot);
    const databasePath = coreDbPath(input.dataRoot);
    const counts = preflightPredecessorDatabase(databasePath);
    const predecessorInventory = inventoryPredecessorFiles(input.dataRoot, lock.path);
    const backupStartedAt = now();

    copyColdDataRoot({
      backupRoot: input.backupRoot,
      dataRoot: input.dataRoot,
      omitActiveDataRootLock: true,
    });
    const backupCompletedAt = now();
    const backup = writeColdDataRootBackupManifest({
      backupRoot: input.backupRoot,
      backupId: createBackupId(marker.deploymentId, backupStartedAt),
      sourceDeploymentId: marker.deploymentId,
      startedAt: backupStartedAt,
      completedAt: backupCompletedAt,
    });
    assertBackupMatchesPredecessor(backup, predecessorInventory);
    assertInventoriesEqual(
      predecessorInventory,
      inventoryPredecessorFiles(input.dataRoot, lock.path),
      'Predecessor data root changed after backup capture.'
    );

    convertPhysicalEpochSchemas(databasePath, counts, now());

    const result: PhysicalEpochMigrationResult = {
      backendSessionCount: counts.backendSessionCount,
      backupId: backup.manifest.id,
      outcome: 'succeeded',
      runtimeTargetCount: counts.runtimeTargetCount,
      sandboxCount: counts.sandboxCount,
    };
    const report: PhysicalEpochMigrationReport = {
      ...result,
      backup: {
        contentDigest: backup.manifest.contentDigest,
        inventoryFileCount: backup.manifest.contentInventory.length,
      },
      completedAt: now(),
      migrationId: PHYSICAL_EPOCH_CUTOVER_ID,
      recordType: 'physical-epoch-cutover',
      schemaVersion: 1,
      startedAt,
    };
    writeStorageJsonAtomically(reportPath, report);

    return result;
  } finally {
    lock.release();
  }
}

/**
 * Parses the closed physical Epoch migration CLI flags.
 *
 * @param argv Argument vector after the script name.
 * @returns Required data-root and backup-root arguments.
 * @throws Error when a flag is missing, duplicated, unknown, or malformed.
 */
export function parsePhysicalEpochMigrationArgs(
  argv: readonly string[]
): PhysicalEpochMigrationCliArgs {
  const { values } = parseArgs({
    allowPositionals: false,
    args: argv[0] === '--' ? [...argv.slice(1)] : [...argv],
    options: {
      'backup-root': { multiple: true, type: 'string' },
      'data-root': { multiple: true, type: 'string' },
    },
    strict: true,
  });

  return {
    backupRoot: requireOneFlag(values['backup-root'], '--backup-root'),
    dataRoot: requireOneFlag(values['data-root'], '--data-root'),
  };
}

/**
 * Runs the stopped-process physical Epoch migration CLI.
 *
 * @param argv Argument vector after the script name.
 * @param write Output sink for the path-free JSON summary.
 * @param now Optional timestamp source for deterministic tests.
 * @returns Evidence-safe successful conversion summary.
 */
export function runPhysicalEpochMigrationCli(
  argv: readonly string[],
  write: (line: string) => void = (line) => process.stdout.write(line),
  now?: () => string
): PhysicalEpochMigrationResult {
  const args = parsePhysicalEpochMigrationArgs(argv);
  const summary = migratePhysicalEpochs(now ? { ...args, now } : args);
  write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

/** Reads and validates the exact predecessor schema before any backup write. */
function preflightPredecessorDatabase(databasePath: string): PhysicalEpochRowCounts {
  const sqlite = new Database(databasePath, { fileMustExist: true, readonly: true });

  try {
    if (sqlite.prepare('PRAGMA quick_check').pluck().get() !== 'ok') {
      throw new Error('Physical Epoch cutover requires a healthy predecessor Core database.');
    }
    const completed = sqlite
      .prepare('SELECT 1 FROM schema_migrations WHERE id = ?')
      .get(PHYSICAL_EPOCH_CUTOVER_ID);
    if (completed) {
      throw new Error('Physical Epoch cutover already completed.');
    }

    assertTableSql(sqlite, 'nanohost_runtime_targets', PREDECESSOR_TARGET_SQL);
    assertTableSql(sqlite, 'sandbox_runtime_records', PREDECESSOR_SANDBOX_SQL);
    assertTableSql(sqlite, 'worker_backend_sessions', PREDECESSOR_BACKEND_SQL);
    assertIndexes(sqlite, 'nanohost_runtime_targets', {});
    assertIndexes(sqlite, 'sandbox_runtime_records', SANDBOX_INDEX_SQL);
    assertIndexes(sqlite, 'worker_backend_sessions', BACKEND_INDEX_SQL);
    assertNoTriggers(sqlite, [
      'nanohost_runtime_targets',
      'sandbox_runtime_records',
      'worker_backend_sessions',
    ]);

    return readRowCounts(sqlite);
  } finally {
    sqlite.close();
  }
}

/** Applies all schema, row, readiness, and ledger changes in one SQLite transaction. */
function convertPhysicalEpochSchemas(
  databasePath: string,
  expectedCounts: PhysicalEpochRowCounts,
  appliedAt: string
): void {
  const sqlite = new Database(databasePath, { fileMustExist: true });

  try {
    sqlite.pragma('foreign_keys = OFF');
    sqlite.transaction(() => {
      assertTableSql(sqlite, 'nanohost_runtime_targets', PREDECESSOR_TARGET_SQL);
      assertTableSql(sqlite, 'sandbox_runtime_records', PREDECESSOR_SANDBOX_SQL);
      assertTableSql(sqlite, 'worker_backend_sessions', PREDECESSOR_BACKEND_SQL);
      assertIndexes(sqlite, 'nanohost_runtime_targets', {});
      assertIndexes(sqlite, 'sandbox_runtime_records', SANDBOX_INDEX_SQL);
      assertIndexes(sqlite, 'worker_backend_sessions', BACKEND_INDEX_SQL);
      assertNoTriggers(sqlite, [
        'nanohost_runtime_targets',
        'sandbox_runtime_records',
        'worker_backend_sessions',
      ]);

      sqlite.exec('UPDATE nanohost_runtime_targets SET ready = 0, fresh_empty = 0');
      rebuildNanoHostRuntimeTargets(sqlite);
      rebuildSandboxRuntimeRecords(sqlite);
      rebuildWorkerBackendSessions(sqlite);

      assertTableSql(sqlite, 'nanohost_runtime_targets', SUCCESSOR_TARGET_SQL);
      assertTableSql(sqlite, 'sandbox_runtime_records', SUCCESSOR_SANDBOX_SQL);
      assertTableSql(sqlite, 'worker_backend_sessions', SUCCESSOR_BACKEND_SQL);
      assertIndexes(sqlite, 'nanohost_runtime_targets', {});
      assertIndexes(sqlite, 'sandbox_runtime_records', SANDBOX_INDEX_SQL);
      assertIndexes(sqlite, 'worker_backend_sessions', BACKEND_INDEX_SQL);

      sqlite
        .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run(PHYSICAL_EPOCH_CUTOVER_ID, appliedAt);

      const actualCounts = readRowCounts(sqlite);
      if (JSON.stringify(actualCounts) !== JSON.stringify(expectedCounts)) {
        throw new Error('Physical Epoch cutover changed an owned row count.');
      }
      if (sqlite.prepare('PRAGMA foreign_key_check').all().length > 0) {
        throw new Error('Physical Epoch cutover failed its foreign-key verification.');
      }
      assertConvertedOrigins(sqlite, expectedCounts);
    })();
  } finally {
    sqlite.pragma('foreign_keys = ON');
    sqlite.close();
  }
}

/** Rebuilds RuntimeTargets with the nullable witness in the clean-target column order. */
function rebuildNanoHostRuntimeTargets(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE physical_epoch_nanohost_runtime_targets (
      target_id text PRIMARY KEY NOT NULL,
      identity_id text NOT NULL,
      deployment_id text NOT NULL,
      connection_generation integer NOT NULL,
      predecessor_fenced integer NOT NULL,
      ready integer NOT NULL,
      fresh_empty integer NOT NULL,
      physical_epoch text,
      observed_at text NOT NULL,
      slot_count integer NOT NULL,
      last_fresh_ready_at text
    );
    INSERT INTO physical_epoch_nanohost_runtime_targets (
      target_id, identity_id, deployment_id, connection_generation, predecessor_fenced,
      ready, fresh_empty, physical_epoch, observed_at, slot_count, last_fresh_ready_at
    ) SELECT
      target_id, identity_id, deployment_id, connection_generation, predecessor_fenced,
      ready, fresh_empty, NULL, observed_at, slot_count, last_fresh_ready_at
    FROM nanohost_runtime_targets;
    DROP TABLE nanohost_runtime_targets;
    ALTER TABLE physical_epoch_nanohost_runtime_targets RENAME TO nanohost_runtime_targets;
  `);
}

/** Rebuilds the Sandbox table so the new origin is non-null without a default. */
function rebuildSandboxRuntimeRecords(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE physical_epoch_sandbox_runtime_records (
      sandbox_runtime_id text PRIMARY KEY NOT NULL,
      runtime_target_id text NOT NULL REFERENCES nanohost_runtime_targets(target_id) ON DELETE RESTRICT,
      origin_physical_epoch text NOT NULL,
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
      pinned_goal_id text,
      CONSTRAINT sandbox_runtime_records_open_capacity_check CHECK (max_open_sessions >= 2),
      CONSTRAINT sandbox_runtime_records_harness_capacity_check CHECK (max_harnesses >= 2),
      CONSTRAINT sandbox_runtime_records_turn_capacity_check CHECK (max_active_turns = 1)
    );
    INSERT INTO physical_epoch_sandbox_runtime_records (
      sandbox_runtime_id, runtime_target_id, origin_physical_epoch, sandbox_binding_ref,
      sandbox_integration_binding_ref, sandbox_compatibility_key, image_digest, environment_class,
      max_open_sessions, max_harnesses, max_active_turns, lifecycle_state, health_state, drain_state,
      cleanup_state, created_at, updated_at, pinned_goal_id
    ) SELECT
      sandbox_runtime_id, runtime_target_id, '${PRE_WITNESS_ORIGIN}', sandbox_binding_ref,
      sandbox_integration_binding_ref, sandbox_compatibility_key, image_digest, environment_class,
      max_open_sessions, max_harnesses, max_active_turns, lifecycle_state, health_state, drain_state,
      cleanup_state, created_at, updated_at, pinned_goal_id
    FROM sandbox_runtime_records;
    DROP TABLE sandbox_runtime_records;
    ALTER TABLE physical_epoch_sandbox_runtime_records RENAME TO sandbox_runtime_records;
    CREATE UNIQUE INDEX sandbox_runtime_records_binding_idx
      ON sandbox_runtime_records (sandbox_binding_ref);
    CREATE UNIQUE INDEX sandbox_runtime_records_integration_binding_idx
      ON sandbox_runtime_records (sandbox_integration_binding_ref);
    CREATE INDEX sandbox_runtime_records_target_idx
      ON sandbox_runtime_records (runtime_target_id, lifecycle_state);
  `);
}

/** Rebuilds the backend-session table so the new origin is non-null without a default. */
function rebuildWorkerBackendSessions(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE physical_epoch_worker_backend_sessions (
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
      origin_physical_epoch text NOT NULL,
      backend_lineage_json text,
      sandbox_binding_ref text
    );
    INSERT INTO physical_epoch_worker_backend_sessions (
      lease_id, workspace_id, thread_id, turn_id, agent_session_id, package_snapshot_id,
      backend_kind, deployment_id, backend_version, worker_image, cell_target_id, placement,
      gateway_name, gateway_endpoint, backend_session_id, staging_directory_ref,
      transient_provider_instance_id, workspace_handoff_state, state, physical_cleaned_at,
      created_at, updated_at, runtime_target_id, origin_physical_epoch, backend_lineage_json,
      sandbox_binding_ref
    ) SELECT
      lease_id, workspace_id, thread_id, turn_id, agent_session_id, package_snapshot_id,
      backend_kind, deployment_id, backend_version, worker_image, cell_target_id, placement,
      gateway_name, gateway_endpoint, backend_session_id, staging_directory_ref,
      transient_provider_instance_id, workspace_handoff_state, state, physical_cleaned_at,
      created_at, updated_at, runtime_target_id, '${PRE_WITNESS_ORIGIN}', backend_lineage_json,
      sandbox_binding_ref
    FROM worker_backend_sessions;
    DROP TABLE worker_backend_sessions;
    ALTER TABLE physical_epoch_worker_backend_sessions RENAME TO worker_backend_sessions;
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
  `);
}

/** Confirms every converted origin and cleared target witness after the transaction writes. */
function assertConvertedOrigins(
  sqlite: Database.Database,
  expectedCounts: PhysicalEpochRowCounts
): void {
  const readyTargets = Number(
    sqlite
      .prepare(
        'SELECT COUNT(*) FROM nanohost_runtime_targets WHERE ready != 0 OR fresh_empty != 0 OR physical_epoch IS NOT NULL'
      )
      .pluck()
      .get()
  );
  const convertedSandboxes = Number(
    sqlite
      .prepare('SELECT COUNT(*) FROM sandbox_runtime_records WHERE origin_physical_epoch = ?')
      .pluck()
      .get(PRE_WITNESS_ORIGIN)
  );
  const convertedBackends = Number(
    sqlite
      .prepare('SELECT COUNT(*) FROM worker_backend_sessions WHERE origin_physical_epoch = ?')
      .pluck()
      .get(PRE_WITNESS_ORIGIN)
  );

  if (
    readyTargets !== 0 ||
    convertedSandboxes !== expectedCounts.sandboxCount ||
    convertedBackends !== expectedCounts.backendSessionCount
  ) {
    throw new Error('Physical Epoch cutover verification failed.');
  }
}

/** Reads stable row counts for the three converted tables. */
function readRowCounts(sqlite: Database.Database): PhysicalEpochRowCounts {
  return {
    agentSessionBindingCount: countRows(sqlite, 'agent_session_runtime_bindings'),
    backendSessionCount: countRows(sqlite, 'worker_backend_sessions'),
    harnessInstanceCount: countRows(sqlite, 'harness_instance_records'),
    runtimeTargetCount: countRows(sqlite, 'nanohost_runtime_targets'),
    sandboxCount: countRows(sqlite, 'sandbox_runtime_records'),
  };
}

/** Counts rows in one fixed migration-owned table. */
function countRows(sqlite: Database.Database, table: string): number {
  return Number(sqlite.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get());
}

/** Rejects a table whose complete canonical DDL differs from the accepted schema. */
function assertTableSql(sqlite: Database.Database, table: string, expected: string): void {
  const row = sqlite
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string | null } | undefined;
  if (!row?.sql || normalizeSchemaSql(row.sql) !== normalizeSchemaSql(expected)) {
    throw new Error(`Physical Epoch cutover requires the exact predecessor schema for ${table}.`);
  }
}

/** Rejects rebuilt tables with unknown, missing, or altered caller-defined indexes. */
function assertIndexes(
  sqlite: Database.Database,
  table: string,
  expected: Readonly<Record<string, string>>
): void {
  const indexes = sqlite
    .prepare(
      "SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL"
    )
    .all(table) as Array<{
    name: string;
    sql: string;
  }>;
  const actualNames = indexes.map(({ name }) => name).sort();
  const expectedNames = Object.keys(expected).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(`Physical Epoch cutover requires the exact predecessor indexes for ${table}.`);
  }
  for (const index of indexes) {
    if (normalizeSchemaSql(index.sql) !== normalizeSchemaSql(expected[index.name]!)) {
      throw new Error(`Physical Epoch cutover requires the exact predecessor index ${index.name}.`);
    }
  }
}

/** Compares the closed schema vocabulary as tokens without erasing token or literal boundaries. */
function normalizeSchemaSql(sql: string): string {
  const tokens: string[] = [];
  let offset = 0;

  while (offset < sql.length) {
    const remainder = sql.slice(offset);
    const whitespace = /^[\t\n\r ]+/.exec(remainder)?.[0];
    if (whitespace) {
      offset += whitespace.length;
      continue;
    }

    const quote = sql[offset];
    if (quote === '`' || quote === '"') {
      const end = sql.indexOf(quote, offset + 1);
      if (end < 0) {
        throw new Error('Physical Epoch schema contains an unterminated quoted identifier.');
      }
      const identifier = sql.slice(offset + 1, end);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
        throw new Error('Physical Epoch schema contains an unsupported quoted identifier.');
      }
      tokens.push(`word:${identifier.toLowerCase()}`);
      offset = end + 1;
      continue;
    }

    if (quote === "'") {
      let end = offset + 1;
      while (end < sql.length) {
        if (sql[end] !== "'") {
          end += 1;
          continue;
        }
        if (sql[end + 1] === "'") {
          end += 2;
          continue;
        }
        break;
      }
      if (end >= sql.length) {
        throw new Error('Physical Epoch schema contains an unterminated string literal.');
      }
      tokens.push(`string:${sql.slice(offset, end + 1)}`);
      offset = end + 1;
      continue;
    }

    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(remainder)?.[0];
    if (word) {
      tokens.push(`word:${word.toLowerCase()}`);
      offset += word.length;
      continue;
    }
    const number = /^[0-9]+/.exec(remainder)?.[0];
    if (number) {
      tokens.push(`number:${number}`);
      offset += number.length;
      continue;
    }
    const operator = /^(?:>=|<=|!=|=|>|<)/.exec(remainder)?.[0];
    if (operator) {
      tokens.push(`operator:${operator}`);
      offset += operator.length;
      continue;
    }
    if (quote === '(' || quote === ')' || quote === ',') {
      tokens.push(`punctuation:${quote}`);
      offset += 1;
      continue;
    }
    if (quote === ';' && sql.slice(offset + 1).trim().length === 0) {
      offset = sql.length;
      continue;
    }

    throw new Error(`Physical Epoch schema contains an unsupported SQL token at byte ${offset}.`);
  }

  return JSON.stringify(tokens);
}

/** Rejects triggers that a table rebuild would otherwise silently discard. */
function assertNoTriggers(sqlite: Database.Database, tables: readonly string[]): void {
  const placeholders = tables.map(() => '?').join(', ');
  const triggers = sqlite
    .prepare(
      `SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name IN (${placeholders})`
    )
    .all(...tables);
  if (triggers.length > 0) {
    throw new Error('Physical Epoch cutover does not accept predecessor table triggers.');
  }
}

/** Acquires the existing data-root owner for the complete cold conversion. */
function acquireCutoverLock(dataRoot: string): ReturnType<typeof acquireDataRootLock> {
  try {
    return acquireDataRootLock(dataRoot, { bootId: `physical-epoch-cutover-${randomUUID()}` });
  } catch (error) {
    if (error instanceof DataRootLockError) {
      throw new Error(`Refusing to migrate while NanoCore appears to be running: ${error.message}`);
    }
    throw error;
  }
}

/** Inventories persistent predecessor bytes while excluding the converter-owned live lock. */
function inventoryPredecessorFiles(
  dataRoot: string,
  lockPath: string
): RegularFileInventoryEntry[] {
  const resolvedLockPath = resolve(lockPath);
  return inventoryRegularFiles(dataRoot).filter(
    (entry) => resolve(dataRoot, entry.path) !== resolvedLockPath
  );
}

/** Creates a stable backup id from deployment lineage and capture time. */
function createBackupId(deploymentId: string, startedAt: string): string {
  const suffix = createHash('sha256')
    .update(`${deploymentId}\0${startedAt}`)
    .digest('hex')
    .slice(0, 24);
  return `backup_physical_epoch_${suffix}`;
}

/** Compares two stable file inventories exactly. */
function assertInventoriesEqual(
  expected: readonly RegularFileInventoryEntry[],
  actual: readonly RegularFileInventoryEntry[],
  message: string
): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(message);
  }
}

/** Reads one required single-value CLI flag. */
function requireOneFlag(values: string[] | undefined, flag: string): string {
  const candidates = values ?? [];
  if (candidates.length === 0) {
    throw new Error(`Missing required physical Epoch migration flag: ${flag}`);
  }
  if (candidates.length > 1) {
    throw new Error(`Physical Epoch migration flag must be provided once: ${flag}`);
  }
  return candidates[0]!;
}

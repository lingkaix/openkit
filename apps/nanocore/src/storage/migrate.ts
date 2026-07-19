import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BootConfigError } from '../config/mode.js';
import type { CoreDb, UserDb, WorkspaceDb } from './db.js';

/**
 * One committed SQL migration file.
 */
interface MigrationFile {
  /** Stable migration id stored after success. */
  id: string;
  /** SQL file name under the drizzle directory. */
  fileName: string;
}

const migrations: MigrationFile[] = [
  { id: 'core_0000_baseline', fileName: '0000_core_baseline.sql' },
  { id: 'core_0001_workspace_sharing', fileName: '0001_core_workspace_sharing.sql' },
  { id: 'core_0002_scheduler_trigger_actor', fileName: '0002_core_scheduler_trigger_actor.sql' },
  { id: 'core_0003_lifecycle_authority', fileName: '0003_core_lifecycle_authority.sql' },
];

const workspaceMigrations: MigrationFile[] = [
  { id: '0000_baseline', fileName: '0000_workspace_baseline.sql' },
  {
    id: '0001_goal_review_resolution_snapshot',
    fileName: '0001_workspace_goal_review_resolution_snapshot.sql',
  },
  {
    id: '0002_idempotency_requests',
    fileName: '0001_user_0002_workspace_idempotency_requests.sql',
  },
  {
    id: '0003_drop_sync_evidence_bundles',
    fileName: '0003_workspace_drop_sync_evidence_bundles.sql',
  },
  {
    id: '0004_capability_runtime_correlation',
    fileName: '0004_workspace_capability_runtime_correlation.sql',
  },
  {
    id: '0005_material_authority',
    fileName: '0005_workspace_material_authority.sql',
  },
  {
    id: '0006_goal_steering_authority',
    fileName: '0006_workspace_goal_steering_authority.sql',
  },
  {
    id: '0007_artifact_review_authority',
    fileName: '0007_workspace_artifact_review_authority.sql',
  },
  {
    id: '0008_shared_attribution',
    fileName: '0008_workspace_shared_attribution.sql',
  },
  {
    id: '0009_usage_responsible_user',
    fileName: '0009_workspace_usage_responsible_user.sql',
  },
];

const userMigrations: MigrationFile[] = [
  { id: '0000_baseline', fileName: '0000_user_baseline.sql' },
  {
    id: '0001_idempotency_requests',
    fileName: '0001_user_0002_workspace_idempotency_requests.sql',
  },
];

/**
 * Database handle that can read migration metadata.
 */
interface MigrationReadableDb {
  /** Raw SQLite connection. */
  sqlite: CoreDb['sqlite'];
}

type ScopedDb = UserDb | WorkspaceDb;

/**
 * Applies every pending committed migration to a Core database.
 *
 * @param coreDb Open Core database handles.
 * @throws BootConfigError when a migration file is missing or fails to apply.
 */
export function applyMigrations(coreDb: CoreDb): void {
  const appliedIds = readAppliedMigrationIds(coreDb);

  for (const migration of migrations) {
    if (appliedIds.has(migration.id)) {
      continue;
    }

    try {
      coreDb.sqlite.transaction(() => {
        coreDb.sqlite.exec(readMigrationSql(migration));
        coreDb.sqlite
          .prepare('INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)')
          .run(migration.id, new Date().toISOString());
      })();
      appliedIds.add(migration.id);
    } catch (error) {
      throw new BootConfigError(
        'migration_failed',
        `Failed to apply migration ${migration.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

/**
 * Applies pending migrations for one non-server scoped database.
 *
 * @param scopedDb Open user- or workspace-scope database handle.
 * @throws BootConfigError when a scoped migration file is missing or fails to apply.
 */
export function applyScopedMigrations(scopedDb: ScopedDb): void {
  const appliedIds = readAppliedMigrationIds(scopedDb);

  for (const migration of scopedMigrationsFor(scopedDb)) {
    const migrationId = `${scopedDb.scope}_${migration.id}`;

    if (appliedIds.has(migrationId)) {
      continue;
    }

    try {
      scopedDb.sqlite.exec(readMigrationSql(migration));
      scopedDb.sqlite
        .prepare('INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run(migrationId, new Date().toISOString());
      appliedIds.add(migrationId);
    } catch (error) {
      throw new BootConfigError(
        'migration_failed',
        `Failed to apply migration ${migrationId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

/**
 * Lists applied migration ids in stable order.
 *
 * @param coreDb Open Core database handles.
 * @returns Applied migration ids.
 */
export function listAppliedMigrationIds(coreDb: CoreDb): string[] {
  return [...readAppliedMigrationIds(coreDb)].sort();
}

/**
 * Reads the set of migration ids already applied to the database.
 *
 * @param coreDb Open Core database handles.
 * @returns Applied migration ids.
 */
function readAppliedMigrationIds(coreDb: MigrationReadableDb): Set<string> {
  const table = coreDb.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get('schema_migrations');

  if (!table) {
    return new Set();
  }

  const rows = coreDb.sqlite.prepare('SELECT id FROM schema_migrations').all() as Array<{
    id: string;
  }>;

  return new Set(rows.map((row) => row.id));
}

/**
 * Returns the ordered migration list for one scoped database.
 *
 * @param scopedDb Open scoped database handle.
 * @returns Scope-specific migrations.
 */
function scopedMigrationsFor(scopedDb: ScopedDb): readonly MigrationFile[] {
  return scopedDb.scope === 'workspace' ? workspaceMigrations : userMigrations;
}

/**
 * Reads one committed migration SQL file.
 *
 * @param migration Migration metadata.
 * @returns SQL text with Drizzle breakpoints removed.
 * @throws BootConfigError when the migration file cannot be found.
 */
function readMigrationSql(migration: MigrationFile): string {
  const path = findMigrationPath(migration.fileName);

  if (!path) {
    throw new BootConfigError('migration_missing', `Missing migration file ${migration.fileName}.`);
  }

  return readFileSync(path, 'utf8').replaceAll('--> statement-breakpoint', '');
}

/**
 * Finds a migration file from source, app, or built runtime paths.
 *
 * @param fileName Migration file name.
 * @returns Absolute path when found, otherwise undefined.
 */
function findMigrationPath(fileName: string): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), 'apps', 'nanocore', 'drizzle', fileName),
    join(process.cwd(), 'drizzle', fileName),
    join(here, '..', '..', 'drizzle', fileName),
    join(here, '..', 'drizzle', fileName),
  ];

  return candidates.find((path) => existsSync(path));
}

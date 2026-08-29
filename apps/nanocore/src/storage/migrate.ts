import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BootConfigError } from '../config/mode.js';
import type { CoreDb, UserDb, WorkspaceDb } from './db.js';

const SETUP_FILE = '0000_setup.sql';
const SETUP_ID = '0000_setup';
const SETUP_SCOPE_MARKER = '-- openkit:scope ';

type SetupDb = CoreDb | UserDb | WorkspaceDb;

/**
 * Applies the current database setup to a Core database.
 *
 * @param coreDb Open Core database handles.
 * @throws BootConfigError when the setup file is missing or fails to apply.
 */
export function applyMigrations(coreDb: CoreDb): void {
  applyDatabaseSetup(coreDb);
}

/**
 * Applies the current database setup to one User or Workspace database.
 *
 * @param scopedDb Open User or Workspace database.
 * @throws BootConfigError when the setup file is missing or fails to apply.
 */
export function applyScopedMigrations(scopedDb: UserDb | WorkspaceDb): void {
  applyDatabaseSetup(scopedDb);
}

/**
 * Lists applied setup ids in stable order.
 *
 * @param coreDb Open Core database handles.
 * @returns Applied setup ids.
 */
export function listAppliedMigrationIds(coreDb: CoreDb): string[] {
  return [...readAppliedSetupIds(coreDb)].sort();
}

/** Applies the scope-specific section from the single committed setup file. */
function applyDatabaseSetup(database: SetupDb): void {
  const setupId = `${database.scope}_${SETUP_ID}`;
  if (readAppliedSetupIds(database).has(setupId)) {
    return;
  }

  const sql = readSetupSql(database.scope);

  try {
    database.sqlite.transaction(() => {
      database.sqlite.exec(sql);
      database.sqlite
        .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run(setupId, new Date().toISOString());
    })();
  } catch (error) {
    throw new BootConfigError(
      'migration_failed',
      `Failed to apply database setup ${setupId}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Reads applied setup ids from one database when its ledger exists. */
function readAppliedSetupIds(database: SetupDb): Set<string> {
  const table = database.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get('schema_migrations');

  if (!table) {
    return new Set();
  }

  const rows = database.sqlite.prepare('SELECT id FROM schema_migrations').all() as Array<{
    id: string;
  }>;

  return new Set(rows.map((row) => row.id));
}

/** Reads one scope section from the single committed setup file. */
function readSetupSql(scope: SetupDb['scope']): string {
  const path = findSetupPath();

  if (!path) {
    throw new BootConfigError('migration_missing', `Missing database setup file ${SETUP_FILE}.`);
  }

  const setup = readFileSync(path, 'utf8');
  const marker = `${SETUP_SCOPE_MARKER}${scope}`;
  const markerIndex = setup.indexOf(marker);

  if (markerIndex < 0) {
    throw new BootConfigError('migration_missing', `Missing ${scope} section in ${SETUP_FILE}.`);
  }

  const sectionStart = markerIndex + marker.length;
  const nextSection = setup.indexOf(`\n${SETUP_SCOPE_MARKER}`, sectionStart);
  return setup.slice(sectionStart, nextSection < 0 ? undefined : nextSection).trim();
}

/** Finds the database setup file from source, app, or built runtime paths. */
function findSetupPath(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), 'apps', 'nanocore', 'drizzle', SETUP_FILE),
    join(process.cwd(), 'drizzle', SETUP_FILE),
    join(here, '..', '..', 'drizzle', SETUP_FILE),
    join(here, '..', 'drizzle', SETUP_FILE),
  ];

  return candidates.find((path) => existsSync(path));
}

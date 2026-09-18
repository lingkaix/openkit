import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { BootConfigError } from '../config/mode.js';
import type { CoreDb, UserDb, WorkspaceDb } from './db.js';

/** Ownership scope for one native Drizzle journal. */
export type StorageMigrationScope = 'core' | 'user' | 'workspace' | 'app';

/** Database handle that can apply a scoped native journal. */
type SetupDb = {
  readonly scope: StorageMigrationScope;
  readonly sqlite: Database.Database;
};

const NATIVE_LEDGER_TABLE = '__drizzle_migrations';

/**
 * Applies the native Core Drizzle journal.
 *
 * @param coreDb Open Core database handles.
 * @throws BootConfigError when the journal is missing or fails to apply.
 */
export function applyMigrations(coreDb: CoreDb): void {
  applyNativeScopeMigrations(coreDb.sqlite, 'core');
}

/**
 * Applies the native User, Workspace, or App Drizzle journal.
 *
 * @param scopedDb Open User, Workspace, or App database.
 * @throws BootConfigError when the journal is missing or fails to apply.
 */
export function applyScopedMigrations(
  scopedDb: UserDb | WorkspaceDb | { readonly scope: 'app'; readonly sqlite: SetupDb['sqlite'] }
): void {
  applyNativeScopeMigrations(scopedDb.sqlite, scopedDb.scope);
}

/**
 * Applies the app-scope native Drizzle journal.
 *
 * Native migrate opens its own BEGIN/COMMIT. Callers must not invoke this while the
 * connection already has an open transaction.
 *
 * @param sqlite Open app SQLite connection.
 * @throws BootConfigError when the journal is missing or fails to apply.
 */
export function applyAppMigrations(sqlite: SetupDb['sqlite']): void {
  applyNativeScopeMigrations(sqlite, 'app');
}

/**
 * Lists applied Core migration ids as `core_<tag>` names from exact native ledger matches.
 *
 * @param coreDb Open Core database handles.
 * @returns Applied setup ids in stable order.
 */
export function listAppliedMigrationIds(coreDb: CoreDb): string[] {
  return listAppliedNativeMigrationIds(coreDb.sqlite, 'core');
}

/**
 * Applies one scope's native Drizzle Kit journal through better-sqlite3 `migrate`.
 *
 * @param sqlite Open SQLite connection.
 * @param scope Journal scope.
 * @param migrationsFolder Optional explicit journal folder; product paths are discovered when omitted.
 * @throws BootConfigError when the journal or a referenced SQL file is missing, or apply fails.
 */
export function applyNativeScopeMigrations(
  sqlite: Database.Database,
  scope: StorageMigrationScope,
  migrationsFolder = findMigrationsFolder(scope)
): void {
  if (hasSqliteTable(sqlite, 'schema_migrations')) {
    throw new BootConfigError(
      'migration_failed',
      'schema_migrations already exists; refuse native startup apply and handle the predecessor ledger offline.'
    );
  }

  try {
    migrate(drizzle(sqlite), { migrationsFolder });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isMissingNativeSqlError(message)) {
      throw new BootConfigError(
        'migration_missing',
        `Missing ${scope} native Drizzle SQL: ${message}`
      );
    }
    throw new BootConfigError(
      'migration_failed',
      `Failed to apply ${scope} native Drizzle migrations: ${message}`
    );
  }
}

/**
 * Lists applied migration ids as `<scope>_<tag>` for journal entries whose `when`
 * exactly matches a native `__drizzle_migrations.created_at` row.
 *
 * This does not treat every journal entry at or below the maximum ledger timestamp as applied.
 *
 * @param sqlite Open SQLite connection.
 * @param scope Journal scope used as the id prefix.
 * @param migrationsFolder Optional explicit journal folder; product paths are discovered when omitted.
 * @returns Applied ids in stable order.
 */
export function listAppliedNativeMigrationIds(
  sqlite: Database.Database,
  scope: StorageMigrationScope,
  migrationsFolder = findMigrationsFolder(scope)
): string[] {
  const journal = readJournal(migrationsFolder);
  if (!hasSqliteTable(sqlite, NATIVE_LEDGER_TABLE)) {
    return [];
  }

  const appliedWhen = new Set(
    (
      sqlite.prepare(`SELECT created_at FROM ${NATIVE_LEDGER_TABLE}`).all() as Array<{
        created_at: number | string;
      }>
    ).map((row) => Number(row.created_at))
  );

  return journal.entries
    .filter((entry) => appliedWhen.has(entry.when))
    .map((entry) => `${scope}_${entry.tag}`)
    .sort();
}

/** One native Drizzle Kit journal entry. */
interface NativeJournalEntry {
  readonly tag: string;
  readonly when: number;
}

/** Reads one native journal or fails closed on missing or corrupt metadata. */
function readJournal(migrationsFolder: string): { entries: NativeJournalEntry[] } {
  const journalPath = join(migrationsFolder, 'meta', '_journal.json');
  if (!existsSync(journalPath)) {
    throw new BootConfigError(
      'migration_missing',
      `Missing native Drizzle journal ${journalPath}.`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(journalPath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BootConfigError(
      'migration_failed',
      `Corrupt native Drizzle journal ${journalPath}: ${message}`
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('entries' in parsed)) {
    throw new BootConfigError(
      'migration_failed',
      `Corrupt native Drizzle journal ${journalPath}: missing entries.`
    );
  }

  const { entries } = parsed as { entries: unknown };
  if (!Array.isArray(entries)) {
    throw new BootConfigError(
      'migration_failed',
      `Corrupt native Drizzle journal ${journalPath}: missing entries.`
    );
  }

  return {
    entries: entries.map((entry, index) => {
      if (
        !entry ||
        typeof entry !== 'object' ||
        Array.isArray(entry) ||
        typeof (entry as { tag?: unknown }).tag !== 'string' ||
        typeof (entry as { when?: unknown }).when !== 'number'
      ) {
        throw new BootConfigError(
          'migration_failed',
          `Corrupt native Drizzle journal ${journalPath}: malformed entry ${index}.`
        );
      }
      return {
        tag: (entry as { tag: string }).tag,
        when: (entry as { when: number }).when,
      };
    }),
  };
}

/** Returns whether one SQLite table exists. */
function hasSqliteTable(sqlite: Database.Database, name: string): boolean {
  return Boolean(
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  );
}

/** Finds one scope's native journal folder from source, app, or built runtime paths. */
function findMigrationsFolder(scope: StorageMigrationScope): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), 'apps', 'nanocore', 'drizzle', scope),
    join(process.cwd(), 'drizzle', scope),
    join(here, '..', '..', 'drizzle', scope),
    join(here, '..', 'drizzle', scope),
  ];
  const found = candidates.find((path) => existsSync(join(path, 'meta', '_journal.json')));

  if (!found) {
    throw new BootConfigError(
      'migration_missing',
      `Missing ${scope} native Drizzle journal under drizzle/${scope}.`
    );
  }

  return found;
}

/** Returns whether a native migrator error means a journal or SQL file is missing. */
function isMissingNativeSqlError(message: string): boolean {
  return (
    message.includes("Can't find meta/_journal.json file") ||
    /^No file .+ found in .+ folder$/.test(message)
  );
}

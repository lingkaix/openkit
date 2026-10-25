import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { BetterSQLiteSession } from 'drizzle-orm/better-sqlite3';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { BootConfigError } from '../config/mode.js';
import { configureOwnedSqlite } from './control-store.js';
import type { CoreDb, UserDb, WorkspaceDb } from './db.js';
import { applyGoalCutover, removeGoalSandboxPin } from './goal-cutover.js';
import { applyHostRepositoryCutover } from './host-repository-cutover.js';

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
 * @param beforePendingMigration Synchronous recovery copy before pending app DDL.
 * @throws BootConfigError when the journal is missing or fails to apply.
 */
export function applyAppMigrations(
  sqlite: SetupDb['sqlite'],
  beforePendingMigration?: () => void
): void {
  const migrationsFolder = findMigrationsFolder('app');
  const journal = readJournal(migrationsFolder);
  const applied = listAppliedNativeMigrationIds(sqlite, 'app', migrationsFolder);
  if (journal.entries.some((entry) => !applied.includes(`app_${entry.tag}`))) {
    beforePendingMigration?.();
  }
  applyNativeScopeMigrations(sqlite, 'app', migrationsFolder);
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
 * Applies one scope's native Drizzle Kit journal through its synchronous SQLite dialect.
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
  let failure: string | undefined;
  let rollbackCode: string | undefined;
  try {
    if (hasSqliteTable(sqlite, 'schema_migrations')) {
      failure =
        'schema_migrations already exists; refuse native startup apply and handle the predecessor ledger offline.';
      throw new BootConfigError('migration_failed', failure);
    }
    configureOwnedSqlite(sqlite);
    const config = { migrationsFolder };
    const journal = readJournal(migrationsFolder);
    const migrations = readMigrationFiles(config);
    // Use the same latest-row predicate as the native dialect, including sparse ledgers.
    const latest = hasSqliteTable(sqlite, NATIVE_LEDGER_TABLE)
      ? (sqlite
          .prepare(`SELECT created_at FROM ${NATIVE_LEDGER_TABLE} ORDER BY created_at DESC LIMIT 1`)
          .get() as { created_at: number | string } | undefined)
      : undefined;
    const statements = migrations.flatMap((migration, migrationIndex) =>
      !latest || Number(latest.created_at) < migration.folderMillis
        ? migration.sql.map((text, index) => ({
            text,
            tag: journal.entries[migrationIndex]?.tag,
            index: index + 1,
          }))
        : []
    );
    const dialect = new SQLiteSyncDialect();
    const session = new BetterSQLiteSession(sqlite, dialect, undefined);
    const run = session.run.bind(session);
    let statementIndex = 0;
    let started = false;
    // Capture before Drizzle's cleanup can replace the initiating exception. Its
    // native dialect still owns every statement, ledger write and transaction.
    session.run = (query) => {
      const compiled = dialect.sqlToQuery(query);
      const text = compiled.sql;
      const next = statements[statementIndex];
      const statement =
        started && compiled.params.length === 0 && next?.text === text ? next : undefined;
      if (statement) statementIndex += 1;
      try {
        const result = run(query);
        if (!started && text === 'BEGIN') started = true;
        return result;
      } catch (error) {
        if (failure === undefined) {
          const tag = statement?.tag;
          const migration =
            tag && /^[0-9]{4}_[a-z0-9_]{1,96}$/.test(tag) ? `${scope}_${tag}` : 'unavailable';
          failure = `sqlite_code=${migrationSqliteCode(error)}; migration=${migration}; statement_index=${statement?.index ?? 'unavailable'}`;
        } else if (text === 'ROLLBACK') {
          rollbackCode = migrationSqliteCode(error);
        }
        throw error;
      }
    };
    dialect.migrate(migrations, session, config);
    if (scope === 'workspace') {
      applyGoalCutover(sqlite);
      applyHostRepositoryCutover(sqlite);
    }
    if (scope === 'core') removeGoalSandboxPin(sqlite);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (
      (error instanceof BootConfigError && error.code === 'migration_missing') ||
      isMissingNativeSqlError(message)
    ) {
      throw new BootConfigError('migration_missing', `Missing ${scope} native Drizzle SQL.`);
    }
    throw new BootConfigError(
      'migration_failed',
      `Failed to apply ${scope} native Drizzle migrations: ${failure ?? `sqlite_code=${migrationSqliteCode(error)}; migration=unavailable; statement_index=unavailable`}${rollbackCode ? `; rollback_code=${rollbackCode}` : ''}`
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

/** Extracts only a bounded SQLite code, never native SQL, parameters or error text. */
function migrationSqliteCode(error: unknown): string {
  for (let depth = 0; depth < 4 && error && typeof error === 'object'; depth += 1) {
    const { code, cause } = error as { code?: unknown; cause?: unknown };
    if (typeof code === 'string' && /^SQLITE_[A-Z0-9_]{1,60}$/.test(code)) return code;
    error = cause;
  }
  return 'unavailable';
}

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { assertScopeAdmitted, isScopeAdmitted, refuseScope } from '../bootstrap/readiness.js';
import { recoverRunningCapabilityCalls } from '../capability/usage-ledger.js';
import { resolveDataRoot } from '../config/data-root.js';
import { configureOwnedSqlite } from './control-store.js';
import {
  coreDbPath,
  ensureLayout,
  ensureLayoutDirectories,
  ensureUserLayout,
  ensureWorkspaceLayout,
  ensureWorkspaceLayoutRoot,
  readDataRootLayoutMarker,
  userDbPath,
  workspaceDbPath,
} from './fs-layout.js';
import { applyScopedMigrations } from './migrate.js';
import * as schema from './schema/index.js';

/**
 * Open NanoCore SQLite database handles.
 */
export interface CoreDb {
  /** Database ownership scope. */
  scope: 'core';
  /** One-use process-local proof captured before fresh deployment initialization; never inferred from an empty User lookup. */
  canInitializeLocalUser: boolean;
  /** Raw better-sqlite3 connection for low-level migration checks. */
  sqlite: Database.Database;
  /** Drizzle ORM database client bound to the NanoCore schema. */
  db: BetterSQLite3Database<typeof schema>;
  /** Absolute data root that owns the database file. */
  dataRoot: string;
}

/**
 * Open user-scoped SQLite database handle.
 */
export interface UserDb {
  /** Database ownership scope. */
  scope: 'user';
  /** Raw better-sqlite3 connection for user-scope storage. */
  sqlite: Database.Database;
  /** Absolute data root that owns the database file. */
  dataRoot: string;
  /** User id that owns this database. */
  userId: string;
}

/**
 * Open workspace-scoped SQLite database handle.
 */
export interface WorkspaceDb {
  /** Database ownership scope. */
  scope: 'workspace';
  /** Raw better-sqlite3 connection for workspace-scope storage. */
  sqlite: Database.Database;
  /** Drizzle ORM database client bound to the NanoCore schema. */
  db: BetterSQLite3Database<typeof schema>;
  /** Absolute data root that owns the database file. */
  dataRoot: string;
  /** Workspace id that owns this database. */
  workspaceId: string;
}

let singleton: CoreDb | undefined;

/**
 * Opens owned writable authority and reapplies its connection-local durability policy.
 *
 * WAL persists in the file, but FULL synchronization does not. Configure every open before schema allocation and close failed opens locally.
 *
 * @param path Owned database path.
 * @param options Whether the authoritative file must already exist.
 * @returns Configured writable SQLite connection.
 * @throws When the file cannot open or its connection policy cannot be applied.
 */
function openOwnedSqlite(
  path: string,
  options: { fileMustExist?: boolean } = {}
): Database.Database {
  const sqlite = new Database(path, options);
  try {
    configureOwnedSqlite(sqlite);
    return sqlite;
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

/**
 * Opens one server-scope Core database under the provided data root.
 *
 * @param dataRoot Data root that will contain server/db/core.sqlite.
 * @param options Fresh-scope admission captured before boot writes layout metadata.
 * @returns Raw SQLite and Drizzle handles for the database.
 */
export function openCoreDb(
  dataRoot: string,
  options: { readonly freshInitialization?: boolean } = {}
): CoreDb {
  const canInitializeLocalUser =
    !existsSync(coreDbPath(dataRoot)) &&
    (options.freshInitialization ?? isFreshCoreInitializationScope(dataRoot));
  ensureLayoutDirectories(dataRoot);

  const sqlite = openOwnedSqlite(coreDbPath(dataRoot));

  return {
    scope: 'core',
    canInitializeLocalUser,
    sqlite,
    db: drizzle(sqlite, { schema }),
    dataRoot,
  };
}

/**
 * Opens the boot Core database after validating any existing authoritative file.
 *
 * @param dataRoot Data root that will contain server/db/core.sqlite.
 * @param options Fresh-scope admission captured before boot writes layout metadata.
 * @returns Open Core database.
 * @throws When expected authority is missing or the existing database fails SQLite integrity validation.
 */
export function openCoreDbWithIntegrityCheck(
  dataRoot: string,
  options: { readonly freshInitialization?: boolean } = {}
): CoreDb {
  const freshInitialization =
    options.freshInitialization ?? isFreshCoreInitializationScope(dataRoot);
  const path = coreDbPath(dataRoot);
  // SQLite accepts a zero-byte file as new; an established deployment has no such initialization proof.
  if (!freshInitialization && (!existsSync(path) || statSync(path).size === 0)) {
    throw new Error('Core database is missing from an existing deployment.');
  }
  ensureLayout(dataRoot);
  assertSqliteIntegrity(path);
  return openCoreDb(dataRoot, { freshInitialization });
}

/**
 * Opens an existing Core database after validating its authoritative file.
 *
 * @param dataRoot Data root that already contains server/db/core.sqlite.
 * @returns Open Core database.
 * @throws When the authoritative database is missing or fails SQLite integrity validation.
 */
export function openExistingCoreDbWithIntegrityCheck(dataRoot: string): CoreDb {
  readDataRootLayoutMarker(dataRoot);
  const path = coreDbPath(dataRoot);
  assertSqliteIntegrity(path);
  const sqlite = openOwnedSqlite(path, { fileMustExist: true });

  return {
    scope: 'core',
    canInitializeLocalUser: false,
    sqlite,
    db: drizzle(sqlite, { schema }),
    dataRoot,
  };
}

/**
 * Validates and migrates existing user- and workspace-scope databases at boot.
 *
 * @param dataRoot Data root to scan.
 * SQLite keeps its existing journal recovery; migrations and domain recovery wait for file admission.
 * @param validateFileAuthority Boot's file-history barrier, after integrity checks and before domain mutations.
 * Isolated failures refuse only their owning scope; shared layout failures still throw.
 */
export function verifyAndMigrateExistingScopedDatabases(
  dataRoot: string,
  validateFileAuthority?: () => void
): void {
  ensureLayout(dataRoot);
  const scopes = [
    ...listChildDirectories(join(dataRoot, 'users')).map((id) => ({ scope: 'user' as const, id })),
    ...listWorkspaceDirectories(dataRoot).map((id) => ({ scope: 'workspace' as const, id })),
  ];
  for (const { scope, id } of scopes) {
    if (!isScopeAdmitted(dataRoot, scope, id)) continue;
    try {
      const path = scope === 'workspace' ? workspaceDbPath(dataRoot, id) : userDbPath(dataRoot, id);
      if (scope === 'workspace' && (!existsSync(path) || statSync(path).size === 0))
        throw new Error('Expected Workspace database is missing or uninitialized.');
      assertSqliteIntegrity(path);
    } catch {
      refuseScope(dataRoot, { scope, id, check: 'database' });
    }
  }
  // Boot must not migrate or recover a scope whose canonical file authority is unreadable.
  validateFileAuthority?.();
  for (const { scope, id } of scopes) {
    if (!isScopeAdmitted(dataRoot, scope, id)) continue;
    try {
      if (scope === 'workspace') migrateWorkspaceDatabase(dataRoot, id);
      else migrateUserDatabase(dataRoot, id);
    } catch {
      refuseScope(dataRoot, { scope, id, check: 'database' });
    }
  }
}

/**
 * Lists admitted existing Workspace scopes for ordinary scans, excluding staging and boot quarantine.
 *
 * @param dataRoot Data root whose existing workspace directories should be scanned.
 * @returns Workspace ids for every existing workspace scope.
 * @throws When a required layout directory or marker is unsafe or incompatible.
 */
export function listExistingWorkspaceDatabaseScopes(
  dataRoot: string
): Array<{ readonly workspaceId: string }> {
  ensureLayoutDirectories(dataRoot);
  return listWorkspaceDirectories(dataRoot)
    .filter((workspaceId) => isScopeAdmitted(dataRoot, 'workspace', workspaceId))
    .map((workspaceId) => ({ workspaceId }));
}

/**
 * Opens one user-scope database under the provided data root.
 *
 * @param dataRoot Data root that contains the user tree.
 * @param userId User id that owns the database.
 * @returns Raw SQLite handle for the user-scope database.
 */
export function openUserDb(dataRoot: string, userId: string): UserDb {
  ensureUserLayout(dataRoot, userId);

  const sqlite = openOwnedSqlite(userDbPath(dataRoot, userId));

  return { scope: 'user', sqlite, dataRoot, userId };
}

/**
 * Opens one workspace-scope database under the provided data root.
 *
 * @param dataRoot Data root that contains the workspace tree.
 * @param workspaceId Workspace id that owns the database.
 * @returns Raw SQLite handle for the workspace-scope database.
 */
export function openWorkspaceDb(dataRoot: string, workspaceId: string): WorkspaceDb {
  ensureWorkspaceLayout(dataRoot, workspaceId);

  const sqlite = openOwnedSqlite(workspaceDbPath(dataRoot, workspaceId));

  return {
    scope: 'workspace',
    sqlite,
    db: drizzle(sqlite, { schema }),
    dataRoot,
    workspaceId,
  };
}

/** Opens an existing Workspace database after the current boot already verified its layout. */
export function openBootVerifiedWorkspaceDb(dataRoot: string, workspaceId: string): WorkspaceDb {
  assertScopeAdmitted(dataRoot, 'workspace', workspaceId);
  const sqlite = openOwnedSqlite(workspaceDbPath(dataRoot, workspaceId), { fileMustExist: true });

  return {
    scope: 'workspace',
    sqlite,
    db: drizzle(sqlite, { schema }),
    dataRoot,
    workspaceId,
  };
}

/**
 * Opens one workspace-scope database under an already resolved workspace root.
 *
 * @param input Data root, Workspace id, and resolved workspace root.
 * @returns Raw SQLite and Drizzle handles for the staged workspace database.
 */
export function openWorkspaceDbAtRoot(input: {
  dataRoot: string;
  workspaceId: string;
  workspaceRoot: string;
}): WorkspaceDb {
  ensureWorkspaceLayoutRoot(input.workspaceRoot);

  const sqlite = openOwnedSqlite(join(input.workspaceRoot, 'db', 'workspace.sqlite'));

  return {
    scope: 'workspace',
    sqlite,
    db: drizzle(sqlite, { schema }),
    dataRoot: input.dataRoot,
    workspaceId: input.workspaceId,
  };
}

/**
 * Returns the process singleton Core database.
 *
 * @param env Environment variables used to resolve the data root.
 * @returns Singleton raw SQLite and Drizzle handles.
 */
export function getCoreDb(env: NodeJS.ProcessEnv = process.env): CoreDb {
  if (!singleton) {
    singleton = openCoreDb(resolveDataRoot(env));
  }

  return singleton;
}

/**
 * Applies user-scope migrations after integrity and boot file-authority admission.
 *
 * @param dataRoot Data root that owns the database.
 * @param userId User id that owns the database.
 * @throws When the existing authoritative database fails SQLite integrity validation.
 */
function migrateUserDatabase(dataRoot: string, userId: string): void {
  const userDb = openUserDb(dataRoot, userId);

  try {
    applyScopedMigrations(userDb);
  } finally {
    userDb.sqlite.close();
  }
}

/**
 * Applies Workspace migrations and call-loss recovery only after both authority checks.
 *
 * @param dataRoot Data root that owns the database.
 * @param workspaceId Workspace id that owns the database.
 * @throws When the authoritative Workspace database is missing or fails SQLite integrity validation.
 */
function migrateWorkspaceDatabase(dataRoot: string, workspaceId: string): void {
  const workspaceDb = openBootVerifiedWorkspaceDb(dataRoot, workspaceId);

  try {
    applyScopedMigrations(workspaceDb);
    recoverRunningCapabilityCalls({ workspaceDb });
  } finally {
    workspaceDb.sqlite.close();
  }
}

/**
 * Fails closed when an existing authoritative SQLite database is corrupt.
 *
 * @param path SQLite database path.
 * @throws When SQLite cannot open or validate the existing file.
 */
function assertSqliteIntegrity(path: string): void {
  if (!existsSync(path)) {
    return;
  }

  const integrity = checkSqliteIntegrity(path);
  if (integrity.ok) {
    return;
  }

  throw new Error(`SQLite integrity check failed for ${path}: ${integrity.detail}`);
}

/**
 * Lists Workspace directories without admitting the unpublished staging container as a scope.
 *
 * @param dataRoot Data root whose Workspace tree should be scanned.
 * @returns Workspace directory names in stable order, including scopes with missing databases.
 */
function listWorkspaceDirectories(dataRoot: string): string[] {
  return listChildDirectories(join(dataRoot, 'workspaces')).filter((name) => name !== '.staging');
}

/**
 * Lists direct child directory names in stable order.
 *
 * @param path Parent path.
 * @returns Child directory names.
 */
function listChildDirectories(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }

  return readdirSync(path)
    .filter((name) => statSync(join(path, name)).isDirectory())
    .sort();
}

/**
 * Runs SQLite's cheap integrity check against one database file.
 *
 * @param path SQLite database path.
 * @returns Integrity check result.
 */
function checkSqliteIntegrity(path: string): { ok: true } | { ok: false; detail: string } {
  let sqlite: Database.Database | undefined;

  try {
    sqlite = new Database(path, { fileMustExist: true });
    const result = sqlite.prepare('PRAGMA quick_check').pluck().get();

    return result === 'ok' ? { ok: true } : { ok: false, detail: String(result) };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    sqlite?.close();
  }
}

/**
 * Proves a fresh owned deployment before layout creation. Existing markers, databases or owned data
 * exclude first User allocation even if an initialized User table is later empty.
 */
export function isFreshCoreInitializationScope(dataRoot: string): boolean {
  if (existsSync(coreDbPath(dataRoot)) || existsSync(join(dataRoot, 'server', 'layout.json')))
    return false;
  return ['server', 'users', 'workspaces', 'local', 'logs'].every((name) => {
    const path = join(dataRoot, name);
    return !existsSync(path) || readdirSync(path).length === 0;
  });
}

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { recoverRunningCapabilityCalls } from '../capability/usage-ledger.js';
import { resolveDataRoot } from '../config/data-root.js';
import {
  coreDbPath,
  ensureLayout,
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
 * Opens one server-scope Core database under the provided data root.
 *
 * @param dataRoot Data root that will contain server/db/core.sqlite.
 * @returns Raw SQLite and Drizzle handles for the database.
 */
export function openCoreDb(dataRoot: string): CoreDb {
  ensureLayout(dataRoot);

  const sqlite = new Database(coreDbPath(dataRoot));

  return {
    scope: 'core',
    sqlite,
    db: drizzle(sqlite, { schema }),
    dataRoot,
  };
}

/**
 * Opens the boot Core database after validating any existing authoritative file.
 *
 * @param dataRoot Data root that will contain server/db/core.sqlite.
 * @returns Open Core database.
 * @throws When the existing authoritative database fails SQLite integrity validation.
 */
export function openCoreDbWithIntegrityCheck(dataRoot: string): CoreDb {
  ensureLayout(dataRoot);
  assertSqliteIntegrity(coreDbPath(dataRoot));
  return openCoreDb(dataRoot);
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
  const sqlite = new Database(path, { fileMustExist: true });

  return {
    scope: 'core',
    sqlite,
    db: drizzle(sqlite, { schema }),
    dataRoot,
  };
}

/**
 * Validates and migrates existing user- and workspace-scope databases at boot.
 *
 * @param dataRoot Data root to scan.
 * @throws When any existing authoritative database fails SQLite integrity validation.
 */
export function verifyAndMigrateExistingScopedDatabases(dataRoot: string): void {
  ensureLayout(dataRoot);

  const usersRoot = join(dataRoot, 'users');

  for (const userId of listChildDirectories(usersRoot)) {
    verifyAndMigrateUserDatabase(dataRoot, userId);
  }

  for (const workspaceId of listChildDirectories(join(dataRoot, 'workspaces'))) {
    verifyAndMigrateWorkspaceDatabase(dataRoot, workspaceId);
  }
}

/**
 * Lists existing workspace database scopes in stable boot order.
 *
 * @param dataRoot Data root whose existing workspace directories should be scanned.
 * @returns Workspace ids for every existing workspace scope.
 * @throws When the data root is not a valid owner-independent layout.
 */
export function listExistingWorkspaceDatabaseScopes(
  dataRoot: string
): Array<{ readonly workspaceId: string }> {
  ensureLayout(dataRoot);
  return listChildDirectories(join(dataRoot, 'workspaces')).map((workspaceId) => ({ workspaceId }));
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

  const sqlite = new Database(userDbPath(dataRoot, userId));

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

  const sqlite = new Database(workspaceDbPath(dataRoot, workspaceId));

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
  const sqlite = new Database(workspaceDbPath(dataRoot, workspaceId), { fileMustExist: true });

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

  const sqlite = new Database(join(input.workspaceRoot, 'db', 'workspace.sqlite'));

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
 * Validates one user database and applies user-scope migrations.
 *
 * @param dataRoot Data root that owns the database.
 * @param userId User id that owns the database.
 * @throws When the existing authoritative database fails SQLite integrity validation.
 */
function verifyAndMigrateUserDatabase(dataRoot: string, userId: string): void {
  assertSqliteIntegrity(userDbPath(dataRoot, userId));
  const userDb = openUserDb(dataRoot, userId);

  try {
    applyScopedMigrations(userDb);
  } finally {
    userDb.sqlite.close();
  }
}

/**
 * Validates one workspace database and applies workspace-scope migrations.
 *
 * @param dataRoot Data root that owns the database.
 * @param workspaceId Workspace id that owns the database.
 * @throws When the existing authoritative database fails SQLite integrity validation.
 */
function verifyAndMigrateWorkspaceDatabase(dataRoot: string, workspaceId: string): void {
  assertSqliteIntegrity(workspaceDbPath(dataRoot, workspaceId));
  const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);

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

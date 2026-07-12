import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
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
  userDbPath,
  workspaceDbPath,
} from './fs-layout.js';
import { applyScopedMigrations } from './migrate.js';
import * as schema from './schema/index.js';

/**
 * Open NanoCore SQLite database handles.
 */
export interface CoreDb {
  /** Raw better-sqlite3 connection for low-level migration checks. */
  sqlite: Database.Database;
  /** Drizzle ORM database client bound to the NanoCore schema. */
  db: BetterSQLite3Database<typeof schema>;
  /** Absolute data root that owns the database file. */
  dataRoot: string;
}

/** SQLite source-of-truth recovery event produced before opening a boot database. */
export interface DatabaseIntegrityRecoveryEvent {
  /** Ownership scope that owns the recovered database. */
  scope: 'server' | 'user' | 'workspace';
  /** User id for user- or workspace-scoped recovery. */
  userId?: string;
  /** Workspace id for workspace-scoped recovery. */
  workspaceId?: string;
  /** Original database path that failed integrity validation. */
  originalPath: string;
  /** Quarantine path that now preserves the original database file. */
  quarantinePath: string;
  /** SHA-256 digest of the quarantined database file before it moved. */
  contentDigest: string;
  /** Machine-readable recovery reason. */
  reason: 'database_integrity_check_failed';
  /** Human-readable integrity failure detail. */
  detail: string;
}

/** Result of opening the boot Core database with integrity recovery. */
export interface OpenCoreDbWithIntegrityRecoveryResult {
  /** Open Core database handles after any recovery. */
  coreDb: CoreDb;
  /** Recovery events produced before the returned database was opened. */
  recoveryEvents: DatabaseIntegrityRecoveryEvent[];
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
  /** User id that owns the workspace. */
  userId: string;
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
    sqlite,
    db: drizzle(sqlite, { schema }),
    dataRoot,
  };
}

/**
 * Opens the boot Core database after quarantining a corrupt source-of-truth file.
 *
 * @param dataRoot Data root that will contain server/db/core.sqlite.
 * @returns Open Core database and any recovery events.
 */
export function openCoreDbWithIntegrityRecovery(
  dataRoot: string
): OpenCoreDbWithIntegrityRecoveryResult {
  ensureLayout(dataRoot);

  const path = coreDbPath(dataRoot);
  const recoveryEvents = recoverCorruptDatabase({
    path,
    quarantineDir: join(dataRoot, 'server', 'quarantine'),
    scope: 'server',
  });

  return {
    coreDb: openCoreDb(dataRoot),
    recoveryEvents,
  };
}

/**
 * Recovers and migrates existing user- and workspace-scope databases at boot.
 *
 * @param dataRoot Data root to scan.
 * @returns Recovery events produced before scoped databases were migrated.
 */
export function recoverExistingScopedDatabases(dataRoot: string): DatabaseIntegrityRecoveryEvent[] {
  ensureLayout(dataRoot);

  const recoveryEvents: DatabaseIntegrityRecoveryEvent[] = [];
  const usersRoot = join(dataRoot, 'users');

  for (const userId of listChildDirectories(usersRoot)) {
    recoveryEvents.push(...recoverAndMigrateUserDatabase(dataRoot, userId));

    const workspacesRoot = join(dataRoot, 'users', userId, 'workspaces');
    for (const workspaceId of listChildDirectories(workspacesRoot)) {
      recoveryEvents.push(...recoverAndMigrateWorkspaceDatabase(dataRoot, userId, workspaceId));
    }
  }

  return recoveryEvents;
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
 * @param userId User id that owns the workspace.
 * @param workspaceId Workspace id that owns the database.
 * @returns Raw SQLite handle for the workspace-scope database.
 */
export function openWorkspaceDb(
  dataRoot: string,
  userId: string,
  workspaceId: string
): WorkspaceDb {
  ensureWorkspaceLayout(dataRoot, userId, workspaceId);

  const sqlite = new Database(workspaceDbPath(dataRoot, userId, workspaceId));

  return {
    scope: 'workspace',
    sqlite,
    db: drizzle(sqlite, { schema }),
    dataRoot,
    userId,
    workspaceId,
  };
}

/**
 * Opens one workspace-scope database under an already resolved workspace root.
 *
 * @param input Data root, owner ids, and resolved workspace root.
 * @returns Raw SQLite and Drizzle handles for the staged workspace database.
 */
export function openWorkspaceDbAtRoot(input: {
  dataRoot: string;
  userId: string;
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
    userId: input.userId,
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
 * Recovers one user database and applies user-scope migrations.
 *
 * @param dataRoot Data root that owns the database.
 * @param userId User id that owns the database.
 * @returns Recovery events produced for the file.
 */
function recoverAndMigrateUserDatabase(
  dataRoot: string,
  userId: string
): DatabaseIntegrityRecoveryEvent[] {
  const recoveryEvents = recoverCorruptDatabase({
    path: userDbPath(dataRoot, userId),
    quarantineDir: join(dataRoot, 'users', userId, 'quarantine'),
    scope: 'user',
    userId,
  });
  const userDb = openUserDb(dataRoot, userId);

  try {
    applyScopedMigrations(userDb);
  } finally {
    userDb.sqlite.close();
  }

  return recoveryEvents;
}

/**
 * Recovers one workspace database and applies workspace-scope migrations.
 *
 * @param dataRoot Data root that owns the database.
 * @param userId User id that owns the workspace.
 * @param workspaceId Workspace id that owns the database.
 * @returns Recovery events produced for the file.
 */
function recoverAndMigrateWorkspaceDatabase(
  dataRoot: string,
  userId: string,
  workspaceId: string
): DatabaseIntegrityRecoveryEvent[] {
  const recoveryEvents = recoverCorruptDatabase({
    path: workspaceDbPath(dataRoot, userId, workspaceId),
    quarantineDir: join(dataRoot, 'users', userId, 'workspaces', workspaceId, 'quarantine'),
    scope: 'workspace',
    userId,
    workspaceId,
  });
  const workspaceDb = openWorkspaceDb(dataRoot, userId, workspaceId);

  try {
    applyScopedMigrations(workspaceDb);
    recoverRunningCapabilityCalls({ workspaceDb });
  } finally {
    workspaceDb.sqlite.close();
  }

  return recoveryEvents;
}

/**
 * Quarantines a corrupt SQLite database file.
 *
 * @param input Recovery target.
 * @returns Recovery events produced for the file.
 */
function recoverCorruptDatabase(input: {
  path: string;
  quarantineDir: string;
  scope: DatabaseIntegrityRecoveryEvent['scope'];
  userId?: string;
  workspaceId?: string;
}): DatabaseIntegrityRecoveryEvent[] {
  if (!existsSync(input.path)) {
    return [];
  }

  const integrity = checkSqliteIntegrity(input.path);
  if (integrity.ok) {
    return [];
  }

  mkdirSync(input.quarantineDir, { recursive: true });
  const quarantinePath = join(
    input.quarantineDir,
    `${Date.now()}-${process.pid}-${basename(input.path)}`
  );
  const contentDigest = sha256File(input.path);
  renameSync(input.path, quarantinePath);

  return [
    {
      scope: input.scope,
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      originalPath: input.path,
      quarantinePath,
      contentDigest,
      reason: 'database_integrity_check_failed',
      detail: integrity.detail,
    },
  ];
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
    sqlite = new Database(path, { readonly: true, fileMustExist: true });
    const result = sqlite.prepare('PRAGMA quick_check').pluck().get();

    return result === 'ok' ? { ok: true } : { ok: false, detail: String(result) };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    sqlite?.close();
  }
}

/**
 * Computes a SHA-256 digest for one file.
 *
 * @param path File path.
 * @returns Hex encoded SHA-256 digest.
 */
function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

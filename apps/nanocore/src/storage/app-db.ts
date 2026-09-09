import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

import { KernelCommandError } from '../generative-kernel/errors.js';
import { resolveDataRootPath } from './fs-layout.js';
import { applyAppMigrations } from './migrate.js';

/** Open app-scoped SQLite handle collocating Kernel data, receipts, and audit. */
export interface AppDb {
  /** Database ownership scope. */
  scope: 'app';
  /** Raw better-sqlite3 connection. */
  sqlite: Database.Database;
  /** Absolute data root that owns the database file. */
  dataRoot: string;
  /** Workspace that owns the app. */
  workspaceId: string;
  /** Light App identity. */
  appId: string;
}

const APP_BUSY_TIMEOUT_MS = 1000;

/**
 * Resolves one Light App SQLite path.
 *
 * @param dataRoot Data root.
 * @param workspaceId Workspace id.
 * @param appId App UUID.
 * @returns Absolute database path.
 */
export function lightAppDbPath(dataRoot: string, workspaceId: string, appId: string): string {
  return join(lightAppRoot(dataRoot, workspaceId, appId), 'data.sqlite');
}

/**
 * Resolves one Light App directory.
 *
 * @param dataRoot Data root.
 * @param workspaceId Workspace id.
 * @param appId App UUID.
 * @returns Absolute app directory.
 */
export function lightAppRoot(dataRoot: string, workspaceId: string, appId: string): string {
  return resolveDataRootPath(dataRoot, 'workspaces', workspaceId, 'light-apps', appId);
}

/**
 * Resolves the Workspace Light App inventory directory.
 *
 * @param dataRoot Data root.
 * @param workspaceId Workspace id.
 * @returns Absolute inventory directory.
 */
export function lightAppsRoot(dataRoot: string, workspaceId: string): string {
  return resolveDataRootPath(dataRoot, 'workspaces', workspaceId, 'light-apps');
}

/**
 * Opens an existing app database after integrity and identity checks. Does not create files.
 *
 * @param dataRoot Data root.
 * @param workspaceId Workspace id.
 * @param appId App UUID.
 * @returns Open app database.
 */
export function openExistingAppDb(dataRoot: string, workspaceId: string, appId: string): AppDb {
  const path = lightAppDbPath(dataRoot, workspaceId, appId);
  assertNotSymlink(path);
  if (!existsSync(path)) {
    throw new KernelCommandError('unavailable', 'App authority is missing.');
  }
  assertSqliteIntegrity(path);
  const sqlite = openSqlite(path, true);
  applyAppPragmas(sqlite);
  const db: AppDb = { scope: 'app', sqlite, dataRoot, workspaceId, appId };
  try {
    applyAppMigrations(db.sqlite);
    assertAppIdentity(db);
    assertDefinitionMatches(db);
    return db;
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

/**
 * Creates a new app database after the app directory exists.
 *
 * @param dataRoot Data root.
 * @param workspaceId Workspace id.
 * @param appId App UUID.
 * @returns Open app database.
 */
export function createAppDb(dataRoot: string, workspaceId: string, appId: string): AppDb {
  const path = lightAppDbPath(dataRoot, workspaceId, appId);
  if (existsSync(path)) {
    throw new KernelCommandError(
      'recovery_required',
      'Interrupted app creation cannot be replayed.'
    );
  }
  const sqlite = openSqlite(path, false);
  applyAppPragmas(sqlite);
  const db: AppDb = { scope: 'app', sqlite, dataRoot, workspaceId, appId };
  applyAppMigrations(db.sqlite);
  return db;
}

/**
 * Durably writes one UTF-8 file and fsyncs the file plus its directory.
 *
 * @param path Destination path.
 * @param contents Exact UTF-8 bytes.
 */
export function writeDurableFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'wx');
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const directoryFd = openSync(dirname(path), 'r');
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}

/**
 * Maps SQLite busy failures to the Kernel unavailable contract.
 *
 * @param error Caught error.
 * @returns True when the error is retryable SQLite busy.
 */
export function isSqliteBusy(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'SQLITE_BUSY'
  );
}

/**
 * Opens a SQLite connection with the Kernel busy bound.
 *
 * @param path Database path.
 * @param fileMustExist Whether the file must already exist.
 * @returns Open connection.
 */
function openSqlite(path: string, fileMustExist: boolean): Database.Database {
  try {
    return new Database(path, { fileMustExist, timeout: APP_BUSY_TIMEOUT_MS });
  } catch (error) {
    if (isSqliteBusy(error)) {
      throw new KernelCommandError('unavailable', 'App database is busy.', {
        status: 503,
      });
    }
    throw error;
  }
}

/**
 * Applies Kernel SQLite durability and isolation pragmas.
 *
 * @param sqlite Open connection.
 */
function applyAppPragmas(sqlite: Database.Database): void {
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = FULL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma(`busy_timeout = ${APP_BUSY_TIMEOUT_MS}`);
}

/**
 * Verifies the open database belongs to the requested app and Workspace.
 *
 * @param db Open app database.
 */
function assertAppIdentity(db: AppDb): void {
  const row = db.sqlite
    .prepare('SELECT app_id AS appId, workspace_id AS workspaceId FROM app_metadata LIMIT 1')
    .get() as { appId: string; workspaceId: string } | undefined;
  if (!row) {
    throw new KernelCommandError('unavailable', 'App authority is incomplete.');
  }
  if (row.appId !== db.appId || row.workspaceId !== db.workspaceId) {
    throw new KernelCommandError('unavailable', 'App identity does not match its storage.');
  }
}

function assertDefinitionMatches(db: AppDb): void {
  const row = db.sqlite
    .prepare('SELECT schema_digest AS schemaDigest FROM app_metadata LIMIT 1')
    .get() as { schemaDigest: string } | undefined;
  if (!row?.schemaDigest?.startsWith('sha256:')) {
    throw new KernelCommandError('unavailable', 'App authority is incomplete.');
  }
  const definitionPath = join(
    lightAppRoot(db.dataRoot, db.workspaceId, db.appId),
    'definitions',
    `${row.schemaDigest.slice('sha256:'.length)}.json`
  );
  assertNotSymlink(definitionPath);
  if (!existsSync(definitionPath)) {
    throw new KernelCommandError('unavailable', 'App definition bytes are missing.');
  }
  const bytes = readFileSync(definitionPath);
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (digest !== row.schemaDigest) {
    throw new KernelCommandError('unavailable', 'App definition digest does not match.');
  }
}

/**
 * Rejects a symbolic-link database path.
 *
 * @param path Candidate path.
 */
function assertNotSymlink(path: string): void {
  const metadata = lstatSync(path, { throwIfNoEntry: false });
  if (metadata?.isSymbolicLink()) {
    throw new KernelCommandError('unavailable', 'App database must not be a symbolic link.');
  }
}

/**
 * Fails closed when an existing authoritative SQLite database is corrupt.
 *
 * @param path SQLite database path.
 */
function assertSqliteIntegrity(path: string): void {
  let sqlite: Database.Database | undefined;
  try {
    sqlite = new Database(path, { fileMustExist: true });
    const result = sqlite.prepare('PRAGMA quick_check').pluck().get();
    if (result !== 'ok') {
      throw new KernelCommandError('unavailable', 'App database failed integrity check.');
    }
  } catch (error) {
    if (error instanceof KernelCommandError) {
      throw error;
    }
    throw new KernelCommandError('unavailable', 'App database failed integrity check.');
  } finally {
    sqlite?.close();
  }
}

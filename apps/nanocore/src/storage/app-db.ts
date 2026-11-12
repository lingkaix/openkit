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
import { LIGHT_APP_KERNEL_FORMAT_VERSION } from '@openkit/app-api-schemas';
import Database from 'better-sqlite3';

import { BootConfigError } from '../config/mode.js';
import { KernelCommandError } from '../generative-kernel/errors.js';
import { ownMainScopeReadHandle } from './control-store-product-records.js';
import { resolveDataRootPath } from './fs-layout.js';
import { assertSupportedNativeLedger } from './migrate.js';

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

const APP_BUSY_TIMEOUT_MS = 1000;

/**
 * Opens an existing app database after integrity and identity checks. Does not create files.
 *
 * @param dataRoot Data root.
 * @param workspaceId Workspace id.
 * @param appId App UUID.
 * @param admission Current-format reads or explicit native migration admission.
 * @returns Open app database.
 */
export function openExistingAppDb(
  dataRoot: string,
  workspaceId: string,
  appId: string,
  admission: 'current' | 'format-upgrade' = 'current'
): AppDb {
  const path = lightAppDbPath(dataRoot, workspaceId, appId);
  assertNotSymlink(path);
  if (!existsSync(path)) {
    throw new KernelCommandError('unavailable', 'App authority is missing.');
  }
  const sqlite = openAppDbReadOnly(path);
  const db: AppDb = { scope: 'app', sqlite, dataRoot, workspaceId, appId };
  try {
    assertAppAuthority(db, admission === 'format-upgrade');
    return db;
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

/**
 * Durably writes exact UTF-8 or binary bytes and fsyncs the file plus its directory.
 *
 * @param path Destination path.
 * @param contents Exact UTF-8 text or binary bytes.
 */
export function writeDurableFile(path: string, contents: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'wx');
  try {
    const bytes = typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents;
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    }
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

/** Verifies retained definition bytes against the selected app authority. */
export function assertAppDefinitionMatches(db: AppDb): void {
  const row = db.sqlite
    .prepare('SELECT schema_digest AS schemaDigest FROM app_metadata LIMIT 1')
    .get() as { schemaDigest: string } | undefined;
  assertAppDefinitionDigestMatches(db, row?.schemaDigest);
}

/** Rechecks exact retained definition authority without reopening or retaining a SQLite handle. */
export function assertAppDefinitionDigestMatches(
  db: Pick<AppDb, 'dataRoot' | 'workspaceId' | 'appId'>,
  schemaDigest: string | undefined
): void {
  if (!schemaDigest?.startsWith('sha256:')) {
    throw new KernelCommandError('unavailable', 'App authority is incomplete.');
  }
  const definitionPath = join(
    lightAppRoot(db.dataRoot, db.workspaceId, db.appId),
    'definitions',
    `${schemaDigest.slice('sha256:'.length)}.json`
  );
  assertNotSymlink(definitionPath);
  if (!existsSync(definitionPath)) {
    throw new KernelCommandError('unavailable', 'App definition bytes are missing.');
  }
  const bytes = readFileSync(definitionPath);
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (digest !== schemaDigest) {
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
 * Opens one existing App or rollback-candidate database for read-only verification.
 * The caller retains path, lineage, and lifecycle admission.
 *
 * @param path Existing SQLite path.
 * @returns Read-only connection after the bounded integrity check.
 */
export function openAppDbReadOnly(path: string): Database.Database {
  let sqlite: Database.Database | undefined;
  try {
    sqlite = new Database(path, {
      readonly: true,
      fileMustExist: true,
      timeout: APP_BUSY_TIMEOUT_MS,
    });
    assertSupportedNativeLedger(sqlite, 'app');
    sqlite.pragma('query_only = ON');
    const result = sqlite.prepare('PRAGMA quick_check').pluck().get();
    if (result !== 'ok') {
      throw new KernelCommandError('unavailable', 'App database failed integrity check.');
    }
    return ownMainScopeReadHandle(sqlite);
  } catch (error) {
    sqlite?.close();
    if (error instanceof KernelCommandError || error instanceof BootConfigError) {
      throw error;
    }
    throw new KernelCommandError('unavailable', 'App database failed integrity check.');
  }
}

/** Refuses unknown app formats before applying any pending native migration. */
function assertKnownKernelFormat(db: AppDb, permitMigrationBase = false): void {
  const columns = db.sqlite.pragma('table_info(app_metadata)') as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'kernel_format_version')) {
    if (permitMigrationBase) return;
    throw new KernelCommandError('unavailable', 'App kernel format requires an explicit upgrade.');
  }
  const version = db.sqlite
    .prepare('SELECT kernel_format_version FROM app_metadata LIMIT 1')
    .pluck()
    .get();
  if (version !== LIGHT_APP_KERNEL_FORMAT_VERSION) {
    throw new KernelCommandError('unavailable', 'App kernel format is unsupported.');
  }
}

/** Rechecks existing physical App authority without opening another connection or running migration. */
export function assertAppAuthority(db: AppDb, permitMigrationBase = false): void {
  assertAppIdentity(db);
  assertAppDefinitionMatches(db);
  assertKnownKernelFormat(db, permitMigrationBase);
}

import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { isEntityId } from '@openkit/protocol';
import {
  assertCanonicalDirectory,
  copyFileForCut,
  createPrivateTree,
  readLayoutDirectory,
  removePrivateTree,
  replaceExistingFileText,
} from '@openkit/storage';
import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { type DataRootLock, retainDataRootLock } from '../bootstrap/lock.js';
import { assertScopeAdmitted, isScopeAdmitted } from '../bootstrap/readiness.js';
import { resolveDataRoot } from '../config/data-root.js';
import { BootConfigError } from '../config/mode.js';
import { configureOwnedSqlite } from './control-store.js';
import {
  openControlStoreProductReadHandle,
  ownMainScopeReadHandle,
} from './control-store-product-records.js';
import {
  coreDbPath,
  type DataRootLayoutMarker,
  ensureLayout,
  ensureLayoutDirectories,
  ensureUserLayout,
  ensureWorkspaceLayout,
  ensureWorkspaceLayoutRoot,
  readDataRootLayoutMarker,
  resolveDataRootPath,
  userDbPath,
  workspaceDbPath,
} from './fs-layout.js';
import {
  assertCurrentCoreBaseline,
  assertCurrentServerOwnerSchema,
  assertSupportedNativeLedger,
  ServerOwnerAdmissionError,
  SPLIT_STORAGE_JOURNALS,
  type SplitStorageOwner,
  type StorageMigrationScope,
} from './migrate.js';
import * as schema from './schema/index.js';

/** Resolves an installed Server owner to its canonical SQLite path. */
export function serverStoragePath(
  dataRoot: string,
  owner: 'control-kernel' | SplitStorageOwner
): string {
  return owner === 'control-kernel'
    ? coreDbPath(dataRoot)
    : resolveDataRootPath(dataRoot, 'server', SPLIT_STORAGE_JOURNALS[owner], 'state.sqlite');
}

/** Inspects a Server owner path without creating it or following owner-directory/file aliases. */
export async function inspectServerOwnerFile(
  dataRoot: string,
  owner: 'control-kernel' | SplitStorageOwner
) {
  const path = serverStoragePath(dataRoot, owner);
  let directory = dataRoot;
  for (const part of relative(dataRoot, dirname(path)).split(sep)) {
    directory = join(directory, part);
    const metadata = await serverOwnerMetadata(directory);
    if (!metadata) return undefined;
    if (!metadata.isDirectory()) throw new ServerOwnerAdmissionError('unsupported');
  }
  const file = await serverOwnerMetadata(path);
  if (file && (!file.isFile() || file.nlink !== 1))
    throw new ServerOwnerAdmissionError('unsupported');
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = await serverOwnerMetadata(`${path}${suffix}`);
    if (sidecar && (!sidecar.isFile() || sidecar.nlink !== 1))
      throw new ServerOwnerAdmissionError('unsupported');
    if (sidecar && !file) throw new ServerOwnerAdmissionError('recovery-required');
  }
  if (file?.size === 0) throw new ServerOwnerAdmissionError('corrupt');
  return file;
}

/** Returns absent only for a missing filesystem entry. */
async function serverOwnerMetadata(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

/**
 * Opens the bounded query-only connection while the native client owns the reader acquisition.
 */
export async function openServerOwnerReadConnection(
  dataRoot: string,
  owner: SplitStorageOwner,
  assertCurrent: (identity: string) => void
): Promise<Database.Database> {
  const path = serverStoragePath(dataRoot, owner);
  const file = await inspectServerOwnerFile(dataRoot, owner);
  if (!file) throw new ServerOwnerAdmissionError('recovery-required');
  assertCurrent(`${file.dev}:${file.ino}`);
  return openServerOwnerQueryOnly(path);
}

/** Reads existing owner history while the caller holds this stopped root exclusively. */
export async function withStoppedServerOwnerReadConnection<Value>(
  dataRoot: string,
  owner: SplitStorageOwner,
  lock: DataRootLock,
  read: (sqlite: Database.Database) => Value
): Promise<Awaited<Value>> {
  const release = retainDataRootLock(lock, dataRoot);
  if (!release) throw new ServerOwnerAdmissionError('recovery-required');
  let sqlite: Database.Database | undefined;
  try {
    if (!(await inspectServerOwnerFile(dataRoot, owner)))
      throw new ServerOwnerAdmissionError('recovery-required');
    sqlite = openServerOwnerQueryOnly(serverStoragePath(dataRoot, owner));
    assertCurrentServerOwnerConnection(sqlite, owner);
    return await read(sqlite);
  } finally {
    try {
      sqlite?.close();
    } finally {
      release();
    }
  }
}

function openServerOwnerQueryOnly(path: string): Database.Database {
  const sqlite = openSqliteConnection(path, { fileMustExist: true, readonly: true });
  try {
    sqlite.pragma('query_only = ON');
    return ownMainScopeReadHandle(sqlite);
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

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

/** Binds ORM access to the exact admitted Core connection; never opens, migrates, closes or grants fresh initialization. */
export function bindCoreSqlite(
  sqlite: Database.Database,
  dataRoot: string,
  canInitializeLocalUser = false
): CoreDb {
  return {
    scope: 'core',
    canInitializeLocalUser,
    sqlite,
    db: drizzle(sqlite, { schema }),
    dataRoot,
  };
}

/** Binds a supplied Workspace connection; raw-only readers avoid ORM construction, while the admitting caller owns identity and lifetime. */
export function bindWorkspaceSqlite(
  sqlite: Database.Database,
  dataRoot: string,
  workspaceId: string
): WorkspaceDb {
  let db: WorkspaceDb['db'] | undefined;
  return {
    scope: 'workspace',
    sqlite,
    get db() {
      db ??= drizzle(sqlite, { schema });
      return db;
    },
    dataRoot,
    workspaceId,
  };
}

let singleton: CoreDb | undefined;

/** Opens one connection; scoped admission and pure integrity inspection retain their separate policies. */
function openSqliteConnection(
  path: string,
  options: { fileMustExist?: boolean; readonly?: boolean }
): Database.Database {
  return new Database(path, { ...options, timeout: 5 });
}

/** Tests the same owned file presence for initialization and integrity admission. */
function sqlitePathExists(path: string): boolean {
  return existsSync(path);
}

/**
 * Opens owned authority and reapplies its connection-local read or durability policy.
 *
 * Read-only handles stay query-only and never configure WAL or schema. Writable handles require FULL synchronization on every open because that setting does not persist in the file. Close failed opens locally.
 *
 * @param path Owned database path.
 * @param scope Exact physical journal scope.
 * @param options Existing-file and read-only policy.
 * @param busyTimeoutMs Scope-owned lock wait, applied before writable configuration.
 * @returns Configured owned SQLite connection.
 * @throws When the file cannot open or its connection policy cannot be applied.
 */
function openOwnedSqlite(
  path: string,
  scope: StorageMigrationScope,
  options: { fileMustExist?: boolean; readonly?: boolean } = {},
  busyTimeoutMs = 5
): Database.Database {
  // Even closing a writable connection can checkpoint a retained WAL. Admit existing
  // history through a read-only handle before any mutable connection can be constructed.
  if (!options.readonly && sqlitePathExists(path)) {
    const inspection = openOwnedSqlite(
      path,
      scope,
      { fileMustExist: true, readonly: true },
      busyTimeoutMs
    );
    inspection.close();
  }
  const sqlite = openSqliteConnection(path, options);
  try {
    if (busyTimeoutMs !== 5) sqlite.pragma(`busy_timeout = ${busyTimeoutMs}`);
    assertSupportedNativeLedger(sqlite, scope);
    // Apply durability only after the exact retained journal is supported.
    if (options.readonly) sqlite.pragma('query_only = ON');
    else configureOwnedSqlite(sqlite);
    return sqlite;
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

/**
 * Opens existing scope history or its private restore copy through the read-only admission owner.
 * The caller owns path admission and lifetime; this neither creates storage nor applies SQL.
 * @param path Existing admitted database path.
 * @param scope Exact journal scope supplied by the physical or restore owner.
 * @param busyTimeoutMs Existing owner lock-wait policy.
 * @returns Read-only, query-only connection after supported-ledger admission.
 */
export function openSupportedScopeReadOnlySqlite(
  path: string,
  scope: StorageMigrationScope,
  busyTimeoutMs = 5
): Database.Database {
  return openOwnedSqlite(path, scope, { fileMustExist: true, readonly: true }, busyTimeoutMs);
}

/** Checks the exact shipped journal and schema on an already selected owner connection. */
export function assertCurrentServerOwnerConnection(
  sqlite: Database.Database,
  owner: SplitStorageOwner
): void {
  assertCurrentServerOwnerSchema(sqlite, owner, () => openSqliteConnection(':memory:', {}));
}

/** Checks a private restore copy against its exact split owner's shipped journal and schema. */
export function verifyServerOwnerRestoreCopy(path: string, owner: SplitStorageOwner): void {
  const sqlite = openSqliteConnection(path, { fileMustExist: true, readonly: true });
  try {
    assertCurrentServerOwnerConnection(sqlite, owner);
  } finally {
    sqlite.close();
  }
}

/** Checks the Core authority on an admitted read-only copy before it can enter service. */
export function assertCoreBaseline(sqlite: Database.Database): void {
  assertCurrentCoreBaseline(sqlite, () => openSqliteConnection(':memory:', {}));
}

/** Inspects Core and its committed WAL without touching canonical SQLite sidecars. */
export async function verifyExistingCoreBaseline(dataRoot: string): Promise<void> {
  const path = serverStoragePath(dataRoot, 'control-kernel');
  let present: Awaited<ReturnType<typeof inspectServerOwnerFile>>;
  try {
    present = await inspectServerOwnerFile(dataRoot, 'control-kernel');
  } catch (error) {
    if (!(error instanceof ServerOwnerAdmissionError)) throw error;
    throw new BootConfigError(
      'migration_unsupported_core',
      'Unsupported Core database. A fresh v0.2.0 installation is required.'
    );
  }
  if (!present)
    throw new BootConfigError(
      'migration_unsupported_core',
      'Core database is missing from an existing deployment. A fresh v0.2.0 installation is required.'
    );

  const [root, scratch] = await Promise.all([realpath(dataRoot), realpath(tmpdir())]);
  const relativeScratch = relative(root, scratch);
  if (
    relativeScratch === '' ||
    (!isAbsolute(relativeScratch) &&
      relativeScratch !== '..' &&
      !relativeScratch.startsWith(`..${sep}`))
  )
    throw new BootConfigError(
      'migration_core_inspection_unsafe',
      'Core inspection requires a temporary directory outside DATA_ROOT.'
    );

  const inspectionRoot = await createPrivateTree(scratch, 'openkit-core-admission-');
  const inspectionPath = join(inspectionRoot, 'core.sqlite');
  try {
    for (const suffix of ['', '-wal', '-journal']) {
      const sourcePath = `${path}${suffix}`;
      const metadata = suffix ? await serverOwnerMetadata(sourcePath) : present;
      if (!metadata) continue;
      await copyFileForCut({
        sourcePath,
        destinationPath: `${inspectionPath}${suffix}`,
        maxBytes: metadata.size,
        mode: 0o600,
      });
    }
    const sqlite = openSqliteConnection(inspectionPath, { fileMustExist: true, readonly: true });
    try {
      assertCoreBaseline(sqlite);
    } finally {
      sqlite.close();
    }
  } finally {
    await removePrivateTree(inspectionRoot);
  }
}

/** Checks whether this root can be seeded or booted before either caller may write. */
export async function admitDataRootForBoot(dataRoot: string): Promise<boolean> {
  try {
    if (isFreshCoreInitializationScope(dataRoot)) return true;
    await verifyExistingCoreBaseline(dataRoot);
    assertCanonicalDirectory(resolveDataRootPath(dataRoot, 'server'));
    readDataRootLayoutMarker(dataRoot);
    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message} Follow the v0.2.0 Storage Reinstall procedure in docs/cookbooks/persistent-live-acceptance.md#v020-storage-reinstall.`,
      { cause: error }
    );
  }
}

/** Records deployment lineage only on an admitted existing Core and marker. */
export async function recordDataRootDeploymentMove(
  root: string,
  deploymentId: string
): Promise<DataRootLayoutMarker> {
  if (!isEntityId('dep', deploymentId)) {
    throw new Error('DATA_ROOT deployment id must not be empty.');
  }

  await verifyExistingCoreBaseline(root);
  const current = readDataRootLayoutMarker(root);
  const predecessorDeploymentId =
    current.deploymentId === deploymentId ? current.predecessorDeploymentId : current.deploymentId;

  if (predecessorDeploymentId === deploymentId) {
    throw new Error('DATA_ROOT predecessor deployment id must differ from deployment id.');
  }

  const marker: DataRootLayoutMarker = {
    schemaVersion: 1,
    layoutVersion: current.layoutVersion,
    deploymentId,
    ...(predecessorDeploymentId ? { predecessorDeploymentId } : {}),
  };
  const markerPath = resolveDataRootPath(root, 'server', 'layout.json');
  await replaceExistingFileText(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  return marker;
}

/** Opens an existing Core reader without layout creation or migration; the caller owns its lifetime. */
export function openCoreReadDb(dataRoot: string): CoreDb {
  const reader = openControlStoreProductReadHandle(coreDbPath(dataRoot), { kind: 'server' });
  return bindCoreSqlite(reader.sqlite, dataRoot);
}

/**
 * Opens the boot or explicit setup Core writer; serving reads use openCoreReadDb.
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

  const sqlite = openOwnedSqlite(coreDbPath(dataRoot), 'core');

  return bindCoreSqlite(sqlite, dataRoot, canInitializeLocalUser);
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
  const path = serverStoragePath(dataRoot, 'control-kernel');
  // SQLite accepts a zero-byte file as new; an established deployment has no such initialization proof.
  const present = existsSync(path);
  if (!freshInitialization && (!present || statSync(path).size === 0)) {
    throw new Error('Core database is missing from an existing deployment.');
  }
  ensureLayout(dataRoot);
  if (!freshInitialization || present) return openExistingCoreDbWithIntegrityCheck(dataRoot);
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
  const sqlite = openOwnedSqlite(path, 'core', { fileMustExist: true });

  return bindCoreSqlite(sqlite, dataRoot);
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

  const sqlite = openOwnedSqlite(userDbPath(dataRoot, userId), 'user');

  return { scope: 'user', sqlite, dataRoot, userId };
}

/**
 * Opens an existing User database for a short read without layout creation or migration.
 * Callers retain current authority and physical-path checks and close the owned connection.
 * @param dataRoot Data root that contains the existing User database.
 * @param userId Exact User owner.
 * @returns Read-only, query-only User connection under the existing Main busy policy.
 */
export function openUserReadDb(dataRoot: string, userId: string): UserDb {
  const path = userDbPath(dataRoot, userId);
  if (!lstatSync(path).isFile() || realpathSync(dirname(path)) !== dirname(path))
    throw new Error('User database path is not canonical.');
  const sqlite = openOwnedSqlite(path, 'user', {
    readonly: true,
    fileMustExist: true,
  });
  try {
    ownMainScopeReadHandle(sqlite);
    return { scope: 'user', sqlite, dataRoot, userId };
  } catch (error) {
    sqlite.close();
    throw error;
  }
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

  const sqlite = openOwnedSqlite(workspaceDbPath(dataRoot, workspaceId), 'workspace');

  return bindWorkspaceSqlite(sqlite, dataRoot, workspaceId);
}

/**
 * Opens an existing Workspace through the native product owner's read-only, query-only connection.
 * No layout or schema is created. Main lock waiting is bounded to 5 ms. Callers own closure; synchronous reads leave no transaction across an await.
 * @param dataRoot Data root that owns the existing Workspace.
 * @param workspaceId Exact Workspace owner.
 * @returns Scoped raw SQLite and ORM read views on the same connection.
 */
export function openWorkspaceReadDb(dataRoot: string, workspaceId: string): WorkspaceDb {
  const reader = openControlStoreProductReadHandle(workspaceDbPath(dataRoot, workspaceId), {
    kind: 'workspace',
    workspaceId,
  });
  return bindWorkspaceSqlite(reader.sqlite, dataRoot, workspaceId);
}

/** Opens a current admitted Workspace for observation, without layout creation or migration. */
export function openAdmittedWorkspaceReadDb(dataRoot: string, workspaceId: string): WorkspaceDb {
  assertScopeAdmitted(dataRoot, 'workspace', workspaceId);
  return openWorkspaceReadDb(dataRoot, workspaceId);
}

/** Opens an existing Workspace database after the current boot already verified its layout. */
export function openBootVerifiedWorkspaceDb(dataRoot: string, workspaceId: string): WorkspaceDb {
  assertScopeAdmitted(dataRoot, 'workspace', workspaceId);
  const sqlite = openOwnedSqlite(workspaceDbPath(dataRoot, workspaceId), 'workspace', {
    fileMustExist: true,
  });

  return bindWorkspaceSqlite(sqlite, dataRoot, workspaceId);
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

  const sqlite = openOwnedSqlite(join(input.workspaceRoot, 'db', 'workspace.sqlite'), 'workspace');

  return bindWorkspaceSqlite(sqlite, input.dataRoot, input.workspaceId);
}

/**
 * Returns the existing read-only process Core view without creating storage or migrating.
 *
 * @param env Environment variables used to resolve the data root.
 * @returns Singleton raw SQLite and Drizzle handles.
 */
export function getCoreDb(env: NodeJS.ProcessEnv = process.env): CoreDb {
  if (!singleton) {
    singleton = openCoreReadDb(resolveDataRoot(env));
  }

  return singleton;
}

/**
 * Fails closed when an existing authoritative SQLite database is corrupt.
 *
 * @param path SQLite database path.
 * @throws When SQLite cannot open or validate the existing file.
 */
export function assertSqliteIntegrity(path: string): void {
  if (!sqlitePathExists(path)) {
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
export function listWorkspaceDirectories(dataRoot: string): string[] {
  return listChildDirectories(join(dataRoot, 'workspaces')).filter((name) => name !== '.staging');
}

/**
 * Lists direct child directory names in stable order.
 *
 * @param path Parent path.
 * @returns Child directory names.
 */
export function listChildDirectories(path: string): string[] {
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
    sqlite = openSqliteConnection(path, { fileMustExist: true, readonly: true });
    // Preserve the integrity reader's original driver-default wait without granting write access.
    sqlite.pragma('busy_timeout = 5000');
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
  const emptyOwnedDirectories = ['server', 'users', 'workspaces', 'local', 'logs'].every((name) => {
    const path = join(dataRoot, name);
    return !existsSync(path) || readdirSync(path).length === 0;
  });
  return (
    emptyOwnedDirectories &&
    !readLayoutDirectory(dataRoot).some((entry) => entry.name === 'core.sqlite')
  );
}

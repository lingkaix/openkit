import { type BigIntStats, existsSync, readdirSync, statSync } from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { compareCodeUnits } from '@openkit/protocol';
import { copyFileForCut, createPrivateTree, removePrivateTree } from '@openkit/storage';
import Database from 'better-sqlite3';

import { FileStorageAdmission } from './artifacts/file-admission.js';
import { coreDbPath, userDbPath, workspaceDbPath } from './fs-layout.js';
import { listAppliedNativeMigrationIds, type StorageMigrationScope } from './migrate.js';

/**
 * Storage database migration status.
 */
export interface StorageDatabaseReport {
  /** Database path relative to the data root. */
  path: string;
  /** Whether the database file exists. */
  exists: boolean;
  /** Applied migration ids in stable order. */
  appliedMigrations: string[];
}

/**
 * Directory status for derived index storage.
 */
export interface StorageDirectoryReport {
  /** Directory path relative to the data root. */
  path: string;
  /** Whether the directory exists. */
  exists: boolean;
  /** Direct child count when the directory exists. */
  entryCount: number;
}

/** Exact owner of one quarantined storage file. */
type StorageQuarantineOwner =
  | { readonly scope: 'server' }
  | { readonly scope: 'user'; readonly userId: string }
  | { readonly scope: 'workspace'; readonly workspaceId: string };

/** One quarantined storage file available for operator inspection. */
export type StorageQuarantineEntry = StorageQuarantineOwner & {
  /** Quarantined file path relative to the data root. */
  path: string;
  /** Quarantined file size in bytes. */
  bytes: number;
};

/**
 * One workspace subtree in the storage layout report.
 */
export interface StorageWorkspaceReport {
  /** Workspace id derived from the workspace directory name. */
  workspaceId: string;
  /** Workspace-scoped SQLite status. */
  workspaceDb: StorageDatabaseReport;
  /** Derived indexes directory status. */
  indexesDir: StorageDirectoryReport;
}

/**
 * One user subtree in the storage layout report.
 */
export interface StorageUserReport {
  /** User id derived from the user directory name. */
  userId: string;
  /** User-scoped SQLite status. */
  userDb: StorageDatabaseReport;
}

/**
 * Read-only storage baseline report for the current data root.
 */
export interface StorageLayoutReport {
  /** Data root that was inspected. */
  dataRoot: string;
  /** Server-scoped SQLite status. */
  serverDb: StorageDatabaseReport;
  /** User subtrees found under `users/`. */
  users: StorageUserReport[];
  /** Owner-independent Workspace subtrees found under `workspaces/`. */
  workspaces: StorageWorkspaceReport[];
  /** Quarantined storage files preserved for operator inspection. */
  quarantineEntries: StorageQuarantineEntry[];
}

/**
 * Creates a read-only report from private file cuts of the target storage baseline.
 * Live callers retain the native posting hold until this promise settles; no source SQLite is opened.
 *
 * @param dataRoot Data root to inspect.
 * @param fileAdmission Existing configured physical capacity owner.
 * @returns Storage layout report with database ledgers and quarantine entries.
 */
export async function createStorageLayoutReport(
  dataRoot: string,
  fileAdmission = new FileStorageAdmission(dataRoot, () => 1_000_000_000n)
): Promise<StorageLayoutReport> {
  const users: StorageUserReport[] = [];
  const workspaces: StorageWorkspaceReport[] = [];
  for (const userId of listDirectories(join(dataRoot, 'users')))
    users.push(await createUserReport(dataRoot, userId, fileAdmission));
  for (const workspaceId of listDirectories(join(dataRoot, 'workspaces'))) {
    if (workspaceId !== '.staging')
      workspaces.push(await createWorkspaceReport(dataRoot, workspaceId, fileAdmission));
  }

  return {
    dataRoot,
    serverDb: await createDatabaseReport(dataRoot, coreDbPath(dataRoot), 'core', fileAdmission),
    users,
    workspaces,
    quarantineEntries: createQuarantineEntries(dataRoot, users, workspaces),
  };
}

/**
 * Creates one user subtree report.
 *
 * @param dataRoot Data root to inspect.
 * @param userId User directory name.
 * @param fileAdmission Existing configured physical capacity owner.
 * @returns User storage report.
 */
async function createUserReport(
  dataRoot: string,
  userId: string,
  fileAdmission: FileStorageAdmission
): Promise<StorageUserReport> {
  return {
    userId,
    userDb: await createDatabaseReport(
      dataRoot,
      userDbPath(dataRoot, userId),
      'user',
      fileAdmission
    ),
  };
}

/**
 * Creates one workspace subtree report.
 *
 * @param dataRoot Data root to inspect.
 * @param workspaceId Workspace directory name.
 * @param fileAdmission Existing configured physical capacity owner.
 * @returns Workspace storage report.
 */
async function createWorkspaceReport(
  dataRoot: string,
  workspaceId: string,
  fileAdmission: FileStorageAdmission
): Promise<StorageWorkspaceReport> {
  const indexesPath = join(dataRoot, 'workspaces', workspaceId, 'indexes');

  return {
    workspaceId,
    workspaceDb: await createDatabaseReport(
      dataRoot,
      workspaceDbPath(dataRoot, workspaceId),
      'workspace',
      fileAdmission
    ),
    indexesDir: createDirectoryReport(dataRoot, indexesPath),
  };
}

/**
 * Creates one database ledger report.
 *
 * @param dataRoot Data root used for relative output paths.
 * @param dbPath SQLite file path.
 * @param scope Native journal scope used to name exact matched applied ids.
 * @param fileAdmission Existing configured physical capacity owner.
 * @returns Database status and applied migration ids.
 */
async function createDatabaseReport(
  dataRoot: string,
  dbPath: string,
  scope: StorageMigrationScope,
  fileAdmission: FileStorageAdmission
): Promise<StorageDatabaseReport> {
  const reportPath = toReportPath(dataRoot, dbPath);
  if (!existsSync(dbPath)) return { path: reportPath, exists: false, appliedMigrations: [] };

  const [root, parent, scratchParent] = await Promise.all([
    realpath(dataRoot),
    realpath(dirname(dbPath)),
    realpath(tmpdir()),
  ]);
  const [rootIdentity, parentIdentity] = await Promise.all([
    stat(root, { bigint: true }),
    stat(parent, { bigint: true }),
  ]);
  const scratchRelative = relative(root, scratchParent);
  if (
    !scratchRelative ||
    (!isAbsolute(scratchRelative) &&
      scratchRelative !== '..' &&
      !scratchRelative.startsWith(`..${sep}`))
  )
    throw new Error('Storage report scratch must be outside the data root.');

  // A readonly source WAL open still creates sidecars. Only private bytes reach SQLite.
  const inputs = await Promise.all(
    ['', '-wal', '-journal'].map(async (suffix) => ({
      suffix,
      metadata: await reportInputMetadata(`${dbPath}${suffix}`),
    }))
  );
  for (const { suffix, metadata } of inputs) {
    if (!metadata && suffix) continue;
    if (
      !metadata?.isFile() ||
      metadata.nlink !== 1n ||
      metadata.size > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw new Error('Storage report source is not an admitted regular file.');
  }
  const bytes = inputs.reduce((total, { metadata }) => total + (metadata?.size ?? 0n), 0n);
  const reservation = fileAdmission.forPath(scratchParent).reserve({
    stagingBytes: bytes * 2n + 98_304n,
    extractionBytes: 0n,
    derivativeBytes: 0n,
    publicationBytes: 0n,
  });
  let scratch: string | undefined;
  let result: StorageDatabaseReport;
  try {
    scratch = await createPrivateTree(scratchParent, 'openkit-layout-inspection-');
    const copy = join(scratch, 'inspection');
    for (const { suffix, metadata } of inputs) {
      if (!metadata) continue;
      await copyFileForCut({
        sourcePath: `${dbPath}${suffix}`,
        destinationPath: `${copy}${suffix}`,
        maxBytes: Number(metadata.size),
        mode: 0o600,
      });
    }
    result = {
      path: reportPath,
      exists: true,
      appliedMigrations: readPrivateReportLedger(copy, scope),
    };
  } finally {
    if (scratch) await removePrivateTree(scratch);
    reservation.release();
  }
  // Copy and cleanup yield. Reject a changed logical binding or input set before returning the ledger.
  const [currentRoot, currentParent, currentRootPath, currentParentPath] = await Promise.all([
    stat(dataRoot, { bigint: true }),
    stat(dirname(dbPath), { bigint: true }),
    realpath(dataRoot),
    realpath(dirname(dbPath)),
  ]);
  if (
    currentRootPath !== root ||
    currentParentPath !== parent ||
    currentRoot.dev !== rootIdentity.dev ||
    currentRoot.ino !== rootIdentity.ino ||
    currentParent.dev !== parentIdentity.dev ||
    currentParent.ino !== parentIdentity.ino
  )
    throw new Error('Storage report source binding changed.');
  for (const { suffix, metadata } of inputs) {
    const current = await reportInputMetadata(`${dbPath}${suffix}`);
    if (!sameReportSource(metadata, current)) throw new Error('Storage report source changed.');
  }
  return result;
}

/** Reads the original ledger projection only on an already copied private database. */
function readPrivateReportLedger(dbPath: string, scope: StorageMigrationScope): string[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    return listAppliedNativeMigrationIds(db, scope);
  } finally {
    db.close();
  }
}

/** Observes an optional retained input without moving filesystem work onto Main. */
async function reportInputMetadata(path: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw error;
  }
}

/** Compares every retained input fact after asynchronous private inspection and cleanup. */
function sameReportSource(
  before: BigIntStats | undefined,
  after: BigIntStats | undefined
): boolean {
  if (!before || !after) return before === after;
  return (
    after.isFile() &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs &&
    before.nlink === after.nlink &&
    before.mode === after.mode
  );
}

/**
 * Creates one directory report.
 *
 * @param dataRoot Data root used for relative output paths.
 * @param dirPath Directory path.
 * @returns Directory status.
 */
function createDirectoryReport(dataRoot: string, dirPath: string): StorageDirectoryReport {
  if (!existsSync(dirPath)) {
    return { path: toReportPath(dataRoot, dirPath), exists: false, entryCount: 0 };
  }

  return {
    path: toReportPath(dataRoot, dirPath),
    exists: true,
    entryCount: readdirSync(dirPath).length,
  };
}

/**
 * Lists all known quarantine entries in stable order.
 *
 * @param dataRoot Data root to inspect.
 * @param users User reports already discovered under the data root.
 * @param workspaces Workspace reports already discovered under the data root.
 * @returns Quarantined file entries.
 */
function createQuarantineEntries(
  dataRoot: string,
  users: StorageUserReport[],
  workspaces: StorageWorkspaceReport[]
): StorageQuarantineEntry[] {
  return [
    ...listQuarantineFiles(dataRoot, join(dataRoot, 'server', 'quarantine'), { scope: 'server' }),
    ...users.flatMap((user) =>
      listQuarantineFiles(dataRoot, join(dataRoot, 'users', user.userId, 'quarantine'), {
        scope: 'user',
        userId: user.userId,
      })
    ),
    ...workspaces.flatMap((workspace) =>
      listQuarantineFiles(
        dataRoot,
        join(dataRoot, 'workspaces', workspace.workspaceId, 'quarantine'),
        { scope: 'workspace', workspaceId: workspace.workspaceId }
      )
    ),
  ].sort((left, right) => compareCodeUnits(left.path, right.path));
}

/**
 * Lists direct quarantined files for one quarantine directory.
 *
 * @param dataRoot Data root used for relative output paths.
 * @param dirPath Quarantine directory path.
 * @param owner Entry ownership metadata.
 * @returns Quarantined file entries.
 */
function listQuarantineFiles(
  dataRoot: string,
  dirPath: string,
  owner: StorageQuarantineOwner
): StorageQuarantineEntry[] {
  if (!existsSync(dirPath)) {
    return [];
  }

  return readdirSync(dirPath)
    .map((name) => {
      const path = join(dirPath, name);
      const stat = statSync(path);

      return { name, path, stat };
    })
    .filter((entry) => entry.stat.isFile())
    .map((entry) => ({
      ...owner,
      path: toReportPath(dataRoot, entry.path),
      bytes: entry.stat.size,
    }));
}

/**
 * Lists direct child directories in stable order.
 *
 * @param path Parent directory.
 * @returns Directory names.
 */
function listDirectories(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }

  return readdirSync(path)
    .filter((name) => statSync(join(path, name)).isDirectory())
    .sort();
}

/**
 * Converts a data-root path to a portable report path.
 *
 * @param dataRoot Data root.
 * @param path Path under the data root.
 * @returns Slash-separated relative path.
 */
function toReportPath(dataRoot: string, path: string): string {
  return relative(dataRoot, path).split(sep).join('/');
}

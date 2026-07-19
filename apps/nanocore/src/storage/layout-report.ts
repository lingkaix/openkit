import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import Database from 'better-sqlite3';

import { coreDbPath, userDbPath, workspaceDbPath } from './fs-layout.js';

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
 * Creates a read-only report for the target storage baseline.
 *
 * @param dataRoot Data root to inspect.
 * @returns Storage layout report with database ledgers and quarantine entries.
 */
export function createStorageLayoutReport(dataRoot: string): StorageLayoutReport {
  const users = listDirectories(join(dataRoot, 'users')).map((userId) =>
    createUserReport(dataRoot, userId)
  );
  const workspaces = listDirectories(join(dataRoot, 'workspaces'))
    .filter((workspaceId) => workspaceId !== '.staging')
    .map((workspaceId) => createWorkspaceReport(dataRoot, workspaceId));

  return {
    dataRoot,
    serverDb: createDatabaseReport(dataRoot, coreDbPath(dataRoot)),
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
 * @returns User storage report.
 */
function createUserReport(dataRoot: string, userId: string): StorageUserReport {
  return {
    userId,
    userDb: createDatabaseReport(dataRoot, userDbPath(dataRoot, userId)),
  };
}

/**
 * Creates one workspace subtree report.
 *
 * @param dataRoot Data root to inspect.
 * @param workspaceId Workspace directory name.
 * @returns Workspace storage report.
 */
function createWorkspaceReport(dataRoot: string, workspaceId: string): StorageWorkspaceReport {
  const indexesPath = join(dataRoot, 'workspaces', workspaceId, 'indexes');

  return {
    workspaceId,
    workspaceDb: createDatabaseReport(dataRoot, workspaceDbPath(dataRoot, workspaceId)),
    indexesDir: createDirectoryReport(dataRoot, indexesPath),
  };
}

/**
 * Creates one database ledger report.
 *
 * @param dataRoot Data root used for relative output paths.
 * @param dbPath SQLite file path.
 * @returns Database status and applied migration ids.
 */
function createDatabaseReport(dataRoot: string, dbPath: string): StorageDatabaseReport {
  if (!existsSync(dbPath)) {
    return { path: toReportPath(dataRoot, dbPath), exists: false, appliedMigrations: [] };
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  try {
    const hasMigrationTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get('schema_migrations');

    if (!hasMigrationTable) {
      return { path: toReportPath(dataRoot, dbPath), exists: true, appliedMigrations: [] };
    }

    const rows = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{
      id: string;
    }>;

    return {
      path: toReportPath(dataRoot, dbPath),
      exists: true,
      appliedMigrations: rows.map((row) => row.id),
    };
  } finally {
    db.close();
  }
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
  ].sort((left, right) => left.path.localeCompare(right.path));
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

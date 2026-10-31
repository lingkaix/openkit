import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { vi } from 'vitest';
import { collectionTableName, quoteIdent } from '../generative-kernel/native.js';
import { FsStore, type FsStoreOptions } from '../lib/store.js';
import { openExistingAppDb } from '../storage/app-db.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import {
  type CoreDb,
  openCoreDb,
  openUserDb,
  openWorkspaceDb,
  type UserDb,
  type WorkspaceDb,
} from '../storage/db.js';
import { coreDbPath } from '../storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';

/** Constructs the genuine storage-owner error class without opening a test database. */
export function createTestSqliteError(message: string, code: 'SQLITE_BUSY' | 'SQLITE_LOCKED') {
  return new Database.SqliteError(message, code);
}

/**
 * Changes only an existing Workspace revision for explicit physical-corruption fixtures.
 * This bypasses product admission solely after genuine owner setup; it creates no lifecycle, receipt or Audit.
 * Callers must exclude real writers and restore the original revision in finally.
 * @param dataRoot Private fixture root containing the existing Workspace.
 * @param workspaceId Exact Workspace whose physical revision is damaged or restored.
 * @param revision Explicit fault value or the original revision to restore.
 */
export function setTestWorkspaceRevision(
  dataRoot: string,
  workspaceId: string,
  revision: number
): void {
  const scope = nativeProductScope(dataRoot, { kind: 'workspace', workspaceId });
  const db = new Database(scope.path, { fileMustExist: true });
  try {
    db.prepare('UPDATE control_workspaces SET revision=? WHERE id=?').run(revision, workspaceId);
  } finally {
    db.close();
  }
}

/**
 * Creates a Store after initializing the native Core schema in a caller-owned fixture root.
 * Existing databases are never repaired or replaced. Callers retain root and writer cleanup ownership.
 *
 * @param options Explicit fixture storage options; omitted roots retain in-memory Store behavior.
 * @returns The production Store with its file-backed read prerequisites already present.
 */
export function createTestStore(options: FsStoreOptions = {}): FsStore {
  if (options.dataRoot) initializeTestCore(options.dataRoot);
  return new FsStore(options);
}

/** Initializes the absent Core schema in a private fixture root before a caller constructs its own Store. */
export function initializeTestCore(dataRoot: string): void {
  if (!existsSync(coreDbPath(dataRoot))) {
    const coreDb = openCoreDb(dataRoot);
    try {
      applyMigrations(coreDb);
    } finally {
      coreDb.sqlite.close();
    }
  }
}

/** Opens a migrated private Core fixture through its storage owner; the caller owns root removal. */
export function createTestCoreDb(dataRoot: string): CoreDb {
  initializeTestCore(dataRoot);
  return openCoreDb(dataRoot);
}

/** Opens only an already initialized Workspace fixture; creates no records or authority. */
export function createTestWorkspaceDb(dataRoot: string, workspaceId: string): WorkspaceDb {
  return openWorkspaceDb(dataRoot, workspaceId);
}

/** Closes the exact caller-owned fixture handle after native work has drained. */
export function closeTestCoreDb(coreDb: CoreDb | WorkspaceDb): void {
  if (coreDb.sqlite.open) coreDb.sqlite.close();
}

/** Opens and migrates a private User fixture without creating identity or authorization facts. */
export function createTestUserDb(
  dataRoot: string,
  userId: string
): { userDb: UserDb; close: () => void } {
  const userDb = openUserDb(dataRoot, userId);
  try {
    applyScopedMigrations(userDb);
  } catch (error) {
    userDb.sqlite.close();
    throw error;
  }
  return {
    userDb,
    close: () => {
      if (userDb.sqlite.open) userDb.sqlite.close();
    },
  };
}

/**
 * Opens the existing native owner for an already migrated private Workspace fixture.
 * Callers must drain the shared client before they close handles or remove fixture roots.
 *
 * @param workspaceDb Existing migrated Workspace handle; no authority or schema is created.
 * @returns Acknowledgement that the exact existing native scope is open.
 */
export async function openTestNativeWorkspace(workspaceDb: WorkspaceDb): Promise<void> {
  const scope = nativeProductScope(workspaceDb.dataRoot, {
    kind: 'workspace',
    workspaceId: workspaceDb.workspaceId,
  });
  await getControlStoreWorkerClient().open({
    database: `workspace:${scope.path}`,
    path: scope.path,
    dataRoot: workspaceDb.dataRoot,
    create: false,
    initialize: 'workspace',
    productOwner: scope.owner,
    contentMount: scope.contentMount,
  });
}

/**
 * Observes one actual record COUNT in a valid private app, without exposing SQL or a handle.
 * The callback can run a genuine native writer between count and selected rows; results stay unchanged.
 * The caller restores the observer in finally after draining any callback work.
 * @param scope Existing app and admitted collection in the caller-owned fixture root.
 * @param afterCount One synchronous interleaving after the actual COUNT result is available.
 * @returns Cleanup for the exact observer and its private read handle.
 */
export function observeTestAppRecordCount(
  scope: { dataRoot: string; workspaceId: string; appId: string; collectionId: string },
  afterCount: () => void
): () => void {
  const observer = openExistingAppDb(scope.dataRoot, scope.workspaceId, scope.appId);
  const table = quoteIdent(collectionTableName(scope.collectionId));
  const prepare = Database.prototype.prepare;
  let observed = false;
  const instrumentation = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    const statement = prepare.call(this, sql) as Database.Statement;
    if (
      this.name === observer.sqlite.name &&
      !observed &&
      sql.startsWith(`SELECT COUNT(*) AS total FROM ${table} `)
    ) {
      const get = statement.get.bind(statement);
      vi.spyOn(statement, 'get').mockImplementation((...parameters: unknown[]) => {
        const count = get(...parameters);
        observed = true;
        afterCount();
        return count;
      });
    }
    return statement;
  });
  return () => {
    instrumentation.mockRestore();
    if (observer.sqlite.open) observer.sqlite.close();
  };
}

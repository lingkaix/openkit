import { existsSync } from 'node:fs';
import { FsStore, type FsStoreOptions } from '../lib/store.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { type CoreDb, openCoreDb, type WorkspaceDb } from '../storage/db.js';
import { coreDbPath } from '../storage/fs-layout.js';
import { applyMigrations } from '../storage/migrate.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';

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

/** Closes the exact caller-owned fixture handle after native work has drained. */
export function closeTestCoreDb(coreDb: CoreDb): void {
  if (coreDb.sqlite.open) coreDb.sqlite.close();
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

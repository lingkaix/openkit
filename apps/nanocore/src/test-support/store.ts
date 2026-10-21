import { existsSync } from 'node:fs';
import { FsStore, type FsStoreOptions } from '../lib/store.js';
import { openCoreDb } from '../storage/db.js';
import { coreDbPath } from '../storage/fs-layout.js';
import { applyMigrations } from '../storage/migrate.js';

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

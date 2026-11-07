import { openWorkspaceDb, type WorkspaceDb } from './db.js';
import { applyScopedMigrations } from './migrate.js';

/** Opens one workspace database for a title oracle. The caller closes it. */
export function openTitleOracleWorkspace(
  dataRoot: string,
  workspaceId: string,
  options?: { readonly migrate?: boolean }
): WorkspaceDb {
  const db = openWorkspaceDb(dataRoot, workspaceId);
  if (options?.migrate) applyScopedMigrations(db);
  return db;
}

/** Closes one oracle workspace handle when it is still open. */
export function closeTitleOracleWorkspace(db: WorkspaceDb): void {
  if (db.sqlite.open) db.sqlite.close();
}

/** True while this owned connection has not been closed. */
export function titleOracleWorkspaceIsOpen(db: WorkspaceDb): boolean {
  return db.sqlite.open;
}

/** Removes one thread row without the store API, so a title write can observe deletion. */
export function deleteTitleOracleThread(
  dataRoot: string,
  workspaceId: string,
  threadId: string
): void {
  const db = openWorkspaceDb(dataRoot, workspaceId);
  try {
    db.sqlite.exec('PRAGMA foreign_keys = OFF');
    db.sqlite.prepare('DELETE FROM control_threads WHERE id = ?').run(threadId);
  } finally {
    if (db.sqlite.open) db.sqlite.close();
  }
}

/**
 * Installs an abort trigger on thread updates.
 * The returned function drops the trigger and closes this connection.
 */
export function abortTitleOracleThreadUpdates(dataRoot: string, workspaceId: string): () => void {
  const db = openWorkspaceDb(dataRoot, workspaceId);
  db.sqlite.exec(`
    CREATE TRIGGER p2_title_revision_conflict
    BEFORE UPDATE ON control_threads
    BEGIN
      SELECT RAISE(ABORT, 'revision conflict');
    END;
  `);
  return () => {
    if (db.sqlite.open) {
      db.sqlite.exec('DROP TRIGGER IF EXISTS p2_title_revision_conflict');
      db.sqlite.close();
    }
  };
}

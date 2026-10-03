import type Database from 'better-sqlite3';

/** Drops only the retired pre-release host families after historical migration replay; shared records and native ledger stay intact. */
export function applyHostRepositoryCutover(sqlite: Database.Database): void {
  sqlite.transaction(() => {
    sqlite.exec('DROP TABLE IF EXISTS workspace_repository_resources');
    sqlite.exec('DROP TABLE IF EXISTS git_push_records');
  })();
}

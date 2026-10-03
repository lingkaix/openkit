import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { applyNativeScopeMigrations } from './migrate.js';

describe('host repository release cutover', () => {
  it('drops retired host records while preserving shared tables and the native ledger', () => {
    const sqlite = new Database(':memory:');
    try {
      applyNativeScopeMigrations(sqlite, 'workspace');
      const setup = readFileSync('drizzle/workspace/0000_setup.sql', 'utf8');
      for (const name of ['workspace_repository_resources', 'git_push_records']) {
        sqlite.exec(`DROP TABLE IF EXISTS ${name}`);
        const ddl = setup
          .split('--> statement-breakpoint')
          .find((statement) => statement.includes(`CREATE TABLE \`${name}\``));
        if (!ddl) throw new Error(`Historical setup lacks ${name}`);
        sqlite.exec(ddl);
      }
      sqlite.exec(
        "INSERT INTO workspace_repository_resources (workspace_id, resource_id, type, display_name, local_path, diagnostics_status, created_at, updated_at) VALUES ('ws_old', 'repo_default', 'git_repository', 'Historical', '/unreachable/host', 'ready', '2026-10-01', '2026-10-01')"
      );
      const tables = (): string[] =>
        (
          sqlite
            .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
            .all() as { name: string }[]
        ).map((row) => row.name);
      const before = tables();
      const beforeLedger = sqlite.prepare('SELECT * FROM __drizzle_migrations').all();
      // Seed the native ledger through its real migration, then verify exact replay and shared ownership.
      applyNativeScopeMigrations(sqlite, 'workspace');
      expect(tables()).not.toContain('workspace_repository_resources');
      expect(tables()).not.toContain('git_push_records');
      for (const name of before.filter(
        (name) => !['workspace_repository_resources', 'git_push_records'].includes(name)
      ))
        expect(tables()).toContain(name);
      const ledger = sqlite.prepare('SELECT * FROM __drizzle_migrations').all();
      expect(ledger).toEqual(beforeLedger);
      applyNativeScopeMigrations(sqlite, 'workspace');
      expect(sqlite.prepare('SELECT * FROM __drizzle_migrations').all()).toEqual(ledger);
    } finally {
      sqlite.close();
    }
  });
});

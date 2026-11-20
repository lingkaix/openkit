// openkit-test-platform: posix
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestStore, disposeTestStore } from '../test-support/store.js';
import { type CoreDb, openCoreReadDb, openWorkspaceReadDb, type WorkspaceDb } from './db.js';

const journalTags = {
  core: ['0000_baseline'],
  workspace: ['0000_baseline'],
  user: ['0000_baseline'],
  app: ['0000_baseline'],
} as const;

describe('fresh Core and Workspace setup', () => {
  it.each(['core', 'workspace', 'user', 'app'] as const)(
    'packages the complete native journal and SQL for %s',
    (scope) => {
      const folder = new URL(`../../drizzle/${scope}/`, import.meta.url);
      const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', folder), 'utf8')) as {
        entries: Array<{ idx: number; tag: string }>;
      };
      const tags = journalTags[scope];
      expect(journal.entries.map(({ tag }) => tag)).toEqual(tags);
      expect(journal.entries.map(({ idx }) => idx)).toEqual(tags.map((_, index) => index));
      const sqlFiles = readdirSync(folder)
        .filter((name) => name.endsWith('.sql'))
        .sort();
      expect(sqlFiles).toEqual(tags.map((tag) => `${tag}.sql`));
      for (const file of sqlFiles)
        expect(readFileSync(new URL(file, folder), 'utf8')).toMatch(/\S/);
    }
  );

  it('initializes complete fresh scopes and publishes through the original native owners', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-fresh-baseline-'));
    const databases: Array<CoreDb | WorkspaceDb> = [];
    try {
      const store = createTestStore({ dataRoot });
      const workspace = await store.createWorkspace('Fresh baseline Workspace');
      const serverThread = await store.createServerThread('Fresh Core publication');
      const workspaceThread = await store.createThread(workspace.id, 'Fresh Workspace publication');
      expect(store.getServerThread(serverThread.id)).toEqual(serverThread);
      expect(store.getThread(workspace.id, workspaceThread.id)).toEqual(workspaceThread);
      expect(store.getWorkspace(workspace.id)).toMatchObject({
        id: workspace.id,
        name: workspace.name,
      });

      // Setup writers have closed. These are the existing read owners, not second serving writers.
      const core = openCoreReadDb(dataRoot);
      databases.push(core);
      const scoped = openWorkspaceReadDb(dataRoot, workspace.id);
      databases.push(scoped);
      for (const db of databases) {
        expect(db.sqlite.readonly).toBe(true);
        expect(db.sqlite.pragma('query_only', { simple: true })).toBe(1);
        expect(db.sqlite.pragma('foreign_key_check')).toEqual([]);
        expect(db.sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
      }

      // Late Core schema and its current default must survive the squash, not just the old setup DDL.
      expect(
        core.sqlite
          .prepare(
            'SELECT singleton, state, enable_generation, enabling_user_id, expected_alarm_count FROM security_trigger_state'
          )
          .all()
      ).toEqual([
        {
          singleton: 1,
          state: 'off',
          enable_generation: 0,
          enabling_user_id: null,
          expected_alarm_count: 0,
        },
      ]);
      for (const table of [
        'security_trigger_alarms',
        'security_trigger_outbox',
        'security_thread_destinations',
      ]) {
        expect(core.sqlite.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()).toBe(0);
      }

      // Full fresh Workspace publication includes its actual initial Knowledge authority.
      expect(
        scoped.sqlite.prepare('SELECT COUNT(*) FROM knowledge_notebook_heads').pluck().get()
      ).toBe(1);
      const snapshotColumns = scoped.sqlite.pragma(
        'table_info(mcp_tool_schema_snapshots)'
      ) as Array<{
        name: string;
        notnull: number;
        dflt_value: unknown;
      }>;
      expect(snapshotColumns.find(({ name }) => name === 'approved_schema_digest')).toMatchObject({
        notnull: 0,
        dflt_value: null,
      });

      // N3's Pending rebuild must retain its dashboard maintenance and lookup dependencies.
      // Actual automation admission/publication stays with security-alarm-publication.test.ts.
      const pendingDependencies = scoped.sqlite
        .prepare("SELECT name FROM sqlite_schema WHERE type IN ('index', 'trigger')")
        .pluck()
        .all();
      expect(pendingDependencies).toEqual(
        expect.arrayContaining([
          'pending_requests_thread_state_idx',
          'pending_requests_thread_active_idx',
          'pending_requests_goal_active_idx',
          'pending_requests_goal_scope_insert',
          'pending_requests_goal_scope_update',
          'goals_attention_scope_insert',
          'goals_attention_scope_delete',
          'goal_card_tasks_attention_scope_insert',
          'goal_card_tasks_attention_scope_delete',
        ])
      );

      // Fresh publication applies every migration in the owning scope.
      for (const db of databases) {
        expect
          .soft(
            db.sqlite.prepare('SELECT COUNT(*) FROM __drizzle_migrations').pluck().get(),
            db.scope
          )
          .toBe(journalTags[db.scope].length);
      }
    } finally {
      // The shared fixture owner closes readers, drains the actual native writer, then removes only this private root.
      await disposeTestStore(dataRoot, ...databases);
    }
  });
});

// openkit-test-platform: posix
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureLocalUser } from '../test-support/local-user.js';
import { openTestServerWork } from '../test-support/server-work-store.js';
import { createTestCoreDb, disposeTestStore } from '../test-support/store.js';
import type { ControlStoreProductReadHandle } from './control-store-product-records.js';
import { type CoreDb, openCoreReadDb, openWorkspaceReadDb, type WorkspaceDb } from './db.js';
import { SECURITY_TRIGGER_OWNER } from './security-trigger-port.js';

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
    let serverReader: ControlStoreProductReadHandle | undefined;
    try {
      const setup = createTestCoreDb(dataRoot);
      let serverOwner: Awaited<ReturnType<typeof openTestServerWork>>;
      const userId = ensureLocalUser(setup);
      try {
        serverOwner = await openTestServerWork(setup);
      } finally {
        setup.sqlite.close();
      }
      serverReader = serverOwner.reader;
      const { store } = serverOwner;
      const workspace = await store.createWorkspace('Fresh baseline Workspace');
      const serverThread = await store.createServerThread(
        'Fresh Server publication',
        undefined,
        undefined,
        {
          actor: { kind: 'user', id: userId },
          credentialRef: null,
        }
      );
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
      for (const sqlite of [core.sqlite, scoped.sqlite, serverReader.sqlite]) {
        expect(sqlite.readonly).toBe(true);
        expect(sqlite.pragma('query_only', { simple: true })).toBe(1);
        expect(sqlite.pragma('foreign_key_check')).toEqual([]);
        expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
      }
      expect(
        core.sqlite.prepare("SELECT name FROM sqlite_schema WHERE name = 'control_threads'").get()
      ).toBeUndefined();
      expect(serverReader.sqlite.prepare('SELECT id FROM control_threads').all()).toEqual([
        { id: serverThread.id },
      ]);
      expect(
        serverReader.sqlite.prepare('SELECT COUNT(*) FROM __drizzle_migrations').pluck().get()
      ).toBe(1);

      const triggerTables = SECURITY_TRIGGER_OWNER.requiredTables;
      expect(
        core.sqlite
          .prepare(
            `SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN (${triggerTables.map(() => '?').join(',')})`
          )
          .all(...triggerTables)
      ).toEqual([]);

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
      serverReader?.close();
      await disposeTestStore(dataRoot, ...databases);
    }
  });
});

// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ensureLocalUser } from '../test-support/local-user.js';
import { openTestServerWork } from '../test-support/server-work-store.js';
import { createTestCoreDb, disposeTestStore } from '../test-support/store.js';
import type { ControlStoreProductReadHandle } from './control-store-product-records.js';
import { type CoreDb, openCoreReadDb, openWorkspaceReadDb, type WorkspaceDb } from './db.js';
import { applyNativeScopeMigrations } from './migrate.js';
import { SECURITY_TRIGGER_OWNER } from './security-trigger-port.js';

const journalTags = {
  core: ['0000_baseline'],
  workspace: ['0000_baseline'],
  user: ['0000_baseline'],
  app: ['0000_baseline'],
  'extensions/nanohost': ['0000_baseline'],
} as const;

// Signed owner partition from Appendix A. Keep this independent of the shipped DDL.
const k8Tables = {
  core: [
    'account',
    'audit_events',
    'control_execution_steps',
    'control_executions',
    'idempotency_requests',
    'openkit_access_tokens',
    'permission_decisions',
    'recurring_expired_ranges',
    'recurring_occurrences',
    'recurring_schedules',
    'scheduler_admission_entries',
    'scheduler_execution_attempts',
    'server_settings',
    'session',
    'users',
    'vault_grants',
    'vault_injection_plans',
    'vault_injection_receipts',
    'vault_references',
    'vault_use_records',
    'verification',
    'workspace_invitations',
    'workspace_members',
    'workspace_registry',
  ],
  'extensions/nanohost': [
    'agent_session_runtime_binding_image_digests',
    'agent_session_runtime_bindings',
    'harness_instance_records',
    'nanohost_integration_identities',
    'nanohost_runtime_targets',
    'nanohost_transport_tokens',
    'sandbox_runtime_records',
    'worker_backend_sessions',
    'worker_control_records',
    'worker_control_rejected_evidence',
    'worker_control_sequence_fingerprints',
    'worker_image_settlements',
    'worker_storage_bindings',
    'worker_storage_contributors',
  ],
} as const;

function compactSchemaSql(sql: string): string {
  return sql
    .replace(/[`"]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .trim();
}

function expectK8AttemptSchema(sqlite: Database.Database): void {
  const columns = [
    ['attempt_id', 'TEXT', 1, null, 1],
    ['queue_entry_id', 'TEXT', 1, null, 0],
    ['workspace_id', 'TEXT', 1, null, 0],
    ['thread_id', 'TEXT', 1, null, 0],
    ['turn_id', 'TEXT', 1, null, 0],
    ['agent_session_id', 'TEXT', 0, null, 0],
    ['input_ref', 'TEXT', 0, null, 0],
    ['binding_ref', 'TEXT', 0, null, 0],
    ['phase', 'TEXT', 1, null, 0],
    ['disposition', 'TEXT', 1, null, 0],
    ['operation_id', 'TEXT', 0, null, 0],
    ['deadline', 'TEXT', 0, null, 0],
    ['terminal_cause', 'TEXT', 0, null, 0],
    ['created_at', 'TEXT', 1, null, 0],
    ['schema_version', 'INTEGER', 1, '1', 0],
  ];
  expect(
    sqlite
      .prepare(`SELECT name,upper(type),"notnull",dflt_value,pk,hidden
      FROM pragma_table_xinfo('scheduler_execution_attempts') ORDER BY cid`)
      .raw()
      .all(),
    'K8 attempt columns'
  ).toEqual(columns.map((column) => [...column, 0]));

  const admissionScope = ['queue_entry_id', 'workspace_id', 'thread_id', 'turn_id'];
  expect(
    sqlite
      .prepare(`SELECT id,seq,"table","from","to",on_update,on_delete,match
      FROM pragma_foreign_key_list('scheduler_execution_attempts') ORDER BY id,seq`)
      .raw()
      .all()
  ).toEqual(
    admissionScope.map((name, seq) => [
      0,
      seq,
      'scheduler_admission_entries',
      name,
      name,
      'NO ACTION',
      'NO ACTION',
      'NONE',
    ])
  );
  const attemptSql = sqlite
    .prepare(`SELECT sql FROM sqlite_schema
    WHERE type='table' AND name='scheduler_execution_attempts'`)
    .pluck()
    .get() as string;
  const compactAttempt = compactSchemaSql(attemptSql);
  expect(compactAttempt.match(/CHECK\(/g)).toHaveLength(2);
  expect(compactAttempt.match(/CHECK\([^()]*\([^()]*\)\)/g)).toEqual([
    "CHECK(phase IN('open','closing','closed'))",
    "CHECK(disposition IN('not_accepted','accepted','unknown'))",
  ]);
  expect(
    sqlite
      .prepare(`SELECT origin,"unique",partial FROM pragma_index_list('scheduler_execution_attempts')
        WHERE origin <> 'c'`)
      .raw()
      .all()
  ).toEqual([['pk', 1, 0]]);
  const indexSql = sqlite
    .prepare(`SELECT sql FROM sqlite_schema
    WHERE type='index' AND tbl_name='scheduler_execution_attempts' AND sql IS NOT NULL
    ORDER BY name`)
    .pluck()
    .all() as string[];
  expect(indexSql.map(compactSchemaSql)).toEqual([
    'CREATE INDEX scheduler_execution_attempts_deadline_idx ON scheduler_execution_attempts(phase,deadline)',
    'CREATE INDEX scheduler_execution_attempts_lineage_idx ON scheduler_execution_attempts(workspace_id,thread_id,turn_id,agent_session_id,input_ref)',
    "CREATE UNIQUE INDEX scheduler_execution_attempts_live_session_idx ON scheduler_execution_attempts(agent_session_id)WHERE phase <> 'closed' AND agent_session_id IS NOT NULL",
    "CREATE UNIQUE INDEX scheduler_execution_attempts_live_thread_idx ON scheduler_execution_attempts(workspace_id,thread_id)WHERE phase <> 'closed'",
    "CREATE UNIQUE INDEX scheduler_execution_attempts_live_turn_idx ON scheduler_execution_attempts(turn_id)WHERE phase <> 'closed'",
    'CREATE INDEX scheduler_execution_attempts_queue_idx ON scheduler_execution_attempts(queue_entry_id)',
  ]);
  const admissionIndexes = sqlite
    .prepare(`SELECT sql FROM sqlite_schema WHERE type='index'
    AND name IN ('scheduler_admission_entries_attempt_scope_idx', 'scheduler_admission_entries_non_terminal_turn_idx')
    ORDER BY name`)
    .pluck()
    .all() as string[];
  expect(admissionIndexes.map(compactSchemaSql)).toEqual([
    'CREATE UNIQUE INDEX scheduler_admission_entries_attempt_scope_idx ON scheduler_admission_entries(queue_entry_id,workspace_id,thread_id,turn_id)',
    "CREATE UNIQUE INDEX scheduler_admission_entries_non_terminal_turn_idx ON scheduler_admission_entries(turn_id)WHERE status IN('queued','admitted')",
  ]);
}

describe('K8 exact Core and NanoHost schema', () => {
  it.each(['core', 'extensions/nanohost'] as const)('applies the signed %s journal', (scope) => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.pragma('foreign_keys = ON');
      applyNativeScopeMigrations(sqlite, scope);
      expect(
        sqlite
          .prepare(`SELECT name FROM sqlite_schema WHERE type='table'
        AND name NOT GLOB 'sqlite_*' AND name <> '__drizzle_migrations' ORDER BY name`)
          .pluck()
          .all()
      ).toEqual(k8Tables[scope]);
      const baseline = readFileSync(
        new URL(`../../drizzle/${scope}/0000_baseline.sql`, import.meta.url)
      );
      expect(sqlite.prepare('SELECT created_at,hash FROM __drizzle_migrations').all()).toEqual([
        { created_at: 1794664200000, hash: createHash('sha256').update(baseline).digest('hex') },
      ]);
      expect(sqlite.pragma('foreign_key_check')).toEqual([]);
      expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
      if (scope === 'core') expectK8AttemptSchema(sqlite);
    } finally {
      sqlite.close();
    }
  });
});

describe('fresh Core and Workspace setup', () => {
  it.each(['core', 'workspace', 'user', 'app', 'extensions/nanohost'] as const)(
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

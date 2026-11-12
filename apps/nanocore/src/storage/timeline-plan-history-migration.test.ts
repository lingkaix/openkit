import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { disposeTestStore } from '../test-support/store.js';
import {
  prepareControlKnowledgeAuthorityTransfer,
  readControlKnowledgeHead,
} from './control-store-knowledge.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { openWorkspaceDb } from './db.js';
import { readImmutableContentBytes } from './immutable-content-read.js';
import {
  applyNativeScopeMigrations,
  assertSupportedNativeLedger,
  listAppliedNativeMigrationIds,
} from './migrate.js';
import {
  nativeProductScope,
  readNativeThreadItem,
  withNativeThreadTimelineSnapshot,
} from './workspace-file-records.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await disposeTestStore(root);
});
type RetainedEntry = {
  id: string;
  revision: number;
  sequence: number;
  content_json: string;
  identity_json: string;
};

// Owner: Conversation Timeline Run Entries and Loading And Performance; the accepted Workspace-only W3 index.
// The original migration fixture may model predecessor DDL, but all product records and immutable bytes come from real publishers.
it('upgrades genuine Workspace plan and output revisions without changing their authority, and admits the new native prefix', async () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'plan-history-source-'));
  const targetRoot = mkdtempSync(join(tmpdir(), 'plan-history-predecessor-'));
  roots.push(sourceRoot, targetRoot);
  const store = await createDemoStore({ dataRoot: sourceRoot });
  const actor = { kind: 'user', id: FIXTURE_LOCAL_USER_ID } as const;
  const thread = await store.createThread(DEMO_WORKSPACE_ID, 'Retained plan history upgrade');
  const turn = await store.createTurn(
    DEMO_WORKSPACE_ID,
    thread.id,
    'Original plan and output',
    actor
  );
  const base = {
    owner: turn.owner,
    threadId: thread.id,
    turnId: turn.id,
    status: 'completed' as const,
    createdAt: '2026-11-12T12:00:00.000Z',
    completedAt: '2026-11-12T12:00:00.000Z',
  };
  const firstPlan = await store.createItem({
    ...base,
    id: allocateEntityId('it'),
    type: 'plan',
    title: 'Original plan',
    summary: null,
    steps: [{ id: 'a', title: 'Inspect', status: 'in_progress' }],
  });
  const originalOutput = await store.createItem({
    ...base,
    id: allocateEntityId('it'),
    type: 'command-execution',
    command: 'fixture.inspect',
    cwd: '.',
    output: 'Original retained output. '.repeat(12_000),
    exitCode: 0,
    durationMs: 1,
  });
  const currentOutput = await store.updateItem(originalOutput.id, {
    output: 'Revised retained output. '.repeat(13_000),
  });
  const secondRevision = await store.updateItem(firstPlan.id, {
    steps: [
      { id: 'a', title: 'Inspect', status: 'completed' },
      { id: 'b', title: 'Check', status: 'in_progress' },
    ],
  });
  const thirdRevision = await store.updateItem(firstPlan.id, {
    steps: [
      { id: 'a', title: 'Inspect', status: 'completed' },
      { id: 'b', title: 'Check', status: 'completed' },
    ],
  });
  const nextPlan = await store.createItem({
    ...base,
    id: allocateEntityId('it'),
    type: 'plan',
    title: 'Next recorded plan',
    summary: null,
    steps: [{ id: 'c', title: 'Report', status: 'in_progress' }],
  });
  await shutdownControlStoreWorkerClient();
  const sourceScope = nativeProductScope(sourceRoot, turn.owner);
  const sourceDb = new Database(sourceScope.path, { readonly: true });
  const targetOwnerRoot = join(targetRoot, 'workspaces', DEMO_WORKSPACE_ID);
  cpSync(join(sourceRoot, 'workspaces', DEMO_WORKSPACE_ID), targetOwnerRoot, { recursive: true });
  for (const suffix of ['', '-wal', '-shm'])
    rmSync(join(targetOwnerRoot, 'db', `workspace.sqlite${suffix}`), { force: true });
  const target = openWorkspaceDb(targetRoot, DEMO_WORKSPACE_ID);
  let sourceWorkspace: ReturnType<typeof openWorkspaceDb> | undefined;
  try {
    const migrationRoot = new URL('../../drizzle/workspace/', import.meta.url);
    const journal = JSON.parse(
      readFileSync(new URL('meta/_journal.json', migrationRoot), 'utf8')
    ) as {
      entries: { tag: string; when: number }[];
    };
    const tag = '0025_timeline_plan_history';
    const index = journal.entries.findIndex((entry) => entry.tag === tag);
    expect(index, 'The released Workspace plan-history migration must exist').toBeGreaterThan(0);
    const predecessor = join(targetRoot, 'predecessor-journal');
    mkdirSync(join(predecessor, 'meta'), { recursive: true });
    const entries = journal.entries.slice(0, index);
    for (const entry of entries)
      copyFileSync(
        new URL(`${entry.tag}.sql`, migrationRoot),
        join(predecessor, `${entry.tag}.sql`)
      );
    writeFileSync(join(predecessor, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
    sourceWorkspace = openWorkspaceDb(sourceRoot, DEMO_WORKSPACE_ID);
    const knowledgeBaseId = readDefaultKnowledgeBaseId({
      dataRoot: sourceRoot,
      scope: { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID },
    });
    const transfer = prepareControlKnowledgeAuthorityTransfer({
      db: target,
      heads: [readControlKnowledgeHead(sourceWorkspace, knowledgeBaseId)!],
      proposals: [],
    });
    applyNativeScopeMigrations(target.sqlite, 'workspace', predecessor, transfer);
    const tables = [
      'control_workspaces',
      'control_threads',
      'control_agent_sessions',
      'control_turns',
      'control_product_entries',
    ];
    // Copy original owner-created rows in their original publication order, exactly as the existing migration fixture does.
    target.sqlite.transaction(() => {
      for (const table of tables) {
        const names = (
          target.sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
        ).map((column) => column.name);
        const fields = names.map((name) => `"${name}"`).join(',');
        const insert = target.sqlite.prepare(
          `INSERT INTO ${table}(${fields}) VALUES(${names.map(() => '?').join(',')})`
        );
        const sourceFields = names
          .map((name) =>
            table === 'control_product_entries' && name === 'is_current' ? '0' : `"${name}"`
          )
          .join(',');
        // Existing current-revision triggers select each incoming revision; never fabricate a second current revision.
        for (const row of sourceDb
          .prepare(`SELECT ${sourceFields} FROM ${table} ORDER BY rowid`)
          .raw()
          .all() as unknown[][])
          insert.run(...row);
      }
    })();
    const stableRows = () =>
      Object.fromEntries(
        tables.map((table) => [
          table,
          target.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        ])
      );
    const before = stableRows();
    for (const table of tables)
      expect(before[table]).toEqual(
        sourceDb.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
      );
    const retained = target.sqlite
      .prepare(
        "SELECT id,revision,sequence,content_json,identity_json FROM control_product_entries WHERE kind='item' ORDER BY sequence"
      )
      .all() as RetainedEntry[];
    expect(retained).toHaveLength(6);
    const expectedPlans = [firstPlan, secondRevision, thirdRevision, nextPlan];
    const plans = retained.filter((row) => JSON.parse(row.identity_json).type === 'plan');
    expect(plans.map((row) => [row.id, row.revision])).toEqual([
      [firstPlan.id, 1],
      [firstPlan.id, 2],
      [firstPlan.id, 3],
      [nextPlan.id, 1],
    ]);
    expect(JSON.parse(plans[0]!.content_json).reference.representation).toBe('inline');
    const fileRows = retained.filter(
      (row) => JSON.parse(row.content_json).reference.representation !== 'inline'
    );
    expect(fileRows.map((row) => [row.id, row.revision])).toEqual([
      [originalOutput.id, 1],
      [originalOutput.id, 2],
    ]);
    const fileBytes = fileRows.map((row) =>
      Buffer.from(
        readImmutableContentBytes(
          sourceScope.contentMount,
          turn.owner,
          JSON.parse(row.content_json),
          2_000_000
        )
      )
    );
    const schemaIndexes = () =>
      target.sqlite
        .prepare("SELECT name,sql FROM sqlite_schema WHERE type='index' AND sql IS NOT NULL")
        .all() as { name: string; sql: string }[];
    const oldIndexes = new Set(schemaIndexes().map((row) => row.name));
    expect(listAppliedNativeMigrationIds(target.sqlite, 'workspace')).not.toContain(
      `workspace_${tag}`
    );
    assertSupportedNativeLedger(target.sqlite, 'workspace');
    const oldLedger = target.sqlite.prepare('SELECT * FROM __drizzle_migrations ORDER BY id').all();

    // Expected upgrade boundary: the existing predecessor is supported but lacks this exact history access path.
    applyNativeScopeMigrations(target.sqlite, 'workspace');
    expect(listAppliedNativeMigrationIds(target.sqlite, 'workspace')).toContain(`workspace_${tag}`);
    const ledger = target.sqlite.prepare('SELECT * FROM __drizzle_migrations ORDER BY id').all();
    expect(ledger.slice(0, oldLedger.length)).toEqual(oldLedger);
    expect(ledger).toHaveLength(journal.entries.length);
    expect(stableRows()).toEqual(before);
    const added = schemaIndexes().filter((row) => !oldIndexes.has(row.name));
    const history = added.filter((row) =>
      row.sql.replace(/[\s"`]/g, '').includes("json_extract(identity_json,'$.type')")
    );
    expect(history).toHaveLength(1);
    const accessPath = history[0]!;
    expect(accessPath.sql.replace(/[\s"`]/g, '')).toContain("WHEREkind='item'");
    const keys = target.sqlite.prepare(`PRAGMA index_xinfo("${accessPath.name}")`).all() as {
      name: string | null;
      cid: number;
      key: number;
    }[];
    expect(keys.filter((key) => key.key === 1).map((key) => [key.name, key.cid === -2])).toEqual([
      ['turn_id', false],
      [null, true],
      ['sequence', false],
    ]);
    const query =
      "SELECT sequence,revision FROM control_product_entries WHERE kind='item' AND turn_id=? AND json_extract(identity_json,'$.type')='plan' ORDER BY sequence DESC LIMIT 11";
    const explanation = target.sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all(turn.id) as {
      detail: string;
    }[];
    expect(explanation.some((row) => row.detail.includes(accessPath.name))).toBe(true);
    expect(explanation.some((row) => /TEMP B-TREE/i.test(row.detail))).toBe(false);
    const targetScope = nativeProductScope(targetRoot, turn.owner);
    for (const [i, row] of fileRows.entries()) {
      expect(
        Buffer.from(
          readImmutableContentBytes(
            targetScope.contentMount,
            turn.owner,
            JSON.parse(row.content_json),
            2_000_000
          )
        )
      ).toEqual(fileBytes[i]);
    }
    const upgraded = withNativeThreadTimelineSnapshot(targetScope, thread.id, (snapshot) =>
      snapshot.planRevisions(turn.id)
    );
    expect(upgraded.map((row) => ({ sequence: row.sequence, revision: row.revision }))).toEqual(
      plans.map((row) => ({ sequence: row.sequence, revision: row.revision }))
    );
    expect(upgraded.map((row) => row.item)).toEqual(expectedPlans);
    expect(readNativeThreadItem(targetScope, thread.id, originalOutput.id)).toEqual(currentOutput);
    const beforeRepeat = target.sqlite.serialize();
    applyNativeScopeMigrations(target.sqlite, 'workspace');
    expect(target.sqlite.serialize()).toEqual(beforeRepeat);

    // The real runtime opening owns readiness and native-prefix acceptance, not a test-maintained prefix list.
    await getControlStoreWorkerClient().open({
      database: `workspace:${targetScope.path}`,
      path: targetScope.path,
      dataRoot: targetRoot,
      create: false,
      initialize: 'workspace',
      productOwner: turn.owner,
      contentMount: targetScope.contentMount,
    });
    expect(
      withNativeThreadTimelineSnapshot(targetScope, thread.id, (snapshot) =>
        snapshot.planRevisions(turn.id)
      ).map((row) => row.item)
    ).toEqual(expectedPlans);
  } finally {
    await shutdownControlStoreWorkerClient();
    sourceWorkspace?.sqlite.close();
    target.sqlite.close();
    sourceDb.close();
  }
}, 120_000);

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, expect, it } from 'vitest';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { disposeTestStore } from '../test-support/store.js';
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
// All product records and immutable bytes come from the real current publishers.
it('reads genuine current Workspace plan history through its covering index and native baseline owner', async () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'plan-history-source-'));
  roots.push(sourceRoot);
  const store = await createDemoStore({ dataRoot: sourceRoot });
  const actor = { kind: 'user', id: FIXTURE_LOCAL_USER_ID } as const;
  const thread = await store.createThread(DEMO_WORKSPACE_ID, 'Fresh plan history');
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
  const target = openWorkspaceDb(sourceRoot, DEMO_WORKSPACE_ID);
  try {
    const tables = [
      'control_workspaces',
      'control_threads',
      'control_agent_sessions',
      'control_turns',
      'control_product_entries',
    ];
    const stableRows = () =>
      Object.fromEntries(
        tables.map((table) => [
          table,
          target.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        ])
      );
    const before = stableRows();
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
    assertSupportedNativeLedger(target.sqlite, 'workspace');
    expect(listAppliedNativeMigrationIds(target.sqlite, 'workspace')).toEqual([
      'workspace_0000_baseline',
    ]);
    applyNativeScopeMigrations(target.sqlite, 'workspace');
    expect(stableRows()).toEqual(before);
    const history = schemaIndexes().filter(
      (row) => row.name === 'control_items_turn_history_type_idx'
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
    const targetScope = nativeProductScope(sourceRoot, turn.owner);
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
    const current = withNativeThreadTimelineSnapshot(targetScope, thread.id, (snapshot) =>
      snapshot.planRevisions(turn.id)
    );
    expect(current.map((row) => ({ sequence: row.sequence, revision: row.revision }))).toEqual(
      plans.map((row) => ({ sequence: row.sequence, revision: row.revision }))
    );
    expect(current.map((row) => row.item)).toEqual(expectedPlans);
    expect(readNativeThreadItem(targetScope, thread.id, originalOutput.id)).toEqual(currentOutput);
    const beforeRepeat = target.sqlite.serialize();
    applyNativeScopeMigrations(target.sqlite, 'workspace');
    expect(target.sqlite.serialize()).toEqual(beforeRepeat);

    // Close the explicit stopped-scope handle before the original native owner reopens it.
    target.sqlite.close();
    await getControlStoreWorkerClient().open({
      database: `workspace:${targetScope.path}`,
      path: targetScope.path,
      dataRoot: sourceRoot,
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
    if (target.sqlite.open) target.sqlite.close();
  }
}, 120_000);

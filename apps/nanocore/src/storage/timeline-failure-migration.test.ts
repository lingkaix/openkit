import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openWorkspaceDb } from './db.js';
import { readImmutableContentBytes } from './immutable-content-read.js';
import { applyNativeScopeMigrations, listAppliedNativeMigrationIds } from './migrate.js';
import {
  nativeProductScope,
  readNativeThreadItem,
  withNativeThreadTimelineSnapshot,
} from './workspace-file-records.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await disposeTestStore(root);
});
type Entry = {
  id: string;
  revision: number;
  content_json: string;
  identity_json: string;
  read_metadata_json: string;
};

// Owner: Conversation Timeline, Run Entries and Loading And Performance: Workspace-scoped statistics.
// Failure read metadata is a verified projection; original Item authority is unchanged.
it('carries Workspace failure metadata from verified inline and file-backed revisions, or rolls back the complete migration', async () => {
  const kind = 'workspace' as const;
  const sourceRoot = mkdtempSync(join(tmpdir(), 'failure-source-'));
  const targetRoot = mkdtempSync(join(tmpdir(), 'failure-predecessor-'));
  roots.push(sourceRoot, targetRoot);
  const store = await createDemoStore({ dataRoot: sourceRoot });
  const actor = { kind: 'user' as const, id: FIXTURE_LOCAL_USER_ID };
  const thread = await store.createThread(DEMO_WORKSPACE_ID, 'Failure migration');
  const turn = await store.createTurn(DEMO_WORKSPACE_ID, thread.id, 'Original failures', actor);
  const createItem = store.createItem.bind(store);
  const updateItem = store.updateItem.bind(store);
  const base = {
    owner: turn.owner,
    threadId: thread.id,
    turnId: turn.id,
    status: 'completed' as const,
    createdAt: '2026-11-12T05:20:00.000Z',
    completedAt: '2026-11-12T05:20:00.000Z',
  };
  const recovered = await createItem({
    ...base,
    id: allocateEntityId('it'),
    type: 'command-execution',
    status: 'failed',
    command: 'first attempt',
    cwd: '.',
    output: 'Original inline failure',
    exitCode: 1,
    durationMs: 1,
  });
  await updateItem(recovered.id, {
    status: 'completed',
    exitCode: 0,
    output: 'Current successful revision',
  });
  const nonzero = await createItem({
    ...base,
    id: allocateEntityId('it'),
    type: 'command-execution',
    command: 'recorded exit failure',
    cwd: '.',
    output: 'Recorded nonzero exit',
    exitCode: 7,
    durationMs: 1,
  });
  const large = await createItem({
    ...base,
    id: allocateEntityId('it'),
    type: 'tool-call',
    tool: 'fixture.inspect',
    server: null,
    arguments: {},
    result: 'Original file-backed result. '.repeat(12_000),
    error: 'Recorded tool error',
    durationMs: 1,
  });
  await shutdownControlStoreWorkerClient();
  const sourceScope = nativeProductScope(sourceRoot, turn.owner);
  const sourceDb = new Database(sourceScope.path, { readonly: true });
  const ownerRoot = join(sourceRoot, 'workspaces', DEMO_WORKSPACE_ID);
  const targetOwnerRoot = join(targetRoot, 'workspaces', DEMO_WORKSPACE_ID);
  cpSync(ownerRoot, targetOwnerRoot, { recursive: true });
  for (const suffix of ['', '-wal', '-shm'])
    rmSync(join(targetOwnerRoot, 'db', `workspace.sqlite${suffix}`), { force: true });
  const target = openWorkspaceDb(targetRoot, DEMO_WORKSPACE_ID);
  let sourceWorkspace: ReturnType<typeof openWorkspaceDb> | undefined;
  try {
    const migrationRoot = new URL(`../../drizzle/${kind}/`, import.meta.url);
    const journal = JSON.parse(
      readFileSync(new URL('meta/_journal.json', migrationRoot), 'utf8')
    ) as { entries: { tag: string }[] };
    const tag = '0024_thread_failure_counts';
    const migrationIndex = journal.entries.findIndex((entry) => entry.tag === tag);
    expect(
      migrationIndex,
      `The released ${kind} failure-count migration must exist`
    ).toBeGreaterThan(0);
    const entries = journal.entries.slice(0, migrationIndex);
    const predecessor = join(targetRoot, 'predecessor-journal');
    mkdirSync(join(predecessor, 'meta'), { recursive: true });
    for (const entry of entries)
      copyFileSync(
        new URL(`${entry.tag}.sql`, migrationRoot),
        join(predecessor, `${entry.tag}.sql`)
      );
    writeFileSync(join(predecessor, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
    sourceWorkspace = openWorkspaceDb(sourceRoot, DEMO_WORKSPACE_ID);
    const kb = readDefaultKnowledgeBaseId({
      dataRoot: sourceRoot,
      scope: { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID },
    });
    const transfer = prepareControlKnowledgeAuthorityTransfer({
      db: target,
      heads: [readControlKnowledgeHead(sourceWorkspace, kb)!],
      proposals: [],
    });
    applyNativeScopeMigrations(target.sqlite, kind, predecessor, transfer);
    const tables = [
      'control_workspaces',
      'control_threads',
      'control_agent_sessions',
      'control_turns',
      'control_product_entries',
    ];
    const stableColumns = new Map<string, string[]>();
    target.sqlite.transaction(() => {
      for (const table of tables) {
        const names = (
          target.sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
        ).map((column) => column.name);
        stableColumns.set(
          table,
          names.filter(
            (name) => table !== 'control_product_entries' || name !== 'read_metadata_json'
          )
        );
        const fields = names.map((name) => `"${name}"`).join(',');
        const insert = target.sqlite.prepare(
          `INSERT INTO ${table}(${fields}) VALUES(${names.map(() => '?').join(',')})`
        );
        // The predecessor already owns current-revision triggers. Replay publication order with
        // an unselected incoming row; each trigger selects it after clearing its prior revision.
        const sourceFields = names
          .map((name) =>
            table === 'control_product_entries' && name === 'is_current' ? '0' : `"${name}"`
          )
          .join(',');
        for (const row of sourceDb
          .prepare(`SELECT ${sourceFields} FROM ${table} ORDER BY rowid`)
          .raw()
          .all() as unknown[][])
          insert.run(...row);
      }
      // Emulate the accepted predecessor projection only; canonical bodies and identities stay owner-created.
      target.sqlite
        .prepare(
          "UPDATE control_product_entries SET read_metadata_json=json_remove(read_metadata_json,'$.failed') WHERE kind='item'"
        )
        .run();
    })();
    const stableRows = () =>
      Object.fromEntries(
        tables.map((table) => [
          table,
          target.sqlite
            .prepare(`SELECT ${stableColumns.get(table)!.join(',')} FROM ${table} ORDER BY rowid`)
            .all(),
        ])
      );
    const originals = stableRows();
    const itemRows = () =>
      target.sqlite
        .prepare(
          "SELECT id,revision,content_json,identity_json,read_metadata_json FROM control_product_entries WHERE kind='item' ORDER BY id,revision"
        )
        .all() as Entry[];
    const oldMetadata = itemRows();
    expect(oldMetadata).toHaveLength(4);
    for (const row of oldMetadata)
      expect(JSON.parse(row.read_metadata_json).failed).toBeUndefined();
    const inline = oldMetadata.find((row) => row.id === recovered.id && row.revision === 1)!;
    const file = oldMetadata.find((row) => row.id === large.id)!;
    expect(JSON.parse(inline.content_json).reference.representation).toBe('inline');
    const fileContent = JSON.parse(file.content_json);
    expect(fileContent.reference.representation).not.toBe('inline');
    const originalFileBytes = Buffer.from(
      readImmutableContentBytes(sourceScope.contentMount, turn.owner, fileContent, 2_000_000)
    );
    const targetScope = nativeProductScope(targetRoot, turn.owner);
    const filePath = join(targetScope.contentMount.root, fileContent.reference.locator.path);
    const migrationState = () => ({
      rows: target.sqlite.prepare('SELECT * FROM control_product_entries ORDER BY rowid').all(),
      ledger: listAppliedNativeMigrationIds(target.sqlite, kind),
      schema: target.sqlite
        .prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name')
        .all(),
    });
    const corrupt = JSON.parse(inline.content_json);
    corrupt.reference.contentDigest = `sha256:${'0'.repeat(64)}`;
    target.sqlite
      .prepare(
        "UPDATE control_product_entries SET content_json=? WHERE kind='item' AND id=? AND revision=1"
      )
      .run(JSON.stringify(corrupt), recovered.id);
    const refusedInline = migrationState();
    expect(() => applyNativeScopeMigrations(target.sqlite, kind)).toThrow();
    expect(migrationState()).toEqual(refusedInline);
    expect(listAppliedNativeMigrationIds(target.sqlite, kind)).not.toContain(`${kind}_${tag}`);
    target.sqlite
      .prepare(
        "UPDATE control_product_entries SET content_json=? WHERE kind='item' AND id=? AND revision=1"
      )
      .run(inline.content_json, recovered.id);
    const damaged = Buffer.from(originalFileBytes);
    damaged[0] = damaged[0]! ^ 1;
    // Fault injection changes only this disposable copied body, then restores its immutable mode.
    const originalMode = statSync(filePath).mode & 0o777;
    chmodSync(filePath, 0o600);
    writeFileSync(filePath, damaged);
    chmodSync(filePath, originalMode);
    const refusedFile = migrationState();
    expect(() => applyNativeScopeMigrations(target.sqlite, kind)).toThrow();
    expect(migrationState()).toEqual(refusedFile);
    expect(listAppliedNativeMigrationIds(target.sqlite, kind)).not.toContain(`${kind}_${tag}`);
    chmodSync(filePath, 0o600);
    writeFileSync(filePath, originalFileBytes);
    chmodSync(filePath, originalMode);
    applyNativeScopeMigrations(target.sqlite, kind);
    expect(listAppliedNativeMigrationIds(target.sqlite, kind)).toContain(`${kind}_${tag}`);
    expect(stableRows()).toEqual(originals);
    const expected = new Map([
      [`${recovered.id}:1`, true],
      [`${recovered.id}:2`, false],
      [`${nonzero.id}:1`, true],
      [`${large.id}:1`, true],
    ]);
    for (const row of itemRows()) {
      const metadata = JSON.parse(row.read_metadata_json);
      expect(metadata.failed).toBe(expected.get(`${row.id}:${row.revision}`));
      const { failed: _failed, ...retainedMetadata } = metadata;
      expect(retainedMetadata).toEqual(
        JSON.parse(
          oldMetadata.find((old) => old.id === row.id && old.revision === row.revision)!
            .read_metadata_json
        )
      );
    }
    expect(
      target.sqlite
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='index' AND name='control_items_turn_failure_idx'"
        )
        .get()
    ).toEqual({ name: 'control_items_turn_failure_idx' });
    expect(readFileSync(filePath)).toEqual(originalFileBytes);
    const failures = withNativeThreadTimelineSnapshot(targetScope, thread.id, (snapshot) =>
      snapshot.failures(turn.id)
    );
    expect(failures['command-execution']).toBe(1);
    expect(failures['tool-call']).toBe(1);
    expect(Object.values(failures).reduce((total, count) => total + count, 0)).toBe(2);
    expect(readNativeThreadItem(targetScope, thread.id, large.id)).toEqual(large);
    expect(readNativeThreadItem(targetScope, thread.id, recovered.id)).toMatchObject({
      status: 'completed',
      exitCode: 0,
    });
    const beforeReapply = target.sqlite.serialize();
    applyNativeScopeMigrations(target.sqlite, kind);
    expect(target.sqlite.serialize()).toEqual(beforeReapply);
  } finally {
    sourceWorkspace?.sqlite.close();
    target.sqlite.close();
    sourceDb.close();
  }
}, 120_000);

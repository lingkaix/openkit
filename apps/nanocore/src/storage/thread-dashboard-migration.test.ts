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
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyNativeScopeMigrations, listAppliedNativeMigrationIds } from './migrate.js';
import { nativeProductScope, readNativeThreadItem } from './workspace-file-records.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await disposeTestStore(root);
});

it.each(['core', 'workspace'] as const)(
  'carries %s verified inline and file-backed bodies through the read-index migration atomically',
  async (kind) => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'dashboard-source-'));
    const targetRoot = mkdtempSync(join(tmpdir(), 'dashboard-predecessor-'));
    roots.push(sourceRoot, targetRoot);
    const store = await createDemoStore({ dataRoot: sourceRoot });
    const actor = { kind: 'user' as const, id: FIXTURE_LOCAL_USER_ID };
    const thread =
      kind === 'core'
        ? await store.createServerThread('Read migration')
        : await store.createThread(DEMO_WORKSPACE_ID, 'Read migration');
    const turn =
      kind === 'core'
        ? await store.createServerTurn(thread.id, 'Original body', actor)
        : await store.createTurn(DEMO_WORKSPACE_ID, thread.id, 'Original body', actor);
    const createItem =
      kind === 'core' ? store.createServerItem.bind(store) : store.createItem.bind(store);
    const small = await createItem({
      id: allocateEntityId('it'),
      owner: turn.owner,
      threadId: thread.id,
      turnId: turn.id,
      type: 'assistant-message',
      text: 'Original small note',
      status: 'in_progress',
      createdAt: '2026-11-08T12:00:00.000Z',
      completedAt: null,
    });
    await (kind === 'core' ? store.updateServerItem.bind(store) : store.updateItem.bind(store))(
      small.id,
      {
        text: 'Current small note',
        status: 'completed',
        completedAt: '2026-11-08T12:00:01.000Z',
      }
    );
    const requestId = crypto.randomUUID();
    const large = await createItem({
      id: allocateEntityId('it'),
      owner: turn.owner,
      threadId: thread.id,
      turnId: turn.id,
      type: 'approval-request',
      approvalRequestId: requestId,
      kind: 'permission',
      title: 'Retained file-backed request',
      description: 'Original exact effect. '.repeat(5000),
      status: 'completed',
      createdAt: '2026-11-08T12:00:02.000Z',
      completedAt: '2026-11-08T12:00:02.000Z',
    });
    await shutdownControlStoreWorkerClient();
    const sourceScope = nativeProductScope(sourceRoot, turn.owner);
    const sourceDb = new Database(sourceScope.path, { readonly: true });
    const ownerRoot =
      kind === 'core'
        ? join(sourceRoot, 'server')
        : join(sourceRoot, 'workspaces', DEMO_WORKSPACE_ID);
    const targetOwnerRoot =
      kind === 'core'
        ? join(targetRoot, 'server')
        : join(targetRoot, 'workspaces', DEMO_WORKSPACE_ID);
    cpSync(ownerRoot, targetOwnerRoot, { recursive: true });
    for (const suffix of ['', '-wal', '-shm'])
      rmSync(
        join(
          targetOwnerRoot,
          'db',
          kind === 'core' ? `core.sqlite${suffix}` : `workspace.sqlite${suffix}`
        ),
        { force: true }
      );
    const target =
      kind === 'core' ? openCoreDb(targetRoot) : openWorkspaceDb(targetRoot, DEMO_WORKSPACE_ID);
    let sourceWorkspace: ReturnType<typeof openWorkspaceDb> | undefined;
    try {
      const migrationRoot = new URL(`../../drizzle/${kind}/`, import.meta.url);
      const journal = JSON.parse(
        readFileSync(new URL('meta/_journal.json', migrationRoot), 'utf8')
      ) as { entries: { tag: string }[] };
      const entries = journal.entries.slice(0, -1);
      const predecessor = join(targetRoot, 'predecessor-journal');
      mkdirSync(join(predecessor, 'meta'), { recursive: true });
      for (const entry of entries)
        copyFileSync(
          new URL(`${entry.tag}.sql`, migrationRoot),
          join(predecessor, `${entry.tag}.sql`)
        );
      writeFileSync(
        join(predecessor, 'meta/_journal.json'),
        JSON.stringify({ ...journal, entries })
      );
      let transfer: ReturnType<typeof prepareControlKnowledgeAuthorityTransfer> | undefined;
      if (target.scope === 'workspace') {
        sourceWorkspace = openWorkspaceDb(sourceRoot, DEMO_WORKSPACE_ID);
        const kb = readDefaultKnowledgeBaseId({
          dataRoot: sourceRoot,
          scope: { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID },
        });
        const head = readControlKnowledgeHead(sourceWorkspace, kb)!;
        transfer = prepareControlKnowledgeAuthorityTransfer({
          db: target,
          heads: [head],
          proposals: [],
        });
      }
      applyNativeScopeMigrations(target.sqlite, kind, predecessor, transfer);
      const tables = [
        ...(kind === 'workspace' ? ['control_workspaces'] : []),
        'control_threads',
        ...(kind === 'workspace' ? ['control_agent_sessions'] : []),
        'control_turns',
        'control_product_entries',
      ];
      const columns = new Map<string, string[]>();
      target.sqlite.transaction(() => {
        for (const table of tables) {
          const names = (
            target.sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
          ).map((row) => row.name);
          columns.set(table, names);
          const fields = names.map((name) => `"${name}"`).join(',');
          const insert = target.sqlite.prepare(
            `INSERT INTO ${table}(${fields}) VALUES(${names.map(() => '?').join(',')})`
          );
          for (const row of sourceDb
            .prepare(`SELECT ${fields} FROM ${table} ORDER BY rowid`)
            .raw()
            .all() as unknown[][])
            insert.run(...row);
        }
      })();
      const originalRows = () =>
        Object.fromEntries(
          tables.map((table) => [
            table,
            target.sqlite
              .prepare(`SELECT ${columns.get(table)!.join(',')} FROM ${table} ORDER BY rowid`)
              .all(),
          ])
        );
      const original = originalRows();
      const saved = target.sqlite
        .prepare(
          "SELECT content_json FROM control_product_entries WHERE kind='item' AND id=? AND revision=1"
        )
        .get(small.id) as { content_json: string };
      const corrupted = JSON.parse(saved.content_json);
      expect(corrupted.reference.representation).toBe('inline');
      corrupted.reference.contentDigest = `sha256:${'0'.repeat(64)}`;
      target.sqlite
        .prepare(
          "UPDATE control_product_entries SET content_json=? WHERE kind='item' AND id=? AND revision=1"
        )
        .run(JSON.stringify(corrupted), small.id);
      const refusedRows = originalRows();
      expect(() => applyNativeScopeMigrations(target.sqlite, kind)).toThrow();
      expect(originalRows()).toEqual(refusedRows);
      expect(
        (
          target.sqlite.prepare('PRAGMA table_info(control_product_entries)').all() as {
            name: string;
          }[]
        ).map((row) => row.name)
      ).not.toContain('read_metadata_json');
      expect(listAppliedNativeMigrationIds(target.sqlite, kind).at(-1)).toBe(
        `${kind}_${entries.at(-1)!.tag}`
      );
      target.sqlite
        .prepare(
          "UPDATE control_product_entries SET content_json=? WHERE kind='item' AND id=? AND revision=1"
        )
        .run(saved.content_json, small.id);
      const identityRow = target.sqlite
        .prepare(
          "SELECT identity_json FROM control_product_entries WHERE kind='item' AND id=? AND revision=1"
        )
        .get(small.id) as { identity_json: string };
      const badIdentity = { ...JSON.parse(identityRow.identity_json), type: 'command-execution' };
      target.sqlite
        .prepare(
          "UPDATE control_product_entries SET identity_json=? WHERE kind='item' AND id=? AND revision=1"
        )
        .run(JSON.stringify(badIdentity), small.id);
      const contradictoryRows = originalRows();
      expect(() => applyNativeScopeMigrations(target.sqlite, kind)).toThrow();
      expect(originalRows()).toEqual(contradictoryRows);
      expect(listAppliedNativeMigrationIds(target.sqlite, kind).at(-1)).toBe(
        `${kind}_${entries.at(-1)!.tag}`
      );
      target.sqlite
        .prepare(
          "UPDATE control_product_entries SET identity_json=? WHERE kind='item' AND id=? AND revision=1"
        )
        .run(identityRow.identity_json, small.id);
      applyNativeScopeMigrations(target.sqlite, kind);
      expect(originalRows()).toEqual(original);
      const rows = target.sqlite
        .prepare(
          "SELECT id,revision,is_current,item_order,turn_admission_order,read_metadata_json,content_json FROM control_product_entries WHERE kind='item' AND id IN (?,?) ORDER BY id,revision"
        )
        .all(small.id, large.id) as {
        id: string;
        revision: number;
        is_current: number;
        item_order: number;
        turn_admission_order: number;
        read_metadata_json: string;
        content_json: string;
      }[];
      const smallRows = rows.filter((row) => row.id === small.id);
      expect(smallRows.map((row) => row.is_current)).toEqual([0, 1]);
      expect(smallRows[0]!.item_order).toBe(smallRows[1]!.item_order);
      const file = rows.find((row) => row.id === large.id)!;
      expect(JSON.parse(file.content_json).reference.representation).not.toBe('inline');
      expect(JSON.parse(file.read_metadata_json)).toMatchObject({ requestId, status: 'completed' });
      expect(file.turn_admission_order).toBeGreaterThan(0);
      const targetScope = nativeProductScope(targetRoot, turn.owner);
      expect(readNativeThreadItem(targetScope, thread.id, large.id)).toEqual(large);
      expect(readNativeThreadItem(targetScope, thread.id, small.id)?.status).toBe('completed');
      const before = target.sqlite.serialize();
      applyNativeScopeMigrations(target.sqlite, kind);
      expect(target.sqlite.serialize()).toEqual(before);
    } finally {
      sourceWorkspace?.sqlite.close();
      target.sqlite.close();
      sourceDb.close();
    }
  }
);

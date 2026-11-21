import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, expect, it, onTestFinished } from 'vitest';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import {
  createTestServerThread,
  createTestServerWorkStore,
} from '../test-support/server-work-store.js';
import {
  createTestCoreDb,
  disposeTestStore,
  shutdownTestStoreWorker,
} from '../test-support/store.js';
import { openWorkspaceDb, serverStoragePath } from './db.js';
import {
  applyNativeScopeMigrations,
  applyServerOwnerJournal,
  listAppliedNativeMigrationIds,
} from './migrate.js';
import { nativeProductScope, readNativeThreadItem } from './workspace-file-records.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await disposeTestStore(root);
});

it.each(['server-work', 'workspace'] as const)(
  'reads %s current inline and file-backed revisions from the fresh baseline',
  async (kind) => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'dashboard-source-'));
    roots.push(sourceRoot);
    const coreDb = createTestCoreDb(sourceRoot);
    onTestFinished(() => coreDb.sqlite.close());
    const store =
      kind === 'server-work'
        ? await createTestServerWorkStore(coreDb)
        : await createDemoStore({ dataRoot: sourceRoot });
    if (kind === 'server-work') ensureLocalUser(coreDb);
    const actor = { kind: 'user' as const, id: FIXTURE_LOCAL_USER_ID };
    const thread =
      kind === 'server-work'
        ? await createTestServerThread(store, coreDb, 'Fresh read metadata')
        : await store.createThread(DEMO_WORKSPACE_ID, 'Fresh read metadata');
    const turn =
      kind === 'server-work'
        ? await store.createServerTurn(thread.id, 'Original body', actor)
        : await store.createTurn(DEMO_WORKSPACE_ID, thread.id, 'Original body', actor);
    const createItem =
      kind === 'server-work' ? store.createServerItem.bind(store) : store.createItem.bind(store);
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
    await (kind === 'server-work'
      ? store.updateServerItem.bind(store)
      : store.updateItem.bind(store))(small.id, {
      text: 'Current small note',
      status: 'completed',
      completedAt: '2026-11-08T12:00:01.000Z',
    });
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
    await shutdownTestStoreWorker();
    const server = kind === 'server-work';
    const target = server
      ? new Database(serverStoragePath(sourceRoot, 'server-work'), { fileMustExist: true })
      : openWorkspaceDb(sourceRoot, DEMO_WORKSPACE_ID).sqlite;
    try {
      if (server) {
        expect(target.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get()).toEqual({
          n: 1,
        });
      } else {
        expect(listAppliedNativeMigrationIds(target, 'workspace')).toEqual([
          'workspace_0000_baseline',
        ]);
      }
      const rows = target
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
      const before = target.serialize();
      if (server) applyServerOwnerJournal(target, 'server-work', () => new Database(':memory:'));
      else applyNativeScopeMigrations(target, 'workspace');
      expect(target.serialize()).toEqual(before);
      const targetScope = server
        ? (await createTestServerWorkStore(coreDb)).getServerWorkReadScope()
        : nativeProductScope(sourceRoot, turn.owner);
      expect(readNativeThreadItem(targetScope, thread.id, large.id)).toEqual(large);
      expect(readNativeThreadItem(targetScope, thread.id, small.id)?.status).toBe('completed');
    } finally {
      target.close();
    }
  }
);

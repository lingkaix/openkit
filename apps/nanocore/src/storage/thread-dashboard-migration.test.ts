import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, expect, it } from 'vitest';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { disposeTestStore } from '../test-support/store.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyNativeScopeMigrations, listAppliedNativeMigrationIds } from './migrate.js';
import { nativeProductScope, readNativeThreadItem } from './workspace-file-records.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await disposeTestStore(root);
});

it.each(['core', 'workspace'] as const)(
  'reads %s current inline and file-backed revisions from the fresh baseline',
  async (kind) => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'dashboard-source-'));
    roots.push(sourceRoot);
    const store = await createDemoStore({ dataRoot: sourceRoot });
    const actor = { kind: 'user' as const, id: FIXTURE_LOCAL_USER_ID };
    const thread =
      kind === 'core'
        ? await store.createServerThread('Fresh read metadata')
        : await store.createThread(DEMO_WORKSPACE_ID, 'Fresh read metadata');
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
    const target =
      kind === 'core' ? openCoreDb(sourceRoot) : openWorkspaceDb(sourceRoot, DEMO_WORKSPACE_ID);
    try {
      expect(listAppliedNativeMigrationIds(target.sqlite, kind)).toEqual([`${kind}_0000_baseline`]);
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
      const targetScope = nativeProductScope(sourceRoot, turn.owner);
      expect(readNativeThreadItem(targetScope, thread.id, large.id)).toEqual(large);
      expect(readNativeThreadItem(targetScope, thread.id, small.id)?.status).toBe('completed');
      const before = target.sqlite.serialize();
      applyNativeScopeMigrations(target.sqlite, kind);
      expect(target.sqlite.serialize()).toEqual(before);
    } finally {
      target.sqlite.close();
    }
  }
);

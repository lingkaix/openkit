// openkit-test-platform: posix
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId, type Item } from '@openkit/protocol';
import { afterEach, expect, it } from 'vitest';
import { type CommandRequestRecord, commandRequestKey } from '../lib/store.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { disposeTestStore } from '../test-support/store.js';
import { getCommandRequestRecordFromDb } from './command-request-records.js';
import {
  listProducts,
  openControlStoreProductReadHandle,
  readProductEntries,
} from './control-store-product-records.js';
import { openCoreDb } from './db.js';
import { workspaceDbPath } from './fs-layout.js';
import { applyMigrations } from './migrate.js';

const timestamp = '2026-10-20T00:00:00.000Z';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await disposeTestStore(root);
});

it('keeps readonly metadata and entry reads in their supplied connection snapshot across real Store writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'product-read-snapshot-'));
  roots.push(root);
  const store = await createDemoStore({ dataRoot: root });
  const turn = await store.createTurn(DEMO_WORKSPACE_ID, DEMO_THREAD_ID, 'Snapshot isolation.', {
    kind: 'user',
    id: FIXTURE_LOCAL_USER_ID,
  });
  const item: Extract<Item, { type: 'assistant-message' }> = {
    id: allocateEntityId('it'),
    owner: turn.owner,
    threadId: turn.threadId,
    turnId: turn.id,
    type: 'assistant-message',
    status: 'in_progress',
    text: 'Original snapshot bytes.',
    createdAt: turn.startedAt!,
    completedAt: null,
  };
  await store.createItem(item);
  const reader = openControlStoreProductReadHandle(
    workspaceDbPath(root, DEMO_WORKSPACE_ID),
    turn.owner
  );
  try {
    expect(reader.sqlite.readonly).toBe(true);
    reader.sqlite.exec('BEGIN');
    const metadata = listProducts(reader.sqlite, turn.owner, 'turn');
    const entries = readProductEntries(reader.sqlite, turn.owner, turn.id, 'item');
    expect(entries).toHaveLength(1);
    expect(() => reader.sqlite.prepare('DELETE FROM control_product_entries').run()).toThrow();
    await store.updateItem(item.id, {
      text: 'A later committed revision.',
      status: 'completed',
      completedAt: item.createdAt,
    });
    await store.completeTurn(turn.id, { status: 'completed', completedAt: item.createdAt });
    expect(listProducts(reader.sqlite, turn.owner, 'turn')).toEqual(metadata);
    expect(readProductEntries(reader.sqlite, turn.owner, turn.id, 'item')).toEqual(entries);
    reader.sqlite.exec('ROLLBACK');
    expect(listProducts(reader.sqlite, turn.owner, 'turn')).not.toEqual(metadata);
    expect(
      readProductEntries(reader.sqlite, turn.owner, turn.id, 'item').map((entry) => [
        entry.id,
        entry.revision,
      ])
    ).toEqual([
      [item.id, 1],
      [item.id, 2],
    ]);
  } finally {
    if (reader.sqlite.inTransaction) reader.sqlite.exec('ROLLBACK');
    reader.close();
  }
});

it('decodes descriptive additions in a retained legacy conversation receipt', () => {
  const root = mkdtempSync(join(tmpdir(), 'retained-conversation-receipt-'));
  roots.push(root);
  const db = openCoreDb(root);
  try {
    applyMigrations(db);
    const scope = { coreId: 'server' };
    const requestId = randomUUID();
    const record: CommandRequestRecord = {
      key: commandRequestKey('conversation.submit', requestId, scope),
      command: 'conversation.submit',
      requestId,
      scope,
      inputHash: `sha256:${'a'.repeat(64)}`,
      response: {
        kind: 'turn',
        id: allocateEntityId('tu'),
        conversationMetadata: {
          targetRef: 'fixture-target',
          logicalModelId: null,
          receivingWorkspaceId: allocateEntityId('ws'),
          receivingThreadId: allocateEntityId('th'),
          downstream: null,
          resultKind: 'worker-turn',
          status: 202,
        },
      },
      createdAt: timestamp,
      expiresAt: '2026-10-27T00:00:00.000Z',
    };
    // Deliberate retained-format fixture, not a live producer or an admitted canonical tuple.
    db.sqlite
      .prepare(`INSERT INTO idempotency_requests
          (schema_version,request_key,command_name,request_id,scope_json,input_hash,
           response_kind,response_id,response_json,created_at,expires_at)
          VALUES (1,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        record.key,
        record.command,
        record.requestId,
        JSON.stringify(record.scope),
        record.inputHash,
        record.response.kind,
        record.response.id,
        JSON.stringify(record.response.conversationMetadata),
        record.createdAt,
        record.expiresAt
      );
    db.sqlite.prepare('UPDATE idempotency_requests SET response_json=? WHERE request_key=?').run(
      JSON.stringify({
        ...record.response.conversationMetadata,
        annotation: { source: 'future-reader' },
      }),
      record.key
    );
    expect(getCommandRequestRecordFromDb(db, record.key, timestamp)?.response).toEqual(
      record.response
    );
  } finally {
    db.sqlite.close();
  }
});

import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { allocateEntityId, ItemSchema, writeRetainedV1 } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { commandRequestExpiresAt, commandRequestKey } from '../lib/store.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { createTestStore, disposeTestStore } from '../test-support/store.js';
import type { ControlAdmission } from './control-store-admission-codecs.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { openAdmittedWorkspaceReadDb } from './db.js';
import { prepareRetainedProductJson } from './immutable-content.js';
import { nativeProductScope, readNativeProductEntries } from './workspace-file-records.js';

const roots: string[] = [];
const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;
afterEach(async () => {
  for (const root of roots.splice(0)) await disposeTestStore(root);
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-task-steer-'));
  roots.push(root);
  const store = createTestStore({ dataRoot: root });
  const workspace = await store.createWorkspace('Exact live-steer receipt');
  const thread = await store.createThread(workspace.id, 'Original Task');
  const turn = await store.createTurn(workspace.id, thread.id, 'Original input', actor);
  const requestId = randomUUID();
  const createdAt = new Date().toISOString();
  const item = ItemSchema.parse({
    id: allocateEntityId('it'),
    owner: turn.owner,
    threadId: thread.id,
    turnId: turn.id,
    type: 'user-message',
    actor,
    text: '  Original steer bytes\n',
    status: 'completed',
    createdAt,
    completedAt: createdAt,
    causationId: `task.steer:${requestId}`,
  });
  await store.createItem(item);
  const scope = { workspaceId: workspace.id, threadId: thread.id, actorId: actor.id };
  const inputHash = commandInputHash({
    workspaceId: workspace.id,
    threadId: thread.id,
    turnId: turn.id,
    input: item.text,
  });
  const native = nativeProductScope(root, { kind: 'workspace', workspaceId: workspace.id });
  const disposition = {
    inputHash,
    disposition: 'accepted' as const,
    reason: null,
    operationId: 'a'.repeat(64),
    executionId: 'existing-execution',
  };
  const updatedItem = { ...item, steerDisposition: disposition };
  const originalEntries = readNativeProductEntries(native, turn.id, 'item');
  const previous = originalEntries.filter((row) => row.id === item.id).at(-1)!;
  const transition = {
    receipt: {
      key: commandRequestKey('task.steer', requestId, scope),
      command: 'task.steer',
      requestId,
      scope,
      inputHash,
      response: {
        kind: 'turn',
        id: turn.id,
      },
      createdAt,
      expiresAt: commandRequestExpiresAt(createdAt),
    },
    products: [],
    entries: [
      {
        kind: 'item',
        turnId: turn.id,
        sequence: originalEntries.length + 1,
        expectedRevision: previous.revision,
        ...(await prepareRetainedProductJson(
          native.contentMount,
          native.owner,
          join(dirname(dirname(native.path)), 'runtime', 'staging'),
          writeRetainedV1(updatedItem)
        )),
      },
    ],
    audit: {
      id: allocateEntityId('aud'),
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      itemId: item.id,
      capabilityCallId: null,
      permissionDecisionId: null,
      vaultGrantId: null,
      requestId,
      actor,
      subject: null,
      agentId: null,
      agentSessionId: null,
      category: 'command',
      action: 'task.steer',
      resource: `turn:${turn.id}`,
      resourceRevision: null,
      outcome: 'succeeded',
      severity: 'info',
      summary: 'Native steer accepted',
      errorCode: null,
      createdAt,
      occurredAt: createdAt,
    },
  } as unknown as ControlAdmission;
  return {
    root,
    store,
    workspace,
    thread,
    turn,
    item,
    disposition,
    updatedItem,
    transition,
    native,
    database: `workspace:${native.path}`,
  };
}

describe('native completed Task steer receipts', () => {
  it('commits disposition on the original Item after terminal without changing its Turn head, and replays after restart', async () => {
    const f = await fixture();
    await f.store.updateTurn(f.turn.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    const before = f.store.getTurnById(f.turn.id);
    const privateBefore = f.store.readThreadTimelineSnapshot(
      f.workspace.id,
      f.thread.id,
      (snapshot) => snapshot.item(f.item.id)
    );
    expect(privateBefore).toBeDefined();
    const beforeOwner = openAdmittedWorkspaceReadDb(f.root, f.workspace.id);
    let originalRows: unknown[];
    try {
      originalRows = beforeOwner.sqlite
        .prepare(`SELECT id,sequence,revision,content_json,
        identity_json,read_metadata_json FROM control_product_entries
        WHERE kind='item' AND turn_id=? ORDER BY sequence`)
        .all(f.turn.id);
    } finally {
      beforeOwner.sqlite.close();
    }
    await expect(
      getControlStoreWorkerClient().transition(f.database, f.transition)
    ).resolves.toMatchObject({ replayed: false });
    const after = f.store.getTurnById(f.turn.id);
    expect(after).toEqual(before);
    const privateAfter = f.store.readThreadTimelineSnapshot(
      f.workspace.id,
      f.thread.id,
      (snapshot) => snapshot.item(f.item.id)
    );
    expect(privateAfter).toEqual({ ...privateBefore, steerDisposition: f.disposition });
    const owner = openAdmittedWorkspaceReadDb(f.root, f.workspace.id);
    try {
      const revisions = owner.sqlite
        .prepare(`SELECT id,sequence,revision,content_json,
        identity_json,read_metadata_json FROM control_product_entries
        WHERE kind='item' AND turn_id=? ORDER BY sequence`)
        .all(f.turn.id) as {
        id: string;
        sequence: number;
        revision: number;
        read_metadata_json: string;
      }[];
      expect(revisions).toHaveLength(originalRows.length + 1);
      expect(revisions.slice(0, -1)).toEqual(originalRows);
      const appended = revisions.at(-1)!;
      expect(appended).toMatchObject({
        id: f.item.id,
        revision: f.transition.entries[0]!.expectedRevision + 1,
        sequence: f.transition.entries[0]!.sequence,
      });
      expect(JSON.parse(appended.read_metadata_json).steerDisposition).toEqual(f.disposition);
      expect(
        owner.sqlite
          .prepare('SELECT response_json FROM idempotency_requests WHERE request_key=?')
          .pluck()
          .get(f.transition.receipt.key)
      ).toBeNull();
    } finally {
      owner.sqlite.close();
    }
    const record = f.store.getCommandRequest(
      'task.steer',
      f.transition.receipt.requestId,
      f.transition.receipt.scope
    );
    expect(record?.response).toEqual(f.transition.receipt.response);
    await shutdownControlStoreWorkerClient();
    const cold = createTestStore({ dataRoot: f.root });
    expect(
      cold.getCommandRequest(
        'task.steer',
        f.transition.receipt.requestId,
        f.transition.receipt.scope
      )
    ).toEqual(record);
    // Reopen through the same native store owner, then attempt a changed disposition under identical scope/input.
    await getControlStoreWorkerClient().open({
      database: f.database,
      path: f.native.path,
      dataRoot: f.root,
      create: false,
      initialize: 'workspace',
      productOwner: f.native.owner,
      contentMount: f.native.contentMount,
    });
    const changed = structuredClone(f.transition);
    const currentEntries = readNativeProductEntries(f.native, f.turn.id, 'item');
    changed.entries[0] = {
      ...changed.entries[0]!,
      sequence: currentEntries.length + 1,
      expectedRevision: currentEntries.filter((row) => row.id === f.item.id).at(-1)!.revision,
      ...(await prepareRetainedProductJson(
        f.native.contentMount,
        f.native.owner,
        join(dirname(dirname(f.native.path)), 'runtime', 'staging'),
        writeRetainedV1({
          ...f.updatedItem,
          steerDisposition: { ...f.disposition, disposition: 'unknown' },
        })
      )),
    };
    await expect(
      getControlStoreWorkerClient().transition(f.database, changed)
    ).resolves.toMatchObject({ replayed: true, response: record!.response });
    expect(cold.getTurnById(f.turn.id)).toEqual(after);
    expect(
      cold.readThreadTimelineSnapshot(f.workspace.id, f.thread.id, (snapshot) =>
        snapshot.item(f.item.id)
      )
    ).toEqual(privateAfter);
  });

  it.each(['input', 'actor', 'turn', 'item', 'causation'])(
    'rejects contradictory %s without a receipt',
    async (fault) => {
      const f = await fixture();
      const bad = structuredClone(f.transition);
      if (fault === 'input') bad.receipt.inputHash = `sha256:${'f'.repeat(64)}`;
      if (fault === 'actor') {
        bad.receipt.scope.actorId = allocateEntityId('usr');
        bad.receipt.key = commandRequestKey('task.steer', bad.receipt.requestId, bad.receipt.scope);
      }
      if (fault === 'turn') bad.receipt.response.id = allocateEntityId('tu');
      if (fault === 'item')
        bad.entries[0] = {
          ...bad.entries[0]!,
          ...(await prepareRetainedProductJson(
            f.native.contentMount,
            f.native.owner,
            join(dirname(dirname(f.native.path)), 'runtime', 'staging'),
            writeRetainedV1({ ...f.updatedItem, id: allocateEntityId('it') })
          )),
        };
      if (fault === 'causation') {
        bad.receipt.requestId = randomUUID();
        bad.receipt.key = commandRequestKey('task.steer', bad.receipt.requestId, bad.receipt.scope);
        bad.audit.requestId = bad.receipt.requestId;
      }
      await expect(getControlStoreWorkerClient().transition(f.database, bad)).rejects.toThrow();
      expect(
        f.store.getCommandRequest('task.steer', bad.receipt.requestId, bad.receipt.scope)
      ).toBeNull();
    }
  );
});

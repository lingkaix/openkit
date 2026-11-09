import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId, ItemSchema } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { commandRequestExpiresAt, commandRequestKey } from '../lib/store.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { createTestStore, disposeTestStore } from '../test-support/store.js';
import type { ControlAdmission } from './control-store-admission-codecs.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { nativeProductScope } from './workspace-file-records.js';

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
        steerMetadata: {
          turnId: turn.id,
          inputItemId: item.id,
          inputHash,
          disposition: 'accepted',
          reason: null,
          operationId: 'a'.repeat(64),
          executionId: 'existing-execution',
        },
      },
      createdAt,
      expiresAt: commandRequestExpiresAt(createdAt),
    },
    products: [],
    entries: [],
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
  const native = nativeProductScope(root, { kind: 'workspace', workspaceId: workspace.id });
  return {
    root,
    store,
    workspace,
    thread,
    turn,
    item,
    transition,
    native,
    database: `workspace:${native.path}`,
  };
}

describe('native completed Task steer receipts', () => {
  it('commits the original receipt after terminal without changing the Turn or Item, and replays after restart', async () => {
    const f = await fixture();
    await f.store.updateTurn(f.turn.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    const before = f.store.getTurnById(f.turn.id);
    await expect(
      getControlStoreWorkerClient().transition(f.database, f.transition)
    ).resolves.toMatchObject({ replayed: false });
    expect(f.store.getTurnById(f.turn.id)).toEqual(before);
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
    changed.receipt.response.steerMetadata!.disposition = 'unknown';
    await expect(
      getControlStoreWorkerClient().transition(f.database, changed)
    ).resolves.toMatchObject({ replayed: true, response: record!.response });
    expect(cold.getTurnById(f.turn.id)).toEqual(before);
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
        bad.receipt.response.steerMetadata!.inputItemId = allocateEntityId('it');
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

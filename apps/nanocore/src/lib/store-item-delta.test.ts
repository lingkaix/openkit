import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId, type Item, PROTOCOL_VERSION } from '@openkit/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import { listServerAuditEvents, listWorkspaceAuditEvents } from '../audit-events.js';
import {
  closeTestCoreDb,
  createTestCoreDb,
  createTestStore,
  createTestWorkspaceDb,
  disposeTestStore,
} from '../test-support/store.js';
import { FsStore } from './store.js';

const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;

/** Uses genuine retained Items, native events and a second Store for cold reconstruction. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'delta-protocol-'));
  onTestFinished(() => disposeTestStore(dataRoot));
  const store = createTestStore({ dataRoot });
  const workspace = await store.createWorkspace('Protocol');
  const thread = await store.createThread(workspace.id, 'Deltas');
  const turn = await store.createTurn(workspace.id, thread.id, 'Input', actor);
  const item: Item = {
    id: allocateEntityId('it'),
    owner: turn.owner,
    threadId: thread.id,
    turnId: turn.id,
    type: 'assistant-message',
    status: 'in_progress',
    text: '',
    createdAt: turn.startedAt!,
    completedAt: null,
  };
  await store.createItem(item);
  const publish = (data: Record<string, unknown>, writer = store) =>
    writer.persistTurnEvent(turn.id, {
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      event: 'item.delta',
      data: {
        type: 'item-delta',
        itemId: item.id,
        itemType: item.type,
        status: 'completed',
        ...data,
      },
    } as Parameters<FsStore['persistTurnEvent']>[1]);
  return { dataRoot, store, workspace, thread, turn, item, publish };
}

describe('Item delta publication protocol', () => {
  it.each([
    { deltaKind: 'indexed-text-delta', partId: 'missing', delta: 'text' },
    { deltaKind: 'request-resolved', requestRefId: 'missing' },
    { deltaKind: 'output-delta', delta: 'undeclared output' },
    { deltaKind: 'text-delta', itemType: 'reasoning', delta: 'wrong actual type' },
    { deltaKind: 'unknown-delta' },
  ])('rejects and audits $deltaKind without publishing invalid bytes', async (delta) => {
    const f = await fixture();
    await expect(f.publish(delta)).rejects.toMatchObject({ code: 'core.protocol.invalid_delta' });
    expect(f.store.getTurnEventsForExport(f.turn.id)).toEqual([]);
    const db = createTestWorkspaceDb(f.dataRoot, f.workspace.id);
    try {
      expect(
        listWorkspaceAuditEvents(db, f.workspace.id).filter((event) => event.turnId === f.turn.id)
      ).toMatchObject([
        {
          action: 'core.protocol.invalid_delta',
          errorCode: 'core.protocol.invalid_delta',
          protocolVersion: PROTOCOL_VERSION,
        },
      ]);
    } finally {
      closeTestCoreDb(db);
    }
  });

  it('allows repeated request introductions and resolves the outstanding request once', async () => {
    const f = await fixture();
    await f.publish({ deltaKind: 'request-started', requestRefId: 'repeat' });
    await f.publish({ deltaKind: 'request-started', requestRefId: 'repeat' });
    await f.publish({ deltaKind: 'request-resolved', requestRefId: 'repeat' });
    expect(f.store.getTurnEventsForExport(f.turn.id)).toHaveLength(3);
    await expect(
      f.publish({ deltaKind: 'request-resolved', requestRefId: 'repeat' })
    ).rejects.toMatchObject({ code: 'core.protocol.invalid_delta' });
  });

  it('retains introduction evidence beyond the public event window in memory', async () => {
    const store = new FsStore();
    const workspace = await store.createWorkspace('Memory protocol');
    const thread = await store.createThread(workspace.id, 'Parts');
    const turn = await store.createTurn(workspace.id, thread.id, 'Input', actor);
    const item: Item = {
      id: allocateEntityId('it'),
      owner: turn.owner,
      threadId: thread.id,
      turnId: turn.id,
      type: 'assistant-message',
      status: 'in_progress',
      text: '',
      createdAt: turn.startedAt!,
      completedAt: null,
    };
    await store.createItem(item);
    const publish = (data: Record<string, unknown>) =>
      store.persistTurnEvent(turn.id, {
        workspaceId: workspace.id,
        threadId: thread.id,
        turnId: turn.id,
        event: 'item.delta',
        data: { type: 'item-delta', itemId: item.id, itemType: item.type, ...data },
      } as Parameters<FsStore['persistTurnEvent']>[1]);
    await publish({ deltaKind: 'part-started', partId: 'old-part' });
    for (let index = 0; index < 105; index++)
      await publish({ deltaKind: 'text-delta', delta: 'text' });
    await publish({ deltaKind: 'indexed-text-delta', partId: 'old-part', delta: 'valid' });
    expect(store.getTurnEvents(turn.id)).toHaveLength(100);
    expect(store.getTurnEventsForExport(turn.id)).toHaveLength(107);
  });

  it('refuses a terminal batch with an orphan delta before sealing the Turn', async () => {
    const f = await fixture();
    await expect(
      f.store.completeTurn(
        f.turn.id,
        { status: 'completed', completedAt: new Date().toISOString() },
        {
          precedingEvents: [
            {
              workspaceId: f.workspace.id,
              threadId: f.thread.id,
              turnId: f.turn.id,
              event: 'item.delta',
              data: {
                type: 'item-delta',
                itemId: f.item.id,
                itemType: 'assistant-message',
                deltaKind: 'indexed-text-delta',
                partId: 'orphan',
                delta: 'text',
              },
            },
          ],
        }
      )
    ).rejects.toMatchObject({ code: 'core.protocol.invalid_delta' });
    expect(f.store.getTurnById(f.turn.id).status).toBe('running');
    expect(f.store.getTurnEventsForExport(f.turn.id)).toEqual([]);
  });

  it('allows only one resolution from simultaneous publishers sharing native authority', async () => {
    const f = await fixture();
    await f.publish({ deltaKind: 'request-started', requestRefId: 'r' });
    const peer = new FsStore({ dataRoot: f.dataRoot });
    const results = await Promise.allSettled([
      f.publish({ deltaKind: 'request-resolved', requestRefId: 'r' }),
      f.publish({ deltaKind: 'request-resolved', requestRefId: 'r' }, peer),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'core.protocol.invalid_delta' },
    });
    expect(f.store.getTurnEventsForExport(f.turn.id)).toHaveLength(2);
  });

  it('applies the same rule to the Server transcript and audits the refusal', async () => {
    const f = await fixture();
    const thread = await f.store.createServerThread('Server deltas');
    const turn = await f.store.createServerTurn(thread.id, 'Work', actor);
    const item = {
      ...f.item,
      id: allocateEntityId('it'),
      owner: { kind: 'server' as const },
      threadId: thread.id,
      turnId: turn.id,
    };
    await f.store.createServerItem(item);
    await expect(
      f.store.persistServerTurnEvent(turn.id, {
        threadId: thread.id,
        turnId: turn.id,
        event: 'item.delta',
        data: {
          type: 'item-delta',
          itemId: item.id,
          itemType: 'assistant-message',
          deltaKind: 'indexed-text-delta',
          partId: 'orphan',
          delta: 'text',
        },
      })
    ).rejects.toMatchObject({ code: 'core.protocol.invalid_delta' });
    expect(f.store.getServerTurnTranscript(turn.id)).toEqual([]);
    const coreDb = createTestCoreDb(f.dataRoot);
    try {
      expect(
        listServerAuditEvents(coreDb).filter((event) => event.turnId === turn.id)
      ).toMatchObject([
        {
          action: 'core.protocol.invalid_delta',
          errorCode: 'core.protocol.invalid_delta',
          protocolVersion: PROTOCOL_VERSION,
        },
      ]);
    } finally {
      closeTestCoreDb(coreDb);
    }
  });

  it('reconstructs item-local parts and outstanding requests after restart and rejects double resolution', async () => {
    const f = await fixture();
    await f.publish({ deltaKind: 'part-started', partId: 'a' });
    await f.publish({ deltaKind: 'request-started', requestRefId: 'r' });
    const cold = new FsStore({ dataRoot: f.dataRoot });
    await f.publish({ deltaKind: 'indexed-text-delta', partId: 'a', delta: 'text' }, cold);
    await f.publish({ deltaKind: 'request-resolved', requestRefId: 'r' }, cold);
    await expect(
      f.publish({ deltaKind: 'request-resolved', requestRefId: 'r' }, cold)
    ).rejects.toMatchObject({ code: 'core.protocol.invalid_delta' });
    expect(cold.getTurnEventsForExport(f.turn.id)).toHaveLength(4);
    const peer = { ...f.item, id: allocateEntityId('it') };
    await cold.createItem(peer);
    await expect(
      f.publish(
        { itemId: peer.id, deltaKind: 'indexed-text-delta', partId: 'a', delta: 'cross-item' },
        cold
      )
    ).rejects.toMatchObject({ code: 'core.protocol.invalid_delta' });
  });
});

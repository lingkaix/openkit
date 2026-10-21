import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allocateEntityId,
  ItemSchema,
  PROTOCOL_VERSION,
  SseEventEnvelopeSchema,
  writeRetainedV1,
} from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { openControlStoreProductReadHandle } from '../storage/control-store-products.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  nativeProductScope,
  readNativeProductEntries,
  readNativeTurnHistory,
} from '../storage/workspace-file-records.js';
import { FsStore } from './store.js';

const roots: string[] = [];
const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Uses production DDL and native Server configuration, not test-owned product tables. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'store-native-'));
  roots.push(root);
  const db = openCoreDb(root);
  try {
    applyMigrations(db);
  } finally {
    db.sqlite.close();
  }
  initializeDefaultKnowledgeBaseId({
    dataRoot: root,
    scope: { kind: 'server' },
    knowledgeBaseId: allocateEntityId('kb'),
  });
  return { root, store: new FsStore({ dataRoot: root }) };
}

/** Builds an admitted native graph through real acknowledged Store operations. */
async function workspaceFixture() {
  const f = fixture();
  const workspace = await f.store.createWorkspace('Native');
  const thread = await f.store.createThread(workspace.id, 'Native Thread');
  const turn = await f.store.createTurn(workspace.id, thread.id, 'Input', actor);
  const scope = nativeProductScope(f.root, { kind: 'workspace', workspaceId: workspace.id });
  return { ...f, workspace, thread, turn, scope };
}

/** Produces a full revision whose identity remains stable across later text changes. */
function message(
  turn: ReturnType<FsStore['getTurnById']>,
  text: string,
  id = allocateEntityId('it')
) {
  return ItemSchema.parse({
    id,
    owner: turn.owner,
    threadId: turn.threadId,
    turnId: turn.id,
    type: 'user-message',
    actor,
    text,
    status: 'completed',
    createdAt: turn.startedAt!,
    completedAt: turn.startedAt!,
  });
}

describe('native Store authority and immutable closure', () => {
  it('rereads SQL and every immutable revision after reopen, without mutable product files', async () => {
    const f = await workspaceFixture();
    const first = message(f.turn, 'First');
    const second = message(f.turn, 'Other');
    await f.store.createItem(first);
    await f.store.createItem(second);
    await f.store.updateItem(first.id, { text: 'Second' });
    Object.assign(f.store.getTurnById(f.turn.id), { status: 'completed' });
    Object.assign(f.store.getThread(f.workspace.id, f.thread.id), {
      visibility: 'private',
      privateOwnerUserId: actor.id,
    });
    Object.assign(f.store.getWorkspace(f.workspace.id), { kind: 'personal' });
    expect(f.store.getTurnById(f.turn.id).status).toBe('running');
    expect(f.store.getThread(f.workspace.id, f.thread.id).visibility).toBe('workspace');
    expect(f.store.getWorkspace(f.workspace.id).kind).toBe('general');
    expect(
      f.store
        .listWorkspaceItemRevisions(f.workspace.id)
        .map((item) => (item.type === 'user-message' ? item.text : ''))
    ).toEqual(['First', 'Other', 'Second']);
    const reopened = new FsStore({ dataRoot: f.root });
    expect(reopened.getTurnById(f.turn.id).items.map((item) => item.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(reopened.getTurnById(f.turn.id).items[0]).toMatchObject({
      id: first.id,
      text: 'Second',
    });
    const threadRoot = join(f.root, 'workspaces', f.workspace.id, 'threads', f.thread.id);
    for (const path of [
      join(threadRoot, 'thread.json'),
      join(threadRoot, 'turns', f.turn.id, 'turn.json'),
      join(threadRoot, 'turns', f.turn.id, 'items.jsonl'),
    ])
      expect(existsSync(path)).toBe(false);
  });

  it('separates durable event persistence from the synchronous notification tail', async () => {
    const f = await workspaceFixture();
    const item = await f.store.createItem(message(f.turn, 'Event'));
    const observed: number[] = [];
    f.store.addTurnListener(f.turn.id, (event) => observed.push(event.sequence));
    const envelope = await f.store.persistTurnEvent(f.turn.id, {
      event: 'item.created',
      workspaceId: f.workspace.id,
      threadId: f.thread.id,
      turnId: f.turn.id,
      data: { type: 'item-created', item },
    });
    expect(observed).toEqual([]);
    const result = f.store.emitTurnEvent(f.turn.id, envelope);
    expect(result).toBe(envelope);
    expect(observed).toEqual([1]);
    expect(new FsStore({ dataRoot: f.root }).getTurnEventsForExport(f.turn.id)).toEqual([envelope]);
    expect(() =>
      f.store.emitTurnEvent(f.turn.id, {
        ...envelope,
        data: { type: 'item-created', item: { ...item, text: 'Forged' } },
      } as typeof envelope)
    ).toThrow(/exact acknowledged/);
  });

  it('uses native rows created outside the Store caches and discovers opaque lineage without body reads', async () => {
    const f = await workspaceFixture();
    const threadId = allocateEntityId('th');
    const turnId = allocateEntityId('tu');
    await getControlStoreWorkerClient().products(`workspace:${f.scope.path}`, {
      products: [
        {
          kind: 'thread',
          expectedRevision: 0,
          record: writeRetainedV1({ ...f.thread, id: threadId }),
        },
        {
          kind: 'turn',
          expectedRevision: 0,
          record: writeRetainedV1({ ...f.turn, id: turnId, threadId, items: [] }),
        },
      ],
      entries: [],
    });
    expect(f.store.getTurnLineage(turnId)).toEqual({ workspaceId: f.workspace.id, threadId });
    expect(f.store.getTurnById(turnId).id).toBe(turnId);
    expect(f.store.listThreadTurns(f.workspace.id, threadId).map((turn) => turn.id)).toEqual([
      turnId,
    ]);
  });

  it('rereads immutable bodies and refuses changed bytes instead of serving a cached Item', async () => {
    const f = await workspaceFixture();
    const item = await f.store.createItem(message(f.turn, 'Original'));
    expect(f.store.getTurnById(f.turn.id).items[0]!.id).toBe(item.id);
    const reader = openControlStoreProductReadHandle(f.scope.path, f.scope.owner);
    let path: string;
    try {
      path = join(
        f.scope.contentMount.root,
        reader.entries(f.turn.id, 'item')[0]!.content.reference.locator.path
      );
    } finally {
      reader.close();
    }
    chmodSync(path, 0o600);
    writeFileSync(path, 'changed');
    expect(f.store.getTurnLineage(f.turn.id)).toEqual({
      workspaceId: f.workspace.id,
      threadId: f.thread.id,
    });
    expect(() => f.store.getTurnById(f.turn.id)).toThrow(/immutable (size|digest)/);
  });

  it('retains real Server history and AgentSession lifecycle through the native worker', async () => {
    const f = await workspaceFixture();
    const timestamp = f.turn.startedAt!;
    const session = await f.store.createAgentSession({
      id: allocateEntityId('as'),
      workspaceId: f.workspace.id,
      threadId: f.thread.id,
      agentId: 'agent_codex_host',
      status: 'initializing',
      message: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await f.store.updateAgentSession(session.id, { status: 'ready', message: 'Ready' });
    const thread = await f.store.createServerThread('Server');
    const turn = await f.store.createServerTurn(thread.id, 'Server input', actor);
    const item = await f.store.createServerItem(message(turn, 'Server original'));
    await f.store.updateServerItem(item.id, { text: 'Server changed' });
    const event = await f.store.persistServerTurnEvent(turn.id, {
      event: 'item.created',
      threadId: thread.id,
      turnId: turn.id,
      data: { type: 'item-created', item: f.store.getServerItemById(item.id) },
    });
    f.store.emitServerTurnEvent(turn.id, event);
    const reopened = new FsStore({ dataRoot: f.root });
    expect(reopened.getServerItemById(item.id)).toMatchObject({ text: 'Server changed' });
    expect(reopened.getServerTurnTranscript(turn.id)).toEqual([event]);
    expect(reopened.getAgentSession(session.id)).toMatchObject({
      status: 'ready',
      message: 'Ready',
    });
  });

  it.each([
    'running',
    'completed',
  ] as const)('imports every initial native family and complete descriptive history (%s)', async (status) => {
    const f = await workspaceFixture();
    const targetId = allocateEntityId('ws');
    const threadId = allocateEntityId('th');
    const turnId = allocateEntityId('tu');
    const sessionId = allocateEntityId('as');
    const owner = { kind: 'workspace', workspaceId: targetId } as const;
    const timestamp = f.turn.startedAt!;
    const first = {
      ...message(f.turn, 'Before'),
      owner,
      threadId,
      turnId,
      note: 'retained annotation',
    };
    const last = { ...first, text: 'After' };
    const turn = {
      ...f.turn,
      id: turnId,
      threadId,
      owner,
      agentSessionId: sessionId,
      status,
      completedAt: status === 'completed' ? timestamp : null,
      durationMs: status === 'completed' ? 0 : null,
      items: [last],
    };
    const event = {
      ...SseEventEnvelopeSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        requestId: null,
        workspaceId: targetId,
        threadId,
        turnId,
        sequence: 1,
        timestamp,
        event: status === 'completed' ? 'turn.completed' : 'turn.updated',
        data:
          status === 'completed'
            ? { type: 'turn-completed', turn, stopReason: 'completed' }
            : { type: 'turn-updated', turn },
      }),
      note: 'event annotation',
    };
    await f.store.importWorkspaceSnapshot({
      workspace: { ...f.workspace, id: targetId },
      threads: [{ ...f.thread, id: threadId, owner }],
      turns: [turn],
      knowledge: [],
      itemRevisions: [first, last],
      artifacts: [],
      agentSessions: [
        {
          id: sessionId,
          workspaceId: targetId,
          threadId,
          agentId: 'agent_codex_host',
          status: status === 'completed' ? 'closed' : 'ready',
          message: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          configVersion: null,
          environmentPackageSnapshotId: null,
          nativeHandleDigest: null,
          retainedStorage: null,
          policySnapshotId: null,
          sessionCompatibilityKey: null,
          stale: false,
          workspaceRoots: [],
          sandboxSummary: null,
        },
      ],
      turnEvents: [
        [
          turnId,
          Array.from({ length: status === 'completed' ? 129 : 1 }, (_, index) => ({
            ...event,
            sequence: index + 1,
          })),
        ],
      ],
      notebookInitialization: {
        requestId: randomUUID(),
        producer: actor,
        instructionReference: 'native-import-test',
      },
    });
    const reopened = new FsStore({ dataRoot: f.root });
    expect(reopened.getTurn(targetId, threadId, turnId).items[0]).toMatchObject({ text: 'After' });
    expect(reopened.getAgentSession(sessionId).status).toBe(
      status === 'completed' ? 'closed' : 'ready'
    );
    expect(reopened.listWorkspaceItemRevisions(targetId)).toMatchObject([
      { text: 'Before', note: first.note },
      { text: 'After', note: first.note },
    ]);
    expect(reopened.getTurnEventsForExport(turnId)[0]).toMatchObject({ note: 'event annotation' });
    const count = status === 'completed' ? 129 : 1;
    expect(reopened.getTurnEventsForExport(turnId).map((entry) => entry.sequence)).toEqual(
      Array.from({ length: count }, (_, index) => index + 1)
    );
    expect(reopened.getTurnEvents(turnId)).toHaveLength(Math.min(count, 100));
    const scope = nativeProductScope(f.root, owner);
    expect(readNativeProductEntries(scope, turnId, 'item').map((row) => row.revision)).toEqual([
      1, 2,
    ]);
    expect(readNativeTurnHistory(scope, turnId)!.turn.items[0]).toMatchObject({ note: first.note });
    if (status === 'running') {
      await reopened.updateItem(first.id, { text: 'Later' });
      expect(reopened.listWorkspaceItemRevisions(targetId)[2]).toMatchObject({
        text: 'Later',
        note: first.note,
      });
    }
  });
});

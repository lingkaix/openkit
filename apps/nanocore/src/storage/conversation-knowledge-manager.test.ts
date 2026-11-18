import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubmitConversationResponseSchema } from '@openkit/app-api-schemas';
import {
  allocateEntityId,
  deriveEntityId,
  type Item,
  isSealedTurnTerminal,
} from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareAuditEvent } from '../audit-events.js';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import { CONVERSATION_FILE_MEDIA_TYPE } from '../conversation-file-body.js';
import * as knowledgeAgent from '../knowledge/knowledge-agent.js';
import { FsStore } from '../lib/store.js';
import { runIdempotentCommand } from '../runtime/idempotent-command.js';
import { createApp } from '../test-support/app.js';
import { confirmContextDefaultsForApp } from '../test-support/context-defaults.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';
import { nativeProductScope, turnFilePayloadPath } from './workspace-file-records.js';

const cleanups: Array<() => void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await shutdownControlStoreWorkerClient();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** Exercises public conversation admission and native storage; only the downstream query is replaced. */
async function fixture(visibility: 'private' | 'workspace' = 'workspace') {
  const dataRoot = mkdtempSync(join(tmpdir(), 'conversation-km-'));
  cleanups.push(() => rmSync(dataRoot, { recursive: true, force: true }));
  const coreDb = openCoreDb(dataRoot);
  cleanups.push(() => coreDb.sqlite.close());
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot });
  const workspaceId = DEMO_WORKSPACE_ID;
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: userId, workspaceId });
  const thread = await store.createThread(
    workspaceId,
    'Knowledge query origin',
    undefined,
    'conversation',
    { visibility, ...(visibility === 'private' ? { privateOwnerUserId: userId } : {}) }
  );
  const ask = vi.spyOn(knowledgeAgent, 'askKnowledgeAgent').mockResolvedValue({
    threadId: allocateEntityId('th'),
    turnId: allocateEntityId('tu'),
    answer: 'No supported evidence was found.',
    citations: [],
    uncertainty: 'The notebook has no matching evidence.',
  });
  const options = await confirmContextDefaultsForApp({ coreDb, dataRoot, store });
  let app = createApp(options);
  const input = {
    requestId: randomUUID(),
    input: 'What does the notebook say?',
    targetRef: 'internal-role:knowledge-manager',
    artifactRefs: [],
  };
  const selectors = { workspaceId, threadId: thread.id };
  const submit = (body = input) =>
    app.request(
      ...operationRequest('conversation.submit', selectors, { body: JSON.stringify(body) })
    );
  return {
    dataRoot,
    coreDb,
    store,
    thread,
    workspaceId,
    userId,
    ask,
    input,
    selectors,
    submit,
    get app() {
      return app;
    },
    restart: async () => {
      await shutdownControlStoreWorkerClient();
      const reopened = new FsStore({ dataRoot });
      app = createApp({ ...options, store: reopened });
      return reopened;
    },
  };
}

it.each(['private', 'workspace'] as const)(
  'routes a new %s Knowledge Manager submission to its own linked Thread (#786, #790)',
  async (visibility) => {
    const f = await fixture(visibility);
    const priorTurns = f.store.listThreadTurns(f.workspaceId, f.thread.id);
    const response = await f.submit();
    expect(response.status, await response.clone().text()).toBe(200);
    const result = SubmitConversationResponseSchema.parse(await response.json());
    expect(result.receivingThreadId).not.toBe(f.thread.id);
    expect(result).toMatchObject({
      originatingWorkspaceId: f.workspaceId,
      originatingThreadId: f.thread.id,
      receivingWorkspaceId: f.workspaceId,
      turn: { threadId: result.receivingThreadId, agentId: 'knowledge-manager' },
      item: { threadId: result.receivingThreadId, turnId: result.turn.id },
      handoff: null,
    });
    expect(f.store.getThread(f.workspaceId, result.receivingThreadId)).toMatchObject({
      entryPath: 'knowledge-manager',
      parentThreadId: f.thread.id,
      visibility,
      ...(visibility === 'private' ? { privateOwnerUserId: f.userId } : {}),
    });
    const originTurns = f.store.listThreadTurns(f.workspaceId, f.thread.id);
    expect(originTurns.slice(0, priorTurns.length)).toEqual(priorTurns);
    expect(originTurns).toHaveLength(priorTurns.length + 1);
    expect(originTurns.at(-1)).toMatchObject({
      agentId: 'quick-chat',
      status: 'completed',
      items: expect.arrayContaining([
        expect.objectContaining({
          type: 'status',
          title: 'Knowledge Manager handoff',
          causationId: result.turn.id,
          summary: `Work directed to Thread ${result.receivingThreadId}.`,
        }),
      ]),
    });
    expect(originTurns.every((turn) => turn.agentId !== 'knowledge-manager')).toBe(true);
    expect(result.turn.items.every((item) => item.threadId === result.receivingThreadId)).toBe(
      true
    );
    expect(f.ask).toHaveBeenCalledOnce();
    expect(f.ask.mock.calls[0]![1].access).toMatchObject({
      outputThreadId: result.receivingThreadId,
      outputTurnId: result.turn.id,
    });
    const receipt = f.store.getCommandRequest('conversation.submit', f.input.requestId, {
      actorId: f.userId,
      ...f.selectors,
    });
    expect(receipt?.response).toMatchObject({
      id: result.turn.id,
      conversationMetadata: {
        receivingThreadId: result.receivingThreadId,
        receivingWorkspaceId: f.workspaceId,
        resultKind: 'knowledge-answer',
      },
    });

    const reopened = await f.restart();
    const threads = reopened.listThreads(f.workspaceId);
    const turns = threads.flatMap((thread) => reopened.listThreadTurns(f.workspaceId, thread.id));
    f.ask.mockRejectedValue(new Error('Replay must not query Knowledge again.'));
    const replay = await f.submit();
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toEqual(result);
    expect(reopened.listThreads(f.workspaceId)).toEqual(threads);
    expect(threads.flatMap((thread) => reopened.listThreadTurns(f.workspaceId, thread.id))).toEqual(
      turns
    );
    expect(f.ask).toHaveBeenCalledOnce();
    const conflict = await f.submit({ ...f.input, input: 'Changed question' });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'idempotency_key_conflict' });
  }
);

it('retains original files on the Knowledge Manager receiving Turn and replays without retry bytes', async () => {
  const f = await fixture('private');
  const bytes = Buffer.from('exact question attachment');
  const fileInputs = [
    {
      name: 'question.txt',
      mediaType: 'text/plain',
      sizeBytes: bytes.length,
      contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    },
  ];
  const body = { ...f.input, fileInputs };
  const json = Buffer.from(JSON.stringify({ ...body, ...f.selectors }));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(json.length);
  const response = await f.app.request('/api/app/operations/conversation.submit', {
    method: 'POST',
    headers: {
      'content-type': CONVERSATION_FILE_MEDIA_TYPE,
      'x-openkit-request-id': body.requestId,
    },
    body: new Blob([prefix, json, bytes]),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const result = SubmitConversationResponseSchema.parse(await response.json());
  expect(result.receivingThreadId).not.toBe(f.thread.id);
  expect(result.turn.fileInputs).toEqual(fileInputs);
  expect(f.store.listThreadTurns(f.workspaceId, f.thread.id).at(-1)?.fileInputs).toBeUndefined();
  expect(
    readFileSync(
      turnFilePayloadPath(
        join(f.dataRoot, 'workspaces', f.workspaceId),
        result.receivingThreadId,
        result.turn.id,
        0
      )
    )
  ).toEqual(bytes);
  const replay = await f.app.request(
    ...operationRequest('conversation.submit', f.selectors, { body: JSON.stringify(body) })
  );
  expect(replay.status, await replay.clone().text()).toBe(200);
  expect(await replay.json()).toEqual(result);
  expect(f.ask).toHaveBeenCalledOnce();
});

it('keeps a receiving storage fault local and allows a new action on the origin', async () => {
  const f = await fixture();
  const createThread = f.store.createThread.bind(f.store);
  const fault = vi.spyOn(f.store, 'createThread').mockImplementation((...args) => {
    if (args[3] === 'knowledge-manager') throw new Error('Fixture receiving storage failure.');
    return createThread(...args);
  });
  const response = await f.submit();
  expect(response.status, await response.clone().text()).toBe(500);
  expect(await response.json()).toMatchObject({
    code: 'chat_mode_failed',
    message: expect.stringContaining('new requestId'),
  });
  expect(f.ask).not.toHaveBeenCalled();
  expect(
    f.store
      .listThreadTurns(f.workspaceId, f.thread.id)
      .every((turn) => isSealedTurnTerminal(turn.status))
  ).toBe(true);
  expect(
    f.store.listThreadTurns(f.workspaceId, f.thread.id).flatMap((turn) => turn.items)
  ).not.toContainEqual(
    expect.objectContaining({
      type: 'status',
      status: 'completed',
      title: 'Knowledge Manager handoff',
    })
  );
  fault.mockRestore();
  const retry = await f.submit({ ...f.input, requestId: randomUUID() });
  expect(retry.status, await retry.clone().text()).toBe(200);
  expect(f.ask).toHaveBeenCalledOnce();
});

it('preserves live file authority refusal at Knowledge Manager receiving publication', async () => {
  const f = await fixture('private');
  const createTurn = f.store.createTurn.bind(f.store);
  const publication = vi.spyOn(f.store, 'createTurn').mockImplementation((...args) => {
    if (f.store.getThread(args[0], args[1]).entryPath === 'knowledge-manager')
      f.coreDb.sqlite.transaction(() => disableCanonicalUser(f.coreDb, f.userId))();
    return createTurn(...args);
  });
  const bytes = Buffer.from('authority-bound input');
  const fileInputs = [
    {
      name: 'question.txt',
      mediaType: 'text/plain',
      sizeBytes: bytes.length,
      contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    },
  ];
  const json = Buffer.from(JSON.stringify({ ...f.input, ...f.selectors, fileInputs }));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(json.length);
  const response = await f.app.request('/api/app/operations/conversation.submit', {
    method: 'POST',
    headers: {
      'content-type': CONVERSATION_FILE_MEDIA_TYPE,
      'x-openkit-request-id': f.input.requestId,
    },
    body: new Blob([prefix, json, bytes]),
  });
  expect(response.status, await response.clone().text()).toBe(403);
  expect(await response.json()).toMatchObject({ code: 'workspace_access_denied' });
  expect(f.ask).not.toHaveBeenCalled();
  expect(
    f.store
      .listThreadTurns(f.workspaceId, f.thread.id)
      .every((turn) => isSealedTurnTerminal(turn.status))
  ).toBe(true);
  expect(
    f.store.listThreadTurns(f.workspaceId, f.thread.id).flatMap((turn) => turn.items)
  ).not.toContainEqual(
    expect.objectContaining({
      type: 'status',
      status: 'completed',
      title: 'Knowledge Manager handoff',
    })
  );
  publication.mockRestore();
});

it.each(['receipt', 'parent', 'entryPath', 'audience', 'receiving-turn', 'handoff'] as const)(
  'refuses a missing or contradictory Knowledge Manager %s without repeating work',
  async (missing) => {
    const f = await fixture('private');
    const response = await f.submit();
    expect(response.status).toBe(200);
    const result = SubmitConversationResponseSchema.parse(await response.json());
    expect(result.receivingThreadId).not.toBe(f.thread.id);
    // Fault injection has exclusive custody of this stopped private native owner.
    await shutdownControlStoreWorkerClient();
    const scope = nativeProductScope(f.dataRoot, { kind: 'workspace', workspaceId: f.workspaceId });
    const db = new Database(scope.path, { fileMustExist: true });
    try {
      if (missing === 'receipt') {
        db.prepare('DELETE FROM idempotency_requests WHERE request_id = ?').run(f.input.requestId);
      } else if (missing === 'receiving-turn') {
        db.prepare('UPDATE idempotency_requests SET response_id = ? WHERE request_id = ?').run(
          allocateEntityId('tu'),
          f.input.requestId
        );
      } else if (missing === 'handoff') {
        const origin = f.store.listThreadTurns(f.workspaceId, f.thread.id).at(-1)!;
        const row = db
          .prepare('SELECT record_json FROM control_turns WHERE id = ?')
          .get(origin.id) as { record_json: string };
        const record = JSON.parse(row.record_json);
        record.status = 'failed';
        db.prepare('UPDATE control_turns SET status = ?, record_json = ? WHERE id = ?').run(
          'failed',
          JSON.stringify(record),
          origin.id
        );
      } else {
        const row = db
          .prepare('SELECT record_json FROM control_threads WHERE id = ?')
          .get(result.receivingThreadId) as { record_json: string };
        const record = JSON.parse(row.record_json);
        if (missing === 'parent') delete record.parentThreadId;
        else if (missing === 'entryPath') record.entryPath = 'conversation';
        else {
          record.visibility = 'workspace';
          delete record.privateOwnerUserId;
        }
        db.prepare('UPDATE control_threads SET record_json = ? WHERE id = ?').run(
          JSON.stringify(record),
          result.receivingThreadId
        );
      }
    } finally {
      db.close();
    }
    const replay = await f.submit();
    expect(replay.status, await replay.clone().text()).toBe(409);
    expect(await replay.json()).toMatchObject({
      code: 'recovery_required',
      message: expect.stringContaining('new requestId'),
    });
    expect(f.ask).toHaveBeenCalledOnce();
  }
);

it('preserves an earlier Knowledge Manager Chat receipt without relabeling its history', async () => {
  const f = await fixture();
  const actor = { kind: 'user' as const, id: f.userId };
  const turnId = deriveEntityId('tu', {
    command: 'conversation.submit',
    actor,
    ...f.selectors,
    requestId: f.input.requestId,
  });
  await runIdempotentCommand({
    store: f.store,
    command: 'conversation.submit',
    requestId: f.input.requestId,
    scope: { actorId: f.userId, ...f.selectors },
    input: {
      artifactRefs: [],
      input: f.input.input,
      logicalModelId: null,
      targetRef: f.input.targetRef,
      workerStorageChoice: undefined,
    },
    responseKind: 'turn',
    responseId: () => turnId,
    inflightCommands: new WeakMap(),
    replay: () => {
      throw new Error('The historical fixture must be fresh.');
    },
    execute: async (receipt) => {
      const turn = await f.store.createTurn(
        f.workspaceId,
        f.thread.id,
        f.input.input,
        actor,
        null,
        { turnId, agentId: 'knowledge-manager' }
      );
      const time = turn.startedAt!;
      const user: Item = {
        id: deriveEntityId('it', ['chat-user', turn.id]),
        owner: turn.owner,
        threadId: f.thread.id,
        turnId,
        type: 'user-message',
        status: 'completed',
        actor,
        text: f.input.input,
        createdAt: time,
        completedAt: time,
      };
      await f.store.createItem(user);
      const answer: Item = {
        id: deriveEntityId('it', ['chat-answer', turn.id]),
        owner: turn.owner,
        threadId: f.thread.id,
        turnId,
        type: 'assistant-message',
        status: 'completed',
        text: 'Historical supported answer.',
        createdAt: time,
        completedAt: time,
      };
      const { responseKind: _, ...original } = receipt;
      return f.store.completeTurn(
        turnId,
        { status: 'completed', completedAt: time },
        {
          items: [answer],
          requestId: f.input.requestId,
          command: {
            audit: prepareAuditEvent({
              workspaceId: f.workspaceId,
              threadId: f.thread.id,
              turnId,
              requestId: f.input.requestId,
              actor,
              category: 'command',
              action: 'conversation.submit',
              resource: `turn:${turnId}`,
              outcome: 'succeeded',
              summary: 'Historical conversation result published.',
              now: new Date(receipt.createdAt),
            }),
            receipt: {
              ...original,
              response: {
                kind: 'turn',
                id: turnId,
                conversationMetadata: {
                  targetRef: f.input.targetRef,
                  logicalModelId: 'test-default',
                  receivingWorkspaceId: f.workspaceId,
                  receivingThreadId: f.thread.id,
                  resultKind: 'knowledge-answer',
                  status: 200,
                  downstream: null,
                },
              },
            },
          },
        }
      );
    },
  });
  const originalThread = f.store.getThread(f.workspaceId, f.thread.id);
  const originalTurn = f.store.getTurnById(turnId);
  await f.restart();
  const replay = await f.submit();
  expect(replay.status, await replay.clone().text()).toBe(200);
  expect(await replay.json()).toMatchObject({
    originatingThreadId: f.thread.id,
    receivingThreadId: f.thread.id,
    turn: originalTurn,
    explanation: 'The Knowledge Manager answered from Workspace Knowledge.',
  });
  expect(f.store.getThread(f.workspaceId, f.thread.id)).toEqual(originalThread);
  expect(f.store.getTurnById(turnId)).toEqual(originalTurn);
  expect(f.ask).not.toHaveBeenCalled();
});

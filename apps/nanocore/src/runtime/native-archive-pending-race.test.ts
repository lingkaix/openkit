import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { FsStore } from '../lib/store.js';
import { readCommandRequestRecordsFromSqlite } from '../storage/command-request-records.js';
import {
  ControlProductEntrySchema,
  openControlStoreProductReadHandle,
} from '../storage/control-store-products.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { openWorkspaceDb } from '../storage/db.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';
import { initializeTestCore } from '../test-support/store.js';
import { archiveThread, createThread } from '../thread-routes.js';
import { commandInputHash, runIdempotentCommand } from './idempotent-command.js';
import { raiseRecordedPendingRequest } from './pending-request-flow.js';
import {
  pendingRequestItemId,
  readPendingRequest,
  validateCanonicalLoad,
} from './pending-requests.js';

const userId = 'usr_00000000-0000-7000-8000-000000000001';
const actor = { kind: 'local', userId } as const;
const roots: string[] = [];
const readers: ReturnType<typeof openControlStoreProductReadHandle>[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const reader of readers.splice(0)) reader.close();
  await shutdownControlStoreWorkerClient();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Creates the original running Turn and command receipts through their native owners. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-archive-pending-race-'));
  roots.push(root);
  initializeTestCore(root);
  initializeDefaultKnowledgeBaseId({
    dataRoot: root,
    scope: { kind: 'server' },
    knowledgeBaseId: allocateEntityId('kb'),
  });
  const store = new FsStore({ dataRoot: root });
  const workspace = await store.createWorkspace('Archive Pending race');
  const dependencies = {
    store,
    inflightCommands: new WeakMap(),
    repositoryWorkspaceDb: (workspaceId: string) => openWorkspaceDb(root, workspaceId),
  } satisfies Parameters<typeof archiveThread>[1];
  const thread = await createThread(
    {
      requestId: randomUUID(),
      workspaceId: workspace.id,
      name: 'Original Thread',
      visibility: 'workspace',
    },
    dependencies,
    userId
  );
  const turnInput = {
    requestId: randomUUID(),
    workspaceId: workspace.id,
    threadId: thread.id,
    input: 'Keep the original Turn running',
  };
  const turn = await runIdempotentCommand({
    store,
    inflightCommands: dependencies.inflightCommands,
    command: 'turn.start',
    requestId: turnInput.requestId,
    scope: { workspaceId: workspace.id, threadId: thread.id },
    input: turnInput,
    responseKind: 'turn',
    execute: (commandReceipt) =>
      store.createTurn(
        workspace.id,
        thread.id,
        turnInput.input,
        { kind: 'user', id: userId },
        null,
        { commandReceipt }
      ),
    replay: (record) => store.getTurnById(record.response.id),
    responseId: (result) => result.id,
  });
  const scope = nativeProductScope(root, { kind: 'workspace', workspaceId: workspace.id });
  const reader = openControlStoreProductReadHandle(scope.path, scope.owner);
  readers.push(reader);
  const requestId = randomUUID();
  const raise = {
    requestId,
    workspaceId: workspace.id,
    threadId: thread.id,
    raisingTurnId: turn.id,
    requestItemId: pendingRequestItemId(requestId, 'request'),
    kind: 'approval' as const,
    requesterKind: 'person' as const,
    responsibleUserId: userId,
    governedIntent: { operation: 'thread.archive-race-review' },
    approval: {
      kind: 'permission' as const,
      title: 'Review the original request',
      description: 'Keep this request and its original raising Turn intact.',
    },
    now: turn.startedAt!,
  };
  const archive = { requestId: randomUUID(), workspaceId: workspace.id, threadId: thread.id };
  return { root, store, workspace, thread, turn, reader, raise, archive, dependencies };
}

/** Exact committed rows expose partial metadata, sequence, Pending, receipt and Audit effects. */
function committedRows(reader: ReturnType<typeof openControlStoreProductReadHandle>) {
  return Object.fromEntries(
    [
      'control_workspaces',
      'control_threads',
      'control_turns',
      'control_agent_sessions',
      'control_product_entries',
      'pending_requests',
      'idempotency_requests',
      'audit_events',
    ].map((table) => [
      table,
      reader.sqlite
        .prepare(`SELECT * FROM ${table}`)
        .all()
        .map((row) => JSON.stringify(row))
        .sort(),
    ])
  );
}

describe('native standalone archive and concurrent Pending raise', () => {
  it('refuses archive when an unseen real raise commits after the empty Main census', async () => {
    const f = await fixture();
    const originalTurn = structuredClone(f.store.getTurnById(f.turn.id));
    const originalThread = structuredClone(f.store.getThread(f.workspace.id, f.thread.id));
    const originalReceipts = readCommandRequestRecordsFromSqlite(f.reader.sqlite);
    expect(originalTurn.status).toBe('running');
    expect(originalReceipts.map((receipt) => receipt.command).sort()).toEqual([
      'thread.create',
      'turn.start',
    ]);
    expect(f.reader.sqlite.prepare('SELECT * FROM pending_requests').all()).toEqual([]);

    const nativeUpdate = f.store.updateThread.bind(f.store);
    let committedBeforeArchive: ReturnType<typeof committedRows> | undefined;
    let raised: Awaited<ReturnType<typeof raiseRecordedPendingRequest>> | undefined;
    const boundary = vi.spyOn(f.store, 'updateThread').mockImplementationOnce(async (...args) => {
      expect(args.slice(0, 3)).toEqual([f.workspace.id, f.thread.id, { status: 'archived' }]);
      expect(args[3]?.receipt.command).toBe('thread.archive');
      // The real archive owner reaches this boundary only after its empty census selected no closeout.
      expect(f.reader.sqlite.prepare('SELECT * FROM pending_requests').all()).toEqual([]);
      raised = await raiseRecordedPendingRequest(f.store, f.reader.sqlite, f.raise);
      expect(raised).toMatchObject({
        requestId: f.raise.requestId,
        raisingTurnId: f.turn.id,
        requestItemId: f.raise.requestItemId,
        state: 'pending',
        claim: 'unclaimed',
        disposition: null,
        publicationTurnId: null,
        delivery: 'undelivered',
      });
      const currentTurn = f.store.getTurnById(f.turn.id);
      expect(currentTurn).toEqual({
        ...originalTurn,
        items: [expect.objectContaining({ id: f.raise.requestItemId, type: 'approval-request' })],
      });
      expect(validateCanonicalLoad(raised, [currentTurn], originalReceipts)).toBeNull();
      committedBeforeArchive = committedRows(f.reader);
      // Only ordering is intercepted. The original method must post the actual native archive tuple.
      return nativeUpdate(...args);
    });

    // Expected RED: stale empty-census archive succeeds, or returns a different refusal, after raise ACK.
    await expect(archiveThread(f.archive, f.dependencies, actor)).rejects.toMatchObject({
      status: 409,
      code: 'thread_busy',
    });
    expect(boundary).toHaveBeenCalledTimes(1);
    expect(committedBeforeArchive).toBeDefined();
    expect(committedRows(f.reader)).toEqual(committedBeforeArchive);
    expect(f.store.getThread(f.workspace.id, f.thread.id)).toEqual(originalThread);
    expect(readPendingRequest(f.reader.sqlite, f.raise.requestId)).toEqual(raised);
    expect(readCommandRequestRecordsFromSqlite(f.reader.sqlite)).toEqual(originalReceipts);
    expect(
      f.reader.sqlite
        .prepare('SELECT * FROM audit_events WHERE request_id = ?')
        .all(f.archive.requestId)
    ).toEqual([]);
    expect(f.store.listThreadTurns(f.workspace.id, f.thread.id)).toEqual([
      {
        ...originalTurn,
        items: [expect.objectContaining({ id: f.raise.requestItemId, type: 'approval-request' })],
      },
    ]);
    const reopened = new FsStore({ dataRoot: f.root });
    expect(reopened.getThread(f.workspace.id, f.thread.id)).toEqual(originalThread);
    expect(reopened.getTurnById(f.turn.id)).toEqual(f.store.getTurnById(f.turn.id));
  });

  it('permits archive with only the original running Turn and refuses a later real raise', async () => {
    const f = await fixture();
    const originalTurn = structuredClone(f.store.getTurnById(f.turn.id));
    const originalReceipts = readCommandRequestRecordsFromSqlite(f.reader.sqlite);
    const archived = await archiveThread(f.archive, f.dependencies, actor);
    expect(archived).toMatchObject({ id: f.thread.id, status: 'archived' });
    expect(f.store.getTurnById(f.turn.id)).toEqual(originalTurn);
    const receipts = readCommandRequestRecordsFromSqlite(f.reader.sqlite);
    expect(receipts.filter((receipt) => receipt.requestId !== f.archive.requestId)).toEqual(
      originalReceipts
    );
    expect(receipts.filter((receipt) => receipt.requestId === f.archive.requestId)).toMatchObject([
      { command: 'thread.archive', response: { kind: 'thread', id: f.thread.id } },
    ]);
    expect(
      f.reader.sqlite
        .prepare('SELECT action, outcome FROM audit_events WHERE request_id = ?')
        .all(f.archive.requestId)
    ).toEqual([{ action: 'thread.archive', outcome: 'succeeded' }]);
    const beforeRaise = committedRows(f.reader);

    await expect(
      raiseRecordedPendingRequest(f.store, f.reader.sqlite, f.raise)
    ).rejects.toMatchObject({ status: 409 });
    expect(committedRows(f.reader)).toEqual(beforeRaise);
    expect(readPendingRequest(f.reader.sqlite, f.raise.requestId)).toBeNull();
    expect(f.store.getThread(f.workspace.id, f.thread.id)).toEqual(archived);
    expect(f.store.listThreadTurns(f.workspace.id, f.thread.id)).toEqual([originalTurn]);
    expect(originalTurn).toMatchObject({ status: 'running', completedAt: null, items: [] });

    expect(await archiveThread(f.archive, f.dependencies, actor)).toEqual(archived);
    expect(committedRows(f.reader)).toEqual(beforeRaise);
  });

  it('refuses an archive queued after the actual Pending producer packet and keeps a sibling usable', async () => {
    const f = await fixture();
    const client = getControlStoreWorkerClient();
    const nativePending = client.pendingCommand.bind(client);
    const nativeArchive = client.transition.bind(client);
    const pendingPacket = Promise.withResolvers<Parameters<typeof nativePending>>();
    const archivePacket = Promise.withResolvers<Parameters<typeof nativeArchive>>();
    const pendingResult = Promise.withResolvers<Awaited<ReturnType<typeof nativePending>>>();
    const archiveResult = Promise.withResolvers<Awaited<ReturnType<typeof nativeArchive>>>();
    const originalThread = structuredClone(f.store.getThread(f.workspace.id, f.thread.id));
    const originalTurn = structuredClone(f.store.getTurnById(f.turn.id));
    const beforeQueue = committedRows(f.reader);

    // Capture production-prepared envelopes before their first post; only real native replies settle them.
    const pendingBoundary = vi.spyOn(client, 'pendingCommand').mockImplementationOnce((...args) => {
      pendingPacket.resolve(args);
      return pendingResult.promise;
    });
    const archiveBoundary = vi.spyOn(client, 'transition').mockImplementationOnce((...args) => {
      archivePacket.resolve(args);
      return archiveResult.promise;
    });
    const raiseAttempt = raiseRecordedPendingRequest(f.store, f.reader.sqlite, f.raise).then(
      (record) => ({ status: 'fulfilled' as const, record }),
      (reason: unknown) => ({ status: 'rejected' as const, reason })
    );
    const pendingArgs = await pendingPacket.promise;
    expect(pendingArgs[1].input).toMatchObject({ action: 'raise', input: f.raise });
    expect(pendingArgs[1].entries).toHaveLength(1);
    expect(committedRows(f.reader)).toEqual(beforeQueue);

    const archiveAttempt = archiveThread(f.archive, f.dependencies, actor).then(
      (thread) => ({ status: 'fulfilled' as const, thread }),
      (reason: unknown) => ({ status: 'rejected' as const, reason })
    );
    const archiveArgs = await archivePacket.promise;
    expect(archiveArgs[0]).toBe(pendingArgs[0]);
    expect(archiveArgs[1].receipt).toMatchObject({
      command: 'thread.archive',
      requestId: f.archive.requestId,
      response: { kind: 'thread', id: f.thread.id },
    });
    expect(archiveArgs[1].products).toMatchObject([
      { kind: 'thread', record: { id: f.thread.id, status: 'archived' } },
    ]);
    expect(committedRows(f.reader)).toEqual(beforeQueue);

    const resume = await client.pauseForDataRootBackup();
    try {
      // The existing hold admits both real envelopes in this order without posting either one yet.
      void nativePending(...pendingArgs).then(pendingResult.resolve, pendingResult.reject);
      void nativeArchive(...archiveArgs).then(archiveResult.resolve, archiveResult.reject);
      expect(committedRows(f.reader)).toEqual(beforeQueue);
    } finally {
      resume();
    }

    const raised = await raiseAttempt;
    expect(raised.status).toBe('fulfilled');
    if (raised.status !== 'fulfilled') throw raised.reason;
    expect(await archiveAttempt).toMatchObject({
      status: 'rejected',
      reason: { status: 409, code: 'thread_busy' },
    });
    expect(pendingBoundary).toHaveBeenCalledTimes(1);
    expect(archiveBoundary).toHaveBeenCalledTimes(1);
    pendingBoundary.mockRestore();
    archiveBoundary.mockRestore();

    const afterArchive = committedRows(f.reader);
    for (const table of [
      'control_workspaces',
      'control_threads',
      'control_turns',
      'control_agent_sessions',
      'idempotency_requests',
      'audit_events',
    ])
      expect(afterArchive[table]).toEqual(beforeQueue[table]);
    expect(afterArchive.pending_requests).toHaveLength(1);
    expect(afterArchive.control_product_entries).toHaveLength(
      beforeQueue.control_product_entries!.length + 1
    );
    expect(readPendingRequest(f.reader.sqlite, f.raise.requestId)).toEqual(raised.record);
    expect(raised.record).toMatchObject({
      state: 'pending',
      claim: 'unclaimed',
      disposition: null,
      publicationTurnId: null,
      delivery: 'undelivered',
    });
    const retainedTurn = f.store.getTurnById(f.turn.id);
    expect(retainedTurn).toEqual({
      ...originalTurn,
      items: [expect.objectContaining({ id: f.raise.requestItemId, type: 'approval-request' })],
    });
    expect(
      validateCanonicalLoad(
        raised.record,
        [retainedTurn],
        readCommandRequestRecordsFromSqlite(f.reader.sqlite)
      )
    ).toBeNull();
    expect(f.store.getThread(f.workspace.id, f.thread.id)).toEqual(originalThread);

    const siblingInput = {
      requestId: randomUUID(),
      workspaceId: f.workspace.id,
      name: 'Independent sibling after archive refusal',
      visibility: 'workspace' as const,
    };
    const sibling = await createThread(siblingInput, f.dependencies, userId);
    expect(sibling).toMatchObject({ status: 'active', name: siblingInput.name });
    expect(sibling.id).not.toBe(f.thread.id);
    expect(f.store.getThread(f.workspace.id, f.thread.id)).toEqual(originalThread);
    expect(f.store.getTurnById(f.turn.id)).toEqual(retainedTurn);
    expect(readPendingRequest(f.reader.sqlite, f.raise.requestId)).toEqual(raised.record);
    expect(
      f.reader.sqlite
        .prepare('SELECT command_name, response_id FROM idempotency_requests WHERE request_id = ?')
        .all(siblingInput.requestId)
    ).toEqual([{ command_name: 'thread.create', response_id: sibling.id }]);
    expect(
      f.reader.sqlite
        .prepare('SELECT action, outcome FROM audit_events WHERE request_id = ?')
        .all(siblingInput.requestId)
    ).toEqual([{ action: 'thread.create', outcome: 'succeeded' }]);
    const beforeReplay = committedRows(f.reader);
    expect(await createThread(siblingInput, f.dependencies, userId)).toEqual(sibling);
    expect(committedRows(f.reader)).toEqual(beforeReplay);
  });

  it('preserves an inspect-only request without treating its contradictory Item as archive authority', async () => {
    const f = await fixture();
    const record = await raiseRecordedPendingRequest(f.store, f.reader.sqlite, f.raise);
    const requestItem = f.store
      .getTurnById(f.turn.id)
      .items.find((item) => item.id === f.raise.requestItemId);
    if (requestItem?.type !== 'approval-request') throw new Error('Real request Item is missing.');
    expect(
      validateCanonicalLoad(
        record,
        [f.store.getTurnById(f.turn.id)],
        readCommandRequestRecordsFromSqlite(f.reader.sqlite)
      )
    ).toBeNull();
    // A real Item revision creates the contradiction through the existing sole native writer.
    const contradictoryItem = await f.store.createItem({
      ...requestItem,
      title: 'Conflicting retained request title',
    });
    const turn = structuredClone(f.store.getTurnById(f.turn.id));
    expect(turn).toMatchObject({
      status: 'running',
      completedAt: null,
      items: [contradictoryItem],
    });
    expect(readPendingRequest(f.reader.sqlite, f.raise.requestId)).toEqual(record);
    expect(
      validateCanonicalLoad(record, [turn], readCommandRequestRecordsFromSqlite(f.reader.sqlite))
    ).toMatchObject({ requestId: f.raise.requestId });
    const beforeArchive = committedRows(f.reader);

    const archived = await archiveThread(f.archive, f.dependencies, actor);
    expect(archived).toMatchObject({ id: f.thread.id, status: 'archived' });
    const afterArchive = committedRows(f.reader);
    for (const table of [
      'control_workspaces',
      'control_turns',
      'control_agent_sessions',
      'control_product_entries',
      'pending_requests',
    ])
      expect(afterArchive[table]).toEqual(beforeArchive[table]);
    expect(f.store.listThreadTurns(f.workspace.id, f.thread.id)).toEqual([turn]);
    expect(readPendingRequest(f.reader.sqlite, f.raise.requestId)).toEqual(record);
    expect(
      f.reader.sqlite
        .prepare('SELECT command_name, response_id FROM idempotency_requests WHERE request_id = ?')
        .all(f.archive.requestId)
    ).toEqual([{ command_name: 'thread.archive', response_id: f.thread.id }]);
    expect(
      f.reader.sqlite
        .prepare('SELECT action, outcome FROM audit_events WHERE request_id = ?')
        .all(f.archive.requestId)
    ).toEqual([{ action: 'thread.archive', outcome: 'succeeded' }]);
    expect(afterArchive.idempotency_requests).toHaveLength(
      beforeArchive.idempotency_requests!.length + 1
    );
    expect(afterArchive.audit_events).toHaveLength(beforeArchive.audit_events!.length + 1);
  });

  it('replays the original native archive receipt with an unrelated Item body unavailable', async () => {
    const f = await fixture();
    const item = await f.store.createItem({
      id: allocateEntityId('it'),
      owner: f.turn.owner,
      threadId: f.thread.id,
      turnId: f.turn.id,
      type: 'user-message',
      actor: { kind: 'user', id: userId },
      text: 'Existing history is not a fresh archive admission dependency on exact replay.',
      status: 'completed',
      createdAt: f.turn.startedAt!,
      completedAt: f.turn.startedAt!,
    });
    const scope = nativeProductScope(f.root, f.turn.owner);
    const client = getControlStoreWorkerClient();
    const nativeTransition = client.transition.bind(client);
    let originalArgs: Parameters<typeof nativeTransition> | undefined;
    const boundary = vi.spyOn(client, 'transition').mockImplementationOnce((...args) => {
      originalArgs = structuredClone(args);
      return nativeTransition(...args);
    });
    const archived = await archiveThread(f.archive, f.dependencies, actor);
    expect(archived).toMatchObject({ id: f.thread.id, status: 'archived' });
    expect(f.store.getTurnById(f.turn.id)).toMatchObject({
      status: 'running',
      completedAt: null,
      items: [item],
    });
    expect(boundary).toHaveBeenCalledTimes(1);
    boundary.mockRestore();
    if (!originalArgs) throw new Error('Original native archive envelope was not captured.');
    const [database, originalEnvelope] = originalArgs;
    const receipt = readCommandRequestRecordsFromSqlite(f.reader.sqlite).find(
      (record) => record.requestId === f.archive.requestId
    );
    expect(receipt).toMatchObject({
      key: originalEnvelope.receipt.key,
      command: 'thread.archive',
      inputHash: originalEnvelope.receipt.inputHash,
      response: { kind: 'thread', id: f.thread.id },
    });
    expect(Date.parse(receipt!.expiresAt)).toBeGreaterThan(Date.now());
    expect(
      f.reader.sqlite
        .prepare('SELECT action, outcome FROM audit_events WHERE request_id = ?')
        .all(f.archive.requestId)
    ).toEqual([{ action: 'thread.archive', outcome: 'succeeded' }]);
    const row = f.reader.sqlite
      .prepare(
        "SELECT content_json FROM control_product_entries WHERE kind='item' AND turn_id=? AND id=? ORDER BY revision DESC LIMIT 1"
      )
      .get(f.turn.id, item.id) as { content_json: string } | undefined;
    if (!row) throw new Error('Acknowledged native Item descriptor is missing.');
    const content = ControlProductEntrySchema.shape.content.parse(JSON.parse(row.content_json));
    const immutablePath = join(scope.contentMount.root, content.reference.locator.path);
    const originalBytes = readFileSync(immutablePath);
    const beforeReplay = committedRows(f.reader);

    // The real writer must stop before this fixture-only loss of an acknowledged immutable body.
    await shutdownControlStoreWorkerClient();
    const unavailablePath = `${immutablePath}.unavailable-${randomUUID()}`;
    renameSync(immutablePath, unavailablePath);
    expect(existsSync(immutablePath)).toBe(false);
    const immutableDirectoryEntries = readdirSync(dirname(immutablePath)).sort();
    const coldClient = getControlStoreWorkerClient();
    await coldClient.open({
      database,
      path: scope.path,
      dataRoot: f.root,
      create: false,
      initialize: 'workspace',
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });

    // Expected RED: native fresh-history preparation reads the missing body before exact receipt lookup.
    await expect(coldClient.transition(database, originalEnvelope)).resolves.toMatchObject({
      replayed: true,
      response: { kind: 'thread', id: f.thread.id },
    });
    expect(committedRows(f.reader)).toEqual(beforeReplay);
    expect(existsSync(immutablePath)).toBe(false);
    expect(readFileSync(unavailablePath)).toEqual(originalBytes);
    expect(readdirSync(dirname(immutablePath)).sort()).toEqual(immutableDirectoryEntries);

    const conflictingEnvelope = structuredClone(originalEnvelope);
    conflictingEnvelope.receipt.inputHash = commandInputHash({
      ...f.archive,
      threadId: allocateEntityId('th'),
    });
    expect(conflictingEnvelope.receipt.inputHash).not.toBe(originalEnvelope.receipt.inputHash);
    await expect(coldClient.transition(database, conflictingEnvelope)).rejects.toMatchObject({
      commit: 'not-committed',
    });
    expect(committedRows(f.reader)).toEqual(beforeReplay);
    expect(existsSync(immutablePath)).toBe(false);
    expect(readFileSync(unavailablePath)).toEqual(originalBytes);
    expect(readdirSync(dirname(immutablePath)).sort()).toEqual(immutableDirectoryEntries);
  });
});

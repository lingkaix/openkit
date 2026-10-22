import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { commandRequestKey, FsStore } from '../lib/store.js';
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
import { archiveThreadWithCloseout, raiseRecordedPendingRequest } from './pending-request-flow.js';
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
      'control_work_observations',
      'runtime_evidence',
      'control_executions',
      'control_execution_steps',
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

  it.each([
    'lifecycle',
    'public',
  ] as const)('refuses %s closeout when a real Turn wins after native packet preparation', async (path) => {
    const f = await fixture();
    await raiseRecordedPendingRequest(f.store, f.reader.sqlite, f.raise);
    await f.store.completeTurn(f.turn.id, {
      status: 'completed',
      completedAt: f.turn.startedAt!,
    });
    const request = readPendingRequest(f.reader.sqlite, f.raise.requestId)!;
    const raisingTurn = structuredClone(f.store.getTurnById(f.turn.id));
    const raisingEvents = structuredClone(f.store.getTurnEventsForExport(f.turn.id));
    const receipts = readCommandRequestRecordsFromSqlite(f.reader.sqlite);
    const beforePreparation = committedRows(f.reader);
    expect(request).toMatchObject({
      state: 'pending',
      claim: 'unclaimed',
      publicationTurnId: null,
      delivery: 'undelivered',
    });
    expect(raisingTurn.status).toBe('completed');
    const client = getControlStoreWorkerClient();
    const nativePending = client.pendingCommand.bind(client);
    const packet = Promise.withResolvers<Parameters<typeof nativePending>>();
    const reply = Promise.withResolvers<Awaited<ReturnType<typeof nativePending>>>();
    // Hold only the real producer's first post; the unchanged packet receives a real native reply.
    const boundary = vi.spyOn(client, 'pendingCommand').mockImplementationOnce((...args) => {
      packet.resolve(args);
      return reply.promise;
    });
    const archiveAttempt = (
      path === 'public'
        ? archiveThread(f.archive, f.dependencies, actor)
        : archiveThreadWithCloseout(
            f.store,
            { openWorkspace: f.dependencies.repositoryWorkspaceDb },
            f.workspace.id,
            f.thread.id,
            { kind: 'user', id: userId }
          )
    ).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason })
    );
    const args = await packet.promise;
    let winningTurn: Awaited<ReturnType<typeof f.store.createTurn>>;
    let winningThread: ReturnType<typeof f.store.getThread>;
    let beforeRelease: ReturnType<typeof committedRows>;
    try {
      expect(args[1].input).toMatchObject({
        action: 'closeout',
        workspaceId: f.workspace.id,
        threadId: f.thread.id,
        expectedThreadCensus: [f.raise.requestId],
        expected: [expect.objectContaining({ requestId: f.raise.requestId })],
      });
      expect(args[1].terminal).toMatchObject({
        turn: { expectedRevision: 0, record: { status: 'completed' } },
        execution: null,
        command: null,
        evidence: [],
      });
      expect(args[1].receipt).toBeNull();
      if (path === 'public') {
        const scope = { workspaceId: f.workspace.id, threadId: f.thread.id };
        expect(args[1].admission?.receipt).toMatchObject({
          key: commandRequestKey('thread.archive', f.archive.requestId, scope),
          command: 'thread.archive',
          requestId: f.archive.requestId,
          scope,
          inputHash: commandInputHash(f.archive),
          response: { kind: 'thread', id: f.thread.id },
        });
        expect(args[1].admission?.audit).toMatchObject({
          requestId: f.archive.requestId,
          action: 'thread.archive',
        });
      } else {
        expect(args[1].admission).toBeUndefined();
      }
      expect(committedRows(f.reader)).toEqual(beforePreparation);
      winningTurn = await f.store.createTurn(
        f.workspace.id,
        f.thread.id,
        'Competing Turn admitted before archive closeout',
        { kind: 'user', id: userId },
        null,
        { agentId: null, agentSessionId: null }
      );
      expect(
        f.reader.sqlite
          .prepare(
            "SELECT id, status FROM control_turns WHERE thread_id=? AND status IN ('pending','running')"
          )
          .all(f.thread.id)
      ).toEqual([{ id: winningTurn.id, status: 'running' }]);
      winningThread = structuredClone(f.store.getThread(f.workspace.id, f.thread.id));
      beforeRelease = committedRows(f.reader);
    } finally {
      void nativePending(...args).then(reply.resolve, reply.reject);
    }
    const result = await archiveAttempt;
    expect(boundary).toHaveBeenCalledTimes(1);
    boundary.mockRestore();
    // A refusal must roll back every selected request, product, original receipt and Audit write.
    expect(committedRows(f.reader)).toEqual(beforeRelease);
    expect(readPendingRequest(f.reader.sqlite, f.raise.requestId)).toEqual(request);
    expect(f.store.getThread(f.workspace.id, f.thread.id)).toEqual(winningThread);
    expect(winningThread.status).toBe('active');
    expect(f.store.getTurnById(f.turn.id)).toEqual(raisingTurn);
    expect(f.store.getTurnEventsForExport(f.turn.id)).toEqual(raisingEvents);
    expect(f.store.getTurnById(winningTurn.id)).toEqual(winningTurn);
    const turns = f.store.listThreadTurns(f.workspace.id, f.thread.id);
    expect(turns.map((turn) => turn.id).sort()).toEqual([f.turn.id, winningTurn.id].sort());
    expect(readCommandRequestRecordsFromSqlite(f.reader.sqlite)).toEqual(receipts);
    expect(
      f.reader.sqlite
        .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
        .all(f.archive.requestId)
    ).toEqual([]);
    expect(
      f.reader.sqlite
        .prepare('SELECT * FROM audit_events WHERE request_id=?')
        .all(f.archive.requestId)
    ).toEqual([]);
    expect(validateCanonicalLoad(request, turns, receipts)).toBeNull();
    // Expected RED: stale closeout commits or returns a generic precondition instead of thread_busy.
    expect(result).toMatchObject({
      status: 'rejected',
      reason: { status: 409, code: 'thread_busy' },
    });
  });

  it('archives an idle request with one fresh immutable service outcome and refuses later Turn admission', async () => {
    const f = await fixture();
    await raiseRecordedPendingRequest(f.store, f.reader.sqlite, f.raise);
    // This fixture is a Core-local person's request, with no Worker or invented runtime proof.
    await f.store.completeTurn(f.turn.id, {
      status: 'completed',
      completedAt: f.turn.startedAt!,
    });
    const raisingTurn = structuredClone(f.store.getTurnById(f.turn.id));
    const raisingEvents = structuredClone(f.store.getTurnEventsForExport(f.turn.id));
    const before = committedRows(f.reader);
    expect(raisingTurn.status).toBe('completed');
    expect(raisingTurn.agentId ?? null).toBeNull();
    expect(raisingTurn.agentSessionId ?? null).toBeNull();
    expect(readPendingRequest(f.reader.sqlite, f.raise.requestId)).toMatchObject({
      state: 'pending',
      publicationTurnId: null,
      delivery: 'undelivered',
    });

    // Expected RED: archive prepares a fresh terminal service Turn against already-archived metadata.
    expect(
      await archiveThreadWithCloseout(
        f.store,
        { openWorkspace: f.dependencies.repositoryWorkspaceDb },
        f.workspace.id,
        f.thread.id,
        { kind: 'user', id: userId }
      )
    ).toBe(f.thread.id);
    const archived = f.store.getThread(f.workspace.id, f.thread.id);
    expect(archived).toMatchObject({ id: f.thread.id, status: 'archived' });
    const turns = f.store.listThreadTurns(f.workspace.id, f.thread.id);
    expect(turns).toHaveLength(2);
    const closeout = turns.find((turn) => turn.id !== f.turn.id)!;
    expect(closeout).toMatchObject({
      owner: f.turn.owner,
      threadId: f.thread.id,
      status: 'completed',
      agentId: null,
      agentSessionId: null,
      triggerSource: { kind: 'system-input' },
      completedAt: expect.any(String),
      items: [
        expect.objectContaining({
          id: pendingRequestItemId(f.raise.requestId, 'ending'),
          type: 'status',
          turnId: closeout.id,
          threadId: f.thread.id,
          causationId: f.raise.requestItemId,
          summary: 'thread-archived',
          status: 'completed',
        }),
      ],
    });
    expect(closeout.items).toHaveLength(1);
    expect(readPendingRequest(f.reader.sqlite, f.raise.requestId)).toMatchObject({
      state: 'ended',
      ending: 'invalidated',
      invalidatingEvent: 'thread-archived',
      endingActor: { kind: 'user', id: userId },
      endedAt: closeout.completedAt,
      publicationTurnId: closeout.id,
      delivery: 'closed-out',
      deliveryTurnId: null,
      claim: 'unclaimed',
      disposition: null,
    });
    const events = f.store.getTurnEventsForExport(closeout.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      workspaceId: f.workspace.id,
      threadId: f.thread.id,
      turnId: closeout.id,
      event: 'turn.completed',
      data: { type: 'turn-completed', stopReason: 'completed', turn: closeout },
    });
    expect(f.store.getTurnById(f.turn.id)).toEqual(raisingTurn);
    expect(f.store.getTurnEventsForExport(f.turn.id)).toEqual(raisingEvents);
    // A lifecycle archive without command admission creates no substitute receipt or Audit.
    expect(committedRows(f.reader).idempotency_requests).toEqual(before.idempotency_requests);
    expect(committedRows(f.reader).audit_events).toEqual(before.audit_events);
    const committed = committedRows(f.reader);
    expect(committed.control_turns).toHaveLength(before.control_turns!.length + 1);
    for (const table of ['runtime_evidence', 'control_executions', 'control_execution_steps'])
      expect(committed[table]).toEqual(before[table]);

    // Archive closeout is the admitted exception; ordinary fresh admission remains forbidden.
    await expect(
      f.store.createTurn(
        f.workspace.id,
        f.thread.id,
        'Fresh work after archive must be refused',
        { kind: 'user', id: userId },
        null,
        { agentId: null, agentSessionId: null }
      )
    ).rejects.toThrow();
    await expect(f.store.updateTurn(closeout.id, { status: 'failed' })).rejects.toThrow();
    expect(committedRows(f.reader)).toEqual(committed);
    // Repeating lifecycle closeout cannot move or republish its outcome. Thread update time may refresh.
    await archiveThreadWithCloseout(
      f.store,
      { openWorkspace: f.dependencies.repositoryWorkspaceDb },
      f.workspace.id,
      f.thread.id,
      { kind: 'user', id: userId }
    );
    const repeated = committedRows(f.reader);
    for (const table of Object.keys(committed).filter((table) => table !== 'control_threads'))
      expect(repeated[table]).toEqual(committed[table]);
    expect(f.store.getTurnById(closeout.id)).toEqual(closeout);
    expect(f.store.getTurnEventsForExport(closeout.id)).toEqual(events);
    const retainedArchived = f.store.getThread(f.workspace.id, f.thread.id);
    expect(retainedArchived).toEqual({ ...archived, updatedAt: expect.any(String) });

    // A new read-only handle opens only after the actual live writer has stopped.
    await shutdownControlStoreWorkerClient();
    const scope = nativeProductScope(f.root, f.turn.owner);
    const cold = openControlStoreProductReadHandle(scope.path, scope.owner);
    readers.push(cold);
    expect(committedRows(cold)).toEqual(repeated);
    const reopened = new FsStore({ dataRoot: f.root });
    expect(reopened.getThread(f.workspace.id, f.thread.id)).toEqual(retainedArchived);
    expect(reopened.getTurnById(f.turn.id)).toEqual(raisingTurn);
    expect(reopened.getTurnById(closeout.id)).toEqual(closeout);
    expect(reopened.getTurnEventsForExport(closeout.id)).toEqual(events);
    const record = readPendingRequest(cold.sqlite, f.raise.requestId)!;
    expect(
      validateCanonicalLoad(
        record,
        reopened.listThreadTurns(f.workspace.id, f.thread.id),
        readCommandRequestRecordsFromSqlite(cold.sqlite)
      )
    ).toBeNull();
  });

  it('rolls back fresh lifecycle closeout when the native archived-status write fails', async () => {
    const f = await fixture();
    const request = await raiseRecordedPendingRequest(f.store, f.reader.sqlite, f.raise);
    await f.store.completeTurn(f.turn.id, {
      status: 'completed',
      completedAt: f.turn.startedAt!,
    });
    const raisingTurn = structuredClone(f.store.getTurnById(f.turn.id));
    const originalThread = structuredClone(f.store.getThread(f.workspace.id, f.thread.id));
    const before = committedRows(f.reader);
    await shutdownControlStoreWorkerClient();
    const stopped = openWorkspaceDb(f.root, f.workspace.id);
    try {
      // The trigger fires only when this archive write follows the complete closeout in its transaction.
      stopped.sqlite.exec(`
        CREATE TRIGGER refuse_archive_closeout_status BEFORE UPDATE OF status ON control_threads
        WHEN NEW.id = '${f.thread.id}' AND NEW.status = 'archived' AND OLD.status = 'active'
          AND EXISTS (
            SELECT 1 FROM pending_requests p JOIN control_turns t ON t.id = p.publication_turn_id
            WHERE p.request_id = '${f.raise.requestId}' AND p.state = 'ended'
              AND p.delivery = 'closed-out' AND t.status = 'completed' AND t.id != '${f.turn.id}'
              AND EXISTS (SELECT 1 FROM control_product_entries e WHERE e.turn_id = t.id AND e.kind = 'event')
              AND EXISTS (SELECT 1 FROM control_product_entries e WHERE e.turn_id = t.id
                AND e.kind = 'item' AND e.id = '${pendingRequestItemId(f.raise.requestId, 'ending')}')
          )
        BEGIN SELECT RAISE(ABORT, 'archive closeout status refused'); END
      `);
    } finally {
      stopped.sqlite.close();
    }

    // Expected RED: a premature precondition refusal never reaches this in-transaction fault.
    await expect(
      archiveThreadWithCloseout(
        f.store,
        { openWorkspace: f.dependencies.repositoryWorkspaceDb },
        f.workspace.id,
        f.thread.id,
        { kind: 'user', id: userId }
      )
    ).rejects.toMatchObject({
      code: 'constraint',
      commit: 'not-committed',
    });
    await shutdownControlStoreWorkerClient();
    const scope = nativeProductScope(f.root, f.turn.owner);
    const cold = openControlStoreProductReadHandle(scope.path, scope.owner);
    readers.push(cold);
    expect(committedRows(cold)).toEqual(before);
    const reopened = new FsStore({ dataRoot: f.root });
    expect(reopened.getThread(f.workspace.id, f.thread.id)).toEqual(originalThread);
    expect(reopened.listThreadTurns(f.workspace.id, f.thread.id)).toEqual([raisingTurn]);
    expect(readPendingRequest(cold.sqlite, f.raise.requestId)).toEqual(request);
    expect(committedRows(cold).idempotency_requests).toEqual(before.idempotency_requests);
    expect(committedRows(cold).audit_events).toEqual(before.audit_events);
  });
});

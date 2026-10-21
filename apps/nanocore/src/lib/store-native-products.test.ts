import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allocateEntityId,
  deriveEntityId,
  ItemSchema,
  PROTOCOL_VERSION,
  SseEventEnvelopeSchema,
  writeRetainedV1,
} from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareAuditEvent } from '../audit-events.js';
import { initializeDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { WORKSPACE_WORKER_TURN_EXECUTION_DEFINITION } from '../runtime/execution-journal.js';
import type { ExecutionJournalSpan } from '../runtime/execution-step-journal.js';
import { openControlStoreProductReadHandle } from '../storage/control-store-products.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  nativeProductScope,
  readNativeProductEntries,
  readNativeTurnHistory,
} from '../storage/workspace-file-records.js';
import { createThread as createThreadCommand } from '../thread-routes.js';
import { commandRequestKey, DISPLAY_PROJECTION_REFRESH_ADMISSION, FsStore } from './store.js';

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
  it('acknowledges independent concurrent shared Thread creations without losing parent metadata', async () => {
    const f = fixture();
    const workspace = await f.store.createWorkspace('Concurrent parent metadata');
    const before = structuredClone(f.store.getWorkspace(workspace.id));
    const commands = ['First independent Thread', 'Second independent Thread'].map((name) => ({
      workspaceId: workspace.id,
      requestId: randomUUID(),
      name,
      visibility: 'workspace' as const,
    }));
    const dependencies: Parameters<typeof createThreadCommand>[1] = {
      store: f.store,
      inflightCommands: new WeakMap(),
    };
    const startedAt = Date.now();
    const outcomes = await Promise.allSettled(
      commands.map((command) => createThreadCommand(command, dependencies, actor.id))
    );
    const acknowledgedAt = Date.now();
    expect(outcomes).toMatchObject([{ status: 'fulfilled' }, { status: 'fulfilled' }]);
    const threads = outcomes.map((outcome) => {
      if (outcome.status === 'rejected') throw outcome.reason;
      return outcome.value;
    });
    expect(new Set(threads.map((thread) => thread.id)).size).toBe(2);
    for (const [index, thread] of threads.entries()) {
      expect(thread).toMatchObject({
        owner: { kind: 'workspace', workspaceId: workspace.id },
        visibility: 'workspace',
        name: commands[index]!.name,
        preview: commands[index]!.name,
      });
      expect(Date.parse(thread.createdAt)).toBeGreaterThanOrEqual(startedAt);
      expect(Date.parse(thread.updatedAt)).toBeGreaterThanOrEqual(Date.parse(thread.createdAt));
      expect(Date.parse(thread.updatedAt)).toBeLessThanOrEqual(acknowledgedAt);
      expect(f.store.getThread(workspace.id, thread.id)).toEqual(thread);
    }
    const ids = threads.map((thread) => thread.id).sort();
    expect(
      f.store
        .listThreads(workspace.id)
        .map((thread) => thread.id)
        .sort()
    ).toEqual(ids);
    const after = structuredClone(f.store.getWorkspace(workspace.id));
    expect({ ...after, counts: before.counts, updatedAt: before.updatedAt }).toEqual(before);
    expect(after.counts).toEqual({ ...before.counts, threadCount: before.counts.threadCount + 2 });
    expect(Date.parse(after.updatedAt)).toBeGreaterThanOrEqual(
      Math.max(
        Date.parse(before.updatedAt),
        ...threads.map((thread) => Date.parse(thread.createdAt))
      )
    );
    expect(Date.parse(after.updatedAt)).toBeLessThanOrEqual(acknowledgedAt);

    await shutdownControlStoreWorkerClient();
    const reopened = new FsStore({ dataRoot: f.root });
    expect(reopened.getWorkspace(workspace.id)).toEqual(after);
    for (const thread of threads)
      expect(reopened.getThread(workspace.id, thread.id)).toEqual(thread);
    const replayDependencies: Parameters<typeof createThreadCommand>[1] = {
      store: reopened,
      inflightCommands: new WeakMap(),
    };
    expect(
      await Promise.all(
        commands.map((command) => createThreadCommand(command, replayDependencies, actor.id))
      )
    ).toEqual(threads);
    const scope = nativeProductScope(f.root, { kind: 'workspace', workspaceId: workspace.id });
    const reader = openControlStoreProductReadHandle(scope.path, scope.owner);
    try {
      expect(reader.sqlite.prepare('SELECT id FROM control_threads ORDER BY id').all()).toEqual(
        ids.map((id) => ({ id }))
      );
      expect(
        reader.sqlite
          .prepare(
            "SELECT request_id, response_id FROM idempotency_requests WHERE command_name = 'thread.create' ORDER BY request_id"
          )
          .all()
      ).toEqual(
        commands
          .map((command, index) => ({
            request_id: command.requestId,
            response_id: threads[index]!.id,
          }))
          .sort((left, right) => left.request_id.localeCompare(right.request_id))
      );
      expect(
        reader.sqlite
          .prepare(
            "SELECT request_id, thread_id, resource, outcome FROM audit_events WHERE action = 'thread.create' ORDER BY request_id"
          )
          .all()
      ).toEqual(
        commands
          .map((command, index) => ({
            request_id: command.requestId,
            thread_id: threads[index]!.id,
            resource: `thread:${threads[index]!.id}`,
            outcome: 'succeeded',
          }))
          .sort((left, right) => left.request_id.localeCompare(right.request_id))
      );
    } finally {
      reader.close();
    }
    expect(reopened.getWorkspace(workspace.id)).toEqual(after);
  });

  it('publishes a service terminal tuple only after commit and retries a real SQL rollback', async () => {
    const f = await workspaceFixture();
    const item = message(f.turn, 'Terminal result');
    const completedAt = f.turn.startedAt!;
    const observed: number[] = [];
    f.store.addTurnListener(f.turn.id, (event) => observed.push(event.sequence));
    const db = openWorkspaceDb(f.root, f.workspace.id);
    try {
      db.sqlite.exec(`CREATE TRIGGER terminal_store_abort BEFORE UPDATE ON control_turns
        WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT,'terminal_store_abort'); END`);
      await expect(
        f.store.completeTurn(f.turn.id, { status: 'completed', completedAt }, { items: [item] })
      ).rejects.toMatchObject({ code: 'constraint', commit: 'not-committed' });
      expect(f.store.getTurnById(f.turn.id)).toMatchObject({ status: 'running', items: [] });
      expect(f.store.getTurnEventsForExport(f.turn.id)).toEqual([]);
      expect(observed).toEqual([]);
      db.sqlite.exec('DROP TRIGGER terminal_store_abort');
      const turn = await f.store.completeTurn(
        f.turn.id,
        { status: 'completed', completedAt },
        { items: [item] }
      );
      expect(turn).toMatchObject({ status: 'completed', items: [item] });
      expect(observed).toEqual([]);
      const event = f.store.getTurnEventsForExport(f.turn.id).at(-1)!;
      expect(event).toMatchObject({ event: 'turn.completed', data: { turn } });
      f.store.emitTurnEvent(f.turn.id, await f.store.persistTurnEvent(f.turn.id, event));
      expect(observed).toEqual([1]);
      await expect(
        f.store.completeTurn(f.turn.id, { status: 'completed', completedAt }, { items: [item] })
      ).resolves.toEqual(turn);
      expect(f.store.getTurnEventsForExport(f.turn.id)).toEqual([event]);
      await shutdownControlStoreWorkerClient();
      expect(new FsStore({ dataRoot: f.root }).getTurnById(f.turn.id)).toEqual(turn);
    } finally {
      db.sqlite.close();
    }
  });

  it.each(['message', 'display'])('preserves %s history on terminal replay', async (kind) => {
    const f = await workspaceFixture();
    const session = await f.store.createAgentSession({
      id: allocateEntityId('as'),
      workspaceId: f.workspace.id,
      threadId: f.thread.id,
      agentId: 'agent_codex_host',
      status: 'ready',
      message: null,
      createdAt: f.turn.startedAt!,
      updatedAt: f.turn.startedAt!,
    });
    await f.store.updateTurn(f.turn.id, { agentId: session.agentId, agentSessionId: session.id });
    const first =
      kind === 'message'
        ? message(f.turn, 'A')
        : ItemSchema.parse({
            id: deriveEntityId('it', ['worker-result', f.turn.id]),
            owner: f.turn.owner,
            threadId: f.thread.id,
            turnId: f.turn.id,
            type: 'status',
            status: 'completed',
            actor,
            level: 'info',
            title: 'Result',
            summary: 'A',
            createdAt: f.turn.startedAt!,
            completedAt: f.turn.startedAt!,
          });
    await f.store.createItem(first);
    await f.store.updateItem(first.id, kind === 'message' ? { text: 'B' } : { summary: 'B' });
    const db = openWorkspaceDb(f.root, f.workspace.id);
    const { sqlite } = db;
    try {
      const now = BigInt(Date.now()) * 1_000_000n;
      const empty = { attributes: [], droppedAttributesCount: 0 };
      const span: ExecutionJournalSpan & { endTimeUnixNano: null } = {
        traceId: '1'.repeat(32),
        spanId: '1'.padStart(16, '0'),
        flags: 1,
        name: 'Original terminal history',
        kind: 'INTERNAL',
        startTimeUnixNano: now,
        endTimeUnixNano: null,
        status: { code: 'UNSET' },
        ...empty,
        events: [],
        droppedEventsCount: 0,
        links: [],
        droppedLinksCount: 0,
        instrumentationScope: { ...empty, name: 'openkit.history-test' },
        resource: empty,
      };
      const admission = {
        ref: { owner: f.turn.owner, executionId: 'original-history-execution' },
        definitionVersion: WORKSPACE_WORKER_TURN_EXECUTION_DEFINITION,
        workId: f.turn.id,
        fingerprint: 'a'.repeat(64),
        exclusionRefs: ['original:cleanup'],
        span,
      };
      for (const [index, stepId] of (
        ['terminal-publication', 'inspect-cleanup'] as const
      ).entries()) {
        await f.store.writeWorkspaceExecutionJournalIntent(f.workspace.id, {
          execution: admission,
          stepId,
          parentStepId: null,
          parent: null,
          inspectedStep: null,
          carriage: {
            operation: stepId,
            requestId: String(index + 2).repeat(64),
            sequence: null,
            bindingRef: null,
          },
          control: {
            definitionVersion: admission.definitionVersion,
            kind: stepId,
            target: null,
            workId: f.turn.id,
            operationId: null,
            attemptId: null,
            invocationId: `original-${stepId}`,
            actor,
            inputRefs: ['original:input'],
            outputRefs: [],
            fingerprint: 'b'.repeat(64),
            permittingDecisionRef: null,
            authorityRefs: ['original:workspace'],
            retryDeclarationRef: null,
            retryPermitted: false,
            deadlineUnixNano: now + 60_000_000_000n,
            physicalFenceRefs: [],
          },
          span: {
            ...span,
            spanId: String(index + 2).padStart(16, '0'),
            parentSpanId: span.spanId,
          },
        });
      }
      const requestId = randomUUID();
      const scope = { workspaceId: f.workspace.id };
      const createdAt = f.turn.startedAt!;
      const receipt = {
        key: commandRequestKey('turn.start', requestId, scope),
        command: 'turn.start' as const,
        requestId,
        scope,
        inputHash: 'sha256:78c69048486cc3ab57a442a9ee2cd89da02f7b20c609b180562977c4c3054be1',
        response: { kind: 'turn', id: f.turn.id },
        createdAt,
        expiresAt: new Date(Date.parse(createdAt) + 7 * 24 * 60 * 60 * 1000).toISOString(),
      };
      const rev = Number(sqlite.prepare('SELECT revision FROM control_executions').pluck().get());
      const input = {
        items: [first],
        requestId,
        stopReason: 'error' as const,
        command: {
          receipt,
          audit: prepareAuditEvent({
            workspaceId: f.workspace.id,
            threadId: f.thread.id,
            turnId: f.turn.id,
            requestId,
            actor,
            category: 'command',
            action: 'turn.start',
            resource: `turn:${f.turn.id}`,
            outcome: 'succeeded',
            summary: 'Original terminal publication.',
            now: new Date(createdAt),
          }),
        },
        execution: {
          executionId: admission.ref.executionId,
          terminalStepId: 'terminal-publication',
          cleanupStepId: 'inspect-cleanup',
          expectedRevision: rev,
        },
      };
      const patch = { status: 'failed' as const, completedAt: createdAt };
      const terminal = await f.store.completeTurn(f.turn.id, patch, input);
      expect(terminal).toMatchObject({
        id: f.turn.id,
        agentSessionId: session.id,
        status: 'failed',
        items: [first],
      });
      const events = f.store.getTurnEventsForExport(f.turn.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event: 'turn.completed',
        requestId,
        data: { type: 'turn-completed', stopReason: 'error', turn: terminal },
      });
      const revisions = readNativeProductEntries(f.scope, f.turn.id, 'item');
      expect(revisions.map(({ id }) => id)).toEqual([first.id, first.id, first.id]);
      expect(revisions.map(({ revision }) => revision)).toEqual([1, 2, 3]);
      expect(revisions.map(({ value }) => value)).toEqual([
        writeRetainedV1(first),
        writeRetainedV1({ ...first, ...(kind === 'message' ? { text: 'B' } : { summary: 'B' }) }),
        writeRetainedV1(first),
      ]);
      const contents = sqlite
        .prepare(
          "SELECT content_json FROM control_product_entries WHERE kind='item' ORDER BY sequence"
        )
        .all();
      expect(contents[0]).toEqual(contents[2]);
      const execution = sqlite.prepare('SELECT phase FROM control_executions').get();
      expect(execution).toEqual({ phase: 'closing' });
      expect(
        sqlite.prepare('SELECT step_id,state FROM control_execution_steps ORDER BY step_id').all()
      ).toEqual([
        { step_id: 'inspect-cleanup', state: 'intent' },
        { step_id: 'terminal-publication', state: 'completed' },
      ]);
      expect(f.store.getCommandRequest('turn.start', requestId, scope)).toEqual(receipt);
      expect(
        sqlite
          .prepare('SELECT request_id,turn_id,action,outcome FROM audit_events WHERE request_id=?')
          .all(requestId)
      ).toEqual([
        { request_id: requestId, turn_id: f.turn.id, action: 'turn.start', outcome: 'succeeded' },
      ]);
      if (kind === 'display') {
        // The accepted Conversation Worker result path permits only this display refresh.
        await f.store.updateItem(
          first.id,
          { summary: 'Later display' },
          DISPLAY_PROJECTION_REFRESH_ADMISSION
        );
        expect(f.store.getTurnById(f.turn.id).items[0]).toMatchObject({ summary: 'Later display' });
        expect(f.store.listWorkspaceItemRevisions(f.workspace.id)).toHaveLength(4);
        expect(f.store.getTurnEventsForExport(f.turn.id)).toEqual(events);
      }
      const tables =
        'control_turns control_threads control_agent_sessions control_product_entries control_executions control_execution_steps control_work_observations task_turn_terminal_facts runtime_evidence idempotency_requests audit_events'.split(
          ' '
        );
      const snapshot = () => ({
        rows: tables.map((table) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()),
        history: readNativeProductEntries(f.scope, f.turn.id, 'item'),
        turn: f.store.getTurnById(f.turn.id),
        events: f.store.getTurnEventsForExport(f.turn.id),
      });
      const before = snapshot();
      await expect(f.store.completeTurn(f.turn.id, patch, input)).resolves.toEqual(before.turn);
      expect(snapshot()).toEqual(before);
      const changed = ItemSchema.parse({
        ...first,
        ...(kind === 'message' ? { text: 'Changed' } : { summary: 'Changed' }),
      });
      await expect(
        f.store.completeTurn(f.turn.id, patch, { ...input, items: [changed] })
      ).rejects.toThrow(/terminal.*conflicts.*already-decided/);
      expect(snapshot()).toEqual(before);
    } finally {
      sqlite.close();
    }
  });

  it('finishes a Server service Turn through its original native owner', async () => {
    const f = fixture();
    const thread = await f.store.createServerThread('Server terminal');
    const turn = await f.store.createServerTurn(thread.id, 'Server input', actor);
    const item = message(turn, 'Server failure');
    const result = await f.store.completeTurn(
      turn.id,
      {
        status: 'failed',
        completedAt: turn.startedAt!,
        error: { code: 'service_failed', message: 'Failed.' },
      },
      { items: [item] }
    );
    expect(result).toMatchObject({ status: 'failed', items: [item] });
    const events = f.store.getServerTurnTranscript(turn.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'turn.completed',
      data: { stopReason: 'error', turn: result },
    });
    expect(new FsStore({ dataRoot: f.root }).getServerTurnById(turn.id)).toEqual(result);
  });

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

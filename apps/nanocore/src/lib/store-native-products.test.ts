import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
import { isScopeAdmitted, refuseScope } from '../bootstrap/readiness.js';
import { initializeDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { createWorkerContextPackageAuthorityReader } from '../context/worker-context-authorities.js';
import type { WorkerContextPackageSourceFile } from '../context/worker-context-package.js';
import { WORKSPACE_WORKER_TURN_EXECUTION_DEFINITION } from '../runtime/execution-journal.js';
import type { ExecutionJournalSpan } from '../runtime/execution-step-journal.js';
import { artifactVersionRecordPath } from '../storage/artifacts/artifact-version-records.js';
import {
  ControlProductPreconditionError,
  closeWorkspaceProductReadHandles,
  getWorkspaceProductReadHandle,
  openControlStoreProductReadHandle,
} from '../storage/control-store-product-records.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  listNativeProducts,
  nativeProductScope,
  readAdmittedWorkspaceKnowledgeSelection,
  readNativeProduct,
  readNativeProductEntries,
  readNativeTurnHistory,
  readWorkspaceKnowledgeProposalInventory,
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
  it('composes retained history and Knowledge reads on the borrowed Workspace snapshot', async () => {
    const f = await workspaceFixture();
    const first = await f.store.createItem(message(f.turn, 'Before snapshot'));
    const reader = openControlStoreProductReadHandle(f.scope.path, f.scope.owner);
    const scope = { ...f.scope, sqlite: reader.sqlite };
    const workspaceDb = {
      scope: 'workspace' as const,
      workspaceId: f.workspace.id,
      sqlite: reader.sqlite,
    };
    const workspaceRoot = join(f.root, 'workspaces', f.workspace.id);
    try {
      reader.sqlite.exec('BEGIN');
      const before = readNativeTurnHistory(scope, f.turn.id)!;
      expect(before.turn.items).toEqual([first]);
      const head = readAdmittedWorkspaceKnowledgeSelection(
        workspaceRoot,
        f.workspace.id,
        workspaceDb
      );
      expect(
        readWorkspaceKnowledgeProposalInventory(workspaceRoot, f.workspace.id, workspaceDb)
      ).toEqual({ knowledgeProposals: [], knowledgeProposalReviews: [] });
      const second = await f.store.createItem(message(f.turn, 'After snapshot'));
      expect(readNativeProduct(scope, 'turn', f.turn.id)?.revision).toBe(before.revision);
      expect(
        listNativeProducts(scope, 'turn').find((row) => row.record.id === f.turn.id)?.revision
      ).toBe(before.revision);
      expect(readNativeProductEntries(scope, f.turn.id, 'item')).toHaveLength(1);
      expect(readNativeTurnHistory(scope, f.turn.id)?.turn.items).toEqual([first]);
      expect(
        readAdmittedWorkspaceKnowledgeSelection(workspaceRoot, f.workspace.id, workspaceDb).head
      ).toEqual(head.head);
      expect(reader.sqlite.inTransaction).toBe(true);
      reader.sqlite.exec('ROLLBACK');
      expect(readNativeTurnHistory(scope, f.turn.id)?.turn.items).toEqual([first, second]);
      expect(reader.sqlite.open).toBe(true);
      expect(() =>
        readWorkspaceKnowledgeProposalInventory(workspaceRoot, allocateEntityId('ws'), workspaceDb)
      ).toThrow('binding is recovery_required');
    } finally {
      if (reader.sqlite.inTransaction) reader.sqlite.exec('ROLLBACK');
      reader.close();
    }
  });

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
    // Keep this corruption fixture on the immutable-file branch.
    const item = await f.store.createItem(message(f.turn, 'Original'.repeat(10_000)));
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

  it('reuses the actual readonly product connection while reading current Workspace and Thread metadata', async () => {
    const f = fixture();
    const workspace = await f.store.createWorkspace('Metadata reuse');
    const thread = await f.store.createThread(workspace.id, 'Before external commit');
    const peer = new FsStore({ dataRoot: f.root });
    const owner = { kind: 'workspace', workspaceId: workspace.id } as const;
    const scope = nativeProductScope(f.root, owner);
    closeWorkspaceProductReadHandles(scope.path);
    const reader = getWorkspaceProductReadHandle(scope.path, owner);
    const sqlite = reader.sqlite;
    const prepare = sqlite.prepare;
    const preparedSql: string[] = [];
    // Observation only: every prepare call executes the original native method on the same receiver.
    // No result, connection, SQL statement, selector or admission decision is replaced.
    sqlite.prepare = function (this: typeof sqlite, sql: string) {
      preparedSql.push(sql);
      return Reflect.apply(prepare, this, [sql]);
    } as typeof prepare;
    try {
      expect(sqlite.readonly).toBe(true);
      expect(sqlite.pragma('query_only', { simple: true })).toBe(1);
      // readonly alone permits TEMP writes; query_only must also prevent this real native write.
      expect(() =>
        sqlite.exec('CREATE TEMP TABLE task3_query_only_probe (value INTEGER)')
      ).toThrow();
      expect(f.store.getWorkspace(workspace.id)).toMatchObject({
        id: workspace.id,
        status: 'active',
      });
      const afterWorkspace = preparedSql.length;
      expect(afterWorkspace).toBeGreaterThan(0);
      expect(sqlite.inTransaction).toBe(false);
      expect(f.store.getThread(workspace.id, thread.id).name).toBe('Before external commit');
      expect(preparedSql.length).toBeGreaterThan(afterWorkspace);
      expect(sqlite.inTransaction).toBe(false);

      // The existing owner promises prepared-statement reuse, never retained rows or snapshots.
      const warm = preparedSql.length;
      expect(f.store.getWorkspace(workspace.id).status).toBe('active');
      expect(f.store.getThread(workspace.id, thread.id).name).toBe('Before external commit');
      expect(preparedSql.length).toBe(warm);
      expect(getWorkspaceProductReadHandle(scope.path, owner)).toBe(reader);
      expect(sqlite.inTransaction).toBe(false);

      // A separate Store publishes through the real native writer's separate SQLite connection.
      // The reading Store's process-local metadata is not updated by these operations.
      await peer.updateThread(workspace.id, thread.id, { name: 'After external commit' });
      await peer.updateWorkspace(workspace.id, { status: 'archived' });
      expect(f.store.getWorkspace(workspace.id).status).toBe('archived');
      expect(f.store.getThread(workspace.id, thread.id).name).toBe('After external commit');
      expect(getWorkspaceProductReadHandle(scope.path, owner)).toBe(reader);
      expect(sqlite.inTransaction).toBe(false);
      expect(sqlite.readonly).toBe(true);
      expect(sqlite.pragma('query_only', { simple: true })).toBe(1);
    } finally {
      sqlite.prepare = prepare;
      await shutdownControlStoreWorkerClient();
    }
    expect(sqlite.open).toBe(false);
  }, 30_000);

  // Renaming an open SQLite inode is the subject of this new case's POSIX restriction.
  // The pre-run condition applies only to this case; it does not restrict any existing case.
  it.skipIf(process.platform === 'win32')(
    'refuses replaced, missing and unsupported native Workspace and Thread metadata',
    async () => {
      for (const kind of ['workspace', 'thread'] as const) {
        const f = fixture();
        const workspace = await f.store.createWorkspace('Reader identity refusal');
        const thread = await f.store.createThread(workspace.id, 'Reader identity Thread');
        const owner = { kind: 'workspace', workspaceId: workspace.id } as const;
        const scope = nativeProductScope(f.root, owner);
        // Stop the native writer before copying/replacing valid canonical database bytes.
        await shutdownControlStoreWorkerClient();
        expect(existsSync(`${scope.path}-wal`)).toBe(false);
        expect(existsSync(`${scope.path}-shm`)).toBe(false);
        const read =
          kind === 'workspace'
            ? () => f.store.getWorkspace(workspace.id)
            : () => f.store.getThread(workspace.id, thread.id);
        let reader = getWorkspaceProductReadHandle(scope.path, owner);
        try {
          expect(read().id).toBe(kind === 'workspace' ? workspace.id : thread.id);
          const before = lstatSync(scope.path);
          const replacement = `${scope.path}.replacement`;
          copyFileSync(scope.path, replacement);
          const after = lstatSync(replacement);
          expect(`${after.dev}:${after.ino}`).not.toBe(`${before.dev}:${before.ino}`);
          renameSync(replacement, scope.path);
          expect(read).toThrow(ControlProductPreconditionError);
          expect(reader.sqlite.open).toBe(false);

          // Invalidation closes the old connection; it is not a new durable quarantine or repair.
          reader = getWorkspaceProductReadHandle(scope.path, owner);
          expect(read().id).toBe(kind === 'workspace' ? workspace.id : thread.id);
          const missing = `${scope.path}.missing`;
          renameSync(scope.path, missing);
          expect(read).toThrow();
          expect(existsSync(scope.path)).toBe(false);
          expect(reader.sqlite.open).toBe(false);
          renameSync(missing, scope.path);

          reader = getWorkspaceProductReadHandle(scope.path, owner);
          expect(read().id).toBe(kind === 'workspace' ? workspace.id : thread.id);
          const corruptor = openWorkspaceDb(f.root, workspace.id);
          try {
            const table = kind === 'workspace' ? 'control_workspaces' : 'control_threads';
            const id = kind === 'workspace' ? workspace.id : thread.id;
            // Deliberate corruption after valid owner-produced setup, not successful state fabrication.
            // The stopped native writer and cached readonly connection are separate from this fault writer.
            expect(
              corruptor.sqlite
                .prepare(
                  `UPDATE ${table} SET record_json=json_set(record_json, '$.requiredFeatures', json(?)) WHERE id=?`
                )
                .run(JSON.stringify(['example.unsupported-task3-feature']), id).changes
            ).toBe(1);
            expect(read).toThrow();
            expect(reader.sqlite.inTransaction).toBe(false);
            expect(reader.sqlite.open).toBe(true);
          } finally {
            corruptor.sqlite.close();
          }
        } finally {
          closeWorkspaceProductReadHandles(scope.path);
        }
      }
    },
    30_000
  );
});

// Schema #598 proposal: use the real FsStore on its caller's actual admitted connection.
describe('FsStore borrowed native owner binding', () => {
  it('keeps the caller transaction for every product read and sees native progress after rollback', async () => {
    const f = await workspaceFixture();
    const first = await f.store.createItem(message(f.turn, 'Original owner snapshot'));
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
    const db = openWorkspaceDb(f.root, f.workspace.id);
    const scope = { ...f.scope, sqlite: db.sqlite };
    const prepare = db.sqlite.prepare;
    const observed: string[] = [];
    // Observation only. Every query executes the original method on the same actual connection.
    db.sqlite.prepare = function (this: typeof db.sqlite, sql: string) {
      observed.push(sql);
      return Reflect.apply(prepare, this, [sql]);
    } as typeof prepare;
    try {
      db.sqlite.exec('BEGIN');
      expect(db.sqlite.prepare('SELECT id FROM control_turns WHERE id=?').get(f.turn.id)).toEqual({
        id: f.turn.id,
      });
      const bound = new FsStore({ dataRoot: f.root, nativeProductScope: scope });
      expect(bound).toBeInstanceOf(FsStore);
      expect(bound.getTurnById(f.turn.id).items).toEqual([first]);
      const afterConstruction = observed.length;
      const second = await f.store.createItem(message(f.turn, 'Native progress'));
      await f.store.updateThread(f.workspace.id, f.thread.id, { name: 'New native name' });
      await f.store.updateAgentSession(session.id, { status: 'busy', message: 'Native progress' });
      await f.store.updateTurn(f.turn.id, { status: 'completed', completedAt: f.turn.startedAt! });
      await f.store.updateWorkspace(f.workspace.id, { status: 'archived' });
      // Core Storage: current SQL, not Main's caches, owns this caller's selected view.
      expect(f.store.getTurnById(f.turn.id).items).toEqual([first, second]);
      expect(bound.getWorkspace(f.workspace.id).status).toBe('active');
      expect(bound.listThreads(f.workspace.id).map(({ name }) => name)).toEqual([f.thread.name]);
      expect(bound.getThread(f.workspace.id, f.thread.id).name).toBe(f.thread.name);
      expect(bound.getTurnMetadata(f.workspace.id, f.thread.id, f.turn.id).status).toBe('running');
      expect(bound.getTurn(f.workspace.id, f.thread.id, f.turn.id).items).toEqual([first]);
      expect(bound.getTurnById(f.turn.id).items).toEqual([first]);
      expect(bound.listThreadTurns(f.workspace.id, f.thread.id)[0]!.items).toEqual([first]);
      expect(bound.listWorkspaceAgentSessions(f.workspace.id).map(({ status }) => status)).toEqual([
        'ready',
      ]);
      expect(bound.getAgentSession(session.id).status).toBe('ready');
      expect(observed.length).toBeGreaterThan(afterConstruction);
      expect(db.sqlite.inTransaction).toBe(true);
      expect(db.sqlite.open).toBe(true);
      db.sqlite.exec('ROLLBACK');
      expect(bound.getWorkspace(f.workspace.id).status).toBe('archived');
      expect(bound.listThreads(f.workspace.id)[0]!.name).toBe('New native name');
      expect(bound.getThread(f.workspace.id, f.thread.id).name).toBe('New native name');
      expect(bound.getTurnMetadata(f.workspace.id, f.thread.id, f.turn.id).status).toBe(
        'completed'
      );
      expect(bound.getTurnById(f.turn.id).items).toEqual([first, second]);
      expect(bound.getAgentSession(session.id).status).toBe('busy');
      expect(db.sqlite.open).toBe(true);
      expect(db.sqlite.inTransaction).toBe(false);
    } finally {
      db.sqlite.prepare = prepare;
      if (db.sqlite.inTransaction) db.sqlite.exec('ROLLBACK');
      db.sqlite.close();
    }
  }, 30_000);

  it('rejects a mismatched physical binding without taking the caller connection', async () => {
    const f = await workspaceFixture();
    const other = await f.store.createWorkspace('Other physical owner');
    const otherScope = nativeProductScope(f.root, { kind: 'workspace', workspaceId: other.id });
    const db = openWorkspaceDb(f.root, f.workspace.id);
    try {
      expect(
        () =>
          new FsStore({
            dataRoot: f.root,
            nativeProductScope: { ...otherScope, sqlite: db.sqlite },
          })
      ).toThrow();
      expect(db.sqlite.open).toBe(true);
      expect(
        db.sqlite.prepare('SELECT id FROM control_workspaces WHERE id=?').get(f.workspace.id)
      ).toEqual({ id: f.workspace.id });
    } finally {
      db.sqlite.close();
    }
  });

  it.each([
    'root',
    'mount',
    'knowledgeBaseId',
  ] as const)('refuses a contentMount-only %s contradiction before product metadata reads', async (field) => {
    const f = await workspaceFixture();
    const db = openWorkspaceDb(f.root, f.workspace.id);
    // The original physical owner supplies this tuple; the test defines no default binding.
    const contentMount = {
      ...f.scope.contentMount,
      ...(field === 'root'
        ? { root: join(f.scope.contentMount.root, 'contradictory-root') }
        : field === 'mount'
          ? { mount: `${f.scope.contentMount.mount}-contradictory` }
          : { knowledgeBaseId: allocateEntityId('kb') }),
    };
    const prepare = db.sqlite.prepare;
    const metadataReads: string[] = [];
    // Observe the original connection without substituting a query or its result.
    db.sqlite.prepare = function (this: typeof db.sqlite, sql: string) {
      if (/\bcontrol_(workspaces|threads|turns|agent_sessions)\b/i.test(sql))
        metadataReads.push(sql);
      return Reflect.apply(prepare, this, [sql]);
    } as typeof prepare;
    try {
      db.sqlite.exec('BEGIN');
      expect(
        () =>
          new FsStore({
            dataRoot: f.root,
            nativeProductScope: { ...f.scope, contentMount, sqlite: db.sqlite },
          })
      ).toThrow(expect.objectContaining({ code: 'recovery_required' }));
      expect(metadataReads).toEqual([]);
      expect(db.sqlite.open).toBe(true);
      expect(db.sqlite.inTransaction).toBe(true);
      const bound = new FsStore({
        dataRoot: f.root,
        nativeProductScope: { ...f.scope, sqlite: db.sqlite },
      });
      expect(bound.getWorkspace(f.workspace.id).name).toBe(f.workspace.name);
      expect(db.sqlite.inTransaction).toBe(true);
      db.sqlite.exec('ROLLBACK');
      expect(db.sqlite.open).toBe(true);
    } finally {
      db.sqlite.prepare = prepare;
      if (db.sqlite.inTransaction) db.sqlite.exec('ROLLBACK');
      db.sqlite.close();
    }
  });

  it('reads both Artifact origins and exact Item-backed revisions through the original S39 owner', async () => {
    const f = await workspaceFixture();
    const timestamp = f.turn.startedAt!;
    const original = '\uFEFFimported\r\noriginal\n';
    const contentDigest = (body: string) =>
      `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
    const imported = await f.store.createArtifact({
      id: allocateEntityId('ar'),
      workspaceId: f.workspace.id,
      threadId: null,
      turnId: null,
      kind: 'file',
      title: 'Imported',
      status: 'ready',
      summary: null,
      version: 1,
      content: { format: 'text', body: original },
      contentDigest: contentDigest(original),
      lastMutationRequestId: 'bound-import',
      origin: {
        kind: 'imported',
        sourceKind: 'direct-import',
        sourceId: 'bound-import',
        sourceDigest: contentDigest(original),
        actor,
        requestId: 'bound-import',
        recordedAt: timestamp,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const output = await f.store.createArtifact({
      id: allocateEntityId('ar'),
      workspaceId: f.workspace.id,
      threadId: f.thread.id,
      turnId: f.turn.id,
      kind: 'summary',
      title: 'Work output',
      status: 'ready',
      summary: null,
      version: 1,
      content: { format: 'text', body: 'Turn original\r\n' },
      contentDigest: contentDigest('Turn original\r\n'),
      lastMutationRequestId: 'bound-output',
      origin: {
        kind: 'turn-output',
        threadId: f.thread.id,
        turnId: f.turn.id,
        requestId: 'bound-output',
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await f.store.updateTurn(f.turn.id, { status: 'completed', completedAt: timestamp });
    const db = openWorkspaceDb(f.root, f.workspace.id);
    const coreDb = openCoreDb(f.root);
    try {
      const bound = new FsStore({
        dataRoot: f.root,
        nativeProductScope: { ...f.scope, sqlite: db.sqlite },
      });
      expect(
        bound
          .listArtifacts(f.workspace.id)
          .map(({ id }) => id)
          .sort()
      ).toEqual([imported.id, output.id].sort());
      expect(bound.getArtifactVersion(f.workspace.id, imported.id, 1).artifact).toEqual(imported);
      expect(bound.getArtifactVersion(f.workspace.id, output.id, 1).artifact).toEqual(output);
      expect(bound.getTurnById(f.turn.id).items).toContainEqual(
        expect.objectContaining({
          type: 'artifact-reference',
          artifactId: output.id,
          artifactVersion: 1,
          lastMutationRequestId: 'bound-output',
          threadId: f.thread.id,
          turnId: f.turn.id,
        })
      );
      const revised = await f.store.commitArtifactVersion({
        workspaceId: f.workspace.id,
        threadId: f.thread.id,
        artifactId: imported.id,
        expectedArtifactVersion: 1,
        actor,
        requestId: 'bound-revision',
        recordedAt: timestamp,
        title: 'Later current title',
        summary: null,
        content: { format: 'text', body: 'New original\n' },
      });
      expect(bound.getArtifact(f.workspace.id, imported.id)).toEqual(revised.artifact);
      expect(bound.getArtifactVersion(f.workspace.id, imported.id, 1).artifact).toEqual(imported);
      expect(bound.getArtifactVersion(f.workspace.id, imported.id, 2)).toEqual(revised);
      expect(
        bound
          .listArtifactVersions(f.workspace.id, imported.id)
          .map(({ artifactVersion }) => artifactVersion)
      ).toEqual([1, 2]);
      expect(bound.getTurnById(revised.version.turnId!).items).toContainEqual(
        expect.objectContaining({
          type: 'artifact-reference',
          artifactId: imported.id,
          artifactVersion: 2,
          lastMutationRequestId: 'bound-revision',
        })
      );
      const authority = createWorkerContextPackageAuthorityReader({
        coreDb,
        workspaceDb: db,
        store: bound,
      });
      // Transient public selector input, not a retained trace or a hand-authored authority record.
      const source: WorkerContextPackageSourceFile = {
        source: {
          kind: 'artifact',
          artifactVersion: 1,
          reference: {
            scopeId: `artifact/workspace/${f.workspace.id}`,
            objectId: imported.id,
          },
        },
        originalDigest: imported.contentDigest,
        byteLength: Buffer.byteLength(original),
        mediaType: 'text/plain',
        originalSnapshotPath: 'originals/source/payload',
        packagePath: 'sources/source.txt',
        projection: {
          kind: 'descriptor',
          sourceRevision: '1',
          representationId: 'fixture',
          representationDigest: imported.contentDigest,
          representationByteLength: 0,
          deliveredDigest: imported.contentDigest,
          ranges: [],
          byteLength: 0,
          truncated: true,
          availability: 'unavailable',
          originalSnapshotPath: 'originals/source/payload',
        },
      };
      expect(authority.readSourceFile!(source)).toEqual({
        originalDigest: imported.contentDigest,
        byteLength: Buffer.byteLength(original),
        mediaType: 'text/plain',
      });
      // Exact retained bytes must be read again, even after a successful bound read.
      const path = artifactVersionRecordPath(
        join(f.root, 'workspaces', f.workspace.id),
        imported.id,
        1
      );
      const payload = join(path, '..', 'payload');
      const before = readFileSync(payload);
      chmodSync(payload, 0o600);
      writeFileSync(payload, 'corrupt original');
      expect(() => bound.getArtifactVersion(f.workspace.id, imported.id, 1)).toThrow(
        expect.objectContaining({ code: 'recovery_required' })
      );
      expect(authority.readSourceFile!(source)).toBeNull();
      expect(readFileSync(payload)).not.toEqual(before);
      expect(readFileSync(payload, 'utf8')).toBe('corrupt original');
      expect(db.sqlite.open).toBe(true);
    } finally {
      coreDb.sqlite.close();
      db.sqlite.close();
    }
  }, 30_000);

  it('refuses a real future Artifact directory without its selected head and Item witness', async () => {
    const f = await workspaceFixture();
    const timestamp = f.turn.startedAt!;
    const body = 'Original output\n';
    const artifact = await f.store.createArtifact({
      id: allocateEntityId('ar'),
      workspaceId: f.workspace.id,
      threadId: f.thread.id,
      turnId: f.turn.id,
      kind: 'summary',
      title: 'Original',
      status: 'ready',
      summary: null,
      version: 1,
      content: { format: 'text', body },
      contentDigest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
      lastMutationRequestId: 'bound-gap-original',
      origin: {
        kind: 'turn-output',
        threadId: f.thread.id,
        turnId: f.turn.id,
        requestId: 'bound-gap-original',
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await f.store.updateTurn(f.turn.id, { status: 'completed', completedAt: timestamp });
    const workspaceRoot = join(f.root, 'workspaces', f.workspace.id);
    const headPath = join(workspaceRoot, 'artifacts', artifact.id, 'artifact.json');
    const acknowledgedHead = readFileSync(headPath);
    const revised = await f.store.commitArtifactVersion({
      workspaceId: f.workspace.id,
      threadId: f.thread.id,
      artifactId: artifact.id,
      expectedArtifactVersion: 1,
      actor,
      requestId: 'bound-gap-next',
      recordedAt: timestamp,
      title: 'Later',
      summary: null,
      content: { format: 'text', body: 'Later original\n' },
    });
    await shutdownControlStoreWorkerClient();
    const db = openWorkspaceDb(f.root, f.workspace.id);
    const path = artifactVersionRecordPath(workspaceRoot, artifact.id, 2);
    const descriptor = readFileSync(path);
    const payload = readFileSync(join(path, '..', 'payload'));
    try {
      const bound = new FsStore({
        dataRoot: f.root,
        nativeProductScope: { ...f.scope, sqlite: db.sqlite },
      });
      expect(bound.getArtifactVersion(f.workspace.id, artifact.id, 2)).toEqual(revised);
      // Fault after owner-produced state: restore the exact previous head and remove later SQL proof.
      // This models the file-only cut; it does not claim to have produced a real lost acknowledgement.
      writeFileSync(headPath, acknowledgedHead);
      db.sqlite
        .prepare('DELETE FROM control_product_entries WHERE turn_id=?')
        .run(revised.version.turnId!);
      // Terminal publication also retains Turn-owned observations with enforced foreign keys.
      db.sqlite
        .prepare('DELETE FROM control_work_observations WHERE turn_id=?')
        .run(revised.version.turnId!);
      db.sqlite.prepare('DELETE FROM control_turns WHERE id=?').run(revised.version.turnId!);
      expect(() => bound.getArtifactVersion(f.workspace.id, artifact.id, 1)).toThrow(
        expect.objectContaining({ code: 'recovery_required' })
      );
      expect(() => bound.getArtifactVersion(f.workspace.id, artifact.id, 2)).toThrow();
      expect(readFileSync(headPath)).toEqual(acknowledgedHead);
      expect(readFileSync(path)).toEqual(descriptor);
      expect(readFileSync(join(path, '..', 'payload'))).toEqual(payload);
      expect(db.sqlite.open).toBe(true);
    } finally {
      db.sqlite.close();
    }
  }, 30_000);

  it('keeps foreign opaque fallback and duplicate refusal without hydrating unrelated bodies', async () => {
    const f = await workspaceFixture();
    const foreign = await f.store.createWorkspace('Foreign owner');
    const thread = await f.store.createThread(foreign.id, 'Foreign Thread');
    const turn = await f.store.createTurn(foreign.id, thread.id, 'Foreign input', actor);
    const session = await f.store.createAgentSession({
      id: allocateEntityId('as'),
      workspaceId: foreign.id,
      threadId: thread.id,
      agentId: 'agent_codex_host',
      status: 'ready',
      message: null,
      createdAt: turn.startedAt!,
      updatedAt: turn.startedAt!,
    });
    const brokenThread = await f.store.createThread(foreign.id, 'Unrelated corrupt body');
    const brokenTurn = await f.store.createTurn(
      foreign.id,
      brokenThread.id,
      'Unrelated input',
      actor
    );
    await f.store.createItem(message(brokenTurn, 'Unrelated immutable body'.repeat(10_000)));
    const foreignScope = nativeProductScope(f.root, { kind: 'workspace', workspaceId: foreign.id });
    const reader = openControlStoreProductReadHandle(foreignScope.path, foreignScope.owner);
    let bodyPath: string;
    try {
      bodyPath = join(
        foreignScope.contentMount.root,
        reader.entries(brokenTurn.id, 'item')[0]!.content.reference.locator.path
      );
    } finally {
      reader.close();
    }
    chmodSync(bodyPath, 0o600);
    writeFileSync(bodyPath, 'unrelated corrupt bytes');
    const db = openWorkspaceDb(f.root, f.workspace.id);
    try {
      expect(isScopeAdmitted(f.root, 'workspace', foreign.id)).toBe(true);
      const bound = new FsStore({
        dataRoot: f.root,
        nativeProductScope: { ...f.scope, sqlite: db.sqlite },
      });
      // A global constructor reload would read this unrelated body and quarantine its whole owner.
      expect(isScopeAdmitted(f.root, 'workspace', foreign.id)).toBe(true);
      expect(bound.getTurnById(f.turn.id).id).toBe(f.turn.id);
      expect(bound.getTurnLineage(turn.id)).toEqual({
        workspaceId: foreign.id,
        threadId: thread.id,
      });
      expect(bound.getTurnById(turn.id).id).toBe(turn.id);
      expect(bound.getAgentSession(session.id)).toEqual(session);
      // Exact-selector miss retains the original foreign opaque fallback classification.
      expect(bound.getTurnMetadata(f.workspace.id, f.thread.id, turn.id).id).toBe(turn.id);
      expect(() => bound.getTurnById(brokenTurn.id)).toThrow(/immutable (size|digest)/);
      await shutdownControlStoreWorkerClient();
      const corruptor = openWorkspaceDb(f.root, foreign.id);
      try {
        // Unsupported retained selectors remain a refusal, not an opaque miss.
        // Admit only this exact unsupported-header fault; restore CHECK enforcement before reads.
        corruptor.sqlite.pragma('ignore_check_constraints = ON');
        try {
          corruptor.sqlite
            .prepare('UPDATE control_turns SET schema_version=999 WHERE id=?')
            .run(turn.id);
        } finally {
          corruptor.sqlite.pragma('ignore_check_constraints = OFF');
        }
        expect(() => bound.getTurnById(turn.id)).toThrow(/Unsupported native product selector/);
        expect(bound.getTurnById(f.turn.id).id).toBe(f.turn.id);
        corruptor.sqlite
          .prepare('UPDATE control_turns SET schema_version=1 WHERE id=?')
          .run(turn.id);
        // Remove only this selector's dependent history before changing its primary key.
        corruptor.sqlite
          .prepare('DELETE FROM control_product_entries WHERE turn_id=?')
          .run(turn.id);
        corruptor.sqlite
          .prepare('DELETE FROM control_work_observations WHERE turn_id=?')
          .run(turn.id);
        // Corrupt an existing native selector after real setup; never fabricate a successful SQL row.
        expect(
          corruptor.sqlite
            .prepare('UPDATE control_turns SET id=? WHERE id=?')
            .run(f.turn.id, turn.id).changes
        ).toBe(1);
        expect(() => bound.getTurnById(f.turn.id)).toThrow(/Conflicting native product owner/);
        expect(db.sqlite.open).toBe(true);
      } finally {
        corruptor.sqlite.close();
      }
      expect(readFileSync(bodyPath, 'utf8')).toBe('unrelated corrupt bytes');
    } finally {
      db.sqlite.close();
    }
  }, 30_000);

  it('keeps known healthy opaque reads beside quarantine and refuses an unprovable opaque miss', async () => {
    const f = await workspaceFixture();
    const foreign = await f.store.createWorkspace('Quarantined peer');
    const db = openWorkspaceDb(f.root, f.workspace.id);
    try {
      const bound = new FsStore({
        dataRoot: f.root,
        nativeProductScope: { ...f.scope, sqlite: db.sqlite },
      });
      refuseScope(f.root, { scope: 'workspace', id: foreign.id, check: 'recovery' });
      expect(bound.getTurnById(f.turn.id).id).toBe(f.turn.id);
      expect(() => bound.getWorkspace(foreign.id)).toThrow(
        expect.objectContaining({ code: 'recovery_required' })
      );
      expect(() => bound.getTurnById(allocateEntityId('tu'))).toThrow(
        expect.objectContaining({ code: 'recovery_required' })
      );
      expect(isScopeAdmitted(f.root, 'workspace', foreign.id)).toBe(false);
      expect(db.sqlite.open).toBe(true);
    } finally {
      db.sqlite.close();
    }
  });
});

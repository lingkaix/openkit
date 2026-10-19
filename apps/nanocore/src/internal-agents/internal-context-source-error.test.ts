import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId, writeRetainedV1 } from '@openkit/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import {
  readMemoryPage,
  recordMemorySuppression,
  saveMemoryPage,
} from '../knowledge/memory-lifecycle.js';
import { initializeScopedNotebook } from '../knowledge/scoped-notebook-owner.js';
import { FsStore } from '../lib/store.js';
import { closeRetrievalServices } from '../retrieval-service.js';
import { openCoreDb, openUserDb } from '../storage/db.js';
import {
  assertKnowledgeRetrievalTraceReadable,
  resolveWorkspaceKnowledgeRetrievalPages,
  retrieveUserMemory,
} from '../storage/index-rebuild.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { readRetrievalTrace } from '../storage/retrieval-traces.js';
import { serializeKnowledgePageFixture } from '../test-support/knowledge-page.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { openAssistantTimeline } from './assistant-timeline.js';
import { runInternalAgentLoop } from './internal-agent-loop.js';
import { readInternalContextEvidence } from './internal-context-evidence.js';
import { internalContextFailure, prepareInternalAgentContext } from './rolling-context.js';

const timestamp = '2026-10-19T00:00:00.000Z';
const privateText = 'PRIVATE_MEMORY_SOURCE_BODY';
const model = { logicalModelId: 'context-source-test', capabilities: [], modelFamilyId: null };
const systemPrompt = 'Answer the current request under current source authority.';
const limits = { maxModelTurns: 3, maxToolCalls: 1, deadlineMs: 10_000 };

/** Composes actual User, Notebook, Memory selection, retained trace and canonical history owners. */
async function fixture(selected = false) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'internal-context-source-error-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const userDb = openUserDb(dataRoot, userId);
  applyScopedMigrations(userDb);
  onTestFinished(async () => {
    await closeRetrievalServices();
    userDb.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const actor = { kind: 'local' as const, userId };
  const actorRef = { kind: 'user' as const, id: userId };
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Context source verification');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const writer = {
    coreDb,
    userDb,
    actor,
    store,
    runtimeConfigManager: createRuntimeConfigManager({ dataRoot }),
    inflightCommands: new WeakMap(),
  };
  const notebookRevision = initializeScopedNotebook({
    ...writer,
    target: { kind: 'user' },
    initialization: { requestId: randomUUID(), instructionReference: 'test:context-source' },
  });
  if (selected)
    await saveMemoryPage(writer, {
      requestId: randomUUID(),
      baseRevision: notebookRevision,
      pageId: 'preferences',
      content: serializeKnowledgePageFixture(
        {
          title: 'Personal preference',
          content: `contextSourcePreference ${privateText}`,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        { kind: 'user', userId }
      ),
      summary: 'Explicit personal preference',
    });
  const thread = openAssistantTimeline(store, workspace.id, userId, 'Private Assistant');
  const sourceTurn = store.createTurn(workspace.id, thread.id, 'Recall preferences.', actorRef);
  store.createItem({
    id: allocateEntityId('it'),
    workspaceId: workspace.id,
    threadId: thread.id,
    turnId: sourceTurn.id,
    type: 'user-message',
    actor: actorRef,
    text: 'Recall preferences.',
    status: 'completed',
    createdAt: timestamp,
    completedAt: timestamp,
  });
  const access = {
    coreDb,
    userDb,
    store,
    requestActor: actor,
    actor: actorRef,
    outputThreadId: thread.id,
    outputTurnId: sourceTurn.id,
  };
  const selection = await retrieveUserMemory({
    dataRoot,
    workspaceId: workspace.id,
    access,
    caller: 'assistant',
    query: 'contextSourcePreference',
    limit: 10,
    ...(selected ? {} : { types: ['*'], appliesTo: ['*'] }),
  });
  const reference = selection.retrievalTraceRef!;
  const workspaceRoot = join(dataRoot, 'workspaces', workspace.id);
  const trace = readRetrievalTrace(workspaceRoot, reference)!;
  const tracePath = join(
    workspaceRoot,
    'threads',
    thread.id,
    'turns',
    sourceTurn.id,
    'retrieval-traces',
    `${reference.objectId}.json`
  );
  store.updateTurn(sourceTurn.id, { status: 'completed', completedAt: timestamp });
  const turn = store.createTurn(workspace.id, thread.id, 'Continue.', actorRef, null, {
    agentId: 'quick-chat',
    executorKind: 'assistant',
  });
  const callProvider = vi.fn(async () => ({
    message: {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'The current request can continue.' }],
      truncated: false,
    },
  }));
  const request = {
    store,
    turn,
    systemPrompt,
    tools: [],
    model,
    bounds: { context: 100_000, output: 512 },
    requiredMessages: [
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'Continue.' }] },
    ],
    limits,
    signal: new AbortController().signal,
    assertCurrent: () => {},
    readEvidence: (items: Parameters<typeof readInternalContextEvidence>[0]['items']) =>
      readInternalContextEvidence({
        store,
        coreDb,
        actor,
        workspaceId: workspace.id,
        threadId: thread.id,
        items,
      }),
    callProvider,
  };
  return {
    dataRoot,
    store,
    coreDb,
    writer,
    workspace,
    thread,
    access,
    reference,
    trace,
    tracePath,
    request,
  };
}

/** Reaches the ordinary loop only after real rolling assembly and the publication guard succeed. */
async function continueRun(f: Awaited<ReturnType<typeof fixture>>) {
  const prepared = await prepareInternalAgentContext(f.request);
  prepared.assertCurrent();
  return runInternalAgentLoop({ ...f.request, ...prepared }, f.request.callProvider);
}

/** Checks the typed cause and public Turn projection without retaining private diagnostic inputs. */
async function expectSourceUnavailable(f: Awaited<ReturnType<typeof fixture>>, check: string) {
  const error = await continueRun(f).then(
    () => {
      throw new Error('Source verification must stop before Provider dispatch.');
    },
    (failure: unknown) => failure
  );
  expect(f.request.callProvider).not.toHaveBeenCalled();
  expect(error).toMatchObject({ code: 'internal_agent_context_source_unavailable' });
  expect((error as Error).message).toContain(check);
  const projection = internalContextFailure(error);
  expect(projection).toMatchObject({ code: 'internal_agent_context_source_unavailable' });
  expect(projection?.message).toMatch(/source|evidence/i);
  for (const text of [(error as Error).message, JSON.stringify(projection)]) {
    expect(text).not.toContain(f.dataRoot);
    expect(text).not.toContain(privateText);
    expect(text).not.toContain('sk-test-secret-authority');
    expect(text).not.toContain(f.reference.objectId);
    expect(text).not.toContain('context capacity was exceeded');
  }
}

describe('Internal rolling context source failure classification', () => {
  it('continues from a real valid empty User trace with a present Notebook revision', async () => {
    const f = await fixture();
    expect(f.trace.notebookRevision).not.toBeNull();
    expect(f.trace.selected).toEqual([]);
    expect(f.trace.excluded).toEqual([]);
    expect(f.trace.retrievalParameters.pinnedReferences).toEqual([]);
    const native = {
      dataRoot: f.dataRoot,
      workspaceId: f.workspace.id,
      access: f.access,
      retrievalTraceRef: f.reference,
    };
    expect(assertKnowledgeRetrievalTraceReadable(native)).toEqual(f.trace);
    expect(resolveWorkspaceKnowledgeRetrievalPages({ ...native, caller: 'assistant' })).toEqual([]);
    const before = readFileSync(f.tracePath, 'utf8');
    expect((await continueRun(f)).kind).toBe('quiescent');
    expect(f.request.callProvider).toHaveBeenCalledTimes(1);
    expect(readFileSync(f.tracePath, 'utf8')).toBe(before);
    expect(
      f.store
        .listThreadItems(f.workspace.id, f.thread.id)
        .some((item) => item.type === 'context-summary')
    ).toBe(false);
  });

  it.each([
    'User identity',
    'Knowledge Base identity',
    'private audience',
    'trace integrity',
  ] as const)('keeps the %s check strict and reports its native verifier before dispatch', async (fault) => {
    const f = await fixture();
    if (fault === 'private audience')
      Object.assign(f.store.getThread(f.workspace.id, f.thread.id), {
        privateOwnerUserId: allocateEntityId('usr'),
      });
    else if (fault === 'trace integrity')
      writeFileSync(
        f.tracePath,
        JSON.stringify(writeRetainedV1({ ...f.trace, traceId: allocateEntityId('krt') }))
      );
    else {
      const trace = structuredClone(f.trace);
      if (fault === 'User identity')
        trace.queryContext.actor = { kind: 'user', id: allocateEntityId('usr') };
      else
        trace.sourceScope = trace.sourceScope.replace(/.$/, (last) => (last === '0' ? '1' : '0'));
      // Keep the native envelope valid so identity faults reach their owning admission check.
      writeFileSync(f.tracePath, JSON.stringify(writeRetainedV1(trace)));
    }
    await expectSourceUnavailable(
      f,
      fault === 'trace integrity'
        ? 'readTurnRetrievalTraces'
        : 'assertKnowledgeRetrievalTraceReadable'
    );
  });

  it('rejects a previously selected Memory after current owner suppression without disclosing its body', async () => {
    const f = await fixture(true);
    expect(f.trace.selected).toHaveLength(1);
    const page = readMemoryPage(f.writer, 'preferences')!;
    recordMemorySuppression(f.writer, {
      requestId: randomUUID(),
      pageId: page.id,
      notebookRevision: page.notebookRevision,
      digest: page.digest,
    });
    await expectSourceUnavailable(f, 'assertKnowledgeRetrievalTraceReadable');
  });

  it('redacts an early current-authority failure and keeps it distinct from capacity', async () => {
    const f = await fixture();
    f.request.assertCurrent = () => {
      throw new Error(`${privateText} ${f.dataRoot} sk-test-secret-authority`);
    };
    await expectSourceUnavailable(f, 'assertCurrent');
  });

  it('preserves the actual upstream context-overflow Turn error', () => {
    expect(internalContextFailure({ failure: { kind: 'context_overflow' } })).toEqual({
      code: 'internal_agent_context_exceeded',
      message:
        'The selected model context capacity was exceeded. Reduce input or retrieve a smaller excerpt.',
    });
  });
});

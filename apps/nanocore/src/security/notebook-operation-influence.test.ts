import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { expect, it, onTestFinished } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { KnowledgeNotebook } from '../knowledge/notebook.js';
import { FsStore } from '../lib/store.js';
import { createOperationInvocation } from '../operation-composition.js';
import type { WorkspaceDb } from '../storage/db.js';
import { userMemoryRoot } from '../storage/fs-layout.js';
import { createApp } from '../test-support/app.js';
import { serializeKnowledgePageFixture } from '../test-support/knowledge-page.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { remoteMcpInvocation } from '../test-support/remote-mcp-invocation.js';
import {
  createTestServerThread,
  createTestServerWorkStore,
} from '../test-support/server-work-store.js';
import {
  createTestCoreDb,
  createTestWorkspaceDb,
  disposeTestStore,
} from '../test-support/store.js';
import { readTestWorkspaceNotebookSelection } from '../test-support/workspace-notebook.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { receiveContextInfluence } from './context-influence.js';
import {
  notebookWritingContextInfluence,
  receiveNotebookOperationDisclosure,
} from './notebook-influence.js';

/** Real native records and the same operation invoker used by HTTP, MCP and internal model delivery. */
async function fixture(externallyInfluenced?: boolean) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'notebook-operation-influence-'));
  const coreDb = createTestCoreDb(dataRoot);
  const userId = ensureLocalUser(coreDb);
  const store = await createTestServerWorkStore(coreDb);
  const readers: WorkspaceDb[] = [];
  onTestFinished(() => disposeTestStore(dataRoot, coreDb, ...readers));
  const workspace = await store.createWorkspace('Writing context');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const thread = await store.createThread(workspace.id, 'Source');
  const source = await store.createTurn(
    workspace.id,
    thread.id,
    'Publish',
    { kind: 'user', id: userId },
    null,
    externallyInfluenced === undefined ? {} : { externallyInfluenced }
  );
  const runtimeConfigManager = createRuntimeConfigManager({ dataRoot, captureCoverage: store });
  const app = createApp({ coreDb, dataRoot, store, runtimeConfigManager });
  const invoke = createOperationInvocation({
    coreDb,
    store,
    runtimeConfigManager,
    inflightCommands: new WeakMap(),
    repositoryWorkspaceDb: (id) => {
      const db = createTestWorkspaceDb(dataRoot, id);
      readers.push(db);
      return db;
    },
  });
  const context = {
    kind: 'public' as const,
    actor: { kind: 'local' as const, userId },
    delivery: 'model' as const,
    queryContext: { threadId: thread.id, turnId: source.id },
  };
  return { dataRoot, coreDb, userId, store, workspace, thread, source, invoke, context, app };
}

it.each([true, false, undefined])(
  'binds model-invoked Knowledge and first Memory writes to the native writing context (%s) (#740)',
  async (externallyInfluenced) => {
    const { dataRoot, userId, workspace, invoke, context } = await fixture(externallyInfluenced);
    const selection = readTestWorkspaceNotebookSelection(dataRoot, workspace.id);
    const published = await invoke(
      'knowledge.notebook.update',
      {
        workspaceId: workspace.id,
        requestId: randomUUID(),
        baseRevision: selection.head.notebookCommit,
        changes: [
          {
            path: 'index.md',
            content: '---\nokf_version: "0.2"\n---\n# Context-bound Knowledge\n',
          },
        ],
        summary: 'Publish Knowledge',
      },
      context
    );
    expect(
      selection.notebook.readRevision(published.notebookRevision).metadata.externallyInfluenced
    ).toBe(externallyInfluenced !== false);
    const saved = await invoke(
      'memory.create',
      {
        requestId: randomUUID(),
        baseRevision: null,
        pageId: 'preference',
        summary: 'First Memory save',
        content: serializeKnowledgePageFixture(
          {
            title: 'Preference',
            content: 'Keep the writing provenance.',
            sourceReferences: [],
            createdAt: '2026-11-16T00:00:00.000Z',
            updatedAt: '2026-11-16T00:00:00.000Z',
          },
          { kind: 'user', userId }
        ),
      },
      context
    );
    const memory = new KnowledgeNotebook({
      repositoryPath: join(userMemoryRoot(dataRoot, userId), 'notebook.git'),
    });
    expect(memory.readRevision(saved.notebookRevision).metadata.externallyInfluenced).toBe(
      externallyInfluenced !== false
    );
  }
);

it('uses native writing lineage for Workspace and Memory Source registration, independently of payload origin (#740)', async () => {
  const f = await fixture(true);
  const clearThread = await f.store.createThread(
    f.workspace.id,
    'Unrelated clear context',
    undefined,
    'knowledge-manager'
  );
  const clear = await f.store.createTurn(
    f.workspace.id,
    clearThread.id,
    'Clear',
    { kind: 'user', id: f.userId },
    null,
    { externallyInfluenced: false }
  );
  await f.invoke(
    'knowledge.source.register',
    {
      workspaceId: f.workspace.id,
      requestId: randomUUID(),
      kind: 'document',
      title: 'External fact',
      content: 'Influenced text',
      originatingThreadId: clearThread.id,
      originatingTurnId: clear.id,
    },
    f.context
  );
  const selected = readTestWorkspaceNotebookSelection(f.dataRoot, f.workspace.id);
  expect(
    selected.notebook.readRevision(selected.head.notebookCommit).metadata.externallyInfluenced
  ).toBe(true);
  await f.invoke(
    'memory.source.register',
    {
      requestId: randomUUID(),
      kind: 'document',
      title: 'External Memory fact',
      content: 'Influenced text without a payload origin',
    },
    f.context
  );
  const memory = new KnowledgeNotebook({
    repositoryPath: join(userMemoryRoot(f.dataRoot, f.userId), 'notebook.git'),
  });
  expect(memory.readRevision(memory.publishedRevision()).metadata.externallyInfluenced).toBe(true);
});

const readOperations = [
  'knowledge.notebook.list',
  'knowledge.retrieval',
  'knowledge.context.prepare',
  'knowledge.notebook.history',
  'knowledge.notebook.diff',
  'memory.read',
  'memory.search',
  'memory.notebook.history',
  'memory.notebook.diff',
] as const;
it.each(readOperations)(
  'propagates %s into the actual second model Session before returning (#740)',
  async (operation) => {
    const f = await fixture(true);
    const page = (
      scope: { kind: 'workspace'; workspaceId: string } | { kind: 'user'; userId: string }
    ) =>
      serializeKnowledgePageFixture(
        {
          title: 'Inherited fact',
          content: 'auroraprovenance fact',
          sourceReferences: [],
          createdAt: '2026-11-16T00:00:00.000Z',
          updatedAt: '2026-11-16T00:00:00.000Z',
        },
        scope
      );
    const base = readTestWorkspaceNotebookSelection(f.dataRoot, f.workspace.id).head.notebookCommit;
    const knowledge = await f.invoke(
      'knowledge.notebook.update',
      {
        workspaceId: f.workspace.id,
        requestId: randomUUID(),
        baseRevision: base,
        changes: [
          { path: 'fact.md', content: page({ kind: 'workspace', workspaceId: f.workspace.id }) },
        ],
        summary: 'Retain influenced Knowledge',
      },
      f.context
    );
    const memory = await f.invoke(
      'memory.create',
      {
        requestId: randomUUID(),
        baseRevision: null,
        pageId: 'fact',
        content: page({ kind: 'user', userId: f.userId }),
        summary: 'Retain influenced Memory',
      },
      f.context
    );
    const timeline = await f.store.createThread(
      f.workspace.id,
      'Receiver',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: f.userId }
    );
    const session = await f.store.createAgentSession({
      id: allocateEntityId('as'),
      workspaceId: f.workspace.id,
      threadId: timeline.id,
      agentId: 'notebook-reader',
      status: 'created',
      message: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      externallyInfluenced: false,
    });
    const receiver = await f.store.createTurn(
      f.workspace.id,
      timeline.id,
      'Read governed content',
      { kind: 'user', id: f.userId },
      null,
      { agentId: session.agentId, agentSessionId: session.id, externallyInfluenced: false }
    );
    const context = { ...f.context, queryContext: { threadId: timeline.id, turnId: receiver.id } };
    expect(f.store.getTurnById(receiver.id).externallyInfluenced).toBe(false);
    if (operation === 'knowledge.notebook.list')
      await f.invoke(operation, { workspaceId: f.workspace.id }, context);
    if (operation === 'knowledge.retrieval' || operation === 'knowledge.context.prepare') {
      const result = await f.invoke(
        operation,
        { workspaceId: f.workspace.id, query: 'auroraprovenance' },
        context
      );
      expect(result.selected.length).toBeGreaterThan(0);
    }
    if (operation === 'knowledge.notebook.history')
      await f.invoke(
        operation,
        { workspaceId: f.workspace.id, revision: knowledge.notebookRevision },
        context
      );
    if (operation === 'knowledge.notebook.diff')
      await f.invoke(
        operation,
        {
          workspaceId: f.workspace.id,
          baseRevision: knowledge.notebookRevision,
          fromRevision: base,
        },
        context
      );
    if (operation === 'memory.read')
      expect((await f.invoke(operation, { pageId: 'fact' }, context)).page?.content).toContain(
        'auroraprovenance'
      );
    if (operation === 'memory.search')
      expect(
        (
          await f.invoke(
            operation,
            { workspaceId: f.workspace.id, query: 'auroraprovenance' },
            context
          )
        ).selected.length
      ).toBeGreaterThan(0);
    if (operation === 'memory.notebook.history')
      await f.invoke(operation, { revision: memory.notebookRevision }, context);
    if (operation === 'memory.notebook.diff')
      await f.invoke(
        operation,
        { baseRevision: memory.notebookRevision, fromRevision: memory.notebookRevision },
        context
      );
    const reloaded = new FsStore({ dataRoot: f.dataRoot });
    expect(reloaded.getTurnById(receiver.id).externallyInfluenced).toBe(true);
    expect(reloaded.getAgentSession(session.id).externallyInfluenced).toBe(true);
  }
);

it('keeps remote MCP Memory reads and writes available without local Turn lineage and marks those writes influenced (#740)', async () => {
  const f = await fixture(false);
  const token = createOpenKitAccessTokenRecord(f.coreDb, {
    ownerUserId: f.userId,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const call = async (operation: string, input: unknown) => {
    const response = await f.app.request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token.secret}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: remoteMcpInvocation(operation, input),
      }),
    });
    expect(response.status).toBe(200);
    const result = (await response.json()).result;
    expect(result.isError, `${operation}: ${JSON.stringify(result.content)}`).not.toBe(true);
    return JSON.parse(result.content[0].text);
  };
  const saved = await call('memory.create', {
    requestId: randomUUID(),
    baseRevision: null,
    pageId: 'remote',
    summary: 'Remote model write',
    content: serializeKnowledgePageFixture(
      {
        title: 'Remote fact',
        content: 'Retain external provenance.',
        createdAt: '2026-11-16T00:00:00.000Z',
        updatedAt: '2026-11-16T00:00:00.000Z',
      },
      { kind: 'user', userId: f.userId }
    ),
  });
  await call('memory.source.list', {});
  expect((await call('memory.read', { pageId: 'remote' })).page.content).toContain(
    'external provenance'
  );
  await call('memory.list', {});
  const memory = new KnowledgeNotebook({
    repositoryPath: join(userMemoryRoot(f.dataRoot, f.userId), 'notebook.git'),
  });
  expect(memory.readRevision(saved.notebookRevision).metadata.externallyInfluenced).toBe(true);
  const base = readTestWorkspaceNotebookSelection(f.dataRoot, f.workspace.id);
  const changed = await call('knowledge.notebook.update', {
    workspaceId: f.workspace.id,
    requestId: randomUUID(),
    baseRevision: base.head.notebookCommit,
    changes: [{ path: 'index.md', content: '---\nokf_version: "0.2"\n---\n# Remote navigation\n' }],
    summary: 'Remote model Notebook write',
  });
  expect(base.notebook.readRevision(changed.notebookRevision).metadata.externallyInfluenced).toBe(
    true
  );
});

it('treats a retained Notebook revision with no reserved influence bit as influenced at model disclosure (#740)', async () => {
  const f = await fixture(false);
  // The reserved Notebook codec can author the exact historical absence; current application publishers always write a boolean.
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(f.dataRoot, 'legacy-notebook.git'),
  });
  const revision = notebook.initialize({
    files: { 'index.md': '---\nokf_version: "0.2"\n---\n# Historical content\n' },
    metadata: {
      summary: 'Historical revision',
      changeRequest: { requestId: randomUUID(), inputDigest: `sha256:${'a'.repeat(64)}` },
      producer: { kind: 'user', id: f.userId },
      authority: { kind: 'direct', instructionReference: 'legacy-fixture' },
      sourceReferences: [],
    },
  });
  expect(notebook.readRevision(revision).metadata.externallyInfluenced).toBeUndefined();
  expect(f.store.getTurnById(f.source.id).externallyInfluenced).toBe(false);
  await receiveNotebookOperationDisclosure({ ...f.context, delivery: 'human' }, f.store, notebook, {
    notebookRevision: revision,
  });
  expect(f.store.getTurnById(f.source.id).externallyInfluenced).toBe(false);
  await receiveNotebookOperationDisclosure(f.context, f.store, notebook, {
    notebookRevision: revision,
  });
  expect(new FsStore({ dataRoot: f.dataRoot }).getTurnById(f.source.id).externallyInfluenced).toBe(
    true
  );
});

it.each([false, true])(
  'resolves the native Server writing context (%s) and marks Server disclosure (#740)',
  async (externallyInfluenced) => {
    const f = await fixture(false);
    const thread = await createTestServerThread(f.store, f.coreDb, 'Server context');
    const turn = await f.store.createServerTurn(
      thread.id,
      'Write',
      { kind: 'user', id: f.userId },
      null,
      { externallyInfluenced }
    );
    expect(
      notebookWritingContextInfluence({
        store: f.store,
        producer: { kind: 'agent', id: 'knowledge-manager' },
        sourceTurnId: turn.id,
      })
    ).toBe(externallyInfluenced);
    await receiveContextInfluence(
      { store: f.store, outputThreadId: thread.id, outputTurnId: turn.id },
      { externallyInfluenced: true }
    );
    expect(f.store.getServerTurnById(turn.id).externallyInfluenced).toBe(true);
  }
);

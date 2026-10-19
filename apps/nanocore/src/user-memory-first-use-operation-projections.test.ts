// openkit-test-platform: posix

import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { workspaceIdForOwner } from '@openkit/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { readDefaultKnowledgeBaseId } from './config/knowledge-base.js';
import { createRuntimeConfigManager } from './config/runtime-config.js';
import { openAssistantTimeline } from './internal-agents/assistant-timeline.js';
import type { KnowledgeManagerAgentRun } from './internal-agents/knowledge-manager-agent.js';
import { askKnowledgeAgent } from './knowledge/knowledge-agent.js';
import { KnowledgeNotebook } from './knowledge/notebook.js';
import { initializeScopedNotebook } from './knowledge/scoped-notebook-owner.js';
import { FsStore } from './lib/store.js';
import { createOperationInvocation } from './operation-composition.js';
import { closeRetrievalServices } from './retrieval-service.js';
import { openCoreDb, openUserDb, openWorkspaceDb } from './storage/db.js';
import { userDbPath, userMemoryRoot } from './storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { testEntityId } from './test-support/entity-ids.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('./internal-agents/knowledge-manager-agent.js', async (original) => ({
  ...(await original<typeof import('./internal-agents/knowledge-manager-agent.js')>()),
  runKnowledgeManagerAgent: run,
}));

/** Real identities, Workspace admission and storage; only bounded model execution is injected. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'memory-fresh-query-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userIds = [
    testEntityId('usr', 'fresh-memory-alice'),
    testEntityId('usr', 'fresh-memory-bob'),
  ];
  const now = '2026-10-19T00:00:00.000Z';
  for (const userId of userIds)
    coreDb.sqlite
      .prepare(
        "INSERT INTO users (id, kind, display_name, email, email_verified, created_at, updated_at, status) VALUES (?, 'human', 'Fresh Memory User', ?, 0, ?, ?, 'active')"
      )
      .run(userId, `${userId}@example.invalid`, now, now);
  const userId = userIds[0]!;
  const actor = { kind: 'session' as const, userId };
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Fresh Memory context');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const foreign = store.createWorkspace('Other User context');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: foreign.id, ownerUserId: userIds[1]! });
  const timeline = openAssistantTimeline(store, workspace.id, userId, 'Private recall');
  const turn = store.createTurn(
    workspace.id,
    timeline.id,
    'My saved preference?',
    { kind: 'user', id: userId },
    null
  );
  const runtimeConfigManager = createRuntimeConfigManager({ dataRoot });
  const selectionResults: unknown[] = [];
  run.mockReset();
  run.mockImplementation(async (_dependencies: unknown, input: KnowledgeManagerAgentRun) => {
    const search = input.tools.find(({ name }) => name === 'knowledge.retrieval')!;
    const result = await search.execute(
      { query: 'saved preference', limit: 5 },
      {
        callId: randomUUID(),
        toolOccurrence: 1,
        signal: input.signal,
      }
    );
    const text = result.content
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('');
    const selected = JSON.parse(text);
    selectionResults.push(selected);
    expect(selected).toMatchObject({
      sources: [{ source: 'memory', selected: [], sourceScope: memoryScope() }],
      unavailableSources: [],
    });
    const answer = JSON.stringify({
      answer: 'No saved preference.',
      citationIds: [],
      uncertainty: 'No saved page matched.',
    });
    expect(input.validateResult(answer)).toBeUndefined();
    store.updateTurn(input.turn.id, { status: 'completed', completedAt: new Date().toISOString() });
    return { turnId: input.turn.id, text: answer };
  });
  const invoke = createOperationInvocation({
    coreDb,
    store,
    runtimeConfigManager,
    inflightCommands: new WeakMap(),
    repositoryWorkspaceDb: (id) => openWorkspaceDb(dataRoot, id),
    knowledgeAgent: {
      ask: (input) =>
        askKnowledgeAgent(
          {
            store,
            runtimeConfig: () => runtimeConfigManager.current(),
            dispatcher: { createResponses: vi.fn() },
            resolveGatewayProvider: vi.fn(),
            openWorkspace: (id) => openWorkspaceDb(dataRoot, id),
          },
          input
        ),
      maintain: vi.fn(),
    },
  });
  const context = {
    kind: 'public' as const,
    actor,
    delivery: 'model' as const,
    queryContext: { threadId: timeline.id, turnId: turn.id },
  };
  const memoryScope = () =>
    `page/user/${userId}/${readDefaultKnowledgeBaseId({ dataRoot, scope: { kind: 'user', userId } })}`;
  onTestFinished(async () => {
    await closeRetrievalServices();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  return {
    dataRoot,
    coreDb,
    userId,
    userIds,
    actor,
    store,
    workspace,
    foreign,
    timeline,
    turn,
    invoke,
    context,
    memoryScope,
    selectionResults,
  };
}

describe('first private User Memory query', () => {
  it('returns an empty schema-valid public search with real User KB, Notebook and Timeline references', async () => {
    const f = fixture();
    const credential = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: f.userId,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const app = createApp({
      coreDb: f.coreDb,
      dataRoot: f.dataRoot,
      store: f.store,
      mode: 'server',
    });
    expect(existsSync(userDbPath(f.dataRoot, f.userId))).toBe(false);
    expect(existsSync(userMemoryRoot(f.dataRoot, f.userId))).toBe(false);
    const response = await app.request('https://localhost/api/app/operations/memory.search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${credential.secret}` },
      body: JSON.stringify({ workspaceId: f.workspace.id, query: 'saved preference' }),
    });
    expect(response.status).toBe(200);
    const result = OPERATION_DEFINITIONS['memory.search'].outputSchema.parse(await response.json());
    const notebook = new KnowledgeNotebook({
      repositoryPath: join(userMemoryRoot(f.dataRoot, f.userId), 'notebook.git'),
    });
    expect(result).toMatchObject({
      selected: [],
      sourceScope: f.memoryScope(),
      notebookRevision: notebook.publishedRevision(),
      queryContext: { actor: { kind: 'user', id: f.userId }, threadId: f.timeline.id },
    });
    expect(result.retrievalTraceRef.scopeId).toBe(
      `retrieval-trace/thread/${f.workspace.id}/${f.timeline.id}`
    );
    expect(existsSync(dirname(userDbPath(f.dataRoot, f.userIds[1]!)))).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('runs native ask through the real private Memory reader and search on first use', async () => {
    const f = fixture();
    expect(existsSync(userDbPath(f.dataRoot, f.userId))).toBe(false);
    const result = await f.invoke(
      'memory.ask',
      { workspaceId: f.workspace.id, question: 'My saved preference?' },
      f.context
    );
    expect(OPERATION_DEFINITIONS['memory.ask'].outputSchema.safeParse(result).success).toBe(true);
    expect(result.citations).toEqual([]);
    const work = f.store.getTurnById(result.turnId);
    expect(work.owner).toEqual({ kind: 'workspace', workspaceId: f.workspace.id });
    expect(f.store.getThread(workspaceIdForOwner(work.owner), work.threadId)).toMatchObject({
      visibility: 'private',
      privateOwnerUserId: f.userId,
    });
    expect(f.selectionResults).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(existsSync(dirname(userDbPath(f.dataRoot, f.userIds[1]!)))).toBe(false);
  });

  it('refuses foreign Workspace and shared Thread entry before creating User storage', async () => {
    const f = fixture();
    const shared = f.store.createThread(f.workspace.id, 'Shared work', undefined, 'conversation', {
      visibility: 'workspace',
    });
    for (const operation of ['memory.search', 'memory.ask'] as const) {
      const input =
        operation === 'memory.search'
          ? { query: 'saved preference' }
          : { question: 'My saved preference?' };
      await expect(
        f.invoke(operation, { workspaceId: f.foreign.id, ...input }, f.context)
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        f.invoke(
          operation,
          { workspaceId: f.workspace.id, ...input },
          { ...f.context, queryContext: { threadId: shared.id } }
        )
      ).rejects.toMatchObject({ code: 'memory_access_denied', status: 403 });
      expect(existsSync(dirname(userDbPath(f.dataRoot, f.userId)))).toBe(false);
      expect(existsSync(userMemoryRoot(f.dataRoot, f.userId))).toBe(false);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    'UserDb',
    'Notebook',
    'Notebook Git',
    'Scope schema',
    'UserDb and Notebook',
  ] as const)('does not replace an established lost %s with empty Memory', async (lost) => {
    const f = fixture();
    const userDb = openUserDb(f.dataRoot, f.userId);
    applyScopedMigrations(userDb);
    const revision = initializeScopedNotebook({
      coreDb: f.coreDb,
      userDb,
      actor: f.actor,
      target: { kind: 'user' },
      initialization: { requestId: randomUUID(), instructionReference: 'test:established-memory' },
    });
    userDb.sqlite.close();
    const root = userMemoryRoot(f.dataRoot, f.userId);
    const knowledgeBaseId = readDefaultKnowledgeBaseId({
      dataRoot: f.dataRoot,
      scope: { kind: 'user', userId: f.userId },
    });
    const missing = {
      UserDb: [userDbPath(f.dataRoot, f.userId)],
      Notebook: [root],
      'Notebook Git': [join(root, 'notebook.git')],
      'Scope schema': [join(root, 'schema', 'scope-schema.yaml')],
      'UserDb and Notebook': [userDbPath(f.dataRoot, f.userId), root],
    }[lost];
    for (const path of missing) rmSync(path, { recursive: true });
    if (lost === 'Notebook Git' || lost === 'Scope schema') expect(existsSync(root)).toBe(true);
    for (const operation of ['memory.search', 'memory.ask'] as const) {
      const input =
        operation === 'memory.search'
          ? { query: 'saved preference' }
          : { question: 'My saved preference?' };
      await expect(
        f.invoke(operation, { workspaceId: f.workspace.id, ...input }, f.context)
      ).rejects.toMatchObject({ code: 'recovery_required', status: 503 });
      for (const path of missing) expect(existsSync(path)).toBe(false);
    }
    expect(
      readDefaultKnowledgeBaseId({
        dataRoot: f.dataRoot,
        scope: { kind: 'user', userId: f.userId },
      })
    ).toBe(knowledgeBaseId);
    if (lost === 'UserDb' || lost === 'Scope schema')
      expect(
        new KnowledgeNotebook({ repositoryPath: join(root, 'notebook.git') }).publishedRevision()
      ).toBe(revision);
    expect(run).not.toHaveBeenCalled();
  });
});

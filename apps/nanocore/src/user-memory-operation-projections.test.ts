import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { listWorkspaceCapabilityCalls } from './capability/usage-ledger.js';
import { createRuntimeConfigManager } from './config/runtime-config.js';
import { openAssistantTimeline } from './internal-agents/assistant-timeline.js';
import { initializeScopedNotebook } from './knowledge/scoped-notebook-owner.js';
import { FsStore } from './lib/store.js';
import { createOperationInvocation } from './operation-composition.js';
import { openCoreDb, openUserDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { ensureUserQuickChatWorkspace } from './workspace-membership.js';

/** Real authority, native invocation and delivery ledger; only the already tested role runner is injected. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'memory-km-operations-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const actor = { kind: 'local' as const, userId };
  const store = new FsStore({ dataRoot });
  ensureUserQuickChatWorkspace({ coreDb, store, userId });
  const workspace = store.ensureQuickChatWorkspace(userId);
  const timeline = openAssistantTimeline(store, workspace.id, userId, 'Private question');
  const turn = store.createTurn(
    workspace.id,
    timeline.id,
    'My preference?',
    { kind: 'user', id: userId },
    null
  );
  const userDb = openUserDb(dataRoot, userId);
  applyScopedMigrations(userDb);
  const baseRevision = initializeScopedNotebook({
    coreDb,
    userDb,
    actor,
    target: { kind: 'user' },
    initialization: { requestId: randomUUID(), instructionReference: 'test:User Memory' },
  });
  const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  applyScopedMigrations(workspaceDb);
  const answer = {
    threadId: timeline.id,
    turnId: turn.id,
    answer: 'No saved preference.',
    citations: [],
    uncertainty: 'No matching page.',
  };
  const ask = vi.fn(async () => answer);
  const maintainMemory = vi.fn(async () => ({
    threadId: timeline.id,
    turnId: turn.id,
    outcome: 'no-change' as const,
    notebookRevision: baseRevision,
    summary: 'No change.',
  }));
  const invoke = createOperationInvocation({
    coreDb,
    store,
    runtimeConfigManager: createRuntimeConfigManager({ dataRoot }),
    inflightCommands: new WeakMap(),
    repositoryWorkspaceDb: (id) => openWorkspaceDb(dataRoot, id),
    knowledgeAgent: { ask, maintainMemory, maintain: vi.fn() },
  });
  const context = {
    kind: 'public' as const,
    actor,
    delivery: 'model' as const,
    queryContext: { threadId: timeline.id, turnId: turn.id },
  };
  onTestFinished(() => {
    workspaceDb.sqlite.close();
    userDb.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  return {
    invoke,
    ask,
    maintainMemory,
    context,
    workspace,
    timeline,
    turn,
    workspaceDb,
    answer,
    store,
  };
}

it('routes private Memory ask and tell to the User KM and retains exact delivered answer bytes', async () => {
  const f = fixture();
  expect(
    await f.invoke(
      'memory.ask',
      { workspaceId: f.workspace.id, question: 'My preference?' },
      f.context
    )
  ).toEqual(f.answer);
  expect(f.ask).toHaveBeenCalledWith(
    expect.objectContaining({
      source: 'memory',
      caller: 'internal-agent',
      access: expect.objectContaining({
        outputThreadId: f.timeline.id,
        outputTurnId: f.turn.id,
        requestActor: f.context.actor,
      }),
    })
  );
  const calls = listWorkspaceCapabilityCalls(f.workspaceDb, f.workspace.id);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.extensions?.['openkit.knowledge/delivery']).toEqual({
    answer: JSON.stringify(f.answer),
  });
  await f.invoke(
    'memory.tell',
    {
      workspaceId: f.workspace.id,
      requestId: randomUUID(),
      content: 'Keep answers short.',
      sources: [],
    },
    f.context
  );
  expect(f.maintainMemory).toHaveBeenCalledWith(
    expect.objectContaining({
      requestActor: f.context.actor,
      tellContent: 'Keep answers short.',
      askingThreadId: f.timeline.id,
      askingTurnId: f.turn.id,
    }),
    expect.objectContaining({ userId: f.context.actor.userId })
  );
});

it('refuses a shared caller before User recall or tell and keeps human Review unavailable to a model', async () => {
  const f = fixture();
  const shared = f.store.createThread(f.workspace.id, 'Shared work', undefined, 'conversation', {
    visibility: 'workspace',
  });
  const context = { ...f.context, queryContext: { threadId: shared.id } };
  await expect(
    f.invoke('memory.ask', { workspaceId: f.workspace.id, question: 'My preference?' }, context)
  ).rejects.toMatchObject({ code: 'memory_access_denied' });
  await expect(
    f.invoke(
      'memory.tell',
      {
        workspaceId: f.workspace.id,
        requestId: randomUUID(),
        content: 'Remember shared work.',
        sources: [],
      },
      context
    )
  ).rejects.toMatchObject({ code: 'memory_access_denied' });
  expect(f.ask).not.toHaveBeenCalled();
  expect(f.maintainMemory).not.toHaveBeenCalled();
  await expect(
    f.invoke(
      'memory.proposal.decide',
      {
        proposalId: `kp_${'0'.repeat(64)}`,
        requestId: randomUUID(),
        proposalDigest: `sha256:${'0'.repeat(64)}`,
        baseRevision: 'base',
        candidateRevision: 'candidate',
        decision: 'accepted',
      },
      f.context
    )
  ).rejects.toMatchObject({ code: 'human_review_required' });
  expect(listWorkspaceCapabilityCalls(f.workspaceDb, f.workspace.id)).toEqual([]);
});

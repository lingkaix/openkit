import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { projectAgentCatalogEntries } from '../agents/catalog-projection.js';
import { ensureLocalUser } from '../auth/identity.js';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import { FsStore } from '../lib/store.js';
import { createOperationInvocation } from '../operation-composition.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { createGoalTools, type GoalWorkerCandidate } from './goal-coordinator.js';
import { executeGoalOperation } from './goal-owner.js';

/** Uses real operation admission and catalog reads; only live setup resolution is supplied. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'goal-discovery-'));
  const coreDb = openCoreDb(root);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot: root });
  const workspace = store.createWorkspace('Discovery');
  const other = store.createWorkspace('Other authorized Workspace');
  for (const entry of [workspace, other])
    recordWorkspaceOwnerMembership({ coreDb, workspaceId: entry.id, ownerUserId: 'user_local' });
  store.setWorkspaceAgentCatalogProjection(() =>
    projectAgentCatalogEntries([createTestAgentSetup({ agentId: 'selected-worker' }).manifest])
  );
  const actor = { kind: 'session' as const, userId: 'user_local' };
  const db = openWorkspaceDb(root, workspace.id);
  applyScopedMigrations(db);
  const created = await executeGoalOperation(
    'goal.create',
    {
      workspaceId: workspace.id,
      requestId: randomUUID(),
      intent: 'Discover a Worker',
    },
    { actor },
    store,
    db,
    { coreDb }
  );
  const goal = created.goal!;
  const turn = store.createTurn(
    workspace.id,
    goal.threadId,
    'Discover Workers',
    { kind: 'user', id: actor.userId },
    undefined,
    { agentId: 'goal-coordinator', executorKind: 'coordinator' }
  );
  let candidates: readonly GoalWorkerCandidate[] = [
    { agentId: 'selected-worker', runtime: 'codex', readiness: 'ready', reasons: [] },
  ];
  const resolver = vi.fn(() => candidates);
  const invoke = createOperationInvocation({
    coreDb,
    store,
    repositoryWorkspaceDb: (id) => openWorkspaceDb(root, id),
    workspaceMutationAdmission: new WorkspaceMutationAdmission(),
  });
  const tools = createGoalTools({
    store,
    db,
    actor,
    goalId: goal.goalId,
    turnId: turn.id,
    services: { coreDb },
    invoke,
    workerCandidates: resolver,
  });
  const tool = tools.find((entry) => entry.name === 'agent_list')!;
  return {
    root,
    coreDb,
    store,
    db,
    workspace,
    goal,
    turn,
    tool,
    tools,
    resolver,
    setCandidates(value: readonly GoalWorkerCandidate[]) {
      candidates = value;
    },
    close() {
      vi.restoreAllMocks();
      db.sqlite.close();
      coreDb.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it('discovers through agent.list with exact Workspace scope, no work effect, and fixed Tool membership', async () => {
  const f = await fixture();
  try {
    const resources = vi.spyOn(f.store, 'getWorkspaceResources');
    const result = await f.tool.execute({});
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0]!.text!)).toEqual({
      items: [
        {
          agentId: 'selected-worker',
          displayName: 'Codex Agent',
          runtime: 'codex',
          readiness: 'ready',
          reasons: [],
        },
      ],
    });
    expect(resources.mock.calls.map(([id]) => id)).toEqual([f.workspace.id]);
    expect(f.resolver).toHaveBeenCalledWith(f.workspace.id, 'user_local');
    expect(f.store.listThreads(f.workspace.id)).toHaveLength(1);
    expect(f.db.sqlite.prepare('SELECT * FROM goal_card_tasks').all()).toEqual([]);
    const names = f.tools.map((tool) => tool.name);
    f.setCandidates([]);
    expect(JSON.parse((await f.tool.execute({})).content[0]!.text!)).toEqual({ items: [] });
    expect(f.tools.map((tool) => tool.name)).toEqual(names);
  } finally {
    f.close();
  }
});

it.each([
  { workspaceId: 'other' },
  { agentId: 'replacement' },
  { goalId: 'other' },
])('refuses model-selected discovery context %j before catalog reads', async (value) => {
  const f = await fixture();
  try {
    const resources = vi.spyOn(f.store, 'getWorkspaceResources');
    const result = await f.tool.execute(value);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text!)).toMatchObject({ code: 'invalid_request' });
    expect(resources).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});

it('preserves blocked supply and refuses a failed catalog read instead of returning an empty set', async () => {
  const f = await fixture();
  try {
    f.setCandidates([
      {
        agentId: 'selected-worker',
        runtime: 'codex',
        readiness: 'blocked',
        reasons: ['Current Worker setup is not ready.'],
      },
    ]);
    expect(JSON.parse((await f.tool.execute({})).content[0]!.text!)).toMatchObject({
      items: [{ readiness: 'blocked' }],
    });
    vi.spyOn(f.store, 'getWorkspaceResources').mockImplementation(() => {
      throw new Error('PRIVATE_DIAGNOSTIC_CANARY');
    });
    const result = await f.tool.execute({});
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text!)).toMatchObject({
      code: 'worker_discovery_unavailable',
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_DIAGNOSTIC_CANARY');
  } finally {
    f.close();
  }
});

it('rechecks actor authority before publishing discovery', async () => {
  const f = await fixture();
  try {
    f.resolver.mockImplementation(() => {
      f.coreDb.sqlite.transaction(() => disableCanonicalUser(f.coreDb, 'user_local'))();
      return [{ agentId: 'selected-worker', runtime: 'codex', readiness: 'ready', reasons: [] }];
    });
    const result = await f.tool.execute({});
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('selected-worker');
  } finally {
    f.close();
  }
});

it('refuses an ended Coordinator before reading catalog content', async () => {
  const f = await fixture();
  try {
    f.store.updateTurn(f.turn.id, { status: 'completed', completedAt: new Date().toISOString() });
    const resources = vi.spyOn(f.store, 'getWorkspaceResources');
    expect((await f.tool.execute({})).isError).toBe(true);
    expect(resources).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});

it('refuses incomplete or oversized discovery without publishing a partial candidate set', async () => {
  const f = await fixture();
  try {
    f.setCandidates([
      { agentId: 'removed-worker', runtime: 'codex', readiness: 'ready', reasons: [] },
    ]);
    expect(JSON.parse((await f.tool.execute({})).content[0]!.text!)).toMatchObject({
      code: 'worker_discovery_changed',
    });
    f.setCandidates(
      Array.from({ length: 201 }, () => ({
        agentId: 'selected-worker',
        runtime: 'codex' as const,
        readiness: 'ready' as const,
        reasons: [],
      }))
    );
    expect(JSON.parse((await f.tool.execute({})).content[0]!.text!)).toMatchObject({
      code: 'result_too_large',
    });
    f.setCandidates([
      {
        agentId: 'selected-worker',
        runtime: 'codex',
        readiness: 'blocked',
        reasons: ['x'.repeat(65536)],
      },
    ]);
    expect(JSON.parse((await f.tool.execute({})).content[0]!.text!)).toMatchObject({
      code: 'result_too_large',
    });
  } finally {
    f.close();
  }
});

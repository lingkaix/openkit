import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import { createStructuredWorkerDelegationRequest } from '../internal-agents/delegation.js';
import { FsStore } from '../lib/store.js';
import { createGoalDomainPolicyService } from '../policy/goal-domains.js';
import { createGoalTaskPolicyService } from '../policy/goal-task-policy.js';
import { EMPTY_POLICY_DOCUMENT, policyDigest } from '../policy/statements.js';
import { closeRetrievalServices } from '../retrieval-service.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { executeGoalOperation } from './goal-owner.js';
import { createCoordinatorTaskTool } from './task-admission.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  await closeRetrievalServices();
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** Composes the real Goal/Pending writer and admitted Policy owner before any Task or transport. */
async function fixture(
  options: { uses?: number; publish?: boolean; approval?: boolean; taskGrant?: boolean } = {}
) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'goal-consumer-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const actor = { kind: 'local' as const, userId };
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Goal Policy consumers');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const db = openWorkspaceDb(dataRoot, workspace.id);
  applyScopedMigrations(db);
  cleanup.push(() => {
    db.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  mkdirSync(join(dataRoot, 'config'), { recursive: true });
  writeFileSync(join(dataRoot, 'config/server.jsonc'), JSON.stringify({ schemaVersion: 1 }));
  const manager = createRuntimeConfigManager({ dataRoot });
  const domains = createGoalDomainPolicyService({
    coreDb,
    store,
    repositoryWorkspaceDb: () => db,
    files: new RuntimeConfigFileService({
      dataRoot,
      userId,
      workspaceIds: [workspace.id],
      runtimeConfigManager: manager,
      readRuntimeConfigStatus: () => manager.status(),
    }),
    currentPolicy: () => manager.current().openKitConfig.policy?.mediation,
    reload: () => manager.reload({ mode: 'safe', dryRun: false }),
  });
  const services = {
    coreDb,
    goalDomain: {
      forActor: () => domains,
      currentRevision: () =>
        policyDigest(manager.current().openKitConfig.policy?.mediation ?? EMPTY_POLICY_DOCUMENT),
    },
  };
  const goal = (
    await executeGoalOperation(
      'goal.create',
      { workspaceId: workspace.id, requestId: randomUUID(), intent: 'Read a bounded issue' },
      { actor },
      store,
      db,
      services
    )
  ).goal!;
  const scope = { workspaceId: workspace.id, threadId: goal.threadId, goalId: goal.goalId };
  const coordinator = store.createTurn(
    workspace.id,
    goal.threadId,
    'Coordinate',
    { kind: 'user', id: userId },
    null,
    { executorKind: 'coordinator', agentId: 'goal-coordinator' }
  );
  const coordinatorContext = { actor, coordinatorTurnId: coordinator.id };
  const cards = await executeGoalOperation(
    'goal.card.create',
    { ...scope, requestId: randomUUID(), description: 'Read an issue', priority: 1 },
    { actor },
    store,
    db,
    services
  );
  const card = cards.cards[0]!;
  const agentId = 'issue-worker';
  const resource = {
    kind: 'mcp-tool' as const,
    workspaceId: workspace.id,
    serverId: 'issues',
    toolName: 'read',
  };
  const proposed = await executeGoalOperation(
    'goal.plan.propose',
    {
      ...scope,
      requestId: randomUUID(),
      expectedRevision: cards.goal!.changeRevision,
      commitment: {
        intentBasis: { revision: 0, intent: goal.intent },
        cards: [
          {
            cardId: card.cardId,
            revision: card.revision,
            description: card.description,
            priority: card.priority,
          },
        ],
        permittedAdjustments: 'Refine read method only',
        completionEvidence: ['Read issue'],
        boundaries: 'No writes',
      },
      goalDomain: {
        id: 'issue-domain',
        scope: {
          subjects: [{ kind: 'agent', id: agentId }],
          actions: ['tool.use'],
          resources: [resource],
        },
        lifetime: {
          ...(options.uses === undefined ? {} : { uses: options.uses }),
          anchor: {
            owner: { kind: 'workspace', workspaceId: workspace.id },
            kind: 'goal',
            id: goal.goalId,
          },
        },
      },
    },
    coordinatorContext,
    store,
    db,
    services
  );
  const plan = proposed.versions[0]!;
  const approval = {
    ...scope,
    pendingRequestId: plan.pendingRequestId,
    decision: 'granted' as const,
  };
  await executeGoalOperation(
    'goal.plan.approve',
    { ...approval, requestId: randomUUID() },
    { actor },
    store,
    db,
    services
  );
  await executeGoalOperation(
    'goal.plan.approve',
    { ...approval, requestId: randomUUID() },
    coordinatorContext,
    store,
    db,
    options.publish === false ? { coreDb } : services
  );
  const domain = domains.read(scope);
  expect(domain !== null).toBe(options.publish !== false);
  const goalTaskPolicy = (_workspaceDb: typeof db) =>
    createGoalTaskPolicyService({ coreDb, store, domains });
  const request = createStructuredWorkerDelegationRequest({
    objective: 'Read an issue',
    acceptanceCriteria: ['Read issue'],
    contextRefs: [{ kind: 'workspace', id: workspace.id }],
    resources:
      options.taskGrant === false
        ? []
        : [{ kind: 'policy', resource, reason: 'Read the exact selected Tool' }],
    expectedArtifacts: [],
    constraints: { maxContextTokens: 1000, maxWorkerIterations: 1 },
    verification: [{ kind: 'manual', description: 'Inspect issue' }],
    reviewPolicy: { required: false, reviewers: ['human'], instructions: 'Inspect issue' },
    escalationConditions: [],
    reviewContext: null,
  });
  const dispatchInput = {
    cardId: card.cardId,
    cardRevision: card.revision,
    intentRevision: 0,
    planVersionId: plan.planVersionId,
    withinCurrentIntent: true,
    withinPermittedAdjustments: true,
    rationale: 'Read only',
    agentId,
    request,
  };
  const dispatch = async (selectedAgentId = agentId) => {
    const startWorker = vi.fn(async () => {
      throw new Error('SAFE_WORKER_BOUNDARY');
    });
    const tool = createCoordinatorTaskTool({
      store,
      coreDb,
      openWorkspace: (id) => openWorkspaceDb(dataRoot, id),
      inflightCommands: new WeakMap(),
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      startWorker,
      goalId: goal.goalId,
      coordinatorTurnId: coordinator.id,
      ...{ goalTaskPolicy },
    });
    const result = await tool.execute({ ...dispatchInput, agentId: selectedAgentId });
    return { result, startWorker };
  };

  return { coreDb, db, store, actor, scope, domain, domains, plan, agentId, dispatch };
}

describe('Goal-domain Task consumers', () => {
  it.each([
    'missing-domain',
    'wrong-worker',
  ] as const)('refuses %s before Task reservation and Worker entry', async (reason) => {
    const f = await fixture({ publish: reason !== 'missing-domain' });
    const before = f.db.sqlite
      .prepare('SELECT thread_id FROM goal_card_tasks ORDER BY thread_id')
      .all();
    const { result, startWorker } = await f.dispatch(
      reason === 'wrong-worker' ? 'unselected-worker' : f.agentId
    );
    expect(result.isError).toBe(true);
    expect(startWorker).not.toHaveBeenCalled();
    expect(
      f.db.sqlite.prepare('SELECT thread_id FROM goal_card_tasks ORDER BY thread_id').all()
    ).toEqual(before);
  });

  it('lets an admitted selected Worker reach ordinary Task execution', async () => {
    const f = await fixture();
    const { result, startWorker } = await f.dispatch();
    expect(JSON.stringify(result)).toContain('SAFE_WORKER_BOUNDARY');
    expect(startWorker).toHaveBeenCalledTimes(1);
  });
});

import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';
import * as operationAuthorizer from '../auth/operation-authorizer.js';
import { createStructuredWorkerDelegationRequest } from '../internal-agents/delegation.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { executeGoalOperation, readGoalView } from './goal-owner.js';
import { createCoordinatorTaskTool } from './task-admission.js';

it.each([
  false,
  true,
])('uses current Knowledge admission before reserving Plan/card citations (read denied: %s)', async (readDenied) => {
  const root = mkdtempSync(join(tmpdir(), 'goal-native-task-'));
  const coreDb = openCoreDb(root);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot: root });
  const ws = store.createWorkspace('Task citations');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: ws.id, ownerUserId: 'user_local' });
  const db = openWorkspaceDb(root, ws.id);
  applyScopedMigrations(db);
  const actor = { kind: 'local' as const, userId: 'user_local' };
  const human = { actor };
  const services = { coreDb };
  const originalAuthorize = operationAuthorizer.authorizeWorkspace;
  const authorization = vi.spyOn(operationAuthorizer, 'authorizeWorkspace');
  const startWorker = vi.fn(
    async (input: Parameters<import('./task-admission.js').TaskWorkerStarter>[0]) => {
      const turn = store.createTurn(
        input.workspaceId,
        input.threadId,
        input.prompt,
        input.triggerActor,
        undefined,
        { turnId: input.reservedTurnId }
      );
      input.onTurnCreated(turn);
      return store.updateTurn(turn.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
    }
  );
  try {
    const created = await executeGoalOperation(
      'goal.create',
      { workspaceId: ws.id, requestId: randomUUID(), intent: 'Review the schema' },
      human,
      store,
      db,
      services
    );
    const goal = created.goal!;
    const scope = { workspaceId: ws.id, threadId: goal.threadId, goalId: goal.goalId };
    const cards = await executeGoalOperation(
      'goal.card.create',
      { ...scope, requestId: randomUUID(), description: 'Review the schema', priority: 0 },
      human,
      store,
      db,
      services
    );
    const card = cards.cards[0]!;
    const coordinator = store.createTurn(
      ws.id,
      goal.threadId,
      'Coordinate',
      { kind: 'user', id: actor.userId },
      undefined,
      { executorKind: 'coordinator', agentId: 'goal-coordinator' }
    );
    const context = { actor, coordinatorTurnId: coordinator.id };
    const proposal = await executeGoalOperation(
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
          permittedAdjustments: 'Refine review only',
          completionEvidence: ['A review'],
          boundaries: 'No deployment',
        },
      },
      context,
      store,
      db,
      services
    );
    const plan = proposal.versions[0]!;
    await executeGoalOperation(
      'goal.plan.approve',
      {
        ...scope,
        requestId: randomUUID(),
        pendingRequestId: plan.pendingRequestId,
        decision: 'granted',
      },
      human,
      store,
      db,
      services
    );
    await executeGoalOperation(
      'goal.plan.approve',
      {
        ...scope,
        requestId: randomUUID(),
        pendingRequestId: plan.pendingRequestId,
        decision: 'granted',
      },
      context,
      store,
      db,
      services
    );
    const taskTool = createCoordinatorTaskTool({
      store,
      coreDb,
      openWorkspace: (id) => openWorkspaceDb(root, id),
      inflightCommands: new WeakMap(),
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      goalId: goal.goalId,
      coordinatorTurnId: coordinator.id,
      startWorker,
    });
    const request = createStructuredWorkerDelegationRequest({
      objective: 'Review the schema',
      acceptanceCriteria: ['A review exists'],
      contextRefs: [{ kind: 'workspace', id: ws.id }],
      resources: [],
      expectedArtifacts: [],
      constraints: { maxContextTokens: 1000, maxWorkerIterations: 1 },
      verification: [{ kind: 'manual', description: 'Inspect the review' }],
      reviewPolicy: { required: false, reviewers: ['human'], instructions: 'Inspect the review' },
      escalationConditions: [],
      reviewContext: null,
    });
    if (readDenied)
      authorization.mockImplementation((...args) =>
        args[3].policyOperation === 'knowledge.read' ? null : originalAuthorize(...args)
      );
    const result = await taskTool.execute(
      {
        cardId: card.cardId,
        cardRevision: card.revision,
        intentRevision: 0,
        planVersionId: plan.planVersionId,
        withinCurrentIntent: true,
        withinPermittedAdjustments: true,
        rationale: 'Review stays inside the approved boundary',
        agentId: 'test-worker',
        request,
      },
      { callId: 'task', signal: new AbortController().signal }
    );
    expect(authorization).toHaveBeenCalledWith(
      coreDb,
      actor,
      ws.id,
      expect.objectContaining({
        mutating: true,
        policyOperation: 'knowledge.read',
      })
    );
    const linked = readGoalView(store, db, goal.goalId);
    if (readDenied) {
      expect(result.isError, JSON.stringify(result)).toBe(true);
      expect(linked.tasks).toEqual([]);
      expect(startWorker).not.toHaveBeenCalled();
      return;
    }
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(startWorker).toHaveBeenCalledOnce();
    expect(linked.tasks).toMatchObject([
      { cardId: card.cardId, cardRevision: 0, planVersionId: plan.planVersionId, missing: false },
    ]);
    expect(linked.tasks[0]!.turns).toMatchObject([{ status: 'completed' }]);
    expect(linked.goal!.disposition).toBeNull();
  } finally {
    authorization.mockRestore();
    db.sqlite.close();
    coreDb.sqlite.close();
  }
});

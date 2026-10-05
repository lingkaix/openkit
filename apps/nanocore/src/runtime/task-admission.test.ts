import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';
import * as operationAuthorizer from '../auth/operation-authorizer.js';
import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import { createStructuredWorkerDelegationRequest } from '../internal-agents/delegation.js';
import { FsStore } from '../lib/store.js';
import { ProviderRegistry } from '../providers/registry.js';
import { completeSchedulerLeaseForTerminalTurn } from '../scheduler-records.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { executeGoalOperation, readGoalView } from './goal-owner.js';
import { TurnStartValidationError } from './orchestrator.js';
import { startProductTurn } from './product-turn-start.js';
import { createCoordinatorTaskTool } from './task-admission.js';
import { listThreadWorkerCheckpoints } from './worker-checkpoints.js';

it.each([
  'admitted',
  'interrupted',
  'read-denied',
  'refused',
  'recovery-required-refusal',
] as const)('projects Goal Task reservation from ordinary admission owners (%s)', async (outcome) => {
  const readDenied = outcome === 'read-denied';
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
      if (outcome === 'refused')
        throw new TurnStartValidationError('scheduler_admission_denied', 'Capacity refused.', 409);
      if (outcome === 'recovery-required-refusal')
        throw new TurnStartValidationError(
          'recovery_required',
          'Capacity inspection refused before admission.',
          409
        );
      const manifest = createTestAgentSetup().manifest;
      let result: ReturnType<FsStore['createTurn']> | undefined;
      await startProductTurn({
        coreDb,
        store,
        triggerActor: input.triggerActor,
        requestActor: input.requestActor,
        snapshot: createInMemoryRuntimeConfigSnapshot({
          agentManifests: [manifest],
          dataRoot: null,
          gatewayConfig: createTestGatewayConfig(),
          providerRegistry: new ProviderRegistry([
            {
              id: 'agent-openrouter',
              displayName: 'Fixture',
              kind: 'local',
              defaultModel: 'openai/gpt-5.2',
              models: ['openai/gpt-5.2'],
              modelMetadata: { 'openai/gpt-5.2': { temperature: false } },
            },
          ]),
        }),
        schedulerEpoch: 1,
        workerPlacement: 'local',
        providerCredentialResolver: () => null,
        reservedTurnId: input.reservedTurnId,
        input: {
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          requestId: input.requestId,
          input: input.prompt,
          agentId: manifest.id,
        },
        onTurnCreated: (created, agentSessionId) => {
          input.onTurnCreated(created, agentSessionId);
          const checkpoint = listThreadWorkerCheckpoints(db, ws.id, input.threadId)[0]!;
          expect(checkpoint).toMatchObject({
            stage: 'running_worker',
            workerSessionId: agentSessionId,
            stopReason: null,
          });
        },
        turnExecutor: {
          capabilities: {},
          eventFamilies: [],
          prepareAgentSessionForTurn: async () => ({
            agentSessionId: 'as_goal_fixture',
            currentAgentSession: null,
            replacementRequired: false,
            sessionCompatibilityKey: 'sha256:fixture',
          }),
          startTurn: async (
            _store: FsStore,
            turnId: string,
            _prompt: string,
            context: { agentSessionId: string }
          ) => {
            const turn = store.getTurnById(turnId);
            const at = turn.startedAt!;
            store.createAgentSession({
              id: context.agentSessionId,
              agentId: manifest.id,
              workspaceId: ws.id,
              threadId: input.threadId,
              status: outcome === 'interrupted' ? 'interrupted' : 'idle',
              message: null,
              createdAt: at,
              updatedAt: at,
            });
            store.createItem({
              id: `it_user_${turnId}`,
              workspaceId: ws.id,
              threadId: input.threadId,
              turnId,
              type: 'user-message',
              status: 'completed',
              text: input.prompt,
              actor: input.triggerActor,
              createdAt: at,
              completedAt: at,
            });
            result = store.updateTurn(turnId, {
              agentSessionId: context.agentSessionId,
              status: outcome === 'interrupted' ? 'interrupted' : 'completed',
              completedAt: at,
            });
            if (outcome === 'interrupted')
              throw new TurnStartValidationError(
                'workspace_access_denied',
                'Workspace access denied.',
                403
              );
            store.emitTurnEvent(turnId, {
              event: 'turn.completed',
              requestId: input.requestId,
              workspaceId: ws.id,
              threadId: input.threadId,
              turnId,
              data: { type: 'turn-completed', stopReason: 'completed', turn: result },
            });
          },
        } as never,
      });
      completeSchedulerLeaseForTerminalTurn(coreDb, result!);
      return result!;
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
    const connections: ReturnType<typeof openWorkspaceDb>[] = [];
    const taskTool = createCoordinatorTaskTool({
      store,
      coreDb,
      openWorkspace: (id) => {
        const connection = openWorkspaceDb(root, id);
        connections.push(connection);
        return connection;
      },
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
    await vi.waitFor(() =>
      expect(connections.every((connection) => !connection.sqlite.open)).toBe(true)
    );
    if (outcome === 'refused' || outcome === 'recovery-required-refusal') {
      expect(result.isError, JSON.stringify(result)).toBe(true);
      expect(startWorker).toHaveBeenCalledOnce();
      expect(linked.tasks).toMatchObject([
        {
          cardId: card.cardId,
          planVersionId: plan.planVersionId,
          admittedAt: null,
          missing: false,
          turns: [],
        },
      ]);
      const task = linked.tasks[0]!;
      const errorResult = JSON.parse((result.content[0] as { text: string }).text);
      expect(errorResult).toMatchObject({
        threadId: task.threadId,
        code:
          outcome === 'recovery-required-refusal'
            ? 'recovery_required'
            : 'scheduler_admission_denied',
      });
      // Retained pre-fix timestamps remain usable data but cannot prove a Turn was admitted.
      const retainedBytes = JSON.stringify({ ...task, admittedAt: '2026-09-01T00:00:00.000Z' });
      db.sqlite
        .prepare('UPDATE goal_card_tasks SET payload_json=? WHERE thread_id=?')
        .run(retainedBytes, task.threadId);
      expect(readGoalView(store, db, goal.goalId).tasks).toEqual(linked.tasks);
      const checkpoints = listThreadWorkerCheckpoints(db, ws.id, task.threadId);
      expect(checkpoints).toMatchObject([
        {
          stage: outcome === 'recovery-required-refusal' ? 'preparing' : 'failed',
          workerSessionId: null,
        },
      ]);
      // Reopening the owners must preserve the attempted citation without inventing admission or retry.
      const reopened = openWorkspaceDb(root, ws.id);
      try {
        expect(readGoalView(new FsStore({ dataRoot: root }), reopened, goal.goalId).tasks).toEqual(
          linked.tasks
        );
      } finally {
        reopened.sqlite.close();
      }
      expect(startWorker).toHaveBeenCalledOnce();
      expect(linked.goal!.disposition).toBeNull();
      return;
    }
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(startWorker).toHaveBeenCalledOnce();
    expect(linked.tasks).toMatchObject([
      { cardId: card.cardId, cardRevision: 0, planVersionId: plan.planVersionId, missing: false },
    ]);
    expect(linked.tasks[0]!.turns).toMatchObject([
      { status: outcome === 'interrupted' ? 'interrupted' : 'completed' },
    ]);
    const checkpoints = listThreadWorkerCheckpoints(db, ws.id, linked.tasks[0]!.threadId);
    if (outcome === 'interrupted')
      expect(checkpoints).toMatchObject([
        { stage: 'running_worker', stopReason: null, workerSessionId: 'as_goal_fixture' },
      ]);
    else expect(checkpoints).toEqual([]);
    const admittedTurn = store.listThreadTurns(ws.id, linked.tasks[0]!.threadId)[0]!;
    expect(linked.tasks[0]!.admittedAt).toBe(admittedTurn.startedAt);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      threadId: admittedTurn.threadId,
      turnId: admittedTurn.id,
      admittedAt: admittedTurn.startedAt,
    });
    store.createTurn(ws.id, admittedTurn.threadId, 'Follow up', { kind: 'user', id: actor.userId });
    expect(readGoalView(store, db, goal.goalId).tasks[0]!.admittedAt).toBe(admittedTurn.startedAt);
    expect(linked.goal!.disposition).toBeNull();
  } finally {
    authorization.mockRestore();
    db.sqlite.close();
    coreDb.sqlite.close();
  }
});

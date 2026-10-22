import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import * as operationAuthorizer from '../auth/operation-authorizer.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
  loadRuntimeConfig,
} from '../config/runtime-config.js';
import { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import { createStructuredWorkerDelegationRequest } from '../internal-agents/delegation.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { FsStore } from '../lib/store.js';
import { createGoalDomainPolicyService } from '../policy/goal-domains.js';
import { createGoalTaskPolicyService } from '../policy/goal-task-policy.js';
import { EMPTY_POLICY_DOCUMENT, policyDigest } from '../policy/statements.js';
import { ProviderRegistry } from '../providers/registry.js';
import {
  cancelSchedulerAdmissionEntry,
  createSchedulerAdmissionEntry,
  listSchedulerAdmissionEntriesForWorkspace,
} from '../scheduler-records.js';
import { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { testGoalDomainProposal } from '../test-support/goal-domain.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import {
  admitTestNativeEnvironment,
  recordTestNativeRuntimeTarget,
} from '../test-support/native-environment.js';
import { createNativeTaskAdmissionFixture } from '../test-support/native-task-admission.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import {
  listSchedulerExecutionAttemptsByTurnId,
  listSchedulerExecutionAttemptsForTurn,
} from './execution-attempt-records.js';
import { executeGoalOperation, readGoalView } from './goal-owner.js';
import { TurnStartValidationError } from './orchestrator.js';
import { startProductTurn } from './product-turn-start.js';
import { createCoordinatorTaskTool } from './task-admission.js';
import { listThreadWorkerCheckpoints } from './worker-checkpoints.js';
import * as workerTurnLoop from './worker-turn-loop.js';

it.each([
  'admitted',
  'interrupted',
  'read-denied',
  'refused',
  'cancelled',
  'recovery-required-refusal',
] as const)('projects Goal Task reservation from ordinary admission owners (%s)', async (outcome) => {
  const readDenied = outcome === 'read-denied';
  const root = mkdtempSync(join(tmpdir(), 'goal-native-task-'));
  const coreDb = openCoreDb(root);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot: root });
  const ws = await store.createWorkspace('Task citations');
  recordWorkspaceOwnerMembership({
    coreDb,
    workspaceId: ws.id,
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
  });
  const db = openWorkspaceDb(root, ws.id);
  applyScopedMigrations(db);
  const actor = { kind: 'local' as const, userId: 'usr_00000000-0000-7000-8000-000000000001' };
  const human = { actor };
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config/server.jsonc'), JSON.stringify({ schemaVersion: 1 }));
  const manager = createRuntimeConfigManager({ dataRoot: root });
  const domains = createGoalDomainPolicyService({
    coreDb,
    store,
    repositoryWorkspaceDb: () => db,
    files: new RuntimeConfigFileService({
      dataRoot: root,
      userId: actor.userId,
      workspaceIds: [ws.id],
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
  const selectedAgentId = createTestAgentSetup().manifest.id;
  const originalAuthorize = operationAuthorizer.authorizeWorkspace;
  const authorization = vi.spyOn(operationAuthorizer, 'authorizeWorkspace');
  let interruptedNative: ReturnType<typeof createNativeTaskAdmissionFixture> | undefined;
  let drainingInterruptedPeer = false;
  const enteredWorkerStarts: Promise<void>[] = [];
  const enteredWorkerLoops: Promise<unknown>[] = [];
  const connectionClosures: Promise<void>[] = [];
  const runWorkerLoop = workerTurnLoop.runWorkerTurnLoop;
  const loopObservation =
    outcome === 'interrupted'
      ? vi.spyOn(workerTurnLoop, 'runWorkerTurnLoop').mockImplementation((args) => {
          const execution = runWorkerLoop(args);
          if (args.store === store) enteredWorkerLoops.push(execution);
          return execution;
        })
      : undefined;
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
      if (outcome === 'cancelled') {
        // Cancellation precedes product acceptance and all preparation/effects. The existing
        // checkpoint-removal owner must decide the exact tuple and complete absence proof.
        const entry = createSchedulerAdmissionEntry(coreDb, {
          backendId: 'nanohost',
          queueEntryId: `queue_cancel_${input.requestId}`,
          requestId: input.requestId,
          requestedAgentId: input.requestedAgentId,
          threadId: input.threadId,
          turnId: input.reservedTurnId,
          turnInput: input.prompt,
          triggerActor: input.triggerActor,
          workspaceId: input.workspaceId,
        });
        cancelSchedulerAdmissionEntry(coreDb, {
          queueEntryId: entry.queueEntryId,
          workspaceId: entry.workspaceId,
        });
        throw new TurnStartValidationError(
          'turn_cancelled',
          'Task request cancelled before product acceptance.',
          409
        );
      }
      const manifest = createTestAgentSetup(
        outcome === 'interrupted'
          ? { requiredCapabilities: ['trusted-worker-inference-relay'] }
          : {}
      ).manifest;
      admitTestNativeEnvironment(coreDb, manifest);
      recordTestNativeRuntimeTarget(coreDb);
      const snapshot = createInMemoryRuntimeConfigSnapshot({
        workspaceConfigs: outcome === 'interrupted' ? loadRuntimeConfig(root).workspaceConfigs : [],
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
      });
      // The shared peer holds the admitted Turn until the actual interrupt owner stops it.
      if (outcome === 'interrupted') {
        const native = createNativeTaskAdmissionFixture(coreDb, store, {
          readRuntimeConfig: () => snapshot,
        });
        interruptedNative = native;
        const start = native.executor.startTurn.bind(native.executor);
        native.executor.startTurn = (...args) => {
          const execution = start(...args);
          enteredWorkerStarts.push(execution);
          // A late start during failure cleanup must release only its entered peer hold.
          if (drainingInterruptedPeer && native.executor.launches > 0)
            native.executor.completion.resolve();
          return execution;
        };
      }
      const turnExecutor =
        interruptedNative?.executor ??
        new SimulatedTurnExecutor({
          coreDb,
          fileAdmission: new FileStorageAdmission(root, () => 1_000_000_000n),
        });
      const ended = await startProductTurn({
        ...(input.commandReceipt ? { commandReceipt: input.commandReceipt } : {}),
        coreDb,
        store,
        triggerActor: input.triggerActor,
        requestActor: input.requestActor,
        snapshot,
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
          expect(agentSessionId).toBeNull();
          input.onTurnCreated(created, agentSessionId);
          const checkpoint = listThreadWorkerCheckpoints(db, ws.id, input.threadId)[0]!;
          expect(checkpoint).toMatchObject({
            stage: 'preparing',
            workerSessionId: null,
            stopReason: null,
          });
        },
        turnExecutor,
      });
      return ended.turn;
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
    const coordinator = await store.createTurn(
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
        goalDomain: {
          ...testGoalDomainProposal(scope.workspaceId, scope.goalId),
          scope: {
            ...testGoalDomainProposal(scope.workspaceId, scope.goalId).scope,
            subjects: [{ kind: 'agent', id: selectedAgentId }],
          },
        },
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
        connectionClosures.push(
          new Promise<void>((resolve) => {
            const close = connection.sqlite.close.bind(connection.sqlite);
            vi.spyOn(connection.sqlite, 'close').mockImplementation(() => {
              const result = close();
              resolve();
              return result;
            });
          })
        );
        connections.push(connection);
        return connection;
      },
      inflightCommands: new WeakMap(),
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      goalId: goal.goalId,
      coordinatorTurnId: coordinator.id,
      startWorker,
      ...{ goalTaskPolicy: () => createGoalTaskPolicyService({ coreDb, store, domains }) },
    });
    expect(taskTool.name).toBe('goal.task.dispatch');
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
        agentId: selectedAgentId,
        request,
      },
      { callId: 'task', toolOccurrence: 1, signal: new AbortController().signal }
    );
    if (outcome === 'interrupted') {
      await interruptedNative!.executor.launched.promise;
      const worker = startWorker.mock.calls[0]![0];
      await vi.waitFor(() => {
        expect(
          listSchedulerExecutionAttemptsForTurn(coreDb, {
            workspaceId: worker.workspaceId,
            threadId: worker.threadId,
            turnId: worker.reservedTurnId,
          })
        ).toContainEqual(expect.objectContaining({ phase: 'open', disposition: 'accepted' }));
      });
      await interruptedNative!.executor.interruptTurn(store, worker.reservedTurnId, {
        requestId: worker.requestId,
      });
      await interruptedNative!.executor.execution;
    }
    expect(authorization).toHaveBeenCalledWith(
      coreDb,
      actor,
      ws.id,
      expect.objectContaining({
        mutating: true,
        policyOperation: 'knowledge.read',
      })
    );
    let linked = readGoalView(store, db, goal.goalId);
    if (readDenied) {
      expect(result.isError, JSON.stringify(result)).toBe(true);
      expect(linked.tasks).toEqual([]);
      expect(startWorker).not.toHaveBeenCalled();
      return;
    }
    expect(linked.tasks, JSON.stringify(result)).toHaveLength(1);
    const retrievalTraceRoot = join(
      root,
      'workspaces',
      ws.id,
      'threads',
      linked.tasks[0]!.threadId,
      'retrieval-traces'
    );
    const retrievalTraceFiles = readdirSync(retrievalTraceRoot);
    expect(retrievalTraceFiles).toHaveLength(1);
    expect(retrievalTraceFiles[0]).toMatch(/^krt_.+\.json$/);
    const retrievalTrace = JSON.parse(
      readFileSync(join(retrievalTraceRoot, retrievalTraceFiles[0]!), 'utf8')
    );
    expect(retrievalTrace.queryContext).toMatchObject({
      workspaceId: ws.id,
      threadId: linked.tasks[0]!.threadId,
    });
    expect(retrievalTrace.queryContext).not.toHaveProperty('turnId');
    for (const taskTurn of store.listThreadTurns(ws.id, linked.tasks[0]!.threadId)) {
      expect(
        existsSync(
          join(
            root,
            'workspaces',
            ws.id,
            'threads',
            linked.tasks[0]!.threadId,
            'turns',
            taskTurn.id,
            'retrieval-traces'
          )
        )
      ).toBe(false);
    }
    // Admission returns before detached Worker closeout; join its real connection release.
    await Promise.all(connectionClosures);
    expect(connections.every((connection) => !connection.sqlite.open)).toBe(true);
    linked = readGoalView(store, db, goal.goalId);
    if (
      outcome === 'refused' ||
      outcome === 'recovery-required-refusal' ||
      outcome === 'cancelled'
    ) {
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
            : outcome === 'cancelled'
              ? 'turn_cancelled'
              : 'scheduler_admission_denied',
      });
      // Retained pre-fix timestamps remain usable data but cannot prove a Turn was admitted.
      const retainedBytes = JSON.stringify({ ...task, admittedAt: '2026-09-01T00:00:00.000Z' });
      db.sqlite
        .prepare('UPDATE goal_card_tasks SET payload_json=? WHERE thread_id=?')
        .run(retainedBytes, task.threadId);
      expect(readGoalView(store, db, goal.goalId).tasks).toEqual(linked.tasks);
      const checkpoints = listThreadWorkerCheckpoints(db, ws.id, task.threadId);
      if (outcome === 'cancelled') {
        expect(checkpoints).toEqual([]);
        expect(
          listSchedulerAdmissionEntriesForWorkspace(coreDb, {
            workspaceId: ws.id,
            statuses: ['queued', 'admitted', 'denied', 'cancelled', 'expired'],
          }).find((entry) => entry.threadId === task.threadId)?.status
        ).toBe('cancelled');
        expect(
          listSchedulerExecutionAttemptsByTurnId(
            coreDb,
            startWorker.mock.calls[0]![0].reservedTurnId
          )
        ).toEqual([]);
      } else
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
    expect(startWorker.mock.calls[0]![0].triggerSource).toEqual({
      kind: 'handoff',
      summary: 'Task Worker handoff.',
    });
    expect(linked.tasks).toMatchObject([
      { cardId: card.cardId, cardRevision: 0, planVersionId: plan.planVersionId, missing: false },
    ]);
    expect(linked.tasks[0]!.turns).toMatchObject([
      { status: outcome === 'interrupted' ? 'interrupted' : 'completed' },
    ]);
    const checkpoints = listThreadWorkerCheckpoints(db, ws.id, linked.tasks[0]!.threadId);
    expect(checkpoints).toEqual([]);
    if (outcome === 'interrupted') {
      const launch = interruptedNative!.executor.nativeLineage!;
      expect(launch).toMatchObject({
        workspaceId: ws.id,
        threadId: linked.tasks[0]!.threadId,
        turnId: linked.tasks[0]!.turns[0]!.turnId,
      });
      const terminal = store
        .getTurnEvents(launch.turnId)
        .find((event) => event.event === 'turn.completed');
      expect(terminal).toMatchObject({
        workspaceId: launch.workspaceId,
        threadId: launch.threadId,
        turnId: launch.turnId,
        data: {
          type: 'turn-completed',
          stopReason: 'aborted',
          turn: {
            id: launch.turnId,
            threadId: launch.threadId,
            agentSessionId: launch.agentSessionId,
            status: 'interrupted',
          },
        },
      });
    }
    const admittedTurn = store.listThreadTurns(ws.id, linked.tasks[0]!.threadId)[0]!;
    expect(linked.tasks[0]!.admittedAt).toBe(admittedTurn.startedAt);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      threadId: admittedTurn.threadId,
      turnId: admittedTurn.id,
      admittedAt: admittedTurn.startedAt,
    });
    await store.createTurn(ws.id, admittedTurn.threadId, 'Follow up', {
      kind: 'user',
      id: actor.userId,
    });
    expect(readGoalView(store, db, goal.goalId).tasks[0]!.admittedAt).toBe(admittedTurn.startedAt);
    expect(linked.goal!.disposition).toBeNull();
  } finally {
    if (outcome === 'interrupted') {
      drainingInterruptedPeer = true;
      if (interruptedNative && interruptedNative.executor.launches > 0)
        interruptedNative.executor.completion.resolve();
      // Join entered loops first so any late start is observed before joining start closeout.
      await Promise.allSettled(enteredWorkerLoops);
      await Promise.allSettled(enteredWorkerStarts);
      await Promise.allSettled(connectionClosures);
    }
    loopObservation?.mockRestore();
    authorization.mockRestore();
    interruptedNative?.restore();
    await shutdownControlStoreWorkerClient();
    db.sqlite.close();
    coreDb.sqlite.close();
  }
});

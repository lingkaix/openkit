import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveEntityId } from '@openkit/protocol';
import { afterEach, expect, it } from 'vitest';
import {
  createStructuredWorkerDelegationRequest,
  type StructuredWorkerDelegationRequest,
  serializeStructuredWorkerDelegationRequest,
} from '../internal-agents/delegation.js';
import { FsStore } from '../lib/store.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { testGoalDomainProposal } from '../test-support/goal-domain.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  acceptSchedulerExecutionObservation,
  closeSchedulerExecutionAttemptWithFence,
  markSchedulerExecutionAttemptClosing,
  recordSchedulerExecutionOperation,
  schedulerExecutionCorrelation,
} from './execution-attempt-records.js';
import { executeGoalOperation } from './goal-owner.js';
import { reserveGoalTask } from './goal-task-admission.js';
import { readGoalTaskPolicyContext } from './goal-task-policy-context.js';
import { commandInputHash } from './idempotent-command.js';
import { mcpToolArgumentsContentDigest } from './mcp-tool-schema-snapshots.js';
import { raiseRecordedPendingRequest } from './pending-request-flow.js';
import { readPendingRequest } from './pending-requests.js';
import { clearWorkerCheckpoint, upsertWorkerCheckpoint } from './worker-checkpoints.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Retains a real Goal grant, Task link and scheduler package lineage without Worker effects. */
async function fixture(typed = true, linked = true) {
  const root = mkdtempSync(join(tmpdir(), 'goal-task-policy-'));
  let coreDb = openCoreDb(root);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  let store = new FsStore({ dataRoot: root });
  const workspace = store.createWorkspace('Policy context');
  let db = openWorkspaceDb(root, workspace.id);
  applyScopedMigrations(db);
  cleanups.push(() => {
    db.sqlite.close();
    coreDb.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  const actor = { kind: 'local' as const, userId: 'usr_00000000-0000-7000-8000-000000000001' };
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: actor.userId });
  const human = { actor };
  const goal = (
    await executeGoalOperation(
      'goal.create',
      { workspaceId: workspace.id, requestId: randomUUID(), intent: 'Read an application' },
      human,
      store,
      db
    )
  ).goal!;
  const scope = { workspaceId: workspace.id, threadId: goal.threadId, goalId: goal.goalId };
  const coordinatorTurn = store.createTurn(
    workspace.id,
    goal.threadId,
    'Coordinate',
    {
      kind: 'user',
      id: actor.userId,
    },
    undefined,
    { executorKind: 'coordinator', agentId: 'goal-coordinator' }
  );
  const coordinator = { actor, coordinatorTurnId: coordinatorTurn.id };
  const cards = await executeGoalOperation(
    'goal.card.create',
    { ...scope, requestId: randomUUID(), description: 'Review application', priority: 1 },
    human,
    store,
    db
  );
  const card = cards.cards[0]!;
  const proposed = await executeGoalOperation(
    'goal.plan.propose',
    {
      ...scope,
      requestId: randomUUID(),
      expectedRevision: cards.goal!.changeRevision,
      goalDomain: testGoalDomainProposal(workspace.id, goal.goalId),
      commitment: {
        intentBasis: { revision: 0, intent: goal.intent },
        cards: [{ cardId: card.cardId, revision: 0, description: card.description, priority: 1 }],
        permittedAdjustments: 'Refine the review',
        completionEvidence: ['Reviewed application'],
        boundaries: 'No writes',
      },
    },
    coordinator,
    store,
    db
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
    human,
    store,
    db
  );
  await executeGoalOperation(
    'goal.plan.approve',
    { ...approval, requestId: randomUUID() },
    coordinator,
    store,
    db
  );
  const thread = store.createThread(workspace.id, 'Review', undefined, 'conversation', {
    visibility: 'workspace',
    threadSource: 'worker',
  });
  if (linked)
    db.sqlite.transaction(() =>
      reserveGoalTask(
        store,
        db,
        {
          goalId: goal.goalId,
          cardId: card.cardId,
          planVersionId: plan.planVersionId,
          cardRevision: 0,
          intentRevision: 0,
          withinCurrentIntent: true,
          withinPermittedAdjustments: true,
          rationale: 'Read only',
        },
        thread.id
      )
    )();
  const resource = {
    kind: 'mcp-tool' as const,
    workspaceId: workspace.id,
    serverId: 'sis',
    toolName: 'application.read',
  };
  const resources: StructuredWorkerDelegationRequest['resources'] = [
    { kind: 'external', reference: 'sis/application.read', reason: 'Context only' },
    ...(typed ? [{ kind: 'policy' as const, resource, reason: 'Exact selected Tool' }] : []),
  ];
  const request = createStructuredWorkerDelegationRequest({
    objective: 'Review application',
    acceptanceCriteria: ['The review is complete'],
    contextRefs: [
      { kind: 'workspace', id: workspace.id },
      { kind: 'thread', id: thread.id },
    ],
    resources,
    expectedArtifacts: [],
    constraints: { maxContextTokens: 12_000, maxWorkerIterations: 1 },
    verification: [{ kind: 'manual', description: 'Inspect review' }],
    reviewPolicy: { required: false, reviewers: ['human'], instructions: 'Inspect review' },
    escalationConditions: [],
    reviewContext: null,
  });
  const turnInput = serializeStructuredWorkerDelegationRequest(request);
  const requestId = randomUUID();
  const agentId = 'application-worker';
  const agentSessionId = testEntityId('as', root);
  const turn = store.createTurn(
    workspace.id,
    thread.id,
    turnInput,
    { kind: 'user', id: actor.userId },
    undefined,
    { agentId, agentSessionId, executorKind: 'worker' }
  );
  store.createItem({
    id: deriveEntityId('it', ['task-user', turn.id]),
    workspaceId: workspace.id,
    threadId: thread.id,
    turnId: turn.id,
    type: 'user-message',
    status: 'completed',
    actor: turn.triggerActor,
    text: turnInput,
    createdAt: turn.startedAt!,
    completedAt: turn.startedAt!,
  });
  const admission = createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    queueEntryId: `queue_${requestId}`,
    requestId,
    triggerActor: turn.triggerActor,
    workspaceId: workspace.id,
    threadId: thread.id,
    turnId: turn.id,
    turnInput,
    requestedAgentId: agentId,
  });
  const attempt = recordTestExecutionAttempt(coreDb, {
    entry: admission,
    attemptId: testEntityId('attempt', root),
    agentSessionId,
    inputRef: 'task-package',
    bindingRef: `task-binding:${root}`,
    sessionCompatibilityKey: 'task-context',
    now: () => new Date().toISOString(),
  });
  upsertWorkerCheckpoint(db, {
    workspaceId: workspace.id,
    threadId: thread.id,
    turnId: turn.id,
    requestId,
    requestInputHash: commandInputHash({ input: turnInput }),
    stage: 'running_worker',
    iteration: 0,
    workerSessionId: agentSessionId,
    contextDigest: commandInputHash(request),
  });
  const lineage = {
    workspaceId: workspace.id,
    threadId: thread.id,
    turnId: turn.id,
    agentSessionId,
    packageSnapshotId: 'task-package',
  };
  return {
    get coreDb() {
      return coreDb;
    },
    get db() {
      return db;
    },
    get store() {
      return store;
    },
    lineage,
    scope,
    card,
    plan,
    actor,
    agentId,
    resource,
    admission,
    turnInput,
    read: () => readGoalTaskPolicyContext({ coreDb, store, db, lineage }),
    capture: () => {
      const requestId = randomUUID();
      const requestItemId = testEntityId('it', requestId);
      const args = { applicationId: '123' };
      const captured = raiseRecordedPendingRequest(store, db.sqlite, {
        requestId,
        requestItemId,
        workspaceId: workspace.id,
        threadId: thread.id,
        raisingTurnId: turn.id,
        kind: 'approval',
        requesterKind: 'worker',
        agentId,
        agentSessionId,
        responsibleUserId: actor.userId,
        call: {
          serverId: 'sis',
          toolName: 'application.read',
          catalogRevision: 'catalog-current',
          schemaSnapshotId: 'schema-current',
          canonicalArgumentsJson: JSON.stringify(args),
          argumentsDigest: mcpToolArgumentsContentDigest(args),
          packageDigest: lineage.packageSnapshotId,
          policyDecisionId: null,
          authorizationContext: {
            threadId: thread.id,
            turnId: turn.id,
            agentId,
            agentSessionId,
            responsibleUserId: actor.userId,
            packageDigest: lineage.packageSnapshotId,
            policyDecisionId: null,
          },
        },
        approval: { kind: 'permission', title: 'Read application', description: 'Exact read' },
        now: new Date().toISOString(),
      });
      store.createItem({
        id: requestItemId,
        workspaceId: workspace.id,
        threadId: thread.id,
        turnId: turn.id,
        type: 'approval-request',
        approvalRequestId: requestId,
        kind: 'permission',
        title: 'Read application',
        description: 'Exact read',
        status: 'completed',
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });
      return captured;
    },
    closeSource: () => {
      // Only retained local record owners are exercised; no Worker backend is submitted.
      const operation = recordSchedulerExecutionOperation(coreDb, {
        attemptId: attempt.attemptId,
        operationId: `source:${turn.id}`,
      });
      const correlation = schedulerExecutionCorrelation(operation);
      expect(
        acceptSchedulerExecutionObservation(coreDb, {
          ...correlation,
          disposition: 'accepted',
          execution: 'terminal',
          outcomeRef: `source:${turn.id}:completed`,
          fenceRef: null,
        })
      ).not.toBeNull();
      markSchedulerExecutionAttemptClosing(coreDb, {
        attemptId: attempt.attemptId,
        cause: 'turn-completed',
      });
      closeSchedulerExecutionAttemptWithFence(coreDb, {
        correlation,
        fenceRef: `fence:${turn.id}`,
        proof: {
          terminalHandoff: true,
          output: true,
          evidence: true,
          outsideWorkspaceCollection: true,
          integrationDrain: true,
          routesRevoked: true,
        },
      });
      store.updateTurn(turn.id, { status: 'completed', completedAt: new Date().toISOString() });
    },
    reopen: () => {
      db.sqlite.close();
      coreDb.sqlite.close();
      store = new FsStore({ dataRoot: root });
      coreDb = openCoreDb(root);
      db = openWorkspaceDb(root, workspace.id);
    },
  };
}

it('reads only typed resources from exact retained Task lineage after database reopen', async () => {
  const f = await fixture();
  f.reopen();
  expect(f.read()).toEqual({
    workspaceId: f.lineage.workspaceId,
    goalId: f.scope.goalId,
    taskThreadId: f.lineage.threadId,
    turnId: f.lineage.turnId,
    planVersionId: f.plan.planVersionId,
    agentId: f.agentId,
    responsibleUserId: f.actor.userId,
    resources: [f.resource],
    requestInputHash: f.admission.inputHash,
  });
});

it('keeps identical retained context for a real captured request after source closure and cleanup', async () => {
  const f = await fixture();
  const original = f.read();
  const captured = f.capture();
  f.closeSource();
  expect(f.read()).toEqual(original);
  expect(
    clearWorkerCheckpoint(f.db, f.lineage.workspaceId, f.lineage.threadId, f.lineage.turnId)
  ).toBe(true);
  f.reopen();
  const retained = readPendingRequest(f.db.sqlite, captured.requestId)!;
  expect(retained.state).toBe('pending');
  expect(retained.canonicalArgumentsJson).toBe(captured.canonicalArgumentsJson);
  expect(f.store.getTurnById(retained.raisingTurnId).status).toBe('completed');
  expect(
    readGoalTaskPolicyContext({
      coreDb: f.coreDb,
      store: f.store,
      db: f.db,
      lineage: {
        workspaceId: retained.workspaceId,
        threadId: retained.threadId,
        turnId: retained.raisingTurnId,
        agentSessionId: retained.agentSessionId!,
        packageSnapshotId: retained.packageDigest!,
      },
    })
  ).toEqual(original);
});

it.each([
  'wrong-package',
  'missing-attempt',
  'missing-close-proof',
] as const)('refuses a retained captured source with %s', async (corruption) => {
  const f = await fixture();
  const captured = f.capture();
  if (corruption === 'missing-close-proof') {
    f.store.updateTurn(f.lineage.turnId, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
  } else f.closeSource();
  clearWorkerCheckpoint(f.db, f.lineage.workspaceId, f.lineage.threadId, f.lineage.turnId);
  if (corruption === 'missing-attempt')
    f.coreDb.sqlite
      .prepare('DELETE FROM scheduler_execution_attempts WHERE turn_id=?')
      .run(captured.raisingTurnId);
  expect(() =>
    readGoalTaskPolicyContext({
      coreDb: f.coreDb,
      store: f.store,
      db: f.db,
      lineage: {
        workspaceId: captured.workspaceId,
        threadId: captured.threadId,
        turnId: captured.raisingTurnId,
        agentSessionId: captured.agentSessionId!,
        packageSnapshotId:
          corruption === 'wrong-package' ? 'wrong-package' : captured.packageDigest!,
      },
    })
  ).toThrow();
});

it('gives descriptive references and context selection no Policy authority', async () => {
  const f = await fixture(false);
  expect(f.read()?.resources).toEqual([]);
});

it('returns null for an ordinary Task with no Goal link', async () => {
  const f = await fixture(true, false);
  expect(f.read()).toBeNull();
});

it('keeps a running Task eligible after ordinary card edits', async () => {
  const f = await fixture();
  await executeGoalOperation(
    'goal.card.edit',
    {
      ...f.scope,
      cardId: f.card.cardId,
      expectedRevision: 0,
      requestId: randomUUID(),
      description: 'More precise review',
      priority: 2,
    },
    { actor: f.actor },
    f.store,
    f.db
  );
  expect(f.read()?.resources).toEqual([f.resource]);
});

it.each([
  'agentSessionId',
  'packageSnapshotId',
  'turnId',
  'threadId',
] as const)('refuses a linked Task with wrong %s', async (key) => {
  const f = await fixture();
  expect(() =>
    readGoalTaskPolicyContext({
      coreDb: f.coreDb,
      store: f.store,
      db: f.db,
      lineage: {
        ...f.lineage,
        [key]:
          key === 'turnId'
            ? testEntityId('tu', 'wrong')
            : key === 'threadId'
              ? testEntityId('th', 'wrong')
              : key === 'agentSessionId'
                ? testEntityId('as', 'wrong')
                : 'wrong-package',
      },
    })
  ).toThrow();
});

it.each([
  'missing-attempt',
  'missing-checkpoint',
  'changed-input',
  'wrong-worker',
  'cancelled-card',
  'closed-goal',
  'stale-plan',
  'wrong-link',
] as const)('refuses a linked Task with %s', async (corruption) => {
  const f = await fixture();
  if (corruption === 'missing-attempt')
    f.coreDb.sqlite
      .prepare('DELETE FROM scheduler_execution_attempts WHERE turn_id=?')
      .run(f.lineage.turnId);
  if (corruption === 'missing-checkpoint')
    f.db.sqlite
      .prepare('DELETE FROM worker_turn_checkpoints WHERE turn_id=?')
      .run(f.lineage.turnId);
  if (corruption === 'changed-input')
    f.coreDb.sqlite
      .prepare('UPDATE scheduler_admission_entries SET turn_input=? WHERE turn_id=?')
      .run('{}', f.lineage.turnId);
  if (corruption === 'wrong-worker')
    f.store.updateTurn(f.lineage.turnId, { agentId: 'another-worker' });
  if (corruption === 'cancelled-card')
    f.db.sqlite
      .prepare(
        "UPDATE goal_cards SET payload_json=json_set(payload_json,'$.cancelled',json('true')) WHERE card_id=?"
      )
      .run(f.card.cardId);
  if (corruption === 'closed-goal')
    f.db.sqlite
      .prepare(
        "UPDATE goals SET payload_json=json_set(payload_json,'$.disposition',json(?)) WHERE goal_id=?"
      )
      .run(
        JSON.stringify({
          kind: 'cancelled',
          reason: 'Stop',
          actorId: f.actor.userId,
          at: new Date().toISOString(),
        }),
        f.scope.goalId
      );
  if (corruption === 'stale-plan')
    f.db.sqlite
      .prepare(
        "UPDATE goals SET payload_json=json_set(payload_json,'$.activePlanVersionId',NULL) WHERE goal_id=?"
      )
      .run(f.scope.goalId);
  if (corruption === 'wrong-link')
    f.db.sqlite
      .prepare(
        "UPDATE goal_card_tasks SET payload_json=json_set(payload_json,'$.threadId',?) WHERE thread_id=?"
      )
      .run(testEntityId('th', 'wrong'), f.lineage.threadId);
  expect(() => f.read()).toThrow();
});

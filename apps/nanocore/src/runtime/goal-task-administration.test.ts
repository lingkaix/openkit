import { randomUUID } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allocateEntityId,
  deriveEntityId,
  PolicyPermissionV1Schema,
  PROTOCOL_VERSION,
} from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listServerAuditEvents } from '../audit-events.js';
import { ensureLocalUser } from '../auth/identity.js';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import {
  createStructuredWorkerDelegationRequest,
  serializeStructuredWorkerDelegationRequest,
} from '../internal-agents/delegation.js';
import { FsStore } from '../lib/store.js';
import { createOperationInvocation } from '../operation-composition.js';
import { createGoalDomainPolicyService } from '../policy/goal-domains.js';
import { createGoalTaskPolicyService } from '../policy/goal-task-policy.js';
import { listServerPermissionDecisions } from '../policy/permission-decisions.js';
import { EMPTY_POLICY_DOCUMENT, policyDigest } from '../policy/statements.js';
import { evaluateWorkspaceMemberAccess } from '../policy/workspace-access.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import {
  openCoreDb,
  openWorkspaceDb,
  openWorkspaceDbAtRoot,
  type WorkspaceDb,
} from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { loadWorkspaceFileRecords } from '../storage/workspace-file-records.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { createGoalTools } from './goal-coordinator.js';
import { executeGoalOperation } from './goal-owner.js';
import { reserveGoalTask } from './goal-task-admission.js';
import { readGoalTaskPolicyContext } from './goal-task-policy-context.js';
import { commandInputHash } from './idempotent-command.js';
import { listThreadPendingRequests, readPendingRequest } from './pending-requests.js';
import { recordTaskTerminalFact } from './task-terminal-fact.js';
import { upsertWorkerCheckpoint } from './worker-checkpoints.js';

/** Rebuilds a stopped private fixture through native history admission, without claiming a live Worker outcome. */
async function retainCompletedTaskFixture(
  store: FsStore,
  db: WorkspaceDb,
  turnId: string,
  closeSession = true
): Promise<void> {
  await shutdownControlStoreWorkerClient();
  const dataRoot = store.getDataRoot()!;
  const records = loadWorkspaceFileRecords(dataRoot).find(
    (entry) => entry.workspace.id === db.workspaceId
  )!;
  const original = records.turns.find((turn) => turn.id === turnId)!;
  const completedAt = new Date().toISOString();
  const historical = {
    ...original,
    status: 'completed' as const,
    completedAt,
    durationMs: original.startedAt
      ? Math.max(0, Date.parse(completedAt) - Date.parse(original.startedAt))
      : original.durationMs,
  };
  // These are the existing Goal/Pending owners' exact retained dependencies, not execution proof.
  const dependencies = [
    'goals',
    'goal_cards',
    'goal_plan_versions',
    'goal_card_tasks',
    'task_turn_terminal_facts',
    'pending_requests',
    'worker_turn_checkpoints',
    'idempotency_requests',
    'audit_events',
  ].map((table) => ({
    table,
    rows: db.sqlite.prepare(`SELECT * FROM ${table}`).all() as Record<
      string,
      string | number | bigint | Buffer | null
    >[],
  }));
  const defaultKnowledgeBaseId = readDefaultKnowledgeBaseId({
    dataRoot,
    scope: { kind: 'workspace', workspaceId: db.workspaceId },
  });
  const workspaceRoot = join(dataRoot, 'workspaces', db.workspaceId);
  const retainedRoot = join(dataRoot, `.fixture-history-${randomUUID()}`);
  db.sqlite.close();
  renameSync(workspaceRoot, retainedRoot);
  try {
    await store.importWorkspaceSnapshot({
      ...records,
      defaultKnowledgeBaseId,
      turns: records.turns.map((turn) => (turn.id === turnId ? historical : turn)),
      agentSessions: records.agentSessions.map((session) =>
        closeSession && session.id === original.agentSessionId
          ? { ...session, status: 'closed' as const, updatedAt: completedAt }
          : session
      ),
      turnEvents: records.streamEvents.map(
        ([id, events]) =>
          [
            id,
            id === turnId
              ? [
                  ...events,
                  {
                    protocolVersion: PROTOCOL_VERSION,
                    workspaceId: db.workspaceId,
                    threadId: original.threadId,
                    turnId,
                    requestId: null,
                    sequence: (events.at(-1)?.sequence ?? 0) + 1,
                    timestamp: completedAt,
                    event: 'turn.completed',
                    data: { type: 'turn-completed', stopReason: 'completed', turn: historical },
                  },
                ]
              : events,
          ] as const
      ),
      initialNotebookFiles: Object.fromEntries(
        records.knowledge.map((page) => [page.path, page.content])
      ),
      notebookInitialization: {
        requestId: randomUUID(),
        producer: original.triggerActor,
        instructionReference: 'test:retained-goal-task-history',
      },
      stageWorkspace: (stage) => {
        // Replace the initializer's private Notebook before copying retained read-only Git objects.
        rmSync(join(stage.workspaceRoot, 'knowledge'), { recursive: true, force: true });
        for (const name of readdirSync(retainedRoot))
          if (name !== 'db')
            cpSync(join(retainedRoot, name), join(stage.workspaceRoot, name), { recursive: true });
      },
      finalizeNativeWorkspace: (stage) => {
        const target = openWorkspaceDbAtRoot({ dataRoot, ...stage });
        try {
          target.sqlite.transaction(() => {
            for (const { table, rows } of dependencies) {
              target.sqlite.prepare(`DELETE FROM ${table}`).run();
              for (const row of rows) {
                const columns = Object.keys(row);
                target.sqlite
                  .prepare(
                    `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`
                  )
                  .run(...Object.values(row));
              }
            }
            recordTaskTerminalFact(target, historical);
          })();
        } finally {
          target.sqlite.close();
        }
      },
    });
  } catch (error) {
    rmSync(workspaceRoot, { recursive: true, force: true });
    renameSync(retainedRoot, workspaceRoot);
    Object.assign(db, openWorkspaceDb(dataRoot, db.workspaceId));
    throw error;
  }
  // Keep every existing fixture consumer on the newly admitted owning handle.
  Object.assign(db, openWorkspaceDb(dataRoot, db.workspaceId));
  rmSync(retainedRoot, { recursive: true, force: true });
}

const cleanups: (() => void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await shutdownControlStoreWorkerClient();
  for (const close of cleanups.splice(0).reverse()) await close();
});

/** Real owners below the Worker dispatcher; no backend execution or MCP routing is claimed. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'goal-admin-tool-'));
  const coreDb = openCoreDb(root);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const actor = { kind: 'local' as const, userId };
  const store = new FsStore({ dataRoot: root });
  const workspace = await store.createWorkspace('Coordinator Policy Tool');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const db = openWorkspaceDb(root, workspace.id);
  applyScopedMigrations(db);
  cleanups.push(() => {
    db.sqlite.close();
    coreDb.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'config'), { recursive: true });
  const path = join(root, 'config/server.jsonc');
  writeFileSync(path, JSON.stringify({ schemaVersion: 1 }));
  const manager = createRuntimeConfigManager({ dataRoot: root });
  const files = new RuntimeConfigFileService({
    dataRoot: root,
    userId,
    workspaceIds: [workspace.id],
    runtimeConfigManager: manager,
    readRuntimeConfigStatus: () => manager.status(),
  });
  const reload = vi.fn(() => manager.reload({ mode: 'safe', dryRun: false }));
  const domains = createGoalDomainPolicyService({
    coreDb,
    store,
    files,
    reload,
    currentPolicy: () => manager.current().openKitConfig.policy?.mediation,
    repositoryWorkspaceDb: () => db,
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
  const coordinator = await store.createTurn(
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
    { ...scope, requestId: randomUUID(), description: 'Read the issue', priority: 1 },
    { actor },
    store,
    db,
    services
  );
  const card = cards.cards[0]!;
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
        cards: [{ cardId: card.cardId, revision: 0, description: card.description, priority: 1 }],
        permittedAdjustments: 'Refine the read method',
        completionEvidence: ['Issue read'],
        boundaries: 'No writes',
      },
      goalDomain: {
        id: 'approved-issue-domain',
        scope: {
          subjects: [{ kind: 'agent', id: 'issue-worker' }],
          actions: ['tool.use'],
          resources: [resource],
        },
        lifetime: {
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
  for (const context of [{ actor }, coordinatorContext])
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

  const requestId = randomUUID();
  const thread = await store.createThread(
    workspace.id,
    'Selected Task',
    deriveEntityId('th', ['task', requestId]),
    'conversation',
    { visibility: 'workspace', threadSource: 'worker' }
  );
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
        rationale: 'Read the issue',
      },
      thread.id
    )
  )();
  // The request mentions the Tool in prose but has no typed resource association.
  const request = createStructuredWorkerDelegationRequest({
    objective: 'Read issues/read in this Workspace',
    acceptanceCriteria: ['Issue read'],
    contextRefs: [
      { kind: 'workspace', id: workspace.id },
      { kind: 'thread', id: thread.id },
    ],
    resources: [],
    expectedArtifacts: [],
    constraints: { maxContextTokens: 1000, maxWorkerIterations: 1 },
    verification: [{ kind: 'manual', description: 'Inspect the issue' }],
    reviewPolicy: { required: false, reviewers: ['human'], instructions: 'Inspect the issue' },
    escalationConditions: [],
    reviewContext: null,
  });
  const turnInput = serializeStructuredWorkerDelegationRequest(request);
  const agentSessionId = allocateEntityId('as');
  const fixtureSessionStartedAt216 = new Date().toISOString();
  await store.createAgentSession({
    id: agentSessionId,
    agentId: 'issue-worker',
    workspaceId: workspace.id,
    threadId: thread.id,
    status: 'busy',
    message: null,
    createdAt: fixtureSessionStartedAt216,
    updatedAt: fixtureSessionStartedAt216,
  });
  const turn = await store.createTurn(
    workspace.id,
    thread.id,
    turnInput,
    { kind: 'user', id: userId },
    null,
    {
      startedAt: fixtureSessionStartedAt216,
      executorKind: 'worker',
      agentId: 'issue-worker',
      agentSessionId,
      turnId: deriveEntityId('tu', {
        command: 'task.start',
        actorId: userId,
        workspaceId: workspace.id,
        threadId: thread.id,
        requestId,
      }),
    }
  );
  await store.createItem({
    id: deriveEntityId('it', ['task-user', turn.id]),
    owner: { kind: 'workspace', workspaceId: workspace.id },
    threadId: thread.id,
    turnId: turn.id,
    type: 'user-message',
    status: 'completed',
    actor: turn.triggerActor,
    text: turnInput,
    createdAt: turn.startedAt!,
    completedAt: turn.startedAt!,
  });
  const entry = createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    queueEntryId: `queue_${requestId}`,
    requestId,
    triggerActor: turn.triggerActor,
    workspaceId: workspace.id,
    threadId: thread.id,
    turnId: turn.id,
    turnInput,
    requestedAgentId: 'issue-worker',
  });
  const attempt = recordTestExecutionAttempt(coreDb, {
    entry,
    attemptId: allocateEntityId('attempt'),
    agentSessionId,
    inputRef: 'selected-task-package',
    bindingRef: `selected-binding:${requestId}`,
    sessionCompatibilityKey: 'issue-read',
    now: () => new Date().toISOString(),
  });
  await upsertWorkerCheckpoint(db, {
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
    packageSnapshotId: attempt.inputRef!,
  };
  const context = () => readGoalTaskPolicyContext({ coreDb, store, db, lineage });
  const tasks = createGoalTaskPolicyService({ coreDb, store, domains });
  const effect = {
    workspaceDb: db,
    lineage,
    operation: 'tool.use',
    resource,
    subject: {
      principal: { kind: 'agent' as const, id: 'issue-worker' },
      onBehalfOf: null,
      actor: { kind: 'agent' as const, id: 'issue-worker', responsibleUserId: userId },
      process: { workspaceId: workspace.id, threadId: thread.id, turnId: turn.id },
      credentialKind: 'worker-package' as const,
      responsibleHumanId: userId,
    },
    humanKernel: evaluateWorkspaceMemberAccess({ operation: 'tool.use' }),
  };
  const input = {
    taskThreadId: thread.id,
    expectedPolicyRevision: services.goalDomain.currentRevision(),
    grant: {
      id: 'selected-task-read',
      scope: {
        subjects: [{ kind: 'agent' as const, id: 'issue-worker' }],
        actions: ['tool.use'],
        resources: [resource],
      },
      lifetime: {
        anchor: {
          owner: { kind: 'workspace' as const, workspaceId: workspace.id },
          kind: 'thread',
          id: thread.id,
        },
      },
      rationale: 'Read the issue for this assigned Task',
    },
  };
  const invoke = createOperationInvocation({
    coreDb,
    store,
    repositoryWorkspaceDb: () => db,
    goalServices: services,
    workspaceMutationAdmission: new WorkspaceMutationAdmission(),
  });
  const toolsFor = (goalId = goal.goalId, turnId = coordinator.id) =>
    createGoalTools({
      store,
      db,
      actor,
      goalId,
      turnId,
      services,
      invoke,
    });
  const pending = () => listThreadPendingRequests(db.sqlite, workspace.id, goal.threadId);
  function healthy() {
    expect(readPendingRequest(db.sqlite, plan.pendingRequestId)).toMatchObject({
      state: 'resolved',
      resolution: 'granted',
      claim: 'finished',
      disposition: 'approved-executed',
    });
    expect(domains.read(scope)?.id).toBe('approved-issue-domain');
    expect(context()).toMatchObject({
      taskThreadId: thread.id,
      turnId: turn.id,
      agentId: 'issue-worker',
      resources: [],
    });
    expect(store.getTurnById(coordinator.id).status).toBe('running');
    expect(tasks.evaluateTask(effect)).toMatchObject({
      inGoalEnvelope: true,
      kernel: { effect: 'deny' },
    });
  }
  return {
    root,
    coreDb,
    db,
    store,
    actor,
    workspace,
    path,
    manager,
    files,
    reload,
    domains,
    tasks,
    effect,
    goal,
    scope,
    coordinator,
    turn,
    lineage,
    attempt,
    context,
    input,
    toolsFor,
    pending,
    healthy,
    services,
  };
}

/** Availability is checked before refusal assertions so an absent Tool can never pass them. */
function policyTool(tools: ReturnType<typeof createGoalTools>) {
  const tool = tools.find((entry) => entry.name === 'policy.write');
  expect(tool, 'the fixed Goal Coordinator Tool set must expose native policy.write').toBeDefined();
  return tool!;
}

const callContext = {
  callId: 'native-policy-write',
  toolOccurrence: 1,
  signal: new AbortController().signal,
};

describe('Goal Coordinator native Task Policy administration', () => {
  it('establishes real current approval, Task lineage and a missing typed grant before Tool invocation', async () => {
    const f = await fixture();
    f.healthy();
    expect(f.coordinator.id).not.toBe(f.lineage.turnId);
    expect(f.pending()).toHaveLength(1);
  });

  it('exposes only bounded model arguments on the fixed canonical policy.write Tool', async () => {
    const f = await fixture();
    f.healthy();
    const tool = policyTool(f.toolsFor());
    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: expect.arrayContaining(['taskThreadId', 'expectedPolicyRevision', 'grant']),
    });
    expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual([
      'expectedPolicyRevision',
      'grant',
      'taskThreadId',
    ]);
    expect(f.toolsFor().filter((entry) => entry.name === 'policy.write')).toHaveLength(1);
  });

  it('binds actual Coordinator and selected Worker lineage and publishes an admitted allow without another human approval', async () => {
    const f = await fixture();
    f.healthy();
    const tool = policyTool(f.toolsFor());
    const administer = vi.spyOn(f.domains, 'administer');
    const writes = vi.spyOn(f.files, 'updateFile');
    const pending = f.pending();
    const decisions = listServerPermissionDecisions(f.coreDb).length;
    const response = await tool.execute(f.input, callContext);
    expect(response.isError).not.toBe(true);
    const result = JSON.parse(response.content[0]!.text!);
    expect(administer).toHaveBeenCalledExactlyOnceWith({
      workspaceDb: f.db,
      goalId: f.goal.goalId,
      coordinatorTurnId: f.coordinator.id,
      taskLineage: f.lineage,
      expectedPolicyRevision: f.input.expectedPolicyRevision,
      grant: f.input.grant,
    });
    expect(PolicyPermissionV1Schema.parse(result.statement)).toMatchObject({
      id: f.input.grant.id,
      effect: 'allow',
      author: { kind: 'agent', id: 'goal-coordinator' },
      authority: { kind: 'delegation', statement: { id: 'approved-issue-domain' } },
      scope: f.input.grant.scope,
      lifetime: f.input.grant.lifetime,
    });
    const current = f.manager.current().openKitConfig.policy!.mediation!;
    expect(result.policyRevision).toBe(policyDigest(current));
    expect(current.statements).toContainEqual(result.statement);
    expect(f.domains.readPermissions({ context: f.context()! })).toContainEqual(result.statement);
    expect(f.tasks.evaluateTask(f.effect)?.kernel.effect).toBe('allow');
    expect(f.context()!.resources).toEqual([]);
    expect(writes).toHaveBeenCalledTimes(1);
    const decision = listServerPermissionDecisions(f.coreDb).at(-1)!;
    expect(listServerPermissionDecisions(f.coreDb)).toHaveLength(decisions + 1);
    expect(decision).toMatchObject({
      result: 'allow',
      contextSummary: { operation: 'policy.write' },
    });
    expect(
      listServerAuditEvents(f.coreDb).find(
        (event) => event.permissionDecisionId === decision.decisionId
      )
    ).toMatchObject({
      actor: { kind: 'agent', id: 'goal-coordinator', responsibleUserId: f.actor.userId },
    });
    expect(f.pending()).toEqual(pending);
  });

  it.each([
    'stale-revision',
    'wrong-goal',
    'ended-task',
    'ended-coordinator',
    'outside-envelope',
    'missing-package',
    'forged-lineage',
    'human-proposal',
  ] as const)('refuses %s with no Policy write, reload or extra human approval', async (reason) => {
    const f = await fixture();
    f.healthy();
    let tools = f.toolsFor();
    let value: unknown = f.input;
    if (reason === 'wrong-goal') {
      const other = (
        await executeGoalOperation(
          'goal.create',
          {
            workspaceId: f.workspace.id,
            requestId: randomUUID(),
            intent: 'An unrelated Goal',
          },
          { actor: f.actor },
          f.store,
          f.db,
          f.services
        )
      ).goal!;
      const otherTurn = await f.store.createTurn(
        f.workspace.id,
        other.threadId,
        'Coordinate the other Goal',
        { kind: 'user', id: f.actor.userId },
        null,
        { executorKind: 'coordinator', agentId: 'goal-coordinator' }
      );
      tools = f.toolsFor(other.goalId, otherTurn.id);
    }
    const tool = policyTool(tools);
    if (reason === 'stale-revision')
      value = { ...f.input, expectedPolicyRevision: policyDigest(EMPTY_POLICY_DOCUMENT) };
    if (reason === 'ended-task') await retainCompletedTaskFixture(f.store, f.db, f.turn.id, false);
    if (reason === 'ended-coordinator')
      await f.store.updateTurn(f.coordinator.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
    if (reason === 'outside-envelope')
      value = {
        ...f.input,
        grant: {
          ...f.input.grant,
          scope: {
            ...f.input.grant.scope,
            resources: [{ ...f.effect.resource, toolName: 'delete' }],
          },
        },
      };
    if (reason === 'missing-package')
      f.coreDb.sqlite
        .prepare('DELETE FROM scheduler_execution_attempts WHERE attempt_id=?')
        .run(f.attempt.attemptId);
    if (reason === 'forged-lineage')
      value = {
        ...f.input,
        goalId: f.goal.goalId,
        workspaceId: f.workspace.id,
        turnId: f.turn.id,
        actor: f.actor,
        taskLineage: f.lineage,
      };
    if (reason === 'human-proposal')
      value = {
        schemaVersion: 1,
        proposer: { kind: 'human', id: f.actor.userId },
        rationale: 'Replace Policy',
        baseRevision: f.input.expectedPolicyRevision,
        proposed: { schemaVersion: 1, statements: [] },
        validation: 'valid',
      };
    const bytes = readFileSync(f.path, 'utf8');
    const pending = f.pending();
    const writes = vi.spyOn(f.files, 'updateFile');
    const reloads = f.reload.mock.calls.length;
    const result = await tool.execute(value, callContext);
    expect(result.isError).toBe(true);
    expect(readFileSync(f.path, 'utf8')).toBe(bytes);
    expect(writes).not.toHaveBeenCalled();
    expect(f.reload).toHaveBeenCalledTimes(reloads);
    expect(f.pending()).toEqual(pending);
  });
});

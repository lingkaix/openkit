import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { deriveEntityId } from '@openkit/protocol';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from '../config/runtime-config.js';
import { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import {
  createStructuredWorkerDelegationRequest,
  serializeStructuredWorkerDelegationRequest,
} from '../internal-agents/delegation.js';
import { FsStore } from '../lib/store.js';
import { createGoalDomainPolicyService } from '../policy/goal-domains.js';
import { createGoalTaskPolicyService } from '../policy/goal-task-policy.js';
import { PolicyInterception } from '../policy/interception.js';
import {
  listExportableWorkspacePermissionDecisions,
  readPolicyStatementUseCount,
} from '../policy/permission-decisions.js';
import { EMPTY_POLICY_DOCUMENT, policyDigest } from '../policy/statements.js';
import { closeRetrievalServices } from '../retrieval-service.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { registerWorkerMcpRoutes, reviewCapturedMcpPolicy } from '../worker-mcp-routes.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { recordAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import {
  acceptSchedulerExecutionObservation,
  schedulerExecutionCorrelation,
} from './execution-attempt-records.js';
import { executeGoalOperation, readGoalView } from './goal-owner.js';
import { reserveGoalTask } from './goal-task-admission.js';
import { readGoalTaskPolicyContext } from './goal-task-policy-context.js';
import { commandInputHash } from './idempotent-command.js';
import { listThreadPendingRequests } from './pending-requests.js';
import { createCoordinatorTaskTool } from './task-admission.js';
import { upsertWorkerCheckpoint } from './worker-checkpoints.js';
import type { WorkerControlGateway } from './worker-control-gateway.js';
import type { WorkerMcpGateway } from './worker-mcp-gateway.js';

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
  const setupMcp = async () => {
    const requestId = randomUUID();
    const thread = store.createThread(
      workspace.id,
      'Issue Task',
      deriveEntityId('th', ['task', requestId]),
      'conversation',
      { visibility: 'workspace', threadSource: 'worker' }
    );
    db.sqlite.transaction(() =>
      reserveGoalTask(store, db, { ...dispatchInput, goalId: goal.goalId }, thread.id)
    )();
    const prompt = serializeStructuredWorkerDelegationRequest(request);
    const agentSessionId = testEntityId('as', requestId);
    const turn = store.createTurn(
      workspace.id,
      thread.id,
      prompt,
      { kind: 'user', id: userId },
      null,
      {
        executorKind: 'worker',
        agentId,
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
    store.createItem({
      id: deriveEntityId('it', ['task-user', turn.id]),
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      type: 'user-message',
      status: 'completed',
      actor: turn.triggerActor,
      text: prompt,
      createdAt: turn.startedAt!,
      completedAt: turn.startedAt!,
    });
    store.createAgentSession({
      id: agentSessionId,
      agentId,
      workspaceId: workspace.id,
      threadId: thread.id,
      status: 'busy',
      message: null,
      createdAt: turn.startedAt!,
      updatedAt: turn.startedAt!,
    });
    const catalog = {
      schemaVersion: 1 as const,
      servers: [
        {
          id: 'issues',
          enabled: true,
          credentialBindings: [],
          allowedTools: ['read'],
          deniedTools: [],
          approvalRequiredTools: options.approval ? ['read'] : [],
          schemaPolicy: 'tracking' as const,
          pinnedSchemaSnapshotId: null,
          timeoutMs: 2000,
          transport: { kind: 'http' as const, endpoint: 'https://issues.invalid/mcp' },
        },
      ],
    };
    const environmentPackage = resolveAgentEnvironmentPackage({
      captureCoverage: { scope: 'server', value: 'off' },
      agentSessionId,
      agentSetup: createTestAgentSetup({ agentId, mcpIds: ['issues'] }),
      backend: { kind: 'openshell' },
      createdAt: new Date().toISOString(),
      requestId,
      triggerActor: turn.triggerActor,
      turn,
      workspaceCwd: '/workspace',
      workspaceRoots: [],
      workspaceMcpServerCatalog: catalog,
    });
    const entry = createSchedulerAdmissionEntry(coreDb, {
      backendId: 'nanohost',
      queueEntryId: `queue_${requestId}`,
      requestId,
      triggerActor: turn.triggerActor,
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      turnInput: prompt,
      requestedAgentId: agentId,
    });
    const attempt = recordTestExecutionAttempt(coreDb, {
      entry,
      attemptId: testEntityId('attempt', requestId),
      agentSessionId,
      inputRef: environmentPackage.snapshotId,
      bindingRef: `binding_${requestId}`,
      sessionCompatibilityKey: 'fixture',
      now: () => new Date().toISOString(),
      operationId: `operation_${requestId}`,
    });
    expect(
      acceptSchedulerExecutionObservation(coreDb, {
        ...schedulerExecutionCorrelation(attempt),
        disposition: 'accepted',
        execution: 'running',
        fenceRef: null,
        outcomeRef: null,
      })?.disposition
    ).toBe('accepted');
    upsertWorkerCheckpoint(db, {
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      requestId,
      requestInputHash: commandInputHash({ input: prompt }),
      stage: 'running_worker',
      iteration: 0,
      workerSessionId: agentSessionId,
      contextDigest: commandInputHash(request),
    });
    recordAgentEnvironmentPackageSnapshot(db, {
      environmentPackage,
      createdAt: new Date().toISOString(),
    });
    expect(
      readGoalTaskPolicyContext({
        coreDb,
        store,
        db,
        lineage: { ...environmentPackage.scope, packageSnapshotId: environmentPackage.snapshotId },
      })
    ).toMatchObject({
      goalId: goal.goalId,
      agentId,
      resources: options.taskGrant === false ? [] : [resource],
    });
    const gateway: WorkerMcpGateway = {
      listTools: vi.fn(async () => ({
        serverVersion: 'fixture',
        tools: [
          {
            name: 'read',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
        ],
      })),
      callTool: vi.fn(async () => ({
        content: [{ type: 'text' as const, text: 'ISSUE_RESULT_CANARY' }],
      })),
      close: vi.fn(async () => {}),
      closeServer: vi.fn(async () => {}),
      closeServerIfIdle: vi.fn(async () => {}),
      closeWorkspace: vi.fn(async () => {}),
      getServerHealth: () => 'ready',
    };
    const app = new Hono();
    const interception = new PolicyInterception();
    const routes = {
      app,
      coreDb,
      store,
      interception,
      goalTaskPolicy,
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      workerControlGateway: {
        authenticatePackageToken: () => environmentPackage,
      } as unknown as WorkerControlGateway,
      workerMcpGateway: gateway,
      runtimeConfig: () =>
        createInMemoryRuntimeConfigSnapshot({
          dataRoot,
          agentManifests: [],
          openKitConfig: manager.current().openKitConfig,
          workspaceMcpServerCatalogs: [
            { catalog, workspaceId: workspace.id, path: join(dataRoot, 'catalog.json') },
          ],
        }),
    };
    registerWorkerMcpRoutes(routes);
    const client = new Client({ name: 'goal-consumer', version: '1' });
    cleanup.push(async () => {
      await client.close();
      await gateway.close();
    });
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL('http://nanocore.test/api/worker-capabilities/mcp/issues'),
        {
          fetch: (input, init) => app.fetch(new Request(input, init)),
          requestInit: { headers: { authorization: 'Bearer synthetic-worker-package' } },
        }
      )
    );
    await client.listTools();
    const call = () => client.callTool({ name: 'read', arguments: {} });
    const decisions = () =>
      listExportableWorkspacePermissionDecisions(db, workspace.id).filter(
        (row) => row.mediation?.role === 'final'
      );
    return { client, gateway, call, decisions, turn, routes, catalog, interception };
  };
  return { coreDb, db, store, actor, scope, domain, domains, plan, agentId, dispatch, setupMcp };
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

  it('blocks a linked live effect without current Goal authority before contacting upstream', async () => {
    const f = await fixture({ publish: false });
    const mcp = await f.setupMcp();
    await expect(mcp.call()).rejects.toMatchObject({ data: { code: 'mcp-denied' } });
    expect(mcp.gateway.callTool).not.toHaveBeenCalled();
  });

  it('delivers its own last finite use and refuses the next effect with truthful agent decisions', async () => {
    const f = await fixture({ uses: 1 });
    const mcp = await f.setupMcp();
    expect(await mcp.call()).toMatchObject({ content: [{ text: 'ISSUE_RESULT_CANARY' }] });
    expect(mcp.decisions().at(-1)).toMatchObject({
      result: 'allow',
      mediation: {
        subject: {
          principal: { kind: 'agent', id: f.agentId },
          responsibleHumanId: f.actor.userId,
        },
      },
    });
    expect(
      readPolicyStatementUseCount(f.db, { id: f.domain!.id, digest: policyDigest(f.domain) })
    ).toBe(1);
    await expect(mcp.call()).rejects.toMatchObject({ data: { code: 'mcp-denied' } });
    expect(mcp.gateway.callTool).toHaveBeenCalledTimes(1);
    expect(
      readPolicyStatementUseCount(f.db, { id: f.domain!.id, digest: policyDigest(f.domain) })
    ).toBe(1);
  });

  it('withholds an upstream result after the Goal closes during the effect', async () => {
    const f = await fixture();
    const mcp = await f.setupMcp();
    let release!: () => void;
    let entered!: () => void;
    const upstreamEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(mcp.gateway.callTool).mockImplementationOnce(async () => {
      entered();
      await hold;
      return { content: [{ type: 'text', text: 'ISSUE_RESULT_CANARY' }] };
    });
    const result = mcp.call();
    const assertion = expect(result).rejects.toMatchObject({ data: { code: 'mcp-policy-stale' } });
    await upstreamEntered;
    await executeGoalOperation(
      'goal.cancel',
      {
        ...f.scope,
        requestId: randomUUID(),
        expectedRevision: readGoalView(f.store, f.db, f.scope.goalId).goal!.changeRevision,
        reason: 'Withdraw current Goal authority',
      },
      { actor: f.actor },
      f.store,
      f.db,
      { coreDb: f.coreDb }
    );
    release();
    await assertion;
    expect(mcp.gateway.callTool).toHaveBeenCalledTimes(1);
  });

  it('invalidates a captured human response when Goal authority ends without a Policy revision change', async () => {
    const f = await fixture({ approval: true });
    const mcp = await f.setupMcp();
    expect(await mcp.call()).toMatchObject({
      isError: true,
      structuredContent: { status: 'pending-approval' },
    });
    const record = listThreadPendingRequests(
      f.db.sqlite,
      f.scope.workspaceId,
      mcp.turn.threadId
    )[0]!;
    expect(record.policyDecisionId).toBeTruthy();
    const review = () =>
      reviewCapturedMcpPolicy({
        record,
        actor: f.actor,
        workspaceDb: f.db,
        routes: mcp.routes,
        catalog: mcp.catalog,
        interception: mcp.interception,
      });
    expect(await review()).not.toBeNull();
    await executeGoalOperation(
      'goal.cancel',
      {
        ...f.scope,
        requestId: randomUUID(),
        expectedRevision: readGoalView(f.store, f.db, f.scope.goalId).goal!.changeRevision,
        reason: 'End Goal',
      },
      { actor: f.actor },
      f.store,
      f.db,
      { coreDb: f.coreDb }
    );
    expect(await review()).toBeNull();
    expect(mcp.gateway.callTool).not.toHaveBeenCalled();
  });
});

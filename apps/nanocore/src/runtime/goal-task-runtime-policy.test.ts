import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { parseWorkspaceMcpServerCatalog } from '@openkit/config-schema';
import { allocateEntityId, deriveEntityId } from '@openkit/protocol';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectAgentCatalogEntries } from '../agents/catalog-projection.js';
import { listWorkspaceAuditEvents } from '../audit-events.js';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import type { Actor } from '../auth/identity.js';
import type { AuthVariables } from '../auth/middleware.js';
import { listWorkspaceCapabilityCalls } from '../capability/usage-ledger.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from '../config/runtime-config.js';
import { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import {
  createStructuredWorkerDelegationRequest,
  serializeStructuredWorkerDelegationRequest,
} from '../internal-agents/delegation.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { FsStore } from '../lib/store.js';
import { createOperationInvocation } from '../operation-composition.js';
import { createGoalDomainPolicyService } from '../policy/goal-domains.js';
import { createGoalTaskPolicyService } from '../policy/goal-task-policy.js';
import { PolicyInterception } from '../policy/interception.js';
import {
  listExportableWorkspacePermissionDecisions,
  readPolicyStatementUseCount,
} from '../policy/permission-decisions.js';
import { EMPTY_POLICY_DOCUMENT, policyDigest } from '../policy/statements.js';
import { ProviderRegistry } from '../providers/registry.js';
import { closeRetrievalServices } from '../retrieval-service.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { admitTestMcpApproval } from '../test-support/mcp-tool-policy.js';
import {
  admitTestNativeEnvironment,
  recordTestNativeRuntimeTarget,
} from '../test-support/native-environment.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { registerWorkerMcpRoutes, reviewCapturedMcpPolicy } from '../worker-mcp-routes.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import {
  listExportableAgentEnvironmentPackageSnapshots,
  recordAgentEnvironmentPackageSnapshot,
} from './aep-snapshot-ledger.js';
import {
  admitCapturedPendingCall,
  evaluateCapturedPendingCall,
  executeCapturedPendingCall,
  type PreparedCapturedPendingCall,
  prepareCapturedPendingCall,
} from './captured-pending-call.js';
import {
  acceptSchedulerExecutionObservation,
  closeSchedulerExecutionAttemptWithFence,
  markSchedulerExecutionAttemptClosing,
  recordSchedulerExecutionOperation,
  schedulerExecutionCorrelation,
} from './execution-attempt-records.js';
import { createGoalCoordinator } from './goal-coordinator.js';
import { executeGoalOperation, readGoalView } from './goal-owner.js';
import { reserveGoalTask } from './goal-task-admission.js';
import { readGoalTaskPolicyContext } from './goal-task-policy-context.js';
import { commandInputHash } from './idempotent-command.js';
import { TurnStartValidationError } from './orchestrator.js';
import { respondRecordedApproval } from './pending-request-flow.js';
import {
  executionCallIdForRequest,
  listThreadPendingRequests,
  readPendingRequest,
  validateCanonicalLoad,
} from './pending-requests.js';
import { startProductTurn } from './product-turn-start.js';
import { createCoordinatorTaskTool } from './task-admission.js';
import {
  clearWorkerCheckpoint,
  listExportableWorkerCheckpoints,
  listThreadWorkerCheckpoints,
  upsertWorkerCheckpoint,
} from './worker-checkpoints.js';
import type { WorkerControlGateway } from './worker-control-gateway.js';
import type { WorkerMcpGateway } from './worker-mcp-gateway.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  await closeRetrievalServices();
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** Composes the real Goal/Pending writer and admitted Policy owner before any Task or transport. */
async function fixture(
  options: {
    uses?: number;
    publish?: boolean;
    approval?: boolean;
    taskGrant?: boolean;
    activation?: 'pending' | 'granted';
  } = {}
) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'goal-consumer-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const actor = { kind: 'local' as const, userId };
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Goal Policy consumers');
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
  const files = new RuntimeConfigFileService({
    dataRoot,
    userId,
    workspaceIds: [workspace.id],
    runtimeConfigManager: manager,
    readRuntimeConfigStatus: () => manager.status(),
  });
  const domains = createGoalDomainPolicyService({
    coreDb,
    store,
    repositoryWorkspaceDb: () => db,
    files,
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
  const goalWake = vi.fn<(workspaceId: string, goalId: string) => void>();
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
  if (options.activation !== 'pending')
    await executeGoalOperation(
      'goal.plan.approve',
      { ...approval, requestId: randomUUID() },
      { actor },
      store,
      db,
      services
    );
  if (!options.activation)
    await executeGoalOperation(
      'goal.plan.approve',
      { ...approval, requestId: randomUUID() },
      coordinatorContext,
      store,
      db,
      options.publish === false ? { coreDb } : services
    );
  const domain = domains.read(scope);
  expect(domain !== null).toBe(options.publish !== false && !options.activation);
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
    const result = await tool.execute(
      { ...dispatchInput, agentId: selectedAgentId },
      { callId: 'goal-task-test', toolOccurrence: 1, signal: new AbortController().signal }
    );
    return { result, startWorker };
  };
  const setupMcp = async (administratorContinuation = false) => {
    const requestId = randomUUID();
    const thread = await store.createThread(
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
    let turn = await store.createTurn(
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
    await store.createItem({
      id: deriveEntityId('it', ['task-user', turn.id]),
      owner: { kind: 'workspace', workspaceId: workspace.id },
      threadId: thread.id,
      turnId: turn.id,
      type: 'user-message',
      status: 'completed',
      actor: turn.triggerActor,
      text: prompt,
      createdAt: turn.startedAt!,
      completedAt: turn.startedAt!,
    });
    await store.createAgentSession({
      id: agentSessionId,
      agentId,
      workspaceId: workspace.id,
      threadId: thread.id,
      status: 'busy',
      message: null,
      createdAt: turn.startedAt!,
      updatedAt: turn.startedAt!,
    });
    const catalog = parseWorkspaceMcpServerCatalog({
      schemaVersion: 1 as const,
      servers: [
        {
          id: 'issues',
          enabled: true,
          credentialBindings: [],
          allowedTools: ['read'],
          schemaPolicy: 'tracking' as const,
          pinnedSchemaSnapshotId: null,
          timeoutMs: 2000,
          transport: { kind: 'http' as const, endpoint: 'https://issues.invalid/mcp' },
        },
      ],
    });
    let environmentPackage = resolveAgentEnvironmentPackage({
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
    let administrator: Actor | null = null;
    if (administratorContinuation) {
      // A later native Turn keeps the terminal Task's immutable request and accountability.
      const terminal = recordSchedulerExecutionOperation(coreDb, {
        attemptId: attempt.attemptId,
        operationId: `completed:${turn.id}`,
      });
      const correlation = schedulerExecutionCorrelation(terminal);
      expect(
        acceptSchedulerExecutionObservation(coreDb, {
          ...correlation,
          disposition: 'accepted',
          execution: 'terminal',
          outcomeRef: `completed:${turn.id}`,
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
      await store.updateTurn(turn.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
      clearWorkerCheckpoint(db, workspace.id, thread.id, turn.id);
      await store.updateAgentSession(agentSessionId, {
        status: 'closed',
        updatedAt: new Date().toISOString(),
      });
      const now = new Date().toISOString();
      const administratorId = testEntityId('usr', `${requestId}:administrator`);
      coreDb.sqlite
        .prepare(
          "INSERT INTO users (id,kind,display_name,email,email_verified,created_at,updated_at,status) VALUES (?,'human','Continuation administrator','',0,?,?,'active')"
        )
        .run(administratorId, now, now);
      const token = createOpenKitAccessTokenRecord(coreDb, {
        ownerUserId: administratorId,
        scope: 'server-admin',
        workspaceIds: [],
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      administrator = {
        kind: 'token',
        userId: administratorId,
        tokenId: token.tokenId,
        tokenScope: 'server-admin',
      };
      const followupInput = 'Continue the same bounded issue review.';
      const followupSessionId = testEntityId('as', `${requestId}:continuation`);
      turn = await store.createTurn(
        workspace.id,
        thread.id,
        followupInput,
        { kind: 'user', id: administratorId },
        null,
        {
          agentId,
          agentSessionId: followupSessionId,
          executorKind: 'worker',
          triggerSource: { kind: 'user-input', summary: 'Administrator continuation.' },
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
        text: followupInput,
        createdAt: turn.startedAt!,
        completedAt: turn.startedAt!,
      });
      await store.createAgentSession({
        id: followupSessionId,
        agentId,
        workspaceId: workspace.id,
        threadId: thread.id,
        status: 'busy',
        message: null,
        createdAt: turn.startedAt!,
        updatedAt: turn.startedAt!,
      });
      const followupRequestId = randomUUID();
      environmentPackage = resolveAgentEnvironmentPackage({
        captureCoverage: { scope: 'server', value: 'off' },
        agentSessionId: followupSessionId,
        agentSetup: createTestAgentSetup({ agentId, mcpIds: ['issues'] }),
        backend: { kind: 'openshell' },
        createdAt: now,
        requestId: followupRequestId,
        triggerActor: turn.triggerActor,
        turn,
        workspaceCwd: '/workspace',
        workspaceRoots: [],
        workspaceMcpServerCatalog: catalog,
      });
      const followupEntry = createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        queueEntryId: `queue_${turn.id}`,
        requestId: followupRequestId,
        triggerActor: turn.triggerActor,
        workspaceId: workspace.id,
        threadId: thread.id,
        turnId: turn.id,
        turnInput: followupInput,
        requestedAgentId: agentId,
        serverAdminTokenId: token.tokenId,
      });
      const followupAttempt = recordTestExecutionAttempt(coreDb, {
        entry: followupEntry,
        attemptId: testEntityId('attempt', `${requestId}:continuation`),
        agentSessionId: followupSessionId,
        inputRef: environmentPackage.snapshotId,
        bindingRef: `continuation-binding:${requestId}`,
        sessionCompatibilityKey: 'fixture',
        now: () => now,
        operationId: `continuation:${turn.id}`,
      });
      expect(
        acceptSchedulerExecutionObservation(coreDb, {
          ...schedulerExecutionCorrelation(followupAttempt),
          disposition: 'accepted',
          execution: 'running',
          fenceRef: null,
          outcomeRef: null,
        })?.disposition
      ).toBe('accepted');
      recordAgentEnvironmentPackageSnapshot(db, { environmentPackage, createdAt: now });
    }
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
      responsibleUserId: userId,
      resources: options.taskGrant === false ? [] : [resource],
    });
    const gateway: WorkerMcpGateway = {
      listTools: vi.fn(async () => ({
        serverVersion: 'fixture',
        tools: [
          {
            name: 'read',
            inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
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
    if (options.approval) {
      const policy = admitTestMcpApproval({
        coreDb,
        document: manager.current().openKitConfig.policy?.mediation,
        workspaceId: workspace.id,
        serverId: 'issues',
        toolName: 'read',
        userId,
        principal: { kind: 'agent', id: agentId },
        threadId: thread.id,
        turnId: turn.id,
      });
      writeFileSync(
        join(dataRoot, 'config/server.jsonc'),
        JSON.stringify({
          ...manager.current().openKitConfig,
          policy: { ...manager.current().openKitConfig.policy, mediation: policy },
        })
      );
      manager.reload({ mode: 'safe', dryRun: false });
    }
    const app = new Hono<{ Variables: AuthVariables }>();
    const interception = new PolicyInterception();
    const routes = {
      app,
      coreDb,
      store,
      interception,
      goalTaskPolicy,
      goalWake,
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
          fetch: async (input, init) => app.fetch(new Request(input, init)),
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
    return {
      client,
      gateway,
      call,
      decisions,
      turn,
      routes,
      catalog,
      interception,
      administrator,
      packageSnapshotId: environmentPackage.snapshotId,
    };
  };
  return {
    dataRoot,
    manager,
    files,
    goal,
    card,
    approval,
    coordinatorContext,
    dispatchInput,
    goalTaskPolicy,
    coreDb,
    db,
    store,
    actor,
    scope,
    domain,
    domains,
    plan,
    agentId,
    dispatch,
    setupMcp,
    coordinator,
    resource,
    services,
    goalWake,
  };
}

describe('Goal Coordinator missing Task grant routing', () => {
  it('preserves the actual Coordinator destination without a human request, effect or finite use', async () => {
    const f = await fixture({ taskGrant: false, uses: 2 });
    const mcp = await f.setupMcp();
    const decide = vi.spyOn(mcp.interception, 'decide');
    const goalPending = listThreadPendingRequests(
      f.db.sqlite,
      f.scope.workspaceId,
      f.scope.threadId
    );
    const blocked = await mcp.call().then(
      (result) => result.isError === true,
      () => true
    );
    expect(blocked).toBe(true);
    expect(mcp.gateway.callTool).not.toHaveBeenCalled();
    expect(listThreadPendingRequests(f.db.sqlite, f.scope.workspaceId, mcp.turn.threadId)).toEqual(
      []
    );
    expect(listThreadPendingRequests(f.db.sqlite, f.scope.workspaceId, f.scope.threadId)).toEqual(
      goalPending
    );
    expect(
      readPolicyStatementUseCount(f.db, { id: f.domain!.id, digest: policyDigest(f.domain) })
    ).toBe(0);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(await decide.mock.results[0]!.value).toMatchObject({
      result: 'require_escalation',
      escalation: {
        kind: 'coordinator',
        workspaceId: f.scope.workspaceId,
        goalId: f.scope.goalId,
        agentId: 'goal-coordinator',
      },
    });
  });

  it('advances the existing Goal wake marker and notifies only its Coordinator after a Task grant gap', async () => {
    const f = await fixture({ taskGrant: false, uses: 2 });
    const mcp = await f.setupMcp();
    const before = readGoalView(f.store, f.db, f.scope.goalId).goal!;
    expect(f.goalWake).not.toHaveBeenCalled();
    await mcp.call().catch(() => undefined);
    expect(mcp.gateway.callTool).not.toHaveBeenCalled();
    expect(listThreadPendingRequests(f.db.sqlite, f.scope.workspaceId, mcp.turn.threadId)).toEqual(
      []
    );
    const after = readGoalView(f.store, f.db, f.scope.goalId).goal!;
    expect(after.changeRevision).toBe(before.changeRevision + 1);
    expect(after.consideredRevision).toBe(before.consideredRevision);
    expect(after.disposition).toBeNull();
    expect(f.goalWake).toHaveBeenCalledExactlyOnceWith(f.scope.workspaceId, f.scope.goalId);
  });

  it('rolls back the declined gap fact when its Goal marker update fails and permits a new request', async () => {
    const f = await fixture({ taskGrant: false, uses: 2 });
    const mcp = await f.setupMcp();
    const decide = vi.spyOn(mcp.interception, 'decide');
    const calls = () =>
      listWorkspaceCapabilityCalls(f.db, f.scope.workspaceId).filter(
        (call) => call.operation === 'mcp.call-tool' && call.turnId === mcp.turn.id
      );
    const before = readGoalView(f.store, f.db, f.scope.goalId).goal!;
    const goalPending = listThreadPendingRequests(
      f.db.sqlite,
      f.scope.workspaceId,
      f.scope.threadId
    );
    expect(calls()).toEqual([]);
    expect(f.goalWake).not.toHaveBeenCalled();
    // A persistent SQLite trigger also faults the real route's separate Workspace connection.
    f.db.sqlite.exec(`CREATE TRIGGER reject_goal_gap_marker BEFORE UPDATE ON goals
      BEGIN SELECT RAISE(ABORT, 'Injected Goal marker update failure'); END`);
    try {
      expect(() =>
        f.db.sqlite
          .prepare('UPDATE goals SET payload_json=payload_json WHERE goal_id=?')
          .run(f.scope.goalId)
      ).toThrow('Injected Goal marker update failure');
      await expect(mcp.call()).rejects.toBeInstanceOf(Error);
    } finally {
      f.db.sqlite.exec('DROP TRIGGER reject_goal_gap_marker');
    }
    expect(decide).toHaveBeenCalledTimes(1);
    expect(await decide.mock.results[0]!.value).toMatchObject({
      result: 'require_escalation',
      escalation: { kind: 'coordinator', goalId: f.scope.goalId },
    });
    expect(readGoalView(f.store, f.db, f.scope.goalId).goal).toEqual(before);
    expect(f.goalWake).not.toHaveBeenCalled();
    expect(mcp.gateway.callTool).not.toHaveBeenCalled();
    expect(listThreadPendingRequests(f.db.sqlite, f.scope.workspaceId, mcp.turn.threadId)).toEqual(
      []
    );
    expect(listThreadPendingRequests(f.db.sqlite, f.scope.workspaceId, f.scope.threadId)).toEqual(
      goalPending
    );
    expect(
      readPolicyStatementUseCount(f.db, { id: f.domain!.id, digest: policyDigest(f.domain) })
    ).toBe(0);
    const failedCalls = calls();
    expect(failedCalls).toHaveLength(1);
    const failedCall = failedCalls[0]!;
    expect(failedCall.completedAt).not.toBeNull();
    const failedAudit = listWorkspaceAuditEvents(f.db, f.scope.workspaceId).filter(
      (event) => event.action === 'capability.finish' && event.capabilityCallId === failedCall.id
    );
    expect(failedAudit).toHaveLength(1);

    // The failed request is not repaired or replayed; a new MCP request must route independently.
    expect(await mcp.call()).toMatchObject({ isError: true });
    expect(calls()).toHaveLength(2);
    const routedCall = calls().find((call) => call.id !== failedCall.id)!;
    expect(routedCall).toMatchObject({
      status: 'denied',
      errorCode: 'policy_requires_escalation',
    });
    expect(calls().find((call) => call.id === failedCall.id)).toEqual(failedCall);
    expect(
      listWorkspaceAuditEvents(f.db, f.scope.workspaceId).filter(
        (event) => event.action === 'capability.finish' && event.capabilityCallId === failedCall.id
      )
    ).toEqual(failedAudit);
    expect(readGoalView(f.store, f.db, f.scope.goalId).goal).toMatchObject({
      changeRevision: before.changeRevision + 1,
      consideredRevision: before.consideredRevision,
      disposition: null,
    });
    expect(f.goalWake).toHaveBeenCalledExactlyOnceWith(f.scope.workspaceId, f.scope.goalId);
    expect(mcp.gateway.callTool).not.toHaveBeenCalled();
    expect(listThreadPendingRequests(f.db.sqlite, f.scope.workspaceId, mcp.turn.threadId)).toEqual(
      []
    );
    expect(
      readPolicyStatementUseCount(f.db, { id: f.domain!.id, digest: policyDigest(f.domain) })
    ).toBe(0);
    // A failed operation may remain visible, but a routed decline cannot outlive its rolled-back marker.
    expect({ call: failedCall, audit: failedAudit }).toMatchObject({
      call: { status: 'failed' },
      audit: [{ action: 'capability.finish', outcome: 'failed' }],
    });
  });

  it('reruns ordinary current evaluation after a bounded grant and consumes that grant only on the allowed effect', async () => {
    const f = await fixture({ taskGrant: false, uses: 2 });
    const mcp = await f.setupMcp();
    const blocked = await mcp.call().then(
      (result) => result.isError === true,
      () => true
    );
    expect(blocked).toBe(true);
    expect(mcp.gateway.callTool).not.toHaveBeenCalled();
    expect(listThreadPendingRequests(f.db.sqlite, f.scope.workspaceId, mcp.turn.threadId)).toEqual(
      []
    );
    expect(
      readPolicyStatementUseCount(f.db, { id: f.domain!.id, digest: policyDigest(f.domain) })
    ).toBe(0);
    // Administration and effect are separate requests to their real existing owners.
    const granted = f.domains.administer({
      workspaceDb: f.db,
      goalId: f.scope.goalId,
      coordinatorTurnId: f.coordinator.id,
      taskLineage: {
        workspaceId: f.scope.workspaceId,
        threadId: mcp.turn.threadId,
        turnId: mcp.turn.id,
        agentSessionId: mcp.turn.agentSessionId!,
        packageSnapshotId: mcp.packageSnapshotId,
      },
      expectedPolicyRevision: f.services.goalDomain.currentRevision(),
      grant: {
        id: 'one-issue-read-after-escalation',
        scope: {
          subjects: [{ kind: 'agent', id: f.agentId }],
          actions: ['tool.use'],
          resources: [f.resource],
        },
        lifetime: {
          anchor: {
            owner: { kind: 'workspace', workspaceId: f.scope.workspaceId },
            kind: 'thread',
            id: mcp.turn.threadId,
          },
          uses: 1,
        },
        rationale: 'Read this issue once for the exact assigned Task',
      },
    });
    const permission = { id: granted.statement.id, digest: policyDigest(granted.statement) };
    expect(readPolicyStatementUseCount(f.db, permission)).toBe(0);
    expect(mcp.gateway.callTool).not.toHaveBeenCalled();
    expect(await mcp.call()).toMatchObject({ content: [{ text: 'ISSUE_RESULT_CANARY' }] });
    expect(mcp.gateway.callTool).toHaveBeenCalledTimes(1);
    expect(mcp.decisions().at(-1)).toMatchObject({ result: 'allow' });
    expect(readPolicyStatementUseCount(f.db, permission)).toBe(1);
    expect(
      readPolicyStatementUseCount(f.db, { id: f.domain!.id, digest: policyDigest(f.domain) })
    ).toBe(1);
    expect(listThreadPendingRequests(f.db.sqlite, f.scope.workspaceId, mcp.turn.threadId)).toEqual(
      []
    );
  });
});

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
    expect(startWorker).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      code: 'task_admission_failed',
      message:
        'Task admission failed without a safe result. Inspect current Task records before a new request.',
    });
    expect(JSON.stringify(result)).not.toContain('SAFE_WORKER_BOUNDARY');
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

  it('withholds a captured result after Goal closure while preserving the settled effect and usage', async () => {
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
    let prepared: PreparedCapturedPendingCall | undefined;
    let executionCall: ReturnType<typeof admitCapturedPendingCall> | undefined;
    let entered!: () => void;
    let release!: () => void;
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
    const outcome = respondRecordedApproval({
      store: f.store,
      sqlite: f.db.sqlite,
      workspaceId: f.scope.workspaceId,
      threadId: mcp.turn.threadId,
      approvalRequestId: record.requestId,
      decision: 'granted',
      actorId: f.actor.userId,
      coreDb: f.coreDb,
      requestActor: f.actor,
      dependencies: { coreDb: f.coreDb, openWorkspace: () => f.db },
      prepare: async () => {
        prepared = await prepareCapturedPendingCall({
          actor: f.actor,
          record,
          catalog: mcp.catalog,
          coreDb: f.coreDb,
          vaultBackend: undefined,
          workerMcpGateway: mcp.gateway,
          workspaceDb: f.db,
          reviewPolicy: () =>
            reviewCapturedMcpPolicy({
              record,
              actor: f.actor,
              workspaceDb: f.db,
              routes: mcp.routes,
              catalog: mcp.catalog,
              interception: mcp.interception,
            }),
        });
        expect(prepared.failed).toBe(false);
      },
      evaluate: () =>
        evaluateCapturedPendingCall({
          manifest: createTestAgentSetup({ agentId: f.agentId, mcpIds: ['issues'] }).manifest,
          catalog: mcp.catalog,
          coreDb: f.coreDb,
          record,
          sqlite: f.db.sqlite,
          prepared,
        }),
      admitExecution: () => {
        executionCall = admitCapturedPendingCall(record, f.db, randomUUID(), prepared);
      },
      execute: (claimed) =>
        executeCapturedPendingCall({
          catalog: mcp.catalog,
          coreDb: f.coreDb,
          record: claimed,
          workerMcpGateway: mcp.gateway,
          workspaceDb: f.db,
          prepared,
          executionCall,
        }),
    });
    await upstreamEntered;
    await executeGoalOperation(
      'goal.cancel',
      {
        ...f.scope,
        requestId: randomUUID(),
        expectedRevision: readGoalView(f.store, f.db, f.scope.goalId).goal!.changeRevision,
        reason: 'End authority while captured effect runs',
      },
      { actor: f.actor },
      f.store,
      f.db,
      { coreDb: f.coreDb }
    );
    release();
    const settled = await outcome;
    expect(settled).toMatchObject({ claim: 'finished', disposition: 'approved-executed' });
    expect(mcp.gateway.callTool).toHaveBeenCalledTimes(1);
    const callId = executionCallIdForRequest(record.requestId);
    expect(
      f.db.sqlite.prepare('SELECT status FROM capability_calls WHERE call_id = ?').get(callId)
    ).toEqual({ status: 'succeeded' });
    expect(
      f.db.sqlite
        .prepare('SELECT quantity FROM usage_records WHERE capability_call_id = ?')
        .all(callId)
    ).toEqual([{ quantity: 1 }]);
    expect(JSON.stringify(settled.heldResult)).not.toContain('ISSUE_RESULT_CANARY');
  });

  it('executes captured approval from a later administrator Turn with original Goal accountability', async () => {
    const f = await fixture({ approval: true });
    const mcp = await f.setupMcp(true);
    const administrator = mcp.administrator!;
    expect(administrator.userId).not.toBe(f.actor.userId);
    expect(mcp.turn.triggerActor).toEqual({ kind: 'user', id: administrator.userId });
    expect(await mcp.call()).toMatchObject({
      isError: true,
      structuredContent: { status: 'pending-approval' },
    });
    const record = listThreadPendingRequests(
      f.db.sqlite,
      f.scope.workspaceId,
      mcp.turn.threadId
    )[0]!;
    expect(
      mcp.decisions().find((decision) => decision.decisionId === record.policyDecisionId)
    ).toMatchObject({
      result: 'require_approval',
      mediation: {
        subject: {
          principal: { kind: 'agent', id: f.agentId },
          actor: { responsibleUserId: f.actor.userId },
          responsibleHumanId: f.actor.userId,
        },
      },
    });
    let prepared: PreparedCapturedPendingCall | undefined;
    let executionCall: ReturnType<typeof admitCapturedPendingCall> | undefined;
    const settled = await respondRecordedApproval({
      store: f.store,
      sqlite: f.db.sqlite,
      workspaceId: f.scope.workspaceId,
      threadId: mcp.turn.threadId,
      approvalRequestId: record.requestId,
      decision: 'granted',
      actorId: administrator.userId,
      coreDb: f.coreDb,
      requestActor: administrator,
      dependencies: { coreDb: f.coreDb, openWorkspace: () => f.db },
      prepare: async () => {
        prepared = await prepareCapturedPendingCall({
          actor: administrator,
          record,
          catalog: mcp.catalog,
          coreDb: f.coreDb,
          vaultBackend: undefined,
          workerMcpGateway: mcp.gateway,
          workspaceDb: f.db,
          reviewPolicy: () =>
            reviewCapturedMcpPolicy({
              record,
              actor: administrator,
              workspaceDb: f.db,
              routes: mcp.routes,
              catalog: mcp.catalog,
              interception: mcp.interception,
            }),
        });
        expect(prepared.failed).toBe(false);
      },
      evaluate: () =>
        evaluateCapturedPendingCall({
          manifest: createTestAgentSetup({ agentId: f.agentId, mcpIds: ['issues'] }).manifest,
          catalog: mcp.catalog,
          coreDb: f.coreDb,
          record,
          sqlite: f.db.sqlite,
          prepared,
        }),
      admitExecution: () => {
        executionCall = admitCapturedPendingCall(record, f.db, randomUUID(), prepared);
      },
      execute: (claimed) =>
        executeCapturedPendingCall({
          catalog: mcp.catalog,
          coreDb: f.coreDb,
          record: claimed,
          workerMcpGateway: mcp.gateway,
          workspaceDb: f.db,
          prepared,
          executionCall,
        }),
    });
    expect(settled).toMatchObject({
      claim: 'finished',
      disposition: 'approved-executed',
      responsibleUserId: f.actor.userId,
      authorizationContext: { responsibleUserId: f.actor.userId },
      decidingActor: { kind: 'user', id: administrator.userId },
      decidingActorContext: administrator,
      heldResult: { content: [{ text: 'ISSUE_RESULT_CANARY' }] },
    });
    expect(mcp.gateway.callTool).toHaveBeenCalledTimes(1);
    const executionDecision = listExportableWorkspacePermissionDecisions(
      f.db,
      f.scope.workspaceId
    ).find((decision) => decision.approvalId === record.requestId)!;
    expect(executionDecision).toMatchObject({
      result: 'allow',
      mediation: {
        subject: {
          principal: { kind: 'agent', id: f.agentId },
          responsibleHumanId: f.actor.userId,
        },
      },
    });
    expect(
      listWorkspaceAuditEvents(f.db, f.scope.workspaceId).find(
        (event) => event.id === executionDecision.auditEventId
      )
    ).toMatchObject({ actor: { kind: 'user', id: administrator.userId } });
    const reloaded = readPendingRequest(f.db.sqlite, record.requestId)!;
    const reopenedStore = new FsStore({ dataRoot: f.store.getDataRoot()! });
    expect(
      validateCanonicalLoad(
        reloaded,
        reopenedStore.listThreadTurns(f.scope.workspaceId, mcp.turn.threadId)
      )
    ).toBeNull();
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

// Proposal admission must apply the publisher's native meanings before replacing any approval.
it.each([
  'workspace-knowledge',
  'read',
  'knowledge',
  'artifact',
  'foreign-workspace',
  'wrong-goal-anchor',
  'missing-thread',
  'foreign-thread',
] as const)('rejects an unpublishable Goal proposal before effects: %s', async (invalid) => {
  const f = await fixture({ activation: 'pending' });
  const before = readGoalView(f.store, f.db, f.scope.goalId);
  const owner = { kind: 'workspace' as const, workspaceId: f.scope.workspaceId };
  const domain = {
    id: 'bounded-native-domain',
    scope: {
      subjects: [{ kind: 'agent' as const, id: f.agentId }],
      actions: ['knowledge.read'],
      resources: [
        {
          kind: 'container' as const,
          container: { owner, kind: 'workspace', id: f.scope.workspaceId },
        },
      ],
    },
    lifetime: { anchor: { owner: { ...owner }, kind: 'goal', id: f.scope.goalId } },
  };
  const container = domain.scope.resources[0]!.container;
  if (invalid === 'read') domain.scope.actions = ['read'];
  else if (invalid === 'wrong-goal-anchor') domain.lifetime.anchor.id = 'another-goal';
  else if (invalid === 'foreign-workspace')
    container.owner = { ...owner, workspaceId: testEntityId('ws', 'foreign-domain') };
  else if (invalid === 'missing-thread') {
    container.kind = 'thread';
    container.id = testEntityId('th', 'missing-domain');
  } else if (invalid === 'foreign-thread') {
    const foreign = f.store.createWorkspace('Other Workspace');
    const thread = f.store.createThread(foreign.id, 'Foreign source');
    container.kind = 'thread';
    container.id = thread.id;
  } else container.kind = invalid;
  const policyBytes = readFileSync(join(f.dataRoot, 'config/server.jsonc'), 'utf8');
  const revision = f.services.goalDomain.currentRevision();
  const reload = vi.spyOn(f.manager, 'reload');
  try {
    const result = await executeGoalOperation(
      'goal.plan.propose',
      {
        ...f.scope,
        requestId: randomUUID(),
        expectedRevision: before.goal!.changeRevision,
        commitment: f.plan.commitment,
        goalDomain: domain as never,
      },
      f.coordinatorContext,
      f.store,
      f.db,
      f.services
    ).then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error })
    );
    expect.soft(result.error).toMatchObject({ code: 'invalid_request' });
    if (result.error instanceof Error)
      expect.soft(result.error.message).toMatch(/action|resource|container|anchor/i);
    expect.soft(readGoalView(f.store, f.db, f.scope.goalId)).toEqual(before);
    expect
      .soft(readPendingRequest(f.db.sqlite, f.plan.pendingRequestId))
      .toMatchObject({ state: 'pending', claim: 'unclaimed' });
    expect.soft(readFileSync(join(f.dataRoot, 'config/server.jsonc'), 'utf8')).toBe(policyBytes);
    expect.soft(f.services.goalDomain.currentRevision()).toBe(revision);
    expect.soft(reload).not.toHaveBeenCalled();
    expect.soft(f.domains.read(f.scope)).toBeNull();
  } finally {
    reload.mockRestore();
  }
});

it.each([
  'B01',
  'RG',
] as const)('reads retained unsupported %s domain bytes without activating or rewriting them', async (shape) => {
  const f = await fixture({ publish: false });
  const record = readPendingRequest(f.db.sqlite, f.plan.pendingRequestId)!;
  const intent = structuredClone(record.governedIntent!);
  const captured = intent.goalDomain as {
    statement: { scope: { actions: string[]; resources: unknown[] } };
    digest: string;
  };
  captured.statement.scope.actions =
    shape === 'B01'
      ? ['read', 'propose', 'review']
      : ['read', 'propose', 'knowledge-candidate', 'knowledge-review'];
  captured.statement.scope.resources = (
    shape === 'B01'
      ? ['workspace-knowledge', 'goal-artifacts']
      : ['workspace', 'knowledge', 'artifact']
  ).map((kind) => ({
    kind: 'container',
    container: {
      owner: { kind: 'workspace', workspaceId: f.scope.workspaceId },
      kind,
      id: kind === 'workspace' ? f.scope.workspaceId : 'retained-descriptive-id',
    },
  }));
  captured.digest = policyDigest(captured.statement as never);
  // A retained-format fixture, not a new proposal or permission grant. Only the reader is invoked.
  const bytes = JSON.stringify(intent);
  expect(
    f.db.sqlite
      .prepare('UPDATE pending_requests SET governed_intent_json=? WHERE request_id=?')
      .run(bytes, record.requestId).changes
  ).toBe(1);
  const view = await executeGoalOperation(
    'goal.read',
    f.scope,
    { actor: f.actor },
    new FsStore({ dataRoot: f.dataRoot }),
    f.db,
    f.services
  );
  expect(view.goal?.activePlanVersionId).toBe(f.plan.planVersionId);
  expect(view.requests).toContainEqual(
    expect.objectContaining({
      requestId: record.requestId,
      claim: 'finished',
      disposition: 'approved-executed',
      exactIntent: intent,
    })
  );
  expect(
    f.db.sqlite
      .prepare('SELECT governed_intent_json FROM pending_requests WHERE request_id=?')
      .get(record.requestId)
  ).toEqual({ governed_intent_json: bytes });
  expect(f.domains.read(f.scope)).toBeNull();
});

// Real Goal/Policy/Task owners; only inference and the unresolved Knowledge dependency are external fixtures.
it.each([
  'activation',
  'publication-retry',
  'refused-dispatch',
  'recovery-required',
  'invalid-call',
  'unresolved-knowledge',
  'model-turns',
  'tool-calls',
  'provider-deadline',
] as const)('retains native Coordinator outcomes across %s', async (mode) => {
  const activates = mode === 'activation' || mode === 'publication-retry';
  const f = await fixture(activates ? { activation: 'granted' } : {});
  const { store, coreDb, db, scope } = f;
  const gatewayConfig = createTestGatewayConfig();
  gatewayConfig.logicalModels[0]!.contextManagement = [
    { type: 'compaction', compactThreshold: 64000 },
  ];
  const manifest = createTestAgentSetup({ agentId: f.agentId }).manifest;
  store.setWorkspaceAgentCatalogProjection(() => projectAgentCatalogEntries([manifest]));
  const providerRegistry = new ProviderRegistry([
    {
      id: 'agent-openrouter',
      displayName: 'Local fixture',
      kind: 'local',
      models: ['openai/gpt-5.2'],
      defaultModel: 'openai/gpt-5.2',
    },
  ]);
  const limits = {
    maxModelTurns: mode === 'model-turns' ? 1 : mode === 'refused-dispatch' ? 2 : 8,
    maxToolCalls: mode === 'tool-calls' ? 1 : 24,
    deadlineMs: 120000,
  };
  const inflightCommands = new WeakMap();
  const admission = new WorkspaceMutationAdmission();
  const services = { ...f.services, inflightCommands };
  const runtimeConfig = () =>
    createInMemoryRuntimeConfigSnapshot({
      dataRoot: f.dataRoot,
      agentManifests: [manifest],
      providerRegistry,
      gatewayConfig,
      openKitConfig: f.manager.current().openKitConfig,
      internalRoleProfiles: {
        schemaVersion: 1,
        profiles: [
          {
            id: 'coordinator-fixture',
            roleId: 'goal-orchestrator',
            preferredLogicalModelId: gatewayConfig.logicalModels[0]!.id,
            compatibleLogicalModelIds: [],
            requiredLogicalModelCapabilities: ['responses', 'tool-calling'],
            limits,
          },
        ],
      },
    });
  const historicalIds: string[] = [];
  if (mode === 'invalid-call' || mode === 'unresolved-knowledge') {
    const historical = await executeGoalOperation(
      'goal.read',
      scope,
      { actor: f.actor },
      store,
      db,
      services
    );
    historicalIds.push(
      store.createItem({
        id: allocateEntityId('it'),
        owner: f.coordinator.owner,
        threadId: scope.threadId,
        turnId: f.coordinator.id,
        type: 'tool-call',
        tool: 'goal.read',
        server: null,
        causationId: 'previous-goal-read',
        arguments: {},
        result: JSON.stringify([{ type: 'text', text: JSON.stringify(historical) }]),
        error: null,
        status: 'completed',
        durationMs: null,
        createdAt: f.coordinator.startedAt!,
        completedAt: f.coordinator.startedAt!,
      }).id
    );
    store.updateTurn(f.coordinator.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    f.coordinator = store.createTurn(
      scope.workspaceId,
      scope.threadId,
      'Continue',
      { kind: 'user', id: f.actor.userId },
      null,
      { executorKind: 'coordinator', agentId: 'goal-coordinator' }
    );
  }
  const originalThreads = store.listThreads(scope.workspaceId).map((thread) => thread.id);
  const beforeRevision = services.goalDomain.currentRevision();
  const taskInput = structuredClone(f.dispatchInput);
  if (mode === 'refused-dispatch')
    taskInput.request.resources = [
      {
        kind: 'policy',
        resource: { ...f.resource, toolName: 'write' },
        reason: 'Outside the exact read grant',
      },
    ];
  const scripts: { name: string; args: unknown }[][] =
    mode === 'activation'
      ? [
          [
            {
              name: 'goal_plan_approve',
              args: { pendingRequestId: f.plan.pendingRequestId, decision: 'granted' },
            },
          ],
          [{ name: 'goal_read', args: {} }],
          [{ name: 'agent_list', args: {} }],
          [{ name: 'goal_task_dispatch', args: taskInput }],
        ]
      : mode === 'publication-retry'
        ? [
            [
              {
                name: 'goal_plan_approve',
                args: { pendingRequestId: f.plan.pendingRequestId, decision: 'granted' },
              },
            ],
            [{ name: 'goal_read', args: {} }],
            [{ name: 'goal_task_dispatch', args: taskInput }],
            [
              {
                name: 'goal_plan_approve',
                args: { pendingRequestId: f.plan.pendingRequestId, decision: 'granted' },
              },
            ],
            [{ name: 'goal_read', args: {} }],
          ]
        : mode === 'refused-dispatch' || mode === 'recovery-required'
          ? [[{ name: 'agent_list', args: {} }], [{ name: 'goal_task_dispatch', args: taskInput }]]
          : mode === 'invalid-call'
            ? [[{ name: 'goal_task_dispatch', args: { ...taskInput, cardId: undefined } }]]
            : mode === 'unresolved-knowledge'
              ? [[{ name: 'knowledge_ask', args: { question: 'Which exact issue is in scope?' } }]]
              : mode === 'tool-calls'
                ? [
                    [
                      { name: 'goal_read', args: {} },
                      { name: 'goal_read', args: {} },
                    ],
                  ]
                : [[{ name: 'goal_read', args: {} }]];
  const requests: { input: unknown; tools: unknown }[] = [];
  let releaseProvider!: (value: unknown) => void;
  let providerEntered!: () => void;
  const providerStarted = new Promise<void>((resolve) => {
    providerEntered = resolve;
  });
  let releaseKnowledge!: (value: {
    threadId: string;
    turnId: string;
    answer: string;
    citations: [];
    uncertainty: null;
  }) => void;
  let knowledgeEntered!: () => void;
  const knowledgeStarted = new Promise<void>((resolve) => {
    knowledgeEntered = resolve;
  });
  const knowledgeAsk = vi.fn(async () => {
    knowledgeEntered();
    return new Promise<{
      threadId: string;
      turnId: string;
      answer: string;
      citations: [];
      uncertainty: null;
    }>((resolve) => {
      releaseKnowledge = resolve;
    });
  });
  const dispatch = vi.fn(
    async (_provider: unknown, request: { input: unknown; tools: unknown }) => {
      const index = requests.length;
      requests.push(structuredClone(request));
      if (mode === 'provider-deadline') {
        providerEntered();
        return new Promise((resolve) => {
          releaseProvider = resolve;
        });
      }
      if (mode === 'publication-retry' && index === 1) {
        expect(readGoalView(store, db, scope.goalId).goal?.activePlanVersionId).toBe(
          f.plan.planVersionId
        );
        expect(readPendingRequest(db.sqlite, f.plan.pendingRequestId)).toMatchObject({
          claim: 'finished',
          disposition: 'approved-executed',
        });
        expect(f.domains.read(scope)).toBeNull();
      }
      const calls = scripts[index];
      return {
        id: `response-${index}`,
        object: 'response',
        output: calls
          ? calls.map((call, ordinal) => ({
              type: 'function_call',
              call_id: `current-${index}-${ordinal}`,
              name: call.name,
              arguments: JSON.stringify(call.args),
            }))
          : [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'Bounded consideration ended.' }],
              },
            ],
      };
    }
  );
  const checkpointAtAdmission: unknown[] = [];
  const startWorker = vi.fn(
    async (input: Parameters<import('./task-admission.js').TaskWorkerStarter>[0]) => {
      if (mode === 'recovery-required')
        throw new TurnStartValidationError(
          'recovery_required',
          'Inspect the existing admission before retry.',
          409
        );
      admitTestNativeEnvironment(coreDb, manifest);
      recordTestNativeRuntimeTarget(coreDb);
      const executor = new SimulatedTurnExecutor({
        coreDb,
        fileAdmission: new FileStorageAdmission(f.dataRoot, () => 1_000_000_000n),
      });
      const execution = vi.spyOn(executor, 'startTurn');
      const result = await startProductTurn({
        coreDb,
        store,
        triggerActor: input.triggerActor,
        requestActor: input.requestActor,
        snapshot: runtimeConfig(),
        providerCredentialResolver: () => null,
        workerPlacement: 'local',
        reservedTurnId: input.reservedTurnId,
        input: {
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          requestId: input.requestId,
          input: input.prompt,
          agentId: input.requestedAgentId,
        },
        onTurnCreated: (turn, agentSessionId) => {
          input.onTurnCreated(turn, agentSessionId);
          checkpointAtAdmission.push(
            listThreadWorkerCheckpoints(db, scope.workspaceId, input.threadId)[0]
          );
        },
        turnExecutor: executor,
      });
      // Product admission acknowledges before dispatch settles; keep its real executor alive through cleanup.
      await vi.waitFor(() => expect(execution).toHaveBeenCalledTimes(1), { timeout: 10000 });
      await execution.mock.results[0]!.value;
      execution.mockRestore();
      return result.turn;
    }
  );
  const policy = f.goalTaskPolicy(db);
  const policyEvaluation = vi.spyOn(policy, 'evaluateAdmission');
  const fileFailure =
    mode === 'publication-retry'
      ? vi.spyOn(f.files, 'updateFile').mockImplementationOnce(() => {
          throw new Error('Fixture Policy file write refused.');
        })
      : undefined;
  const taskTool = createCoordinatorTaskTool({
    store,
    coreDb,
    openWorkspace: (id) => openWorkspaceDb(f.dataRoot, id),
    inflightCommands,
    workspaceMutationAdmission: admission,
    startWorker,
    goalId: scope.goalId,
    coordinatorTurnId: f.coordinator.id,
    goalTaskPolicy: () => policy,
  });
  const taskExecute = vi.spyOn(taskTool, 'execute');
  const coordinator = createGoalCoordinator({
    store,
    coreDb,
    openWorkspace: (id) => openWorkspaceDb(f.dataRoot, id),
    runtimeConfig,
    llmGatewayDispatcher: { createResponses: dispatch } as never,
    resolveGatewayProvider: () => ({
      id: 'agent-openrouter',
      displayName: 'Fixture',
      adapterId: 'openai',
      apiKey: null,
      baseUrl: null,
      models: ['openai/gpt-5.2'],
      requiresApiKey: false,
      gatewayCapabilities: { chatCompletions: 'native', responses: 'native' },
    }),
    workspaceMutationAdmission: admission,
    services: () => services,
    taskTool: () => taskTool,
    workerCandidates: () => [
      { agentId: f.agentId, runtime: 'codex', readiness: 'ready', reasons: [] },
    ],
    knowledgeAgent: {
      ask: knowledgeAsk,
      maintain: async () => {
        throw new Error('Unexpected maintenance');
      },
    },
  });
  const deadline = mode === 'provider-deadline' || mode === 'unresolved-knowledge';
  if (deadline) vi.useFakeTimers();
  try {
    const run = coordinator.startTurn(store, f.coordinator.id);
    if (deadline) {
      await Promise.race([
        mode === 'provider-deadline' ? providerStarted : knowledgeStarted,
        run.then(() => {
          throw new Error(
            `Coordinator ended before the dependency: ${JSON.stringify(store.getTurnById(f.coordinator.id).error)}`
          );
        }),
      ]);
      await vi.advanceTimersByTimeAsync(limits.deadlineMs + 1);
    }
    await run;
    const workers = await Promise.allSettled(
      startWorker.mock.results.map((result) => result.value)
    );
    if (mode === 'activation')
      expect(workers.map((result) => result.status)).toEqual(['fulfilled']);
    const ended = store.getTurnById(f.coordinator.id);
    expect(ended.internalExecution).toMatchObject({ profileId: 'coordinator-fixture', limits });
    const view = readGoalView(store, db, scope.goalId);
    if (mode === 'activation') {
      expect(ended.status, JSON.stringify(ended.error)).toBe('completed');
      expect(startWorker).toHaveBeenCalledTimes(1);
      expect(view.tasks).toEqual([
        expect.objectContaining({
          goalId: scope.goalId,
          cardId: f.card.cardId,
          planVersionId: f.plan.planVersionId,
          cardRevision: f.card.revision,
          admittedAt: expect.any(String),
        }),
      ]);
      expect(checkpointAtAdmission).toEqual([
        expect.objectContaining({
          threadId: view.tasks[0]!.threadId,
          turnId: view.tasks[0]!.turns[0]!.turnId,
          stage: 'preparing',
        }),
      ]);
      expect(store.listThreadAgentSessions(scope.workspaceId, scope.threadId)).toEqual([]);
      expect(view.requests).toHaveLength(1);
      expect(view.versions).toHaveLength(1);
      const readOutput = (
        requests[2]!.input as { type: string; call_id?: string; output?: string }[]
      ).find((value) => value.type === 'function_call_output' && value.call_id === 'current-1-0');
      expect(readOutput).toBeDefined();
      expect(services.goalDomain.currentRevision()).not.toBe(beforeRevision);
      expect(JSON.parse(readOutput!.output!)).toMatchObject({
        policyAdministration: {
          policyRevision: services.goalDomain.currentRevision(),
          domain: f.domains.read(scope),
        },
      });
      expect(f.domains.read(scope)?.state).toBe('active');
    } else {
      expect(view.tasks.every((task) => task.admittedAt === null)).toBe(true);
      expect(listExportableAgentEnvironmentPackageSnapshots(db, scope.workspaceId)).toEqual([]);
      if (mode !== 'recovery-required') {
        expect(view.tasks).toEqual([]);
        expect(startWorker).not.toHaveBeenCalled();
        expect(store.listThreads(scope.workspaceId).map((thread) => thread.id)).toEqual(
          originalThreads
        );
        expect(listExportableWorkerCheckpoints(db, scope.workspaceId)).toEqual([]);
      }
    }
    if (mode === 'publication-retry') {
      expect(ended.status).toBe('completed');
      expect(view.versions).toHaveLength(1);
      expect(view.requests).toEqual([
        expect.objectContaining({
          requestId: f.plan.pendingRequestId,
          claim: 'finished',
          disposition: 'approved-executed',
        }),
      ]);
      expect(f.domains.read(scope)?.state).toBe('active');
      const failedApproval = (
        requests[1]!.input as { type: string; call_id?: string; output?: string }[]
      ).find((value) => value.type === 'function_call_output' && value.call_id === 'current-0-0');
      expect(failedApproval).toBeDefined();
      let failurePayload: unknown = null;
      try {
        failurePayload = JSON.parse(failedApproval!.output!);
      } catch {
        /* Untyped message text is not an owned error result. */
      }
      expect.soft(failurePayload).toMatchObject({ code: 'goal_domain_publication_failed' });
      f.domains.close(scope);
      expect(f.domains.read(scope)).toBeNull();
      expect(() =>
        f.domains.activate({
          workspaceId: scope.workspaceId,
          requestId: f.plan.pendingRequestId,
          expectedPolicyRevision: services.goalDomain.currentRevision(),
        })
      ).toThrow('new joint approval');
    }
    if (mode === 'refused-dispatch') {
      expect(taskExecute).toHaveBeenCalledTimes(1);
      expect(policyEvaluation.mock.results).toContainEqual(
        expect.objectContaining({
          type: 'return',
          value: expect.objectContaining({ kernel: expect.objectContaining({ effect: 'deny' }) }),
        })
      );
      expect(ended.status).toBe('failed');
      const nativeResult = await taskExecute.mock.results[0]!.value;
      expect(nativeResult.isError).toBe(true);
      expect
        .soft(JSON.parse(nativeResult.content[0].text))
        .toMatchObject({ code: 'task_admission_failed' });
    }
    if (mode === 'recovery-required') {
      expect(startWorker).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(requests.at(-1)!.input)).toContain('recovery_required');
    }
    if (mode === 'invalid-call') {
      expect(taskExecute).not.toHaveBeenCalled();
      expect(policyEvaluation).not.toHaveBeenCalled();
      expect(JSON.stringify(requests.at(-1)!.input)).toContain(
        'The Tool arguments do not match the required schema.'
      );
    }
    if (mode === 'model-turns' || mode === 'tool-calls') {
      expect(ended.status).toBe('failed');
      expect(ended.error?.message).toBe(
        `Coordinator Turn did not finish: limit_reached (${mode === 'model-turns' ? 'model_turns' : 'tool_calls'}).`
      );
    }
    if (deadline) {
      expect(ended.status).toBe('failed');
      const sealed = new FsStore({ dataRoot: f.dataRoot }).getTurnById(ended.id);
      if (mode === 'provider-deadline')
        releaseProvider({
          id: 'late',
          object: 'response',
          output: [
            { type: 'message', content: [{ type: 'output_text', text: 'PRIVATE_LATE_PROVIDER' }] },
          ],
        });
      else
        releaseKnowledge({
          threadId: scope.threadId,
          turnId: ended.id,
          answer: 'PRIVATE_LATE_KNOWLEDGE',
          citations: [],
          uncertainty: null,
        });
      await vi.advanceTimersByTimeAsync(0);
      expect(new FsStore({ dataRoot: f.dataRoot }).getTurnById(ended.id)).toEqual(sealed);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect
        .soft(ended.error?.message)
        .toBe('Coordinator Turn did not finish: limit_reached (deadline).');
    }
    if (
      [
        'refused-dispatch',
        'recovery-required',
        'invalid-call',
        'unresolved-knowledge',
        'publication-retry',
      ].includes(mode)
    ) {
      const reopened = new FsStore({ dataRoot: f.dataRoot });
      const invoke = createOperationInvocation({
        coreDb,
        store: reopened,
        repositoryWorkspaceDb: (id) => openWorkspaceDb(f.dataRoot, id),
        inflightCommands,
        workspaceMutationAdmission: admission,
      });
      const read = await invoke(
        'turn.read',
        { workspaceId: scope.workspaceId, threadId: scope.threadId, turnId: ended.id },
        { kind: 'public', actor: f.actor }
      );
      const items = reopened
        .getTurnById(ended.id)
        .items.filter((item) => item.type === 'tool-call');
      expect(read).toMatchObject({ id: ended.id, items: expect.arrayContaining(items) });
      const expectedCalls = scripts
        .slice(0, mode === 'unresolved-knowledge' ? 1 : scripts.length)
        .flatMap((calls, index) =>
          calls.map((call, ordinal) => ({ ...call, callId: `current-${index}-${ordinal}` }))
        );
      expect(items.map((item) => item.tool)).toEqual(
        expectedCalls.map((call) => call.name.replaceAll('_', '.'))
      );
      for (const [index, item] of items.entries()) {
        expect(item.arguments).toEqual(JSON.parse(JSON.stringify(expectedCalls[index]!.args)));
        expect(item.causationId).toBe(expectedCalls[index]!.callId);
      }
      expect(
        reopened
          .listThreadItems(scope.workspaceId, scope.threadId)
          .filter((item) => item.type === 'tool-call' && item.causationId === 'previous-goal-read')
          .map((item) => item.id)
      ).toEqual(historicalIds);
      expect(items.some((item) => item.causationId === 'previous-goal-read')).toBe(false);
      const refused = items.find((item) => item.tool === 'goal.task.dispatch');
      if (refused) {
        expect(refused.status).toBe('failed');
        if (mode !== 'invalid-call') {
          const nativeResult = await taskExecute.mock.results[0]!.value;
          expect(refused.result).toBe(JSON.stringify(nativeResult.content));
        }
        const evidence = JSON.stringify({ result: refused.result, error: refused.error });
        expect(evidence).toContain(
          mode === 'recovery-required'
            ? 'recovery_required'
            : mode === 'invalid-call'
              ? 'The Tool arguments do not match the required schema.'
              : 'task_admission_failed'
        );
      }
      if (mode === 'publication-retry')
        expect(items[0]!.result).toContain('goal_domain_publication_failed');
      if (mode === 'unresolved-knowledge')
        expect(items).toEqual([
          expect.objectContaining({ tool: 'knowledge.ask', result: null, error: null }),
        ]);
    }
  } finally {
    fileFailure?.mockRestore();
    policyEvaluation.mockRestore();
    taskExecute.mockRestore();
    vi.useRealTimers();
  }
});

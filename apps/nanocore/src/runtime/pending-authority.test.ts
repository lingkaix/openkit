import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { WorkspaceMcpServerCatalog } from '@openkit/config-schema';
import { allocateEntityId, PolicyDocumentV1Schema } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { expect, it, onTestFinished, vi } from 'vitest';
import { isCanonicalUserActive } from '../auth/user-lifecycle.js';
import { listWorkspaceCapabilityCalls } from '../capability/usage-ledger.js';
import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import { FsStore } from '../lib/store.js';
import { createPendingRequestOperationImplementations } from '../pending-request-operations.js';
import { recordPolicyWriteDecision } from '../policy/configuration.js';
import { PolicyInterception } from '../policy/interception.js';
import {
  EMPTY_POLICY_DOCUMENT,
  policyDigest,
  preparePolicyDocument,
} from '../policy/statements.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { testGoalDomainProposal } from '../test-support/goal-domain.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { registerWorkerMcpRoutes, reviewCapturedMcpPolicy } from '../worker-mcp-routes.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { createWorkspaceSharingOperationImplementations } from '../workspace-sharing-operations.js';
import { recordAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import {
  evaluateCapturedPendingCall,
  executeCapturedPendingCall,
  prepareCapturedPendingCall,
} from './captured-pending-call.js';
import {
  acceptSchedulerExecutionObservation,
  schedulerExecutionCorrelation,
} from './execution-attempt-records.js';
import { executeGoalOperation, readGoalView } from './goal-owner.js';
import { recoverPendingRequestsAtBoot } from './pending-request-flow.js';
import { executionCallIdForRequest, readPendingRequest } from './pending-requests.js';
import type { WorkerControlGateway } from './worker-control-gateway.js';
import type { WorkerMcpGateway } from './worker-mcp-gateway.js';

const native = vi.hoisted(() => ({
  buffer: undefined as SharedArrayBuffer | undefined,
  worker: undefined as import('node:worker_threads').Worker | undefined,
  afterAcknowledgement: undefined as (() => void) | undefined,
}));

// Pass through every real SQLite statement and worker reply. The private observer identifies the
// writing connection; the fault holds only the real claim COMMIT's acknowledgement.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: WorkerOptions) {
        const prelude = `
          const {workerData,threadId}=require('node:worker_threads');
          const Database=require(workerData.databaseModule), state=new Int32Array(workerData.buffer);
          let claimed=false;
          const afterCommit=()=>{
            const committedClaim=claimed; claimed=false;
            if(!committedClaim || Atomics.compareExchange(state,0,1,0)!==1) return;
            Atomics.store(state,1,1);
            if(Atomics.wait(state,2,0,10000)==='timed-out') throw Error('Private claim ACK gate expired.');
          };
          const prepare=Database.prototype.prepare, exec=Database.prototype.exec;
          Database.prototype.prepare=function(sql){
            const db=this, stmt=prepare.call(this,sql), run=stmt.run;
            stmt.run=function(...args){
              const result=run.apply(this,args);
              if(result.changes && /^(?:INSERT(?: OR \\w+)? INTO|UPDATE|DELETE FROM)\\s+(?:main\\.)?["\\[]?pending_requests\\b/i.test(sql.trim())){
                Atomics.add(state,3,result.changes);
                const first=Atomics.compareExchange(state,9,0,threadId);
                if(first!==0 && first!==threadId) Atomics.store(state,10,1);
                if(prepare.call(db,"SELECT 1 FROM pending_requests WHERE claim='claimed' AND disposition IS NULL LIMIT 1").get()) claimed=true;
              }
              const family=/^(?:INSERT(?: OR \\w+)? INTO|UPDATE|DELETE FROM)\\s+(?:main\\.)?["\\[]?(capability_calls|permission_decisions|audit_events)\\b/i.exec(sql.trim())?.[1];
              if(result.changes && family){
                Atomics.or(state,5,1 << ['capability_calls','permission_decisions','audit_events'].indexOf(family.toLowerCase()));
                const first=Atomics.compareExchange(state,9,0,threadId);
                if(first!==0 && first!==threadId) Atomics.store(state,10,1);
              }
              if(result.changes && /^(?:INSERT(?: OR \\w+)? INTO|UPDATE)\\s+(?:main\\.)?["\\[]?idempotency_requests\\b/i.test(sql.trim()) &&
                prepare.call(db,"SELECT name FROM sqlite_master WHERE name='pending_requests'").get()){
                const rows=prepare.call(db,"SELECT p.claim,p.disposition FROM idempotency_requests i LEFT JOIN pending_requests p ON p.request_id=i.response_id WHERE i.command_name='approval.respond'").all();
                if(rows.length) Atomics.store(state,8,rows.length);
                if(rows.some(row=>row.claim!=='finished' || row.disposition===null)) Atomics.add(state,7,1);
              }
              if(/^COMMIT$/i.test(sql.trim())) afterCommit();
              return result;
            };
            return stmt;
          };
          Database.prototype.exec=function(sql){
            const result=exec.call(this,sql);
            if(/^COMMIT$/i.test(sql.trim())) afterCommit();
            return result;
          };
        `;
        super(
          prelude +
            (options?.eval ? String(filename) : `import(${JSON.stringify(String(filename))});`),
          {
            ...options,
            eval: true,
            workerData: {
              ...options?.workerData,
              buffer: native.buffer,
              databaseModule: createRequire(import.meta.url).resolve('better-sqlite3'),
            },
          }
        );
        native.worker = this;
      }

      override emit(event: string | symbol, ...args: unknown[]): boolean {
        const result = super.emit(event, ...args);
        if (
          event === 'message' &&
          native.buffer &&
          Atomics.load(new Int32Array(native.buffer), 1)
        ) {
          const action = native.afterAcknowledgement;
          native.afterAcknowledgement = undefined;
          // The actual ACK has reached its listener; its Promise continuation has not run.
          action?.();
        }
        return result;
      }
    },
  };
});

/** Private real stores and their normal lifetime; authority changes use the User command owner. */
async function fixture() {
  native.buffer = new SharedArrayBuffer(11 * Int32Array.BYTES_PER_ELEMENT);
  const state = new Int32Array(native.buffer);
  const prepare = Database.prototype.prepare;
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (sql) {
    const db = this;
    const statement = prepare.call(this, sql);
    const run = statement.run;
    statement.run = function (...args) {
      const result = run.apply(this, args);
      if (
        result.changes &&
        /^(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+(?:main\.)?["[]?pending_requests\b/i.test(
          sql.trim()
        )
      ) {
        Atomics.add(state, 4, result.changes);
      }
      const table =
        /^(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+(?:main\.)?["[]?(capability_calls|permission_decisions|audit_events)\b/i.exec(
          sql.trim()
        )?.[1];
      if (result.changes && table)
        Atomics.or(
          state,
          6,
          1 << ['capability_calls', 'permission_decisions', 'audit_events'].indexOf(table)
        );
      if (
        result.changes &&
        /^(?:INSERT(?: OR \w+)? INTO|UPDATE)\s+(?:main\.)?["[]?idempotency_requests\b/i.test(
          sql.trim()
        ) &&
        prepare.call(db, "SELECT name FROM sqlite_master WHERE name='pending_requests'").get()
      ) {
        const rows = prepare
          .call(
            db,
            "SELECT p.claim,p.disposition FROM idempotency_requests i LEFT JOIN pending_requests p ON p.request_id=i.response_id WHERE i.command_name='approval.respond'"
          )
          .all() as Array<{ claim: string; disposition: string | null }>;
        if (rows.length) Atomics.store(state, 8, rows.length);
        if (rows.some((row) => row.claim !== 'finished' || row.disposition === null))
          Atomics.add(state, 7, 1);
      }
      return result;
    };
    return statement;
  });
  const root = mkdtempSync(join(tmpdir(), 'pending-authority-'));
  const coreDb = openCoreDb(root);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot: root });
  const workspace = await store.createWorkspace('Pending authority');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const db = openWorkspaceDb(root, workspace.id);
  const databases = [db];
  const actor = { kind: 'local' as const, userId };
  const context = {
    kind: 'public' as const,
    actor,
    actorRef: { kind: 'user' as const, id: userId },
    scope: { kind: 'workspace' as const, workspaceId: workspace.id },
  };
  const sharing = createWorkspaceSharingOperationImplementations({
    coreDb,
    store,
    inflightCommands: new WeakMap(),
  });
  onTestFinished(async () => {
    Atomics.store(state, 2, 1);
    Atomics.notify(state, 2);
    await shutdownControlStoreWorkerClient();
    vi.restoreAllMocks();
    native.afterAcknowledgement = undefined;
    native.buffer = undefined;
    for (const database of databases) if (database.sqlite.open) database.sqlite.close();
    coreDb.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  const revoke = () =>
    sharing['user.disable']({ targetUserId: userId, requestId: randomUUID() }, context);
  const reopenWorkspace = () => {
    for (const database of databases) if (database.sqlite.open) database.sqlite.close();
    const reopened = openWorkspaceDb(root, workspace.id);
    databases.push(reopened);
    return reopened;
  };
  return { root, coreDb, store, workspace, db, actor, context, revoke, state, reopenWorkspace };
}

/** Captures and grants a real Coordinator Plan or completion, without terminal-history fabrication. */
async function goalFixture(
  operation: 'goal.plan.approve' | 'goal.completion.accept',
  supplied?: Awaited<ReturnType<typeof fixture>>
) {
  const f = supplied ?? (await fixture());
  const human = { actor: f.actor };
  const created = await executeGoalOperation(
    'goal.create',
    { workspaceId: f.workspace.id, requestId: randomUUID(), intent: 'Produce a design' },
    human,
    f.store,
    f.db,
    { coreDb: f.coreDb }
  );
  const goal = created.goal!;
  const scope = { workspaceId: f.workspace.id, threadId: goal.threadId, goalId: goal.goalId };
  const turn = await f.store.createTurn(
    scope.workspaceId,
    scope.threadId,
    'Coordinate the design',
    { kind: 'user', id: f.actor.userId },
    undefined,
    { executorKind: 'coordinator', agentId: 'goal-coordinator' }
  );
  const coordinator = { ...human, coordinatorTurnId: turn.id };
  const cards = await executeGoalOperation(
    'goal.card.create',
    { ...scope, requestId: randomUUID(), description: 'Design the schema', priority: 1 },
    human,
    f.store,
    f.db,
    { coreDb: f.coreDb }
  );
  const card = cards.cards[0]!;
  const proposed = await executeGoalOperation(
    'goal.plan.propose',
    {
      ...scope,
      requestId: randomUUID(),
      expectedRevision: cards.goal!.changeRevision,
      goalDomain: testGoalDomainProposal(scope.workspaceId, scope.goalId),
      commitment: {
        intentBasis: { revision: 0, intent: 'Produce a design' },
        cards: [{ cardId: card.cardId, revision: 0, description: card.description, priority: 1 }],
        permittedAdjustments: 'Refine the design',
        completionEvidence: ['Reviewed design'],
        boundaries: 'No deployment',
      },
    },
    coordinator,
    f.store,
    f.db,
    { coreDb: f.coreDb }
  );
  const plan = proposed.versions.at(-1)!;
  let pendingRequestId = plan.pendingRequestId;
  const planInput = { ...scope, pendingRequestId, decision: 'granted' as const };
  await executeGoalOperation(
    'goal.plan.approve',
    { ...planInput, requestId: randomUUID() },
    human,
    f.store,
    f.db,
    { coreDb: f.coreDb }
  );
  if (operation === 'goal.completion.accept') {
    await executeGoalOperation(
      'goal.plan.approve',
      { ...planInput, requestId: randomUUID() },
      coordinator,
      f.store,
      f.db,
      { coreDb: f.coreDb }
    );
    const completion = await executeGoalOperation(
      operation,
      {
        ...scope,
        requestId: randomUUID(),
        candidate: {
          intentRevision: 0,
          intent: 'Produce a design',
          planVersionId: plan.planVersionId,
          evidence: [],
          unresolvedWork: ['Human review remains'],
          summary: 'Review this exact candidate.',
        },
      },
      coordinator,
      f.store,
      f.db,
      { coreDb: f.coreDb }
    );
    pendingRequestId = completion.requests.find((row) => row.operation === operation)!.requestId;
    await executeGoalOperation(
      operation,
      { ...scope, requestId: randomUUID(), pendingRequestId, decision: 'granted' },
      human,
      f.store,
      f.db,
      { coreDb: f.coreDb }
    );
  }
  expect(readPendingRequest(f.db.sqlite, pendingRequestId)).toMatchObject({
    resolution: 'granted',
    claim: 'unclaimed',
    disposition: null,
  });
  const input = {
    ...scope,
    requestId: randomUUID(),
    pendingRequestId,
    decision: 'granted' as const,
  };
  const consume = () =>
    executeGoalOperation(operation, input, coordinator, f.store, f.db, { coreDb: f.coreDb });
  return { ...f, scope, human, input, consume, pendingRequestId, plan };
}

for (const operation of ['goal.plan.approve', 'goal.completion.accept'] as const) {
  it(`${operation} sees revocation committed during preparation before its native post`, async () => {
    const f = await goalFixture(operation);
    const client = getControlStoreWorkerClient();
    const open = client.open.bind(client);
    let changed = false;
    // Real asynchronous database preparation completes before the Main submission check.
    vi.spyOn(client, 'open').mockImplementationOnce(async (input) => {
      await open(input);
      await f.revoke();
      changed = true;
    });
    await expect(f.consume()).rejects.toMatchObject({ code: 'grant_conflict' });
    expect(changed).toBe(true);
    const current = readGoalView(f.store, f.db, f.scope.goalId);
    expect(current.goal!.activePlanVersionId).toBe(
      operation === 'goal.plan.approve' ? null : f.plan.planVersionId
    );
    expect(current.goal!.disposition).toBeNull();
    expect(readPendingRequest(f.db.sqlite, f.pendingRequestId)).toMatchObject({
      claim: 'unclaimed',
      disposition: 'denied-not-executed',
      dispositionReason: 'The deciding actor is no longer authorized.',
    });
    expect(
      f.db.sqlite
        .prepare('SELECT request_id FROM idempotency_requests WHERE request_id=?')
        .all(f.input.requestId)
    ).toEqual([]);
  });

  it(`${operation} remains admitted when revocation commits after its native post`, async () => {
    const f = await goalFixture(operation);
    const post = Worker.prototype.postMessage;
    let revocation: ReturnType<typeof f.revoke> | undefined;
    vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (value, transfer) {
      post.call(this, value, transfer);
      if (
        value.operation === 'goal' &&
        value.input.command.arguments.requestId === f.input.requestId
      ) {
        revocation = f.revoke();
      }
    });
    Atomics.store(f.state, 0, 1);
    const consuming = f.consume();
    // This ordinary Goal consumption also calibrates the claim COMMIT observer and ACK fault.
    await expect.poll(() => Atomics.load(f.state, 1), { timeout: 5000 }).toBe(1);
    expect(readPendingRequest(f.db.sqlite, f.pendingRequestId)).toMatchObject({
      claim: 'finished',
      disposition: 'approved-executed',
    });
    Atomics.store(f.state, 2, 1);
    Atomics.notify(f.state, 2);
    const result = await consuming;
    expect(revocation, 'The real command must be posted before revocation.').toBeDefined();
    await revocation;
    expect(result.goal!.activePlanVersionId).toBe(f.plan.planVersionId);
    expect(result.goal!.disposition?.kind ?? null).toBe(
      operation === 'goal.completion.accept' ? 'accepted' : null
    );
    expect(readPendingRequest(f.db.sqlite, f.pendingRequestId)).toMatchObject({
      claim: 'finished',
      disposition: 'approved-executed',
    });
    expect(
      f.db.sqlite
        .prepare('SELECT request_id FROM idempotency_requests WHERE request_id=?')
        .all(f.input.requestId)
    ).toEqual([{ request_id: f.input.requestId }]);
  });
}

it('a Goal cancellation committed before the consuming native CAS prevents the captured effect', async () => {
  const f = await goalFixture('goal.plan.approve');
  const client = getControlStoreWorkerClient();
  const open = client.open.bind(client);
  let cancellation: Awaited<ReturnType<typeof executeGoalOperation>> | undefined;
  vi.spyOn(client, 'open').mockImplementationOnce(async (input) => {
    await open(input);
    cancellation = await executeGoalOperation(
      'goal.cancel',
      {
        ...f.scope,
        requestId: randomUUID(),
        expectedRevision: readGoalView(f.store, f.db, f.scope.goalId).goal!.changeRevision,
        reason: 'The owner withdrew the design.',
      },
      f.human,
      f.store,
      f.db,
      { coreDb: f.coreDb }
    );
  });
  await expect(f.consume()).rejects.toMatchObject({ code: 'grant_conflict' });
  expect(cancellation!.goal!.disposition?.kind).toBe('cancelled');
  expect(readGoalView(f.store, f.db, f.scope.goalId).goal!.activePlanVersionId).toBeNull();
  expect(readPendingRequest(f.db.sqlite, f.pendingRequestId)).toMatchObject({
    claim: 'unclaimed',
    disposition: 'denied-not-executed',
  });
  expect(
    f.db.sqlite
      .prepare('SELECT request_id FROM idempotency_requests WHERE request_id=?')
      .all(f.input.requestId)
  ).toEqual([]);
});

/** Real MCP capture, Policy pipeline, Pending command and capability owners; only the remote Tool is a stand-in. */
async function capturedFixture() {
  const f = await fixture();
  const thread = await f.store.createThread(f.workspace.id, 'Captured operation');
  const setup = createTestAgentSetup({ agentId: 'agent_demo', mcpIds: ['echo-server'] });
  const catalog: WorkspaceMcpServerCatalog = {
    schemaVersion: 1,
    servers: [
      {
        id: 'echo-server',
        enabled: true,
        allowedTools: ['echo'],
        credentialBindings: [],
        pinnedSchemaSnapshotId: null,
        schemaPolicy: 'tracking',
        timeoutMs: 2000,
        transport: { kind: 'stdio', command: process.execPath, args: [], environment: {} },
      },
    ],
  };
  const turn = await f.store.createTurn(
    f.workspace.id,
    thread.id,
    'Capture an exact effect',
    { kind: 'user', id: f.actor.userId },
    null,
    { agentId: setup.manifest.id }
  );
  const environmentPackage = resolveAgentEnvironmentPackage({
    coreDb: f.coreDb,
    agentSetup: setup,
    agentSessionId: allocateEntityId('as'),
    backend: { kind: 'openshell' },
    createdAt: turn.startedAt!,
    requestId: randomUUID(),
    triggerActor: turn.triggerActor,
    turn,
    workspaceCwd: '/workspace',
    workspaceMcpServerCatalog: catalog,
    workspaceRoots: [],
  });
  const scope = environmentPackage.scope;
  await f.store.createAgentSession({
    id: scope.agentSessionId,
    agentId: setup.manifest.id,
    workspaceId: f.workspace.id,
    threadId: thread.id,
    status: 'busy',
    message: null,
    createdAt: turn.startedAt!,
    updatedAt: turn.startedAt!,
  });
  await f.store.updateTurn(turn.id, { agentSessionId: scope.agentSessionId, status: 'running' });
  const entry = createSchedulerAdmissionEntry(f.coreDb, {
    backendId: 'nanohost',
    queueEntryId: randomUUID(),
    requestId: scope.requestId,
    triggerActor: scope.triggerActor,
    workspaceId: f.workspace.id,
    threadId: thread.id,
    turnId: turn.id,
    turnInput: 'Capture echo',
    requestedAgentId: setup.manifest.id,
  });
  const attempt = recordTestExecutionAttempt(f.coreDb, {
    entry,
    attemptId: allocateEntityId('attempt'),
    agentSessionId: scope.agentSessionId,
    inputRef: environmentPackage.snapshotId,
    bindingRef: 'captured-binding',
    sessionCompatibilityKey: 'captured-operation',
    now: () => new Date().toISOString(),
    operationId: randomUUID(),
  });
  expect(
    acceptSchedulerExecutionObservation(f.coreDb, {
      ...schedulerExecutionCorrelation(attempt),
      disposition: 'accepted',
      execution: 'running',
      fenceRef: null,
      outcomeRef: null,
    })
  ).not.toBeNull();
  recordAgentEnvironmentPackageSnapshot(f.db, { environmentPackage, createdAt: turn.startedAt! });
  const principal = { kind: 'human' as const, id: f.actor.userId };
  const policyScope = {
    subjects: [principal],
    actions: ['tool.use'],
    resources: [
      { kind: 'mcp-tool', workspaceId: f.workspace.id, serverId: 'echo-server', toolName: 'echo' },
    ],
  };
  const policy = preparePolicyDocument({
    current: EMPTY_POLICY_DOCUMENT,
    userId: f.actor.userId,
    now: new Date().toISOString(),
    proposed: PolicyDocumentV1Schema.parse({
      schemaVersion: 1,
      statements: [
        {
          id: 'capture-gate',
          kind: 'binding',
          author: principal,
          authority: { kind: 'human', userId: f.actor.userId },
          authoredAt: new Date().toISOString(),
          scope: policyScope,
          lifetime: {
            anchor: {
              owner: { kind: 'workspace', workspaceId: f.workspace.id },
              kind: 'workspace',
              id: f.workspace.id,
            },
          },
          state: 'active',
          operation: 'mcp.call-tool',
          stage: 'decide',
          mode: 'gate',
          participant: {
            kind: 'deterministic',
            id: 'capture-gate',
            version: `sha256:${'c'.repeat(64)}`,
          },
          inputDisclosure: policyScope,
          order: 0,
          timeoutMs: 10000,
          circuit: { failures: 1, recoveryAfterMs: 1 },
        },
      ],
    }),
  });
  recordPolicyWriteDecision({
    coreDb: f.coreDb,
    actor: f.actor,
    candidate: { artifactId: allocateEntityId('ar'), contentDigest: policyDigest(policy.document) },
    proposal: {
      schemaVersion: 1,
      proposer: principal,
      rationale: 'Review the captured Tool.',
      baseRevision: policyDigest(EMPTY_POLICY_DOCUMENT),
      proposed: policy.document,
      diff: policy.diff,
      classification: policy.classification,
      validation: 'valid',
    },
    requestId: randomUUID(),
    threadId: thread.id,
    turnId: turn.id,
  });
  let gate: 'escalate' | 'allow' = 'escalate';
  const interception = new PolicyInterception({
    id: 'capture-gate',
    version: `sha256:${'c'.repeat(64)}`,
    invoke: async () => ({ decision: gate }),
  });
  const callTool = vi.fn<WorkerMcpGateway['callTool']>().mockResolvedValue({
    content: [{ type: 'text', text: 'Effect completed' }],
    isError: false,
  });
  const gateway: WorkerMcpGateway = {
    callTool,
    listTools: async () => ({
      serverVersion: 'fixture',
      tools: [
        {
          name: 'echo',
          inputSchema: {
            type: 'object',
            properties: { message: { type: 'string' } },
            required: ['message'],
            additionalProperties: false,
          },
        },
      ],
    }),
    close: async () => {},
    closeServer: async () => {},
    closeServerIfIdle: async () => {},
    closeWorkspace: async () => {},
    getServerHealth: () => 'ready',
  };
  const base = createInMemoryRuntimeConfigSnapshot({
    dataRoot: f.root,
    agentManifests: [setup.manifest],
  });
  const app = new Hono();
  const routes = {
    app,
    coreDb: f.coreDb,
    store: f.store,
    interception,
    workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    workerMcpGateway: gateway,
    workerControlGateway: {
      authenticatePackageToken: () => environmentPackage,
    } as unknown as WorkerControlGateway,
    runtimeConfig: () =>
      createInMemoryRuntimeConfigSnapshot({
        dataRoot: f.root,
        agentManifests: [setup.manifest],
        openKitConfig: {
          ...base.openKitConfig,
          policy: { ...base.openKitConfig.policy, mediation: policy.document },
        },
        workspaceMcpServerCatalogs: [
          { workspaceId: f.workspace.id, path: 'fixture-catalog', catalog },
        ],
      }),
  };
  registerWorkerMcpRoutes(routes);
  const caller = new Client({ name: 'pending-authority', version: '1.0.0' });
  await caller.connect(
    new StreamableHTTPClientTransport(
      new URL('http://nanocore.test/api/worker-capabilities/mcp/echo-server'),
      {
        fetch: (request, init) => app.fetch(new Request(request, init)),
        requestInit: { headers: { authorization: 'Bearer private-fixture-package' } },
      }
    )
  );
  onTestFinished(() => caller.close());
  await caller.listTools();
  const captured = await caller.callTool({ name: 'echo', arguments: { message: 'approved' } });
  expect(captured).toMatchObject({
    isError: true,
    structuredContent: { status: 'pending-approval' },
  });
  const requestId = String(captured.structuredContent!.requestId);
  const record = readPendingRequest(f.db.sqlite, requestId)!;
  expect(record).toMatchObject({ claim: 'unclaimed', policyDecisionId: expect.any(String) });
  gate = 'allow';
  let afterPreparation: (() => Promise<void>) | undefined;
  const compose = (store = f.store) =>
    createPendingRequestOperationImplementations({
      coreDb: f.coreDb,
      store,
      inflightCommands: new WeakMap(),
      repositoryWorkspaceDb: (id) => openWorkspaceDb(f.root, id),
      prepareCapturedCall: async (record, workspaceDb, actor) => {
        const prepared = await prepareCapturedPendingCall({
          actor,
          record,
          catalog,
          coreDb: f.coreDb,
          vaultBackend: undefined,
          workerMcpGateway: gateway,
          workspaceDb,
          reviewPolicy: () =>
            reviewCapturedMcpPolicy({ record, actor, workspaceDb, routes, catalog, interception }),
        });
        expect(prepared.failed).toBe(false);
        await afterPreparation?.();
        return prepared;
      },
      evaluateCapturedCall: (record, sqlite, prepared) =>
        evaluateCapturedPendingCall({
          manifest: setup.manifest,
          catalog,
          coreDb: f.coreDb,
          record,
          sqlite,
          prepared,
        }),
      executeCapturedCall: (record, _actor, workspaceDb, prepared, executionCall) =>
        executeCapturedPendingCall({
          catalog,
          coreDb: f.coreDb,
          record,
          workspaceDb,
          prepared,
          executionCall,
          workerMcpGateway: gateway,
        }),
    });
  const operations = compose();
  const input = {
    workspaceId: f.workspace.id,
    threadId: thread.id,
    turnId: turn.id,
    approvalRequestId: requestId,
    requestId: randomUUID(),
    decision: 'granted' as const,
  };
  const grant = (requestId = input.requestId, store = f.store) =>
    (store === f.store ? operations : compose(store))['approval.respond'](
      { ...input, requestId },
      f.context
    );
  return {
    ...f,
    thread,
    turn,
    record,
    input,
    grant,
    operations,
    callTool,
    afterPreparation: (action: () => Promise<void>) => {
      afterPreparation = action;
    },
  };
}

it('keeps CapabilityCall, PermissionDecision and Audit on the native writer while completing one captured call', async () => {
  const f = await capturedFixture();
  Atomics.store(f.state, 5, 0);
  Atomics.store(f.state, 6, 0);
  await f.grant();
  expect(f.callTool).toHaveBeenCalledTimes(1);
  expect(readPendingRequest(f.db.sqlite, f.record.requestId)).toMatchObject({
    claim: 'finished',
    disposition: 'approved-executed',
  });
  const call = listWorkspaceCapabilityCalls(f.db, f.workspace.id).find(
    (row) => row.id === executionCallIdForRequest(f.record.requestId)
  );
  expect(call).toMatchObject({ status: 'succeeded', requestId: f.input.requestId });
  const decisions = f.db.sqlite
    .prepare(
      'SELECT decision_id,audit_event_id,context_summary_json FROM permission_decisions WHERE approval_id=? AND result=?'
    )
    .all(f.record.requestId, 'allow') as Array<{
    decision_id: string;
    audit_event_id: string;
    context_summary_json: string;
  }>;
  expect(decisions).toHaveLength(1);
  expect(JSON.parse(decisions[0]!.context_summary_json)).toMatchObject({
    capabilityCallId: call!.id,
  });
  expect(
    f.db.sqlite
      .prepare('SELECT audit_event_id FROM audit_events WHERE audit_event_id=?')
      .all(decisions[0]!.audit_event_id)
  ).toEqual([{ audit_event_id: decisions[0]!.audit_event_id }]);
  expect(
    f.db.sqlite
      .prepare(
        "SELECT action FROM audit_events WHERE capability_call_id=? AND action='capability.admit'"
      )
      .all(call!.id)
  ).toEqual([{ action: 'capability.admit' }]);
  expect(Atomics.load(f.state, 6), 'None of these Workspace families may write on Main.').toBe(0);
  expect(Atomics.load(f.state, 5), 'All three actual native SQL families must write.').toBe(7);
  expect(
    Atomics.load(f.state, 10),
    'The complete Workspace tuple must have one native writer.'
  ).toBe(0);
  expect(Atomics.load(f.state, 8), 'The real original receipt write must be observed.').toBe(1);
  expect(Atomics.load(f.state, 7), 'No receipt may precede its owned disposition.').toBe(0);
  expect(
    f.db.sqlite
      .prepare('SELECT request_id FROM idempotency_requests WHERE request_id=?')
      .all(f.input.requestId)
  ).toEqual([{ request_id: f.input.requestId }]);
});

/** Waits for a committed native claim, or for the operation to expose the missing native boundary. */
async function heldClaim(f: Awaited<ReturnType<typeof capturedFixture>>) {
  Atomics.store(f.state, 0, 1);
  Atomics.store(f.state, 4, 0);
  let settled = false;
  const result = f
    .grant()
    .then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error })
    )
    .finally(() => {
      settled = true;
    });
  onTestFinished(async () => {
    Atomics.store(f.state, 2, 1);
    Atomics.notify(f.state, 2);
    await result;
  });
  await expect.poll(() => Atomics.load(f.state, 1) === 1 || settled).toBe(true);
  expect(
    {
      nativeClaimCommitted: Atomics.load(f.state, 1),
      contactsBeforeAcknowledgement: f.callTool.mock.calls.length,
      mainPendingWrites: Atomics.load(f.state, 4),
    },
    'A captured call must wait for its real native claim ACK before Main effect admission.'
  ).toEqual({
    nativeClaimCommitted: 1,
    contactsBeforeAcknowledgement: 0,
    mainPendingWrites: 0,
  });
  expect(readPendingRequest(f.db.sqlite, f.record.requestId)).toMatchObject({
    claim: 'claimed',
    disposition: null,
  });
  expect(
    listWorkspaceCapabilityCalls(f.db, f.workspace.id).filter(
      (call) => call.id === executionCallIdForRequest(f.record.requestId)
    )
  ).toEqual([]);
  expect(
    f.db.sqlite
      .prepare('SELECT request_id FROM idempotency_requests WHERE request_id=?')
      .all(f.input.requestId)
  ).toEqual([]);
  return { result };
}

it('revocation after claim ACK gives the exact no-contact failure before the original receipt, without retry', async () => {
  const f = await capturedFixture();
  const held = await heldClaim(f);
  let revocation: ReturnType<typeof f.revoke> | undefined;
  native.afterAcknowledgement = () => {
    revocation = f.revoke();
    expect(isCanonicalUserActive(f.coreDb, f.actor.userId)).toBe(false);
  };
  Atomics.store(f.state, 2, 1);
  Atomics.notify(f.state, 2);
  const result = await held.result;
  await revocation;
  expect(revocation).toBeDefined();
  expect(result.error).toBeUndefined();
  expect(f.callTool).not.toHaveBeenCalled();
  const completed = readPendingRequest(f.db.sqlite, f.record.requestId);
  expect(completed).toMatchObject({
    claim: 'finished',
    disposition: 'execution-error',
    dispositionReason: 'membership-revoked',
  });
  const calls = listWorkspaceCapabilityCalls(f.db, f.workspace.id).filter(
    (call) => call.id === executionCallIdForRequest(f.record.requestId)
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    status: 'failed',
    errorCode: 'membership-revoked',
    upstreamContacted: false,
  });
  expect(
    f.db.sqlite
      .prepare('SELECT usage_id FROM usage_records WHERE capability_call_id=?')
      .all(calls[0]!.id)
  ).toEqual([]);
  expect(
    f.db.sqlite
      .prepare('SELECT request_id FROM idempotency_requests WHERE request_id=?')
      .all(f.input.requestId)
  ).toEqual([{ request_id: f.input.requestId }]);
  expect(Atomics.load(f.state, 8)).toBe(1);
  expect(Atomics.load(f.state, 7)).toBe(0);
  await f.grant();
  await f.grant(randomUUID()).catch(() => undefined);
  expect(f.callTool).not.toHaveBeenCalled();
  expect(readPendingRequest(f.db.sqlite, f.record.requestId)).toEqual(completed);
  expect(
    listWorkspaceCapabilityCalls(f.db, f.workspace.id).filter((call) => call.id === calls[0]!.id)
  ).toEqual(calls);
});

it('lost claim ACK before Main admission recovers as outcome-unknown with proved no contact and never executes again', async () => {
  const f = await capturedFixture();
  const held = await heldClaim(f);
  await native.worker!.terminate();
  const result = await held.result;
  expect(result.error).toBeDefined();
  await shutdownControlStoreWorkerClient();
  const coldDb = f.reopenWorkspace();
  const reopened = new FsStore({ dataRoot: f.root });
  Atomics.store(f.state, 4, 0);
  await recoverPendingRequestsAtBoot(reopened, {
    coreDb: f.coreDb,
    openWorkspace: (id) => openWorkspaceDb(f.root, id),
  });
  expect(readPendingRequest(coldDb.sqlite, f.record.requestId)).toMatchObject({
    claim: 'finished',
    disposition: 'outcome-unknown',
    dispositionReason: 'restart',
  });
  // Absence at the held ACK proved no contact. Recovery may retain that absence or record the
  // original call, but it must not invent contact, usage or a second execution identity.
  const calls = listWorkspaceCapabilityCalls(coldDb, f.workspace.id).filter(
    (call) => call.id === executionCallIdForRequest(f.record.requestId)
  );
  expect(calls.length).toBeLessThanOrEqual(1);
  for (const call of calls) {
    expect(call).toMatchObject({ upstreamContacted: false });
    expect(['failed', 'unknown']).toContain(call.status);
  }
  expect(
    coldDb.sqlite
      .prepare('SELECT usage_id FROM usage_records WHERE capability_call_id=?')
      .all(executionCallIdForRequest(f.record.requestId))
  ).toEqual([]);
  await f.grant(f.input.requestId, reopened).catch(() => undefined);
  await f.grant(randomUUID(), reopened).catch(() => undefined);
  expect(f.callTool).not.toHaveBeenCalled();
  expect(
    listWorkspaceCapabilityCalls(coldDb, f.workspace.id).filter(
      (call) => call.id === executionCallIdForRequest(f.record.requestId)
    )
  ).toEqual(calls);
  expect(readPendingRequest(coldDb.sqlite, f.record.requestId)).toMatchObject({
    claim: 'finished',
    disposition: 'outcome-unknown',
  });
  expect(Atomics.load(f.state, 4), 'Recovery and replay retain the native Pending row owner.').toBe(
    0
  );
});

it('withdrawal committed during captured-call preparation wins before claim and prevents every effect', async () => {
  const f = await capturedFixture();
  let withdrawn = false;
  f.afterPreparation(async () => {
    await f.operations['pending-request.withdraw'](
      {
        workspaceId: f.workspace.id,
        threadId: f.thread.id,
        pendingRequestId: f.record.requestId,
        requestId: randomUUID(),
      },
      f.context
    );
    withdrawn = true;
  });
  await f.grant();
  expect(withdrawn).toBe(true);
  expect(f.callTool).not.toHaveBeenCalled();
  expect(readPendingRequest(f.db.sqlite, f.record.requestId)).toMatchObject({
    state: 'ended',
    ending: 'withdrawn',
    claim: 'unclaimed',
    disposition: null,
  });
  expect(
    listWorkspaceCapabilityCalls(f.db, f.workspace.id).filter(
      (call) => call.id === executionCallIdForRequest(f.record.requestId)
    )
  ).toEqual([]);
});

it('uses one native Pending row writer for Goal consumption and captured-call claim and disposition', async () => {
  const captured = await capturedFixture();
  const goal = await goalFixture('goal.plan.approve', captured);
  Atomics.store(captured.state, 3, 0);
  Atomics.store(captured.state, 4, 0);
  await goal.consume();
  expect(readPendingRequest(goal.db.sqlite, goal.pendingRequestId)).toMatchObject({
    claim: 'finished',
    disposition: 'approved-executed',
  });
  const goalWrites = Atomics.load(captured.state, 3);
  expect(
    goalWrites,
    'The real Goal claim and disposition must reach native SQLite.'
  ).toBeGreaterThan(0);
  await captured.grant();
  expect(captured.callTool).toHaveBeenCalledTimes(1);
  expect(readPendingRequest(captured.db.sqlite, captured.record.requestId)).toMatchObject({
    claim: 'finished',
    disposition: 'approved-executed',
  });
  expect(
    {
      capturedUsesNativeOwner: Atomics.load(captured.state, 3) > goalWrites,
      mainPendingWrites: Atomics.load(captured.state, 4),
    },
    'Both complete Pending transitions must use the native row owner.'
  ).toEqual({
    capturedUsesNativeOwner: true,
    mainPendingWrites: 0,
  });
  expect(Atomics.load(captured.state, 9)).toBeGreaterThan(0);
  expect(Atomics.load(captured.state, 10), 'The same Workspace must have one native writer.').toBe(
    0
  );
});

// openkit-test-platform: posix
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NON_API_EXPOSURE_DEFINITIONS, OPERATION_REGISTRY } from '@openkit/app-api-schemas';
import { allocateEntityId, type PolicyDocumentV1, PolicyDocumentV1Schema } from '@openkit/protocol';
import { Hono } from 'hono';
import { describe, expect, it, onTestFinished } from 'vitest';
import { WorkerControlClient } from '../../../../packages/worker-shim/src/control-client.js';
import { createApp, createDefaultWorkerControlGateway } from '../app.js';
import {
  createOpenKitAccessTokenRecord,
  resolveSessionDeploymentAdminTokenId,
} from '../auth/access-token-store.js';
import { createBetterAuth } from '../auth/better-auth.js';
import type { Actor } from '../auth/identity.js';
import { type AuthVariables, createAuthMiddleware } from '../auth/middleware.js';
import {
  currentSchedulerAdmissionWorkspaceAuthority,
  currentWorkerLineageWorkspaceAuthority,
  evaluateProductAuthorization,
} from '../auth/operation-authorizer.js';
import { isCanonicalUserActive } from '../auth/user-lifecycle.js';
import { createAdministrationConfiguration } from '../config/administration-configuration.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import { readAdmittedPolicyDocument } from '../policy/configuration.js';
import { PolicyInterception } from '../policy/interception.js';
import { listExportableWorkspacePermissionDecisions } from '../policy/permission-decisions.js';
import { recordAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import {
  admitCapturedPendingCall,
  evaluateCapturedPendingCall,
  executeCapturedPendingCall,
  prepareCapturedPendingCall,
} from '../runtime/captured-pending-call.js';
import {
  acceptSchedulerExecutionObservation,
  schedulerExecutionCorrelation,
} from '../runtime/execution-attempt-records.js';
import {
  readCurrentMcpToolSchemaSnapshot,
  readMcpToolDefinitionAdmission,
} from '../runtime/mcp-tool-schema-snapshots.js';
import { respondRecordedApproval } from '../runtime/pending-request-flow.js';
import { readPendingRequest } from '../runtime/pending-requests.js';
import { hashWorkerRouteToken } from '../runtime/worker-control-gateway.js';
import type { WorkerMcpGateway } from '../runtime/worker-mcp-gateway.js';
import {
  createSchedulerAdmissionEntry,
  requireSchedulerAdmissionEntry,
} from '../scheduler-records.js';
import { closeWorkspaceProductReadHandles } from '../storage/control-store-product-records.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openAdmittedTestNanoHost } from '../test-support/admitted-nanohost.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { submitTestNanoHostWorkerLease } from '../test-support/nanohost-worker-lease.js';
import { createNativeCommandTurn } from '../test-support/native-task-admission.js';
import { operationRequest } from '../test-support/operation-request.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { schedulerFixtureInput } from '../test-support/scheduler-admissions.js';
import {
  closeTestCoreDb,
  createTestCoreDb,
  createTestStore,
  createTestWorkspaceDb,
  disposeTestStore,
} from '../test-support/store.js';
import { registerWorkerMcpRoutes, reviewCapturedMcpPolicy } from '../worker-mcp-routes.js';

const BASE = 'http://localhost:3000';
const GROUP = 'llm-gateway';
const EXPIRY = '2999-01-01T00:00:00.000Z';

/** The landed A control; H identifies the real author, never every evaluated caller. */
function control(human: string, state: 'active' | 'inactive' = 'active', group = GROUP) {
  return {
    id: 'runtime-gateway-control',
    kind: 'permission' as const,
    state,
    author: { kind: 'human' as const, id: human },
    authority: { kind: 'human' as const, userId: human },
    authoredAt: '2026-01-01T00:00:00.000Z',
    effect: 'prohibit' as const,
    grant: { kind: 'ordinary' as const },
    scope: {
      subjects: [{ kind: 'human' as const, id: human }],
      actions: ['workspace.configure'],
      resources: [
        {
          kind: 'container' as const,
          container: {
            owner: { kind: 'server' as const },
            kind: 'route-group-switch',
            id: group,
          },
        },
      ],
    },
    lifetime: {
      anchor: {
        owner: { kind: 'server' as const },
        kind: 'server',
        id: 'server',
      },
    },
  };
}
function document(...statements: unknown[]): PolicyDocumentV1 {
  return PolicyDocumentV1Schema.parse({ schemaVersion: 1, statements });
}

/** Real SDK/Token/auth/configuration/native owners. No Provider or invented Actor/Kernel. */
async function fixture(
  serverConfig: Record<string, unknown> = {},
  createOptions: (
    coreDb: ReturnType<typeof createTestCoreDb>,
    nanoHostStorage: Awaited<ReturnType<typeof openAdmittedTestNanoHost>>
  ) => Partial<Parameters<typeof createApp>[0]> = () => ({})
) {
  const pending: Promise<unknown>[] = [];
  const releases: Array<() => void> = [];
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-e13-runtime-'));
  let coreDb = createTestCoreDb(dataRoot);
  let workspaceReaders: ReturnType<typeof createTestWorkspaceDb>[] = [];
  onTestFinished(async () => {
    for (const release of releases) release();
    await Promise.allSettled(pending);
    await disposeTestStore(dataRoot, ...workspaceReaders, coreDb);
  });
  ensureLocalUser(coreDb); // initialization only; no local Actor is ever used
  // Boot admits the NanoHost owner before the Worker control gateway is built (`app.ts`).
  const nanoHostStorage = await openAdmittedTestNanoHost(coreDb);
  let auth = createBetterAuth(coreDb, { env: { BETTER_AUTH_URL: BASE } });
  async function human(label: string, administrator: boolean) {
    const response = await auth.handler(
      new Request(`${BASE}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { origin: BASE, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: label,
          email: `${label}@example.test`,
          password: 'synthetic-e13-runtime-password',
        }),
      })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(typeof body.user?.id).toBe('string');
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    expect(cookie.length).toBeGreaterThan(0);
    const bootstrap = administrator
      ? createOpenKitAccessTokenRecord(coreDb, {
          ownerUserId: body.user.id,
          scope: 'server-admin',
          workspaceIds: [],
          expiresAt: EXPIRY,
        })
      : null;
    return { userId: body.user.id as string, cookie, bootstrap };
  }
  const first = await human('runtime-first', true);
  const second = await human('runtime-second', true);
  const ordinary = await human('runtime-ordinary', false);
  expect(new Set([first.userId, second.userId, ordinary.userId]).size).toBe(3);
  mkdirSync(join(dataRoot, 'config'), { recursive: true });
  writeFileSync(
    join(dataRoot, 'config/server.jsonc'),
    JSON.stringify({
      schemaVersion: 1,
      ...serverConfig,
      policy: { mediation: document() },
    })
  );
  writeFileSync(
    join(dataRoot, 'config/gateway.jsonc'),
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      logicalModels: [],
      requiredFeatures: [],
    })
  );

  async function graph() {
    const store = createTestStore({ dataRoot });
    const manager = createRuntimeConfigManager({ dataRoot });
    expect(manager.current().gatewayConfig.logicalModels).toEqual([]);
    const authentication = new Hono<{ Variables: AuthVariables }>();
    authentication.use(
      createAuthMiddleware('server', auth, {
        coreDb,
        canonicalUserActive: (id) => isCanonicalUserActive(coreDb, id),
        sessionDeploymentAdmin: (id) => resolveSessionDeploymentAdminTokenId(coreDb, id),
      })
    );
    authentication.get('/api/e13-fixture-identity', (c) => c.json(c.get('actor')));
    const accounts = [];
    for (const human of [first, second, ordinary]) {
      const response = await authentication.request(`${BASE}/api/e13-fixture-identity`, {
        headers: { cookie: human.cookie },
      });
      expect(response.status).toBe(200);
      const actor = (await response.json()) as Actor;
      expect(actor).toMatchObject({ kind: 'session', userId: human.userId });
      if (actor.kind !== 'session') throw new Error('Expected the actual SDK session Actor.');
      // H1's real Home is needed by the original personal-Tool control. Other
      // management scopes, and every Thread/Turn/service, open only when invoked.
      let home =
        human.userId === first.userId
          ? await store.ensureQuickChatWorkspace(human.userId)
          : undefined;
      let files: RuntimeConfigFileService | undefined;
      let opened: ReturnType<typeof openManagement> | undefined;
      async function openManagement() {
        home ??= await store.ensureQuickChatWorkspace(human.userId);
        const ownedHome = home;
        const thread = await store.createThread(
          ownedHome.id,
          'Native E13 review',
          allocateEntityId('th'),
          'administration',
          { visibility: 'private', privateOwnerUserId: human.userId }
        );
        const turn = await store.createTurn(
          ownedHome.id,
          thread.id,
          'Review this exact exposure change.',
          { kind: 'user', id: human.userId },
          null
        );
        const ownedFiles = new RuntimeConfigFileService({
          dataRoot,
          userId: human.userId,
          workspaceIds: [ownedHome.id, workspace.id],
          runtimeConfigManager: manager,
          readRuntimeConfigStatus: () => manager.status(),
        });
        files = ownedFiles;
        const readers = new Map<string, ReturnType<typeof createTestWorkspaceDb>>();
        const service = createAdministrationConfiguration({
          actor,
          coreDb,
          store,
          files: ownedFiles,
          runtimeConfig: () => manager.current(),
          reload: async () => await manager.reload({ mode: 'safe', dryRun: false }),
          repositoryWorkspaceDb: (id) => {
            // Only actual SDK-created scopes, with the actual caller's current Kernel read.
            if (id !== ownedHome.id && id !== workspace.id)
              throw new Error('No fixture authority for another Workspace.');
            if (
              evaluateProductAuthorization(
                coreDb,
                actor,
                { kind: 'workspace', workspaceId: id },
                'workspace.read',
                false
              ).effect !== 'allow'
            )
              throw new Error('The actual SDK actor no longer has Workspace read authority.');
            let reader = readers.get(id);
            if (!reader) {
              reader = createTestWorkspaceDb(dataRoot, id);
              workspaceReaders.push(reader);
              readers.set(id, reader);
            }
            return reader;
          },
          inflightCommands: new WeakMap(),
        });
        const propose = (proposed: PolicyDocumentV1) =>
          service.propose(
            {
              targetFamily: 'policy',
              targetId: 'server',
              expectedRevision: ownedFiles.readFile('server.jsonc').file.revision!,
              changes: {
                proposed,
                rationale: 'Actual human review of this exact switch.',
              },
            },
            { threadId: thread.id, turnId: turn.id, requestId: randomUUID() }
          );
        const apply = (p: Awaited<ReturnType<typeof propose>>) =>
          service.apply({
            requestId: randomUUID(),
            candidate: p.candidate,
            confirmation: p.confirmation,
          });
        return { propose, apply };
      }
      const management = () => (opened ??= openManagement());
      const propose = async (proposed: PolicyDocumentV1) => (await management()).propose(proposed);
      const apply = async (p: Awaited<ReturnType<typeof propose>>) => (await management()).apply(p);
      accounts.push({
        human,
        actor,
        get home() {
          if (!home) throw new Error('This actual management Home has not been opened.');
          return home;
        },
        get files() {
          if (!files) throw new Error('This actual management file service has not been opened.');
          return files;
        },
        propose,
        apply,
      });
    }
    const admin = accounts[0]!;
    expect(admin.actor.adminTokenId).toBe(first.bootstrap!.tokenId);
    expect(
      evaluateProductAuthorization(
        coreDb,
        admin.actor,
        { kind: 'server' },
        'workspace.configure',
        true
      ).effect
    ).toBe('allow');
    expect(accounts[2]!.actor.adminTokenId).toBeUndefined();
    const app = createApp({
      mode: 'server',
      coreDb,
      dataRoot,
      store,
      auth,
      runtimeConfigManager: manager,
      ...createOptions(coreDb, nanoHostStorage),
    });
    return {
      coreDb,
      dataRoot,
      store,
      manager,
      accounts,
      app,
      auth,
    };
  }
  let current = await graph();
  const workspaceResponse = await current.app.request(
    ...operationRequest(
      'workspace.create',
      {},
      {
        headers: { cookie: first.cookie },
        body: JSON.stringify({
          name: 'Real scoped runtime caller',
          requestId: randomUUID(),
        }),
      }
    )
  );
  expect(workspaceResponse.status).toBe(201);
  const workspace = await workspaceResponse.json();
  expect(typeof workspace.id).toBe('string');
  async function change(proposed: PolicyDocumentV1, account = 0) {
    const owner = current.accounts[account]!;
    const result = await owner.apply(await owner.propose(proposed));
    expect(result).toMatchObject({ persisted: true, reload: 'applied' });
    return readAdmittedPolicyDocument(
      coreDb,
      current.manager.current().openKitConfig.policy?.mediation
    );
  }
  const loaded = () =>
    readAdmittedPolicyDocument(coreDb, current.manager.current().openKitConfig.policy?.mediation);
  async function restart() {
    await shutdownControlStoreWorkerClient();
    for (const reader of workspaceReaders) closeTestCoreDb(reader);
    workspaceReaders = [];
    closeWorkspaceProductReadHandles(dataRoot);
    closeTestCoreDb(coreDb);
    coreDb = createTestCoreDb(dataRoot);
    auth = createBetterAuth(coreDb, { env: { BETTER_AUTH_URL: BASE } });
    current = await graph();
  }
  return {
    first,
    second,
    ordinary,
    change,
    loaded,
    restart,
    pending,
    releases,
    ordinaryWorkspace: workspace,
    trackReader: (reader: ReturnType<typeof createTestWorkspaceDb>) =>
      workspaceReaders.push(reader),
    graph: () => current,
    post: (path: string, body: unknown, headers: HeadersInit) =>
      current.app.request(path, {
        method: 'POST',
        headers: {
          ...Object.fromEntries(new Headers(headers)),
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      }),
  };
}

/** Read an exact existing source descriptor; do not invent names for new B1 groups. */
function sourceGroup(entry: string) {
  const descriptor = Reflect.get(NON_API_EXPOSURE_DEFINITIONS, entry);
  expect(descriptor).toBeDefined();
  const metadata = descriptor && Reflect.get(descriptor, 'exposure');
  expect(metadata).toMatchObject({
    kind: 'switchable',
    owner: expect.any(String),
    group: expect.any(String),
  });
  const group = Reflect.get(metadata, 'group') as string;
  expect(group.length).toBeGreaterThan(0);
  return group;
}

/** Existing S1 allocation owners seed a real package/session/attempt; no SQL grant or allow decision is inserted. */
async function workerFixture() {
  let gateway!: ReturnType<typeof createDefaultWorkerControlGateway>;
  const f = await fixture({}, (coreDb, nanoHostStorage) => {
    gateway = createDefaultWorkerControlGateway(coreDb, undefined, nanoHostStorage);
    return { workerControlGateway: gateway };
  });
  const g = f.graph();
  const workspaceId = f.ordinaryWorkspace.id; // Actual SDK-created ordinary Workspace and owner membership.
  const thread = await g.store.createThread(
    workspaceId,
    'Native private Worker',
    allocateEntityId('th')
  );
  const setup = createTestAgentSetup({ mcpIds: ['fixture-native'] });
  const commandRequestId = randomUUID();
  const { turn } = await createNativeCommandTurn(
    g.store,
    { requestId: commandRequestId, agentId: setup.manifest.id },
    workspaceId,
    thread.id,
    'Exercise the original allocated Worker package.',
    { kind: 'user', id: f.first.userId }
  );
  const coverage = g.store.getTurnCaptureCoverage(turn.id);
  expect(coverage).toBeDefined();
  const environmentPackage = await resolveAgentEnvironmentPackage({
    coreDb: g.coreDb,
    captureCoverage: coverage!,
    agentSetup: setup,
    agentSessionId: allocateEntityId('as'),
    triggerActor: turn.triggerActor,
    backend: { kind: 'openshell' },
    createdAt: new Date().toISOString(),
    requestId: commandRequestId,
    turn,
    workspaceCwd: '/workspace',
    workspaceRoots: [],
    workspaceMcpServerCatalog: nativeCatalog,
  });
  const db = createTestWorkspaceDb(g.dataRoot, workspaceId);
  f.trackReader(db);
  const lineage = {
    workspaceId,
    threadId: thread.id,
    turnId: turn.id,
    agentSessionId: environmentPackage.scope.agentSessionId,
    packageSnapshotId: environmentPackage.snapshotId,
    requestId: environmentPackage.scope.requestId,
  };
  const queueEntryId = randomUUID();
  const entry = createSchedulerAdmissionEntry(g.coreDb, {
    backendId: 'nanohost',
    triggerActor: turn.triggerActor,
    // Exact credential already projected by the actual SDK session, as in product-turn-start.
    serverAdminTokenId: g.accounts[0]!.actor.adminTokenId ?? null,
    profileRef: environmentPackage.agent.profileId,
    queueEntryId,
    requestId: lineage.requestId,
    requestedAgentId: environmentPackage.agent.agentId,
    threadId: thread.id,
    turnId: turn.id,
    inputRef: schedulerFixtureInput(
      workspaceId,
      turn.id,
      'Exercise the original allocated Worker package.'
    ),
    workspaceId,
  });
  expect(entry.status).toBe('queued');
  expect(entry.backendId).toBe('nanohost');
  expect(entry.serverAdminTokenId).toBe(g.accounts[0]!.actor.adminTokenId);
  let launchKernel: ReturnType<typeof evaluateProductAuthorization> | undefined;
  const dispatchable = currentSchedulerAdmissionWorkspaceAuthority(
    g.coreDb,
    entry,
    'runtime.launch',
    true,
    {
      dependencyFailure: 'throw',
      onEvaluation: (event) => {
        launchKernel = event.decision;
      },
    }
  );
  expect(dispatchable).not.toBeNull();
  expect(launchKernel?.effect).toBe('allow');

  const attemptId = allocateEntityId('attempt');
  const binding = `lease-binding:${attemptId}`;
  const secrets = {
    control: randomBytes(32).toString('base64url'),
    capability: randomBytes(32).toString('base64url'),
    inference: randomBytes(32).toString('base64url'),
  };
  // The original Native submit carries the three route-token hashes (K8 owner).
  const attempt = submitTestNanoHostWorkerLease(
    g.coreDb,
    requireSchedulerAdmissionEntry(g.coreDb, queueEntryId),
    binding,
    {
      agentSessionId: lineage.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      workerControlTokenHash: hashWorkerRouteToken(secrets.control),
      workerCapabilityTokenHash: hashWorkerRouteToken(secrets.capability),
      workerInferenceTokenHash: hashWorkerRouteToken(secrets.inference),
    },
    { attemptId }
  );
  await recordAgentEnvironmentPackageSnapshot(db, {
    environmentPackage,
    createdAt: environmentPackage.createdAt,
  });
  await g.store.createAgentSession({
    id: environmentPackage.scope.agentSessionId,
    workspaceId,
    threadId: thread.id,
    agentId: environmentPackage.agent.agentId,
    status: 'busy',
    message: null,
    environmentPackageSnapshotId: environmentPackage.snapshotId,
    createdAt: environmentPackage.createdAt,
    updatedAt: environmentPackage.createdAt,
  });
  await g.store.updateTurn(turn.id, {
    agentSessionId: environmentPackage.scope.agentSessionId,
    agentId: environmentPackage.agent.agentId,
  });
  expect(attempt).toMatchObject({
    queueEntryId: entry.queueEntryId,
    phase: 'open',
    agentSessionId: lineage.agentSessionId,
    inputRef: environmentPackage.snapshotId,
    bindingRef: binding,
  });
  // Existing allocated S1 fixture observation, not a fabricated Policy/Kernel verdict.
  acceptSchedulerExecutionObservation(g.coreDb, {
    ...schedulerExecutionCorrelation(attempt),
    disposition: 'accepted',
    execution: 'running',
    fenceRef: null,
    outcomeRef: null,
  });
  const registration = gateway.registerSession(environmentPackage, {
    sandboxBindingRef: binding,
    workerControlToken: secrets.control,
    workerCapabilityToken: secrets.capability,
    workerInferenceToken: secrets.inference,
  });
  expect(registration.token).toBe(secrets.control);
  const authenticated: Array<typeof lineage> = [];
  const recordHeartbeat = gateway.recordHeartbeat.bind(gateway);
  gateway.recordHeartbeat = (input) =>
    recordHeartbeat({
      ...input,
      onAuthenticated: (actual) => {
        authenticated.push({ ...actual });
        input.onAuthenticated?.(actual);
      },
    });
  let kernel: ReturnType<typeof evaluateProductAuthorization> | undefined;
  const authority = currentWorkerLineageWorkspaceAuthority(
    g.coreDb,
    { ...lineage, triggerActor: turn.triggerActor },
    'tool.use',
    true,
    {
      dependencyFailure: 'throw',
      onEvaluation: (event) => {
        kernel = event.decision;
      },
    }
  );
  expect(authority).not.toBeNull();
  expect(kernel?.effect).toBe('allow');
  const client = new WorkerControlClient({
    baseUrl: `${BASE}/api/worker-control`,
    token: secrets.control,
    lineage,
    fetch: async (input, init) => await g.app.request(input, init),
  });
  return {
    setup,
    turn,
    thread,
    f,
    g,
    db,
    gateway,
    client,
    lineage,
    environmentPackage,
    attemptId,
    secrets,
    authenticated,
  };
}

const nativeCatalog = {
  schemaVersion: 1 as const,
  servers: [
    {
      id: 'fixture-native',
      enabled: true,
      allowedTools: ['create-thread'],
      credentialBindings: [],
      pinnedSchemaSnapshotId: null,
      schemaPolicy: 'tracking' as const,
      timeoutMs: 2000,
      transport: {
        kind: 'stdio' as const,
        command: process.execPath,
        args: [],
        environment: {},
      },
    },
  ],
};
const nativeTool = {
  name: 'create-thread',
  description: 'Create one actual native Thread with its original request receipt.',
  inputSchema: {
    type: 'object',
    properties: {
      requestId: { type: 'string', minLength: 1 },
      name: { type: 'string', minLength: 1 },
    },
    required: ['requestId', 'name'],
    additionalProperties: false,
  },
};

async function capturedFixture() {
  const w = await workerFixture();
  expect(
    await w.client.recordHeartbeat({
      status: 'starting',
      message: 'Actual captured Worker startup',
    })
  ).toMatchObject({ accepted: true });
  const workspaceId = w.lineage.workspaceId;
  const human = w.f.first.userId;
  const condition = {
    ...control(human),
    id: 'captured-native-human-review',
    effect: 'require_approval',
    scope: {
      subjects: [{ kind: 'human', id: human }],
      actions: ['tool.use'],
      resources: [
        {
          kind: 'mcp-tool',
          workspaceId,
          serverId: 'fixture-native',
          toolName: nativeTool.name,
        },
      ],
    },
    lifetime: {
      anchor: {
        owner: { kind: 'workspace', workspaceId },
        kind: 'workspace',
        id: workspaceId,
      },
    },
  };
  await w.f.change(document(condition));
  const created: string[] = []; // Actual native record identities, not a tool-call effect counter.
  const backend: WorkerMcpGateway = {
    listTools: async () => ({ tools: [nativeTool], serverVersion: '1' }),
    callTool: async (input) => {
      expect(input.toolName).toBe(nativeTool.name);
      const response = await w.g.app.request(
        ...operationRequest(
          'thread.create',
          {},
          {
            headers: { cookie: w.f.first.cookie },
            body: JSON.stringify({
              workspaceId,
              requestId: input.arguments.requestId,
              name: input.arguments.name,
            }),
          }
        )
      );
      expect(response.status).toBe(200);
      const thread = await response.json();
      expect(w.g.store.getThread(workspaceId, thread.id).name).toBe(input.arguments.name);
      created.push(thread.id);
      return {
        content: [{ type: 'text', text: JSON.stringify({ threadId: thread.id }) }],
        structuredContent: { threadId: thread.id },
      };
    },
    close: async () => {},
    closeServer: async () => {},
    closeServerIfIdle: async () => {},
    closeWorkspace: async () => {},
    getServerHealth: () => 'ready',
  };
  const interception = new PolicyInterception();
  const mcp = new Hono<{ Variables: AuthVariables }>();
  const routes = {
    app: mcp,
    coreDb: w.g.coreDb,
    store: w.g.store,
    interception,
    workerMcpGateway: backend,
    workerControlGateway: w.gateway,
    runtimeConfig: () => ({
      ...w.g.manager.current(),
      workspaceMcpServerCatalogs: [
        {
          workspaceId,
          catalog: nativeCatalog,
          path: join(w.g.dataRoot, 'workspaces', workspaceId, 'catalog', 'catalog.json'),
        },
      ],
    }),
  };
  registerWorkerMcpRoutes(routes);
  async function capture(name: string) {
    const args = { requestId: randomUUID(), name };
    const response = await mcp.request('/api/worker-capabilities/mcp/fixture-native', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${w.secrets.capability}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'tools/call',
        params: { name: nativeTool.name, arguments: args },
      }),
    });
    expect(response.status).toBe(200);
    const output = await response.json();
    expect(output).toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          status: 'pending-approval',
          requestId: expect.any(String),
        },
      },
    });
    const requestId = output.result.structuredContent.requestId as string;
    const record = readPendingRequest(w.db.sqlite, requestId);
    expect(record).toMatchObject({
      requestId,
      state: 'pending',
      kind: 'approval',
      responsibleUserId: human,
      agentSessionId: w.lineage.agentSessionId,
      packageDigest: w.environmentPackage.snapshotId,
      serverId: 'fixture-native',
      toolName: nativeTool.name,
    });
    expect(record!.policyDecisionId).toBeTruthy();
    expect(w.g.store.listThreads(workspaceId).filter((t) => t.name === name)).toHaveLength(0);
    return { requestId, args, record: record! };
  }
  let hold: (() => Promise<void>) | undefined;
  let reviewed: string | undefined;
  const http = new Hono<{ Variables: AuthVariables }>();
  http.use(
    '/api/*',
    createAuthMiddleware('server', w.g.auth, {
      coreDb: w.g.coreDb,
      canonicalUserActive: (id) => isCanonicalUserActive(w.g.coreDb, id),
      sessionDeploymentAdmin: (id) => resolveSessionDeploymentAdminTokenId(w.g.coreDb, id),
    })
  );
  http.post('/api/e13/native-approval', async (c) => {
    try {
      const actor = c.get('actor');
      if (actor.kind !== 'session') return c.json({ error: 'actual-human-session-required' }, 403);
      const body = await c.req.json();
      const record = readPendingRequest(w.db.sqlite, body.requestId);
      if (!record) return c.json({ error: 'request-not-found' }, 404);

      let prepared: Awaited<ReturnType<typeof prepareCapturedPendingCall>> | undefined;
      let executionCall: Awaited<ReturnType<typeof admitCapturedPendingCall>> | undefined;
      const result = await respondRecordedApproval({
        store: w.g.store,
        sqlite: w.db.sqlite,
        workspaceId,
        threadId: record.threadId,
        approvalRequestId: record.requestId,
        decision: 'granted',
        actorId: actor.userId,
        coreDb: w.g.coreDb,
        requestActor: actor,
        dependencies: {
          coreDb: w.g.coreDb,
          openWorkspace: (id) => {
            if (id !== workspaceId) throw new Error('No fixture authority for another Workspace.');
            return w.db;
          },
        },
        prepare: async () => {
          prepared = await prepareCapturedPendingCall({
            actor,
            record,
            catalog: nativeCatalog,
            coreDb: w.g.coreDb,
            vaultBackend: undefined,
            workerMcpGateway: backend,
            workspaceDb: w.db,
            reviewPolicy: (record, actor) =>
              reviewCapturedMcpPolicy({
                record,
                actor,
                workspaceDb: w.db,
                routes,
                catalog: nativeCatalog,
                interception,
              }),
          });
          expect(prepared.failed).toBe(false);
          expect(prepared.mediation?.decisionId).toEqual(expect.any(String));
          reviewed = prepared.mediation!.decisionId;
          await hold?.();
        },
        evaluate: () =>
          evaluateCapturedPendingCall({
            manifest: w.setup.manifest,
            catalog: nativeCatalog,
            coreDb: w.g.coreDb,
            record,
            sqlite: w.db.sqlite,
            prepared,
          }),
        admitExecution: async (failure) => {
          executionCall = await admitCapturedPendingCall(
            record,
            w.db,
            randomUUID(),
            prepared,
            failure
          );
          return executionCall.refusal;
        },
        execute: (claimed, current) =>
          executeCapturedPendingCall({
            catalog: nativeCatalog,
            coreDb: w.g.coreDb,
            record: claimed,
            workerMcpGateway: backend,
            workspaceDb: w.db,
            prepared,
            executionCall,
            current,
          }),
      });
      return c.json(result);
    } catch (error) {
      const failure = error as { status?: number; code?: string };
      return c.json(
        { error: failure.code ?? 'native-approval-failed' },
        (failure.status ?? 500) as 400 | 403 | 404 | 409 | 500
      );
    }
  });
  const approve = async (requestId: string) =>
    await http.request('/api/e13/native-approval', {
      method: 'POST',
      headers: { cookie: w.f.first.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId }),
    });
  // Real authenticated original MCP discovery publishes the actual declared upstream schema.
  // Immutable snapshot owner auto-admits its FIRST live observation (line196); no definition-change Pending exists.
  const observed = await mcp.request('/api/worker-capabilities/mcp/fixture-native', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${w.secrets.capability}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/list', params: {} }),
  });
  expect(observed.status).toBe(200);
  const listing = await observed.json();
  expect(listing.error).toBeUndefined();
  expect(listing.result.tools).toMatchObject([nativeTool]);
  const snapshot = readCurrentMcpToolSchemaSnapshot({
    workspaceDb: w.db,
    workspaceId,
    catalogEntryId: 'fixture-native',
    pinnedSchemaSnapshotId: null,
  });
  expect(snapshot).not.toBeNull();
  expect(snapshot!.tools).toMatchObject([nativeTool]);
  const admission = readMcpToolDefinitionAdmission({
    workspaceDb: w.db,
    workspaceId,
    catalogEntryId: 'fixture-native',
  });
  expect(admission).not.toBeNull();
  expect(admission!.approvedSchemaDigest).toBe(admission!.contentDigest);
  expect(admission!.approvedTools).toMatchObject([nativeTool]);
  expect(created).toEqual([]); // Schema observation grants NO Tool-use effect.
  // The unchanged cases NOW issue original tools/call -> real require_approval Tool Pending -> real human HTTP grant.

  return {
    ...w,
    condition,
    created,
    capture,
    approve,
    setHold: (value: () => Promise<void>) => {
      hold = value;
    },
    reviewed: () => reviewed,
  };
}

describe('E13B2 actual captured Pending and native human-approved effect', () => {
  it('requires a real native decision and human HTTP grant, creates once, and never duplicates its durable replay', async () => {
    const p = await capturedFixture();
    const pending = await p.capture(`Actual captured native effect ${randomUUID()}`);
    const response = await p.approve(pending.requestId);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      requestId: pending.requestId,
      resolution: 'granted',
      disposition: 'approved-executed',
    });
    const rows = p.g.store
      .listThreads(p.lineage.workspaceId)
      .filter((t) => t.name === pending.args.name);
    expect(rows).toHaveLength(1);
    expect(p.created).toEqual([rows[0]!.id]);
    const stored = readPendingRequest(p.db.sqlite, pending.requestId);
    expect(stored).toMatchObject({
      resolution: 'granted',
      disposition: 'approved-executed',
    });
    const nativeDecisions = listExportableWorkspacePermissionDecisions(p.db, p.lineage.workspaceId);
    expect(
      nativeDecisions.some((row) => row.decisionId === p.reviewed() && row.result === 'allow')
    ).toBe(true);
    expect((await p.approve(pending.requestId)).status).toBe(409);
    expect(
      p.g.store.listThreads(p.lineage.workspaceId).filter((t) => t.name === pending.args.name)
    ).toHaveLength(1);
    // The actual Thread command receipt returns the same native record on exact request replay.
    const replay = await p.g.app.request(
      ...operationRequest(
        'thread.create',
        {},
        {
          headers: { cookie: p.f.first.cookie },
          body: JSON.stringify({
            workspaceId: p.lineage.workspaceId,
            ...pending.args,
          }),
        }
      )
    );
    expect(replay.status).toBe(200);
    expect((await replay.json()).id).toBe(rows[0]!.id);
  });

  it('rechecks current Policy after a genuine approval decision is cached, and recovers only through a fresh human-approved captured request', async () => {
    const p = await capturedFixture();
    const pending = await p.capture(`Never perform stale approved native effect ${randomUUID()}`);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrived!: () => void;
    const prepared = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    p.setHold(async () => {
      arrived();
      await wait;
    });
    p.f.releases.unshift(release);
    const request = p.approve(pending.requestId);
    p.f.pending.push(request);
    expect(await Promise.race([prepared.then(() => true), request.then(() => false)])).toBe(true);
    const rows = listExportableWorkspacePermissionDecisions(p.db, p.lineage.workspaceId);
    expect(rows.some((row) => row.decisionId === p.reviewed() && row.result === 'allow')).toBe(
      true
    );
    const group = sourceGroup('POST /api/worker-capabilities/mcp/_list-servers');
    const native = Reflect.get(OPERATION_REGISTRY['mcp.call-tool'], 'exposure');
    expect(native).toMatchObject({ kind: 'switchable', group });
    await p.f.change(document(p.condition, control(p.f.second.userId, 'active', group)), 1);
    release();
    const response = await request;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      requestId: pending.requestId,
      resolution: 'granted',
      disposition: 'execution-error',
    });
    expect(
      p.g.store.listThreads(p.lineage.workspaceId).filter((t) => t.name === pending.args.name)
    ).toHaveLength(0);
    expect(readPendingRequest(p.db.sqlite, pending.requestId)).toMatchObject({
      resolution: 'granted',
      disposition: 'execution-error',
    });
    expect((await p.approve(pending.requestId)).status).toBe(409);
    await p.f.change(document(p.condition), 1);
    const fresh = await p.capture(`Fresh current native approval ${randomUUID()}`);
    const recovered = await p.approve(fresh.requestId);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      resolution: 'granted',
      disposition: 'approved-executed',
    });
    expect(
      p.g.store.listThreads(p.lineage.workspaceId).filter((t) => t.name === fresh.args.name)
    ).toHaveLength(1);
    expect(
      p.g.store.listThreads(p.lineage.workspaceId).filter((t) => t.name === pending.args.name)
    ).toHaveLength(0);
  });
});

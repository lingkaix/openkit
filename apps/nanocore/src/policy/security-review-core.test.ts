import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { Client } from '@modelcontextprotocol/client';
import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/core';
import { StartTaskModeResponseSchema } from '@openkit/app-api-schemas';
import { UserConfigSchema, type WorkspaceMcpServerCatalog } from '@openkit/config-schema';
import { allocateEntityId, UserIdSchema } from '@openkit/protocol';
import { policyDigest } from '@openkit/protocol/digest';
import { Hono } from 'hono';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createApp } from '../app.js';
import { listWorkspaceAuditEvents } from '../audit-events.js';
import {
  createOpenKitAccessTokenRecord,
  resolveSessionDeploymentAdminTokenId,
} from '../auth/access-token-store.js';
import { createBetterAuth } from '../auth/better-auth.js';
import type { Actor } from '../auth/identity.js';
import { type AuthVariables, createAuthMiddleware } from '../auth/middleware.js';
import { evaluateProductAuthorization } from '../auth/operation-authorizer.js';
import { isCanonicalUserActive } from '../auth/user-lifecycle.js';
import { replaceWorkspaceEffectiveMcpCatalog } from '../catalog/resource-catalog.js';
import { createAdministrationConfiguration } from '../config/administration-configuration.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import { PiAiGatewayClient } from '../llm/pi-ai-client.js';
import { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import { getSchedulerPreparationClaims } from '../runtime/scheduler-dispatch-loop.js';
import { createDefaultWorkerMcpGateway } from '../runtime/worker-mcp-gateway.js';
import { findSchedulerAdmissionForTurn } from '../scheduler-records.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { createMcpHttpStub } from '../test-support/mcp-http-stub.js';
import { admitTestNativeEnvironment } from '../test-support/native-environment.js';
import { createNativeTaskAdmissionFixture } from '../test-support/native-task-admission.js';
import { operationRequest } from '../test-support/operation-request.js';
import { createPendingRequestFixture } from '../test-support/pending-request.js';
import {
  createTestCoreDb,
  createTestWorkspaceDb,
  disposeTestStore,
} from '../test-support/store.js';
import { registerWorkerMcpRoutes } from '../worker-mcp-routes.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { createAgentPolicyParticipant } from './agent-gate-provider.js';
import { readAdmittedPolicyDocument } from './configuration.js';
import { createGoalTaskPolicyService } from './goal-task-policy.js';
import { PolicyInterception } from './interception.js';
import { listExportableWorkspacePermissionDecisions } from './permission-decisions.js';
import { preparePolicyDocument } from './statements.js';

// The candidate is authored independently against accepted bfd. Only this file is copied
// into apps/nanocore/src/policy/. No S11 module, qualification receipt or verdict stub.
const BASE = 'http://localhost:7676';
const WORKSPACE = DEMO_WORKSPACE_ID;
const THREAD = DEMO_THREAD_ID;
const BINDING = 'public-echo-review';
const PUBLIC_MESSAGE = 'Public fixture echo, with no outbound private content.';

async function fixture(agentId: 'security-review' | 'ordinary-reviewer') {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-security-review-core-'));
  const coreDb = createTestCoreDb(dataRoot);
  const handles: ReturnType<typeof createTestWorkspaceDb>[] = [];
  let native: Awaited<ReturnType<typeof createNativeTaskAdmissionFixture>> | undefined;
  let gateway: ReturnType<typeof createDefaultWorkerMcpGateway> | undefined;
  let upstream: Awaited<ReturnType<typeof createMcpHttpStub>> | undefined;
  let pending: ReturnType<typeof createPendingRequestFixture> | undefined;
  let work:
    | ReturnType<Awaited<ReturnType<typeof createNativeTaskAdmissionFixture>>['executionFor']>
    | undefined;
  let closeout: Promise<unknown> | undefined;
  onTestFinished(async () => {
    try {
      work?.completion.resolve();
      const settled = await Promise.allSettled([
        ...(work ? [work.execution] : []),
        ...(closeout ? [closeout] : []),
      ]);
      try {
        await native?.restore();
      } finally {
        try {
          await gateway?.close();
        } finally {
          pending?.close();
          try {
            await disposeTestStore(dataRoot, ...handles, coreDb);
          } finally {
            await upstream?.close();
          }
        }
      }
      const failures = settled.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (failures.length)
        throw new AggregateError(failures, 'Actual native execution/closeout failed.');
    } finally {
      vi.restoreAllMocks();
    }
  });

  ensureLocalUser(coreDb);
  const auth = createBetterAuth(coreDb, { env: { BETTER_AUTH_URL: BASE } });
  const registration = await auth.handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({
        name: 'S12 synthetic human',
        email: 's12-reviewer@example.test',
        password: 'synthetic-s12-fixture-password',
      }),
    })
  );
  expect(registration.status).toBe(200);
  const userId = UserIdSchema.parse((await registration.json()).user.id);
  const cookie = registration.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  expect(cookie.length).toBeGreaterThan(0);
  const administrator = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: userId,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  const store = await createDemoStore({ dataRoot, knowledge: [] });
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: userId, workspaceId: WORKSPACE });
  const workspaceDb = createTestWorkspaceDb(dataRoot, WORKSPACE);
  handles.push(workspaceDb);
  upstream = await createMcpHttpStub();
  const catalog: WorkspaceMcpServerCatalog = {
    schemaVersion: 1,
    servers: [
      {
        id: 'echo',
        enabled: true,
        allowedTools: ['echo'],
        credentialBindings: [],
        pinnedSchemaSnapshotId: null,
        schemaPolicy: 'tracking',
        timeoutMs: 2_000,
        transport: { kind: 'http', endpoint: upstream.url },
      },
    ],
  };
  // Initial public-safe MCP metadata uses the existing catalog owner. This is not a
  // grant or a changed-definition approval. SDK discovery/native schema admission is real.
  replaceWorkspaceEffectiveMcpCatalog({ dataRoot, workspaceId: WORKSPACE, catalog });
  const setupOptions = {
    logicalModelId: 'gate-default',
    privateRoute: { providerProfileId: 'fixture', providerModel: 'fixture-model' },
    mcpIds: ['echo'],
    requiredCapabilities: ['trusted-worker-inference-relay'] as const,
  };
  const setup = createTestAgentSetup({
    ...setupOptions,
    requiredCapabilities: [...setupOptions.requiredCapabilities],
  });
  const configRoot = join(dataRoot, 'config');
  mkdirSync(join(configRoot, 'agents'), { recursive: true });
  mkdirSync(join(configRoot, 'providers'), { recursive: true });
  writeFileSync(
    join(configRoot, 'agents', `${setup.manifest.id}.agent.jsonc`),
    JSON.stringify(setup.manifest)
  );
  writeFileSync(
    join(configRoot, 'gateway.jsonc'),
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      requiredFeatures: [],
      defaultLogicalModelId: 'gate-default',
      logicalModels: [
        {
          id: 'gate-default',
          displayName: 'Ordinary default model',
          contextManagement: [{ type: 'compaction', compactThreshold: 32_000 }],
          routes: [
            { id: 'fixture-route', providerProfileId: 'fixture', providerModel: 'fixture-model' },
          ],
        },
      ],
    })
  );
  // No secretRef, OAuth account, ambient key or paid endpoint. This ordinary default
  // model is intentionally available but is NEVER a qualified decision route.
  writeFileSync(
    join(configRoot, 'providers', 'fixture.provider.jsonc'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'fixture',
      kind: 'custom',
      displayName: 'Public faux transport',
      baseUrl: 'http://fixture.invalid/v1',
      models: ['fixture-model'],
      modelMetadata: {
        'fixture-model': { tool_call: true, limit: { context: 64_000, output: 2_000 } },
      },
    })
  );
  writeFileSync(
    join(configRoot, 'server.jsonc'),
    JSON.stringify({
      schemaVersion: 1,
      policy: { mediation: { schemaVersion: 1, statements: [] }, workDataCapture: { value: 'on' } },
    })
  );
  const userConfigPath = join(dataRoot, 'users', userId, 'config', 'user.jsonc');
  mkdirSync(join(dataRoot, 'users', userId, 'config'), { recursive: true });
  writeFileSync(
    userConfigPath,
    JSON.stringify(
      UserConfigSchema.parse({
        schemaVersion: 1,
        knowledgeMaintenance: { enabled: false, reviewRequiredPageIds: [] },
      })
    )
  );

  // Observe the real session authentication owner's Actor; a bearer Token is not
  // substituted for the human configuration owner or for actual human confirmation.
  let observedActor: Actor | undefined;
  const authentication = new Hono<{ Variables: AuthVariables }>();
  authentication.use(
    createAuthMiddleware('server', auth, {
      coreDb,
      canonicalUserActive: (id) => isCanonicalUserActive(coreDb, id),
      sessionDeploymentAdmin: (id) => resolveSessionDeploymentAdminTokenId(coreDb, id),
    })
  );
  authentication.get('/api/s12-fixture-identity', (c) => {
    observedActor = c.get('actor');
    return c.json({ observed: true });
  });
  expect(
    (
      await authentication.request(`${BASE}/api/s12-fixture-identity`, {
        headers: { cookie },
      })
    ).status
  ).toBe(200);
  const actor = observedActor;
  if (!actor) throw new Error('The actual authentication owner did not supply its Actor.');
  expect(actor).toMatchObject({ kind: 'session', userId, adminTokenId: administrator.tokenId });
  expect(
    evaluateProductAuthorization(coreDb, actor, { kind: 'server' }, 'workspace.configure', true)
      .effect
  ).toBe('allow');

  const personal = await store.ensureQuickChatWorkspace(userId);
  const homeThread = await store.createThread(
    personal.id,
    'Review this exact Policy candidate',
    allocateEntityId('th'),
    'administration',
    { visibility: 'private', privateOwnerUserId: userId }
  );
  const homeTurn = await store.createTurn(
    personal.id,
    homeThread.id,
    'Review the public fixture Policy configuration.',
    { kind: 'user', id: userId },
    null
  );
  const homeDb = createTestWorkspaceDb(dataRoot, personal.id);
  handles.push(homeDb);
  const manager = createRuntimeConfigManager({ dataRoot });
  expect(manager.current().diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
  expect(manager.current().agentManifests.some((entry) => entry.id === setup.manifest.id)).toBe(
    true
  );
  expect(manager.current().gatewayConfig.defaultLogicalModelId).toBe('gate-default');
  expect(
    manager
      .current()
      .workspaceMcpServerCatalogs.find((entry) => entry.workspaceId === WORKSPACE)
      ?.catalog.servers.map((server) => server.id)
  ).toContain('echo');
  const files = new RuntimeConfigFileService({
    dataRoot,
    userId,
    workspaceIds: [WORKSPACE, personal.id],
    runtimeConfigManager: manager,
    readRuntimeConfigStatus: () => manager.status(),
  });
  const service = createAdministrationConfiguration({
    actor,
    coreDb,
    store,
    files,
    runtimeConfig: () => manager.current(),
    reload: async () => await manager.reload({ mode: 'safe', dryRun: false }),
    repositoryWorkspaceDb: (id) => {
      if (id === WORKSPACE) return workspaceDb;
      if (id === personal.id) return homeDb;
      throw new Error('No fixture repository authority for another Workspace.');
    },
    inflightCommands: new WeakMap(),
  });
  const loaded = () =>
    readAdmittedPolicyDocument(coreDb, manager.current().openKitConfig.policy?.mediation);
  async function publish(statements: unknown[]) {
    const proposed = preparePolicyDocument({
      current: loaded(),
      proposed: { schemaVersion: 1, statements },
      userId,
      now: new Date().toISOString(),
    }).document;
    const candidate = await service.propose(
      {
        targetFamily: 'policy',
        targetId: 'server',
        expectedRevision: files.readFile('server.jsonc').file.revision!,
        changes: {
          proposed,
          rationale: 'Human configuration of this exact public-safe review binding.',
        },
      },
      { threadId: homeThread.id, turnId: homeTurn.id, requestId: randomUUID() }
    );
    // Candidate/confirmation/artifact are owner-created, immutable and actually admitted.
    expect(
      await service.apply({
        requestId: randomUUID(),
        candidate: candidate.candidate,
        confirmation: candidate.confirmation,
      })
    ).toMatchObject({ persisted: true, reload: 'applied' });
    expect(loaded()).toEqual(manager.current().openKitConfig.policy?.mediation);
    return loaded();
  }
  const human = { kind: 'human' as const, id: userId };
  const scope = {
    subjects: [human],
    actions: ['tool.use'],
    resources: [{ kind: 'mcp-tool', workspaceId: WORKSPACE, serverId: 'echo', toolName: 'echo' }],
  };
  const common = {
    author: human,
    authority: { kind: 'human', userId },
    authoredAt: new Date().toISOString(),
    state: 'active',
    lifetime: {
      anchor: {
        owner: { kind: 'workspace', workspaceId: WORKSPACE },
        kind: 'workspace',
        id: WORKSPACE,
      },
    },
  };
  // Publish the declaration through the real human owner first. Pin its ACTUALLY
  // admitted digest, not the digest of a provisional/pre-stamping declaration.
  await publish([
    {
      ...common,
      kind: 'agent-principal',
      id: 'reviewer-principal',
      agentId,
      creator: human,
      responsibleHumanId: userId,
      responsibility: human,
      scope: { ...scope, subjects: [{ kind: 'agent', id: agentId }] },
    },
  ]);
  const declaration = loaded().statements.find((entry) => entry.kind === 'agent-principal');
  if (declaration?.kind !== 'agent-principal')
    throw new Error('The real declaration was not admitted.');
  const binding = {
    ...common,
    // P1's no-shadow amendment is Server-only; the ordinary reviewer keeps its Workspace anchor.
    ...(agentId === 'security-review'
      ? { lifetime: { anchor: { owner: { kind: 'server' }, kind: 'server', id: 'server' } } }
      : {}),
    kind: 'binding',
    id: BINDING,
    scope,
    operation: 'mcp.call-tool',
    stage: 'decide',
    mode: 'gate',
    participant: { kind: 'agent', id: agentId, version: policyDigest(declaration) },
    inputDisclosure: scope,
    order: 0,
    timeoutMs: 20_000,
    circuit: { failures: 1, recoveryAfterMs: 60_000 },
  };
  async function install(state: 'active' | 'shadow') {
    const document = loaded();
    const previous = document.statements.find((entry) => entry.id === BINDING);
    return await publish([
      ...document.statements.filter((entry) => entry.id !== BINDING),
      { ...(previous ?? binding), state },
    ]);
  }

  // The ONLY doubled model effect is the stock faux transport below the real
  // PiAi client/dispatcher. Legacy strings belong solely to the ordinary control;
  // Security Review must never contact this transport or adapt these into E9 output.
  const faux = fauxProvider({
    api: 'openai-responses',
    provider: 'fixture',
    models: [{ id: 'fixture-model' }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const legacyAllow = () =>
    fauxAssistantMessage(
      {
        type: 'toolCall',
        id: `ordinary-assessment-${randomUUID()}`,
        name: 'policy_gate-result',
        arguments: {
          decision: 'allow',
          risk: 'A public fixture echo only.',
          authorizationAssessment: 'The ordinary declared domain covers this effect.',
          rationale: 'No private input is present.',
        },
      },
      { stopReason: 'toolUse' }
    );
  faux.setResponses([legacyAllow, legacyAllow]);
  const providerResolutions: { providerId: string; model: string }[] = [];
  const participant = createAgentPolicyParticipant({
    coreDb,
    store,
    runtimeConfig: () => manager.current(),
    dispatcher: new LLMGatewayProviderDispatcher({ piAiClient: new PiAiGatewayClient({ models }) }),
    resolveGatewayProvider: (providerId, model) => {
      providerResolutions.push({ providerId, model });
      expect(providerId).toBe('fixture');
      expect(model).toBe('fixture-model');
      return {
        id: 'fixture',
        adapterId: 'fixture',
        displayName: 'Public faux transport',
        models: ['fixture-model'],
        baseUrl: null,
        apiKey: '',
        requiresApiKey: false,
        gatewayCapabilities: { responses: 'native', chatCompletions: 'native' },
        modelMetadata: {
          'fixture-model': { tool_call: true, limit: { context: 64_000, output: 2_000 } },
        },
      };
    },
  });
  const sdkCall = vi.spyOn(Client.prototype, 'callTool'); // passive: the real SDK/HTTP peer still runs
  let taskApp: ReturnType<typeof createApp> | undefined;
  let mcpApp: Hono | undefined;
  let token = '';
  let turnId = '';
  let protocolId = 0;
  async function start() {
    native = await createNativeTaskAdmissionFixture(coreDb, store, {
      readRuntimeConfig: () => manager.current(),
    });
    // Existing image/placement/Harness metadata peers do NOT prove physical execution.
    admitTestNativeEnvironment(coreDb, setup.manifest);
    gateway = createDefaultWorkerMcpGateway(coreDb);
    pending = createPendingRequestFixture({ coreDb, store, workspaceId: WORKSPACE });
    taskApp = createApp({
      mode: 'server',
      auth,
      coreDb,
      dataRoot,
      store,
      runtimeConfigManager: manager,
      fileAdmission: native.fileAdmission,
      turnExecutor: native.executor,
      workerLifecycleRuntime: native.runtime,
      workerControlGateway: native.workerControlGateway,
      workerMcpGateway: gateway,
    });
    mcpApp = new Hono();
    registerWorkerMcpRoutes({
      goalTaskPolicy: () => createGoalTaskPolicyService({ coreDb, store }),
      app: mcpApp,
      coreDb,
      store,
      runtimeConfig: () => manager.current(),
      workerControlGateway: native.workerControlGateway,
      workerMcpGateway: gateway,
      interception: new PolicyInterception(undefined, participant),
    });
    const response = await taskApp.request(
      ...operationRequest(
        'task.start',
        { workspaceId: WORKSPACE, threadId: THREAD },
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${administrator.secret}`,
          },
          body: JSON.stringify({
            input: 'Use the selected public fixture echo.',
            requestId: randomUUID(),
          }),
        }
      )
    );
    expect(response.status, 'The real Core Task producer must admit the requester.').toBe(202);
    const turn = StartTaskModeResponseSchema.parse(await response.json()).turn;
    turnId = turn.id;
    work = native.executionFor(turn.id);
    await work.launched.promise;
    const entry = findSchedulerAdmissionForTurn(coreDb, {
      workspaceId: WORKSPACE,
      threadId: THREAD,
      turnId,
    });
    if (!entry) throw new Error('The actual Turn has no scheduler admission.');
    closeout = getSchedulerPreparationClaims(coreDb).get(entry.queueEntryId);
    if (!closeout) throw new Error('The actual Turn has no full native closeout owner.');
    await native.waitForStartup(turn.id);
    token = native.executor.capabilityToken;
    const pkg = native.workerControlGateway.authenticatePackageToken(`Bearer ${token}`, {
      tokenFamily: 'capability',
    });
    expect(pkg.scope).toMatchObject({ workspaceId: WORKSPACE, threadId: THREAD, turnId });
    expect(store.getAgentSession(pkg.scope.agentSessionId).id).toBe(pkg.scope.agentSessionId);
    const list = await rpc('tools/list', {});
    expect(ListToolsResultSchema.parse(list.result).tools.map((tool) => tool.name)).toEqual([
      'echo',
    ]);
    expect(faux.state.callCount).toBe(0);
    expect(sdkCall).not.toHaveBeenCalled();
    return { turn, pkg };
  }
  async function rpc(method: 'tools/list' | 'tools/call', params: unknown) {
    if (!mcpApp || !token) throw new Error('No actual authenticated native requester exists.');
    const response = await mcpApp.request('/api/worker-capabilities/mcp/echo', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++protocolId, method, params }),
    });
    expect(response.status).toBe(200);
    return await response.json();
  }
  const call = async () =>
    CallToolResultSchema.parse(
      (
        await rpc('tools/call', {
          name: 'echo',
          arguments: { message: PUBLIC_MESSAGE },
        })
      ).result
    );
  const decisions = () => listExportableWorkspacePermissionDecisions(workspaceDb, WORKSPACE);
  const events = () => listWorkspaceAuditEvents(workspaceDb, WORKSPACE);
  const finals = () => decisions().filter((row) => row.mediation?.role === 'final');
  const pendingRows = () => {
    if (!pending) throw new Error('The real pending reader is not open.');
    return pending.list(THREAD);
  };
  return {
    coreDb,
    store,
    workspaceDb,
    manager,
    loaded,
    install,
    start,
    call,
    decisions,
    events,
    finals,
    pendingRows,
    faux,
    providerResolutions,
    sdkCall,
    currentTurnId: () => turnId,
  };
}

describe('Security Review through real Core Policy, native Kernel/decisions and Pending', () => {
  it('directly admits the human restrict-only security reviewer, never falls back to the default loop, and escalates a Kernel-allowed effect', async () => {
    const f = await fixture('security-review');
    // Server-only no-shadow admission is a PRODUCT expectation. OLD refuses its Server anchor;
    // later model-contact and native Pending assertions are then NOT reached.
    await f.install('active');
    expect(f.loaded().statements.find((entry) => entry.id === BINDING)).toMatchObject({
      state: 'active',
      participant: { kind: 'agent', id: 'security-review' },
    });
    const admitted = await f.start();
    const before = new Set(f.finals().map((row) => row.decisionId));
    const result = await f.call();
    expect(
      f.providerResolutions,
      'An absent decision route resolved the ordinary default Provider.'
    ).toEqual([]);
    expect(
      f.faux.state.callCount,
      'A Security Review without a decision route contacted the ordinary default model.'
    ).toBe(0);
    expect(
      f.sdkCall,
      'A missing decision route released the actual downstream Tool effect.'
    ).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    const finals = f.finals().filter((row) => !before.has(row.decisionId));
    expect(
      finals,
      'The real Core producer did not retain its actual mediated PermissionDecision.'
    ).toHaveLength(1);
    const final = finals[0]!;
    expect(final).toMatchObject({
      result: 'require_escalation',
      mediation: { role: 'final', kernel: { effect: 'allow' } },
    });
    expect(final.mediation?.invocations).toHaveLength(1);
    const gate = f
      .decisions()
      .filter((row) => row.mediation?.role === 'gate' && row.mediation.binding?.id === BINDING);
    expect(gate).toHaveLength(1);
    expect(gate[0]).toMatchObject({ result: 'require_escalation' });
    const permission = f
      .pendingRows()
      .filter(
        (row) =>
          row.kind === 'approval' && row.approvalKind === 'permission' && row.state === 'pending'
      );
    expect(
      permission,
      'Human escalation must be an actual owner-raised unresolved Pending, not only a deny/error string.'
    ).toHaveLength(1);
    expect(permission[0]).toMatchObject({
      requesterKind: 'worker',
      workspaceId: WORKSPACE,
      threadId: THREAD,
      raisingTurnId: admitted.turn.id,
      agentId: admitted.pkg.agent.agentId,
      agentSessionId: admitted.pkg.scope.agentSessionId,
      claim: 'unclaimed',
      resolution: null,
      disposition: null,
    });
    expect(permission[0]!.requestItemId).not.toBeNull();
    expect(
      f.store
        .getTurnById(admitted.turn.id)
        .items.find((item) => item.id === permission[0]!.requestItemId)
    ).toMatchObject({ type: 'approval-request', approvalRequestId: permission[0]!.requestId });
    expect(f.events().some((event) => event.permissionDecisionId === final.decisionId)).toBe(true);
  }, 60_000);

  it('preserves the ordinary gate fence: real shadow call and native evidence, actual human activation, then the existing default loop', async () => {
    const f = await fixture('ordinary-reviewer');
    await f.install('shadow');
    const shadow = f.loaded().statements.find((entry) => entry.id === BINDING);
    if (shadow?.kind !== 'binding') throw new Error('The real shadow binding was not admitted.');
    const shadowDigest = policyDigest(shadow);
    await f.start();
    const observed = await f.call();
    expect(observed.isError).not.toBe(true);
    expect(observed.content).toContainEqual({ type: 'text', text: PUBLIC_MESSAGE });
    await vi.waitFor(
      () => {
        expect(f.faux.state.callCount).toBe(1);
        const decision = f
          .decisions()
          .find(
            (row) =>
              row.mediation?.role === 'gate' &&
              row.mediation.binding?.id === BINDING &&
              row.mediation.binding.digest === shadowDigest
          );
        expect(decision, 'No actual native shadow PermissionDecision exists.').toBeDefined();
        expect(f.events()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: decision!.auditEventId,
              permissionDecisionId: decision!.decisionId,
              policyInvocation: expect.objectContaining({
                outcome: 'completed',
                binding: expect.objectContaining({ id: BINDING, digest: shadowDigest }),
                policyRevision: decision!.policySnapshotId,
              }),
            }),
          ])
        );
      },
      { timeout: 5_000, interval: 20 }
    );
    expect(f.sdkCall).toHaveBeenCalledTimes(1);
    expect(
      f.pendingRows().filter((row) => row.kind === 'approval' && row.approvalKind === 'permission')
    ).toHaveLength(0);
    await f.install('active');
    expect(f.loaded().statements.find((entry) => entry.id === BINDING)).toMatchObject({
      state: 'active',
      participant: { id: 'ordinary-reviewer' },
    });
    const before = new Set(f.finals().map((row) => row.decisionId));
    const permitted = await f.call();
    expect(permitted.isError).not.toBe(true);
    expect(permitted.content).toContainEqual({ type: 'text', text: PUBLIC_MESSAGE });
    expect(f.faux.state.callCount, 'E9 specialization changed an ordinary agent gate.').toBe(2);
    expect(f.sdkCall).toHaveBeenCalledTimes(2);
    const activeFinals = f.finals().filter((row) => !before.has(row.decisionId));
    expect(activeFinals).toHaveLength(1);
    expect(activeFinals[0]).toMatchObject({
      result: 'allow',
      mediation: { role: 'final', kernel: { effect: 'allow' } },
    });
    expect(
      f.pendingRows().filter((row) => row.kind === 'approval' && row.approvalKind === 'permission')
    ).toHaveLength(0);
  }, 60_000);
});

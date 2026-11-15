import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  TextContentSchema,
} from '@modelcontextprotocol/core';
import { OPERATION_REGISTRY, StartTaskModeResponseSchema } from '@openkit/app-api-schemas';
import { UserConfigSchema, type WorkspaceMcpServerCatalog } from '@openkit/config-schema';
import {
  type ActorRef,
  ApiErrorSchema,
  ApprovalRequestSchema,
  allocateEntityId,
  type PolicyBindingV1,
} from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from './auth/access-token-store.js';
import { listWorkspaceCapabilityCalls } from './capability/usage-ledger.js';
import { replaceWorkspaceEffectiveMcpCatalog } from './catalog/resource-catalog.js';
import { createAdministrationConfiguration } from './config/administration-configuration.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
  loadRuntimeConfig,
} from './config/runtime-config.js';
import { RuntimeConfigFileService } from './config/runtime-config-files.js';
import { FsStore } from './lib/store.js';
import type { GatewayDecisionAction, GatewayDecisionResult } from './llm/gateway-decision.js';
import type { LLMGatewayProviderDispatcher } from './llm/provider-dispatcher.js';
import { createAgentPolicyParticipant } from './policy/agent-gate-provider.js';
import { readAdmittedPolicyDocument } from './policy/configuration.js';
import { PolicyInterception } from './policy/interception.js';
import { listExportableWorkspacePermissionDecisions } from './policy/permission-decisions.js';
import { type PolicyProposal, policyDigest } from './policy/statements.js';
import { ProviderRegistry } from './providers/registry.js';
import {
  listExportableMcpToolSchemaSnapshots,
  mcpToolSchemaContentDigest,
} from './runtime/mcp-tool-schema-snapshots.js';
import type { PendingRequestRecord } from './runtime/pending-requests.js';
import {
  getSchedulerPreparationClaims,
  runSchedulerDispatchLoop,
  type SchedulerDispatchLoopResult,
} from './runtime/scheduler-dispatch-loop.js';
import { createDefaultWorkerMcpGateway } from './runtime/worker-mcp-gateway.js';
import { findSchedulerAdmissionForTurn } from './scheduler-records.js';
import { closeWorkspaceProductReadHandles } from './storage/control-store-product-records.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './storage/control-store-worker-client.js';
import type { CoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createTestAgentSetup, createTestGatewayConfig } from './test-support/agent-environment.js';
import { createAppWithLocalIdentity as createApp } from './test-support/app.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from './test-support/demo-store.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { createMcpHttpStub } from './test-support/mcp-http-stub.js';
import { admitTestNativeEnvironment } from './test-support/native-environment.js';
import { createNativeTaskAdmissionFixture } from './test-support/native-task-admission.js';
import { operationRequest } from './test-support/operation-request.js';
import { createPendingRequestFixture } from './test-support/pending-request.js';
import { closeTestCoreDb, createTestCoreDb, createTestWorkspaceDb } from './test-support/store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

type Tools = Awaited<ReturnType<Client['listTools']>>['tools'];
const toolA: Tools[number] = {
  name: 'echo',
  description: 'Return a public fixture message.',
  inputSchema: {
    type: 'object',
    properties: { message: { type: 'string' } },
    required: ['message'],
    additionalProperties: false,
  },
};
const toolB: Tools[number] = { ...toolA, description: 'Return a changed public fixture message.' };
const toolC: Tools[number] = {
  ...toolB,
  inputSchema: {
    type: 'object',
    properties: { count: { type: 'integer' } },
    required: ['count'],
    additionalProperties: false,
  },
};
const neverObservedTool: Tools[number] = {
  ...toolB,
  inputSchema: {
    type: 'object',
    properties: { unpublished: { type: 'boolean' } },
    required: ['unpublished'],
    additionalProperties: false,
  },
};
const stable: Tools[number] = {
  name: 'stable',
  description: 'An unchanged public fixture operation.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

afterEach(() => vi.restoreAllMocks());

describe('MCP definition review through real Pending and native admission', () => {
  async function definitionReviewFlow(processlessReview = false, cacheReview = false) {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-mcp-definition-review-'));
    const upstream = await createMcpHttpStub({ serverVersion: 'primary-fixture' });
    const foreignUpstream = await createMcpHttpStub({ serverVersion: 'foreign-fixture' });
    const workspaceId = DEMO_WORKSPACE_ID;
    const threadId = DEMO_THREAD_ID;
    const initialCore = createTestCoreDb(dataRoot);
    applyMigrations(initialCore);
    const actor: ActorRef = { kind: 'user', id: ensureLocalUser(initialCore) };
    const initialStore = await createDemoStore({ dataRoot, knowledge: [] });
    recordWorkspaceOwnerMembership({ coreDb: initialCore, ownerUserId: actor.id, workspaceId });
    const caller = createOpenKitAccessTokenRecord(initialCore, {
      ownerUserId: actor.id,
      scope: 'workspace',
      workspaceIds: [workspaceId],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const administrator = createOpenKitAccessTokenRecord(initialCore, {
      ownerUserId: actor.id,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const revokedAdministrator = createOpenKitAccessTokenRecord(initialCore, {
      ownerUserId: actor.id,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const catalog: WorkspaceMcpServerCatalog = {
      schemaVersion: 1,
      servers: [
        {
          id: 'echo',
          enabled: true,
          allowedTools: ['echo', 'stable'],
          credentialBindings: [],
          pinnedSchemaSnapshotId: null,
          schemaPolicy: 'tracking',
          timeoutMs: 2_000,
          transport: { kind: 'http', endpoint: upstream.url },
        },
        {
          id: 'foreign',
          enabled: true,
          allowedTools: ['echo', 'stable'],
          credentialBindings: [],
          pinnedSchemaSnapshotId: null,
          schemaPolicy: 'tracking',
          timeoutMs: 2_000,
          transport: { kind: 'http', endpoint: foreignUpstream.url },
        },
      ],
    };
    const setup = createTestAgentSetup({
      mcpIds: ['echo', 'foreign'],
      requiredCapabilities: ['trusted-worker-inference-relay'],
    });
    let configuration = createInMemoryRuntimeConfigSnapshot({
      dataRoot,
      gatewayConfig: createTestGatewayConfig(),
      userConfigs: [
        {
          userId: actor.id,
          path: join(dataRoot, 'users', actor.id, 'config', 'user.jsonc'),
          config: UserConfigSchema.parse({
            schemaVersion: 1,
            knowledgeMaintenance: { enabled: false, reviewRequiredPageIds: [] },
          }),
        },
      ],
      providerRegistry: new ProviderRegistry([
        {
          id: 'agent-openrouter',
          displayName: 'Uncalled local fixture route',
          kind: 'local',
          models: ['openai/gpt-5.2'],
        },
      ]),
      workspaceConfigs: loadRuntimeConfig(dataRoot).workspaceConfigs,
      agentManifests: [setup.manifest],
      workspaceMcpServerCatalogs: [{ catalog, path: join(dataRoot, 'catalog.json'), workspaceId }],
    });
    let reviewManager: ReturnType<typeof createRuntimeConfigManager> | undefined;
    if (processlessReview) {
      const config = join(dataRoot, 'config');
      mkdirSync(join(config, 'agents'), { recursive: true });
      mkdirSync(join(config, 'providers'), { recursive: true });
      writeFileSync(
        join(config, 'server.jsonc'),
        JSON.stringify({
          schemaVersion: 1,
          policy: { mediation: { schemaVersion: 1, statements: [] } },
        })
      );
      writeFileSync(
        join(config, 'agents', `${setup.manifest.id}.agent.jsonc`),
        JSON.stringify(setup.manifest)
      );
      writeFileSync(join(config, 'gateway.jsonc'), JSON.stringify(createTestGatewayConfig()));
      writeFileSync(
        join(config, 'providers', 'fixture.provider.jsonc'),
        JSON.stringify({
          schemaVersion: 1,
          id: 'agent-openrouter',
          displayName: 'Uncalled local fixture route',
          kind: 'local',
          models: ['openai/gpt-5.2'],
          modelMetadata: {
            'openai/gpt-5.2': { tool_call: true, limit: { context: 64_000, output: 8_000 } },
          },
        })
      );
      const userPath = join(dataRoot, 'users', actor.id, 'config');
      mkdirSync(userPath, { recursive: true });
      writeFileSync(
        join(userPath, 'user.jsonc'),
        JSON.stringify(
          UserConfigSchema.parse({
            schemaVersion: 1,
            knowledgeMaintenance: { enabled: false, reviewRequiredPageIds: [] },
          })
        )
      );
      replaceWorkspaceEffectiveMcpCatalog({ dataRoot, workspaceId, catalog });
      reviewManager = createRuntimeConfigManager({ dataRoot });
      configuration = reviewManager.current();
    }
    const ordinaryGeneration = vi.fn(async () => {
      throw new Error('C4 must not use ordinary generation.');
    });
    const dispatcher = {
      createResponses: ordinaryGeneration,
      createChatCompletion: ordinaryGeneration,
    } as unknown as LLMGatewayProviderDispatcher;
    const requestSecurityReviewDecision = vi.fn(
      async (_input: {
        binding: PolicyBindingV1;
        proposal: PolicyProposal;
        signal: AbortSignal;
        deadline: number;
        action?: GatewayDecisionAction;
      }): Promise<GatewayDecisionResult> => ({
        decision: cacheReview ? 'block' : 'escalate',
        reasonCode: cacheReview ? 'policy_risk' : 'review_failed',
        metric: cacheReview
          ? { kind: 'native_probability', allowProbability: 0.01, confidence: 0.99 }
          : { kind: 'failure', code: 'invalid_input' },
        usageRecordIds: [],
        capabilityCallId: allocateEntityId('cap'),
        route: {
          logicalModelId: 'unqualified-fixture',
          routeId: 'unqualified-fixture',
          mode: 'native',
        },
      })
    );
    const policyInterception = processlessReview
      ? new PolicyInterception(
          undefined,
          createAgentPolicyParticipant({
            coreDb: initialCore,
            store: initialStore,
            runtimeConfig: () => reviewManager!.current(),
            dispatcher,
            resolveGatewayProvider: () => {
              throw new Error('No Provider route is qualified by this fixture.');
            },
            ...{ requestSecurityReviewDecision },
          })
        )
      : undefined;
    let supplied: Tools = structuredClone([toolA, stable]);
    const observations: Array<{ server: string; tools: Tools }> = [];
    vi.spyOn(Client.prototype, 'listTools').mockImplementation(async function (this: Client) {
      const version = this.getServerVersion()?.version;
      if (version !== 'primary-fixture' && version !== 'foreign-fixture')
        throw new Error('The SDK observation did not come from an isolated upstream peer.');
      const tools = structuredClone(version === 'foreign-fixture' ? [toolB, stable] : supplied);
      observations.push({ server: version, tools: structuredClone(tools) });
      return { tools };
    });
    // These existing image/placement/Harness facts are modeled setup, not physical native evidence.
    const openController = async (
      coreDb: CoreDb,
      store: FsStore,
      outside?: Awaited<ReturnType<typeof createNativeTaskAdmissionFixture>>['outside']
    ) => {
      const admission = getControlStoreWorkerClient().workspaceMutations(dataRoot);
      const native = await createNativeTaskAdmissionFixture(
        coreDb,
        store,
        {
          readRuntimeConfig: () => configuration,
          workspaceMutationAdmission: admission,
        },
        outside
      );
      admitTestNativeEnvironment(coreDb, setup.manifest);
      const gateway = createDefaultWorkerMcpGateway(coreDb);
      const app = createApp({
        coreDb,
        store,
        workspaceMutationAdmission: admission,
        fileAdmission: native.fileAdmission,
        turnExecutor: native.executor,
        workerLifecycleRuntime: native.runtime,
        workerControlGateway: native.workerControlGateway,
        workerMcpGateway: gateway,
        ...(policyInterception ? { policyInterception } : {}),
        runtimeConfigManager:
          reviewManager ??
          createRuntimeConfigManager({
            dataRoot: null,
            initialSnapshot: configuration,
          }),
      });
      const pendingRequests = createPendingRequestFixture({ coreDb, store, workspaceId });
      return { coreDb, store, native, gateway, app, pendingRequests };
    };
    let controller = await openController(initialCore, initialStore);
    let work: ReturnType<typeof controller.native.executionFor> | undefined;
    let currentTurnId: string | undefined;
    let preparation: Promise<SchedulerDispatchLoopResult> | undefined;
    let outcomeDispatch: Promise<SchedulerDispatchLoopResult> | undefined;
    const ownPreparation = (turnId: string) => {
      const entry = findSchedulerAdmissionForTurn(controller.coreDb, {
        workspaceId,
        threadId,
        turnId,
      });
      if (!entry) throw new Error('The admitted Turn has no canonical scheduler entry.');
      const claim = getSchedulerPreparationClaims(controller.coreDb).get(entry.queueEntryId);
      if (!claim) throw new Error('The admitted Turn has no live scheduler closeout owner.');
      return claim;
    };
    let capabilityToken = '';
    let protocolId = 0;
    const startTurn = async () => {
      const response = await controller.app.request(
        ...operationRequest(
          'task.start',
          { workspaceId, threadId },
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${caller.secret}`,
            },
            body: JSON.stringify({
              input: 'Discover the selected public fixture interfaces.',
              requestId: randomUUID(),
            }),
          }
        )
      );
      expect(
        response.status,
        'The actual Core Task producer must admit the next discovery Turn.'
      ).toBe(202);
      const turn = StartTaskModeResponseSchema.parse(await response.json()).turn;
      currentTurnId = turn.id;
      work = controller.native.executionFor(turn.id);
      await work.launched.promise;
      preparation = ownPreparation(turn.id);
      await controller.native.waitForStartup(turn.id);
      capabilityToken = controller.native.executor.capabilityToken;
      const pkg = controller.native.workerControlGateway.authenticatePackageToken(
        `Bearer ${capabilityToken}`,
        { tokenFamily: 'capability' }
      );
      expect(pkg.scope).toMatchObject({ workspaceId, threadId, turnId: turn.id });
      expect(controller.store.getAgentSession(pkg.scope.agentSessionId).id).toBe(
        pkg.scope.agentSessionId
      );
      return { turn, pkg };
    };
    const finishTurn = async () => {
      if (!work || !currentTurnId || !preparation)
        throw new Error('No actual discovery Turn is available to complete.');
      work.completion.resolve();
      await work.execution;
      // Native execution ends before the scheduler relinquishes its full closeout claim.
      await preparation;
      await outcomeDispatch;
      expect(controller.store.getTurnById(currentTurnId).status).toBe('completed');
      work = undefined;
      currentTurnId = undefined;
      preparation = undefined;
      outcomeDispatch = undefined;
    };
    const discover = async (via: 'direct' | 'fallback', serverId = 'echo') => {
      const response = await controller.app.request(
        `/api/worker-capabilities/mcp/${via === 'direct' ? serverId : '_discovery'}`,
        {
          method: 'POST',
          headers: {
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${capabilityToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: ++protocolId,
            method: via === 'direct' ? 'tools/list' : 'tools/call',
            params: via === 'direct' ? {} : { name: 'mcp.list-tools', arguments: { serverId } },
          }),
        }
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      if (via === 'direct') return ListToolsResultSchema.parse(body.result);
      const result = CallToolResultSchema.parse(body.result);
      expect(result.isError).not.toBe(true);
      expect(result.content).toHaveLength(1);
      return ListToolsResultSchema.parse(
        JSON.parse(TextContentSchema.parse(result.content[0]).text)
      );
    };
    const captured = (serverId: string, turnId: string) => {
      const db = createTestWorkspaceDb(dataRoot, workspaceId);
      try {
        const call = listWorkspaceCapabilityCalls(db, workspaceId).find(
          (row) =>
            row.turnId === turnId &&
            row.providerRef === serverId &&
            row.operation === 'mcp.list-tools'
        );
        expect(call).toMatchObject({ status: 'succeeded', schemaSnapshotId: expect.any(String) });
        if (!call?.schemaSnapshotId)
          throw new Error('The actual native discovery Call has no schema reference.');
        const row = listExportableMcpToolSchemaSnapshots(db, workspaceId).find(
          (snapshot) => snapshot.schemaSnapshotId === call.schemaSnapshotId
        );
        if (!row) throw new Error('The acknowledged MCP observation is not retained by its owner.');
        return row;
      } finally {
        closeTestCoreDb(db);
      }
    };
    const pending = () => controller.pendingRequests.list(threadId);
    const joinOutcomeTurn = async (requestId: string) => {
      const { turnId, entry } = await vi.waitFor(
        () => {
          const id = pending().find((record) => record.requestId === requestId)?.deliveryTurnId;
          if (!id) throw new Error('The real Pending owner has not admitted its outcome Turn.');
          const entry = findSchedulerAdmissionForTurn(controller.coreDb, {
            workspaceId,
            threadId,
            turnId: id,
          });
          if (!entry) throw new Error('The real outcome Turn has no canonical scheduler entry.');
          return { turnId: id, entry };
        },
        { timeout: 10_000 }
      );
      currentTurnId = turnId;
      const outcomeWork = controller.native.executionFor(turnId);
      work = outcomeWork;
      const executionBackend = controller.native.executor.executionBackend;
      if (!executionBackend) throw new Error('The actual native execution backend is missing.');
      // The App's one-shot dispatch can defer while the preceding Turn still owns closeout.
      // Drive or join only the already-published outcome entry through the real FIFO owner.
      outcomeDispatch = runSchedulerDispatchLoop({
        coreDb: controller.coreDb,
        store: controller.store,
        turnExecutor: controller.native.executor,
        executionBackend,
        callerQueueEntryId: entry.queueEntryId,
        maxDispatches: 1,
        agentManifests: configuration.agentManifests,
        gatewayConfig: configuration.gatewayConfig,
        providerRegistry: configuration.providerRegistry,
        workspaceConfigs: configuration.workspaceConfigs,
        userConfigs: configuration.userConfigs,
        configVersion: configuration.version,
        workspaceDataSourceCatalogs: configuration.workspaceDataSourceCatalogs,
        workspaceMcpServerCatalogs: configuration.workspaceMcpServerCatalogs,
      });
      void outcomeDispatch.catch(() => undefined);
      await Promise.race([
        outcomeWork.launched.promise,
        outcomeDispatch.then((result) => {
          if (!result.startedTurns.some((started) => started.dispatch.entry.turnId === turnId))
            throw new Error('The real scheduler did not submit the owner-created outcome Turn.');
          return outcomeWork.launched.promise;
        }),
      ]);
      preparation = ownPreparation(turnId);
      await controller.native.waitForStartup(turnId);
      capabilityToken = controller.native.executor.capabilityToken;
      const pkg = controller.native.workerControlGateway.authenticatePackageToken(
        `Bearer ${capabilityToken}`,
        { tokenFamily: 'capability' }
      );
      expect(pkg.scope).toMatchObject({ workspaceId, threadId, turnId });
      return { turn: controller.store.getTurnById(turnId), pkg };
    };
    const respond = (record: PendingRequestRecord, secret: string, requestId = randomUUID()) =>
      controller.app.request(
        ...operationRequest(
          'approval.respond',
          {
            workspaceId: record.workspaceId,
            threadId: record.threadId,
            turnId: record.raisingTurnId,
            approvalRequestId: record.requestId,
          },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
            body: JSON.stringify({ decision: 'granted', requestId }),
          }
        )
      );
    try {
      const a = await startTurn();
      expect((await discover('direct')).tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: toolA.name, inputSchema: toolA.inputSchema }),
          expect.objectContaining({ name: stable.name, inputSchema: stable.inputSchema }),
        ])
      );
      expect((await discover('fallback')).tools.map((tool) => tool.name)).toEqual([
        'echo',
        'stable',
      ]);
      expect((await discover('direct', 'foreign')).tools).toHaveLength(2);
      const capturedA = captured('echo', a.turn.id);
      const foreignA = captured('foreign', a.turn.id);
      expect(foreignA.catalogEntryId).toBe('foreign');
      expect(foreignA.schemaSnapshotId).not.toBe(capturedA.schemaSnapshotId);
      await finishTurn();
      supplied = structuredClone([toolB, stable]);
      const b = await startTurn();
      expect(b.turn.id).not.toBe(a.turn.id);
      const nativeWrites = vi.spyOn(getControlStoreWorkerClient(), 'workspaceCapability');
      const withheld = await discover('direct');
      expect(observations.at(-1)).toEqual({ server: 'primary-fixture', tools: [toolB, stable] });
      const captureIndex = nativeWrites.mock.calls.findIndex(
        ([, command]) =>
          command.kind === 'mcp-schema' && command.environmentPackage.scope.turnId === b.turn.id
      );
      expect(captureIndex).toBeGreaterThanOrEqual(0);
      await expect(nativeWrites.mock.results[captureIndex]?.value).resolves.toMatchObject({
        liveSnapshotId: expect.any(String),
      });
      // OLD must fail here on actual B exposure, before any new governed intent is needed.
      expect(
        withheld.tools.map((tool) => tool.name),
        'Core exposed changed B before exact administrator review.'
      ).not.toContain(toolB.name);
      expect((await discover('fallback')).tools.map((tool) => tool.name)).not.toContain(toolB.name);
      const capturedB = captured('echo', b.turn.id);
      expect(capturedB.tools).toEqual(expect.arrayContaining([expect.objectContaining(toolB)]));
      expect(capturedB.contentDigest).not.toBe(capturedA.contentDigest);
      // Identical bytes on another binding must not substitute for this binding's observation.
      expect(foreignA.contentDigest).toBe(capturedB.contentDigest);
      const selected = b.pkg.supply.mcpServers.find((server) => server.id === 'echo');
      if (!selected)
        throw new Error('The actual admitted package did not select the primary binding.');
      const expectedIntent = {
        operation: 'mcp.definition.approve',
        catalogEntryId: 'echo',
        catalogDigest: selected.catalogDigest,
        schemaSnapshotId: capturedB.schemaSnapshotId,
        schemaDigest: capturedB.contentDigest,
      };
      const requestsB = pending().filter(
        (record) =>
          record.state === 'pending' &&
          record.governedIntent?.operation === 'mcp.definition.approve' &&
          record.governedIntent.catalogEntryId === 'echo'
      );
      expect(requestsB).toHaveLength(1);
      const original = requestsB[0];
      if (!original)
        throw new Error('Actual B discovery did not raise its real permission request.');
      expect(original).toMatchObject({
        kind: 'approval',
        approvalKind: 'permission',
        requesterKind: 'worker',
        agentId: b.pkg.agent.agentId,
        agentSessionId: b.pkg.scope.agentSessionId,
        responsibleUserId: actor.id,
        raisingTurnId: b.turn.id,
        claim: 'unclaimed',
        resolution: null,
        disposition: null,
      });
      expect(original.governedIntent).toEqual(expectedIntent);
      expect(
        controller.store
          .getTurnById(b.turn.id)
          .items.find((item) => item.id === original.requestItemId)
      ).toMatchObject({ type: 'approval-request', approvalRequestId: original.requestId });

      if (processlessReview) {
        if (!reviewManager) throw new Error('The real Policy configuration owner is unavailable.');
        const home = await controller.store.ensureQuickChatWorkspace(actor.id);
        const homeDb = createTestWorkspaceDb(dataRoot, home.id);
        try {
          const homeThread = await controller.store.createThread(
            home.id,
            'Human C4 Policy review',
            allocateEntityId('th'),
            'administration',
            { visibility: 'private', privateOwnerUserId: actor.id }
          );
          const homeTurn = await controller.store.createTurn(
            home.id,
            homeThread.id,
            'Review this exact C4 binding.',
            actor,
            null
          );
          const files = new RuntimeConfigFileService({
            dataRoot,
            userId: actor.id,
            workspaceIds: [home.id, workspaceId],
            runtimeConfigManager: reviewManager,
            readRuntimeConfigStatus: () => reviewManager!.status(),
          });
          const service = createAdministrationConfiguration({
            coreDb: controller.coreDb,
            store: controller.store,
            files,
            actor: {
              kind: 'token',
              userId: actor.id,
              tokenId: administrator.tokenId,
              tokenScope: 'server-admin',
              tokenWorkspaceIds: [],
            },
            runtimeConfig: () => reviewManager!.current(),
            reload: () => reviewManager!.reload({ mode: 'safe', dryRun: false }),
            repositoryWorkspaceDb: (id) => {
              if (id === home.id) return homeDb;
              throw new Error('No configuration repository authority for another Workspace.');
            },
            inflightCommands: new WeakMap(),
          });
          const loaded = () =>
            readAdmittedPolicyDocument(
              controller.coreDb,
              reviewManager!.current().openKitConfig.policy?.mediation
            );
          const publish = async (statements: unknown[]) => {
            const candidate = await service.propose(
              {
                targetFamily: 'policy',
                targetId: 'server',
                expectedRevision: files.readFile('server.jsonc').file.revision!,
                changes: {
                  proposed: { schemaVersion: 1, statements },
                  rationale: 'Human review of the private C4 decision binding.',
                },
              },
              { threadId: homeThread.id, turnId: homeTurn.id, requestId: randomUUID() }
            );
            expect(
              await service.apply({
                requestId: randomUUID(),
                candidate: candidate.candidate,
                confirmation: candidate.confirmation,
              })
            ).toMatchObject({ persisted: true, reload: 'applied' });
          };
          const human = { kind: 'human' as const, id: actor.id };
          const target = {
            kind: 'container' as const,
            container: {
              owner: { kind: 'workspace' as const, workspaceId },
              kind: 'workspace',
              id: workspaceId,
            },
          };
          const right = OPERATION_REGISTRY['approval.respond'].policyOperation;
          const scope = { subjects: [human], actions: [right], resources: [target] };
          const common = {
            author: human,
            authority: { kind: 'human', userId: actor.id },
            authoredAt: new Date().toISOString(),
            state: 'active',
            lifetime: { anchor: { owner: { kind: 'server' }, kind: 'server', id: 'server' } },
          };
          await publish([
            {
              ...common,
              kind: 'agent-principal',
              id: 'c4-reviewer',
              agentId: 'security-review',
              creator: human,
              responsibleHumanId: actor.id,
              responsibility: human,
              scope: { ...scope, subjects: [{ kind: 'agent', id: 'security-review' }] },
            },
          ]);
          const declaration = loaded().statements.find(
            (statement) =>
              statement.kind === 'agent-principal' && statement.agentId === 'security-review'
          );
          if (!declaration)
            throw new Error('The real human did not activate the reviewer declaration.');
          await publish([
            ...loaded().statements,
            {
              ...common,
              kind: 'binding',
              id: 'processless-c4-review',
              scope,
              operation: 'mcp.definition.approve',
              stage: 'decide',
              mode: 'gate',
              participant: {
                kind: 'agent',
                id: 'security-review',
                version: policyDigest(declaration),
              },
              inputDisclosure: scope,
              order: 0,
              timeoutMs: 2_000,
              failure: 'escalate-to-human',
              circuit: { failures: 1, recoveryAfterMs: 60_000 },
            },
          ]);
          const responseRequestId = randomUUID();
          const response = await respond(original, administrator.secret, responseRequestId);
          expect(response.status, await response.clone().text()).toBe(409);
          expect(await response.json()).toMatchObject({ code: 'approval_preview_unavailable' });
          expect(requestSecurityReviewDecision).toHaveBeenCalledTimes(1);
          const input = requestSecurityReviewDecision.mock.calls[0]![0];
          expect(input.proposal.subject).toMatchObject({
            principal: human,
            onBehalfOf: null,
            process: null,
          });
          expect(input.action).toMatchObject({
            principal: human,
            onBehalfOf: null,
            operation: 'mcp.definition.approve',
            target,
            destinationAudience: null,
            definitionChange: {
              oldDigest: capturedA.contentDigest,
              newDigest: capturedB.contentDigest,
            },
          });
          expect(input.action?.influenceSources.join('\n')).toContain(capturedB.schemaSnapshotId);
          const text = input.action?.definitionChange?.newText;
          expect(typeof text).toBe('string');
          expect(text).toContain(toolB.name);
          expect(text).toContain(toolB.description!);
          expect(text).toContain('message');
          expect(text).toContain(stable.name);
          expect(text).toContain(stable.description!);
          expect(Buffer.byteLength(text!, 'utf8')).toBeLessThanOrEqual(8192);
          expect(ordinaryGeneration).not.toHaveBeenCalled();
          expect(
            controller.store.getCommandRequest('approval.respond', responseRequestId, {
              workspaceId,
              threadId,
              turnId: original.raisingTurnId,
            })
          ).toBeFalsy();
          expect(pending().find((record) => record.requestId === original.requestId)).toMatchObject(
            { state: 'pending', resolution: null, disposition: null }
          );
          expect((await discover('direct')).tools.map((tool) => tool.name)).not.toContain(
            toolB.name
          );
          if (cacheReview) {
            // This is unqualified requester-effect/cache evidence, not Provider, evaluation or usage evidence.
            const decisionsDb = createTestWorkspaceDb(dataRoot, workspaceId);
            try {
              const finalDecisions = () =>
                listExportableWorkspacePermissionDecisions(decisionsDb, workspaceId).filter(
                  (decision) =>
                    decision.mediation?.role === 'final' &&
                    decision.mediation.operation === 'mcp.definition.approve'
                );
              expect(finalDecisions()).toHaveLength(1);
              const replay = await respond(original, administrator.secret, randomUUID());
              expect(replay.status, await replay.clone().text()).toBe(409);
              expect(requestSecurityReviewDecision).toHaveBeenCalledTimes(1);
              expect(finalDecisions()).toHaveLength(2);
              vi.useFakeTimers({ toFake: ['Date'] });
              try {
                vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000 + 1);
                const expired = await respond(original, administrator.secret, randomUUID());
                expect(expired.status, await expired.clone().text()).toBe(409);
                expect(requestSecurityReviewDecision).toHaveBeenCalledTimes(2);
                expect(finalDecisions()).toHaveLength(3);
              } finally {
                vi.useRealTimers();
              }
            } finally {
              closeTestCoreDb(decisionsDb);
            }
          }
          return;
        } finally {
          closeTestCoreDb(homeDb);
        }
      }
      const unobservedDigest = mcpToolSchemaContentDigest([neverObservedTool, stable]);
      expect([
        capturedA.contentDigest,
        capturedB.contentDigest,
        foreignA.contentDigest,
      ]).not.toContain(unobservedDigest);
      const faultIntents = [
        {
          name: 'old A',
          intent: {
            ...expectedIntent,
            schemaSnapshotId: capturedA.schemaSnapshotId,
            schemaDigest: capturedA.contentDigest,
          },
        },
        {
          name: 'foreign snapshot',
          intent: {
            ...expectedIntent,
            schemaSnapshotId: foreignA.schemaSnapshotId,
            schemaDigest: foreignA.contentDigest,
          },
        },
        {
          name: 'never observed digest',
          intent: { ...expectedIntent, schemaDigest: unobservedDigest },
        },
      ];
      for (const fault of faultIntents) {
        // Real pending-only counterfault input, never an approved row or a fabricated human proof.
        const proposal = await controller.pendingRequests.raise({
          requestId: randomUUID(),
          requestItemId: allocateEntityId('it'),
          workspaceId,
          threadId,
          raisingTurnId: b.turn.id,
          kind: 'approval',
          requesterKind: original.requesterKind,
          responsibleUserId: original.responsibleUserId,
          agentId: original.agentId,
          agentSessionId: original.agentSessionId,
          governedIntent: fault.intent,
          approval: {
            kind: 'permission',
            title: `Inspect ${fault.name}.`,
            description: 'This candidate must not release the current MCP definition.',
          },
          now: new Date().toISOString(),
        });
        const refused = await respond(proposal, administrator.secret);
        expect(
          refused.status,
          `${fault.name} must not be accepted as current B authority.`
        ).toBeGreaterThanOrEqual(400);
        expect(refused.status).toBeLessThan(500);
        ApiErrorSchema.parse(await refused.json());
        expect(pending().find((record) => record.requestId === proposal.requestId)).toMatchObject({
          state: 'pending',
          resolution: null,
          claim: 'unclaimed',
          disposition: null,
        });
        expect((await discover('direct')).tools.map((tool) => tool.name)).not.toContain(toolB.name);
        expect((await discover('fallback')).tools.map((tool) => tool.name)).not.toContain(
          toolB.name
        );
      }
      const nonadmin = await respond(original, caller.secret);
      expect(nonadmin.status).toBeGreaterThanOrEqual(400);
      expect(nonadmin.status).toBeLessThan(500);
      ApiErrorSchema.parse(await nonadmin.json());
      expect(
        revokeOpenKitAccessTokenRecord(controller.coreDb, revokedAdministrator.tokenId)?.status
      ).toBe('revoked');
      const revoked = await respond(original, revokedAdministrator.secret);
      expect(revoked.status).toBeGreaterThanOrEqual(400);
      expect(revoked.status).toBeLessThan(500);
      ApiErrorSchema.parse(await revoked.json());
      expect(pending().find((record) => record.requestId === original.requestId)).toMatchObject({
        state: 'pending',
        resolution: null,
        claim: 'unclaimed',
        disposition: null,
      });
      expect((await discover('direct')).tools.map((tool) => tool.name)).not.toContain(toolB.name);

      const pendingWrites = vi.spyOn(getControlStoreWorkerClient(), 'pendingCommand');
      const decisionId = randomUUID();
      const granted = await respond(original, administrator.secret, decisionId);
      expect(
        granted.status,
        'The actual current administrator must be able to admit exact B.'
      ).toBe(200);
      expect(ApprovalRequestSchema.parse(await granted.json())).toMatchObject({
        id: original.requestId,
        status: 'granted',
      });
      const grantIndex = pendingWrites.mock.calls.findIndex(
        ([, transition]) =>
          transition.input.action === 'grant-command' &&
          transition.input.requestId === original.requestId
      );
      expect(
        grantIndex,
        'Release must traverse the real native Pending command.'
      ).toBeGreaterThanOrEqual(0);
      await expect(pendingWrites.mock.results[grantIndex]?.value).resolves.toMatchObject({
        requestIds: expect.arrayContaining([original.requestId]),
      });
      const resolvedB = pending().find((record) => record.requestId === original.requestId);
      expect(resolvedB).toMatchObject({
        state: 'resolved',
        resolution: 'granted',
        claim: 'unclaimed',
        disposition: null,
        decidingActor: { kind: 'user', id: actor.id },
        decidingActorContext: {
          kind: 'token',
          tokenId: administrator.tokenId,
          tokenScope: 'server-admin',
        },
      });
      expect(resolvedB?.governedIntent).toEqual(original.governedIntent);
      pendingWrites.mockRestore();
      nativeWrites.mockRestore();
      await finishTurn();
      // Worker Pending delivery owns this next Turn; do not race it with task.start.
      const admittedB = await joinOutcomeTurn(original.requestId);
      expect(admittedB.turn.id).not.toBe(b.turn.id);
      for (const via of ['direct', 'fallback'] satisfies Array<'direct' | 'fallback'>) {
        expect((await discover(via)).tools).toEqual(
          expect.arrayContaining([expect.objectContaining(toolB), expect.objectContaining(stable)])
        );
      }
      expect(captured('echo', admittedB.turn.id).contentDigest).toBe(capturedB.contentDigest);
      await finishTurn();
      const outside = controller.native.outside;
      await controller.native.restore();
      await controller.gateway.close();
      controller.pendingRequests.close();
      closeWorkspaceProductReadHandles(dataRoot);
      await shutdownControlStoreWorkerClient();
      closeTestCoreDb(controller.coreDb);
      controller = await openController(
        createTestCoreDb(dataRoot),
        new FsStore({ dataRoot }),
        outside
      );
      const afterRestart = await startTurn();
      for (const via of ['direct', 'fallback'] satisfies Array<'direct' | 'fallback'>) {
        expect((await discover(via)).tools).toEqual(
          expect.arrayContaining([expect.objectContaining(toolB), expect.objectContaining(stable)])
        );
      }
      expect(captured('echo', afterRestart.turn.id).contentDigest).toBe(capturedB.contentDigest);
      expect(pending().find((record) => record.requestId === original.requestId)).toMatchObject({
        state: 'resolved',
        resolution: 'granted',
        decidingActor: { kind: 'user', id: actor.id },
      });
      await finishTurn();
      supplied = structuredClone([toolC, stable]);
      const c = await startTurn();
      expect(c.turn.id).not.toBe(afterRestart.turn.id);
      for (const via of ['direct', 'fallback'] satisfies Array<'direct' | 'fallback'>) {
        expect((await discover(via)).tools.map((tool) => tool.name)).not.toContain(toolC.name);
      }
      const capturedC = captured('echo', c.turn.id);
      expect(capturedC.contentDigest).not.toBe(capturedB.contentDigest);
      expect(capturedC.tools).toEqual(expect.arrayContaining([expect.objectContaining(toolC)]));
      expect(pending()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            state: 'pending',
            governedIntent: {
              ...expectedIntent,
              schemaSnapshotId: capturedC.schemaSnapshotId,
              schemaDigest: capturedC.contentDigest,
            },
          }),
        ])
      );
      // Receipt replay may return the old granted card; it must not grant this distinct C.
      const replay = await respond(original, administrator.secret, decisionId);
      expect(replay.status).toBe(200);
      expect(ApprovalRequestSchema.parse(await replay.json())).toMatchObject({
        id: original.requestId,
        status: 'granted',
      });
      const stale = await respond(original, administrator.secret);
      expect(stale.status).toBeGreaterThanOrEqual(400);
      expect(stale.status).toBeLessThan(500);
      ApiErrorSchema.parse(await stale.json());
      for (const via of ['direct', 'fallback'] satisfies Array<'direct' | 'fallback'>) {
        expect((await discover(via)).tools.map((tool) => tool.name)).not.toContain(toolC.name);
      }
      expect(upstream.observed.filter((entry) => entry.startsWith('handler|tools/call|'))).toEqual(
        []
      );
      expect(
        foreignUpstream.observed.filter((entry) => entry.startsWith('handler|tools/call|'))
      ).toEqual([]);
      await finishTurn();
      const heldOutside = controller.native.outside;
      await controller.native.restore();
      await controller.gateway.close();
      controller.pendingRequests.close();
      closeWorkspaceProductReadHandles(dataRoot);
      await shutdownControlStoreWorkerClient();
      closeTestCoreDb(controller.coreDb);
      controller = await openController(
        createTestCoreDb(dataRoot),
        new FsStore({ dataRoot }),
        heldOutside
      );
      const heldAfterRestart = await startTurn();
      for (const via of ['direct', 'fallback'] satisfies Array<'direct' | 'fallback'>) {
        expect((await discover(via)).tools.map((tool) => tool.name)).not.toContain(toolC.name);
      }
      expect(captured('echo', heldAfterRestart.turn.id).contentDigest).toBe(
        capturedC.contentDigest
      );
      expect(
        pending().find((record) => record.requestId === original.requestId)?.governedIntent
      ).toEqual(original.governedIntent);
      await finishTurn();
    } finally {
      work?.completion.resolve();
      await work?.execution.catch(() => undefined);
      await preparation?.catch(() => undefined);
      await outcomeDispatch?.catch(() => undefined);
      await controller.native.restore();
      await controller.gateway.close();
      controller.pendingRequests.close();
      await shutdownControlStoreWorkerClient();
      closeWorkspaceProductReadHandles(dataRoot);
      closeTestCoreDb(controller.coreDb);
      rmSync(dataRoot, { recursive: true, force: true });
      await upstream.close();
      await foreignUpstream.close();
    }
  }
  it(
    'admits only exact current administrator review, retains it on reopen and holds the next change',
    () => definitionReviewFlow(),
    60_000
  );
  it(
    'keeps the original held-definition Pending after processless C4 receives complete native metadata but no audience',
    () => definitionReviewFlow(true),
    60_000
  );
  it(
    'replays a block assessment without another requester until 24h while retaining each current native decision',
    () => definitionReviewFlow(true, true),
    60_000
  );
});

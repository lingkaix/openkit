import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';
import { AgentEnvironmentPackageSchema, type GatewayConfig } from '@openkit/config-schema';
import { type ReasoningEffort, workspaceIdForOwner } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listWorkspaceCapabilityCalls } from '../capability/usage-ledger.js';
import { createInternalAgentGatewayProvider } from '../internal-agents/gateway-provider.js';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import { ProviderRegistry } from '../providers/registry.js';
import {
  acceptSchedulerExecutionObservation,
  schedulerExecutionCorrelation,
} from '../runtime/execution-attempt-records.js';
import { WorkerControlGateway } from '../runtime/worker-control-gateway.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createApp } from '../test-support/app.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import {
  closeTestCoreDb,
  createTestCoreDb,
  createTestStore,
  createTestWorkspaceDb,
} from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import type { ResolvedLogicalModel } from './logical-models.js';
import type { OpenAICompatibleResponsesRequest } from './openai-compatible-client.js';
import { PiAiGatewayClient } from './pi-ai-client.js';
import {
  type LLMGatewayDispatchContext,
  LLMGatewayProviderDispatcher,
} from './provider-dispatcher.js';

const WORKER_LOGICAL_MODEL_ID = 'worker-reasoning';
const WORKER_PROVIDER_ID = 'agent-openai';
const WORKER_PROVIDER_MODEL = 'gpt-5.4';
const DEMO_WORKSPACE_ID = 'ws_00000000-0000-7000-8000-000000000001';
const DEMO_THREAD_ID = 'th_00000000-0000-7000-8000-000000000001';
const LOCAL_USER_ID = 'usr_00000000-0000-7000-8000-000000000001';
const ADVERTISED_LEVELS = ['low', 'high'] as const satisfies readonly ReasoningEffort[];

const roots: string[] = [];
const coreDatabases: CoreDb[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await shutdownControlStoreWorkerClient();
  for (const coreDb of coreDatabases.splice(0)) closeTestCoreDb(coreDb);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Reads the effort field the Gateway placed on a Responses request. */
function requestEffort(request: OpenAICompatibleResponsesRequest): unknown {
  const reasoning = request.reasoning;
  if (!reasoning || typeof reasoning !== 'object' || !('effort' in reasoning)) return undefined;
  return reasoning.effort;
}

/** Reads the effort field of one captured provider JSON body. */
function providerBodyEffort(body: unknown): unknown {
  if (!body || typeof body !== 'object') return undefined;
  const reasoning = (body as { reasoning?: unknown }).reasoning;
  if (!reasoning || typeof reasoning !== 'object' || !('effort' in reasoning)) return undefined;
  return reasoning.effort;
}

/** Responses SSE with one proved text field so worker raw settlement can finish. */
function workerResponsesSse(): string {
  const text = {
    type: 'message',
    id: 'msg_fixture',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'Ready.', annotations: [] }],
  };
  const events = [
    { type: 'response.created', response: { id: 'resp_fixture' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...text, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Ready.' },
    { type: 'response.output_item.done', output_index: 0, item: text },
    {
      type: 'response.completed',
      response: {
        id: 'resp_fixture',
        status: 'completed',
        output: [text],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

/** xAI Responses SSE that the internal-agent projection accepts. */
function quickChatResponsesSse(): string {
  const item = {
    id: 'msg_synthetic',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'Ready.', annotations: [] }],
  };
  const events = [
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    {
      type: 'response.content_part.added',
      output_index: 0,
      content_index: 0,
      part: { ...item.content[0], text: '' },
    },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Ready.' },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id: 'resp_synthetic',
        object: 'response',
        status: 'completed',
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

function readAttempt(dataRoot: string, workspaceId: string) {
  const workspaceDb = createTestWorkspaceDb(dataRoot, workspaceId);
  try {
    applyScopedMigrations(workspaceDb);
    const attempts = listWorkspaceCapabilityCalls(workspaceDb, workspaceId).flatMap((call) =>
      (call.extensions?.['openkit.gateway/routeLineage']?.entries ?? []).filter(
        (entry) => entry.kind === 'attempt'
      )
    );
    expect(attempts, 'attempt lineage').toHaveLength(1);
    return attempts[0]!;
  } finally {
    closeTestCoreDb(workspaceDb);
  }
}

/**
 * Posts one Worker Responses request and returns the effort handed to the provider
 * plus the durable attempt lineage.
 */
async function postWorkerEffort(input: {
  readonly turnEffort?: ReasoningEffort;
  readonly bodyEffort?: ReasoningEffort;
  readonly requestKind?: 'turn' | 'prewarm' | 'compaction';
}): Promise<{ sent: unknown; entry: ReturnType<typeof readAttempt> }> {
  const dataRoot = mkdtempSync(join(tmpdir(), 'gateway-effort-primary-'));
  roots.push(dataRoot);
  const coreDb = createTestCoreDb(dataRoot);
  coreDatabases.push(coreDb);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: LOCAL_USER_ID,
    workspaceId: DEMO_WORKSPACE_ID,
  });
  const turn = await store.createTurn(
    DEMO_WORKSPACE_ID,
    DEMO_THREAD_ID,
    'Call worker inference',
    { kind: 'user', id: LOCAL_USER_ID },
    null,
    {
      captureCoverage: { scope: 'server', value: 'off' },
      ...(input.turnEffort === undefined ? {} : { reasoningEffort: input.turnEffort }),
    }
  );
  const agentSetup = createTestAgentSetup({
    logicalModelId: WORKER_LOGICAL_MODEL_ID,
    privateRoute: {
      providerProfileId: WORKER_PROVIDER_ID,
      providerModel: WORKER_PROVIDER_MODEL,
    },
    requiredCapabilities: ['trusted-worker-inference-relay'],
  });
  const environmentPackage = AgentEnvironmentPackageSchema.parse(
    resolveAgentEnvironmentPackage({
      captureCoverage: store.getTurnCaptureCoverage(turn.id)!,
      agentSetup,
      agentSessionId: 'as_00000000-0000-72a4-a75d-bbe733e57f67',
      backend: { kind: 'openshell' },
      createdAt: '2026-07-13T00:00:00.000Z',
      requestId: 'req_worker_inference_outer_1',
      triggerActor: {
        kind: 'automation',
        id: 'auto_00000000-0000-755a-81b4-0445480bb7a3',
        responsibleUserId: LOCAL_USER_ID,
      },
      turn,
      workspaceCwd: '/workspace/openkit',
      workspaceRoots: [],
    })
  );
  const sandboxBindingRef = 'lease-binding:worker_inference_1';
  const workerControlToken = 'A'.repeat(43);
  const workerInferenceToken = 'B'.repeat(43);
  const workerCapabilityToken = 'C'.repeat(43);
  const entry = createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    queueEntryId: `queue_${turn.id}`,
    requestId: 'req_worker_inference_outer_1',
    triggerActor: environmentPackage.scope.triggerActor,
    serverAdminTokenId: null,
    workspaceId: workspaceIdForOwner(turn.owner),
    threadId: turn.threadId,
    turnId: turn.id,
    turnInput: 'Call worker inference',
    requestedAgentId: environmentPackage.agent.agentId,
  });
  const submittedAttempt = recordTestExecutionAttempt(coreDb, {
    entry,
    attemptId: testEntityId('attempt', `lease_${turn.id}`),
    agentSessionId: environmentPackage.scope.agentSessionId,
    inputRef: environmentPackage.snapshotId,
    bindingRef: sandboxBindingRef,
    sessionCompatibilityKey: 'fixture-compatibility',
    now: () => new Date().toISOString(),
    operationId: `fixture-submit:${testEntityId('attempt', `lease_${turn.id}`)}`,
  });
  expect(
    acceptSchedulerExecutionObservation(coreDb, {
      ...schedulerExecutionCorrelation(submittedAttempt),
      disposition: 'accepted',
      execution: 'running',
      fenceRef: null,
      outcomeRef: null,
    })?.disposition
  ).toBe('accepted');
  const workerControlGateway = new WorkerControlGateway({
    resolveTokenBinding: () => ({ status: 'accepted' }),
  });
  workerControlGateway.registerSession(environmentPackage, {
    sandboxBindingRef,
    workerCapabilityToken,
    workerControlToken,
    workerInferenceToken,
  });
  const models = createModels();
  models.setProvider(openaiProvider());
  const gatewayConfig: GatewayConfig = {
    schemaVersion: 1,
    enabled: true,
    defaultLogicalModelId: WORKER_LOGICAL_MODEL_ID,
    logicalModels: [
      {
        id: WORKER_LOGICAL_MODEL_ID,
        displayName: 'Worker reasoning',
        routing: { autoFailover: true },
        contextManagement: [{ type: 'compaction', compactThreshold: 8_000 }],
        routes: [
          {
            id: 'primary',
            providerProfileId: WORKER_PROVIDER_ID,
            providerModel: WORKER_PROVIDER_MODEL,
          },
        ],
      },
    ],
    requiredFeatures: [],
  };
  const dispatcher = new LLMGatewayProviderDispatcher({
    piAiClient: new PiAiGatewayClient({ models }),
  });
  const gatewayEfforts: unknown[] = [];
  const createResponses = dispatcher.createResponses.bind(dispatcher);
  vi.spyOn(dispatcher, 'createResponses').mockImplementation((provider, request, context) => {
    gatewayEfforts.push(requestEffort(request));
    return createResponses(provider, request, context);
  });
  const providerEfforts: unknown[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const httpRequest = new Request(url, init);
    const text = await httpRequest.text();
    if (text.startsWith('{')) providerEfforts.push(providerBodyEffort(JSON.parse(text)));
    return new Response(workerResponsesSse(), {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  const app = createApp({
    coreDb,
    gatewayConfig,
    llmGatewayDispatcher: dispatcher,
    mode: 'server',
    openKitConfig: {},
    providerCredentialResolver: (ref) =>
      ref === 'test:worker-api-key' ? 'synthetic-worker-key' : null,
    providerRegistry: new ProviderRegistry([
      {
        defaultModel: WORKER_PROVIDER_MODEL,
        displayName: 'Agent OpenAI',
        id: WORKER_PROVIDER_ID,
        kind: 'llm-gateway',
        secretRef: 'test:worker-api-key',
        models: [WORKER_PROVIDER_MODEL],
        vendor: 'openai',
        modelMetadata: {
          [WORKER_PROVIDER_MODEL]: {
            reasoning: true,
            tool_call: true,
            reasoning_options: [{ type: 'effort', values: [...ADVERTISED_LEVELS] }],
            limit: { context: 32_000, output: 4_000 },
          },
        },
      },
    ]),
    store,
    workerControlGateway,
  });
  const response = await app.request('/api/worker-inference/v1/responses', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${workerInferenceToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: WORKER_LOGICAL_MODEL_ID,
      input: 'Hello',
      stream: false,
      ...(input.bodyEffort === undefined ? {} : { reasoning: { effort: input.bodyEffort } }),
      ...(input.requestKind === undefined
        ? {}
        : {
            openkit_runtime_hint: {
              runtimeFamily: 'codex',
              nativeSessionId: 'native-session',
              nativeThreadId: 'native-thread',
              requestKind: input.requestKind,
            },
          }),
    }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  await response.text();
  expect(gatewayEfforts, 'gateway request count').toEqual(providerEfforts);
  expect(providerEfforts, 'provider request count').toHaveLength(1);
  return { sent: providerEfforts[0], entry: readAttempt(dataRoot, DEMO_WORKSPACE_ID) };
}

const quickChatLogicalModel: ResolvedLogicalModel = {
  id: 'assistant',
  displayName: 'Assistant',
  capabilities: ['responses', 'tool-calling'],
  contextManagement: { type: 'compaction', compactThreshold: 8_000 },
  modelFamilyId: 'grok',
  autoFailover: true,
  routes: [
    {
      id: 'primary',
      providerProfileId: 'provider',
      providerModel: 'grok-4.6',
      available: true,
      unavailableReason: null,
    },
  ],
};

/**
 * Runs one quick_chat call. The profile effort is the explicit body effort.
 * The stored Turn effort is low so an auxiliary override would be visible.
 */
async function postQuickChat(): Promise<{ sent: unknown; entry: ReturnType<typeof readAttempt> }> {
  const dataRoot = mkdtempSync(join(tmpdir(), 'gateway-effort-quick-chat-'));
  roots.push(dataRoot);
  const store = createTestStore({ dataRoot });
  const workspace = await store.createWorkspace('Quick chat effort');
  const thread = await store.createThread(workspace.id, 'Quick chat effort');
  const turn = await store.createTurn(
    workspace.id,
    thread.id,
    'Request',
    { kind: 'user', id: LOCAL_USER_ID },
    null,
    {
      captureCoverage: { scope: 'server', value: 'off' },
      reasoningEffort: 'low',
    }
  );
  const workspaceDb = createTestWorkspaceDb(dataRoot, workspace.id);
  applyScopedMigrations(workspaceDb);
  const models = createModels();
  models.setProvider(xaiProvider());
  const dispatcher = new LLMGatewayProviderDispatcher({
    piAiClient: new PiAiGatewayClient({ models }),
  });
  const config: ResolvedLLMProviderConfig = {
    id: 'provider',
    displayName: 'Synthetic xAI',
    vendor: 'xai',
    adapterId: 'xai',
    apiKey: 'synthetic-secret',
    baseUrl: null,
    models: ['grok-4.6'],
    requiresApiKey: true,
    gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
    modelMetadata: {
      'grok-4.6': {
        reasoning: true,
        tool_call: true,
        reasoning_options: [{ type: 'effort', values: [...ADVERTISED_LEVELS] }],
        limit: { context: 64_000, output: 8_000 },
      },
    },
  };
  const gatewayEfforts: unknown[] = [];
  const contexts: LLMGatewayDispatchContext[] = [];
  const createResponses = dispatcher.createResponses.bind(dispatcher);
  vi.spyOn(dispatcher, 'createResponses').mockImplementation((provider, request, context) => {
    gatewayEfforts.push(requestEffort(request));
    contexts.push(context ?? {});
    return createResponses(provider, request, context);
  });
  const providerEfforts: unknown[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const httpRequest = new Request(url, init);
    const text = await httpRequest.text();
    if (text.startsWith('{')) providerEfforts.push(providerBodyEffort(JSON.parse(text)));
    return new Response(quickChatResponsesSse(), {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  const provider = createInternalAgentGatewayProvider({
    capture: { workspaceDb, threadId: thread.id, turnId: turn.id },
    logicalModel: quickChatLogicalModel,
    reasoningEffort: 'high',
    resolveLogicalModel: () => quickChatLogicalModel,
    resolveGatewayProvider: () => config,
    dispatcher,
    promptCacheScope: { sessionId: 'quick-chat' },
    usageEndpoint: 'quick_chat',
    callContext: {
      workspaceId: workspace.id,
      authorityActor: turn.triggerActor,
      family: 'llm',
      operation: 'administration',
      capabilityId: 'inference.local.administration',
      requestId: '00000000-0000-4000-8000-000000000001',
      redactionClass: 'metadata-only',
    },
  });
  try {
    await expect(
      provider({
        systemPrompt: 'Admin role.',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        tools: [],
        model: {
          logicalModelId: quickChatLogicalModel.id,
          capabilities: quickChatLogicalModel.capabilities,
          modelFamilyId: quickChatLogicalModel.modelFamilyId,
        },
        signal: new AbortController().signal,
      })
    ).resolves.toHaveProperty('message.content', [{ type: 'text', text: 'Ready.' }]);
  } finally {
    closeTestCoreDb(workspaceDb);
  }
  expect(contexts[0]?.usageEndpoint).toBe('quick_chat');
  expect(gatewayEfforts, 'gateway request count').toEqual(providerEfforts);
  expect(providerEfforts, 'provider request count').toHaveLength(1);
  return { sent: providerEfforts[0], entry: readAttempt(dataRoot, workspace.id) };
}

function expectLineage(
  result: { sent: unknown; entry: { requestedEffort?: unknown; effectiveEffort?: unknown } },
  expected: { sent: ReasoningEffort; requested: ReasoningEffort | null; effective: ReasoningEffort }
) {
  if (expected.requested === null) expect(result.entry).not.toHaveProperty('requestedEffort');
  else expect(result.entry).toHaveProperty('requestedEffort', expected.requested);
  expect(result.entry).toHaveProperty('effectiveEffort', expected.effective);
  expect(result.sent).toBe(expected.sent);
}

describe('primary Turn effort and auxiliary request effort', () => {
  it('sends the Turn effort for a primary request when requestKind is omitted', async () => {
    const result = await postWorkerEffort({ turnEffort: 'low', bodyEffort: 'high' });
    expectLineage(result, { sent: 'low', requested: 'high', effective: 'low' });
  });

  it('sends the Turn effort for a primary request whose requestKind is turn', async () => {
    const result = await postWorkerEffort({
      turnEffort: 'low',
      bodyEffort: 'high',
      requestKind: 'turn',
    });
    expectLineage(result, { sent: 'low', requested: 'high', effective: 'low' });
  });

  it('sends the body effort for compaction when it differs from the Turn effort', async () => {
    const result = await postWorkerEffort({
      turnEffort: 'low',
      bodyEffort: 'high',
      requestKind: 'compaction',
    });
    expectLineage(result, { sent: 'high', requested: 'high', effective: 'high' });
  });

  it('sends the body effort for prewarm when it differs from the Turn effort', async () => {
    const result = await postWorkerEffort({
      turnEffort: 'low',
      bodyEffort: 'high',
      requestKind: 'prewarm',
    });
    expectLineage(result, { sent: 'high', requested: 'high', effective: 'high' });
  });

  it('sends the profile body effort for quick_chat when the Turn effort differs', async () => {
    const result = await postQuickChat();
    expectLineage(result, { sent: 'high', requested: 'high', effective: 'high' });
  });

  it('sends the body effort when the Turn has no recorded effort', async () => {
    const result = await postWorkerEffort({ bodyEffort: 'high' });
    expectLineage(result, { sent: 'high', requested: 'high', effective: 'high' });
  });

  it('sends the Turn effort for a primary request that omits a body effort', async () => {
    const result = await postWorkerEffort({ turnEffort: 'low' });
    expectLineage(result, { sent: 'low', requested: null, effective: 'low' });
  });

  it('fits a Turn effort above the highest advertised level down to that level', async () => {
    const result = await postWorkerEffort({ turnEffort: 'max' });
    expectLineage(result, { sent: 'high', requested: null, effective: 'high' });
  });
});

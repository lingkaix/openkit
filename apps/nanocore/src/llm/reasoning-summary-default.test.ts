import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';
import { AgentEnvironmentPackageSchema, type GatewayConfig } from '@openkit/config-schema';
import { workspaceIdForOwner } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
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
import { readWorkObservations } from '../storage/work-observations.js';
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
import { withTurnModelCapture } from './model-capture.js';
import { PiAiGatewayClient } from './pi-ai-client.js';
import { LLMGatewayProviderDispatcher } from './provider-dispatcher.js';

const WORKER_LOGICAL_MODEL_ID = 'worker-reasoning';
const WORKER_PROVIDER_ID = 'agent-openai';
const WORKER_PROVIDER_MODEL = 'gpt-5.4';
const DEMO_WORKSPACE_ID = 'ws_00000000-0000-7000-8000-000000000001';
const DEMO_THREAD_ID = 'th_00000000-0000-7000-8000-000000000001';
const LOCAL_USER_ID = 'usr_00000000-0000-7000-8000-000000000001';

const roots: string[] = [];
const coreDatabases: CoreDb[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await shutdownControlStoreWorkerClient();
  for (const coreDb of coreDatabases.splice(0)) closeTestCoreDb(coreDb);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const logicalModel: ResolvedLogicalModel = {
  id: 'assistant',
  displayName: 'Assistant',
  capabilities: ['responses', 'tool-calling'],
  contextManagement: { type: 'compaction', compactThreshold: 8_000 },
  modelFamilyId: 'gpt-5',
  autoFailover: true,
  routes: [
    {
      id: 'primary',
      providerProfileId: 'provider',
      providerModel: 'model',
      available: true,
      unavailableReason: null,
    },
  ],
};

function internalRequest() {
  return {
    systemPrompt: 'Admin role.',
    messages: [
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'Read status.' }] },
    ],
    tools: [],
    model: {
      logicalModelId: 'assistant',
      capabilities: logicalModel.capabilities,
      modelFamilyId: logicalModel.modelFamilyId,
    },
    signal: new AbortController().signal,
  };
}

function summaryOf(rows: readonly { type: string; payload: Readonly<Record<string, unknown>> }[]) {
  const request = rows.find(
    (row) => row.type === 'model.observed' && row.payload.direction === 'request'
  );
  expect(request, 'model request observation').toBeDefined();
  const sampling = request?.payload.sampling;
  if (typeof sampling !== 'object' || sampling === null) return undefined;
  return (sampling as { reasoningSummary?: unknown }).reasoningSummary;
}

function xaiEvents(): string {
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

/** Runs one internal-agent Responses call and reads the captured summary field. */
async function internalCapturedSummary(reasoning: boolean): Promise<unknown> {
  const dataRoot = mkdtempSync(join(tmpdir(), 'reasoning-summary-internal-'));
  roots.push(dataRoot);
  const store = createTestStore({ dataRoot });
  const workspace = await store.createWorkspace('Internal summary');
  const thread = await store.createThread(workspace.id, 'Internal summary');
  const turn = await store.createTurn(
    workspace.id,
    thread.id,
    'Request',
    { kind: 'user', id: LOCAL_USER_ID },
    null,
    { captureCoverage: { scope: 'server', value: 'off' } }
  );
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
        reasoning,
        tool_call: true,
        limit: { context: 64_000, output: 8_000 },
      },
    },
  };
  const model: ResolvedLogicalModel = {
    ...logicalModel,
    modelFamilyId: 'grok',
    routes: [{ ...logicalModel.routes[0]!, providerModel: 'grok-4.6' }],
  };
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () => new Response(xaiEvents(), { headers: { 'content-type': 'text/event-stream' } })
  );
  const rows = await withTurnModelCapture({ store, turn }, async (admitted) => {
    const provider = createInternalAgentGatewayProvider({
      capture: admitted,
      logicalModel: model,
      resolveLogicalModel: () => model,
      dispatcher,
      resolveGatewayProvider: () => config,
      promptCacheScope: { sessionId: 'internal' },
      usageEndpoint: 'responses',
    });
    await expect(provider(internalRequest())).resolves.toHaveProperty('message.content', [
      { type: 'text', text: 'Ready.' },
    ]);
    return readWorkObservations(admitted.workspaceDb, {
      threadId: admitted.threadId,
      turnId: admitted.turnId,
    });
  });
  return summaryOf(rows);
}

interface WorkerSummaryFixture {
  readonly app: ReturnType<typeof createApp>;
  readonly coreDb: CoreDb;
  readonly token: string;
  readonly turnId: string;
}

/** Trusted worker session whose provider accepts a Responses summary option. */
async function createWorkerSummaryFixture(): Promise<WorkerSummaryFixture> {
  const dataRoot = mkdtempSync(join(tmpdir(), 'reasoning-summary-worker-'));
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
    { captureCoverage: { scope: 'server', value: 'off' } }
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
  const workerControlToken = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const workerInferenceToken = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  const workerCapabilityToken = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
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
  return {
    app: createApp({
      coreDb,
      gatewayConfig,
      llmGatewayDispatcher: new LLMGatewayProviderDispatcher({
        piAiClient: new PiAiGatewayClient({ models }),
      }),
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
              limit: { context: 32_000, output: 4_000 },
            },
          },
        },
      ]),
      store,
      workerControlGateway,
    }),
    coreDb,
    token: workerInferenceToken,
    turnId: turn.id,
  };
}

/** Responses SSE that proves one text field so worker raw settlement can complete. */
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

/** Posts one worker Responses request and returns the captured summary. */
async function workerCapturedSummary(reasoning?: {
  summary: 'off' | 'detailed';
}): Promise<unknown> {
  const fixture = await createWorkerSummaryFixture();
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(workerResponsesSse(), { headers: { 'content-type': 'text/event-stream' } })
  );
  const response = await fixture.app.request('/api/worker-inference/v1/responses', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${fixture.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: WORKER_LOGICAL_MODEL_ID,
      input: 'Hello',
      stream: false,
      ...(reasoning === undefined ? {} : { reasoning }),
    }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  await response.text();
  const workspaceDb = createTestWorkspaceDb(fixture.coreDb.dataRoot, DEMO_WORKSPACE_ID);
  try {
    applyScopedMigrations(workspaceDb);
    return summaryOf(
      readWorkObservations(workspaceDb, { threadId: DEMO_THREAD_ID, turnId: fixture.turnId })
    );
  } finally {
    closeTestCoreDb(workspaceDb);
  }
}

/** Public Responses caller that omits summary on a reasoning model. */
async function publicCapturedSummary(): Promise<unknown> {
  const dataRoot = mkdtempSync(join(tmpdir(), 'reasoning-summary-public-'));
  roots.push(dataRoot);
  const coreDb = createTestCoreDb(dataRoot);
  coreDatabases.push(coreDb);
  ensureLocalUser(coreDb);
  const store = createTestStore({ dataRoot });
  const workspace = await store.createWorkspace('Public summary');
  const thread = await store.createThread(workspace.id, 'Public summary');
  const turn = await store.createTurn(
    workspace.id,
    thread.id,
    'Request',
    { kind: 'user', id: LOCAL_USER_ID },
    null,
    { captureCoverage: { scope: 'server', value: 'off' } }
  );
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: LOCAL_USER_ID,
    workspaceId: workspace.id,
  });
  const providersRoot = join(dataRoot, 'config', 'providers');
  mkdirSync(providersRoot, { recursive: true });
  writeFileSync(
    join(providersRoot, 'p.provider.jsonc'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'p',
      displayName: 'p',
      kind: 'local',
      vendor: 'openai',
      models: ['summary-model'],
      modelMetadata: {
        'summary-model': {
          reasoning: true,
          limit: { context: 32000, output: 4000 },
        },
      },
    })
  );
  writeFileSync(
    join(dataRoot, 'config', 'gateway.jsonc'),
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      logicalModels: [
        {
          id: 'tier',
          displayName: 'Tier',
          contextManagement: [{ type: 'compaction', compactThreshold: 8000 }],
          routes: [{ id: 'primary', providerProfileId: 'p', providerModel: 'summary-model' }],
        },
      ],
    })
  );
  const faux = fauxProvider({
    provider: 'openai',
    api: 'openai-responses',
    models: [{ id: 'summary-model', reasoning: true }],
  });
  faux.setResponses([fauxAssistantMessage('Ready.')]);
  const models = createModels();
  models.setProvider(faux.provider);
  const app = createApp({
    coreDb,
    dataRoot,
    store,
    runtimeConfigManager: createRuntimeConfigManager({ dataRoot }),
    llmGatewayDispatcher: new LLMGatewayProviderDispatcher({
      piAiClient: new PiAiGatewayClient({ models }),
    }),
    providerCredentialResolver: () => 'synthetic-secret',
  });
  const response = await app.request('/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'tier',
      input: 'Hello',
      stream: false,
      metadata: {
        openkit: { workspaceId: workspace.id, threadId: thread.id, turnId: turn.id },
      },
    }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  await response.text();
  const workspaceDb = createTestWorkspaceDb(dataRoot, workspace.id);
  try {
    applyScopedMigrations(workspaceDb);
    return summaryOf(readWorkObservations(workspaceDb, { threadId: thread.id, turnId: turn.id }));
  } finally {
    closeTestCoreDb(workspaceDb);
  }
}

describe('default reasoning summary', () => {
  it('requests auto for an internal-agent call that omits summary', async () => {
    await expect(internalCapturedSummary(true)).resolves.toBe('auto');
  });

  it('requests auto for a Worker-lineage call that omits summary', async () => {
    await expect(workerCapturedSummary()).resolves.toBe('auto');
  });

  it('keeps an explicit off summary on a Worker-lineage call', async () => {
    await expect(workerCapturedSummary({ summary: 'off' })).resolves.toBe('off');
  });

  it('keeps an explicit detailed summary on a Worker-lineage call', async () => {
    await expect(workerCapturedSummary({ summary: 'detailed' })).resolves.toBe('detailed');
  });

  it('adds no summary option on a public route that omits summary', async () => {
    await expect(publicCapturedSummary()).resolves.toBeUndefined();
  });

  it('adds no summary option for a model without reasoning support', async () => {
    await expect(internalCapturedSummary(false)).resolves.toBeUndefined();
  });
});

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationTargetCatalogSchema, type OperationId } from '@openkit/app-api-schemas';
import { expect, it, onTestFinished } from 'vitest';
import { ProviderRegistry } from './providers/registry.js';
import { QUICK_CHAT_AGENT_ID } from './quick-chat-agent.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { createTestAgentSetup } from './test-support/agent-environment.js';
import { createAppWithWorkspaceAuthority } from './test-support/app.js';
import { confirmContextDefaultsForApp } from './test-support/context-defaults.js';
import { createDemoStore, retainSharedAssistantTurn } from './test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID } from './test-support/local-user.js';
import { operationRequest } from './test-support/operation-request.js';
import { asPiAiGatewayClientDouble } from './test-support/pi-ai-gateway-client-double.js';

async function request(
  app: { request: (...args: unknown[]) => Promise<Response> },
  operation: OperationId,
  input: object
) {
  const response = await app.request(
    ...operationRequest(operation, {}, { body: JSON.stringify(input) })
  );
  return {
    status: response.status,
    body: response.headers.get('content-type')?.includes('application/json')
      ? await response.json()
      : await response.text(),
  };
}

it('refuses a new shared Assistant conversation and keeps an existing one writable', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'shared-conversation-gate-'));
  const store = await createDemoStore({ dataRoot });
  const workspace = await store.createWorkspace('Team');
  const app = createAppWithWorkspaceAuthority(
    await confirmContextDefaultsForApp({
      dataRoot,
      store,
      gatewayConfig: {
        schemaVersion: 1,
        enabled: true,
        defaultLogicalModelId: 'quick-chat',
        logicalModels: [
          {
            id: 'quick-chat',
            displayName: 'Quick Chat',
            contextManagement: [{ type: 'compaction', compactThreshold: 8_000 }],
            routes: [
              { id: 'primary', providerProfileId: 'ollama', providerModel: 'openai/gpt-5.2' },
            ],
          },
        ],
        requiredFeatures: [],
      },
      internalRoleProfiles: {
        schemaVersion: 1,
        defaultLogicalModelId: 'quick-chat',
        profiles: [],
      },
      providerRegistry: new ProviderRegistry([
        {
          defaultModel: 'openai/gpt-5.2',
          displayName: 'Ollama',
          id: 'ollama',
          kind: 'local',
          models: ['openai/gpt-5.2'],
        },
      ]),
      llmPiAiClient: asPiAiGatewayClientDouble({
        createResponses: async (_provider, request) => ({
          id: 'chatcmpl_shared_gate',
          object: 'response',
          status: 'completed',
          model: request.model,
          output: [
            {
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'Shared answer.' }],
            },
          ],
        }),
      }),
    })
  );
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { recursive: true, force: true });
  });

  const created = await request(app, 'thread.create', {
    workspaceId: workspace.id,
    name: 'Formal work',
    visibility: 'workspace',
    requestId: randomUUID(),
  });
  expect(created.status).toBe(200);
  expect(created.body).toMatchObject({
    entryPath: 'conversation',
    visibility: 'workspace',
  });
  const threadId = created.body.id as string;

  const submitted = await request(app, 'conversation.submit', {
    workspaceId: workspace.id,
    threadId,
    requestId: randomUUID(),
    input: 'Start a shared chat.',
    targetRef: 'internal-role:assistant',
    artifactRefs: [],
  });
  expect(submitted.status).toBe(409);
  expect(submitted.body).toMatchObject({
    code: 'assistant_timeline_required',
    message: 'New Assistant requests must use your private Timeline.',
  });
  expect(store.listThreadTurns(workspace.id, threadId)).toEqual([]);

  const targets = await request(app, 'conversation.targets', {
    workspaceId: workspace.id,
    threadId,
  });
  expect(targets.status).toBe(200);
  expect(
    ConversationTargetCatalogSchema.parse(targets.body).targets.find(
      (target) => target.targetRef === 'internal-role:assistant'
    )
  ).toMatchObject({
    availability: 'unavailable',
    unavailableReason: 'Use your private Timeline for the Personal Assistant.',
  });

  const read = await request(app, 'thread.read', { workspaceId: workspace.id, threadId });
  expect(read.status).toBe(200);

  await retainSharedAssistantTurn(
    store,
    workspace.id,
    threadId,
    FIXTURE_LOCAL_USER_ID,
    'Already shared'
  );
  const continued = await request(app, 'conversation.targets', {
    workspaceId: workspace.id,
    threadId,
  });
  expect(
    ConversationTargetCatalogSchema.parse(continued.body).targets.find(
      (target) => target.targetRef === 'internal-role:assistant'
    )?.availability
  ).toBe('available');
  const write = await request(app, 'conversation.submit', {
    workspaceId: workspace.id,
    threadId,
    requestId: randomUUID(),
    input: 'Continue the shared chat.',
    targetRef: 'internal-role:assistant',
    artifactRefs: [],
  });
  expect(write.status, JSON.stringify(write.body)).toBe(200);
  expect(write.body?.code).not.toBe('assistant_timeline_required');
});

it('does not treat a Worker handoff as an existing shared Assistant conversation', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'shared-conversation-worker-'));
  const store = await createDemoStore({ dataRoot });
  const workspace = await store.createWorkspace('Team');
  const workerSetup = createTestAgentSetup({
    logicalModelId: 'quick-chat',
    privateRoute: { providerProfileId: 'ollama', providerModel: 'openai/gpt-5.2' },
  });
  const app = createAppWithWorkspaceAuthority(
    await confirmContextDefaultsForApp({
      dataRoot,
      store,
      agentManifests: [workerSetup.manifest],
      openKitConfig: { defaults: { defaultAgentId: workerSetup.manifest.id } },
      gatewayConfig: {
        schemaVersion: 1,
        enabled: true,
        defaultLogicalModelId: 'quick-chat',
        logicalModels: [
          {
            id: 'quick-chat',
            displayName: 'Quick Chat',
            contextManagement: [{ type: 'compaction', compactThreshold: 8_000 }],
            routes: [
              { id: 'primary', providerProfileId: 'ollama', providerModel: 'openai/gpt-5.2' },
            ],
          },
        ],
        requiredFeatures: [],
      },
      internalRoleProfiles: {
        schemaVersion: 1,
        defaultLogicalModelId: 'quick-chat',
        profiles: [],
      },
      providerRegistry: new ProviderRegistry([
        {
          defaultModel: 'openai/gpt-5.2',
          displayName: 'Ollama',
          id: 'ollama',
          kind: 'local',
          models: ['openai/gpt-5.2'],
        },
      ]),
      llmPiAiClient: asPiAiGatewayClientDouble({
        createResponses: async (_provider, request) => ({
          id: 'chatcmpl_shared_gate',
          object: 'response',
          status: 'completed',
          model: request.model,
          output: [
            {
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'Shared answer.' }],
            },
          ],
        }),
      }),
    })
  );
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const created = await request(app, 'thread.create', {
    workspaceId: workspace.id,
    name: 'Formal work',
    visibility: 'workspace',
    requestId: randomUUID(),
  });
  expect(created.status).toBe(200);
  const threadId = created.body.id as string;
  const worker = await request(app, 'conversation.submit', {
    workspaceId: workspace.id,
    threadId,
    requestId: randomUUID(),
    input: 'Start a worker task.',
    targetRef: 'new-task-worker',
    artifactRefs: [],
  });
  expect(
    store
      .listThreadTurns(workspace.id, threadId)
      .some((turn) => turn.agentId === QUICK_CHAT_AGENT_ID),
    JSON.stringify(worker.body)
  ).toBe(true);
  const assistant = await request(app, 'conversation.submit', {
    workspaceId: workspace.id,
    threadId,
    requestId: randomUUID(),
    input: 'Start a shared chat.',
    targetRef: 'internal-role:assistant',
    artifactRefs: [],
  });
  expect(assistant.status).toBe(409);
  expect(assistant.body).toMatchObject({
    code: 'assistant_timeline_required',
    message: 'New Assistant requests must use your private Timeline.',
  });
});

import { ListAuthorizedWorkspacesResponseSchema } from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';
import { FsStore } from './lib/store.js';
import type { PiAiGatewayClient } from './llm/pi-ai-client.js';
import { ProviderRegistry } from './providers/registry.js';
import { createTestGatewayConfig } from './test-support/agent-environment.js';
import { createAppWithWorkspaceAuthority as createApp } from './test-support/app.js';
import { operationRequest } from './test-support/operation-request.js';

describe('quick-chat workspace mode', () => {
  it('seeds a special lightweight workspace for simple provider-backed prompts', async () => {
    const app = createApp({ store: new FsStore() });
    const res = await app.request('/api/app/operations/workspace.list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = ListAuthorizedWorkspacesResponseSchema.parse(await res.json());

    expect(body.items.map((entry) => entry.workspace)).toContainEqual(
      expect.objectContaining({
        id: 'ws_quick_chat',
        name: 'Quick Chat',
        kind: 'quick-chat',
      })
    );
  });

  it('uses the quick-chat workspace when no workspace is selected', async () => {
    const app = createApp({
      store: new FsStore(),
      gatewayConfig: createTestGatewayConfig(),
      internalRoleProfiles: {
        schemaVersion: 1,
        defaultLogicalModelId: 'openai/gpt-5.2',
        profiles: [],
      },
      providerRegistry: new ProviderRegistry([
        {
          defaultModel: 'openai/gpt-5.2',
          displayName: 'Quick Chat Provider',
          id: 'agent-openrouter',
          kind: 'local',
          models: ['openai/gpt-5.2'],
        },
      ]),
      llmPiAiClient: {
        createChatCompletion: async () => ({
          id: 'chatcmpl_quick_workspace',
          object: 'chat.completion',
          created: 1,
          model: 'openai/gpt-5.2',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Fast answer' },
              finish_reason: 'stop',
            },
          ],
        }),
      } as unknown as PiAiGatewayClient,
    });

    const res = await app.request(
      ...operationRequest(
        'chat.quick',
        {},
        {
          method: 'POST',
          body: JSON.stringify({ input: 'What is nanocore?' }),
          headers: { 'content-type': 'application/json' },
        }
      )
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      workspaceId: 'ws_quick_chat',
      content: 'Fast answer',
    });
  });
});

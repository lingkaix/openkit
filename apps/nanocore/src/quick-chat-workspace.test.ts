import { ListWorkspacesResponseSchema } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import type { PiAiGatewayClient } from './llm/pi-ai-client.js';
import { ProviderRegistry } from './providers/registry.js';
import { createApp } from './test-support/app.js';

describe('quick-chat workspace mode', () => {
  it('seeds a special lightweight workspace for simple provider-backed prompts', async () => {
    const app = createApp();
    const res = await app.request('/api/workspaces');
    const body = ListWorkspacesResponseSchema.parse(await res.json());

    expect(body.items).toContainEqual(
      expect.objectContaining({
        id: 'ws_quick_chat',
        name: 'Quick Chat',
        kind: 'quick-chat',
      })
    );
  });

  it('uses the quick-chat workspace when no workspace is selected', async () => {
    const app = createApp({
      openKitConfig: {
        defaults: {
          coreModel: 'llama3.2',
          coreProviderId: 'ollama',
        },
      },
      providerRegistry: new ProviderRegistry([
        {
          defaultModel: 'llama3.2',
          displayName: 'Ollama',
          id: 'ollama',
          kind: 'local',
          models: ['llama3.2'],
        },
      ]),
      llmPiAiClient: {
        createChatCompletion: async () => ({
          id: 'chatcmpl_quick_workspace',
          object: 'chat.completion',
          created: 1,
          model: 'llama3.2',
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

    const res = await app.request('/api/app/quick-chat', {
      method: 'POST',
      body: JSON.stringify({ input: 'What is nanocore?' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      workspaceId: 'ws_quick_chat',
      content: 'Fast answer',
    });
  });
});

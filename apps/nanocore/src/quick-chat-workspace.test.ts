import { ListWorkspacesResponseSchema } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import type { PiAiGatewayClient } from './llm/pi-ai-client.js';
import { LLMProviderConfigStore } from './llm/provider-config.js';

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
    const configStore = new LLMProviderConfigStore();
    configStore.upsertProvider({
      providerId: 'ollama',
      model: 'llama3.2',
    });
    configStore.updateDefaults({
      quickChat: { providerId: 'ollama', model: 'llama3.2' },
    });
    const app = createApp({
      llmProviderConfigStore: configStore,
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

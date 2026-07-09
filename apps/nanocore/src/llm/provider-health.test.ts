import { describe, expect, it } from 'vitest';

import type { OpenAICompatibleChatClient } from './openai-compatible-client.js';
import { LLMProviderConfigStore } from './provider-config.js';
import { LLMProviderHealthChecker } from './provider-health.js';

describe('LLM provider health checker', () => {
  it('reports healthy OpenAI-compatible providers from a model-list check', async () => {
    const configStore = new LLMProviderConfigStore();
    configStore.upsertProvider({
      providerId: 'openai',
      model: 'gpt-5.1',
      apiKey: 'sk-secret',
    });
    const checker = new LLMProviderHealthChecker({
      configStore,
      client: {
        listModels: async () => ({ data: [{ id: 'gpt-5.1' }] }),
      } as OpenAICompatibleChatClient,
    });

    const health = await checker.checkProvider('openai');

    expect(health).toMatchObject({
      providerId: 'openai',
      status: 'healthy',
      message: 'Provider returned 1 model.',
      checkedAt: expect.any(String),
    });
    expect(JSON.stringify(health)).not.toContain('sk-secret');
  });

  it('reports missing API keys without calling the upstream provider', async () => {
    const configStore = new LLMProviderConfigStore();
    configStore.upsertProvider({
      providerId: 'openai',
      model: 'gpt-5.1',
    });
    let calls = 0;
    const checker = new LLMProviderHealthChecker({
      configStore,
      client: {
        listModels: async () => {
          calls += 1;
          return { data: [] };
        },
      } as OpenAICompatibleChatClient,
    });

    const health = await checker.checkProvider('openai');

    expect(calls).toBe(0);
    expect(health).toMatchObject({
      providerId: 'openai',
      status: 'missing_api_key',
      message: 'OpenAI requires an API key.',
    });
  });

  it('reports OAuth providers as requiring login coordination', async () => {
    const configStore = new LLMProviderConfigStore();
    configStore.upsertProvider({
      providerId: 'openai_codex',
      model: 'codex',
    });
    const checker = new LLMProviderHealthChecker({ configStore });

    await expect(checker.checkProvider('openai_codex')).resolves.toMatchObject({
      providerId: 'openai_codex',
      status: 'oauth_required',
      message: 'OpenAI Codex requires OAuth login before health checks can run.',
    });
  });

  it('reports sanitized provider failures', async () => {
    const configStore = new LLMProviderConfigStore();
    configStore.upsertProvider({
      providerId: 'openai',
      model: 'gpt-5.1',
      apiKey: 'sk-secret',
    });
    const checker = new LLMProviderHealthChecker({
      configStore,
      client: {
        listModels: async () => {
          throw new Error('401 invalid sk-secret');
        },
      } as OpenAICompatibleChatClient,
    });

    await expect(checker.checkProvider('openai')).resolves.toMatchObject({
      providerId: 'openai',
      status: 'unhealthy',
      message: '401 invalid [redacted]',
    });
  });
});

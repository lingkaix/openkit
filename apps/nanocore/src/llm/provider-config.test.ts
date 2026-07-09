import { afterEach, describe, expect, it } from 'vitest';

import { LLMProviderConfigStore } from './provider-config.js';

const originalOpenAiKey = process.env.OPENAI_API_KEY;
const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  if (originalOpenAiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAiKey;
  }
  if (originalAnthropicKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
  }
});

describe('LLM provider config store', () => {
  it('returns provider specs and sanitized configured providers without secrets', () => {
    const store = new LLMProviderConfigStore();

    const configured = store.upsertProvider({
      providerId: 'openai',
      model: 'gpt-5.1',
      apiKey: 'sk-secret',
      baseUrl: 'https://proxy.example.test/v1',
      extraHeaders: { 'x-openkit': 'enabled' },
      extraBody: { temperature: 0.2 },
    });

    expect(configured).toMatchObject({
      id: 'openai',
      specId: 'openai',
      model: 'gpt-5.1',
      baseUrl: 'https://proxy.example.test/v1',
      hasApiKey: true,
      apiKeySource: 'stored',
      gatewayCapabilities: {
        chatCompletions: 'native',
        responses: 'native',
      },
      extraHeaders: { 'x-openkit': 'enabled' },
      extraBody: { temperature: 0.2 },
    });
    expect(configured).not.toHaveProperty('apiKey');
    expect(store.listProviders().configured).toContainEqual(configured);
  });

  it('resolves API keys from env vars without returning the secret', () => {
    process.env.OPENAI_API_KEY = 'sk-from-env';
    const store = new LLMProviderConfigStore();

    store.upsertProvider({
      providerId: 'openai',
      model: 'gpt-5.1',
    });

    expect(store.getProvider('openai')).toMatchObject({
      hasApiKey: true,
      apiKeySource: 'env',
    });
    expect(store.resolveProvider('openai')).toMatchObject({
      apiKey: 'sk-from-env',
      apiKeySource: 'env',
    });
  });

  it('configures Anthropic as the first pi-ai provider family', () => {
    process.env.ANTHROPIC_API_KEY = 'anthropic-from-env';
    const store = new LLMProviderConfigStore();

    store.upsertProvider({
      providerId: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
    });

    expect(store.getProvider('anthropic')).toMatchObject({
      id: 'anthropic',
      specId: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      baseUrl: null,
      hasApiKey: true,
      apiKeySource: 'env',
      gatewayCapabilities: {
        chatCompletions: 'native',
        responses: 'bridged',
      },
    });
    expect(store.resolveProvider('anthropic')).toMatchObject({
      apiKey: 'anthropic-from-env',
      spec: expect.objectContaining({ backend: 'pi-ai' }),
    });
  });

  it('stores default provider and model selection', () => {
    const store = new LLMProviderConfigStore();

    store.upsertProvider({
      providerId: 'openrouter',
      model: 'openai/gpt-5.1',
      apiKey: 'or-secret',
    });
    const defaults = store.updateDefaults({
      quickChat: { providerId: 'openrouter', model: 'openai/gpt-5.1' },
      gateway: { providerId: 'openrouter', model: 'openai/gpt-5.1' },
      internalTasks: { providerId: 'openrouter', model: 'openai/gpt-5.1' },
    });

    expect(defaults).toEqual({
      quickChat: { providerId: 'openrouter', model: 'openai/gpt-5.1' },
      gateway: { providerId: 'openrouter', model: 'openai/gpt-5.1' },
      internalTasks: { providerId: 'openrouter', model: 'openai/gpt-5.1' },
    });
    expect(store.getDefaults().quickChat.providerId).toBe('openrouter');
  });

  it('rejects unknown providers and API-key config for OAuth providers', () => {
    const store = new LLMProviderConfigStore();

    expect(() =>
      store.upsertProvider({
        providerId: 'missing',
        model: 'model',
      })
    ).toThrow('Unknown LLM provider: missing');
    expect(() =>
      store.upsertProvider({
        providerId: 'openai_codex',
        model: 'codex',
        apiKey: 'not-allowed',
      })
    ).toThrow('OpenAI Codex uses OAuth and cannot store an API key.');
  });
});

import { describe, expect, it } from 'vitest';

import { resolveProviderProfileToLLMConfig } from './llm-config.js';

describe('resolveProviderProfileToLLMConfig', () => {
  it('projects runtime instances directly onto their adapter identity', () => {
    const provider = resolveProviderProfileToLLMConfig(
      {
        baseUrl: 'https://openrouter.example/v1',
        defaultModel: 'openai/gpt-5',
        displayName: 'Core OpenRouter',
        id: 'core-openrouter',
        kind: 'gateway',
        models: ['openai/gpt-5'],
        secretRef: 'env:OPENROUTER_API_KEY',
        vendor: 'openrouter',
      },
      () => 'sk-openrouter'
    );

    expect(provider).toMatchObject({
      adapterId: 'openrouter',
      backend: 'pi-ai',
      requiresApiKey: true,
    });
    expect(provider).not.toHaveProperty('apiKeySource');
    expect(provider).not.toHaveProperty('hasApiKey');
    expect(provider).not.toHaveProperty('spec');
    expect(provider).not.toHaveProperty('specId');
  });

  it('projects Codex OAuth profiles onto the dedicated backend without API keys', () => {
    const provider = resolveProviderProfileToLLMConfig({
      defaultModel: 'openai-codex/gpt-5.1-codex',
      displayName: 'Codex Team',
      extensions: { openkit: { codexOAuth: { accountSlotId: 'team' } } },
      id: 'codex-team',
      kind: 'oauth',
      models: ['openai-codex/gpt-5.1-codex'],
      vendor: 'openai_codex',
    });

    expect(provider).toMatchObject({
      adapterId: 'openai_codex',
      backend: 'codex-oauth',
      codexOAuthAccountSlotId: 'team',
      requiresApiKey: false,
    });
  });

  it('normalizes the conventional hyphenated Codex adapter id', () => {
    const provider = resolveProviderProfileToLLMConfig({
      displayName: 'OpenAI Codex',
      id: 'openai-codex',
      kind: 'oauth',
      models: ['openai-codex/gpt-5.1-codex'],
    });

    expect(provider).toMatchObject({
      adapterId: 'openai_codex',
      backend: 'codex-oauth',
      requiresApiKey: false,
    });
  });

  it('resolves provider credentials through configured secret references', () => {
    const provider = resolveProviderProfileToLLMConfig(
      {
        displayName: 'Vault Provider',
        id: 'vault-provider',
        kind: 'direct',
        models: ['model'],
        secretRef: 'vault://provider_vault',
      },
      (secretRef) => (secretRef === 'vault://provider_vault' ? 'sk-vault' : null)
    );

    expect(provider).toMatchObject({
      apiKey: 'sk-vault',
      requiresApiKey: true,
    });
  });

  it('keeps unresolved required credentials absent', () => {
    const provider = resolveProviderProfileToLLMConfig(
      {
        displayName: 'Missing Provider',
        id: 'missing-provider',
        kind: 'direct',
        models: ['model'],
        secretRef: 'vault://provider_missing',
      },
      () => null
    );

    expect(provider).toMatchObject({
      apiKey: null,
      requiresApiKey: true,
    });
  });

  it('projects known provider vendors onto pi-ai adapters', () => {
    const provider = resolveProviderProfileToLLMConfig(
      {
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        displayName: 'Google Gemini',
        id: 'google',
        kind: 'direct',
        models: ['gemini-2.5-pro'],
        secretRef: 'vault://provider_google',
        vendor: 'google',
      },
      (secretRef) => (secretRef === 'vault://provider_google' ? 'sk-google' : null)
    );

    expect(provider).toMatchObject({
      adapterId: 'google',
      apiKey: 'sk-google',
      backend: 'pi-ai',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    });
  });

  it('routes runtime custom OpenAI-compatible endpoints through the pi-ai backend', () => {
    const provider = resolveProviderProfileToLLMConfig(
      {
        baseUrl: 'https://proxy.example/v1',
        displayName: 'Custom OpenAI-Compatible',
        id: 'custom-proxy',
        kind: 'custom',
        models: ['custom-chat'],
        secretRef: 'vault://provider_custom_proxy',
      },
      (secretRef) => (secretRef === 'vault://provider_custom_proxy' ? 'sk-custom' : null)
    );

    expect(provider).toMatchObject({
      adapterId: 'custom_proxy',
      apiKey: 'sk-custom',
      backend: 'pi-ai',
      baseUrl: 'https://proxy.example/v1',
    });
  });

  it('normalizes an instance id used as the adapter fallback', () => {
    const provider = resolveProviderProfileToLLMConfig({
      baseUrl: 'https://proxy.example/v1',
      displayName: 'Custom OpenAI-Compatible',
      id: 'Custom-Proxy',
      kind: 'custom',
      models: ['custom-chat'],
    });

    expect(provider.adapterId).toBe('custom_proxy');
  });

  it('routes runtime direct provider profiles through the pi-ai backend', () => {
    const provider = resolveProviderProfileToLLMConfig(
      {
        baseUrl: 'https://direct.example/v1',
        displayName: 'Direct Provider',
        id: 'direct-provider',
        kind: 'direct',
        models: ['direct-chat'],
        secretRef: 'vault://provider_direct',
      },
      (secretRef) => (secretRef === 'vault://provider_direct' ? 'sk-direct' : null)
    );

    expect(provider).toMatchObject({
      adapterId: 'direct_provider',
      apiKey: 'sk-direct',
      backend: 'pi-ai',
      baseUrl: 'https://direct.example/v1',
    });
  });

  it('marks providers without secret refs as not requiring credentials', () => {
    const provider = resolveProviderProfileToLLMConfig({
      displayName: 'Local Provider',
      id: 'local-provider',
      kind: 'local',
      models: ['model'],
    });

    expect(provider).toMatchObject({
      apiKey: null,
      requiresApiKey: false,
    });
  });
});

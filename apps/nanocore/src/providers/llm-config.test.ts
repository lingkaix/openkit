import { describe, expect, it } from 'vitest';

import { resolveProviderProfileToLLMConfig } from './llm-config.js';

describe('resolveProviderProfileToLLMConfig', () => {
  it('marks vault-resolved provider credentials as vault sourced', () => {
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
      apiKeySource: 'vault',
      hasApiKey: true,
    });
  });

  it('keeps explicitly resolved env provider credentials marked as env sourced', () => {
    const provider = resolveProviderProfileToLLMConfig(
      {
        displayName: 'Env Provider',
        id: 'env-provider',
        kind: 'direct',
        models: ['model'],
        secretRef: 'env:PROVIDER_KEY',
      },
      (secretRef) => (secretRef === 'env:PROVIDER_KEY' ? 'sk-env' : null)
    );

    expect(provider).toMatchObject({
      apiKey: 'sk-env',
      apiKeySource: 'env',
      hasApiKey: true,
    });
  });

  it('marks unresolved provider secret refs as missing credentials', () => {
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
      apiKeySource: 'missing',
      hasApiKey: false,
    });
  });

  it('preserves static pi-ai backend metadata for runtime provider profiles', () => {
    const provider = resolveProviderProfileToLLMConfig(
      {
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        displayName: 'Google Gemini',
        id: 'google',
        kind: 'direct',
        models: ['gemini-2.5-pro'],
        secretRef: 'vault://provider_google',
      },
      (secretRef) => (secretRef === 'vault://provider_google' ? 'sk-google' : null)
    );

    expect(provider).toMatchObject({
      apiKey: 'sk-google',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      spec: expect.objectContaining({
        backend: 'pi-ai',
        id: 'google',
        extraBodyAllowed: false,
        extraHeadersAllowed: false,
      }),
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
      apiKey: 'sk-custom',
      baseUrl: 'https://proxy.example/v1',
      spec: expect.objectContaining({
        backend: 'pi-ai',
        id: 'custom-proxy',
        extraBodyAllowed: false,
        extraHeadersAllowed: false,
      }),
    });
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
      apiKey: 'sk-direct',
      baseUrl: 'https://direct.example/v1',
      spec: expect.objectContaining({
        backend: 'pi-ai',
        id: 'direct-provider',
      }),
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
      apiKeySource: 'not-required',
      hasApiKey: false,
    });
  });
});

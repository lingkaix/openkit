import { describe, expect, it, vi } from 'vitest';

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
      models: ['openai/gpt-5'],
      requiresApiKey: true,
    });
    expect(provider).not.toHaveProperty('backend');
    expect(provider).not.toHaveProperty('apiKeySource');
    expect(provider).not.toHaveProperty('hasApiKey');
    expect(provider).not.toHaveProperty('spec');
    expect(provider).not.toHaveProperty('specId');
  });

  it('projects strict Codex and xAI subscription profiles onto exact account pairs', () => {
    const profiles = [
      {
        accountSlotId: 'codex_vendor',
        expectedAdapterId: 'openai-codex',
        expectedSubscriptionProviderId: 'openai-codex',
        id: 'codex-work',
        vendor: ' OpenAI-Codex ',
      },
      {
        accountSlotId: 'codex_id',
        expectedAdapterId: 'openai-codex',
        expectedSubscriptionProviderId: 'openai-codex',
        id: ' OPENAI-CODEX ',
        vendor: 'catalog',
      },
    ] as const;

    for (const profile of profiles) {
      const provider = resolveProviderProfileToLLMConfig({
        displayName: profile.id,
        extensions: {
          openkit: { subscriptionAccount: { accountSlotId: profile.accountSlotId } },
        },
        id: profile.id,
        kind: 'oauth',
        models: ['configured-model'],
        vendor: profile.vendor,
      });

      expect(provider).toMatchObject({
        accountSlotId: profile.accountSlotId,
        adapterId: profile.expectedAdapterId,
        apiKey: null,
        requiresApiKey: false,
        subscriptionProviderId: profile.expectedSubscriptionProviderId,
      });
      expect(provider).not.toHaveProperty('backend');
      expect(provider).not.toHaveProperty('codexOAuthAccountSlotId');
    }

    const directXai = resolveProviderProfileToLLMConfig(
      {
        baseUrl: 'https://api.x.ai/v1',
        displayName: 'xAI API',
        id: 'xai',
        kind: 'direct',
        models: ['grok-4'],
        secretRef: 'vault://vault_00000000-0000-7230-9979-3ef301686c38',
        vendor: 'xai',
      },
      () => 'xai-api-key'
    );

    expect(directXai).toMatchObject({
      adapterId: 'xai',
      apiKey: 'xai-api-key',
      requiresApiKey: true,
    });
    expect(directXai).not.toHaveProperty('accountSlotId');
    expect(directXai).not.toHaveProperty('subscriptionProviderId');
  });

  it('rejects conflicting recognized subscription vendor and id families', () => {
    expect(() =>
      resolveProviderProfileToLLMConfig({
        displayName: 'Conflicting Subscription',
        extensions: { openkit: { subscriptionAccount: { accountSlotId: 'conflict-slot' } } },
        id: 'openai-codex',
        kind: 'oauth',
        models: ['grok-4'],
        vendor: 'xai',
      })
    ).toThrow();
  });

  it('resolves provider credentials through configured secret references', () => {
    const provider = resolveProviderProfileToLLMConfig(
      {
        displayName: 'Vault Provider',
        id: 'vault-provider',
        kind: 'direct',
        models: ['model'],
        secretRef: 'vault://vault_00000000-0000-7f4f-89a1-f9a4db9f7d9d',
      },
      (secretRef) =>
        secretRef === 'vault://vault_00000000-0000-7f4f-89a1-f9a4db9f7d9d' ? 'sk-vault' : null
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
        secretRef: 'vault://vault_00000000-0000-798c-9b64-a72fb18794ac',
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
        secretRef: 'vault://vault_00000000-0000-7652-9153-59e509aca382',
        vendor: 'google',
      },
      (secretRef) =>
        secretRef === 'vault://vault_00000000-0000-7652-9153-59e509aca382' ? 'sk-google' : null
    );

    expect(provider).toMatchObject({
      adapterId: 'google',
      apiKey: 'sk-google',
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
        secretRef: 'vault://vault_00000000-0000-7be3-a5df-9eb51c70ed98',
      },
      (secretRef) =>
        secretRef === 'vault://vault_00000000-0000-7be3-a5df-9eb51c70ed98' ? 'sk-custom' : null
    );

    expect(provider).toMatchObject({
      adapterId: 'custom_proxy',
      apiKey: 'sk-custom',
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
        secretRef: 'vault://vault_00000000-0000-78ba-8a4b-60d484bc5149',
      },
      (secretRef) =>
        secretRef === 'vault://vault_00000000-0000-78ba-8a4b-60d484bc5149' ? 'sk-direct' : null
    );

    expect(provider).toMatchObject({
      adapterId: 'direct_provider',
      apiKey: 'sk-direct',
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

  it.each([
    'blocked',
    'disabled',
    'unknown',
  ] as const)('rejects %s providers before credential resolution', (status) => {
    const credentialResolver = vi.fn(() => 'must-not-resolve');

    expect(() =>
      resolveProviderProfileToLLMConfig(
        {
          displayName: 'Unavailable Provider',
          id: `provider-${status}`,
          kind: 'direct',
          models: ['configured-model'],
          readiness: { status },
          secretRef: 'vault://vault_00000000-0000-7965-933d-6b51cc983845',
        },
        credentialResolver
      )
    ).toThrow(/not dispatchable/i);
    expect(credentialResolver).not.toHaveBeenCalled();
  });

  it.each([undefined, 'ready', 'degraded'] as const)('keeps readiness %s runnable', (status) => {
    const credentialResolver = vi.fn(() => 'resolved-secret');
    const provider = resolveProviderProfileToLLMConfig(
      {
        displayName: 'Runnable Provider',
        id: `provider-${status ?? 'omitted'}`,
        kind: 'direct',
        models: ['configured-model'],
        ...(status ? { readiness: { status } } : {}),
        secretRef: 'vault://vault_00000000-0000-73e3-b8d4-7b543574a38d',
      },
      credentialResolver
    );

    expect(provider.models).toEqual(['configured-model']);
    expect(credentialResolver).toHaveBeenCalledOnce();
  });
});

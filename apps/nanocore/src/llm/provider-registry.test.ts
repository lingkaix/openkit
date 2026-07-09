import { describe, expect, it } from 'vitest';

import { findProviderSpec, LLM_PROVIDER_SPECS, listProviderSpecs } from './provider-registry.js';

describe('LLM provider registry', () => {
  it('lists the initial Pi AI and Codex OAuth providers', () => {
    expect(listProviderSpecs().map((provider) => provider.id)).toEqual([
      'custom',
      'openai',
      'anthropic',
      'openrouter',
      'deepseek',
      'moonshot',
      'groq',
      'google',
      'dashscope',
      'zhipu',
      'siliconflow',
      'ollama',
      'vllm',
      'openai_codex',
    ]);
  });

  it('routes every non-Codex provider through Pi AI', () => {
    expect(
      listProviderSpecs().map((provider) => ({
        id: provider.id,
        backend: provider.backend,
      }))
    ).toEqual(
      listProviderSpecs().map((provider) => ({
        id: provider.id,
        backend: provider.id === 'openai_codex' ? 'codex-oauth' : 'pi-ai',
      }))
    );
  });

  it('captures gateway, local, and OAuth routing metadata', () => {
    expect(findProviderSpec('openrouter')).toMatchObject({
      backend: 'pi-ai',
      isGateway: true,
      defaultBaseUrl: null,
      gatewayCapabilities: {
        chatCompletions: 'native',
        responses: 'bridged',
      },
    });
    expect(findProviderSpec('google')).toMatchObject({
      backend: 'pi-ai',
      defaultBaseUrl: null,
      envKey: 'GOOGLE_GEMINI_API_KEY',
      gatewayCapabilities: {
        chatCompletions: 'native',
        responses: 'bridged',
      },
    });
    expect(findProviderSpec('ollama')).toMatchObject({
      backend: 'pi-ai',
      isLocal: true,
      requiresApiKey: false,
      defaultBaseUrl: 'http://localhost:11434/v1',
      gatewayCapabilities: {
        chatCompletions: 'native',
        responses: 'bridged',
      },
    });
    expect(findProviderSpec('openai')).toMatchObject({
      gatewayCapabilities: {
        chatCompletions: 'native',
        responses: 'native',
      },
    });
    expect(findProviderSpec('anthropic')).toMatchObject({
      backend: 'pi-ai',
      defaultBaseUrl: null,
      envKey: 'ANTHROPIC_API_KEY',
      supportsStreaming: true,
      gatewayCapabilities: {
        chatCompletions: 'native',
        responses: 'bridged',
      },
    });
    expect(findProviderSpec('openai-codex')).toMatchObject({
      id: 'openai_codex',
      backend: 'codex-oauth',
      isOAuth: true,
      requiresApiKey: false,
      gatewayCapabilities: {
        chatCompletions: 'bridged',
        responses: 'native',
      },
    });
  });

  it('keeps provider specs immutable to callers', () => {
    const providers = listProviderSpecs();

    expect(providers).not.toBe(LLM_PROVIDER_SPECS);
    expect(() => providers.push(providers[0])).not.toThrow();
    expect(listProviderSpecs()).toHaveLength(LLM_PROVIDER_SPECS.length);
  });
});

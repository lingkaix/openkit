import { describe, expect, it } from 'vitest';

import { ProviderRegistry } from './registry.js';

describe('ProviderRegistry', () => {
  it('lists and gets loaded provider profiles', () => {
    const registry = new ProviderRegistry([
      {
        baseUrl: 'https://api.openai.com/v1',
        displayName: 'OpenAI',
        id: 'openai',
        kind: 'direct',
        models: ['gpt-5.1'],
        secretRef: 'env:OPENAI_API_KEY',
      },
    ]);

    expect(registry.list()).toEqual([
      expect.objectContaining({
        displayName: 'OpenAI',
        id: 'openai',
      }),
    ]);
    expect(registry.get('openai')).toEqual(
      expect.objectContaining({
        displayName: 'OpenAI',
        id: 'openai',
      })
    );
    expect(registry.get('missing')).toBeNull();
  });

  it('summarizes providers without secret refs or URL auth components', () => {
    const registry = new ProviderRegistry([
      {
        baseUrl: 'https://user:password@example.com/v1',
        defaultModel: 'gpt-5.1',
        displayName: 'Redacted Provider',
        gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
        id: 'redacted',
        kind: 'direct',
        models: ['gpt-5.1'],
        readiness: { status: 'ready' },
        secretRef: 'env:SECRET_VALUE',
      },
    ]);

    const summary = registry.summarize();

    expect(summary).toEqual([
      {
        baseUrl: 'https://example.com/v1',
        defaultModel: 'gpt-5.1',
        displayName: 'Redacted Provider',
        gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
        id: 'redacted',
        kind: 'direct',
        models: ['gpt-5.1'],
        readiness: { status: 'ready' },
      },
    ]);
    expect(JSON.stringify(summary)).not.toContain('SECRET_VALUE');
    expect(JSON.stringify(summary)).not.toContain('user:password');
  });

  it('checks whether a provider has resolvable required credentials', () => {
    const registry = new ProviderRegistry([
      {
        displayName: 'Hosted Missing',
        id: 'hosted-missing',
        kind: 'direct',
        models: ['gpt-5.1'],
        secretRef: 'env:MISSING_KEY',
      },
      {
        displayName: 'Hosted Ready',
        id: 'hosted-ready',
        kind: 'gateway',
        models: ['model'],
        secretRef: 'env:READY_KEY',
      },
      {
        displayName: 'Hosted Without SecretRef',
        id: 'hosted-without-secret-ref',
        kind: 'direct',
        models: ['gpt-5.1'],
      },
      {
        displayName: 'Local',
        id: 'local',
        kind: 'local',
        models: ['llama3.2'],
      },
    ]);

    const resolveSecret = (secretRef: string): string | null =>
      secretRef === 'env:READY_KEY' ? 'sk-ready' : null;

    expect(registry.hasResolvableCredentials('hosted-missing', resolveSecret)).toBe(false);
    expect(registry.hasResolvableCredentials('hosted-ready', resolveSecret)).toBe(true);
    expect(registry.hasResolvableCredentials('hosted-without-secret-ref', resolveSecret)).toBe(
      false
    );
    expect(registry.hasResolvableCredentials('local', resolveSecret)).toBe(true);
    expect(registry.hasResolvableCredentials('unknown', resolveSecret)).toBeNull();
  });

  it('does not resolve env secret refs without an explicit credential resolver', () => {
    process.env.READY_KEY = 'sk-ready';
    const registry = new ProviderRegistry([
      {
        displayName: 'Hosted Ready',
        id: 'hosted-ready',
        kind: 'gateway',
        models: ['model'],
        secretRef: 'env:READY_KEY',
      },
    ]);

    try {
      expect(registry.hasResolvableCredentials('hosted-ready')).toBe(false);
    } finally {
      delete process.env.READY_KEY;
    }
  });
});

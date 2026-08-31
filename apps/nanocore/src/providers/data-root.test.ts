import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadProviderRegistryFromDataRoot } from './data-root.js';

/**
 * Creates a temporary data root with a providers config directory.
 *
 * @returns Data root and providers directory paths.
 */
function createProviderRoot(): { dataRoot: string; providersRoot: string } {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-provider-registry-'));
  const providersRoot = join(dataRoot, 'config', 'providers');

  mkdirSync(providersRoot, { recursive: true });

  return { dataRoot, providersRoot };
}

describe('loadProviderRegistryFromDataRoot', () => {
  it('loads provider profile files into the Server provider registry', () => {
    const { dataRoot, providersRoot } = createProviderRoot();
    writeFileSync(
      join(providersRoot, 'core-openrouter.provider.jsonc'),
      JSON.stringify({
        baseUrl: 'https://openrouter.ai/api/v1',
        defaultModel: 'openai/gpt-5.1',
        displayName: 'Core OpenRouter',
        id: 'core-openrouter',
        kind: 'gateway',
        models: ['openai/gpt-5.1'],
        secretRef: 'env:CORE_OPENROUTER_API_KEY',
      })
    );

    const result = loadProviderRegistryFromDataRoot(dataRoot);

    expect(result.providerDiagnostics.summaries).toEqual([]);
    expect(result.providerRegistry.get('core-openrouter')).toEqual(
      expect.objectContaining({
        id: 'core-openrouter',
        kind: 'gateway',
      })
    );
    expect(result.providerRegistry.get('openrouter')).toBeNull();
  });

  it('loads a Codex subscription profile without legacy slot blocking', () => {
    const { dataRoot, providersRoot } = createProviderRoot();
    writeFileSync(
      join(providersRoot, 'openai-codex.provider.jsonc'),
      JSON.stringify({
        displayName: 'OpenAI Codex',
        extensions: { openkit: { subscriptionAccount: { accountSlotId: 'default' } } },
        id: 'openai_codex',
        kind: 'oauth',
        models: ['openai-codex/gpt-5.6-sol'],
        vendor: 'openai_codex',
      })
    );

    const result = loadProviderRegistryFromDataRoot(dataRoot);
    const registeredProfile = result.providerRegistry.get('openai_codex');

    expect.soft(result.providerDiagnostics.summaries).toEqual([]);
    expect.soft(registeredProfile).toEqual(expect.objectContaining({ id: 'openai_codex' }));
    expect(registeredProfile).not.toHaveProperty('readiness');
  });

  it('redacts provider profile secrets from diagnostics snapshots', () => {
    const previousKey = process.env.CORE_OPENROUTER_API_KEY;
    process.env.CORE_OPENROUTER_API_KEY = 'sk-server-config-secret';

    try {
      const { dataRoot, providersRoot } = createProviderRoot();
      writeFileSync(
        join(providersRoot, 'core-openrouter.provider.jsonc'),
        JSON.stringify({
          baseUrl: 'https://openrouter.ai/api/v1',
          defaultModel: 'openai/gpt-5.1',
          displayName: 'Core OpenRouter',
          id: 'core-openrouter',
          kind: 'gateway',
          models: ['openai/gpt-5.1'],
          secretRef: 'env:CORE_OPENROUTER_API_KEY',
          vendor: 'openrouter',
        })
      );
      const result = loadProviderRegistryFromDataRoot(dataRoot);
      const serialized = JSON.stringify(result.providerDiagnostics);

      expect(result.providerDiagnostics.redactedSnapshot).toEqual([
        expect.objectContaining({
          baseUrl: 'https://openrouter.ai/api/v1',
          id: 'core-openrouter',
        }),
      ]);
      expect(serialized).not.toContain('CORE_OPENROUTER_API_KEY');
      expect(serialized).not.toContain('sk-server-config-secret');
    } finally {
      if (previousKey === undefined) {
        delete process.env.CORE_OPENROUTER_API_KEY;
      } else {
        process.env.CORE_OPENROUTER_API_KEY = previousKey;
      }
    }
  });
});

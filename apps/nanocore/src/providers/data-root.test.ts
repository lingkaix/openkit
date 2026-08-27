import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { OpenKitConfig } from '../config/openkit-config.js';
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

/**
 * Builds a server config with one configured provider instance.
 *
 * @returns OpenKit config carrying one OpenRouter provider instance.
 */
function createServerConfig(): OpenKitConfig {
  return {
    providers: [
      {
        baseUrl: 'https://core:secret@openrouter.ai/api/v1',
        defaultModel: 'openai/gpt-5.1',
        displayName: 'Core OpenRouter',
        id: 'core-openrouter',
        kind: 'gateway',
        models: ['openai/gpt-5.1'],
        secretRef: 'env:CORE_OPENROUTER_API_KEY',
        vendor: 'openrouter',
      },
    ],
  };
}

describe('loadProviderRegistryFromDataRoot', () => {
  it('merges server config providers and provider profile files into an id registry', () => {
    const { dataRoot, providersRoot } = createProviderRoot();
    const serverConfig = createServerConfig();
    const serverProvider = serverConfig.providers?.[0];
    writeFileSync(
      join(providersRoot, 'agent-openrouter.provider.jsonc'),
      JSON.stringify({
        baseUrl: 'https://openrouter.ai/api/v1',
        defaultModel: 'openai/gpt-5.1',
        displayName: 'Agent OpenRouter',
        id: 'agent-openrouter',
        kind: 'gateway',
        models: ['openai/gpt-5.1'],
        secretRef: 'env:AGENT_OPENROUTER_API_KEY',
      })
    );

    const result = loadProviderRegistryFromDataRoot(dataRoot, serverConfig);

    expect(result.providerDiagnostics.summaries).toEqual([]);
    expect(result.providerRegistry.get('core-openrouter')).toEqual(
      expect.objectContaining({
        id: 'core-openrouter',
        vendor: 'openrouter',
      })
    );
    expect(result.providerRegistry.get('core-openrouter')).toBe(serverProvider);
    expect(result.providerRegistry.get('agent-openrouter')).toEqual(
      expect.objectContaining({ id: 'agent-openrouter' })
    );
    expect(result.providerRegistry.get('openrouter')).toBeNull();
  });

  it('rejects duplicate provider ids across server config and profile files', () => {
    const { dataRoot, providersRoot } = createProviderRoot();
    writeFileSync(
      join(providersRoot, 'duplicate.provider.jsonc'),
      JSON.stringify({
        displayName: 'Duplicate File Provider',
        id: 'core-openrouter',
        kind: 'gateway',
        models: ['openai/gpt-5.1'],
        secretRef: 'env:AGENT_OPENROUTER_API_KEY',
      })
    );

    const result = loadProviderRegistryFromDataRoot(dataRoot, createServerConfig());

    expect(result.providerRegistry.get('core-openrouter')).toBeNull();
    expect(result.providerDiagnostics.summaries).toEqual([
      expect.objectContaining({
        code: 'provider.duplicate_id',
        profileId: 'core-openrouter',
        status: 'blocked',
      }),
    ]);
  });

  it('preserves a server-config Codex subscription account without legacy slot blocking', () => {
    const { dataRoot } = createProviderRoot();
    const config: OpenKitConfig = {
      providers: [
        {
          displayName: 'OpenAI Codex',
          extensions: {
            openkit: {
              subscriptionAccount: { accountSlotId: 'default' },
            },
          },
          id: 'openai_codex',
          kind: 'oauth',
          models: ['openai-codex/gpt-5.6-sol'],
          vendor: 'openai_codex',
        },
      ],
    };
    const configuredProfile = config.providers?.[0];

    const result = loadProviderRegistryFromDataRoot(dataRoot, config);
    const registeredProfile = result.providerRegistry.get('openai_codex');

    expect.soft(result.providerDiagnostics.summaries).toEqual([]);
    expect.soft(registeredProfile).toEqual(configuredProfile);
    expect(registeredProfile).not.toHaveProperty('readiness');
  });

  it('redacts server config provider secrets from diagnostics snapshots', () => {
    const previousKey = process.env.CORE_OPENROUTER_API_KEY;
    process.env.CORE_OPENROUTER_API_KEY = 'sk-server-config-secret';

    try {
      const { dataRoot } = createProviderRoot();
      const result = loadProviderRegistryFromDataRoot(dataRoot, createServerConfig());
      const serialized = JSON.stringify(result.providerDiagnostics);

      expect(result.providerDiagnostics.redactedSnapshot).toEqual([
        expect.objectContaining({
          baseUrl: 'https://openrouter.ai/api/v1',
          id: 'core-openrouter',
        }),
      ]);
      expect(serialized).not.toContain('CORE_OPENROUTER_API_KEY');
      expect(serialized).not.toContain('sk-server-config-secret');
      expect(serialized).not.toContain('core:secret');
    } finally {
      if (previousKey === undefined) {
        delete process.env.CORE_OPENROUTER_API_KEY;
      } else {
        process.env.CORE_OPENROUTER_API_KEY = previousKey;
      }
    }
  });
});

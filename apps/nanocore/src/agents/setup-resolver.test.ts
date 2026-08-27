import { describe, expect, it } from 'vitest';

import { ProviderRegistry } from '../providers/registry.js';
import type { AuthoredAgentConfig } from './manifest.js';
import { resolveAgentSetup } from './setup-resolver.js';

/**
 * Creates a minimal authored agent config.
 *
 * @param overrides Partial config override.
 * @returns Authored agent config.
 */
function agentConfig(overrides: Partial<AuthoredAgentConfig> = {}): AuthoredAgentConfig {
  return {
    schemaVersion: 1,
    id: 'agent_codex_host',
    displayName: 'Codex Agent',
    runtime: {
      kind: 'codex',
      adapter: 'codex-app-server',
      binaries: [
        { id: 'openkit-worker-shim', path: '/usr/local/bin/openkit-worker-shim' },
        { id: 'codex', path: '/usr/local/bin/codex' },
      ],
      image: {
        kind: 'reference',
        pullPolicy: 'if-not-present',
        ref: 'ghcr.io/openkit/worker-codex:test',
      },
      version: '0.130.0',
    },
    extensions: {},
    ...overrides,
  } as unknown as AuthoredAgentConfig;
}

/**
 * Creates a provider registry with one agent provider.
 *
 * @returns Provider registry.
 */
function providerRegistry(): ProviderRegistry {
  return new ProviderRegistry([
    {
      baseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: 'openai/gpt-5.1',
      displayName: 'Agent OpenRouter',
      id: 'agent-openrouter',
      kind: 'gateway',
      models: ['openai/gpt-5.1'],
      secretRef: 'env:AGENT_OPENROUTER_API_KEY',
    },
  ]);
}

describe('resolveAgentSetup', () => {
  it('fails with a typed diagnostic when provider refs are missing', () => {
    const result = resolveAgentSetup(
      agentConfig({ provider: { ref: 'missing-provider', model: 'openai/gpt-5.1' } }),
      { providerRegistry: providerRegistry() }
    );

    expect(result.setup).toBeNull();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'agent_setup.missing_provider',
        message: expect.stringContaining('missing-provider'),
        severity: 'error',
        agentId: 'agent_codex_host',
      }),
    ]);
  });

  it('returns only the complete authored manifest and its resolved provider', () => {
    const manifest = agentConfig({
      provider: { ref: 'agent-openrouter', model: 'openai/gpt-5.1' },
      requiredFeatures: ['workspace.mount.fuse'],
      runtime: {
        adapter: 'future-adapter',
        binaries: [
          { id: 'openkit-worker-shim', path: '/usr/local/bin/openkit-worker-shim' },
          { id: 'future-runtime', path: '/opt/future/bin/runtime' },
        ],
        image: {
          kind: 'reference',
          pullPolicy: 'never',
          ref: 'registry.example.com/openkit/worker-future:1.0.0',
        },
        kind: 'future-runtime',
        version: '1.0.0',
      },
      sandbox: {
        backend: {
          allowedKinds: ['openshell'],
          preferred: 'openshell',
          requiredCapabilities: ['git-materialization'],
        },
        credentialDeclarations: [],
        filesystem: [],
        network: [
          {
            access: 'read-write',
            binaries: ['/opt/future/bin/runtime'],
            host: 'api.example.com',
            id: 'future_api',
            port: 443,
            protocol: 'https',
            purpose: 'Use the governed runtime API.',
          },
        ],
      },
    });
    const result = resolveAgentSetup(manifest, {
      providerRegistry: providerRegistry(),
      supportedRequiredFeatures: ['workspace.mount.fuse'],
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.setup).toEqual({
      manifest,
      provider: {
        model: 'openai/gpt-5.1',
        origin: 'server-providers',
        providerId: 'agent-openrouter',
        secretRef: 'env:AGENT_OPENROUTER_API_KEY',
      },
    });
  });

  it('redacts raw provider secrets from the resolved setup snapshot', () => {
    const previousKey = process.env.AGENT_OPENROUTER_API_KEY;
    process.env.AGENT_OPENROUTER_API_KEY = 'sk-agent-secret';

    try {
      const result = resolveAgentSetup(
        agentConfig({ provider: { ref: 'agent-openrouter', model: 'openai/gpt-5.1' } }),
        { providerRegistry: providerRegistry() }
      );
      const serialized = JSON.stringify(result.setup);

      expect(serialized).toContain('env:AGENT_OPENROUTER_API_KEY');
      expect(serialized).not.toContain('sk-agent-secret');
    } finally {
      if (previousKey === undefined) {
        delete process.env.AGENT_OPENROUTER_API_KEY;
      } else {
        process.env.AGENT_OPENROUTER_API_KEY = previousKey;
      }
    }
  });

  it('fails closed for unsupported required features', () => {
    const result = resolveAgentSetup(agentConfig({ requiredFeatures: ['workspace.mount.fuse'] }), {
      providerRegistry: providerRegistry(),
    });

    expect(result.setup).toBeNull();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'agent_setup.unsupported_required_feature',
        message: 'Agent agent_codex_host requires unsupported feature: workspace.mount.fuse.',
        severity: 'error',
        agentId: 'agent_codex_host',
      }),
    ]);
  });

  it('rejects an explicit default profile id that is absent from the manifest', () => {
    const result = resolveAgentSetup(
      agentConfig({
        defaultProfileId: 'missing-profile',
        profiles: [{ id: 'available-profile' }],
      }),
      { providerRegistry: providerRegistry() }
    );

    expect(result.setup).toBeNull();
    expect(result.diagnostics).toEqual([
      {
        agentId: 'agent_codex_host',
        code: 'agent_setup.invalid_default_profile',
        message:
          'Agent agent_codex_host default profile missing-profile is not declared in profiles.',
        severity: 'error',
      },
    ]);
  });
});

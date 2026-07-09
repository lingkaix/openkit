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
      version: '0.130.0',
    },
    mode: 'local',
    deployment: {
      local: {
        command: 'codex',
        args: ['app-server', '--listen', 'stdio://'],
      },
      remote: {
        endpointRef: 'env:REMOTE_AGENT',
      },
    },
    extensions: {},
    ...overrides,
  };
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

  it('uses only the active deployment block for the selected mode', () => {
    const result = resolveAgentSetup(
      agentConfig({ provider: { ref: 'agent-openrouter', model: 'openai/gpt-5.1' } }),
      { providerRegistry: providerRegistry() }
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.setup?.deployment).toEqual({
      mode: 'local',
      config: {
        command: 'codex',
        args: ['app-server', '--listen', 'stdio://'],
      },
      origin: 'agent-config',
    });
    expect(JSON.stringify(result.setup)).not.toContain('REMOTE_AGENT');
    expect(result.setup?.transport).toEqual({
      kind: 'stdio',
      origin: 'adapter-defaults',
    });
  });

  it('marks explicit transport overrides in resolved setup', () => {
    const result = resolveAgentSetup(agentConfig({ transport: { kind: 'stdio' } }), {
      providerRegistry: providerRegistry(),
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.setup?.transport).toEqual({
      kind: 'stdio',
      origin: 'agent-config',
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

  it('preserves supported required features in the resolved setup', () => {
    const result = resolveAgentSetup(agentConfig({ requiredFeatures: ['workspace.mount.fuse'] }), {
      providerRegistry: providerRegistry(),
      supportedRequiredFeatures: ['workspace.mount.fuse'],
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.setup?.requiredFeatures).toEqual(['workspace.mount.fuse']);
  });

  it('preserves backend requirements from the authored sandbox backend section', () => {
    const result = resolveAgentSetup(
      agentConfig({
        sandbox: {
          backend: {
            allowedKinds: ['openshell'],
            preferred: 'openshell',
            requiredCapabilities: ['git-materialization', 'change-set-collection'],
          },
        },
      }),
      { providerRegistry: providerRegistry() }
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.setup?.backend).toEqual({
      allowedKinds: ['openshell'],
      origin: 'agent-config',
      preferred: 'openshell',
      requiredCapabilities: ['git-materialization', 'change-set-collection'],
    });
  });
});

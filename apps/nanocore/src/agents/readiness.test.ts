import { describe, expect, it } from 'vitest';

import { ProviderRegistry } from '../providers/registry.js';
import type { AgentManifest } from './manifest.js';
import { computeReadiness } from './readiness.js';

/**
 * Creates a minimal agent manifest for readiness tests.
 *
 * @param input Manifest fields to override.
 * @returns Agent manifest.
 */
function manifest(input: Partial<AgentManifest> = {}): AgentManifest {
  return {
    adapter: 'custom-http',
    deployments: ['local'],
    displayName: 'Agent',
    id: 'agent_test',
    kind: 'custom',
    runtime: 'custom',
    version: '0.0.2',
    ...input,
  };
}

describe('computeReadiness', () => {
  it('returns ready for a supported manifest with satisfied dependencies', () => {
    const registry = new ProviderRegistry([]);

    expect(computeReadiness(manifest({ readiness: { status: 'ready' } }), registry)).toEqual({
      reasons: [],
      status: 'ready',
    });
  });

  it('returns degraded when provider credentials are missing', () => {
    const registry = new ProviderRegistry([
      {
        baseUrl: 'https://api.example.com/v1',
        displayName: 'Hosted',
        id: 'hosted',
        kind: 'direct',
        models: ['model'],
      },
    ]);

    expect(computeReadiness(manifest({ providerRef: 'hosted' }), registry)).toEqual({
      reasons: ['Provider hosted is missing credentials.'],
      status: 'degraded',
    });
  });

  it('returns blocked for missing provider profiles and unsupported manifest versions', () => {
    const registry = new ProviderRegistry([]);

    expect(computeReadiness(manifest({ providerRef: 'missing' }), registry)).toEqual({
      reasons: ['Provider profile missing is missing.'],
      status: 'blocked',
    });
    expect(computeReadiness(manifest({ version: '9.9.9' }), registry)).toEqual({
      reasons: ['Unsupported agent manifest version: 9.9.9.'],
      status: 'blocked',
    });
  });

  it('returns disabled when the manifest declares disabled readiness', () => {
    const registry = new ProviderRegistry([]);

    expect(
      computeReadiness(
        manifest({ readiness: { message: 'Disabled by operator.', status: 'disabled' } }),
        registry
      )
    ).toEqual({
      reasons: ['Disabled by operator.'],
      status: 'disabled',
    });
  });

  it('does not probe runtime binaries from agent manifests', () => {
    const registry = new ProviderRegistry([]);

    expect(computeReadiness(manifest({ runtime: 'codex' }), registry)).toEqual({
      reasons: [],
      status: 'ready',
    });
  });

  it('maps OpenCode server readiness through the existing agent states', () => {
    const providerRegistry = new ProviderRegistry([
      {
        baseUrl: 'https://openrouter.ai/api/v1',
        displayName: 'OpenRouter',
        id: 'openrouter',
        kind: 'gateway',
        models: ['openai/gpt-5.1'],
        secretRef: 'env:OPENROUTER_API_KEY',
      },
    ]);
    const opencode = manifest({
      adapter: 'opencode-server',
      displayName: 'OpenCode Server Agent',
      id: 'agent_opencode_server',
      kind: 'custom',
      providerRef: 'openrouter',
      runtime: 'opencode',
    });

    expect(
      computeReadiness(manifest({ ...opencode, providerRef: 'missing' }), providerRegistry, {
        providerCredentialResolver: () => 'secret',
      })
    ).toEqual({
      reasons: ['Provider profile missing is missing.'],
      status: 'blocked',
    });
    expect(
      computeReadiness(opencode, providerRegistry, {
        providerCredentialResolver: () => null,
      })
    ).toEqual({
      reasons: ['Provider openrouter is missing credentials.'],
      status: 'degraded',
    });
    expect(
      computeReadiness(
        manifest({
          ...opencode,
          readiness: { message: 'Disabled by operator.', status: 'disabled' },
        }),
        providerRegistry,
        {
          providerCredentialResolver: () => 'secret',
        }
      )
    ).toEqual({
      reasons: ['Disabled by operator.'],
      status: 'disabled',
    });
    expect(
      computeReadiness(
        manifest({
          ...opencode,
          readiness: {
            message: 'OpenCode server availability has not been probed yet.',
            status: 'unknown',
          },
        }),
        providerRegistry,
        {
          providerCredentialResolver: () => 'secret',
        }
      )
    ).toEqual({
      reasons: ['OpenCode server availability has not been probed yet.'],
      status: 'unknown',
    });
    expect(
      computeReadiness(
        manifest({
          ...opencode,
          readiness: { message: 'OpenCode server is available.', status: 'ready' },
        }),
        providerRegistry,
        {
          providerCredentialResolver: () => 'secret',
        }
      )
    ).toEqual({
      reasons: [],
      status: 'ready',
    });
  });
});

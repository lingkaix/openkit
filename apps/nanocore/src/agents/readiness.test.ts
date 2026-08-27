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
    displayName: 'Agent',
    id: 'agent_test',
    requiredFeatures: [],
    runtime: {
      adapter: 'custom',
      binaries: [
        { id: 'openkit-worker-shim', path: '/usr/local/bin/openkit-worker-shim' },
        { id: 'node', path: '/usr/local/bin/node' },
        { id: 'custom', path: '/usr/local/bin/custom' },
      ],
      image: { kind: 'reference', pullPolicy: 'never', ref: 'openkit/worker-custom:test' },
      kind: 'custom',
    },
    schemaVersion: 1,
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

  it('returns blocked when required provider credentials are missing', () => {
    const registry = new ProviderRegistry([
      {
        baseUrl: 'https://api.example.com/v1',
        displayName: 'Hosted',
        id: 'hosted',
        kind: 'direct',
        models: ['model'],
        readiness: { status: 'ready' },
      },
    ]);

    expect(computeReadiness(manifest({ provider: { ref: 'hosted' } }), registry)).toEqual({
      reasons: ['Provider hosted is missing credentials.'],
      status: 'blocked',
    });
  });

  it('isolates provider credential resolution failures to the affected agent', () => {
    const registry = new ProviderRegistry([
      {
        baseUrl: 'https://api.example.com/v1',
        displayName: 'Hosted',
        id: 'hosted',
        kind: 'direct',
        models: ['model'],
        readiness: { status: 'ready' },
        secretRef: 'vault://provider_hosted',
      },
    ]);

    expect(
      computeReadiness(manifest({ provider: { ref: 'hosted' } }), registry, {
        providerCredentialResolver: () => {
          throw new Error('secret-bearing backend detail');
        },
      })
    ).toEqual({
      reasons: ['Provider hosted credentials are unavailable.'],
      status: 'blocked',
    });
  });

  it('defers manifest-owned worker credential validation to turn-scoped AEP resolution', () => {
    const registry = new ProviderRegistry([
      {
        baseUrl: 'https://api.example.com/v1',
        displayName: 'Hosted',
        id: 'hosted',
        kind: 'direct',
        models: ['model'],
        readiness: { status: 'ready' },
      },
    ]);

    expect(
      computeReadiness(
        manifest({
          provider: { ref: 'hosted' },
          sandbox: {
            credentialDeclarations: [
              {
                id: 'hosted_api_key',
                targetEnvVarName: 'HOSTED_API_KEY',
                vaultGrantId: 'grant_hosted_api_key',
                visibility: 'runtime-env',
              },
            ],
            filesystem: [],
            network: [
              {
                access: 'read-write',
                binaries: ['/usr/local/bin/custom'],
                host: 'api.example.com',
                id: 'hosted_api',
                port: 443,
                protocol: 'https',
                purpose: 'Use the selected provider.',
              },
            ],
          },
        }),
        registry
      )
    ).toEqual({
      reasons: [
        'Provider hosted defers manifest-owned worker credential validation to turn-scoped AEP resolution.',
      ],
      status: 'degraded',
    });
  });

  it('does not defer before the direct provider explicitly reports ready', () => {
    const registry = new ProviderRegistry([
      {
        baseUrl: 'https://api.example.com/v1',
        displayName: 'Hosted',
        id: 'hosted',
        kind: 'direct',
        models: ['model'],
      },
    ]);

    expect(
      computeReadiness(
        manifest({
          provider: { ref: 'hosted' },
          sandbox: {
            credentialDeclarations: [
              {
                id: 'hosted_api_key',
                targetEnvVarName: 'HOSTED_API_KEY',
                vaultGrantId: 'grant_hosted_api_key',
                visibility: 'runtime-env',
              },
            ],
            filesystem: [],
            network: [
              {
                access: 'read-write',
                binaries: ['/usr/local/bin/custom'],
                host: 'api.example.com',
                id: 'hosted_api',
                port: 443,
                protocol: 'https',
                purpose: 'Use the selected provider.',
              },
            ],
          },
        }),
        registry
      )
    ).toEqual({
      reasons: ['Provider hosted is missing credentials.'],
      status: 'blocked',
    });
  });

  it('does not mask an unresolved provider credential with a manifest declaration', () => {
    const registry = new ProviderRegistry([
      {
        baseUrl: 'https://api.example.com/v1',
        displayName: 'Hosted',
        id: 'hosted',
        kind: 'direct',
        models: ['model'],
        readiness: { status: 'ready' },
        secretRef: 'vault://provider_hosted',
      },
    ]);

    expect(
      computeReadiness(
        manifest({
          provider: { ref: 'hosted' },
          sandbox: {
            credentialDeclarations: [
              {
                id: 'hosted_api_key',
                targetEnvVarName: 'HOSTED_API_KEY',
                vaultGrantId: 'grant_hosted_api_key',
                visibility: 'runtime-env',
              },
            ],
            filesystem: [],
            network: [
              {
                access: 'read-write',
                binaries: ['/usr/local/bin/custom'],
                host: 'api.example.com',
                id: 'hosted_api',
                port: 443,
                protocol: 'https',
                purpose: 'Use the selected provider.',
              },
            ],
          },
        }),
        registry,
        { providerCredentialResolver: () => null }
      )
    ).toEqual({
      reasons: ['Provider hosted is missing credentials.'],
      status: 'blocked',
    });
  });

  it('does not treat unrelated worker credential declarations as provider credentials', () => {
    const registry = new ProviderRegistry([
      {
        baseUrl: 'https://api.example.com/v1',
        displayName: 'Hosted',
        id: 'hosted',
        kind: 'direct',
        models: ['model'],
        readiness: { status: 'ready' },
      },
    ]);

    expect(
      computeReadiness(
        manifest({
          provider: { ref: 'hosted' },
          sandbox: {
            credentialDeclarations: [
              {
                id: 'runtime_config',
                targetPath: '/sandbox/.config/runtime.json',
                vaultGrantId: 'grant_runtime_config',
                visibility: 'runtime-file',
              },
            ],
            filesystem: [],
            network: [
              {
                access: 'read-write',
                binaries: ['/usr/local/bin/custom'],
                host: 'api.example.com',
                id: 'hosted_api',
                port: 443,
                protocol: 'https',
                purpose: 'Use the selected provider.',
              },
            ],
          },
        }),
        registry
      )
    ).toEqual({
      reasons: ['Provider hosted is missing credentials.'],
      status: 'blocked',
    });
  });

  it('does not defer a runtime-env credential without direct network access', () => {
    const registry = new ProviderRegistry([
      {
        baseUrl: 'https://api.example.com/v1',
        displayName: 'Hosted',
        id: 'hosted',
        kind: 'direct',
        models: ['model'],
        readiness: { status: 'ready' },
      },
    ]);

    expect(
      computeReadiness(
        manifest({
          provider: { ref: 'hosted' },
          sandbox: {
            credentialDeclarations: [
              {
                id: 'hosted_api_key',
                targetEnvVarName: 'HOSTED_API_KEY',
                vaultGrantId: 'grant_hosted_api_key',
                visibility: 'runtime-env',
              },
            ],
            filesystem: [],
            network: [],
          },
        }),
        registry
      )
    ).toEqual({
      reasons: ['Provider hosted is missing credentials.'],
      status: 'blocked',
    });
  });

  it('does not defer multiple manifest-owned credentials', () => {
    const registry = new ProviderRegistry([
      {
        baseUrl: 'https://api.example.com/v1',
        displayName: 'Hosted',
        id: 'hosted',
        kind: 'direct',
        models: ['model'],
        readiness: { status: 'ready' },
      },
    ]);

    expect(
      computeReadiness(
        manifest({
          provider: { ref: 'hosted' },
          sandbox: {
            credentialDeclarations: [
              {
                id: 'hosted_api_key',
                targetEnvVarName: 'HOSTED_API_KEY',
                vaultGrantId: 'grant_hosted_api_key',
                visibility: 'runtime-env',
              },
              {
                id: 'secondary_api_key',
                targetEnvVarName: 'SECONDARY_API_KEY',
                vaultGrantId: 'grant_secondary_api_key',
                visibility: 'runtime-env',
              },
            ],
            filesystem: [],
            network: [
              {
                access: 'read-write',
                binaries: ['/usr/local/bin/custom'],
                host: 'api.example.com',
                id: 'hosted_api',
                port: 443,
                protocol: 'https',
                purpose: 'Use the selected provider.',
              },
            ],
          },
        }),
        registry
      )
    ).toEqual({
      reasons: ['Provider hosted is missing credentials.'],
      status: 'blocked',
    });
  });

  it('does not defer credentials for a non-direct provider profile', () => {
    const registry = new ProviderRegistry([
      {
        baseUrl: 'https://api.example.com/v1',
        displayName: 'Hosted',
        id: 'hosted',
        kind: 'gateway',
        models: ['model'],
        readiness: { status: 'ready' },
      },
    ]);

    expect(
      computeReadiness(
        manifest({
          provider: { ref: 'hosted' },
          sandbox: {
            credentialDeclarations: [
              {
                id: 'hosted_api_key',
                targetEnvVarName: 'HOSTED_API_KEY',
                vaultGrantId: 'grant_hosted_api_key',
                visibility: 'runtime-env',
              },
            ],
            filesystem: [],
            network: [
              {
                access: 'read-write',
                binaries: ['/usr/local/bin/custom'],
                host: 'api.example.com',
                id: 'hosted_api',
                port: 443,
                protocol: 'https',
                purpose: 'Use the selected provider.',
              },
            ],
          },
        }),
        registry
      )
    ).toEqual({
      reasons: ['Provider hosted is missing credentials.'],
      status: 'blocked',
    });
  });

  it('returns blocked for missing provider profiles', () => {
    const registry = new ProviderRegistry([]);

    expect(computeReadiness(manifest({ provider: { ref: 'missing' } }), registry)).toEqual({
      reasons: ['Provider profile missing is missing.'],
      status: 'blocked',
    });
  });

  it('propagates non-launchable provider readiness', () => {
    const registry = new ProviderRegistry([
      {
        baseUrl: 'https://api.example.com/v1',
        displayName: 'Hosted',
        id: 'hosted',
        kind: 'custom',
        models: ['model'],
        readiness: { message: 'Provider account setup is incomplete.', status: 'blocked' },
      },
    ]);

    expect(computeReadiness(manifest({ provider: { ref: 'hosted' } }), registry)).toEqual({
      reasons: ['Provider account setup is incomplete.'],
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

    expect(
      computeReadiness(manifest({ runtime: { ...manifest().runtime, kind: 'codex' } }), registry)
    ).toEqual({
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
      displayName: 'OpenCode Server Agent',
      id: 'agent_opencode_server',
      provider: { ref: 'openrouter' },
      runtime: {
        ...manifest().runtime,
        adapter: 'opencode',
        kind: 'opencode',
      },
    });

    expect(
      computeReadiness(manifest({ ...opencode, provider: { ref: 'missing' } }), providerRegistry, {
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
      status: 'blocked',
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

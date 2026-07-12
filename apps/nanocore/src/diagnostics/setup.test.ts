import { describe, expect, it } from 'vitest';

import type { AgentManifest } from '../agents/manifest.js';
import { ProviderRegistry } from '../providers/registry.js';
import { createSetupDiagnostics } from './setup.js';

/**
 * Creates a minimal agent manifest for setup diagnostics tests.
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

describe('createSetupDiagnostics', () => {
  it('keeps diagnostics available when credential resolution fails', () => {
    const registry = new ProviderRegistry([
      {
        baseUrl: 'https://user:sk-secret@example.com/v1',
        displayName: 'Hosted',
        id: 'hosted',
        kind: 'custom',
        models: ['model'],
        secretRef: 'vault://missing',
      },
    ]);

    const diagnostics = createSetupDiagnostics({
      agentConfigs: [],
      agentManifests: [manifest({ providerRef: 'hosted' })],
      dataRoot: '/tmp/openkit-test',
      mode: 'local',
      openKitConfig: {},
      providerCredentialResolver: () => {
        throw new Error('reference-not-found: Vault reference material was not found.');
      },
      providerRegistry: registry,
      runtimeConfig: {
        currentVersion: 1,
        lastFailedReload: null,
        lastReload: null,
        loadedAt: '2026-01-01T00:00:00.000Z',
        pendingRestart: [],
        staleSessions: [],
      },
    });

    expect(diagnostics.providers).toEqual([
      expect.objectContaining({
        id: 'hosted',
        secret: { configured: true, marker: 'secret-ref', ref: 'vault://missing' },
      }),
    ]);
    expect(diagnostics.agents[0]?.readiness).toEqual({
      reasons: ['Provider hosted is missing credentials.'],
      status: 'degraded',
    });
    expect(diagnostics.server.dataRoot).toBe('configured');
    expect(JSON.stringify(diagnostics)).not.toContain('/tmp/openkit-test');
    expect(JSON.stringify(diagnostics)).not.toContain('sk-secret');
  });
});

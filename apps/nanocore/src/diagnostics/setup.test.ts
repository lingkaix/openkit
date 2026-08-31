import { describe, expect, it } from 'vitest';

import { ProviderRegistry } from '../providers/registry.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createSetupDiagnostics } from './setup.js';

describe('createSetupDiagnostics', () => {
  it('keeps Provider secret references redacted without making them Agent readiness inputs', () => {
    const registry = new ProviderRegistry([
      {
        baseUrl: 'https://user:sk-secret@example.com/v1',
        displayName: 'Hosted',
        id: 'agent-openrouter',
        kind: 'custom',
        models: ['openai/gpt-5.2'],
        secretRef: 'vault://missing',
      },
    ]);

    const diagnostics = createSetupDiagnostics({
      agentManifests: [createTestAgentSetup().manifest],
      dataRoot: '/tmp/openkit-test',
      gatewayConfig: createTestGatewayConfig(),
      mode: 'local',
      openKitConfig: {},
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
        id: 'agent-openrouter',
        secret: { configured: true, marker: 'secret-ref', ref: 'vault://missing' },
      }),
    ]);
    expect(diagnostics.agents[0]?.readiness).toEqual({
      reasons: [],
      status: 'ready',
    });
    expect(diagnostics.server.dataRoot).toBe('configured');
    expect(JSON.stringify(diagnostics)).not.toContain('/tmp/openkit-test');
    expect(JSON.stringify(diagnostics)).not.toContain('sk-secret');
  });
});

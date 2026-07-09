import { describe, expect, it } from 'vitest';

import { AuthoredAgentConfigSchema } from './agent.js';

describe('AuthoredAgentConfigSchema', () => {
  it('accepts registered required features', () => {
    const parsed = AuthoredAgentConfigSchema.parse({
      schemaVersion: 1,
      requiredFeatures: ['workspace.mount.fuse'],
      id: 'agent_codex_host',
      displayName: 'Codex Agent',
      runtime: { kind: 'codex', adapter: 'codex-app-server' },
      mode: 'local',
      deployment: { local: {} },
    });

    expect(parsed.requiredFeatures).toEqual(['workspace.mount.fuse']);
  });

  it('rejects unregistered required features', () => {
    expect(() =>
      AuthoredAgentConfigSchema.parse({
        schemaVersion: 1,
        requiredFeatures: ['workspace.mount.telepathy'],
        id: 'agent_codex_host',
        displayName: 'Codex Agent',
        runtime: { kind: 'codex', adapter: 'codex-app-server' },
        mode: 'local',
        deployment: { local: {} },
      })
    ).toThrow('Unregistered required feature: workspace.mount.telepathy');
  });

  it('accepts backend capability requirements under sandbox backend', () => {
    const parsed = AuthoredAgentConfigSchema.parse({
      schemaVersion: 1,
      requiredFeatures: [],
      id: 'agent_codex_host',
      displayName: 'Codex Agent',
      runtime: { kind: 'codex', adapter: 'codex-app-server' },
      mode: 'local',
      deployment: { local: {} },
      sandbox: {
        backend: {
          allowedKinds: ['openshell'],
          preferred: 'openshell',
          requiredCapabilities: ['git-materialization', 'change-set-collection'],
        },
      },
    });

    expect(parsed.sandbox?.backend?.requiredCapabilities).toEqual([
      'git-materialization',
      'change-set-collection',
    ]);
  });

  it('rejects unknown backend capability requirements', () => {
    expect(() =>
      AuthoredAgentConfigSchema.parse({
        schemaVersion: 1,
        requiredFeatures: [],
        id: 'agent_codex_host',
        displayName: 'Codex Agent',
        runtime: { kind: 'codex', adapter: 'codex-app-server' },
        mode: 'local',
        deployment: { local: {} },
        sandbox: {
          backend: {
            requiredCapabilities: ['telepathy-materialization'],
          },
        },
      })
    ).toThrow();
  });
});

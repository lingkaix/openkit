import { describe, expect, it } from 'vitest';

import { AuthoredAgentConfigSchema } from './agent.js';

/** Returns one valid opaque worker AgentManifest fixture. */
function validAgentConfig() {
  return {
    schemaVersion: 1,
    requiredFeatures: [],
    id: 'agent_worker_fixture',
    displayName: 'Worker Fixture',
    runtime: {
      kind: 'future-runtime',
      adapter: 'future-adapter',
      image: {
        ref: 'ghcr.io/openkit/worker-fixture:0.1.0',
        pullPolicy: 'if-not-present',
      },
      binaries: [
        { id: 'openkit-worker-shim', path: '/usr/local/bin/openkit-worker-shim' },
        { id: 'future-runtime', path: '/usr/local/bin/future-runtime' },
      ],
    },
    sandbox: {
      network: [
        {
          id: 'runtime_api',
          host: 'api.example.com',
          port: 443,
          protocol: 'https',
          access: 'read-write',
          purpose: 'Call the governed runtime API.',
          binaries: ['/usr/local/bin/future-runtime'],
        },
      ],
    },
  };
}

describe('AuthoredAgentConfigSchema', () => {
  it('accepts one strict opaque runtime declaration', () => {
    const parsed = AuthoredAgentConfigSchema.parse(validAgentConfig());

    expect(parsed.runtime).toEqual(validAgentConfig().runtime);
  });

  const config = validAgentConfig();
  it.each([
    [
      'an image without a pull policy',
      { ...config, runtime: { ...config.runtime, image: { ref: config.runtime.image.ref } } },
    ],
    ['an empty runtime binary list', { ...config, runtime: { ...config.runtime, binaries: [] } }],
    [
      'a relative runtime binary path',
      {
        ...config,
        runtime: { ...config.runtime, binaries: [{ id: 'runtime', path: 'bin/runtime' }] },
      },
    ],
    [
      'a network binary absent from runtime.binaries',
      {
        ...config,
        sandbox: {
          network: [
            { ...config.sandbox.network[0], binaries: ['/usr/local/bin/undeclared-runtime'] },
          ],
        },
      },
    ],
    [
      'an omitted network binary list',
      {
        ...config,
        sandbox: {
          network: [{ ...config.sandbox.network[0], binaries: undefined }],
        },
      },
    ],
    [
      'an empty network binary list',
      {
        ...config,
        sandbox: {
          network: [{ ...config.sandbox.network[0], binaries: [] }],
        },
      },
    ],
  ])('rejects %s', (_name, candidate) => {
    expect(AuthoredAgentConfigSchema.safeParse(candidate).success).toBe(false);
  });

  it.each([
    ['mode', 'local'],
    ['deployment', { local: {} }],
    ['transport', { kind: 'stdio' }],
    ['runtimeConfig', { command: ['runtime'] }],
  ])('rejects retired per-agent execution field %s', (field, value) => {
    expect(
      AuthoredAgentConfigSchema.safeParse({ ...validAgentConfig(), [field]: value }).success
    ).toBe(false);
  });

  it('rejects authored provider fallbacks', () => {
    expect(
      AuthoredAgentConfigSchema.safeParse({
        ...validAgentConfig(),
        provider: { fallbacks: [], model: 'model', ref: 'provider' },
      }).success
    ).toBe(false);
  });

  it('accepts registered required features', () => {
    const parsed = AuthoredAgentConfigSchema.parse({
      ...validAgentConfig(),
      requiredFeatures: ['workspace.mount.fuse'],
    });

    expect(parsed.requiredFeatures).toEqual(['workspace.mount.fuse']);
  });

  it('rejects unregistered required features', () => {
    expect(() =>
      AuthoredAgentConfigSchema.parse({
        ...validAgentConfig(),
        requiredFeatures: ['workspace.mount.telepathy'],
      })
    ).toThrow('Unregistered required feature: workspace.mount.telepathy');
  });

  it('accepts backend capability requirements under sandbox backend', () => {
    const config = validAgentConfig();
    const parsed = AuthoredAgentConfigSchema.parse({
      ...config,
      sandbox: {
        ...config.sandbox,
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
    const config = validAgentConfig();

    expect(() =>
      AuthoredAgentConfigSchema.parse({
        ...config,
        sandbox: {
          ...config.sandbox,
          backend: {
            requiredCapabilities: ['telepathy-materialization'],
          },
        },
      })
    ).toThrow();
  });
});

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { AuthoredAgentConfigSchema } from './agent.js';

/** Returns one valid opaque worker AgentManifest fixture. */
function validAgentConfig() {
  return {
    schemaVersion: 1,
    requiredFeatures: [],
    id: 'agent_worker_fixture',
    displayName: 'Worker Fixture',
    models: {
      preferredLogicalModelId: 'reasoning',
      allowedLogicalModelIds: ['reasoning'],
    },
    runtime: {
      kind: 'future-runtime',
      adapter: 'future-adapter',
      image: {
        kind: 'reference',
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
  it('accepts reusable credential requirements and rejects ambiguous direct grants', () => {
    const requirement = AuthoredAgentConfigSchema.parse({
      ...validAgentConfig(),
      sandbox: {
        credentialDeclarations: [
          {
            id: 'github_token',
            purpose: 'Authenticate GitHub CLI.',
            required: true,
            requirementId: 'github-token',
            targetEnvVarName: 'GITHUB_TOKEN',
            visibility: 'runtime-env',
          },
        ],
        network: [],
      },
    });

    expect(requirement.sandbox?.credentialDeclarations[0]).toMatchObject({
      requirementId: 'github-token',
      required: true,
    });
    expect(() =>
      AuthoredAgentConfigSchema.parse({
        ...validAgentConfig(),
        sandbox: {
          credentialDeclarations: [
            {
              id: 'ambiguous_token',
              requirementId: 'github-token',
              targetEnvVarName: 'GITHUB_TOKEN',
              vaultGrantId: 'grant_github',
              visibility: 'runtime-env',
            },
          ],
          network: [],
        },
      })
    ).toThrow(/must not declare requirementId/);
  });

  it('accepts exactly one reference or bounded build image form', () => {
    const config = validAgentConfig();
    const dockerfile = 'FROM node:24.16.0';
    const dockerfileDigest = `sha256:${createHash('sha256').update(dockerfile).digest('hex')}`;
    const reference = {
      ...config,
      runtime: {
        ...config.runtime,
        image: {
          kind: 'reference',
          pullPolicy: 'if-not-present',
          ref: 'ghcr.io/openkit/worker-fixture:0.1.0',
        },
      },
    };
    const build = {
      ...config,
      runtime: {
        ...config.runtime,
        image: {
          arguments: { NODE_VERSION: '24.16.0' },
          contextDigest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          contextRef: 'build-context://empty/v1',
          egress: [{ host: 'registry.npmjs.org', port: 443 }],
          input: { content: dockerfile, digest: dockerfileDigest, kind: 'dockerfile' },
          kind: 'build',
          layerLimit: 128,
          outputLimitBytes: 21_474_836_480,
          timeLimitSeconds: 1800,
        },
      },
    };

    expect(AuthoredAgentConfigSchema.parse(reference).runtime.image).toEqual(
      reference.runtime.image
    );
    expect(AuthoredAgentConfigSchema.parse(build).runtime.image).toEqual(build.runtime.image);
    const atMaximum = 'a'.repeat(268_435_456);
    for (const [content, accepted] of [
      ['', false],
      ['a', true],
      [atMaximum, true],
      [`${atMaximum}a`, false],
    ] as const) {
      const image = {
        ...build.runtime.image,
        input: {
          content,
          digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
          kind: 'dockerfile' as const,
        },
      };
      expect(
        AuthoredAgentConfigSchema.safeParse({
          ...config,
          runtime: { ...config.runtime, image },
        }).success,
        `Dockerfile UTF-8 byte length ${Buffer.byteLength(content)} had the wrong disposition`
      ).toBe(accepted);
    }
    expect(
      AuthoredAgentConfigSchema.safeParse({
        ...build,
        runtime: {
          ...build.runtime,
          image: {
            ...build.runtime.image,
            input: { ...build.runtime.image.input, digest: `sha256:${'0'.repeat(64)}` },
          },
        },
      }).success
    ).toBe(false);
    expect(
      AuthoredAgentConfigSchema.safeParse({
        ...build,
        runtime: {
          ...build.runtime,
          image: {
            ...build.runtime.image,
            layerLimit: 1,
            outputLimitBytes: 1,
            timeLimitSeconds: 1,
          },
        },
      }).success
    ).toBe(true);
    for (const image of [
      {},
      { ...reference.runtime.image, ...build.runtime.image },
      { ...build.runtime.image, contextRef: undefined },
      { ...build.runtime.image, contextDigest: undefined },
      { ...build.runtime.image, contextRef: 'workspace://build-context' },
      { ...build.runtime.image, contextRef: 'build-context://empty/v2' },
      { ...build.runtime.image, egress: undefined },
      { ...build.runtime.image, egress: [{ host: '*', port: 443 }] },
      { ...build.runtime.image, pullPolicy: 'always' },
      { ...build.runtime.image, arguments: { token: 'forbidden-secret' } },
      { ...build.runtime.image, layerLimit: 129 },
      { ...build.runtime.image, outputLimitBytes: 21_474_836_481 },
      { ...build.runtime.image, timeLimitSeconds: 1801 },
      { ...build.runtime.image, egress: [{ host: 'registry.npmjs.org' }] },
      { ...build.runtime.image, layerLimit: 0 },
      { ...build.runtime.image, outputLimitBytes: 0 },
      { ...build.runtime.image, timeLimitSeconds: 0 },
      { ...build.runtime.image, layerLimit: undefined },
      { ...build.runtime.image, outputLimitBytes: undefined },
      { ...build.runtime.image, timeLimitSeconds: undefined },
    ]) {
      expect(
        AuthoredAgentConfigSchema.safeParse({
          ...config,
          runtime: { ...config.runtime, image },
        }).success,
        `accepted invalid image ${JSON.stringify(image)}`
      ).toBe(false);
    }
  });

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

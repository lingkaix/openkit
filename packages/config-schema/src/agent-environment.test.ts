import { createHash } from 'node:crypto';
import { WORKER_RUNTIME_PROVENANCE_FEATURE as WORKER_PROTOCOL_RUNTIME_PROVENANCE_FEATURE } from '@openkit/worker-protocol';
import { describe, expect, it } from 'vitest';

import {
  AgentEnvironmentBinarySchema,
  AgentEnvironmentControlAdapterSchema,
  AgentEnvironmentCredentialDeclarationSchema,
  AgentEnvironmentLlmSchema,
  AgentEnvironmentPackageSchema,
  AgentEnvironmentRuntimeCommandSchema,
  AgentEnvironmentRuntimeSchema,
  AgentEnvironmentSupplySchema,
  OPENKIT_WORKER_CONTROL_POST_PATHS,
  redactAgentEnvironmentPackageSnapshot,
  validateAgentEnvironmentPackageForBackend,
  WORKER_RUNTIME_PROVENANCE_FEATURE,
  WorkerGovernanceBackendCapabilitiesSchema,
  WorkerSandboxAccessSchema,
} from './index.js';

/**
 * Creates a valid NanoHost-targeted package fixture with local Integration bindings.
 *
 * @returns Agent environment package fixture.
 */
function openshellPackageFixture(): unknown {
  return {
    schemaVersion: 4,
    packageId: 'aepkg_demo',
    snapshotId: 'aepsnap_demo',
    createdAt: '2026-06-16T00:00:00.000Z',
    scope: {
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'turn_demo',
      agentSessionId: 'as_demo',
      triggerActor: { kind: 'user', id: 'user_demo' },
      requestId: 'req_demo',
    },
    agent: {
      agentId: 'agent_codex_container',
      profileId: 'coder',
      displayName: 'Codex Worker',
      runtimeKind: 'codex',
      runtimeVersion: '0.144.1',
      profileKind: 'coder',
      instructions: [],
      capabilityRequests: ['llm', 'shell', 'filesystem', 'network', 'artifacts'],
    },
    runtime: {
      image: {
        kind: 'reference',
        ref: 'ghcr.io/openkit/codex-worker:2026-06-16',
        pullPolicy: 'if-not-present',
      },
      binaries: [
        { id: 'openkit-worker-shim', path: '/usr/local/bin/openkit-worker-shim' },
        { id: 'node', path: '/usr/local/bin/node' },
        { id: 'codex', path: '/usr/local/bin/codex' },
        { id: 'codex-native', path: '/usr/local/lib/codex/bin/codex' },
        { id: 'git', path: '/usr/bin/git' },
      ],
      command: {
        argv: ['openkit-worker-shim'],
        workingDirectory: '/workspace/repo',
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
      process: {
        user: 'openkit-worker',
        group: 'openkit-worker',
        umask: '0022',
      },
      session: {
        reuse: 'never',
        resumeHandleRef: null,
      },
    },
    workspace: {
      root: '/workspace',
      inputs: [
        {
          id: 'repo',
          kind: 'directory',
          source: {
            kind: 'host-dir',
            pathRef: 'workspace://files/repo',
          },
          target: '/workspace/repo',
          access: 'read-write',
        },
      ],
      generatedFiles: [],
      outputs: [
        {
          id: 'default-output',
          path: '/workspace/output',
          registerAsArtifacts: true,
          retention: 'sync-on-turn-end',
        },
      ],
    },
    supply: {
      skills: [
        {
          id: 'repo-guidelines',
          version: '1.0.0',
          sourceRef: 'server:skills/repo-guidelines',
          target: '/openkit/supply/skills/repo-guidelines',
          allowedRuntimeAdapters: ['codex'],
          allowedWorkspaceScopes: ['workspace'],
          integrity: { sha256: 'sha256-repo-guidelines-v1' },
          materialization: {
            kind: 'filesystem-copy',
            targetPath: '/openkit/supply/skills/repo-guidelines',
          },
          policyRefIds: ['policy_worker_skill_repo_guidelines'],
          reviewStatus: 'approved',
          secretRefIds: [],
        },
      ],
      mcpServers: [
        {
          id: 'github',
          catalogDigest: `sha256:${'a'.repeat(64)}`,
          allowedTools: ['repos.get', 'issues.list'],
          deniedTools: [],
          approvalRequiredTools: ['issues.list'],
          schemaPolicy: 'tracking',
          pinnedSchemaSnapshotId: null,
        },
      ],
      services: [],
    },
    control: {
      protocol: 'openkit-worker-control-v1',
      mode: 'sandbox-integration',
      bindings: {
        capabilities: {
          pathPrefix: '/capabilities/',
          tokenRef: 'runtime://openkit/capability-token',
        },
        inference: {
          pathPrefix: '/inference/',
          tokenRef: 'runtime://openkit/inference-token',
        },
        workerControl: {
          pathPrefix: '/worker-control/',
          tokenRef: 'runtime://openkit/worker-control-token',
        },
      },
      transcript: {
        root: '/openkit/session',
        eventsPath: '/openkit/session/events.jsonl',
        itemsPath: '/openkit/session/items.jsonl',
        artifactsPath: '/openkit/session/artifacts.jsonl',
        flush: 'line',
        import: 'turn-end',
        required: true,
      },
      channels: {
        commands: true,
        events: 'batch',
        artifacts: 'batch',
        heartbeats: true,
        logs: 'summary-only',
      },
      commands: ['interrupt'],
      events: ['worker.ready', 'turn.started', 'item.created', 'turn.completed'],
      adapter: {
        kind: 'openkit-worker-shim',
        targetRuntime: 'codex',
      },
    },
    capabilities: {
      protocol: 'openkit-worker-capability-v1',
      mode: 'disabled',
      routes: [],
    },
    vault: {
      references: [
        {
          id: 'vault_github_read',
          kind: 'secret-ref',
          secretRef: 'vault://github/read',
        },
      ],
      grants: [
        {
          id: 'grant_github_read',
          vaultRefId: 'vault_github_read',
          scope: 'agent-session',
          expiresAt: '2026-06-16T01:00:00.000Z',
        },
      ],
    },
    policy: {
      snapshotId: 'worker_turn_launch_policy',
      filesystem: { default: 'deny', rules: [] },
      network: { default: 'deny', rules: [] },
      process: { default: 'deny', rules: [] },
      inference: { allowedProviderInstanceIds: ['provider_github_read'] },
      secrets: { visibility: 'placeholder-only' },
      artifacts: { outputsMustBeDeclared: true },
    },
    llm: {
      mode: 'gateway',
      preferredLogicalModelId: 'gpt-5',
      routes: [
        {
          id: 'default-openai',
          providerInstanceId: 'provider_openai_default',
          model: 'gpt-5',
          endpoint: {
            kind: 'openai-compatible',
            upstream: {
              kind: 'nanocore-gateway',
            },
          },
          credentialVisibility: 'placeholder',
        },
      ],
    },
    resources: {
      cpu: { maxCores: 2 },
      memory: { maxBytes: 4_294_967_296 },
      wallClock: { maxSeconds: 3600 },
    },
    observability: {
      audit: { required: true, formats: { preferred: 'ocsf-json' } },
      evidence: { collectBackendLogs: true, collectSessionFiles: true },
    },
    backend: {
      preferred: 'openshell',
      allowedKinds: ['openshell'],
      requiredCapabilities: [
        'container',
        'transcript-sink',
        'network-policy',
        'worker-control',
        'provider-attachments',
        'credential-placeholder',
        'nanocore-inference-upstream',
        'audit-export',
      ],
      degrade: {
        allowHostMode: false,
        allowMissingAudit: false,
      },
    },
    extensions: {},
  };
}

/**
 * Creates a package that requires the trusted worker-inference relay.
 *
 * @returns Relay-required agent environment package fixture.
 */
function trustedWorkerInferenceRelayPackageFixture(): Record<string, unknown> {
  const fixture = openshellPackageFixture() as Record<string, unknown>;
  const backend = fixture.backend as Record<string, unknown>;
  const policy = fixture.policy as Record<string, unknown>;
  const supply = fixture.supply as Record<string, unknown>;

  return {
    ...fixture,
    backend: {
      ...backend,
      requiredCapabilities: [
        ...(backend.requiredCapabilities as string[]),
        'trusted-worker-inference-relay',
      ],
    },
    credentials: { declarations: [] },
    llm: {
      mode: 'gateway',
      preferredLogicalModelId: 'openai/gpt-5.2',
      routes: [
        {
          credentialVisibility: 'placeholder',
          endpoint: {
            kind: 'openai-compatible',
            upstream: {
              kind: 'nanocore-gateway',
            },
          },
          id: 'worker-inference',
          model: 'openai/gpt-5.2',
          providerInstanceId: 'openkit-gateway',
        },
      ],
    },
    policy: {
      ...policy,
      inference: { mode: 'gateway' },
      network: {
        default: 'deny',
        enforcement: 'openshell',
        rules: [],
      },
    },
    supply: { ...supply, mcpServers: [] },
    vault: { grants: [], references: [] },
  };
}

/**
 * Creates a relay-required package that declares bounded runtime provenance outputs.
 *
 * @returns Runtime provenance package fixture.
 */
function runtimeProvenancePackageFixture(): Record<string, unknown> {
  const fixture = trustedWorkerInferenceRelayPackageFixture();
  const backend = fixture.backend as Record<string, unknown>;
  const control = fixture.control as Record<string, unknown>;
  const transcript = control.transcript as Record<string, unknown>;

  return {
    ...fixture,
    backend: {
      ...backend,
      requiredCapabilities: [
        ...(backend.requiredCapabilities as string[]),
        'worker.runtime-provenance.v1',
      ],
    },
    control: {
      ...control,
      transcript: {
        ...transcript,
        runtimeProvenance: {
          rawStreamsRoot: '/openkit/session/runtime/raw',
          streamManifestPath: '/openkit/session/runtime/raw-streams.json',
          nativeOriginIndexPath: '/openkit/session/runtime/native-origin-index.jsonl',
          maxTotalBytes: 268_435_456,
          maxStreamCount: 64,
        },
      },
    },
  };
}

describe('agent environment package schema', () => {
  it('accepts only strict AEP version 4', () => {
    const versionFour = openshellPackageFixture() as Record<string, unknown>;

    expect(AgentEnvironmentPackageSchema.shape.schemaVersion.safeParse(4).success).toBe(true);
    expect(AgentEnvironmentPackageSchema.shape.schemaVersion.safeParse(3).success).toBe(false);
    expect(AgentEnvironmentPackageSchema.shape.schemaVersion.safeParse(2).success).toBe(false);
    expect(AgentEnvironmentPackageSchema.parse(versionFour).schemaVersion).toBe(4);
    expect(
      AgentEnvironmentPackageSchema.safeParse({ ...versionFour, schemaVersion: 3 }).success
    ).toBe(false);
  });

  it('accepts exactly one reference or immutable bounded build image projection', () => {
    const runtime = (openshellPackageFixture() as { runtime: Record<string, unknown> }).runtime;
    const dockerfile = 'FROM node:24.16.0-bookworm-slim';
    const reference = {
      kind: 'reference',
      pullPolicy: 'if-not-present',
      ref: 'ghcr.io/openkit/codex-worker:2026-08-09',
    };
    const build = {
      arguments: { NODE_VERSION: '24.16.0' },
      argumentsDigest: 'sha256:arguments',
      contextDigest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      contextRef: 'build-context://empty/v1',
      egress: [{ host: 'registry.npmjs.org', port: 443 }],
      input: {
        content: dockerfile,
        digest: `sha256:${createHash('sha256').update(dockerfile).digest('hex')}`,
        kind: 'dockerfile',
      },
      kind: 'build',
      layerLimit: 128,
      outputLimitBytes: 21_474_836_480,
      timeLimitSeconds: 1800,
    };

    expect(AgentEnvironmentRuntimeSchema.safeParse({ ...runtime, image: reference }).success).toBe(
      true
    );
    expect(AgentEnvironmentRuntimeSchema.safeParse({ ...runtime, image: build }).success).toBe(
      true
    );
    const recordedDockerfile = 'é'.repeat(965_971);
    expect(Buffer.byteLength(recordedDockerfile)).toBe(1_931_942);
    expect(
      AgentEnvironmentRuntimeSchema.safeParse({
        ...runtime,
        image: {
          ...build,
          input: {
            content: recordedDockerfile,
            digest: `sha256:${createHash('sha256').update(recordedDockerfile).digest('hex')}`,
            kind: 'dockerfile',
          },
        },
      }).success
    ).toBe(true);
    expect(
      AgentEnvironmentRuntimeSchema.safeParse({
        ...runtime,
        image: {
          ...build,
          input: { ...build.input, digest: `sha256:${'0'.repeat(64)}` },
        },
      }).success
    ).toBe(false);
    expect(
      AgentEnvironmentRuntimeSchema.safeParse({
        ...runtime,
        image: { ...build, layerLimit: 1, outputLimitBytes: 1, timeLimitSeconds: 1 },
      }).success
    ).toBe(true);
    for (const image of [
      {},
      { ...reference, ...build },
      { ...build, contextRef: undefined },
      { ...build, contextDigest: undefined },
      { ...build, contextRef: 'workspace://build-context' },
      { ...build, contextRef: 'build-context://empty/v2' },
      { ...build, contextDigest: `sha256:${'a'.repeat(64)}` },
      {
        ...build,
        contextDigest: `sha256:${'a'.repeat(64)}`,
        contextRef: 'build-context://empty/v2',
      },
      { ...build, egress: [] },
      { ...build, egress: [{ host: '*', port: 443 }] },
      { ...build, pullPolicy: 'always' },
      { ...build, arguments: { NPM_TOKEN: 'secret://npm' } },
      { ...build, layerLimit: 129 },
      { ...build, outputLimitBytes: 21_474_836_481 },
      { ...build, timeLimitSeconds: 1801 },
      { ...build, egress: [{ host: 'registry.npmjs.org' }] },
      { ...build, layerLimit: 0 },
      { ...build, outputLimitBytes: 0 },
      { ...build, timeLimitSeconds: 0 },
      { ...build, layerLimit: undefined },
      { ...build, outputLimitBytes: undefined },
      { ...build, timeLimitSeconds: undefined },
    ]) {
      expect
        .soft(AgentEnvironmentRuntimeSchema.safeParse({ ...runtime, image }).success)
        .toBe(false);
    }
  });

  it('accepts only V4 package scope with one exact trigger actor', () => {
    const fixture = openshellPackageFixture() as Record<string, unknown>;
    const scope = fixture.scope as Record<string, unknown>;
    const parsed = AgentEnvironmentPackageSchema.parse(fixture);

    expect(parsed.schemaVersion).toBe(4);
    expect(parsed.scope.triggerActor).toEqual({ kind: 'user', id: 'user_demo' });
    expect(
      AgentEnvironmentPackageSchema.parse({
        ...fixture,
        scope: {
          ...scope,
          triggerActor: {
            kind: 'automation',
            id: 'automation_demo',
            responsibleUserId: 'user_demo',
          },
        },
      }).scope.triggerActor
    ).toEqual({
      kind: 'automation',
      id: 'automation_demo',
      responsibleUserId: 'user_demo',
    });
    expect(AgentEnvironmentPackageSchema.safeParse({ ...fixture, schemaVersion: 1 }).success).toBe(
      false
    );
    expect(AgentEnvironmentPackageSchema.safeParse({ ...fixture, schemaVersion: 2 }).success).toBe(
      false
    );
    expect(
      AgentEnvironmentPackageSchema.safeParse({
        ...fixture,
        scope: { ...scope, triggerActor: undefined },
      }).success
    ).toBe(false);

    for (const legacyKey of ['userId', 'automationId', 'organizationId']) {
      expect(
        AgentEnvironmentPackageSchema.safeParse({
          ...fixture,
          scope: { ...scope, [legacyKey]: `${legacyKey}_legacy` },
        }).success
      ).toBe(false);
    }
  });

  it('accepts explicit worker sandbox access declarations', () => {
    expect(
      WorkerSandboxAccessSchema.parse({
        credentialDeclarations: [
          {
            id: 'registry_token',
            targetEnvVarName: 'NPM_TOKEN',
            vaultGrantId: 'grant_registry_token',
            visibility: 'runtime-env',
          },
        ],
        filesystem: [
          {
            access: 'read-write',
            id: 'build_cache',
            purpose: 'Build cache',
            scope: 'session',
            targetPath: '/sandbox/.cache/build',
          },
        ],
        network: [
          {
            access: 'read-write',
            binaries: ['/usr/bin/npm'],
            host: 'registry.npmjs.org',
            id: 'npm_registry',
            port: 443,
            protocol: 'rest',
            purpose: 'Install package dependencies',
          },
          {
            binaries: ['/usr/bin/git'],
            host: 'github.com',
            id: 'github_git_read',
            port: 443,
            protocol: 'rest',
            purpose: 'Clone and fetch Git repositories',
            rules: [
              { method: 'GET', path: '/**/info/refs*' },
              { method: 'POST', path: '/**/git-upload-pack' },
            ],
          },
        ],
      })
    ).toEqual(
      expect.objectContaining({
        credentialDeclarations: [expect.objectContaining({ id: 'registry_token' })],
        filesystem: [expect.objectContaining({ id: 'build_cache' })],
        network: expect.arrayContaining([
          expect.objectContaining({ id: 'npm_registry' }),
          expect.objectContaining({ id: 'github_git_read' }),
        ]),
      })
    );
    expect(
      WorkerSandboxAccessSchema.parse({
        network: [
          {
            binaries: ['/usr/bin/curl'],
            host: 'fcdn.example.com',
            id: 'normal_fc_domain',
            port: 443,
            purpose: 'Normal public host',
          },
        ],
      })
    ).toMatchObject({
      network: [expect.objectContaining({ host: 'fcdn.example.com' })],
    });
  });

  it('rejects ambiguous or unsupported exact worker sandbox REST rules', () => {
    const base = {
      binaries: ['/usr/bin/git'],
      host: 'github.com',
      id: 'github_git_read',
      port: 443,
      protocol: 'rest',
      purpose: 'Clone and fetch Git repositories',
      rules: [{ method: 'GET', path: '/**/info/refs*' }],
    };

    expect(() =>
      WorkerSandboxAccessSchema.parse({
        network: [{ ...base, access: 'read-only' }],
      })
    ).toThrow();
    expect(() =>
      WorkerSandboxAccessSchema.parse({
        network: [{ ...base, protocol: 'https' }],
      })
    ).toThrow();
    for (const rules of [
      [{ method: 'DELETE', path: '/repo' }],
      [{ method: 'GET', path: 'relative/path' }],
      [{ method: 'GET', path: '/repo\nreceive-pack' }],
      [],
    ]) {
      expect(() =>
        WorkerSandboxAccessSchema.parse({
          network: [{ ...base, rules }],
        })
      ).toThrow();
    }
  });

  it('rejects unsafe worker sandbox access declarations', () => {
    expect(() =>
      WorkerSandboxAccessSchema.parse({
        network: [
          {
            host: '*.example.com',
            id: 'wildcard',
            port: 443,
            purpose: 'Wildcard egress',
          },
        ],
      })
    ).toThrow();

    expect(() =>
      WorkerSandboxAccessSchema.parse({
        network: [
          {
            host: '10.0.0.1',
            id: 'private_ip',
            port: 443,
            purpose: 'Private egress',
          },
        ],
      })
    ).toThrow();

    expect(() =>
      WorkerSandboxAccessSchema.parse({
        filesystem: [
          {
            access: 'read-write',
            id: 'server_data',
            purpose: 'Server data',
            targetPath: '/openkit/server/data',
          },
        ],
      })
    ).toThrow();

    expect(() =>
      WorkerSandboxAccessSchema.parse({
        filesystem: [
          {
            access: 'read-write',
            id: 'core_config',
            purpose: 'Core config',
            targetPath: '/openkit/config',
          },
        ],
      })
    ).toThrow();

    expect(() =>
      WorkerSandboxAccessSchema.parse({
        network: [
          {
            host: '::1',
            id: 'ipv6_loopback',
            port: 443,
            purpose: 'IPv6 loopback egress',
          },
        ],
      })
    ).toThrow();

    expect(() =>
      WorkerSandboxAccessSchema.parse({
        network: [
          {
            host: '[::1]',
            id: 'bracketed_ipv6_loopback',
            port: 443,
            purpose: 'Bracketed IPv6 loopback egress',
          },
        ],
      })
    ).toThrow();

    expect(() =>
      WorkerSandboxAccessSchema.parse({
        network: [
          {
            host: 'fd00::1',
            id: 'ipv6_unique_local',
            port: 443,
            purpose: 'IPv6 private egress',
          },
        ],
      })
    ).toThrow();
  });

  it('accepts worker credential access declarations for provider, runtime file, and runtime env', () => {
    expect(
      AgentEnvironmentCredentialDeclarationSchema.parse({
        id: 'foo_api',
        provider: {
          credentialKey: 'FOO_API_KEY',
          instanceId: 'provider_foo_api',
          profileId: 'okp-local-foo-api-v1',
          type: 'generic',
        },
        vaultGrantId: 'grant_foo_api',
        visibility: 'sandbox-provider',
      })
    ).toMatchObject({ id: 'foo_api', visibility: 'sandbox-provider' });

    expect(
      AgentEnvironmentCredentialDeclarationSchema.parse({
        id: 'bar_config',
        targetPath: '/sandbox/.config/bar/credentials.json',
        vaultGrantId: 'grant_bar_config',
        visibility: 'runtime-file',
      })
    ).toMatchObject({ targetPath: '/sandbox/.config/bar/credentials.json' });

    expect(
      AgentEnvironmentCredentialDeclarationSchema.parse({
        id: 'legacy_cli_key',
        targetEnvVarName: 'LEGACY_API_KEY',
        vaultGrantId: 'grant_legacy_cli_key',
        visibility: 'runtime-env',
      })
    ).toMatchObject({ targetEnvVarName: 'LEGACY_API_KEY' });
  });

  it('rejects malformed worker credential access declarations', () => {
    expect(() =>
      AgentEnvironmentCredentialDeclarationSchema.parse({
        id: 'missing_provider',
        vaultGrantId: 'grant_missing_provider',
        visibility: 'sandbox-provider',
      })
    ).toThrow();

    expect(() =>
      AgentEnvironmentCredentialDeclarationSchema.parse({
        id: 'old_provider_name',
        provider: {
          credentialKey: 'OLD_API_KEY',
          instanceId: 'provider_old_api',
          profileId: 'okp-local-old-api-v1',
          type: 'generic',
        },
        vaultGrantId: 'grant_old_api',
        visibility: 'openshell-provider-proxy',
      })
    ).toThrow();

    expect(() =>
      AgentEnvironmentCredentialDeclarationSchema.parse({
        id: 'relative_file',
        targetPath: 'relative/path.json',
        vaultGrantId: 'grant_relative_file',
        visibility: 'runtime-file',
      })
    ).toThrow();

    expect(() =>
      AgentEnvironmentCredentialDeclarationSchema.parse({
        id: 'bad_env',
        targetEnvVarName: 'bad-env',
        vaultGrantId: 'grant_bad_env',
        visibility: 'runtime-env',
      })
    ).toThrow();

    expect(() =>
      AgentEnvironmentCredentialDeclarationSchema.parse({
        id: 'inline_secret',
        token: 'ghp_inline_secret',
        vaultGrantId: 'grant_inline_secret',
        visibility: 'runtime-env',
        targetEnvVarName: 'INLINE_SECRET',
      })
    ).toThrow();
  });

  it('rejects duplicate worker credential declaration ids and targets in package snapshots', () => {
    const packageFixture = openshellPackageFixture();

    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...packageFixture,
        credentials: {
          declarations: [
            {
              id: 'dup',
              targetEnvVarName: 'DUPLICATE_SECRET',
              vaultGrantId: 'grant_one',
              visibility: 'runtime-env',
            },
            {
              id: 'dup',
              targetEnvVarName: 'OTHER_SECRET',
              vaultGrantId: 'grant_two',
              visibility: 'runtime-env',
            },
          ],
        },
      })
    ).toThrow();

    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...packageFixture,
        credentials: {
          declarations: [
            {
              id: 'one',
              targetPath: '/sandbox/.config/shared.json',
              vaultGrantId: 'grant_one',
              visibility: 'runtime-file',
            },
            {
              id: 'two',
              targetPath: '/sandbox/.config/shared.json',
              vaultGrantId: 'grant_two',
              visibility: 'runtime-file',
            },
          ],
        },
      })
    ).toThrow();
  });

  it('accepts a NanoHost-targeted package with fail-closed local Integration bindings', () => {
    const parsed = AgentEnvironmentPackageSchema.parse(openshellPackageFixture());

    expect(parsed.control).toMatchObject({
      mode: 'sandbox-integration',
      bindings: {
        capabilities: {
          pathPrefix: '/capabilities/',
          tokenRef: 'runtime://openkit/capability-token',
        },
        inference: {
          pathPrefix: '/inference/',
          tokenRef: 'runtime://openkit/inference-token',
        },
        workerControl: {
          pathPrefix: '/worker-control/',
          tokenRef: 'runtime://openkit/worker-control-token',
        },
      },
      channels: {
        artifacts: 'batch',
        events: 'batch',
      },
      commands: ['interrupt'],
    });
    expect(parsed.control).not.toHaveProperty('endpoint');
    expect(parsed.control).not.toHaveProperty('auth');
    expect(parsed.control.transcript?.itemsPath).toBe('/openkit/session/items.jsonl');
    expect(parsed.supply.skills[0]).toMatchObject({
      id: 'repo-guidelines',
      reviewStatus: 'approved',
      materialization: { kind: 'filesystem-copy' },
    });
    expect(parsed.supply.mcpServers[0]).toMatchObject({
      id: 'github',
      allowedTools: ['repos.get', 'issues.list'],
      approvalRequiredTools: ['issues.list'],
      catalogDigest: `sha256:${'a'.repeat(64)}`,
      schemaPolicy: 'tracking',
    });
    expect(parsed.capabilities).toEqual({
      mode: 'disabled',
      protocol: 'openkit-worker-capability-v1',
      routes: [],
    });
    expect(parsed.llm.routes[0]?.endpoint).not.toHaveProperty('workerBaseUrl');
    expect(parsed.policy.snapshotId).toBe('worker_turn_launch_policy');
  });

  it('requires a nonempty runtime-owned list of absolute binaries', () => {
    const fixture = openshellPackageFixture() as Record<string, unknown>;
    const runtime = fixture.runtime as Record<string, unknown>;
    const policy = fixture.policy as Record<string, unknown>;
    const network = policy.network as Record<string, unknown>;
    const runtimeWithoutBinaries = { ...runtime };
    delete runtimeWithoutBinaries.binaries;

    expect
      .soft(
        [runtimeWithoutBinaries, { ...runtime, binaries: [] }].every(
          (candidate) => !AgentEnvironmentRuntimeSchema.safeParse(candidate).success
        )
      )
      .toBe(true);
    expect
      .soft(AgentEnvironmentBinarySchema.safeParse({ id: 'codex', path: 'codex' }).success)
      .toBe(false);
    expect
      .soft(
        AgentEnvironmentPackageSchema.safeParse({
          ...fixture,
          policy: {
            ...policy,
            network: {
              ...network,
              rules: [
                {
                  action: 'allow',
                  binaries: ['/usr/bin/undeclared'],
                  host: 'github.com',
                  id: 'github-read',
                  port: 443,
                  protocol: 'rest',
                  rules: [{ method: 'GET', path: '/**' }],
                },
              ],
            },
          },
        }).success
      )
      .toBe(false);
  });

  it('accepts only the fixed generic shim command', () => {
    const command = {
      argv: ['openkit-worker-shim'],
      workingDirectory: '/workspace/repo',
    };

    expect(
      AgentEnvironmentRuntimeCommandSchema.safeParse({
        ...command,
        argv: ['codex', 'exec'],
      }).success
    ).toBe(false);
  });

  it('rejects runtime-specific control adapter kinds', () => {
    const control = (openshellPackageFixture() as Record<string, unknown>).control as Record<
      string,
      unknown
    >;
    const adapter = control.adapter as Record<string, unknown>;

    expect(
      AgentEnvironmentControlAdapterSchema.safeParse({
        ...adapter,
        kind: 'openkit-codex-shim',
      }).success
    ).toBe(false);
  });

  it('requires a nonempty uniquely identified resolved LLM route list', () => {
    const llm = (openshellPackageFixture() as Record<string, unknown>).llm as {
      routes: unknown[];
    };

    for (const routes of [[], [llm.routes[0], llm.routes[0]]]) {
      expect(AgentEnvironmentLlmSchema.safeParse({ ...llm, routes }).success).toBe(false);
    }
    expect(
      AgentEnvironmentLlmSchema.safeParse({
        ...llm,
        routes: [
          llm.routes[0],
          { ...(llm.routes[0] as object), id: 'alternate', model: 'alternate-model' },
        ],
      }).success
    ).toBe(true);
  });

  it('accepts only local Integration gateway inference coherence', () => {
    const endpoint = { kind: 'openai-compatible', upstream: { kind: 'nanocore-gateway' } };
    const route = {
      credentialVisibility: 'placeholder',
      endpoint,
      id: 'default',
      model: 'gpt-5',
      providerInstanceId: 'provider',
    };

    expect
      .soft(
        AgentEnvironmentLlmSchema.safeParse({
          mode: 'gateway',
          preferredLogicalModelId: 'gpt-5',
          routes: [route],
        }).success
      )
      .toBe(true);

    for (const invalidRoute of [
      { ...route, credentialVisibility: 'environment' },
      { ...route, endpoint: { ...endpoint, kind: 'provider-compatible' } },
      { ...route, endpoint: { ...endpoint, upstream: { kind: 'direct-provider' } } },
      { ...route, endpoint: { ...endpoint, workerBaseUrl: 'https://nanocore.local' } },
    ]) {
      expect
        .soft(
          AgentEnvironmentLlmSchema.safeParse({
            mode: 'gateway',
            preferredLogicalModelId: 'gpt-5',
            routes: [invalidRoute],
          }).success
        )
        .toBe(false);
    }
    for (const mode of ['direct-external', 'backend-local']) {
      expect
        .soft(
          AgentEnvironmentLlmSchema.safeParse({
            mode,
            preferredLogicalModelId: 'gpt-5',
            routes: [route],
          }).success
        )
        .toBe(false);
    }
  });

  it('rejects runtime binary and native argv authority in supply', () => {
    for (const supply of [
      {
        binaries: [{ id: 'git', path: '/usr/bin/git' }],
        mcpServers: [],
        services: [],
        skills: [],
      },
      {
        mcpServers: [{ command: ['github-mcp-server'], id: 'github', transport: 'stdio' }],
        services: [],
        skills: [],
      },
    ]) {
      expect.soft(AgentEnvironmentSupplySchema.safeParse(supply).success).toBe(false);
    }
  });

  it.each([
    'direct-nanocore',
    'transcript-sink',
    'backend-relay',
    'sidecar',
    'stdio',
    'disabled',
  ])('rejects retired worker control mode %s', (mode) => {
    const fixture = openshellPackageFixture() as Record<string, unknown>;
    const control = fixture.control as Record<string, unknown>;

    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...fixture,
        control: { ...control, mode },
      })
    ).toThrow();
  });

  it.each(['sidecar', 'direct-nanocore'])('rejects retired worker capability mode %s', (mode) => {
    const fixture = openshellPackageFixture() as Record<string, unknown>;

    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...fixture,
        capabilities: {
          protocol: 'openkit-worker-capability-v1',
          mode,
          endpoint: {
            baseUrl: 'https://nanocore.local/api/worker-capabilities',
            implementation: 'direct-nanocore',
            kind: 'direct-url',
            required: true,
          },
          auth: {
            credentialVisibility: 'environment',
            kind: 'sandbox-session-token',
            tokenRef: 'runtime://openkit/control-token',
          },
          routes: [],
        },
      })
    ).toThrow();
  });

  it('accepts worker-control and rejects retired backend control capabilities', () => {
    const backend = {
      capabilities: ['worker-control'],
      dynamicCapabilities: [],
      kind: 'openshell',
    };

    expect(WorkerGovernanceBackendCapabilitiesSchema.parse(backend).capabilities).toEqual([
      'worker-control',
    ]);
    for (const capability of [
      'control-relay',
      'sidecar-control-endpoint',
      'sidecar-capability-endpoint',
      'generic-local-endpoint-relay',
    ]) {
      expect(() =>
        WorkerGovernanceBackendCapabilitiesSchema.parse({
          ...backend,
          capabilities: [capability],
        })
      ).toThrow();
    }
  });

  it('accepts interrupt as the only worker-control command', () => {
    const fixture = openshellPackageFixture() as Record<string, unknown>;
    const control = fixture.control as Record<string, unknown>;

    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...fixture,
        control: { ...control, commands: ['interrupt'] },
      })
    ).not.toThrow();
    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...fixture,
        control: { ...control, commands: ['interrupt', 'terminal-command'] },
      })
    ).toThrow();
    expect(OPENKIT_WORKER_CONTROL_POST_PATHS).not.toContain('/api/worker-control/terminal-results');
    expect(OPENKIT_WORKER_CONTROL_POST_PATHS).not.toContain(
      '/api/worker-control/knowledge-proposal-summary'
    );
  });

  it('rejects false local Integration control declarations', () => {
    const fixture = openshellPackageFixture() as Record<string, unknown>;
    const control = fixture.control as Record<string, unknown>;
    const bindings = control.bindings as Record<string, Record<string, unknown>>;
    const channels = control.channels as Record<string, unknown>;
    const adapter = control.adapter as Record<string, unknown>;
    const invalidControls = [
      { ...control, transcript: undefined },
      { ...control, bindings: undefined },
      {
        ...control,
        bindings: {
          ...bindings,
          workerControl: { ...bindings.workerControl, pathPrefix: '/wrong/' },
        },
      },
      {
        ...control,
        bindings: {
          ...bindings,
          inference: {
            ...bindings.inference,
            tokenRef: bindings.workerControl?.tokenRef,
          },
        },
      },
      { ...control, endpoint: { baseUrl: 'https://nanocore.local/api/worker-control' } },
      { ...control, auth: { tokenRef: 'runtime://openkit/raw-control-token' } },
      { ...control, channels: undefined },
      { ...control, channels: { ...channels, commands: false } },
      { ...control, channels: { ...channels, heartbeats: false } },
      { ...control, commands: ['interrupt', 'terminal-command', 'approval-result'] },
      { ...control, channels: { ...channels, events: 'live' } },
      { ...control, channels: { ...channels, artifacts: 'live' } },
      { ...control, adapter: undefined },
      { ...control, adapter: { ...adapter, targetTransport: 'stdio' } },
    ];

    for (const invalidControl of invalidControls) {
      expect(() =>
        AgentEnvironmentPackageSchema.parse({ ...fixture, control: invalidControl })
      ).toThrow();
    }
  });

  it('rejects endpoint, auth, and routes when worker capabilities are disabled', () => {
    const fixture = openshellPackageFixture() as Record<string, unknown>;
    const capabilities = fixture.capabilities as Record<string, unknown>;
    const invalidCapabilities = [
      {
        ...capabilities,
        endpoint: {
          baseUrl: 'https://nanocore.local/api/worker-capabilities',
          implementation: 'direct-nanocore',
          kind: 'direct-url',
          required: true,
        },
      },
      {
        ...capabilities,
        auth: {
          credentialVisibility: 'environment',
          kind: 'sandbox-session-token',
          tokenRef: 'runtime://sandbox-session-token',
        },
      },
      {
        ...capabilities,
        routes: [
          {
            family: 'knowledge.search',
            path: '/knowledge/search',
            policyRefId: 'policy_knowledge_read',
          },
        ],
      },
    ];

    for (const invalidCapability of invalidCapabilities) {
      expect(() =>
        AgentEnvironmentPackageSchema.parse({ ...fixture, capabilities: invalidCapability })
      ).toThrow();
    }
  });

  it('accepts only the exact enabled MCP route set with selected server supply', () => {
    const fixture = openshellPackageFixture();
    const enabled = {
      mode: 'enabled',
      protocol: 'openkit-worker-capability-v1',
      routes: ['mcp.list_servers', 'mcp.list_tools', 'mcp.call_tool'],
    };

    expect(
      AgentEnvironmentPackageSchema.parse({ ...fixture, capabilities: enabled }).capabilities
    ).toEqual(enabled);
    for (const routes of [
      [],
      ['mcp.list_servers', 'mcp.call_tool'],
      ['mcp.list_servers', 'mcp.list_tools', 'mcp.call_tool', 'knowledge.read'],
    ]) {
      expect(() =>
        AgentEnvironmentPackageSchema.parse({
          ...fixture,
          capabilities: { ...enabled, routes },
        })
      ).toThrow();
    }
    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...fixture,
        capabilities: enabled,
        supply: { ...fixture.supply, mcpServers: [] },
      })
    ).toThrow();
  });

  it('accepts manifest-authored network grants with a placeholder-backed trusted inference route', () => {
    const fixture = trustedWorkerInferenceRelayPackageFixture();
    const policy = fixture.policy as Record<string, unknown>;
    const networkRule = {
      action: 'allow',
      binaries: ['/usr/bin/git'],
      host: 'github.com',
      id: 'github-git-read',
      port: 443,
      protocol: 'rest',
      purpose: 'Clone and fetch Git repositories',
      rules: [
        { method: 'GET', path: '/**/info/refs*' },
        { method: 'POST', path: '/**/git-upload-pack' },
      ],
      scope: 'session',
    };
    const parsed = AgentEnvironmentPackageSchema.parse({
      ...fixture,
      policy: {
        ...policy,
        network: {
          default: 'deny',
          enforcement: 'openshell',
          rules: [networkRule],
        },
      },
    });

    expect(parsed.backend.requiredCapabilities).toContain('trusted-worker-inference-relay');
    expect(parsed.llm.routes).toEqual([
      expect.objectContaining({
        credentialVisibility: 'placeholder',
        endpoint: expect.objectContaining({
          upstream: expect.objectContaining({ kind: 'nanocore-gateway' }),
        }),
      }),
    ]);
    expect(parsed.llm.routes[0]?.endpoint).not.toHaveProperty('workerBaseUrl');
    expect(parsed.policy.network?.rules).toEqual([networkRule]);

    for (const networkBoundary of [
      { default: 'allow', enforcement: 'openshell' },
      { default: 'deny', enforcement: 'none' },
    ]) {
      expect(() =>
        AgentEnvironmentPackageSchema.parse({
          ...fixture,
          policy: {
            ...policy,
            network: { ...networkBoundary, rules: [networkRule] },
          },
        })
      ).toThrow();
    }

    const control = fixture.control as { adapter: { targetRuntime: string } };
    const runtime = fixture.runtime as {
      binaries: Array<{ id: string; path: string }>;
    };
    for (const binaryId of [
      control.adapter.targetRuntime,
      `${control.adapter.targetRuntime}-native`,
    ]) {
      const binary = runtime.binaries.find((candidate) => candidate.id === binaryId);
      if (!binary) {
        throw new Error(`Trusted inference fixture is missing runtime binary: ${binaryId}`);
      }

      expect(
        () =>
          AgentEnvironmentPackageSchema.parse({
            ...fixture,
            policy: {
              ...policy,
              network: {
                default: 'deny',
                enforcement: 'openshell',
                rules: [{ ...networkRule, binaries: [binary.path] }],
              },
            },
          }),
        `expected declared external network rule for ${binaryId} to be accepted`
      ).not.toThrow();
    }
  });

  it('accepts bounded runtime provenance outputs behind the trusted relay feature', () => {
    const parsed = AgentEnvironmentPackageSchema.parse(runtimeProvenancePackageFixture());

    expect(WORKER_RUNTIME_PROVENANCE_FEATURE).toBe('worker.runtime-provenance.v1');
    expect(WORKER_RUNTIME_PROVENANCE_FEATURE).toBe(WORKER_PROTOCOL_RUNTIME_PROVENANCE_FEATURE);
    expect(parsed.backend.requiredCapabilities).toContain(WORKER_RUNTIME_PROVENANCE_FEATURE);
    expect(parsed.control.transcript?.runtimeProvenance).toEqual({
      rawStreamsRoot: '/openkit/session/runtime/raw',
      streamManifestPath: '/openkit/session/runtime/raw-streams.json',
      nativeOriginIndexPath: '/openkit/session/runtime/native-origin-index.jsonl',
      maxTotalBytes: 268_435_456,
      maxStreamCount: 64,
    });
  });

  it('requires runtime provenance declarations and the trusted inference relay together', () => {
    const missingDeclaration = runtimeProvenancePackageFixture();
    const missingControl = missingDeclaration.control as Record<string, unknown>;
    const missingTranscript = missingControl.transcript as Record<string, unknown>;
    const { runtimeProvenance: _runtimeProvenance, ...transcriptWithoutProvenance } =
      missingTranscript;
    const missingRelay = runtimeProvenancePackageFixture();
    const missingRelayBackend = missingRelay.backend as Record<string, unknown>;

    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...missingDeclaration,
        control: { ...missingControl, transcript: transcriptWithoutProvenance },
      })
    ).toThrow();

    const declarationWithoutFeature = trustedWorkerInferenceRelayPackageFixture();
    const declarationControl = declarationWithoutFeature.control as Record<string, unknown>;
    const declarationTranscript = declarationControl.transcript as Record<string, unknown>;
    const sourceRuntimeProvenance = (
      (runtimeProvenancePackageFixture().control as Record<string, unknown>).transcript as Record<
        string,
        unknown
      >
    ).runtimeProvenance;

    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...declarationWithoutFeature,
        control: {
          ...declarationControl,
          transcript: {
            ...declarationTranscript,
            runtimeProvenance: sourceRuntimeProvenance,
          },
        },
      })
    ).toThrow();
    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...missingRelay,
        backend: {
          ...missingRelayBackend,
          requiredCapabilities: (missingRelayBackend.requiredCapabilities as string[]).filter(
            (feature) => feature !== 'trusted-worker-inference-relay'
          ),
        },
      })
    ).toThrow();
  });

  it('rejects invalid runtime provenance paths and non-positive limits', () => {
    const fixture = runtimeProvenancePackageFixture();
    const control = fixture.control as Record<string, unknown>;
    const transcript = control.transcript as Record<string, unknown>;
    const runtimeProvenance = transcript.runtimeProvenance as Record<string, unknown>;

    for (const override of [
      { rawStreamsRoot: '/tmp/runtime/raw' },
      { streamManifestPath: '../raw-streams.json' },
      { nativeOriginIndexPath: '/openkit/session/native-origin-index.jsonl' },
      { maxTotalBytes: 0 },
      { maxStreamCount: -1 },
    ]) {
      expect(() =>
        AgentEnvironmentPackageSchema.parse({
          ...fixture,
          control: {
            ...control,
            transcript: {
              ...transcript,
              runtimeProvenance: { ...runtimeProvenance, ...override },
            },
          },
        })
      ).toThrow();
    }

    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...fixture,
        control: {
          ...control,
          transcript: {
            ...transcript,
            root: '/different/session',
          },
        },
      })
    ).toThrow();
  });

  it('reports missing backend runtime provenance capability through existing negotiation', () => {
    const parsed = AgentEnvironmentPackageSchema.parse(runtimeProvenancePackageFixture());
    const backend = WorkerGovernanceBackendCapabilitiesSchema.parse({
      kind: 'openshell',
      capabilities: parsed.backend.requiredCapabilities.filter(
        (capability) => capability !== WORKER_RUNTIME_PROVENANCE_FEATURE
      ),
      dynamicCapabilities: [],
      version: '0.0.80',
    });

    expect(validateAgentEnvironmentPackageForBackend(parsed, backend)).toContainEqual(
      expect.objectContaining({
        code: 'backend_missing_required_capability',
        message: expect.stringContaining(WORKER_RUNTIME_PROVENANCE_FEATURE),
      })
    );
  });

  it('rejects bypassable routes when trusted worker inference is required', () => {
    const fixture = trustedWorkerInferenceRelayPackageFixture();
    const llm = fixture.llm as { routes: Array<Record<string, unknown>> };
    const route = llm.routes[0] as Record<string, unknown>;
    const endpoint = route.endpoint as Record<string, unknown>;

    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...fixture,
        llm: {
          ...llm,
          routes: [
            {
              ...route,
              endpoint: { ...endpoint, workerBaseUrl: 'https://inference.local/v1' },
            },
          ],
        },
      })
    ).toThrow();
    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...fixture,
        llm: { ...llm, routes: [{ ...route, credentialVisibility: 'none' }] },
      })
    ).toThrow();
    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...fixture,
        llm: {
          ...llm,
          routes: [
            {
              ...route,
              endpoint: { ...endpoint, upstream: { kind: 'direct-provider' } },
            },
          ],
        },
      })
    ).toThrow();
    for (const kind of ['provider-compatible', 'backend-local'] as const) {
      expect(() =>
        AgentEnvironmentPackageSchema.parse({
          ...fixture,
          llm: {
            ...llm,
            routes: [
              {
                ...route,
                endpoint: { ...endpoint, kind },
              },
            ],
          },
        })
      ).toThrow();
    }
  });

  it('allows governed tool credentials alongside trusted worker inference', () => {
    const fixture = trustedWorkerInferenceRelayPackageFixture();
    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...fixture,
        credentials: {
          declarations: [
            {
              id: 'github_runtime_env',
              targetEnvVarName: 'GITHUB_TOKEN',
              vaultGrantId: 'grant_github_runtime_env',
              visibility: 'runtime-env',
            },
          ],
        },
        vault: {
          grants: [
            {
              id: 'grant_github_runtime_env',
              scope: 'agent-session',
              vaultRefId: 'vault_github_runtime_env',
            },
          ],
          references: [
            {
              id: 'vault_github_runtime_env',
              kind: 'secret-ref',
              secretRef: 'vault://workspace/github',
            },
          ],
        },
      })
    ).not.toThrow();
  });

  it('requires trusted worker inference routes to match one gateway provider and model', () => {
    const fixture = trustedWorkerInferenceRelayPackageFixture();
    const llm = fixture.llm as { routes: Array<Record<string, unknown>> };
    const route = llm.routes[0] as Record<string, unknown>;

    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...fixture,
        llm: {
          ...llm,
          routes: [{ ...route, providerInstanceId: 'missing-provider' }],
        },
      })
    ).toThrow();
    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...fixture,
        llm: {
          ...llm,
          routes: [{ ...route, model: 'openai/unbound-model' }],
        },
      })
    ).toThrow();
  });

  it('rejects direct NanoCore inference and worker-control endpoints', () => {
    const fixture = trustedWorkerInferenceRelayPackageFixture();
    const llm = fixture.llm as { routes: Array<Record<string, unknown>> };
    const route = llm.routes[0] as Record<string, unknown>;
    const endpoint = route.endpoint as Record<string, unknown>;
    const control = fixture.control as Record<string, unknown>;
    const policy = fixture.policy as Record<string, unknown>;
    const network = policy.network as { rules: Array<Record<string, unknown>> };

    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...fixture,
        llm: {
          ...llm,
          routes: [
            { ...route, endpoint: { ...endpoint, workerBaseUrl: 'https://nanocore.local' } },
          ],
        },
      })
    ).toThrow();
    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...fixture,
        control: { ...control, endpoint: { baseUrl: 'https://nanocore.local' } },
      })
    ).toThrow();
    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...fixture,
        policy: {
          ...policy,
          network: {
            ...network,
            rules: [
              {
                action: 'allow',
                binaries: ['/usr/local/bin/openkit-worker-shim'],
                host: 'nanocore.local',
                id: 'direct-nanocore-worker-control',
                port: 443,
                protocol: 'rest',
                rules: [{ method: 'POST', path: '/api/worker-control/heartbeat' }],
              },
            ],
          },
        },
      })
    ).toThrow();
  });

  it('rejects host backend capabilities and host runtime images', () => {
    expect(() =>
      WorkerGovernanceBackendCapabilitiesSchema.parse({
        kind: 'host',
        capabilities: ['host-process', 'stdio-control'],
        dynamicCapabilities: [],
      })
    ).toThrow();

    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...openshellPackageFixture(),
        runtime: {
          ...(openshellPackageFixture() as { runtime: Record<string, unknown> }).runtime,
          image: {
            kind: 'host-binary',
            ref: 'codex',
          },
        },
      })
    ).toThrow();
  });

  it('rejects unknown top-level fields and raw secret-bearing fields', () => {
    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...openshellPackageFixture(),
        backendContainerId: 'container_private',
      })
    ).toThrow();

    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...openshellPackageFixture(),
        providers: {},
      })
    ).toThrow();
  });

  it('preserves the canonical control token reference while redacting private runtime references and host paths', () => {
    const parsed = AgentEnvironmentPackageSchema.parse({
      ...openshellPackageFixture(),
      runtime: {
        ...(openshellPackageFixture() as { runtime: Record<string, unknown> }).runtime,
        command: {
          argv: ['openkit-worker-shim'],
          workingDirectory: '/Users/m5pro/Documents/AI/openkit',
        },
      },
      workspace: {
        ...(openshellPackageFixture() as { workspace: Record<string, unknown> }).workspace,
        root: '/Users/m5pro/Documents/AI/openkit',
      },
    });

    const redacted = redactAgentEnvironmentPackageSnapshot(parsed);
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain('runtime://nanocore/v1');
    expect(serialized).not.toContain('/Users/m5pro');
    expect(redacted.control.bindings).toEqual(parsed.control.bindings);
    expect(redacted.capabilities).toEqual({
      mode: 'disabled',
      protocol: 'openkit-worker-capability-v1',
      routes: [],
    });
    expect(redacted.runtime.command.workingDirectory).toBe('[redacted:host-path]');
  });

  it('reports unsupported backend capabilities before worker launch', () => {
    const parsed = AgentEnvironmentPackageSchema.parse(openshellPackageFixture());
    const backend = WorkerGovernanceBackendCapabilitiesSchema.parse({
      kind: 'openshell',
      capabilities: ['container', 'network-policy', 'audit-export'],
      dynamicCapabilities: [],
    });

    const diagnostics = validateAgentEnvironmentPackageForBackend(parsed, backend);

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'backend_missing_required_capability',
          message: expect.stringContaining('transcript-sink'),
        }),
        expect.objectContaining({
          code: 'backend_missing_required_capability',
          message: expect.stringContaining('worker-control'),
        }),
        expect.objectContaining({
          code: 'backend_missing_required_capability',
          message: expect.stringContaining('provider-attachments'),
        }),
        expect.objectContaining({
          code: 'backend_missing_required_capability',
          message: expect.stringContaining('nanocore-inference-upstream'),
        }),
      ])
    );
  });

  it('rejects retired remote Gateway backend selection', () => {
    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...openshellPackageFixture(),
        backend: {
          allowedKinds: ['openshell'],
          extensions: { gatewayUrlRef: 'runtime://openshell/gateway-url', placement: 'remote' },
          preferred: 'openshell',
          requiredCapabilities: ['container', 'remote-gateway'],
        },
      })
    ).toThrow();
  });

  it('rejects sandbox-local sidecar control as the canonical worker control channel', () => {
    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...openshellPackageFixture(),
        control: {
          ...(openshellPackageFixture() as { control: Record<string, unknown> }).control,
          endpoint: {
            kind: 'sandbox-local-https',
            baseUrl: 'https://control.local/v1/worker-control',
            required: true,
            implementation: 'openkit-sidecar',
          },
        },
      })
    ).toThrow();
  });
});

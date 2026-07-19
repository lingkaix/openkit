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
 * Creates a valid OpenShell-targeted package fixture with direct NanoCore control.
 *
 * @returns Agent environment package fixture.
 */
function openshellPackageFixture(): unknown {
  return {
    schemaVersion: 2,
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
      profileKind: 'coder',
      instructions: [],
      capabilityRequests: ['llm', 'shell', 'filesystem', 'network', 'artifacts'],
    },
    runtime: {
      image: {
        kind: 'container-image',
        ref: 'ghcr.io/openkit/codex-worker:2026-06-16',
        digest: 'sha256:demo',
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
        argv: ['openkit-worker-shim', '--package', '/openkit/config/package.json'],
        workingDirectory: '/workspace/repo',
        stdin: 'pipe',
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
        staleWhenPackageChanges: true,
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
          version: '1.0.0',
          sourceRef: 'server:mcp/github',
          allowedTools: ['repos.get', 'issues.list'],
          approvalRequiredTools: ['issues.list'],
          toolSchemas: [
            {
              inputSchema: {
                additionalProperties: false,
                properties: {
                  owner: { type: 'string' },
                  repo: { type: 'string' },
                },
                required: ['owner', 'repo'],
                type: 'object',
              },
              name: 'repos.get',
            },
            {
              inputSchema: {
                additionalProperties: false,
                properties: {
                  owner: { type: 'string' },
                  repo: { type: 'string' },
                },
                required: ['owner', 'repo'],
                type: 'object',
              },
              name: 'issues.list',
            },
          ],
          allowedPrompts: [],
          allowedRuntimeAdapters: ['codex'],
          allowedWorkspaceScopes: ['workspace'],
          integrity: { sha256: 'sha256-github-mcp-v1' },
          reviewStatus: 'approved',
        },
      ],
      services: [],
    },
    control: {
      protocol: 'openkit-worker-control-v1',
      mode: 'direct-nanocore',
      transcript: {
        root: '/openkit/session',
        eventsPath: '/openkit/session/events.jsonl',
        itemsPath: '/openkit/session/items.jsonl',
        artifactsPath: '/openkit/session/artifacts.jsonl',
        flush: 'line',
        import: 'turn-end',
        required: true,
      },
      endpoint: {
        kind: 'direct-url',
        baseUrl: 'https://nanocore.local/api/worker-control',
        required: true,
        implementation: 'direct-nanocore',
      },
      auth: {
        kind: 'sandbox-session-token',
        tokenRef: 'runtime://openkit/control-token',
        credentialVisibility: 'environment',
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
        targetTransport: 'outbound-https',
      },
    },
    capabilities: {
      protocol: 'openkit-worker-capability-v1',
      mode: 'disabled',
      routes: [],
    },
    providers: {
      providerProfiles: [
        {
          id: 'github-read',
          displayName: 'GitHub Read',
          kind: 'oauth',
          models: ['github/api'],
          category: 'repository',
        },
      ],
      providerInstances: [
        {
          id: 'provider_github_read',
          profileId: 'github-read',
          vendor: 'github',
          displayName: 'GitHub Read',
          kind: 'oauth',
          models: ['github/api'],
          vaultRefIds: ['vault_github_read'],
        },
      ],
      attachments: [
        {
          id: 'attach_github_read',
          providerInstanceId: 'provider_github_read',
          vaultGrantIds: ['grant_github_read'],
          binaryIds: ['git'],
          policyContributionIds: ['github-read-network'],
        },
      ],
    },
    vault: {
      references: [
        {
          id: 'vault_github_read',
          providerInstanceId: 'provider_github_read',
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
      routes: [
        {
          id: 'default-openai',
          providerInstanceId: 'provider_openai_default',
          model: 'gpt-5',
          endpoint: {
            kind: 'openai-compatible',
            workerBaseUrl: 'https://inference.local/v1',
            upstream: {
              kind: 'nanocore-gateway',
              baseUrlRef: 'runtime://nanocore/v1',
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
      allowedKinds: ['openshell', 'docker'],
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
      routes: [
        {
          credentialVisibility: 'placeholder',
          endpoint: {
            kind: 'openai-compatible',
            upstream: {
              baseUrlRef: 'runtime://nanocore/worker-inference/v1',
              kind: 'nanocore-gateway',
            },
            workerBaseUrl: 'http://nanocore.internal/api/worker-inference/v1',
          },
          id: 'worker-inference',
          model: 'openai/gpt-5.2',
          providerInstanceId: 'agent-openrouter',
        },
      ],
    },
    policy: {
      ...policy,
      inference: { mode: 'gateway' },
      network: {
        default: 'deny',
        enforcement: 'openshell',
        rules: [
          {
            action: 'allow',
            binaries: ['/usr/local/bin/node', '/usr/local/bin/openkit-worker-shim'],
            host: 'nanocore.local',
            id: 'openkit-worker-control',
            port: 443,
            protocol: 'rest',
            rules: [
              { method: 'POST', path: '/api/worker-control/heartbeat' },
              { method: 'POST', path: '/api/worker-control/artifacts' },
              { method: 'POST', path: '/api/worker-control/commands/poll' },
              { method: 'POST', path: '/api/worker-control/commands/ack' },
              { method: 'POST', path: '/api/worker-control/events/append' },
              { method: 'POST', path: '/api/worker-control/final-status' },
              { method: 'POST', path: '/api/worker-control/supply-refresh-ack' },
              { method: 'POST', path: '/api/worker-control/capability-summary' },
            ],
          },
          {
            action: 'allow',
            binaries: ['/usr/local/bin/codex', '/usr/local/lib/codex/bin/codex'],
            host: 'nanocore.internal',
            id: 'openkit-worker-inference',
            port: 80,
            protocol: 'rest',
            rules: [
              { method: 'POST', path: '/api/worker-inference/v1/chat/completions' },
              { method: 'POST', path: '/api/worker-inference/v1/responses' },
            ],
          },
        ],
      },
    },
    providers: {
      attachments: [],
      providerInstances: [
        {
          displayName: 'OpenRouter',
          id: 'agent-openrouter',
          kind: 'gateway',
          models: ['openai/gpt-5.2'],
          profileId: 'agent-openrouter',
          vendor: 'openrouter',
          vaultRefIds: [],
        },
      ],
      providerProfiles: [
        {
          category: 'model',
          displayName: 'OpenRouter',
          id: 'agent-openrouter',
          kind: 'gateway',
          models: ['openai/gpt-5.2'],
        },
      ],
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
  it('accepts only V2 package scope with one exact trigger actor', () => {
    const fixture = openshellPackageFixture() as Record<string, unknown>;
    const scope = fixture.scope as Record<string, unknown>;
    const parsed = AgentEnvironmentPackageSchema.parse(fixture);

    expect(parsed.schemaVersion).toBe(2);
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
        ],
      })
    ).toMatchObject({
      credentialDeclarations: [expect.objectContaining({ id: 'registry_token' })],
      filesystem: [expect.objectContaining({ id: 'build_cache' })],
      network: [expect.objectContaining({ id: 'npm_registry' })],
    });
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

  it('accepts an OpenShell-targeted package with fail-closed direct NanoCore control', () => {
    const parsed = AgentEnvironmentPackageSchema.parse(openshellPackageFixture());

    expect(parsed.control).toMatchObject({
      mode: 'direct-nanocore',
      endpoint: {
        baseUrl: 'https://nanocore.local/api/worker-control',
        implementation: 'direct-nanocore',
        kind: 'direct-url',
        required: true,
      },
      channels: {
        artifacts: 'batch',
        events: 'batch',
      },
      commands: ['interrupt'],
    });
    expect(parsed.control.relay).toBeUndefined();
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
      reviewStatus: 'approved',
      toolSchemas: [
        {
          name: 'repos.get',
          inputSchema: {
            required: ['owner', 'repo'],
          },
        },
        {
          name: 'issues.list',
          inputSchema: {
            required: ['owner', 'repo'],
          },
        },
      ],
    });
    expect(parsed.capabilities).toEqual({
      mode: 'disabled',
      protocol: 'openkit-worker-capability-v1',
      routes: [],
    });
    expect(parsed.llm.routes[0]?.endpoint.workerBaseUrl).toBe('https://inference.local/v1');
    expect(parsed.policy.snapshotId).toBe('worker_turn_launch_policy');
  });

  it('requires a nonempty runtime-owned list of absolute binaries', () => {
    const fixture = openshellPackageFixture() as Record<string, unknown>;
    const runtime = fixture.runtime as Record<string, unknown>;
    const relayFixture = trustedWorkerInferenceRelayPackageFixture();
    const relayPolicy = relayFixture.policy as Record<string, unknown>;
    const relayNetwork = relayPolicy.network as { rules: Record<string, unknown>[] };
    const [controlRule, inferenceRule] = relayNetwork.rules;
    if (!controlRule || !inferenceRule) {
      throw new Error('Expected the relay fixture to declare control and inference rules.');
    }
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
          ...relayFixture,
          policy: {
            ...relayPolicy,
            network: {
              ...relayNetwork,
              rules: [controlRule, { ...inferenceRule, binaries: ['/usr/bin/undeclared'] }],
            },
          },
        }).success
      )
      .toBe(false);
  });

  it('accepts only the fixed generic shim command', () => {
    const command = {
      argv: ['openkit-worker-shim', '--package', '/openkit/config/package.json'],
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

  it('requires exactly one resolved LLM route for every worker package', () => {
    const llm = (openshellPackageFixture() as Record<string, unknown>).llm as {
      routes: unknown[];
    };

    for (const routes of [[], [llm.routes[0], llm.routes[0]]]) {
      expect(AgentEnvironmentLlmSchema.safeParse({ ...llm, routes }).success).toBe(false);
    }
  });

  it.each([
    ['gateway', 'placeholder', 'openai-compatible', 'nanocore-gateway', true],
    ['direct-external', 'environment', 'provider-compatible', 'direct-provider', false],
    ['backend-local', 'none', 'backend-local', 'backend-local', false],
  ])('enforces %s LLM route coherence', (mode, credentialVisibility, endpointKind, upstreamKind, includesWorkerBaseUrl) => {
    const workerBaseUrl = 'https://nanocore.local/api/worker-inference/v1';
    const endpoint = { kind: endpointKind, upstream: { kind: upstreamKind } };
    const route = {
      credentialVisibility,
      endpoint: includesWorkerBaseUrl ? { ...endpoint, workerBaseUrl } : endpoint,
      id: 'default',
      model: 'gpt-5',
      providerInstanceId: 'provider',
    };

    expect.soft(AgentEnvironmentLlmSchema.safeParse({ mode, routes: [route] }).success).toBe(true);

    for (const invalidRoute of [
      {
        ...route,
        credentialVisibility: mode === 'backend-local' ? 'environment' : 'none',
      },
      {
        ...route,
        endpoint: {
          ...route.endpoint,
          kind: mode === 'gateway' ? 'provider-compatible' : 'openai-compatible',
        },
      },
      {
        ...route,
        endpoint: {
          ...route.endpoint,
          upstream: { kind: mode === 'gateway' ? 'direct-provider' : 'nanocore-gateway' },
        },
      },
      {
        ...route,
        endpoint: includesWorkerBaseUrl ? endpoint : { ...endpoint, workerBaseUrl },
      },
    ]) {
      expect
        .soft(AgentEnvironmentLlmSchema.safeParse({ mode, routes: [invalidRoute] }).success)
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

  it('requires the direct control adapter transport to match the endpoint scheme', () => {
    const fixture = openshellPackageFixture() as Record<string, unknown>;
    const control = fixture.control as Record<string, unknown>;
    const endpoint = control.endpoint as Record<string, unknown>;
    const adapter = control.adapter as Record<string, unknown>;
    const httpControl = {
      ...control,
      endpoint: {
        ...endpoint,
        baseUrl: 'http://nanocore.local/api/worker-control',
      },
      adapter: {
        ...adapter,
        targetTransport: 'outbound-http',
      },
    };

    expect(
      AgentEnvironmentPackageSchema.parse({ ...fixture, control: httpControl }).control
    ).toEqual(
      expect.objectContaining({
        adapter: expect.objectContaining({ targetTransport: 'outbound-http' }),
      })
    );
    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...fixture,
        control: {
          ...control,
          adapter: { ...adapter, targetTransport: 'outbound-http' },
        },
      })
    ).toThrow();
    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...fixture,
        control: {
          ...httpControl,
          adapter: { ...adapter, targetTransport: 'outbound-https' },
        },
      })
    ).toThrow();
  });

  it.each([
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

  it('accepts interrupt as the only direct NanoCore control command', () => {
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

  it('rejects false direct NanoCore control declarations', () => {
    const fixture = openshellPackageFixture() as Record<string, unknown>;
    const control = fixture.control as Record<string, unknown>;
    const endpoint = control.endpoint as Record<string, unknown>;
    const auth = control.auth as Record<string, unknown>;
    const channels = control.channels as Record<string, unknown>;
    const adapter = control.adapter as Record<string, unknown>;
    const invalidControls = [
      { ...control, transcript: undefined },
      { ...control, endpoint: undefined },
      { ...control, endpoint: { ...endpoint, kind: 'sandbox-local-https' } },
      { ...control, endpoint: { ...endpoint, implementation: 'openkit-sidecar' } },
      { ...control, endpoint: { ...endpoint, required: false } },
      { ...control, endpoint: { ...endpoint, baseUrl: 'ftp://nanocore.local/api/worker-control' } },
      { ...control, endpoint: { ...endpoint, baseUrl: 'https://nanocore.local/wrong' } },
      {
        ...control,
        relay: {
          fallback: 'transcript-sink',
          kind: 'outbound-websocket',
          upstream: 'https://nanocore.local/api/worker-control',
        },
      },
      { ...control, auth: undefined },
      { ...control, auth: { ...auth, credentialVisibility: 'none' } },
      { ...control, auth: { ...auth, tokenRef: 'runtime://wrong-token' } },
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

  it('accepts only a placeholder-backed NanoCore route for trusted worker inference', () => {
    const parsed = AgentEnvironmentPackageSchema.parse(trustedWorkerInferenceRelayPackageFixture());

    expect(parsed.backend.requiredCapabilities).toContain('trusted-worker-inference-relay');
    expect(parsed.llm.routes).toEqual([
      expect.objectContaining({
        credentialVisibility: 'placeholder',
        endpoint: expect.objectContaining({
          workerBaseUrl: 'http://nanocore.internal/api/worker-inference/v1',
          upstream: expect.objectContaining({ kind: 'nanocore-gateway' }),
        }),
      }),
    ]);
    expect(parsed.policy.network?.rules[0]).toEqual({
      action: 'allow',
      binaries: ['/usr/local/bin/node', '/usr/local/bin/openkit-worker-shim'],
      host: 'nanocore.local',
      id: 'openkit-worker-control',
      port: 443,
      protocol: 'rest',
      rules: [
        { method: 'POST', path: '/api/worker-control/heartbeat' },
        { method: 'POST', path: '/api/worker-control/artifacts' },
        { method: 'POST', path: '/api/worker-control/commands/poll' },
        { method: 'POST', path: '/api/worker-control/commands/ack' },
        { method: 'POST', path: '/api/worker-control/events/append' },
        { method: 'POST', path: '/api/worker-control/final-status' },
        { method: 'POST', path: '/api/worker-control/supply-refresh-ack' },
        { method: 'POST', path: '/api/worker-control/capability-summary' },
      ],
    });
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

  it('rejects direct credentials and provider attachments for trusted worker inference', () => {
    const fixture = trustedWorkerInferenceRelayPackageFixture();
    const providers = fixture.providers as Record<string, unknown>;

    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...fixture,
        providers: {
          ...providers,
          attachments: [
            {
              binaryIds: ['codex'],
              id: 'attach_direct_provider',
              providerInstanceId: 'agent-openrouter',
            },
          ],
        },
      })
    ).toThrow();
    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...fixture,
        credentials: {
          declarations: [
            {
              id: 'direct_runtime_env',
              targetEnvVarName: 'OPENAI_API_KEY',
              vaultGrantId: 'grant_direct_runtime_env',
              visibility: 'runtime-env',
            },
          ],
        },
      })
    ).toThrow();
    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...fixture,
        vault: {
          grants: [
            {
              id: 'grant_direct_runtime_env',
              scope: 'agent-session',
              vaultRefId: 'vault_direct_runtime_env',
            },
          ],
          references: [
            {
              id: 'vault_direct_runtime_env',
              kind: 'secret-ref',
              secretRef: 'vault://provider/direct',
            },
          ],
        },
      })
    ).toThrow();
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

  it('requires an exact HTTP NanoCore base URL for trusted worker inference', () => {
    const fixture = trustedWorkerInferenceRelayPackageFixture();
    const llm = fixture.llm as { routes: Array<Record<string, unknown>> };
    const route = llm.routes[0] as Record<string, unknown>;
    const endpoint = route.endpoint as Record<string, unknown>;

    for (const workerBaseUrl of [
      'file:///api/worker-inference/v1',
      'ftp://nanocore.internal/api/worker-inference/v1',
      'http://user@nanocore.internal/api/worker-inference/v1',
      'http://nanocore.internal/api/worker-inference/v1?target=other',
      'http://nanocore.internal/api/worker-inference/v1#other',
    ]) {
      expect(() =>
        AgentEnvironmentPackageSchema.parse({
          ...fixture,
          llm: {
            ...llm,
            routes: [
              {
                ...route,
                endpoint: { ...endpoint, workerBaseUrl },
              },
            ],
          },
        })
      ).toThrow();
    }
  });

  it('requires exact relay-only network policy for trusted worker inference', () => {
    const fixture = trustedWorkerInferenceRelayPackageFixture();
    const policy = fixture.policy as Record<string, unknown>;
    const network = policy.network as { rules: Array<Record<string, unknown>> };
    const controlRule = network.rules[0] as Record<string, unknown>;
    const inferenceRule = network.rules[1] as Record<string, unknown>;

    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...fixture,
        policy: {
          ...policy,
          network: {
            ...network,
            rules: [
              ...network.rules,
              {
                action: 'allow',
                host: 'api.openai.com',
                id: 'direct-provider-egress',
              },
            ],
          },
        },
      })
    ).toThrow();
    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...fixture,
        policy: {
          ...policy,
          network: {
            ...network,
            rules: network.rules.map((rule, index) =>
              index === 0
                ? {
                    ...controlRule,
                    rules: [
                      { method: 'POST', path: '/api/worker-control/heartbeat' },
                      { method: 'POST', path: '/api/worker-inference/v1/responses' },
                    ],
                  }
                : rule
            ),
          },
        },
      })
    ).toThrow();
    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...fixture,
        policy: {
          ...policy,
          network: {
            ...network,
            rules: network.rules.map((rule, index) =>
              index === 0 ? { ...controlRule, access: 'read-write', rules: undefined } : rule
            ),
          },
        },
      })
    ).toThrow();
    for (const id of ['codex-control-bypass', 'openkit_worker_inference']) {
      expect(() =>
        AgentEnvironmentPackageSchema.parse({
          ...fixture,
          policy: {
            ...policy,
            network: {
              ...network,
              rules: [
                ...network.rules,
                {
                  access: 'read-write',
                  action: 'allow',
                  binaries: ['/usr/local/bin/codex'],
                  host: 'control.local',
                  id,
                  port: 3000,
                  protocol: 'rest',
                },
              ],
            },
          },
        })
      ).toThrow();
    }
    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...fixture,
        policy: {
          ...policy,
          network: { ...network, default: 'allow' },
        },
      })
    ).toThrow();
    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...fixture,
        policy: {
          ...policy,
          network: { ...network, enforcement: 'advisory' },
        },
      })
    ).toThrow();
    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...fixture,
        policy: {
          ...policy,
          network: {
            ...network,
            rules: network.rules.map((rule, index) =>
              index === 1
                ? {
                    ...inferenceRule,
                    rules: [
                      { method: 'POST', path: '/api/worker-inference/v1/responses' },
                      { method: 'GET', path: '/api/worker-inference/v1/models' },
                    ],
                  }
                : rule
            ),
          },
        },
      })
    ).toThrow();
    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...fixture,
        policy: {
          ...policy,
          network: {
            ...network,
            rules: network.rules.map((rule, index) =>
              index === 1
                ? { ...inferenceRule, binaries: ['/usr/local/bin/codex'], port: 443 }
                : rule
            ),
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
        providers: {
          ...(openshellPackageFixture() as { providers: Record<string, unknown> }).providers,
          providerInstances: [
            {
              id: 'provider_openai_default',
              profileId: 'openai',
              vendor: 'openai',
              displayName: 'OpenAI',
              kind: 'direct',
              models: ['gpt-5'],
              apiKey: 'sk-raw',
            },
          ],
        },
      })
    ).toThrow();
  });

  it('preserves the canonical control token reference while redacting private runtime references and host paths', () => {
    const parsed = AgentEnvironmentPackageSchema.parse({
      ...openshellPackageFixture(),
      runtime: {
        ...(openshellPackageFixture() as { runtime: Record<string, unknown> }).runtime,
        command: {
          argv: ['openkit-worker-shim', '--package', '/openkit/config/package.json'],
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
    expect(redacted.control.auth?.tokenRef).toBe('runtime://openkit/control-token');
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

  it('accepts remote container transport capabilities required by remote runtime gateways', () => {
    const parsed = AgentEnvironmentPackageSchema.parse({
      ...openshellPackageFixture(),
      backend: {
        preferred: 'openshell',
        allowedKinds: ['openshell'],
        requiredCapabilities: [
          'container',
          'remote-gateway',
          'backend-service-readiness',
          'file-upload-download',
          'git-materialization',
          'change-set-collection',
          'transcript-sink',
          'worker-control',
        ],
        extensions: {
          placement: 'remote',
          gatewayUrlRef: 'runtime://openshell/gateway-url',
        },
      },
    });
    const backend = WorkerGovernanceBackendCapabilitiesSchema.parse({
      kind: 'openshell',
      capabilities: [
        'container',
        'remote-gateway',
        'backend-service-readiness',
        'file-upload-download',
        'git-materialization',
        'change-set-collection',
        'transcript-sink',
        'worker-control',
      ],
      dynamicCapabilities: [],
      version: '0.0.63',
    });

    expect(validateAgentEnvironmentPackageForBackend(parsed, backend)).toEqual([]);
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

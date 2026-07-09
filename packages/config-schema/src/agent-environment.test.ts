import { describe, expect, it } from 'vitest';

import {
  AgentEnvironmentCredentialDeclarationSchema,
  AgentEnvironmentPackageSchema,
  redactAgentEnvironmentPackageSnapshot,
  validateAgentEnvironmentPackageForBackend,
  WorkerGovernanceBackendCapabilitiesSchema,
  WorkerSandboxAccessSchema,
} from './index.js';

/**
 * Creates a valid OpenShell-targeted package fixture with transcript and sidecar control.
 *
 * @returns Agent environment package fixture.
 */
function openshellPackageFixture(): unknown {
  return {
    schemaVersion: 1,
    packageId: 'aepkg_demo',
    snapshotId: 'aepsnap_demo',
    createdAt: '2026-06-16T00:00:00.000Z',
    scope: {
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'turn_demo',
      agentSessionId: 'as_demo',
      userId: 'user_demo',
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
      command: {
        argv: ['codex', 'app-server', '--listen', 'stdio://'],
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
      binaries: [{ id: 'git', path: '/usr/bin/git', required: true, allowedProviderIds: [] }],
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
          transport: 'stdio',
          command: ['github-mcp-server'],
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
          materialization: {
            kind: 'generated-config',
            targetPath: '/openkit/supply/mcp/github.json',
          },
          networkPolicyHints: ['api.github.com'],
          providerInstanceIds: ['provider_github_read'],
          vaultGrantIds: ['grant_github_read'],
          secretRefIds: ['vault_github_read'],
          reviewStatus: 'approved',
        },
      ],
      services: [],
    },
    control: {
      protocol: 'openkit-worker-control-v1',
      mode: 'sidecar',
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
        kind: 'sandbox-local-https',
        baseUrl: 'https://control.local/v1/worker-control',
        required: true,
        implementation: 'openkit-sidecar',
      },
      relay: {
        kind: 'outbound-websocket',
        upstream: 'https://nanocore.local/api/worker-control',
        reuseBackendSupervisorSession: 'when-supported',
        fallback: 'transcript-sink',
      },
      auth: {
        kind: 'sandbox-session-token',
        tokenRef: 'runtime://sandbox-session-token',
        credentialVisibility: 'placeholder',
      },
      channels: {
        commands: true,
        events: 'live',
        artifacts: 'batch',
        heartbeats: true,
        logs: 'summary-only',
      },
      commands: ['start-turn', 'interrupt', 'cancel', 'approval-result'],
      events: ['worker.ready', 'turn.started', 'item.created', 'turn.completed'],
      adapter: {
        kind: 'openkit-worker-shim',
        targetRuntime: 'codex',
        targetTransport: 'stdio',
      },
    },
    capabilities: {
      protocol: 'openkit-worker-capability-v1',
      mode: 'sidecar',
      endpoint: {
        kind: 'sandbox-local-https',
        baseUrl: 'https://capability.local/v1',
        required: true,
        implementation: 'openkit-sidecar',
      },
      auth: {
        kind: 'sandbox-session-token',
        tokenRef: 'runtime://sandbox-session-token',
        credentialVisibility: 'placeholder',
      },
      routes: [
        {
          family: 'knowledge.search',
          path: '/knowledge/search',
          policyRefId: 'policy_knowledge_read',
        },
        {
          family: 'knowledge.read',
          path: '/knowledge/read',
          policyRefId: 'policy_knowledge_read',
        },
      ],
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
          credentialVisibility: 'none',
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
        'sidecar-control-endpoint',
        'sidecar-capability-endpoint',
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

describe('agent environment package schema', () => {
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

  it('accepts an OpenShell-targeted package with transcript, sidecar control, capability, and NanoCore inference upstream', () => {
    const parsed = AgentEnvironmentPackageSchema.parse(openshellPackageFixture());

    expect(parsed.control.mode).toBe('sidecar');
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
    expect(parsed.capabilities.routes.map((route) => route.family)).toEqual([
      'knowledge.search',
      'knowledge.read',
    ]);
    expect(parsed.llm.routes[0]?.endpoint.workerBaseUrl).toBe('https://inference.local/v1');
    expect(parsed.policy.snapshotId).toBe('worker_turn_launch_policy');
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

  it('redacts backend-private, runtime credential references, and local host paths from package snapshots', () => {
    const parsed = AgentEnvironmentPackageSchema.parse({
      ...openshellPackageFixture(),
      runtime: {
        ...(openshellPackageFixture() as { runtime: Record<string, unknown> }).runtime,
        command: {
          argv: ['codex'],
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

    expect(serialized).not.toContain('runtime://sandbox-session-token');
    expect(serialized).not.toContain('/Users/m5pro');
    expect(redacted.control.auth?.tokenRef).toBe('[redacted:runtime-ref]');
    expect(redacted.capabilities.auth?.tokenRef).toBe('[redacted:runtime-ref]');
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
          message: expect.stringContaining('sidecar-control-endpoint'),
        }),
        expect.objectContaining({
          code: 'backend_missing_required_capability',
          message: expect.stringContaining('sidecar-capability-endpoint'),
        }),
        expect.objectContaining({
          code: 'backend_missing_required_capability',
          message: expect.stringContaining('provider-attachments'),
        }),
        expect.objectContaining({
          code: 'backend_missing_required_capability',
          message: expect.stringContaining('nanocore-inference-upstream'),
        }),
        expect.objectContaining({ code: 'backend_missing_sidecar_control_endpoint' }),
        expect.objectContaining({ code: 'backend_missing_sidecar_capability_endpoint' }),
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
          'sidecar-control-endpoint',
          'sidecar-capability-endpoint',
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
        'sidecar-control-endpoint',
        'sidecar-capability-endpoint',
      ],
      dynamicCapabilities: [],
      version: '0.0.63',
    });

    expect(validateAgentEnvironmentPackageForBackend(parsed, backend)).toEqual([]);
  });

  it('rejects OpenShell service forwarding as the canonical worker control channel', () => {
    expect(() =>
      AgentEnvironmentPackageSchema.parse({
        ...openshellPackageFixture(),
        control: {
          ...(openshellPackageFixture() as { control: Record<string, unknown> }).control,
          endpoint: {
            kind: 'sandbox-local-https',
            baseUrl: 'https://control.local/v1/worker-control',
            required: true,
            implementation: 'service-forwarding',
          },
        },
      })
    ).toThrow();
  });
});

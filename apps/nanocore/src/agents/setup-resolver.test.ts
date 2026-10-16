import type { GatewayConfig, UserConfig, WorkspaceConfig } from '@openkit/config-schema';
import { describe, expect, it, vi } from 'vitest';

import { ProviderRegistry } from '../providers/registry.js';
import type { AuthoredAgentConfig } from './manifest.js';
import { resolveAgentSetup } from './setup-resolver.js';

function agentConfig(overrides: Partial<AuthoredAgentConfig> = {}): AuthoredAgentConfig {
  return {
    schemaVersion: 1,
    id: 'agent_codex_host',
    displayName: 'Codex Agent',
    models: {
      preferredLogicalModelId: 'reasoning',
      allowedLogicalModelIds: ['reasoning'],
    },
    runtime: {
      kind: 'codex',
      adapter: 'codex-app-server',
      binaries: [
        { id: 'openkit-worker-shim', path: '/usr/local/bin/openkit-worker-shim' },
        { id: 'node', path: '/usr/local/bin/node' },
        { id: 'codex', path: '/usr/local/bin/codex' },
      ],
      image: {
        kind: 'reference',
        pullPolicy: 'if-not-present',
        ref: 'ghcr.io/openkit/worker-codex:test',
      },
      version: '0.130.0',
    },
    extensions: {},
    ...overrides,
  } as AuthoredAgentConfig;
}

function providerRegistry(): ProviderRegistry {
  return new ProviderRegistry([
    {
      baseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: 'openai/gpt-5.1',
      displayName: 'Agent OpenRouter',
      id: 'agent-openrouter',
      kind: 'gateway',
      models: ['openai/gpt-5.1'],
      secretRef: 'env:AGENT_OPENROUTER_API_KEY',
      vendor: 'openrouter',
    },
  ]);
}

function gatewayConfig(): GatewayConfig {
  return {
    schemaVersion: 1,
    enabled: true,
    defaultLogicalModelId: 'reasoning',
    logicalModels: [
      {
        id: 'reasoning',
        displayName: 'Reasoning',
        contextManagement: [{ type: 'compaction', compactThreshold: 8_000 }],
        routes: [
          {
            id: 'primary',
            providerProfileId: 'agent-openrouter',
            providerModel: 'openai/gpt-5.1',
          },
        ],
      },
    ],
    requiredFeatures: [],
  };
}

describe('resolveAgentSetup', () => {
  it('blocks unsupported resource limits without dropping authored intent or exposing it', () => {
    const manifest = agentConfig({ resources: { 'private-resource-fixture': { limit: 2 } } });
    const original = structuredClone(manifest);
    const dependencies = { gatewayConfig: gatewayConfig(), providerRegistry: providerRegistry() };
    const result = resolveAgentSetup(manifest, dependencies);

    expect(result.setup).toBeNull();
    expect(result.diagnostics).toEqual([
      {
        agentId: manifest.id,
        code: 'agent_setup.unsupported_resources',
        message: `Agent ${manifest.id} declares resource limits that the Worker cannot enforce; leave resources empty or absent.`,
        severity: 'error',
      },
    ]);
    expect(manifest).toEqual(original);
    expect(JSON.stringify(result.diagnostics)).not.toContain('private-resource-fixture');

    for (const resources of [undefined, {}]) {
      const corrected = resolveAgentSetup(agentConfig({ resources }), dependencies);
      expect(corrected.diagnostics).toEqual([]);
      expect(corrected.setup).not.toBeNull();
    }
    expect(result.setup).toBeNull();
    expect(manifest).toEqual(original);
  });

  it.each([
    'api-key',
    'subscription',
  ])('rechecks live %s supply on restoration and revocation', (kind) => {
    const baseProvider = providerRegistry().list()[0]!;
    const providers =
      kind === 'api-key'
        ? providerRegistry()
        : new ProviderRegistry([
            {
              ...baseProvider,
              kind: 'oauth',
              vendor: 'openai-codex',
              baseUrl: undefined,
              secretRef: undefined,
              extensions: {
                openkit: { subscriptionAccount: { accountSlotId: 'private-slot-fixture' } },
              },
            },
          ]);
    let available = false;
    const keyCheck = vi.fn(() => available);
    const accountCheck = vi.fn(() => (available ? null : 'subscription_account_logged_out'));
    const dependencies = {
      gatewayConfig: gatewayConfig(),
      providerRegistry: providers,
      providerCredentialConfigured: keyCheck,
      subscriptionAccounts: { gatewayUnavailableReason: accountCheck },
    };

    const unavailable = resolveAgentSetup(agentConfig(), dependencies);
    expect(unavailable.setup).toBeNull();
    expect(unavailable.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'agent_setup.logical_model_not_allowed' })
    );
    expect(JSON.stringify(unavailable.diagnostics)).not.toContain('private-slot-fixture');
    expect(JSON.stringify(unavailable.diagnostics)).not.toContain(baseProvider.secretRef);
    expect(keyCheck).toHaveBeenCalledTimes(kind === 'api-key' ? 1 : 0);
    expect(accountCheck).toHaveBeenCalledTimes(kind === 'subscription' ? 1 : 0);

    available = true;
    const restored = resolveAgentSetup(agentConfig(), dependencies);
    expect(restored.diagnostics).toEqual([]);
    expect(restored.setup?.logicalModels.preferredLogicalModelId).toBe('reasoning');
    expect(restored.setup?.logicalModels.allowed[0]?.routes[0]?.available).toBe(true);

    available = false;
    const revoked = resolveAgentSetup(agentConfig(), dependencies);
    expect(revoked.setup).toBeNull();
    expect(keyCheck).toHaveBeenCalledTimes(kind === 'api-key' ? 3 : 0);
    expect(accountCheck).toHaveBeenCalledTimes(kind === 'subscription' ? 3 : 0);
    if (kind === 'api-key') expect(keyCheck).toHaveBeenLastCalledWith(baseProvider.secretRef);
    else
      expect(accountCheck).toHaveBeenLastCalledWith({
        subscriptionProviderId: 'openai-codex',
        accountSlotId: 'private-slot-fixture',
      });
    expect(restored.setup?.logicalModels.allowed[0]?.routes[0]?.available).toBe(true);

    const failInspection = () => {
      throw new Error('private-owner-failure-fixture');
    };
    keyCheck.mockImplementation(failInspection);
    accountCheck.mockImplementation(failInspection);
    const failed = resolveAgentSetup(agentConfig(), dependencies);
    expect(failed.setup).toBeNull();
    expect(failed.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'agent_setup.logical_model_not_found' })
    );
    expect(JSON.stringify(failed.diagnostics)).not.toContain('private-owner-failure-fixture');
  });

  it.each([false, true])('applies failover=%s after live credential checks', (autoFailover) => {
    const baseProvider = providerRegistry().list()[0]!;
    const providers = new ProviderRegistry([
      baseProvider,
      { ...baseProvider, id: 'keyless-backup', kind: 'custom', secretRef: undefined },
    ]);
    const gateway = gatewayConfig();
    const model = gateway.logicalModels[0]!;
    const keyCheck = vi.fn(() => false);
    const result = resolveAgentSetup(agentConfig(), {
      gatewayConfig: {
        ...gateway,
        logicalModels: [
          {
            ...model,
            routing: { autoFailover },
            routes: [
              model.routes[0]!,
              { ...model.routes[0]!, id: 'backup', providerProfileId: 'keyless-backup' },
            ],
          },
        ],
      },
      providerRegistry: providers,
      providerCredentialConfigured: keyCheck,
    });

    expect(keyCheck).toHaveBeenCalledTimes(1);
    if (autoFailover) {
      expect(result.diagnostics).toEqual([]);
      expect(result.setup?.logicalModels.allowed[0]?.routes).toEqual([
        expect.objectContaining({
          available: false,
          unavailableReason: 'provider_api_key_missing',
        }),
        expect.objectContaining({ available: true, unavailableReason: null }),
      ]);
    } else expect(result.setup).toBeNull();
  });

  it.each([
    false,
    true,
    undefined,
  ])('uses a backup for setup only when failover is enabled: %s', (autoFailover) => {
    const gateway = gatewayConfig();
    const model = gateway.logicalModels[0]!;
    const configured: GatewayConfig = {
      ...gateway,
      logicalModels: [
        {
          ...model,
          ...(autoFailover !== undefined ? { routing: { autoFailover } } : {}),
          routes: [
            { ...model.routes[0]!, id: 'primary', providerProfileId: 'missing-provider' },
            { ...model.routes[0]!, id: 'backup' },
          ],
        },
      ],
    };
    const result = resolveAgentSetup(agentConfig(), {
      gatewayConfig: configured,
      providerRegistry: providerRegistry(),
    });

    if (autoFailover === false) {
      expect(result.setup).toBeNull();
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'agent_setup.logical_model_not_allowed' })
      );
    } else {
      expect(result.diagnostics).toEqual([]);
      expect(result.setup?.logicalModels.preferredLogicalModelId).toBe('reasoning');
      expect(result.setup?.logicalModels.allowed[0]?.routes).toEqual([
        expect.objectContaining({ id: 'primary', available: false }),
        expect.objectContaining({ id: 'backup', available: true }),
      ]);
    }
  });

  it('excludes dormant-only supply from all and admits it when its primary returns', () => {
    const gateway = gatewayConfig();
    const model = gateway.logicalModels[0]!;
    const configured: GatewayConfig = {
      ...gateway,
      logicalModels: [
        model,
        {
          ...model,
          id: 'primary-only',
          routing: { autoFailover: false },
          routes: [
            { ...model.routes[0]!, id: 'primary', providerProfileId: 'restored-provider' },
            { ...model.routes[0]!, id: 'backup' },
          ],
        },
      ],
    };
    const manifest = agentConfig({
      models: { preferredLogicalModelId: 'reasoning', allowedLogicalModelIds: 'all' },
    });
    const providers = providerRegistry();
    const before = resolveAgentSetup(manifest, {
      gatewayConfig: configured,
      providerRegistry: providers,
    });
    expect(before.diagnostics).toEqual([]);
    expect(before.setup?.logicalModels.allowed.map((entry) => entry.id)).toEqual(['reasoning']);

    const after = resolveAgentSetup(manifest, {
      gatewayConfig: configured,
      providerRegistry: new ProviderRegistry([
        ...providers.list(),
        { ...providers.list()[0]!, id: 'restored-provider' },
      ]),
    });
    expect(after.diagnostics).toEqual([]);
    expect(after.setup?.logicalModels.allowed.map((entry) => entry.id)).toEqual([
      'reasoning',
      'primary-only',
    ]);
    expect(before.setup?.logicalModels.allowed.map((entry) => entry.id)).toEqual(['reasoning']);
  });

  it.each([
    '/usr/local/bin/node',
    '/usr/local/bin/openkit-worker-shim',
  ])('blocks setup before AEP construction when control binary %s is absent', (path) => {
    const manifest = agentConfig();
    const result = resolveAgentSetup(
      {
        ...manifest,
        runtime: {
          ...manifest.runtime,
          binaries: manifest.runtime.binaries.filter((binary) => binary.path !== path),
        },
      },
      { gatewayConfig: gatewayConfig(), providerRegistry: providerRegistry() }
    );

    expect(result.setup).toBeNull();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        agentId: manifest.id,
        code: 'agent_setup.missing_control_binary',
        severity: 'error',
      }),
    ]);
  });

  it('does not accept a control binary id at a different path or expose that path', () => {
    const manifest = agentConfig();
    const untrustedPath = '/private/worker/custom-node';
    const result = resolveAgentSetup(
      {
        ...manifest,
        runtime: {
          ...manifest.runtime,
          binaries: manifest.runtime.binaries.map((binary) =>
            binary.id === 'node' ? { ...binary, path: untrustedPath } : binary
          ),
        },
      },
      { gatewayConfig: gatewayConfig(), providerRegistry: providerRegistry() }
    );

    expect(result.setup).toBeNull();
    expect(result.diagnostics).toEqual([
      {
        agentId: manifest.id,
        code: 'agent_setup.missing_control_binary',
        message: `Agent ${manifest.id} must declare the required Worker control binary: node.`,
        severity: 'error',
      },
    ]);
    expect(JSON.stringify(result.diagnostics)).not.toContain(untrustedPath);
  });

  it.each([
    'explicit',
    'all',
  ])('refuses an unavailable preferred model with an %s allowlist', (kind) => {
    const result = resolveAgentSetup(
      agentConfig({
        models: {
          preferredLogicalModelId: 'reasoning',
          allowedLogicalModelIds: kind === 'all' ? 'all' : ['reasoning'],
        },
      }),
      { gatewayConfig: gatewayConfig(), providerRegistry: new ProviderRegistry([]) }
    );

    expect(result.setup).toBeNull();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'agent_setup.logical_model_not_allowed', severity: 'error' })
    );
  });

  it('fails with a typed diagnostic when a logical model is missing', () => {
    const result = resolveAgentSetup(
      agentConfig({
        models: {
          preferredLogicalModelId: 'missing-model',
          allowedLogicalModelIds: ['missing-model'],
        },
      }),
      { gatewayConfig: gatewayConfig(), providerRegistry: providerRegistry() }
    );

    expect(result.setup).toBeNull();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'agent_setup.logical_model_not_found',
        message: expect.stringContaining('missing-model'),
        severity: 'error',
        agentId: 'agent_codex_host',
      })
    );
  });

  it('returns the composed manifest and worker-visible logical models only', () => {
    const manifest = agentConfig({
      requiredFeatures: ['workspace.mount.fuse'],
      runtime: {
        adapter: 'future-adapter',
        binaries: [
          { id: 'openkit-worker-shim', path: '/usr/local/bin/openkit-worker-shim' },
          { id: 'node', path: '/usr/local/bin/node' },
          { id: 'future-runtime', path: '/opt/future/bin/runtime' },
        ],
        image: {
          kind: 'reference',
          pullPolicy: 'never',
          ref: 'registry.example.com/openkit/worker-future:1.0.0',
        },
        kind: 'future-runtime',
        version: '1.0.0',
      },
    });
    const result = resolveAgentSetup(manifest, {
      gatewayConfig: gatewayConfig(),
      providerRegistry: providerRegistry(),
      supportedRequiredFeatures: ['workspace.mount.fuse'],
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.setup).toEqual({
      manifest: expect.objectContaining(manifest),
      profileId: null,
      logicalModels: {
        preferredLogicalModelId: 'reasoning',
        allowed: [expect.objectContaining({ id: 'reasoning', displayName: 'Reasoning' })],
      },
    });
    expect(JSON.stringify(result.setup)).not.toContain('AGENT_OPENROUTER_API_KEY');
  });

  it('resolves request preference before user and workspace preferences', () => {
    const alternateGateway: GatewayConfig = {
      ...gatewayConfig(),
      logicalModels: [
        ...gatewayConfig().logicalModels,
        {
          id: 'fast',
          displayName: 'Fast',
          contextManagement: [{ type: 'compaction', compactThreshold: 8_000 }],
          routes: [
            {
              id: 'primary',
              providerProfileId: 'agent-openrouter',
              providerModel: 'openai/gpt-5.1',
            },
          ],
        },
      ],
    };
    const workspaceConfig = {
      schemaVersion: 1,
      workspace: {
        name: 'Test',
        agents: [
          {
            agentId: 'agent_codex_host',
            preferredLogicalModelId: 'fast',
            allowedLogicalModelIds: 'all',
            credentialBindings: [],
            skills: [],
            mcp: [],
          },
        ],
        internalRoles: [],
        assistant: { repositoryInspection: { enabled: true, excludedPaths: [] } },
        roots: [],
      },
    } satisfies WorkspaceConfig;
    const userConfig = {
      schemaVersion: 1,
      workspaces: [
        {
          workspaceId: 'workspace_test',
          logicalModelId: 'reasoning',
          internalRoles: [],
        },
      ],
    } satisfies UserConfig;

    const result = resolveAgentSetup(
      agentConfig({ models: { preferredLogicalModelId: 'fast', allowedLogicalModelIds: 'all' } }),
      {
        gatewayConfig: alternateGateway,
        providerRegistry: providerRegistry(),
        requestedLogicalModelId: 'fast',
        userConfig,
        workspaceConfig,
        workspaceId: 'workspace_test',
      }
    );

    expect(result.setup?.logicalModels.preferredLogicalModelId).toBe('fast');
    expect(result.setup?.logicalModels.allowed.map((model) => model.id)).toEqual([
      'reasoning',
      'fast',
    ]);
  });

  it('binds one reusable credential requirement to each Workspace grant', () => {
    const manifest = agentConfig({
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
        filesystem: [],
        network: [],
      },
    });
    const workspaceConfig = (workspaceId: string, vaultGrantId?: string): WorkspaceConfig => ({
      schemaVersion: 1,
      workspace: {
        name: workspaceId,
        agents: [
          {
            agentId: 'agent_codex_host',
            credentialBindings: vaultGrantId
              ? [{ requirementId: 'github-token', vaultGrantId }]
              : [],
            mcp: [],
            skills: [],
          },
        ],
        internalRoles: [],
        assistant: { repositoryInspection: { enabled: true, excludedPaths: [] } },
        roots: [],
      },
    });

    const workspaceA = resolveAgentSetup(manifest, {
      gatewayConfig: gatewayConfig(),
      providerRegistry: providerRegistry(),
      workspaceConfig: workspaceConfig('Workspace A', 'grant_00000000-0000-7f83-847d-ca64a2c18901'),
    });
    const workspaceB = resolveAgentSetup(manifest, {
      gatewayConfig: gatewayConfig(),
      providerRegistry: providerRegistry(),
      workspaceConfig: workspaceConfig('Workspace B', 'grant_00000000-0000-785c-bf3c-88f756ef3a75'),
    });
    const missing = resolveAgentSetup(manifest, {
      gatewayConfig: gatewayConfig(),
      providerRegistry: providerRegistry(),
      workspaceConfig: workspaceConfig('Workspace missing'),
    });

    expect(workspaceA.setup?.manifest.sandbox?.credentialDeclarations).toEqual([
      expect.objectContaining({
        requirementId: 'github-token',
        vaultGrantId: 'grant_00000000-0000-7f83-847d-ca64a2c18901',
      }),
    ]);
    expect(workspaceB.setup?.manifest.sandbox?.credentialDeclarations).toEqual([
      expect.objectContaining({
        requirementId: 'github-token',
        vaultGrantId: 'grant_00000000-0000-785c-bf3c-88f756ef3a75',
      }),
    ]);
    expect(missing.setup).toBeNull();
    expect(missing.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'agent_setup.missing_credential_binding' })
    );
  });

  it('fails closed for unsupported required features', () => {
    const result = resolveAgentSetup(agentConfig({ requiredFeatures: ['workspace.mount.fuse'] }), {
      gatewayConfig: gatewayConfig(),
      providerRegistry: providerRegistry(),
    });

    expect(result.setup).toBeNull();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'agent_setup.unsupported_required_feature',
        message: 'Agent agent_codex_host requires unsupported feature: workspace.mount.fuse.',
        severity: 'error',
        agentId: 'agent_codex_host',
      })
    );
  });

  it('rejects an explicit default profile id that is absent from the manifest', () => {
    const result = resolveAgentSetup(
      agentConfig({
        defaultProfileId: 'missing-profile',
        profiles: [{ id: 'available-profile', skills: [], mcp: [] }],
      }),
      { gatewayConfig: gatewayConfig(), providerRegistry: providerRegistry() }
    );

    expect(result.setup).toBeNull();
    expect(result.diagnostics).toContainEqual({
      agentId: 'agent_codex_host',
      code: 'agent_setup.invalid_default_profile',
      message: 'Agent agent_codex_host profile missing-profile is not declared in profiles.',
      severity: 'error',
    });
  });
});

it.each([
  { base: 'high', selected: 'none', expected: 'none' },
  { base: 'high', selected: undefined, expected: 'high' },
  { base: undefined, selected: 'max', expected: 'max' },
  { base: undefined, selected: undefined, expected: undefined },
] as const)('composes profile effort over the Agent default: %j', ({
  base,
  selected,
  expected,
}) => {
  const config = agentConfig();
  const authored = {
    ...config,
    models: { ...config.models, reasoningEffort: base },
    profiles: [{ id: 'selected', reasoningEffort: selected, skills: [], mcp: [] }],
  };
  const result = resolveAgentSetup(authored, {
    gatewayConfig: gatewayConfig(),
    providerRegistry: providerRegistry(),
    selectedProfileId: 'selected',
  });
  expect(result.diagnostics).toEqual([]);
  if (expected === undefined)
    expect(result.setup?.manifest.models).not.toHaveProperty('reasoningEffort');
  else expect(result.setup?.manifest.models).toHaveProperty('reasoningEffort', expected);
});

it('refuses unknown Agent and selected-profile effort through setup diagnostics', () => {
  for (const source of ['base', 'profile']) {
    const config = agentConfig();
    const invalid = {
      ...config,
      models: { ...config.models, ...(source === 'base' ? { reasoningEffort: 'default' } : {}) },
      profiles: [
        {
          id: 'selected',
          skills: [],
          mcp: [],
          ...(source === 'profile' ? { reasoningEffort: 'default' } : {}),
        },
      ],
    };
    const result = resolveAgentSetup(invalid as never, {
      gatewayConfig: gatewayConfig(),
      providerRegistry: providerRegistry(),
      selectedProfileId: 'selected',
    });
    expect(result.setup).toBeNull();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'agent_setup.invalid_reasoning_effort' })
    );
  }
});

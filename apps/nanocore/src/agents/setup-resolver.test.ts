import {
  AuthoredAgentConfigSchema,
  type GatewayConfig,
  type UserConfig,
  type WorkspaceConfig,
} from '@openkit/config-schema';
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
      kind: 'llm-gateway',
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

  it.each(['api-key', 'subscription'])(
    'rechecks live %s supply on restoration and revocation',
    (kind) => {
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
    }
  );

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

  it.each([false, true, undefined])(
    'uses a backup for setup only when failover is enabled: %s',
    (autoFailover) => {
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
    }
  );

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

  it.each(['/usr/local/bin/node', '/usr/local/bin/openkit-worker-shim'])(
    'blocks setup before AEP construction when control binary %s is absent',
    (path) => {
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
    }
  );

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

  it.each(['explicit', 'all'])(
    'refuses an unavailable preferred model with an %s allowlist',
    (kind) => {
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
        expect.objectContaining({
          code: 'agent_setup.logical_model_not_allowed',
          severity: 'error',
        })
      );
    }
  );

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

  it('refuses conflicting exact Skill versions in the composed setup', () => {
    const result = resolveAgentSetup(
      AuthoredAgentConfigSchema.parse(
        agentConfig({
          skills: [{ id: 'review-skill', digest: `sha256:${'a'.repeat(64)}` }],
          profiles: [
            {
              id: 'selected',
              skills: [{ id: 'review-skill', digest: `sha256:${'b'.repeat(64)}` }],
              mcp: [],
            },
          ],
        })
      ),
      {
        selectedProfileId: 'selected',
        gatewayConfig: gatewayConfig(),
        providerRegistry: providerRegistry(),
      }
    );
    expect(result.setup).toBeNull();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'agent_setup.conflicting_skill_versions' })
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
] as const)(
  'composes profile effort over the Agent default: %j',
  ({ base, selected, expected }) => {
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
  }
);

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

/** Authored intent only; setup composition neither creates nor authorizes this grant. */
function authoredCodexLogin(allowed: 'all' | string[] = ['reasoning']) {
  const base = agentConfig();
  const parsed = AuthoredAgentConfigSchema.safeParse({
    ...base,
    runtime: { ...base.runtime, adapter: 'codex', version: '0.166.0' },
    models: { preferredLogicalModelId: 'reasoning', allowedLogicalModelIds: allowed },
    sandbox: {
      credentialDeclarations: [
        {
          id: 'codex-subscription',
          requirementId: 'codex-subscription',
          purpose: 'Use the explicitly reviewed Workspace Codex Login.',
          required: true,
          visibility: 'runtime-token',
          consumer: 'codex-login',
        },
      ],
      filesystem: [],
      network: [],
    },
  });
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error('The explicit authored Codex Login form was refused.');
  return parsed.data;
}

/** Supplies public configuration references, without simulating a canonical grant or use authority. */
function codexLoginComposition() {
  const nativeModel = 'gpt-5.1-codex';
  const providers = new ProviderRegistry([
    {
      id: 'codex-native-metadata',
      displayName: 'Codex native metadata',
      kind: 'oauth',
      vendor: 'openai-codex',
      models: [nativeModel, 'gpt-5.1-codex-mini'],
      modelMetadata: Object.fromEntries(
        [nativeModel, 'gpt-5.1-codex-mini'].map((model) => [
          model,
          {
            family: 'codex-metadata-fixture',
            limit: { context: 128_000, output: 16_000 },
            modalities: { input: ['text', 'image'], output: ['text'] },
            reasoning: true,
            tool_call: true,
          },
        ])
      ),
    },
  ]);
  const gateway: GatewayConfig = {
    ...gatewayConfig(),
    logicalModels: [
      {
        ...gatewayConfig().logicalModels[0]!,
        routes: [
          { id: 'native', providerProfileId: 'codex-native-metadata', providerModel: nativeModel },
        ],
      },
    ],
  };
  const workspace: WorkspaceConfig = {
    schemaVersion: 1,
    workspace: {
      name: 'Codex composition fixture',
      agents: [
        {
          agentId: 'agent_codex_host',
          credentialBindings: [
            {
              requirementId: 'codex-subscription',
              vaultGrantId: 'grant_00000000-0000-7f83-847d-ca64a2c18901',
            },
          ],
          skills: [],
          mcp: [],
        },
      ],
      internalRoles: [],
      roots: [],
      assistant: { repositoryInspection: { enabled: true, excludedPaths: [] } },
    },
  };
  const accountCheck = vi.fn(() => {
    throw new Error('Server account readiness must not be consulted.');
  });
  const keyCheck = vi.fn(() => {
    throw new Error('Server key readiness must not be consulted.');
  });
  return {
    nativeModel,
    gateway,
    workspace,
    providers,
    accountCheck,
    keyCheck,
    dependencies: {
      gatewayConfig: gateway,
      providerRegistry: providers,
      workspaceConfig: workspace,
      subscriptionAccounts: { gatewayUnavailableReason: accountCheck },
      providerCredentialConfigured: keyCheck,
    },
  };
}

// Owners: Vault Harness Subscription Logins and coordinated current4 harness package form.
describe('explicit Codex Login setup metadata', () => {
  // Agent Manifest And AEP Resolution: unsupported composed requirements fail closed (440, 483).
  it.each(['absent', 'empty'] as const)(
    'refuses a Login without an authored feature marker when serving support is %s',
    (support) => {
      const f = codexLoginComposition();
      const manifest = authoredCodexLogin();
      expect(manifest.requiredFeatures ?? []).not.toContain('worker.harness-login.v1');
      const result = resolveAgentSetup(manifest, {
        ...f.dependencies,
        ...(support === 'empty' ? { supportedRequiredFeatures: [] } : {}),
      });
      expect(result.setup).toBeNull();
      expect(result.diagnostics).toContainEqual({
        agentId: manifest.id,
        code: 'agent_setup.unsupported_required_feature',
        message: `Agent ${manifest.id} requires unsupported feature: worker.harness-login.v1.`,
        severity: 'error',
      });
      expect(f.accountCheck).not.toHaveBeenCalled();
      expect(f.keyCheck).not.toHaveBeenCalled();
    }
  );

  it('composes exact native metadata without reading Server Gateway credentials', () => {
    const f = codexLoginComposition();
    const manifest = authoredCodexLogin();
    const original = structuredClone(manifest);
    const result = resolveAgentSetup(manifest, {
      ...f.dependencies,
      supportedRequiredFeatures: ['worker.harness-login.v1'],
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.setup?.logicalModels.allowed).toEqual([
      expect.objectContaining({
        id: 'reasoning',
        modelParameters: {
          contextWindow: 128_000,
          maxOutputTokens: 16_000,
          inputModalities: ['text', 'image'],
          reasoning: true,
        },
        routes: [expect.objectContaining({ providerModel: f.nativeModel })],
      }),
    ]);
    expect(result.setup?.manifest.sandbox?.credentialDeclarations).toEqual([
      {
        id: 'codex-subscription',
        requirementId: 'codex-subscription',
        vaultGrantId: f.workspace.workspace.agents[0]!.credentialBindings[0]!.vaultGrantId,
        visibility: 'runtime-token',
        consumer: 'codex-login',
      },
    ]);
    expect(f.accountCheck).not.toHaveBeenCalled();
    expect(f.keyCheck).not.toHaveBeenCalled();
    expect(manifest).toEqual(original);
  });

  it('refuses ambiguous native identities rather than choosing the first route', () => {
    const f = codexLoginComposition();
    f.gateway.logicalModels[0]!.routes.push({
      id: 'other',
      providerProfileId: 'codex-native-metadata',
      providerModel: 'gpt-5.1-codex-mini',
    });
    const result = resolveAgentSetup(authoredCodexLogin(), f.dependencies);
    expect(result.setup).toBeNull();
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(f.accountCheck).not.toHaveBeenCalled();
    expect(f.keyCheck).not.toHaveBeenCalled();
  });

  it('refuses the entire all expansion when one model is not representable for Codex', () => {
    const f = codexLoginComposition();
    f.gateway.logicalModels.push({
      ...gatewayConfig().logicalModels[0]!,
      id: 'foreign-model',
      routes: [
        { id: 'foreign', providerProfileId: 'foreign-provider', providerModel: 'foreign-native' },
      ],
    });
    const providers = new ProviderRegistry([
      ...f.providers.list(),
      {
        id: 'foreign-provider',
        displayName: 'Foreign metadata',
        kind: 'custom',
        models: ['foreign-native'],
      },
    ]);
    const result = resolveAgentSetup(authoredCodexLogin('all'), {
      ...f.dependencies,
      providerRegistry: providers,
    });
    expect(result.setup).toBeNull();
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(f.accountCheck).not.toHaveBeenCalled();
    expect(f.keyCheck).not.toHaveBeenCalled();
  });

  it('requires the existing Workspace credential binding before an executable setup', () => {
    const f = codexLoginComposition();
    f.workspace.workspace.agents[0]!.credentialBindings = [];
    const result = resolveAgentSetup(authoredCodexLogin(), f.dependencies);
    expect(result.setup).toBeNull();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'agent_setup.missing_credential_binding',
      })
    );
  });
});

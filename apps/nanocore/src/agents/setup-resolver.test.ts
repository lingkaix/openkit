import type { GatewayConfig, UserConfig, WorkspaceConfig } from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';

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
      workspaceConfig: workspaceConfig('Workspace A', 'grant_workspace_a'),
    });
    const workspaceB = resolveAgentSetup(manifest, {
      gatewayConfig: gatewayConfig(),
      providerRegistry: providerRegistry(),
      workspaceConfig: workspaceConfig('Workspace B', 'grant_workspace_b'),
    });
    const missing = resolveAgentSetup(manifest, {
      gatewayConfig: gatewayConfig(),
      providerRegistry: providerRegistry(),
      workspaceConfig: workspaceConfig('Workspace missing'),
    });

    expect(workspaceA.setup?.manifest.sandbox?.credentialDeclarations).toEqual([
      expect.objectContaining({
        requirementId: 'github-token',
        vaultGrantId: 'grant_workspace_a',
      }),
    ]);
    expect(workspaceB.setup?.manifest.sandbox?.credentialDeclarations).toEqual([
      expect.objectContaining({
        requirementId: 'github-token',
        vaultGrantId: 'grant_workspace_b',
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

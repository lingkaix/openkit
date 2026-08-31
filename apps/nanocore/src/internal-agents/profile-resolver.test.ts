import { describe, expect, it } from 'vitest';

import { ProviderRegistry } from '../providers/registry.js';
import { resolveInternalRoleProfile } from './profile-resolver.js';

const providers = new ProviderRegistry([
  {
    id: 'openai',
    adapter: 'openai-compatible',
    vendor: 'openai',
    displayName: 'OpenAI',
    kind: 'llm',
    enabled: true,
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-5.2'],
    capabilities: { llm: { chatCompletions: 'supported', responses: 'supported' } },
    credential: { kind: 'none' },
  },
]);
const gatewayConfig = {
  schemaVersion: 1 as const,
  enabled: true,
  defaultLogicalModelId: 'reasoning',
  requiredFeatures: [],
  logicalModels: [
    {
      id: 'reasoning',
      displayName: 'Reasoning',
      routes: [{ id: 'primary', providerProfileId: 'openai', providerModel: 'gpt-5.2' }],
    },
  ],
};

describe('internal role profile resolution', () => {
  it('applies explicit, User, Workspace, Server profile, and Gateway preferences in order', () => {
    const resolved = resolveInternalRoleProfile({
      roleId: 'assistant',
      workspaceId: 'ws_demo',
      gatewayConfig,
      providerRegistry: providers,
      profilesConfig: {
        schemaVersion: 1,
        defaultLogicalModelId: 'reasoning',
        profiles: [
          {
            id: 'assistant-default',
            roleId: 'assistant',
            preferredLogicalModelId: 'reasoning',
            compatibleLogicalModelIds: [],
            requiredLogicalModelCapabilities: ['chat-completions'],
          },
        ],
      },
      workspaceConfig: {
        schemaVersion: 1,
        workspace: {
          name: 'Demo',
          defaultAgentId: null,
          agents: [],
          internalRoles: [{ roleId: 'assistant', profileId: 'assistant-default' }],
          assistant: { repositoryInspection: { enabled: true, excludedPaths: [] } },
          roots: [],
        },
      },
    });

    expect(resolved).toMatchObject({
      profile: { id: 'assistant-default' },
      logicalModel: { id: 'reasoning' },
      logicalModels: [{ id: 'reasoning' }],
    });
  });

  it('fails closed for a selected profile owned by another role', () => {
    expect(
      resolveInternalRoleProfile({
        roleId: 'assistant',
        workspaceId: 'ws_demo',
        gatewayConfig,
        providerRegistry: providers,
        profilesConfig: {
          schemaVersion: 1,
          profiles: [
            {
              id: 'knowledge-default',
              roleId: 'knowledge-manager',
              compatibleLogicalModelIds: [],
              requiredLogicalModelCapabilities: [],
            },
          ],
        },
        userConfig: {
          schemaVersion: 1,
          workspaces: [
            {
              workspaceId: 'ws_demo',
              internalRoles: [{ roleId: 'assistant', profileId: 'knowledge-default' }],
            },
          ],
        },
      })
    ).toBeNull();
  });

  it('rejects an explicit logical model outside the selected profile allowlist', () => {
    expect(
      resolveInternalRoleProfile({
        roleId: 'assistant',
        workspaceId: 'ws_demo',
        requestedLogicalModelId: 'unlisted',
        gatewayConfig,
        providerRegistry: providers,
        profilesConfig: { schemaVersion: 1, profiles: [], defaultLogicalModelId: 'reasoning' },
      })
    ).toBeNull();
  });
});

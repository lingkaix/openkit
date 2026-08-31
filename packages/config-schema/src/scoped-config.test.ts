import { describe, expect, it } from 'vitest';

import {
  GatewayConfigSchema,
  InternalRoleProfilesConfigSchema,
  UserConfigSchema,
} from './index.js';

describe('scoped runtime config schemas', () => {
  it('validates logical routes and requires the default logical model to exist', () => {
    const config = GatewayConfigSchema.parse({
      schemaVersion: 1,
      defaultLogicalModelId: 'reasoning',
      logicalModels: [
        {
          id: 'reasoning',
          displayName: 'Reasoning',
          routes: [
            { id: 'primary', providerProfileId: 'openai-primary', providerModel: 'gpt-5.2' },
            { id: 'backup', providerProfileId: 'openai-backup', providerModel: 'gpt-5.2' },
          ],
        },
      ],
    });

    expect(config.logicalModels[0]?.routes.map((route) => route.id)).toEqual(['primary', 'backup']);
    expect(() =>
      GatewayConfigSchema.parse({
        schemaVersion: 1,
        defaultLogicalModelId: 'missing',
        logicalModels: [],
      })
    ).toThrow();
  });

  it('validates personal per-Workspace preferences without accepting duplicate owners', () => {
    expect(
      UserConfigSchema.parse({
        schemaVersion: 1,
        workspaces: [
          {
            workspaceId: 'ws_a',
            agentId: 'agent_codex',
            profileId: 'review',
            logicalModelId: 'reasoning',
          },
        ],
      }).workspaces[0]
    ).toMatchObject({ agentId: 'agent_codex', workspaceId: 'ws_a' });
    expect(() =>
      UserConfigSchema.parse({
        schemaVersion: 1,
        workspaces: [{ workspaceId: 'ws_a' }, { workspaceId: 'ws_a' }],
      })
    ).toThrow();
  });

  it('validates only consumed internal-role profile fields', () => {
    expect(
      InternalRoleProfilesConfigSchema.parse({
        schemaVersion: 1,
        defaultLogicalModelId: 'fast',
        profiles: [
          {
            id: 'assistant-default',
            roleId: 'assistant',
            preferredLogicalModelId: 'fast',
          },
        ],
      }).profiles[0]?.roleId
    ).toBe('assistant');
    expect(() =>
      InternalRoleProfilesConfigSchema.parse({
        schemaVersion: 1,
        profiles: [
          {
            id: 'invalid',
            roleId: 'assistant',
            context: { maxTokens: 1_000, reservedTokens: 1_000 },
          },
        ],
      })
    ).toThrow();
  });
});

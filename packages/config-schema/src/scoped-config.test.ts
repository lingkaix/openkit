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
          contextManagement: [{ type: 'compaction', compactThreshold: 100_000 }],
          routes: [
            { id: 'primary', providerProfileId: 'openai-primary', providerModel: 'gpt-5.2' },
            { id: 'backup', providerProfileId: 'openai-backup', providerModel: 'gpt-5.2' },
          ],
        },
      ],
    });

    expect(config.logicalModels[0]?.routes.map((route) => route.id)).toEqual(['primary', 'backup']);
    expect(config.logicalModels[0]?.contextManagement).toEqual([
      { type: 'compaction', compactThreshold: 100_000 },
    ]);
    expect(() =>
      GatewayConfigSchema.parse({
        schemaVersion: 1,
        defaultLogicalModelId: 'missing',
        logicalModels: [],
      })
    ).toThrow();
  });

  it('admits routing booleans, strips additive keys, and rejects invalid core values', () => {
    const model = {
      id: 'tier',
      displayName: 'Tier',
      contextManagement: [{ type: 'compaction', compactThreshold: 8_000 }],
      routes: [{ id: 'primary', providerProfileId: 'provider', providerModel: 'model' }],
    };
    const parse = (routing: unknown) =>
      GatewayConfigSchema.parse({
        schemaVersion: 1,
        logicalModels: [{ ...model, routing }],
      }).logicalModels[0];
    expect(parse(undefined)?.routing).toBeUndefined();
    expect(parse({ autoFailover: false, futureStrategy: 'ignored' })?.routing).toEqual({
      autoFailover: false,
    });
    expect(parse({ autoFailover: true })?.routing).toEqual({ autoFailover: true });
    for (const routing of [{}, { autoFailover: 'false' }, null]) {
      expect(() => parse(routing)).toThrow();
    }
  });

  it('fails closed for unsupported required Gateway semantics', () => {
    expect(
      GatewayConfigSchema.parse({ schemaVersion: 1, requiredFeatures: [] }).logicalModels
    ).toEqual([]);
    expect(() =>
      GatewayConfigSchema.parse({
        schemaVersion: 1,
        requiredFeatures: ['gateway.routing.future-authority'],
      })
    ).toThrow(/gateway\.routing\.future-authority/);
  });

  it('admits one optional transcription route and strips unknown siblings', () => {
    const parsed = GatewayConfigSchema.parse({
      schemaVersion: 1,
      logicalModels: [],
      transcription: {
        id: 'voice',
        providerProfileId: 'speech',
        providerModel: 'whisper-1',
        extra: 'ignored',
      },
    });
    expect(parsed.transcription).toEqual({
      routes: [
        {
          id: 'voice',
          providerProfileId: 'speech',
          providerModel: 'whisper-1',
        },
      ],
    });
    expect(GatewayConfigSchema.parse({ schemaVersion: 1 }).transcription).toBeUndefined();
  });

  it('validates personal per-Workspace preferences without accepting duplicate owners', () => {
    expect(
      UserConfigSchema.parse({
        schemaVersion: 1,
        workspaces: [
          {
            workspaceId: 'ws_00000000-0000-7159-b04f-df2eaa9abaf0',
            agentId: 'agent_codex',
            profileId: 'review',
            logicalModelId: 'reasoning',
          },
        ],
      }).workspaces[0]
    ).toMatchObject({
      agentId: 'agent_codex',
      workspaceId: 'ws_00000000-0000-7159-b04f-df2eaa9abaf0',
    });
    expect(() =>
      UserConfigSchema.parse({
        schemaVersion: 1,
        workspaces: [
          { workspaceId: 'ws_00000000-0000-7159-b04f-df2eaa9abaf0' },
          { workspaceId: 'ws_00000000-0000-7159-b04f-df2eaa9abaf0' },
        ],
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
      }).profiles[0]
    ).toMatchObject({
      roleId: 'assistant',
      limits: { maxModelTurns: 16, maxToolCalls: 48, deadlineMs: 600_000 },
    });
    expect(
      InternalRoleProfilesConfigSchema.parse({
        schemaVersion: 1,
        profiles: [
          {
            id: 'invalid',
            roleId: 'assistant',
            context: { maxTokens: 1_000, reservedTokens: 1_000 },
          },
        ],
      }).profiles[0]
    ).not.toHaveProperty('context');
  });

  it('rejects duplicate logical model ids and duplicate route member ids', () => {
    const route = { id: 'primary', providerProfileId: 'openai-primary', providerModel: 'gpt-5.2' };
    const model = {
      id: 'reasoning',
      displayName: 'Reasoning',
      contextManagement: [{ type: 'compaction' as const, compactThreshold: 100_000 }],
      routes: [route],
    };

    const dupModels = GatewayConfigSchema.safeParse({
      schemaVersion: 1,
      logicalModels: [model, { ...model, displayName: 'Second' }],
    });
    expect(dupModels.success).toBe(false);
    if (!dupModels.success) {
      expect(dupModels.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['logicalModels', 1, 'id'],
          message: 'Duplicate id: reasoning.',
        })
      );
    }

    const dupRoutes = GatewayConfigSchema.safeParse({
      schemaVersion: 1,
      logicalModels: [{ ...model, routes: [route, { ...route, providerModel: 'gpt-5.3' }] }],
    });
    expect(dupRoutes.success).toBe(false);
    if (!dupRoutes.success) {
      expect(dupRoutes.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['logicalModels', 0, 'routes', 1, 'id'],
          message: 'Duplicate id: primary.',
        })
      );
    }
  });

  it('requires one positive compaction policy, non-empty routes, and a nonblank displayName', () => {
    const baseModel = {
      id: 'reasoning',
      displayName: '  Reasoning Model  ',
      contextManagement: [{ type: 'compaction', compactThreshold: 64_000, extra: 'ignored' }],
      routes: [
        { id: 'primary', providerProfileId: 'openai', providerModel: 'gpt-5', extra: 'ignored' },
      ],
    };
    const parsed = GatewayConfigSchema.parse({
      schemaVersion: 1,
      logicalModels: [baseModel],
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.requiredFeatures).toEqual([]);
    expect(parsed.logicalModels[0]?.displayName).toBe('Reasoning Model');
    expect(parsed.logicalModels[0]?.contextManagement).toEqual([
      { type: 'compaction', compactThreshold: 64_000 },
    ]);

    for (const invalidModel of [
      { ...baseModel, displayName: '   ' },
      { ...baseModel, contextManagement: [] },
      {
        ...baseModel,
        contextManagement: [baseModel.contextManagement[0], baseModel.contextManagement[0]],
      },
      { ...baseModel, contextManagement: [{ type: 'compaction', compactThreshold: 0 }] },
      { ...baseModel, contextManagement: [{ type: 'compaction', compactThreshold: -10 }] },
      { ...baseModel, contextManagement: [{ type: 'compaction', compactThreshold: 12.5 }] },
      { ...baseModel, routes: [] },
    ]) {
      expect(
        GatewayConfigSchema.safeParse({ schemaVersion: 1, logicalModels: [invalidModel] }).success
      ).toBe(false);
    }
  });

  it('applies user preference defaults, strips unknown keys, and scopes role uniqueness per workspace', () => {
    const wsA = 'ws_00000000-0000-7159-b04f-df2eaa9abaf0';
    const wsB = 'ws_00000000-0000-7159-b04f-df2eaa9abaf1';
    expect(UserConfigSchema.parse({ schemaVersion: 1, unknownRoot: true })).toEqual({
      schemaVersion: 1,
      workspaces: [],
    });

    const acrossWorkspaces = UserConfigSchema.parse({
      schemaVersion: 1,
      workspaces: [
        {
          workspaceId: wsA,
          unknownWorkspaceField: 'ignored',
          internalRoles: [{ roleId: 'assistant', profileId: 'fast', unknownRoleField: 'ignored' }],
        },
        {
          workspaceId: wsB,
          internalRoles: [{ roleId: 'assistant', profileId: 'deep' }],
        },
      ],
    });
    expect(acrossWorkspaces.workspaces[0]).toEqual({
      workspaceId: wsA,
      internalRoles: [{ roleId: 'assistant', profileId: 'fast' }],
    });
    expect(acrossWorkspaces.workspaces[1]?.internalRoles).toEqual([
      { roleId: 'assistant', profileId: 'deep' },
    ]);

    const duplicateRole = UserConfigSchema.safeParse({
      schemaVersion: 1,
      workspaces: [
        {
          workspaceId: wsA,
          internalRoles: [
            { roleId: 'assistant', profileId: 'fast' },
            { roleId: 'assistant', profileId: 'deep' },
          ],
        },
      ],
    });
    expect(duplicateRole.success).toBe(false);
    if (!duplicateRole.success) {
      expect(duplicateRole.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['workspaces', 0, 'internalRoles', 1, 'roleId'],
          message: 'Duplicate internal role preference: assistant.',
        })
      );
    }

    for (const feature of ['openkit.workspace-resource-policy.v1', 'user.unregistered.feature']) {
      expect(
        UserConfigSchema.safeParse({ schemaVersion: 1, requiredFeatures: [feature] }).success
      ).toBe(false);
    }
  });

  it('rejects duplicate internal-role profile ids and invalid limit bounds', () => {
    const dup = InternalRoleProfilesConfigSchema.safeParse({
      schemaVersion: 1,
      profiles: [
        { id: 'shared-profile', roleId: 'assistant' },
        { id: 'shared-profile', roleId: 'knowledge-manager' },
      ],
    });
    expect(dup.success).toBe(false);
    if (!dup.success) {
      expect(dup.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['profiles', 1, 'id'],
          message: 'Duplicate internal-role profile: shared-profile.',
        })
      );
    }

    for (const limits of [
      { maxModelTurns: 0, maxToolCalls: 1, deadlineMs: 1_000 },
      { maxModelTurns: 1, maxToolCalls: 0, deadlineMs: 1_000 },
      { maxModelTurns: 1.5, maxToolCalls: 1, deadlineMs: 1_000 },
      { maxModelTurns: 1, maxToolCalls: 1, deadlineMs: 1_000, extraLimit: 5 },
    ]) {
      expect(
        InternalRoleProfilesConfigSchema.safeParse({
          schemaVersion: 1,
          profiles: [{ id: 'p1', roleId: 'assistant', limits }],
        }).success
      ).toBe(false);
    }
  });
});

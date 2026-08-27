import { describe, expect, it } from 'vitest';

import {
  AuthoredAgentProviderSchema,
  getConfigSchemaCatalog,
  OpenKitProviderInstanceSchema,
  ProviderProfileSchema,
} from './index.js';

describe('provider config schema', () => {
  it('derives server provider fields from the canonical profile schema', () => {
    const sharedFields = [
      'baseUrl',
      'defaultModel',
      'displayName',
      'extensions',
      'id',
      'kind',
      'models',
      'secretRef',
    ] as const;

    for (const field of sharedFields) {
      expect(OpenKitProviderInstanceSchema.shape[field]).toBe(ProviderProfileSchema.shape[field]);
    }

    const provider = {
      displayName: 'OpenAI',
      id: 'openai',
      kind: 'direct' as const,
      models: ['gpt-5'],
    };

    expect(OpenKitProviderInstanceSchema.safeParse(provider).success).toBe(false);
    expect(
      OpenKitProviderInstanceSchema.safeParse({
        ...provider,
        category: 'inference',
        vendor: 'openai',
      }).success
    ).toBe(false);
    expect(
      OpenKitProviderInstanceSchema.safeParse({
        ...provider,
        readiness: { status: 'ready' },
        vendor: 'openai',
      }).success
    ).toBe(false);
  });

  it('accepts explicit subscription accounts for normalized supported OAuth families', () => {
    const extension = {
      openkit: {
        subscriptionAccount: {
          accountSlotId: 'work_chatgpt-1',
        },
      },
    };
    const profiles = [
      {
        displayName: 'OpenAI Codex Work',
        id: ' OPENAI-CODEX ',
        kind: 'oauth',
        models: ['openai-codex/gpt-5.1-codex'],
        vendor: 'catalog',
      },
      {
        displayName: 'xAI Work',
        id: 'grok-work',
        kind: 'oauth',
        models: ['xai/grok-4'],
        vendor: ' XAI ',
      },
    ] as const;

    for (const profile of profiles) {
      for (const schema of [ProviderProfileSchema, OpenKitProviderInstanceSchema]) {
        expect(schema.parse({ ...profile, extensions: extension }).extensions?.openkit).toEqual(
          extension.openkit
        );
      }
    }
  });

  it('rejects conflicting normalized subscription provider families', () => {
    const profile = {
      displayName: 'Conflicting Subscription Provider',
      extensions: {
        openkit: {
          subscriptionAccount: {
            accountSlotId: 'work',
          },
        },
      },
      id: ' XAI ',
      kind: 'oauth' as const,
      models: ['demo'],
      vendor: ' OpenAI-Codex ',
    };

    expect(ProviderProfileSchema.safeParse(profile).success).toBe(false);
    expect(OpenKitProviderInstanceSchema.safeParse(profile).success).toBe(false);
  });

  it('rejects invalid subscription-account profile combinations', () => {
    const extension = {
      openkit: {
        subscriptionAccount: {
          accountSlotId: 'work',
        },
      },
    };
    const codexProfile = {
      displayName: 'OpenAI Codex',
      id: 'openai_codex',
      kind: 'oauth' as const,
      models: ['openai-codex/gpt-5.1-codex'],
      vendor: 'openai_codex',
    };
    const xaiProfile = {
      displayName: 'xAI',
      id: 'xai',
      kind: 'oauth' as const,
      models: ['xai/grok-4'],
      vendor: 'xai',
    };

    for (const schema of [ProviderProfileSchema, OpenKitProviderInstanceSchema]) {
      for (const profile of [
        codexProfile,
        xaiProfile,
        { ...codexProfile, extensions: { openkit: { subscriptionAccount: {} } } },
        { ...codexProfile, extensions: extension, secretRef: 'vault://codex' },
        { ...xaiProfile, baseUrl: 'https://api.x.ai/v1', extensions: extension },
        {
          ...codexProfile,
          extensions: {
            openkit: {
              subscriptionAccount: {
                accountSlotId: 'work',
                subscriptionProviderId: 'openai-codex',
              },
            },
          },
        },
        {
          ...codexProfile,
          id: 'openai-codex-work',
          vendor: 'openai',
          extensions: extension,
        },
        { ...xaiProfile, kind: 'direct' as const, extensions: extension },
      ]) {
        expect(schema.safeParse(profile).success).toBe(false);
      }

      for (const accountSlotId of ['Work', '../work', '', 'a'.repeat(65)]) {
        expect(
          schema.safeParse({
            ...codexProfile,
            extensions: {
              openkit: {
                subscriptionAccount: {
                  accountSlotId,
                },
              },
            },
          }).success
        ).toBe(false);
      }
    }
  });

  it('keeps direct xAI profiles outside subscription-account rules', () => {
    const profile = {
      baseUrl: 'https://api.x.ai/v1',
      displayName: 'xAI API',
      id: 'xai',
      kind: 'direct' as const,
      models: ['xai/grok-4'],
      secretRef: 'vault://xai',
      vendor: 'xai',
    };

    expect(ProviderProfileSchema.safeParse(profile).success).toBe(true);
    expect(OpenKitProviderInstanceSchema.safeParse(profile).success).toBe(true);
  });

  it('keeps vendor extensions open and the OpenKit namespace strict', () => {
    const parsed = ProviderProfileSchema.parse({
      id: 'custom',
      displayName: 'Custom',
      kind: 'custom',
      models: ['demo'],
      extensions: {
        vendorSpecific: {
          enabled: true,
        },
      },
    });
    const providerSchema = getConfigSchemaCatalog().find(
      (entry) => entry.kind === 'provider'
    )?.schema;

    expect(parsed.extensions?.vendorSpecific).toEqual({ enabled: true });
    for (const schema of [ProviderProfileSchema, OpenKitProviderInstanceSchema]) {
      for (const openkit of [
        {
          codexOAuth: {
            accountSlotId: 'work',
          },
        },
        {
          unknownOpenKitField: true,
        },
      ]) {
        expect(
          schema.safeParse({
            id: 'custom',
            displayName: 'Custom',
            kind: 'custom',
            models: ['demo'],
            vendor: 'custom',
            extensions: {
              openkit,
            },
          }).success
        ).toBe(false);
      }
    }
    expect(JSON.stringify(providerSchema)).not.toContain('codexOAuth');
    expect(JSON.stringify(providerSchema)).toContain('subscriptionAccount');
    expect(JSON.stringify(providerSchema)).toContain('accountSlotId');
  });

  it('omits unowned provider fields from generated provider and server schemas', () => {
    const schemas = getConfigSchemaCatalog().filter(({ kind }) =>
      ['provider', 'server'].includes(kind)
    );

    expect(schemas).toHaveLength(2);

    for (const { schema } of schemas) {
      expect(JSON.stringify(schema)).not.toContain('extraBody');
      expect(JSON.stringify(schema)).not.toContain('extraHeaders');
    }
  });

  it('rejects raw inline provider secrets', () => {
    for (const field of ['apiKey', 'clientSecret', 'secret', 'token'] as const) {
      expect(() =>
        ProviderProfileSchema.parse({
          id: `direct-${field}`,
          displayName: 'Direct Provider',
          kind: 'direct',
          models: ['demo'],
          [field]: 'raw-secret',
        })
      ).toThrow();

      expect(() =>
        OpenKitProviderInstanceSchema.parse({
          id: `direct-${field}`,
          vendor: 'openai',
          displayName: 'Direct Provider',
          kind: 'direct',
          models: ['demo'],
          [field]: 'raw-secret',
        })
      ).toThrow();
    }
  });

  it('rejects provider credential aliases outside secretRef', () => {
    const profile = {
      id: 'direct',
      displayName: 'Direct Provider',
      kind: 'direct' as const,
      models: ['demo'],
    };

    for (const credentialAlias of [
      { baseUrl: 'https://user@example.com/v1' },
      { baseUrl: 'https://:password@example.com/v1' },
      { extraHeaders: { Authorization: 'Bearer raw-secret' } },
      { extraHeaders: { aUtHoRiZaTiOn: 'Bearer raw-secret' } },
      { extraHeaders: { 'Proxy-Authorization': 'Bearer raw-secret' } },
      { extraHeaders: { Cookie: 'session=raw-secret' } },
      { extraHeaders: { 'x-api-key': 'raw-secret' } },
      { extraBody: { apiKey: 'raw-secret' } },
      { extraBody: { access_token: 'raw-secret' } },
      { extraBody: { token: 'raw-secret' } },
      { extraBody: { secret: 'raw-secret' } },
      { extraBody: { clientSecret: 'raw-secret' } },
      { extraBody: { CLIENTSECRET: 'raw-secret' } },
      { extraBody: { password: 'raw-secret' } },
    ]) {
      expect(ProviderProfileSchema.safeParse({ ...profile, ...credentialAlias }).success).toBe(
        false
      );
      expect(
        OpenKitProviderInstanceSchema.safeParse({
          ...profile,
          vendor: 'openai',
          ...credentialAlias,
        }).success
      ).toBe(false);
    }
  });

  it('reports invalid provider URLs as schema failures', () => {
    expect(
      ProviderProfileSchema.safeParse({
        id: 'invalid-url',
        displayName: 'Invalid URL',
        kind: 'custom',
        models: ['demo'],
        baseUrl: 'not-a-url',
      }).success
    ).toBe(false);
  });

  it('rejects provider fields without a runtime owner', () => {
    const profile = {
      id: 'openai',
      displayName: 'OpenAI',
      kind: 'direct' as const,
      models: ['gpt-5'],
    };
    const serverProvider = { ...profile, vendor: 'openai' };

    for (const field of [
      { extraBody: { service_tier: 'auto' } },
      { extraHeaders: { 'x-provider-feature': 'enabled' } },
      { metadata: { region: 'us' } },
      { timeoutMs: 30_000 },
      { retry: { attempts: 3 } },
      { retry: { backoffMs: 100 } },
      { unknownProviderField: true },
    ]) {
      expect(() => ProviderProfileSchema.parse({ ...profile, ...field })).toThrow();
      expect(() => OpenKitProviderInstanceSchema.parse({ ...serverProvider, ...field })).toThrow();
    }
  });

  it('keeps explicitly owned provider fields', () => {
    const parsed = ProviderProfileSchema.parse({
      id: 'openai',
      displayName: 'OpenAI',
      kind: 'direct',
      models: ['gpt-5'],
      category: 'inference',
      vendor: 'openai',
      secretRef: 'vault://provider_openai',
    });

    expect(parsed.vendor).toBe('openai');
    expect(parsed.category).toBe('inference');
    expect(parsed.secretRef).toBe('vault://provider_openai');
  });

  it('rejects inline agent provider config', () => {
    expect(() =>
      AuthoredAgentProviderSchema.parse({
        inline: {
          id: 'direct',
          model: 'demo',
        },
      })
    ).toThrow();
  });
});

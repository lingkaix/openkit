import { describe, expect, it } from 'vitest';

import {
  AuthoredAgentProviderSchema,
  CodexOAuthAccountSlotIdSchema,
  getConfigSchemaCatalog,
  OpenKitProviderInstanceSchema,
  ProviderProfileSchema,
} from './index.js';

describe('provider config schema', () => {
  it('accepts Codex OAuth account slot references in provider profiles and server providers', () => {
    const extension = {
      openkit: {
        codexOAuth: {
          accountSlotId: 'work_chatgpt-1',
        },
      },
    };

    expect(
      ProviderProfileSchema.parse({
        id: 'openai-codex-work',
        displayName: 'OpenAI Codex Work',
        kind: 'oauth',
        models: ['openai-codex/gpt-5.1-codex'],
        extensions: extension,
      }).extensions?.openkit?.codexOAuth?.accountSlotId
    ).toBe('work_chatgpt-1');

    expect(
      OpenKitProviderInstanceSchema.parse({
        id: 'openai-codex-work',
        vendor: 'openai_codex',
        displayName: 'OpenAI Codex Work',
        kind: 'oauth',
        models: ['openai-codex/gpt-5.1-codex'],
        extensions: extension,
      }).extensions?.openkit?.codexOAuth?.accountSlotId
    ).toBe('work_chatgpt-1');
  });

  it('rejects invalid Codex OAuth account slot ids', () => {
    expect(() => CodexOAuthAccountSlotIdSchema.parse('Work')).toThrow();
    expect(() => CodexOAuthAccountSlotIdSchema.parse('../work')).toThrow();
    expect(() => CodexOAuthAccountSlotIdSchema.parse('')).toThrow();
    expect(() => CodexOAuthAccountSlotIdSchema.parse('a'.repeat(65))).toThrow();

    expect(() =>
      ProviderProfileSchema.parse({
        id: 'openai-codex-invalid',
        displayName: 'OpenAI Codex Invalid',
        kind: 'oauth',
        models: ['openai-codex/gpt-5.1-codex'],
        extensions: {
          openkit: {
            codexOAuth: {
              accountSlotId: '../escape',
            },
          },
        },
      })
    ).toThrow();
  });

  it('preserves unrelated provider extensions and exposes Codex OAuth schema hints', () => {
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
    expect(JSON.stringify(providerSchema)).toContain('codexOAuth');
    expect(JSON.stringify(providerSchema)).toContain('accountSlotId');
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

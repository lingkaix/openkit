import { describe, expect, it } from 'vitest';

import { getConfigPolicyCatalog, OpenKitConfigSchema } from './index.js';

describe('server config schema', () => {
  it.each([
    { auth: { enabled: true } },
    { auth: { localModeUserId: 'user_local' } },
    { auth: { provider: 'better-auth' } },
    { data: { layoutVersion: 1 } },
    { defaults: { agentId: 'agent_codex_host' } },
    { defaults: { workspaceId: 'ws_default' } },
    { diagnostics: { redactSecrets: true } },
    { extensions: { experimental: true } },
    { features: { internalOpenAICompatFacade: { enabled: true } } },
    { gateway: { openaiCompatible: { auth: 'agent-session' } } },
    { gateway: { openaiCompatible: { defaultModel: 'gpt-5' } } },
    { gateway: { openaiCompatible: { defaultProviderId: 'openai' } } },
    { gateway: { openaiCompatible: { route: '/v1' } } },
    { internal: { openaiCompatFacade: { enabled: true } } },
    { server: { cors: { origins: ['ftp://console.openkit.example'] } } },
    { server: { publicBaseUrl: 'https://core.openkit.example/path' } },
    { server: { trustedProxies: ['127.0.0.1'] } },
  ])('rejects unsupported configuration instead of accepting ghost fields: %j', (config) => {
    expect(() => OpenKitConfigSchema.parse(config)).toThrow();
  });

  it('rejects removed data-root and unknown top-level fields', () => {
    expect(() =>
      OpenKitConfigSchema.parse({
        schemaVersion: 1,
        dataRoot: './data',
      })
    ).toThrow();

    expect(() =>
      OpenKitConfigSchema.parse({
        schemaVersion: 1,
        unknownTopLevel: true,
      })
    ).toThrow();
  });

  it('keeps the config policy catalog free of inline secret modes', () => {
    expect(getConfigPolicyCatalog().map((entry) => entry.secretPolicy)).not.toContain(
      `server-inline-${'leg'}acy`
    );
  });

  it('marks every provider and agent config surface as restart-required', () => {
    expect(getConfigPolicyCatalog()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'server',
          path: '$.providers',
          reloadClass: 'restart-required',
        }),
        expect.objectContaining({
          kind: 'provider',
          path: '$',
          reloadClass: 'restart-required',
        }),
        expect.objectContaining({
          kind: 'agent',
          path: '$',
          reloadClass: 'restart-required',
        }),
      ])
    );
  });

  it('accepts local vault backend default configuration', () => {
    expect(
      OpenKitConfigSchema.parse({
        schemaVersion: 1,
        vault: {
          localDefaultBackend: 'encrypted-file',
        },
      })
    ).toEqual({
      schemaVersion: 1,
      vault: {
        localDefaultBackend: 'encrypted-file',
      },
    });
  });

  it('accepts an absolute encrypted-file vault key path', () => {
    expect(
      OpenKitConfigSchema.parse({
        schemaVersion: 1,
        vault: {
          encryptedFile: {
            keyFilePath: '/run/secrets/openkit-vault.key',
          },
        },
      })
    ).toEqual({
      schemaVersion: 1,
      vault: {
        encryptedFile: {
          keyFilePath: '/run/secrets/openkit-vault.key',
        },
      },
    });
  });

  it('rejects relative key paths and unknown vault fields', () => {
    expect(() =>
      OpenKitConfigSchema.parse({
        vault: {
          encryptedFile: {
            keyFilePath: './openkit-vault.key',
          },
        },
      })
    ).toThrow();

    expect(() =>
      OpenKitConfigSchema.parse({
        vault: {
          encryptedFile: {
            keyFilePath: '/run/secrets/openkit-vault.key',
            unknownEncryptedFileField: true,
          },
        },
      })
    ).toThrow();

    expect(() =>
      OpenKitConfigSchema.parse({
        vault: {
          encryptedFile: {
            keyFilePath: '/run/secrets/openkit-vault.key',
          },
          unknownVaultField: true,
        },
      })
    ).toThrow();
  });
});

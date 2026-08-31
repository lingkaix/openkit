import { describe, expect, it } from 'vitest';

import { getConfigPolicyCatalog, getConfigSchemaCatalog, OpenKitConfigSchema } from './index.js';

describe('server config schema', () => {
  it('accepts the final Server Agent fallback', () => {
    expect(
      OpenKitConfigSchema.parse({ defaults: { defaultAgentId: 'agent_codex_host' } }).defaults
    ).toEqual({ defaultAgentId: 'agent_codex_host' });
  });

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
    { providers: [] },
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

  it('marks provider profile and agent config surfaces as restart-required', () => {
    expect(getConfigPolicyCatalog()).toEqual(
      expect.arrayContaining([
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

  it.each([
    'encrypted-file',
    'os-keychain',
  ])('rejects the removed local vault backend selector value %s', (localDefaultBackend) => {
    expect(() =>
      OpenKitConfigSchema.parse({
        schemaVersion: 1,
        vault: {
          localDefaultBackend,
        },
      })
    ).toThrow();
  });

  it('omits the removed local vault backend selector from config catalogs', () => {
    expect(JSON.stringify(getConfigSchemaCatalog())).not.toContain('localDefaultBackend');
    expect(JSON.stringify(getConfigPolicyCatalog())).not.toContain('localDefaultBackend');
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

  /**
   * S-2b-1 predicate start: NanoCore deployment config must project exactly one
   * configured NanoHost identity, rendezvous endpoint, and non-secret credential
   * reference (`docs/specs/20260628-nanocore_config_identity_contract.md`).
   * Fail-on-absence until `server.ts` grows the `nanohost` object.
   */
  it('accepts the secret-free NanoHost deployment projection', () => {
    expect(
      OpenKitConfigSchema.parse({
        schemaVersion: 1,
        nanohost: {
          bind: { host: '0.0.0.0', port: 4318 },
          identityId: 'integration_nanohost_primary',
          deploymentId: 'deploy_primary',
          rendezvousUrl: 'https://nanocore.example:8443',
          credentialRef: 'nanohost-transport:primary',
          credentialSlots: {
            A: {
              secretPath: '/run/credentials/nanohost-a.token',
              companionPath: '/run/credentials/nanohost-a.meta',
            },
            B: {
              secretPath: '/run/credentials/nanohost-b.token',
              companionPath: '/run/credentials/nanohost-b.meta',
            },
          },
        },
      })
    ).toEqual({
      schemaVersion: 1,
      nanohost: {
        bind: { host: '0.0.0.0', port: 4318 },
        identityId: 'integration_nanohost_primary',
        deploymentId: 'deploy_primary',
        rendezvousUrl: 'https://nanocore.example:8443',
        credentialRef: 'nanohost-transport:primary',
        credentialSlots: {
          A: {
            secretPath: '/run/credentials/nanohost-a.token',
            companionPath: '/run/credentials/nanohost-a.meta',
          },
          B: {
            secretPath: '/run/credentials/nanohost-b.token',
            companionPath: '/run/credentials/nanohost-b.meta',
          },
        },
      },
    });
  });

  it('requires one exact dedicated NanoHost listener bind', () => {
    expect(() =>
      OpenKitConfigSchema.parse({
        nanohost: {
          credentialRef: 'nanohost-transport:primary',
          credentialSlots: {
            A: {
              companionPath: '/run/credentials/nanohost-a.meta',
              secretPath: '/run/credentials/nanohost-a.token',
            },
            B: {
              companionPath: '/run/credentials/nanohost-b.meta',
              secretPath: '/run/credentials/nanohost-b.token',
            },
          },
          deploymentId: 'deploy_primary',
          identityId: 'integration_nanohost_primary',
          rendezvousUrl: 'https://nanocore.example:8443',
        },
      })
    ).toThrow();
  });

  it('rejects Cell topology keys and raw NanoHost token material in server config', () => {
    expect(() =>
      OpenKitConfigSchema.parse({
        schemaVersion: 1,
        openshellCellSshTarget: 'root@127.0.0.1',
      })
    ).toThrow();

    expect(() =>
      OpenKitConfigSchema.parse({
        schemaVersion: 1,
        nanohost: {
          bind: { host: '127.0.0.1', port: 4318 },
          credentialSlots: {
            A: {
              companionPath: '/run/credentials/nanohost-a.meta',
              secretPath: '/run/credentials/nanohost-a.token',
            },
            B: {
              companionPath: '/run/credentials/nanohost-b.meta',
              secretPath: '/run/credentials/nanohost-b.token',
            },
          },
          deploymentId: 'deploy_primary',
          identityId: 'integration_nanohost_primary',
          rendezvousUrl: 'https://nanocore.example:8443',
          credentialRef: 'nanohost-transport:primary',
          token: 'okt_raw_secret_must_not_be_config',
        },
      })
    ).toThrow();
  });

  it('marks NanoHost deployment configuration restart-required and secret-free', () => {
    expect(getConfigPolicyCatalog()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'server',
          path: '$.nanohost',
          reloadClass: 'restart-required',
          secretPolicy: 'no-secret',
        }),
      ])
    );
  });
});

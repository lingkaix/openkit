import { randomUUID } from 'node:crypto';
import { allocateEntityId, RETAINED_FORMAT_VERSION } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';

import {
  getConfigPolicyCatalog,
  getConfigSchemaCatalog,
  NANO_HOST_DEFAULT_MAX_ACTIVE_TURNS,
  OpenKitConfigSchema,
} from './index.js';

describe('server config schema', () => {
  it('admits authored Server format v1 with descriptive additions', () => {
    expect(
      OpenKitConfigSchema.parse({
        schemaVersion: RETAINED_FORMAT_VERSION,
        futureNote: 'retained description',
      })
    ).toEqual({ schemaVersion: RETAINED_FORMAT_VERSION });
  });

  it('refuses missing or unknown authored Server format versions', () => {
    expect(OpenKitConfigSchema.safeParse({}).success).toBe(false);
    expect(OpenKitConfigSchema.safeParse({ schemaVersion: 2 }).success).toBe(false);
  });

  it('admits an explicit finite Worker Git-read maintenance assignment without changing omission', () => {
    const assignment = {
      responsibleUserId: allocateEntityId('usr'),
      agentId: randomUUID(),
      networkGrantId: 'git-read',
      host: 'git.example.com',
      port: 443,
      protocol: 'rest',
      repositoryPaths: ['/team/project.git'],
      binaries: ['/usr/bin/git'],
      validFrom: '2026-01-01T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
      enabled: true,
    };
    expect(
      OpenKitConfigSchema.safeParse({
        schemaVersion: RETAINED_FORMAT_VERSION,
        policy: { workerGitReadMaintenance: [assignment] },
      }).success
    ).toBe(true);
    expect(
      OpenKitConfigSchema.parse({ schemaVersion: RETAINED_FORMAT_VERSION }).policy
    ).toBeUndefined();
    for (const change of [
      { enabled: undefined },
      { responsibleUserId: allocateEntityId('th') },
      { responsibleUserId: randomUUID() },
      { protocol: 'grpc' },
      { port: 0 },
      { host: '*.example.com' },
      { host: 'git.example.com:443' },
      { host: 'GIT.example.com' },
      { host: 'git.example.com/path' },
      { repositoryPaths: [] },
      { repositoryPaths: ['/team/*'] },
      { repositoryPaths: ['/team/../project.git'] },
      { repositoryPaths: ['/team/%2fproject.git'] },
      { repositoryPaths: ['/team/project.git?service=git-upload-pack'] },
      { repositoryPaths: ['/team/project.git', '/team/project.git'] },
      { binaries: ['git'] },
      { binaries: ['/usr/bin/../bin/git'] },
      { expiresAt: assignment.validFrom },
      { validFrom: '2026-01-01T00:00:00+00:00' },
      { action: 'arbitrary' },
    ]) {
      expect(
        OpenKitConfigSchema.safeParse({
          schemaVersion: RETAINED_FORMAT_VERSION,
          policy: { workerGitReadMaintenance: [{ ...assignment, ...change }] },
        }).success,
        JSON.stringify(change)
      ).toBe(false);
    }
    expect(
      OpenKitConfigSchema.safeParse({
        schemaVersion: RETAINED_FORMAT_VERSION,
        policy: {
          workerGitReadMaintenance: [assignment, { ...assignment, enabled: false }],
        },
      }).success
    ).toBe(false);
  });
  it('admits an authored positive Sandbox active-Turn bound with a default of twenty', () => {
    const nanohost = {
      bind: { host: '127.0.0.1', port: 9443 },
      credentialRef: 'nanohost-slot',
      credentialSlots: {
        A: { companionPath: '/run/nanohost/a.json', secretPath: '/run/nanohost/a.token' },
        B: { companionPath: '/run/nanohost/b.json', secretPath: '/run/nanohost/b.token' },
      },
      deploymentId: 'dep_00000000-0000-7780-8ff7-8a77c50b1701',
      identityId: 'host',
      rendezvousUrl: 'https://core.example',
    };
    expect(NANO_HOST_DEFAULT_MAX_ACTIVE_TURNS).toBe(20);
    expect(
      OpenKitConfigSchema.parse({ schemaVersion: RETAINED_FORMAT_VERSION, nanohost }).nanohost
        ?.maxActiveTurnsPerSandbox
    ).toBeUndefined();
    expect(
      OpenKitConfigSchema.parse({
        schemaVersion: RETAINED_FORMAT_VERSION,
        nanohost: { ...nanohost, maxActiveTurnsPerSandbox: 8 },
      }).nanohost?.maxActiveTurnsPerSandbox
    ).toBe(8);
    for (const maxActiveTurnsPerSandbox of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        OpenKitConfigSchema.safeParse({
          schemaVersion: RETAINED_FORMAT_VERSION,
          nanohost: { ...nanohost, maxActiveTurnsPerSandbox },
        }).success
      ).toBe(false);
    }
  });

  it('defaults work-data capture to off on the server policy switch', () => {
    expect(
      OpenKitConfigSchema.parse({ schemaVersion: RETAINED_FORMAT_VERSION }).policy
    ).toBeUndefined();
    expect(
      OpenKitConfigSchema.parse({
        schemaVersion: RETAINED_FORMAT_VERSION,
        policy: { workDataCapture: {} },
      }).policy?.workDataCapture
    ).toEqual({ value: 'off' });
    expect(
      OpenKitConfigSchema.parse({
        schemaVersion: RETAINED_FORMAT_VERSION,
        policy: { workDataCapture: { value: 'on' } },
      }).policy?.workDataCapture
    ).toEqual({ value: 'on' });
    expect(
      OpenKitConfigSchema.safeParse({
        schemaVersion: RETAINED_FORMAT_VERSION,
        policy: { workDataCapture: { value: 'maybe' } },
      }).success
    ).toBe(false);
  });

  it('accepts deployment-owned approval modes for exact Workspaces', () => {
    const policy = {
      workspaceApprovalModes: {
        ws_trusted: { 'repo.push': 'auto_allow' },
        ws_review: { 'repo.push': 'require_human_approval' },
      },
    };
    expect(
      OpenKitConfigSchema.parse({ schemaVersion: RETAINED_FORMAT_VERSION, policy }).policy
    ).toEqual(policy);
    expect(
      OpenKitConfigSchema.parse({ schemaVersion: RETAINED_FORMAT_VERSION }).policy
    ).toBeUndefined();
    for (const modes of [{ 'repo.push': 'allow' }, { 'tool.use': 'auto_allow' }]) {
      expect(
        OpenKitConfigSchema.safeParse({
          schemaVersion: RETAINED_FORMAT_VERSION,
          policy: { workspaceApprovalModes: { ws_trusted: modes } },
        }).success
      ).toBe(false);
    }
    expect(getConfigPolicyCatalog()).toContainEqual(
      expect.objectContaining({
        kind: 'server',
        path: '$.policy',
        reloadClass: 'restart-required',
        workspaceOverride: 'forbidden',
      })
    );
  });

  it('accepts the final Server Agent fallback', () => {
    expect(
      OpenKitConfigSchema.parse({
        schemaVersion: RETAINED_FORMAT_VERSION,
        defaults: { defaultAgentId: 'agent_codex_host' },
      }).defaults
    ).toEqual({ defaultAgentId: 'agent_codex_host' });
  });

  it.each([
    { auth: { enabled: true } },
    { auth: { localModeUserId: 'usr_00000000-0000-7000-8000-000000000001' } },
    { auth: { provider: 'better-auth' } },
    { defaults: { agentId: 'agent_codex_host' } },
    { defaults: { workspaceId: 'ws_00000000-0000-7345-bbf3-167695f526ce' } },
    { server: { cors: { origins: ['ftp://console.openkit.example'] } } },
    { server: { publicBaseUrl: 'https://core.openkit.example/path' } },
    { server: { trustedProxies: ['127.0.0.1'] } },
  ])('rejects unsupported configuration instead of accepting ghost fields: %j', (config) => {
    expect(() =>
      OpenKitConfigSchema.parse({ schemaVersion: RETAINED_FORMAT_VERSION, ...config })
    ).toThrow();
  });

  it('strips unknown top-level fields while retaining strict known sections', () => {
    expect(
      OpenKitConfigSchema.parse({
        schemaVersion: RETAINED_FORMAT_VERSION,
        dataRoot: './data',
        unknownTopLevel: true,
      })
    ).toEqual({ schemaVersion: RETAINED_FORMAT_VERSION });
    expect(() =>
      OpenKitConfigSchema.parse({
        schemaVersion: RETAINED_FORMAT_VERSION,
        auth: { unknownTopLevel: true },
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
        schemaVersion: RETAINED_FORMAT_VERSION,
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
        schemaVersion: RETAINED_FORMAT_VERSION,
        vault: {
          encryptedFile: {
            keyFilePath: '/run/secrets/openkit-vault.key',
          },
        },
      })
    ).toEqual({
      schemaVersion: RETAINED_FORMAT_VERSION,
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
        schemaVersion: RETAINED_FORMAT_VERSION,
        vault: {
          encryptedFile: {
            keyFilePath: './openkit-vault.key',
          },
        },
      })
    ).toThrow();

    expect(() =>
      OpenKitConfigSchema.parse({
        schemaVersion: RETAINED_FORMAT_VERSION,
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
        schemaVersion: RETAINED_FORMAT_VERSION,
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
        schemaVersion: RETAINED_FORMAT_VERSION,
        nanohost: {
          bind: { host: '0.0.0.0', port: 4318 },
          identityId: 'integration_nanohost_primary',
          deploymentId: 'dep_00000000-0000-7bdd-bdc3-910a52eaec87',
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
      schemaVersion: RETAINED_FORMAT_VERSION,
      nanohost: {
        bind: { host: '0.0.0.0', port: 4318 },
        identityId: 'integration_nanohost_primary',
        deploymentId: 'dep_00000000-0000-7bdd-bdc3-910a52eaec87',
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
        schemaVersion: RETAINED_FORMAT_VERSION,
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
          deploymentId: 'dep_00000000-0000-7bdd-bdc3-910a52eaec87',
          identityId: 'integration_nanohost_primary',
          rendezvousUrl: 'https://nanocore.example:8443',
        },
      })
    ).toThrow();
  });

  it('ignores unknown top-level Cell topology keys and rejects raw NanoHost token material', () => {
    expect(
      OpenKitConfigSchema.parse({
        schemaVersion: RETAINED_FORMAT_VERSION,
        openshellCellSshTarget: 'root@127.0.0.1',
      })
    ).toEqual({ schemaVersion: RETAINED_FORMAT_VERSION });

    expect(() =>
      OpenKitConfigSchema.parse({
        schemaVersion: RETAINED_FORMAT_VERSION,
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
          deploymentId: 'dep_00000000-0000-7bdd-bdc3-910a52eaec87',
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

  it('accepts optional app-update host identity with absolute key paths', () => {
    expect(
      OpenKitConfigSchema.parse({
        schemaVersion: RETAINED_FORMAT_VERSION,
        appUpdate: {
          host: '127.0.0.1',
          user: 'openkit-update',
          port: 22,
          identityFile: '/run/openkit/app-update/id_ed25519',
          knownHostsFile: '/run/openkit/app-update/known_hosts',
        },
      }).appUpdate
    ).toEqual({
      host: '127.0.0.1',
      user: 'openkit-update',
      port: 22,
      identityFile: '/run/openkit/app-update/id_ed25519',
      knownHostsFile: '/run/openkit/app-update/known_hosts',
    });
  });

  it.each([
    {
      identityFile: 'id_ed25519',
      knownHostsFile: '/run/openkit/app-update/known_hosts',
    },
    {
      identityFile: '/run/openkit/app-update/id_ed25519',
      knownHostsFile: 'known_hosts',
    },
    {
      identityFile: '/run/openkit/app-update/id_ed25519',
      knownHostsFile: '/run/openkit/app-update/id_ed25519',
    },
  ])('rejects app-update key paths that are relative or not distinct: %j', (paths) => {
    expect(() =>
      OpenKitConfigSchema.parse({
        schemaVersion: RETAINED_FORMAT_VERSION,
        appUpdate: {
          host: '127.0.0.1',
          user: 'openkit-update',
          port: 22,
          ...paths,
        },
      })
    ).toThrow();
  });

  it.each([
    { command: '/usr/local/libexec/openkit-app-update' },
    { repository: 'https://github.com/openkit/openkit.git' },
    { dockerSocket: '/var/run/docker.sock' },
  ])('rejects request-chosen app-update host fields: %j', (extra) => {
    expect(() =>
      OpenKitConfigSchema.parse({
        schemaVersion: RETAINED_FORMAT_VERSION,
        appUpdate: {
          host: '127.0.0.1',
          user: 'openkit-update',
          port: 22,
          identityFile: '/run/openkit/app-update/id_ed25519',
          knownHostsFile: '/run/openkit/app-update/known_hosts',
          ...extra,
        },
      })
    ).toThrow();
  });

  it('marks app-update configuration restart-required and request-forbidden', () => {
    expect(getConfigPolicyCatalog()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'server',
          path: '$.appUpdate',
          reloadClass: 'restart-required',
          requestOverride: 'forbidden',
          secretPolicy: 'no-secret',
        }),
      ])
    );
  });
});

it('retains the authored Policy collection without conflating its format with a revision', () => {
  const mediation = { schemaVersion: 1, statements: [] };
  expect(OpenKitConfigSchema.parse({ policy: { mediation } }).policy?.mediation).toEqual(mediation);
  expect(
    OpenKitConfigSchema.safeParse({
      policy: { mediation: { ...mediation, revision: 'mutable-label' } },
    }).success
  ).toBe(false);
});

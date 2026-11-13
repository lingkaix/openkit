import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerSandboxAccessSchema } from '@openkit/config-schema';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { listExportableResolvedAgentSetups, requireResolvedAgentSetup } from './setup-ledger.js';
import { redactResolvedAgentSetup } from './setup-ledger-records.js';
import type { ResolvedAgentSetup } from './setup-resolver.js';
import { StoredResolvedAgentSetupV1Schema } from './setup-retained-v1.js';

/**
 * Creates a migrated workspace database for setup ledger tests.
 *
 * @returns Open workspace database.
 */
function createWorkspaceDb() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-agent-setup-ledger-'));
  let workspaceDb: ReturnType<typeof openWorkspaceDb> | undefined;
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    if (workspaceDb?.sqlite.open) workspaceDb.sqlite.close();
    rmSync(dataRoot, { force: true, recursive: true });
  });
  workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-73c3-900f-8d310e4ba201');
  applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
  return workspaceDb;
}

/**
 * Creates one resolved setup fixture.
 *
 * @returns Resolved agent setup.
 */
function resolvedSetup(): ResolvedAgentSetup {
  const setup = createTestAgentSetup();
  return {
    ...setup,
    manifest: {
      ...setup.manifest,
      requiredFeatures: ['workspace.mount.fuse'],
    },
  };
}

describe('resolved agent setup ledger', () => {
  it.each([undefined, false, true])(
    'retains encoded-slash %s in resolved setup evidence',
    async (allowEncodedSlash) => {
      const workspaceDb = createWorkspaceDb();
      const network = WorkerSandboxAccessSchema.parse({
        network: [
          {
            id: 'package-read',
            host: 'packages.example.com',
            port: 443,
            protocol: 'rest',
            access: 'read-only',
            purpose: 'Read scoped packages.',
            binaries: ['/usr/local/bin/node'],
            ...(allowEncodedSlash === undefined ? {} : { allowEncodedSlash }),
          },
        ],
      }).network;
      try {
        const record = await getControlStoreWorkerClient().recordResolvedAgentSetup(workspaceDb, {
          recordId: 'ras_encoding',
          workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
          setup: createTestAgentSetup({ network }),
          createdAt: '2026-10-08T00:00:00.000Z',
        });
        expect(record.setup.manifest.sandbox.network).toEqual(network);
        expect(
          requireResolvedAgentSetup(
            workspaceDb,
            'ws_00000000-0000-73c3-900f-8d310e4ba201',
            record.id
          )
        ).toEqual(record);
      } finally {
        await shutdownControlStoreWorkerClient();
        workspaceDb.sqlite.close();
      }
    }
  );

  it('persists and reopens one v1 workspace-scoped resolved setup without rewriting annotations', async () => {
    const workspaceDb = createWorkspaceDb();

    try {
      const record = await getControlStoreWorkerClient().recordResolvedAgentSetup(workspaceDb, {
        recordId: 'ras_1',
        workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
        turnId: 'tu_00000000-0000-7b5c-9add-c4bfc5a04575',
        requestId: 'req_1',
        setup: resolvedSetup(),
        createdAt: '2026-07-06T00:00:00.000Z',
      });

      expect(record).toMatchObject({
        id: 'ras_1',
        workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
        turnId: 'tu_00000000-0000-7b5c-9add-c4bfc5a04575',
        requestId: 'req_1',
        agentId: 'agent_codex_host',
        logicalModelId: 'openai/gpt-5.2',
        runtimeKind: 'codex',
        runtimeAdapter: 'codex',
        requiredFeatures: ['workspace.mount.fuse'],
      });
      expect(
        requireResolvedAgentSetup(workspaceDb, 'ws_00000000-0000-73c3-900f-8d310e4ba201', 'ras_1')
      ).toEqual(record);
      expect(
        workspaceDb.sqlite
          .prepare('SELECT schema_version AS schemaVersion FROM resolved_agent_setups')
          .get()
      ).toEqual({ schemaVersion: 1 });
      workspaceDb.sqlite
        .prepare('UPDATE resolved_agent_setups SET setup_json = ? WHERE setup_record_id = ?')
        .run(
          JSON.stringify({ ...record.setup, annotation: 'Descriptive setup annotation.' }),
          record.id
        );
      const retained = workspaceDb.sqlite
        .prepare(`SELECT schema_version AS schemaVersion,
        required_features_json, setup_json FROM resolved_agent_setups`)
        .get();
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
      const reopened = openWorkspaceDb(workspaceDb.dataRoot, record.workspaceId);
      try {
        expect(requireResolvedAgentSetup(reopened, record.workspaceId, record.id)).toEqual(record);
        expect(listExportableResolvedAgentSetups(reopened, record.workspaceId)).toEqual([record]);
        expect(
          reopened.sqlite
            .prepare(`SELECT schema_version AS schemaVersion,
          required_features_json, setup_json FROM resolved_agent_setups`)
            .get()
        ).toEqual(retained);
      } finally {
        reopened.sqlite.close();
      }
    } finally {
      await shutdownControlStoreWorkerClient();
      if (workspaceDb.sqlite.open) workspaceDb.sqlite.close();
    }
  });

  it('refuses an unknown setup version before JSON decode or replacement', async () => {
    const workspaceDb = createWorkspaceDb();
    const setup = resolvedSetup();
    const input = {
      recordId: 'ras_unknown_version',
      workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
      setup,
      createdAt: '2026-07-06T00:00:00.000Z',
    };
    try {
      const record = await getControlStoreWorkerClient().recordResolvedAgentSetup(
        workspaceDb,
        input
      );
      workspaceDb.sqlite
        .prepare(`UPDATE resolved_agent_setups SET schema_version = 2,
        required_features_json = '{', setup_json = '{' WHERE setup_record_id = ?`)
        .run(record.id);
      workspaceDb.sqlite.exec(`CREATE TRIGGER reject_unsupported_setup_insert BEFORE INSERT ON resolved_agent_setups
        BEGIN SELECT RAISE(FAIL, 'Unsupported setup reached an INSERT'); END`);

      expect(() => requireResolvedAgentSetup(workspaceDb, record.workspaceId, record.id)).toThrow(
        'Unsupported retained record format.'
      );
      expect(() => listExportableResolvedAgentSetups(workspaceDb, record.workspaceId)).toThrow(
        'Unsupported retained record format.'
      );
      await expect(
        getControlStoreWorkerClient().recordResolvedAgentSetup(workspaceDb, {
          ...input,
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        })
      ).rejects.toThrow('Unsupported retained record format.');
      expect(
        workspaceDb.sqlite
          .prepare(`SELECT schema_version AS schemaVersion, workspace_id,
        required_features_json, setup_json FROM resolved_agent_setups`)
          .all()
      ).toEqual([
        {
          schemaVersion: 2,
          workspace_id: record.workspaceId,
          required_features_json: '{',
          setup_json: '{',
        },
      ]);
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
    }
  });

  it('persists a null logical-model family as unknown rather than inventing an identifier', async () => {
    const workspaceDb = createWorkspaceDb();
    const base = resolvedSetup();
    const setup: ResolvedAgentSetup = {
      ...base,
      logicalModels: {
        ...base.logicalModels,
        allowed: base.logicalModels.allowed.map((model) => ({ ...model, modelFamilyId: null })),
      },
    };

    try {
      const record = await getControlStoreWorkerClient().recordResolvedAgentSetup(workspaceDb, {
        recordId: 'ras_unknown_family',
        workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
        setup,
        createdAt: '2026-07-06T00:00:00.000Z',
      });

      expect(record.setup.logicalModels.allowed).toEqual([
        expect.objectContaining({ id: 'openai/gpt-5.2', modelFamilyId: null }),
      ]);
      expect(JSON.stringify(record.setup)).not.toContain('unlisted:');
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
    }
  });

  it('persists only the deliberate redacted setup projection', async () => {
    const workspaceDb = createWorkspaceDb();
    const base = resolvedSetup();
    const setup: ResolvedAgentSetup = {
      ...base,
      manifest: {
        ...base.manifest,
        extensions: { apiKey: 'extension-secret' },
        lifecycle: { token: 'lifecycle-secret' },
        observability: { authorization: 'observability-secret' },
        permissions: { password: 'permissions-secret' },
        profiles: [{ id: 'profile_default', credential: 'profile-secret' }],
        resources: { secret: 'resources-secret' },
        sandbox: {
          ...base.manifest.sandbox,
          credentialDeclarations: [
            {
              id: 'provider_api_key',
              provider: {
                credentialKey: 'PROVIDER_API_KEY',
                instanceId: 'provider_instance',
                profileId: 'provider_profile',
                type: 'openai-compatible',
              },
              vaultGrantId: 'grant_00000000-0000-7fa7-82fe-c356c64344cc',
              visibility: 'sandbox-provider',
            },
            {
              id: 'runtime_auth_file',
              targetPath: '/run/secrets/runtime-auth.json',
              vaultGrantId: 'grant_00000000-0000-720f-937b-38f5395bee21',
              visibility: 'runtime-file',
            },
            {
              id: 'runtime_api_key',
              requirementId: 'runtime-api-key',
              targetEnvVarName: 'RUNTIME_API_KEY',
              vaultGrantId: 'grant_00000000-0000-7960-b949-4bf702bf6168',
              visibility: 'runtime-env',
            },
          ],
          network: [
            {
              access: 'read-write',
              binaries: ['/usr/local/bin/codex'],
              host: 'api.example.com',
              id: 'runtime_api',
              port: 443,
              protocol: 'https',
              purpose: 'Call the governed runtime API.',
              scope: 'session',
            },
          ],
        },
        skills: [{ id: 'skill_default', token: 'skill-secret' }],
        workspace: {
          env: { API_KEY: 'workspace-env-secret' },
          ephemeralEnv: { SESSION_TOKEN: 'workspace-ephemeral-secret' },
          filesystems: [{ mount: '/workspace/cache', password: 'filesystem-secret' }],
          inputs: [{ target: '/workspace/input', token: 'workspace-input-secret' }],
          root: '/workspace',
        },
      },
      logicalModels: {
        ...base.logicalModels,
        allowed: base.logicalModels.allowed.map((model) => ({
          ...model,
          routeSecret: 'logical-route-secret',
        })),
      },
    } as ResolvedAgentSetup;

    try {
      const record = await getControlStoreWorkerClient().recordResolvedAgentSetup(workspaceDb, {
        recordId: 'ras_redacted',
        workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
        setup,
        createdAt: '2026-07-06T00:00:00.000Z',
      });
      const expectedSetup = {
        manifest: {
          id: setup.manifest.id,
          requiredFeatures: setup.manifest.requiredFeatures,
          runtime: setup.manifest.runtime,
          sandbox: {
            credentialDeclarations: setup.manifest.sandbox?.credentialDeclarations,
            network: setup.manifest.sandbox?.network,
          },
        },
        logicalModels: {
          preferredLogicalModelId: setup.logicalModels.preferredLogicalModelId,
          allowed: setup.logicalModels.allowed.map((model) => ({
            id: model.id,
            capabilities: model.capabilities,
            modelFamilyId: model.modelFamilyId,
          })),
        },
      };

      expect(record.setup).toEqual(expectedSetup);
      const stored = workspaceDb.sqlite
        .prepare('SELECT setup_json FROM resolved_agent_setups WHERE setup_record_id = ?')
        .get(record.id) as { setup_json: string };
      expect(JSON.parse(stored.setup_json)).toEqual(expectedSetup);
      expect(
        listExportableResolvedAgentSetups(workspaceDb, 'ws_00000000-0000-73c3-900f-8d310e4ba201')
      ).toEqual([record]);

      const exportableJson = JSON.stringify(
        listExportableResolvedAgentSetups(workspaceDb, 'ws_00000000-0000-73c3-900f-8d310e4ba201')
      );
      for (const secret of [
        'extension-secret',
        'lifecycle-secret',
        'observability-secret',
        'permissions-secret',
        'profile-secret',
        'resources-secret',
        'skill-secret',
        'workspace-env-secret',
        'workspace-ephemeral-secret',
        'filesystem-secret',
        'workspace-input-secret',
        'logical-route-secret',
      ]) {
        expect(exportableJson).not.toContain(secret);
      }
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
    }
  });

  it('reprojects stored setup JSON before workspace export', async () => {
    const workspaceDb = createWorkspaceDb();

    try {
      const record = await getControlStoreWorkerClient().recordResolvedAgentSetup(workspaceDb, {
        recordId: 'ras_stored',
        workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
        setup: resolvedSetup(),
        createdAt: '2026-07-06T00:00:00.000Z',
      });
      workspaceDb.sqlite
        .prepare(
          `UPDATE resolved_agent_setups
           SET setup_json = ?
           WHERE setup_record_id = ?`
        )
        .run(
          JSON.stringify({
            ...record.setup,
            manifest: {
              ...record.setup.manifest,
              extensions: { apiKey: 'stored-extension-secret' },
              modelRoutes: [{ token: 'stored-route-secret' }],
              workspace: { env: { API_KEY: 'stored-workspace-secret' } },
            },
            logicalModels: {
              ...record.setup.logicalModels,
              privateRoutes: [{ token: 'stored-logical-route-secret' }],
            },
          }),
          record.id
        );

      const exportable = listExportableResolvedAgentSetups(
        workspaceDb,
        'ws_00000000-0000-73c3-900f-8d310e4ba201'
      );

      expect(exportable[0]?.setup).toEqual(record.setup);
      const exportableJson = JSON.stringify(exportable);
      for (const secret of [
        'stored-extension-secret',
        'stored-route-secret',
        'stored-workspace-secret',
        'stored-logical-route-secret',
      ]) {
        expect(exportableJson).not.toContain(secret);
      }
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
    }
  });
});

// Owners: Contract Evolution required-feature admission and the coordinated
// closed Workspace codex-login retained projection. Captured features remain
// evidence; this schema is not current Worker launch or credential authority.
describe('retained Codex Login requirement evidence', () => {
  const feature = 'worker.harness-login.v1';
  const declaration = {
    requirementId: 'codex-subscription',
    vaultGrantId: 'grant_00000000-0000-7fa7-82fe-c356c64344cc',
    visibility: 'runtime-token',
    consumer: 'codex-login',
  };

  /** Supplies valid old evidence siblings without deriving the new expected arm from its producer. */
  const retained = (value: unknown = declaration, requiredFeatures = [feature]) => {
    const base = redactResolvedAgentSetup(resolvedSetup());
    return {
      ...base,
      manifest: {
        ...base.manifest,
        requiredFeatures,
        sandbox: { ...base.manifest.sandbox, credentialDeclarations: [value] },
      },
    };
  };

  it('redacts the gated live requirement to exactly four non-secret retained fields', () => {
    const base = createTestAgentSetup({
      credentialDeclarations: [
        {
          ...declaration,
          visibility: 'runtime-token',
          consumer: 'codex-login',
          id: 'live-only-declaration-id',
        },
      ],
    });
    const setup = { ...base, manifest: { ...base.manifest, requiredFeatures: [feature] } };
    const result = redactResolvedAgentSetup(setup);
    expect(result.manifest.sandbox.credentialDeclarations).toEqual([declaration]);
    expect(result.manifest.requiredFeatures).toEqual([feature]);
    expect(StoredResolvedAgentSetupV1Schema.safeParse(result).success).toBe(true);
    expect(JSON.stringify(result).includes('live-only-declaration-id')).toBe(false);
  });

  it('reads the exact gated arm and preserves unknown captured feature evidence', () => {
    const input = retained(declaration, [feature, 'future.captured-feature.v1']);
    const result = StoredResolvedAgentSetupV1Schema.safeParse(input);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.manifest.sandbox.credentialDeclarations).toEqual([declaration]);
    expect(result.data.manifest.requiredFeatures).toEqual([feature, 'future.captured-feature.v1']);
    expect(redactResolvedAgentSetup(result.data)).toEqual(input);
  });

  it('refuses the new arm without its exact required feature', () => {
    for (const requiredFeatures of [
      [],
      ['worker.harness-login.v2'],
      ['future.captured-feature.v1'],
    ]) {
      expect(
        StoredResolvedAgentSetupV1Schema.safeParse(retained(declaration, requiredFeatures)).success
      ).toBe(false);
    }
  });

  it('refuses missing or empty required identities and consumer fields', () => {
    for (const key of ['requirementId', 'vaultGrantId', 'consumer', 'visibility']) {
      const missing = Object.fromEntries(
        Object.entries(declaration).filter(([name]) => name !== key)
      );
      expect(StoredResolvedAgentSetupV1Schema.safeParse(retained(missing)).success).toBe(false);
      expect(
        StoredResolvedAgentSetupV1Schema.safeParse(retained({ ...declaration, [key]: '' })).success
      ).toBe(false);
    }
  });

  it('refuses every extra field instead of silently discarding private or descriptive content', () => {
    for (const [key, value] of Object.entries({
      id: 'live-only-id',
      purpose: 'Live-only descriptive purpose.',
      accessToken: 'synthetic-access',
      refreshToken: 'synthetic-refresh',
      accountId: 'synthetic-account',
      material: 'synthetic-private-material',
      sql: 'synthetic-private-field',
      annotation: 'Synthetic free text.',
      targetPath: '/synthetic/path',
      targetEnvVarName: 'SYNTHETIC_TOKEN',
    })) {
      expect(
        StoredResolvedAgentSetupV1Schema.safeParse(retained({ ...declaration, [key]: value }))
          .success
      ).toBe(false);
    }
  });

  it('refuses foreign consumers and unknown core values while old evidence stays readable', () => {
    for (const consumer of ['pi-login', 'codex', null, 1]) {
      expect(
        StoredResolvedAgentSetupV1Schema.safeParse(retained({ ...declaration, consumer })).success
      ).toBe(false);
    }
    for (const visibility of ['unknown-runtime-token', null, 1]) {
      expect(
        StoredResolvedAgentSetupV1Schema.safeParse(retained({ ...declaration, visibility })).success
      ).toBe(false);
    }
    const old = redactResolvedAgentSetup(resolvedSetup());
    old.manifest.requiredFeatures.push('future.captured-feature.v1');
    expect(StoredResolvedAgentSetupV1Schema.safeParse(old).success).toBe(true);
    expect(redactResolvedAgentSetup(old)).toEqual(old);
  });
});

// Approved helper shapes remain redacted retained evidence, not current credential or readiness authority.
it.each([
  {
    id: 'retained-process-helper',
    requirementId: 'native-helper',
    vaultGrantId: 'grant_00000000-0000-7fa7-82fe-c356c64344cc',
    visibility: 'runtime-token',
    consumer: 'credential-helper',
    helper: { protocol: 'git', scheme: 'https', host: 'opaque-target', path: 'scope' },
  },
  {
    id: 'retained-ssh-handle',
    requirementId: 'native-ssh',
    vaultGrantId: 'grant_00000000-0000-720f-937b-38f5395bee21',
    visibility: 'external-handle',
    consumer: 'ssh-agent',
  },
] as const)(
  'round-trips redacted $visibility helper metadata without a Codex feature gate',
  async (declaration) => {
    const workspaceDb = createWorkspaceDb();
    const workspaceId = 'ws_00000000-0000-73c3-900f-8d310e4ba201';
    const material = 'synthetic-retained-helper-material';
    const injected =
      'helper' in declaration
        ? { ...declaration, material, helper: { ...declaration.helper, material } }
        : { ...declaration, material };
    const setup = createTestAgentSetup({ credentialDeclarations: [injected] });
    expect(setup.manifest.requiredFeatures).toEqual([]);
    try {
      const projected = redactResolvedAgentSetup(setup);
      expect(JSON.stringify(projected).includes(material)).toBe(false);
      expect(projected.manifest.sandbox.credentialDeclarations).toEqual([declaration]);
      expect(projected.manifest.requiredFeatures).toEqual([]);
      expect(StoredResolvedAgentSetupV1Schema.safeParse(projected).success).toBe(true);
      expect(redactResolvedAgentSetup(projected)).toEqual(projected);
      const record = await getControlStoreWorkerClient().recordResolvedAgentSetup(workspaceDb, {
        recordId: 'ras_native_helper_metadata',
        workspaceId,
        setup,
        createdAt: '2026-11-13T00:00:00.000Z',
      });
      expect(JSON.stringify(record).includes(material)).toBe(false);
      expect(record.setup).toEqual(projected);
      expect(record.requiredFeatures).toEqual([]);
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
      const reopened = openWorkspaceDb(workspaceDb.dataRoot, workspaceId);
      try {
        const read = requireResolvedAgentSetup(reopened, workspaceId, record.id);
        const exported = listExportableResolvedAgentSetups(reopened, workspaceId);
        expect(JSON.stringify([read, exported]).includes(material)).toBe(false);
        expect(read).toEqual(record);
        expect(exported).toEqual([record]);
        expect(read.setup.manifest.sandbox.credentialDeclarations).toEqual([declaration]);
        expect(read.requiredFeatures).toEqual([]);
      } finally {
        reopened.sqlite.close();
      }
    } finally {
      await shutdownControlStoreWorkerClient();
      if (workspaceDb.sqlite.open) workspaceDb.sqlite.close();
    }
  }
);

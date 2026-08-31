import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import {
  importResolvedAgentSetups,
  listExportableResolvedAgentSetups,
  recordResolvedAgentSetup,
  requireResolvedAgentSetup,
} from './setup-ledger.js';
import type { ResolvedAgentSetup } from './setup-resolver.js';

/**
 * Creates a migrated workspace database for setup ledger tests.
 *
 * @returns Open workspace database.
 */
function createWorkspaceDb() {
  const workspaceDb = openWorkspaceDb(
    mkdtempSync(join(tmpdir(), 'openkit-agent-setup-ledger-')),
    'user_1',
    'ws_1'
  );
  applyScopedMigrations(workspaceDb);
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
  it('persists and reads one workspace-scoped resolved setup record', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      const record = recordResolvedAgentSetup(workspaceDb, {
        recordId: 'ras_1',
        workspaceId: 'ws_1',
        turnId: 'turn_1',
        requestId: 'req_1',
        setup: resolvedSetup(),
        createdAt: '2026-07-06T00:00:00.000Z',
      });

      expect(record).toMatchObject({
        id: 'ras_1',
        workspaceId: 'ws_1',
        turnId: 'turn_1',
        requestId: 'req_1',
        agentId: 'agent_codex_host',
        logicalModelId: 'openai/gpt-5.2',
        runtimeKind: 'codex',
        runtimeAdapter: 'codex',
        requiredFeatures: ['workspace.mount.fuse'],
      });
      expect(requireResolvedAgentSetup(workspaceDb, 'ws_1', 'ras_1')).toEqual(record);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('persists only the deliberate redacted setup projection', () => {
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
              vaultGrantId: 'grant_provider_api_key',
              visibility: 'sandbox-provider',
            },
            {
              id: 'runtime_auth_file',
              targetPath: '/run/secrets/runtime-auth.json',
              vaultGrantId: 'grant_runtime_auth_file',
              visibility: 'runtime-file',
            },
            {
              id: 'runtime_api_key',
              requirementId: 'runtime-api-key',
              targetEnvVarName: 'RUNTIME_API_KEY',
              vaultGrantId: 'grant_runtime_api_key',
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
      const record = recordResolvedAgentSetup(workspaceDb, {
        recordId: 'ras_redacted',
        workspaceId: 'ws_1',
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
      expect(listExportableResolvedAgentSetups(workspaceDb, 'ws_1')).toEqual([record]);

      const exportableJson = JSON.stringify(listExportableResolvedAgentSetups(workspaceDb, 'ws_1'));
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
      workspaceDb.sqlite.close();
    }
  });

  it('reprojects imported setup JSON before making it durable or exportable', () => {
    const workspaceDb = createWorkspaceDb();
    const setup = resolvedSetup();
    const redactedSetup = {
      manifest: {
        id: setup.manifest.id,
        requiredFeatures: setup.manifest.requiredFeatures,
        runtime: setup.manifest.runtime,
        sandbox: {
          credentialDeclarations: setup.manifest.sandbox?.credentialDeclarations ?? [],
          network: setup.manifest.sandbox?.network ?? [],
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
    const suppliedSetup = {
      ...redactedSetup,
      manifest: {
        ...redactedSetup.manifest,
        extensions: { apiKey: 'import-extension-secret' },
        modelRoutes: [{ token: 'import-route-secret' }],
        workspace: {
          env: { API_KEY: 'import-workspace-secret' },
          inputs: [{ target: '/workspace/input', token: 'import-passthrough-secret' }],
        },
      },
      logicalModels: {
        ...redactedSetup.logicalModels,
        privateRoutes: [{ token: 'import-logical-route-secret' }],
      },
    };

    try {
      importResolvedAgentSetups(workspaceDb, [
        {
          id: 'ras_imported',
          workspaceId: 'ws_1',
          turnId: null,
          requestId: null,
          agentId: setup.manifest.id,
          logicalModelId: setup.logicalModels.preferredLogicalModelId,
          runtimeKind: setup.manifest.runtime.kind,
          runtimeAdapter: setup.manifest.runtime.adapter,
          requiredFeatures: setup.manifest.requiredFeatures,
          setup: suppliedSetup,
          createdAt: '2026-07-06T00:00:00.000Z',
        },
      ]);

      const stored = workspaceDb.sqlite
        .prepare('SELECT setup_json FROM resolved_agent_setups WHERE setup_record_id = ?')
        .get('ras_imported') as { setup_json: string };
      expect(JSON.parse(stored.setup_json)).toEqual(redactedSetup);
      expect(requireResolvedAgentSetup(workspaceDb, 'ws_1', 'ras_imported').setup).toEqual(
        redactedSetup
      );
      const exportableJson = JSON.stringify(listExportableResolvedAgentSetups(workspaceDb, 'ws_1'));
      for (const secret of [
        'import-extension-secret',
        'import-route-secret',
        'import-workspace-secret',
        'import-passthrough-secret',
        'import-logical-route-secret',
      ]) {
        expect(exportableJson).not.toContain(secret);
      }
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('reprojects stored setup JSON before workspace export', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      const record = recordResolvedAgentSetup(workspaceDb, {
        recordId: 'ras_stored',
        workspaceId: 'ws_1',
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

      const exportable = listExportableResolvedAgentSetups(workspaceDb, 'ws_1');

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
      workspaceDb.sqlite.close();
    }
  });
});

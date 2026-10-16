import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPERATION_DEFINITIONS, type OperationId } from '@openkit/app-api-schemas';
import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
} from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';
import { recordAgentEnvironmentPackageSnapshot } from './runtime/aep-snapshot-ledger.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createTestAgentSetup } from './test-support/agent-environment.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { resolveAgentEnvironmentPackage } from './test-support/prepared-agent-environment.js';
import { createVaultGrant } from './vault/vault-grants.js';
import {
  createVaultReference,
  importUnboundWorkspaceVaultReference,
} from './vault/vault-references.js';
import { createVaultUnlockState } from './vault/vault-unlock-state.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const reads = [
  [
    'usage.read',
    '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/capability-usage',
    { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
  ],
  [
    'audit.workspace-list',
    '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/audit/events',
    { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
  ],
  ['audit.server-list', '/api/app/audit/events', {}],
  [
    'evidence.bundle-list',
    '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/evidence-bundles',
    { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
  ],
  [
    'evidence.runtime-list',
    '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/runtime-evidence',
    { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
  ],
  [
    'permission.workspace-list',
    '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/permission-decisions',
    { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
  ],
  ['permission.server-list', '/api/app/permission-decisions', {}],
  [
    'environment.snapshot-list',
    '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/agent-environment/snapshots',
    { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
  ],
  [
    'environment.snapshot-read',
    '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/agent-environment/snapshots/aepsnap_b6',
    { workspaceId: 'ws_00000000-0000-7000-8000-000000000001', snapshotId: 'aepsnap_b6' },
  ],
  ['app.search', '/api/app/search?q=Demo', { query: 'Demo' }],
] as const;

/** Supplies one valid immutable snapshot using the existing preparation owner. */
function createEnvironmentPackage(): AgentEnvironmentPackage {
  const snapshot = AgentEnvironmentPackageSchema.parse(
    resolveAgentEnvironmentPackage({
      captureCoverage: { scope: 'server', value: 'off' },
      agent: {
        id: 'agent_codex_host',
        name: 'Codex Agent',
        kind: 'coder',
        status: 'enabled',
        modelId: null,
        skillIds: [],
        profiles: [
          {
            id: 'default',
            displayName: 'Default',
            instructionsRef: null,
            modelId: null,
            skillIds: [],
            capabilityIds: [],
          },
        ],
        defaultProfileId: 'default',
        capabilities: [],
        sandboxSummary: null,
        config: {
          adapterType: 'codex',
          command: null,
          baseUrl: null,
          workspaceRoot: '/workspace',
          environment: {},
          capabilities: [],
        },
      },
      agentSetup: createTestAgentSetup(),
      agentSessionId: 'as_00000000-0000-7b98-8803-ea4242ad797b',
      triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      backend: {
        kind: 'openshell',
      },
      requestId: 'req_1',
      turn: {
        id: 'tu_00000000-0000-7b5c-9add-c4bfc5a04575',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        items: [],
        status: 'running',
        error: null,
        configVersion: null,
        startedAt: '2026-07-06T00:00:00.000Z',
        completedAt: null,
        durationMs: null,
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      },
      turnInput: 'Run tests',
      workspaceCwd: '/workspace',
      workspaceRoots: [],
    })
  );

  return { ...snapshot, snapshotId: 'aepsnap_b6' };
}

/** Concrete successful inputs, including request-only synthetic material. */
const vaultCases = [
  ['vault.status', '/api/app/vault/status', {}, 'GET'],
  [
    'vault.unlock',
    '/api/app/vault/unlock',
    { masterKeyBase64: 'CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk=' },
    'POST',
  ],
  ['vault.lock', '/api/app/vault/lock', {}, 'POST'],
  [
    'vault.bootstrap-codex-auth',
    '/api/app/vault/bootstrap/codex-auth-json',
    { authJsonBase64: 'e30=' },
    'POST',
  ],
  [
    'vault.provider-api-key-set',
    '/api/app/providers/provider-b6/api-key',
    { providerId: 'provider-b6', apiKey: 'synthetic-b6-key' },
    'PUT',
  ],
  [
    'vault.secret-create',
    '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/vault/secrets',
    {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      secretKind: 'github-token',
      material: 'synthetic-b6-material',
    },
    'POST',
  ],
  [
    'vault.secret-rotate',
    '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/vault/secrets/vault_00000000-0000-70a7-af6b-8038e2c48211/rotate',
    {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      referenceId: 'vault_00000000-0000-70a7-af6b-8038e2c48211',
      material: 'synthetic-b6-next',
    },
    'POST',
  ],
  [
    'vault.secret-revoke',
    '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/vault/secrets/vault_00000000-0000-70a7-af6b-8038e2c48211/revoke',
    {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      referenceId: 'vault_00000000-0000-70a7-af6b-8038e2c48211',
    },
    'POST',
  ],
  [
    'vault.grant-create',
    '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/vault/grants',
    {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      referenceId: 'vault_00000000-0000-70a7-af6b-8038e2c48211',
    },
    'POST',
  ],
  [
    'vault.grant-revoke',
    '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/vault/grants/grant_00000000-0000-721d-811b-4545a740e396/revoke',
    {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      grantId: 'grant_00000000-0000-721d-811b-4545a740e396',
    },
    'POST',
  ],
  [
    'vault.reference-rebind',
    '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/vault/references/vault_00000000-0000-7f9a-ae09-1112bc878c49/rebind',
    {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      referenceId: 'vault_00000000-0000-7f9a-ae09-1112bc878c49',
      materialBase64: 'c3ludGhldGljLWI2LW1hdGVyaWFs',
    },
    'POST',
  ],
  [
    'vault.reference-list',
    '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/vault/references',
    { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
    'GET',
  ],
  [
    'vault.grant-list',
    '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/vault/grants',
    { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
    'GET',
  ],
  [
    'vault.injection-plan-list',
    '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/vault/injection-plans',
    { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
    'GET',
  ],
  [
    'vault.injection-receipt-list',
    '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/vault/injection-receipts',
    { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
    'GET',
  ],
  [
    'vault.use-list',
    '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/vault/use-records',
    { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
    'GET',
  ],
  ['vault.server-use-list', '/api/app/vault/use-records', {}, 'GET'],
] as const;

/** Observes only the owned Vault rows so a retired binding cannot perform a second effect. */
function vaultRows(coreDb: ReturnType<typeof openCoreDb>) {
  return {
    references: coreDb.sqlite.prepare('SELECT * FROM vault_references ORDER BY reference_id').all(),
    grants: coreDb.sqlite.prepare('SELECT * FROM vault_grants ORDER BY grant_id').all(),
    audit: coreDb.sqlite.prepare('SELECT * FROM vault_admin_audit_events ORDER BY rowid').all(),
  };
}

describe('B6 binding retirement', () => {
  it.each([
    ...reads.map(([id, path, input]) => [id, path, input, 'GET'] as const),
    ...vaultCases,
  ])('%s replaces its authorized former binding', async (id, path, logicalInput, method) => {
    const input = logicalInput as Record<string, unknown>;
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-b6-retirement-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    if (id !== 'vault.unlock') vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 9) });
    if (id !== 'vault.unlock') {
      vaultUnlockState.backend().store({
        referenceId: 'vault_00000000-0000-70a7-af6b-8038e2c48211',
        material: 'synthetic-b6-material',
        metadata: {
          ownerScope: 'workspace',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        },
      });
      createVaultReference(coreDb, {
        referenceId: 'vault_00000000-0000-70a7-af6b-8038e2c48211',
        ownerScope: 'workspace',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        displayName: 'github-token',
        secretKind: 'github-token',
        backendKind: 'encrypted-file',
        backendLocator:
          'encrypted-file://workspace/ws_00000000-0000-7000-8000-000000000001/vault/vault_00000000-0000-70a7-af6b-8038e2c48211',
      });
      createVaultGrant(coreDb, {
        grantId: 'grant_00000000-0000-721d-811b-4545a740e396',
        vaultReferenceId: 'vault_00000000-0000-70a7-af6b-8038e2c48211',
        ownerScope: 'workspace',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        allowedInjectionPaths: ['gateway-only'],
        targetCapabilityId: null,
        lifetime: 'workspace',
      });
    }
    if (id === 'vault.reference-rebind')
      importUnboundWorkspaceVaultReference(coreDb, {
        referenceId: 'vault_00000000-0000-7f9a-ae09-1112bc878c49',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        displayName: 'Imported token',
        secretKind: 'github-token',
        backendKind: 'encrypted-file',
      });
    if (id === 'vault.provider-api-key-set') {
      const providersRoot = join(dataRoot, 'config', 'providers');
      mkdirSync(providersRoot, { recursive: true });
      writeFileSync(
        join(providersRoot, 'provider-b6.provider.jsonc'),
        JSON.stringify({
          id: 'provider-b6',
          displayName: 'B6 provider',
          kind: 'custom',
          defaultModel: 'model-demo',
          models: ['model-demo'],
          secretRef: 'vault://vault_00000000-0000-7dd5-b4e6-1486873453ee',
        })
      );
    }
    if (id === 'environment.snapshot-read') {
      const db = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      applyScopedMigrations(db);
      try {
        recordAgentEnvironmentPackageSnapshot(db, {
          environmentPackage: createEnvironmentPackage(),
          createdAt: '2026-07-06T00:00:01.000Z',
        });
      } finally {
        db.sqlite.close();
      }
    }
    const app = createApp({ coreDb, dataRoot, store, vaultUnlockState });
    try {
      const response = await app.request(`/api/app/operations/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(OPERATION_DEFINITIONS[id as OperationId].outputSchema.safeParse(body).success).toBe(
        true
      );
      expect(JSON.stringify(body)).not.toContain('synthetic-b6-material');
      const before = vaultRows(coreDb);
      const formerBody = Object.fromEntries(
        Object.entries(input).filter(
          ([key]) =>
            ![
              'workspaceId',
              'grantId',
              'providerId',
              'snapshotId',
              ...(id === 'vault.grant-create' ? [] : ['referenceId']),
            ].includes(key)
        )
      );
      const former = await app.request(path, {
        method,
        ...(method !== 'GET'
          ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(formerBody) }
          : {}),
      });
      expect(former.status).toBe(404);
      expect(vaultRows(coreDb)).toEqual(before);
    } finally {
      vaultUnlockState.lock();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});

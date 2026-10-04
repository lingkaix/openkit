import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPERATION_DEFINITIONS, type OperationId } from '@openkit/app-api-schemas';
import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
} from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';
import { ensureLocalUser } from './auth/identity.js';
import { recordAgentEnvironmentPackageSnapshot } from './runtime/aep-snapshot-ledger.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createTestAgentSetup } from './test-support/agent-environment.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { resolveAgentEnvironmentPackage } from './test-support/prepared-agent-environment.js';
import { createVaultGrant } from './vault/vault-grants.js';
import {
  createVaultReference,
  importUnboundWorkspaceVaultReference,
} from './vault/vault-references.js';
import { createVaultUnlockState } from './vault/vault-unlock-state.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const reads = [
  ['usage.read', '/api/app/workspaces/ws_demo/capability-usage', { workspaceId: 'ws_demo' }],
  ['audit.workspace-list', '/api/app/workspaces/ws_demo/audit/events', { workspaceId: 'ws_demo' }],
  ['audit.server-list', '/api/app/audit/events', {}],
  [
    'evidence.bundle-list',
    '/api/app/workspaces/ws_demo/evidence-bundles',
    { workspaceId: 'ws_demo' },
  ],
  [
    'evidence.runtime-list',
    '/api/app/workspaces/ws_demo/runtime-evidence',
    { workspaceId: 'ws_demo' },
  ],
  [
    'permission.workspace-list',
    '/api/app/workspaces/ws_demo/permission-decisions',
    { workspaceId: 'ws_demo' },
  ],
  ['permission.server-list', '/api/app/permission-decisions', {}],
  [
    'environment.snapshot-list',
    '/api/app/workspaces/ws_demo/agent-environment/snapshots',
    { workspaceId: 'ws_demo' },
  ],
  [
    'environment.snapshot-read',
    '/api/app/workspaces/ws_demo/agent-environment/snapshots/aepsnap_b6',
    { workspaceId: 'ws_demo', snapshotId: 'aepsnap_b6' },
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
      agentSessionId: 'as_1',
      triggerActor: { kind: 'user', id: 'user_local' },
      backend: {
        kind: 'openshell',
      },
      requestId: 'req_1',
      turn: {
        id: 'turn_1',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        items: [],
        status: 'running',
        error: null,
        configVersion: null,
        startedAt: '2026-07-06T00:00:00.000Z',
        completedAt: null,
        durationMs: null,
        triggerActor: { kind: 'user', id: 'user_local' },
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
    '/api/app/workspaces/ws_demo/vault/secrets',
    { workspaceId: 'ws_demo', secretKind: 'github-token', material: 'synthetic-b6-material' },
    'POST',
  ],
  [
    'vault.secret-rotate',
    '/api/app/workspaces/ws_demo/vault/secrets/vault_b6/rotate',
    { workspaceId: 'ws_demo', referenceId: 'vault_b6', material: 'synthetic-b6-next' },
    'POST',
  ],
  [
    'vault.secret-revoke',
    '/api/app/workspaces/ws_demo/vault/secrets/vault_b6/revoke',
    { workspaceId: 'ws_demo', referenceId: 'vault_b6' },
    'POST',
  ],
  [
    'vault.grant-create',
    '/api/app/workspaces/ws_demo/vault/grants',
    { workspaceId: 'ws_demo', referenceId: 'vault_b6' },
    'POST',
  ],
  [
    'vault.grant-revoke',
    '/api/app/workspaces/ws_demo/vault/grants/grant_b6/revoke',
    { workspaceId: 'ws_demo', grantId: 'grant_b6' },
    'POST',
  ],
  [
    'vault.reference-rebind',
    '/api/app/workspaces/ws_demo/vault/references/vault_imported/rebind',
    {
      workspaceId: 'ws_demo',
      referenceId: 'vault_imported',
      materialBase64: 'c3ludGhldGljLWI2LW1hdGVyaWFs',
    },
    'POST',
  ],
  [
    'vault.reference-list',
    '/api/app/workspaces/ws_demo/vault/references',
    { workspaceId: 'ws_demo' },
    'GET',
  ],
  [
    'vault.grant-list',
    '/api/app/workspaces/ws_demo/vault/grants',
    { workspaceId: 'ws_demo' },
    'GET',
  ],
  [
    'vault.injection-plan-list',
    '/api/app/workspaces/ws_demo/vault/injection-plans',
    { workspaceId: 'ws_demo' },
    'GET',
  ],
  [
    'vault.injection-receipt-list',
    '/api/app/workspaces/ws_demo/vault/injection-receipts',
    { workspaceId: 'ws_demo' },
    'GET',
  ],
  [
    'vault.use-list',
    '/api/app/workspaces/ws_demo/vault/use-records',
    { workspaceId: 'ws_demo' },
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
    const store = createDemoStore();
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    if (id !== 'vault.unlock') vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 9) });
    if (id !== 'vault.unlock') {
      vaultUnlockState.backend().store({
        referenceId: 'vault_b6',
        material: 'synthetic-b6-material',
        metadata: { ownerScope: 'workspace', workspaceId: 'ws_demo' },
      });
      createVaultReference(coreDb, {
        referenceId: 'vault_b6',
        ownerScope: 'workspace',
        workspaceId: 'ws_demo',
        displayName: 'github-token',
        secretKind: 'github-token',
        backendKind: 'encrypted-file',
        backendLocator: 'encrypted-file://workspace/ws_demo/vault/vault_b6',
      });
      createVaultGrant(coreDb, {
        grantId: 'grant_b6',
        vaultReferenceId: 'vault_b6',
        ownerScope: 'workspace',
        workspaceId: 'ws_demo',
        allowedInjectionPaths: ['gateway-only'],
        targetCapabilityId: null,
        lifetime: 'workspace',
      });
    }
    if (id === 'vault.reference-rebind')
      importUnboundWorkspaceVaultReference(coreDb, {
        referenceId: 'vault_imported',
        workspaceId: 'ws_demo',
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
          secretRef: 'vault://provider_b6',
        })
      );
    }
    if (id === 'environment.snapshot-read') {
      const db = openWorkspaceDb(dataRoot, 'ws_demo');
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

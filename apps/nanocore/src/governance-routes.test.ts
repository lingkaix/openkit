import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ensureLocalUser } from './auth/identity.js';
import { recordWorkspaceEvidenceBundle } from './evidence-bundles.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { operationRequest } from './test-support/operation-request.js';
import { createVaultGrant } from './vault/vault-grants.js';
import { createVaultReference } from './vault/vault-references.js';
import { createVaultInjectionPlan } from './vault-injection-plans.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

it.each([
  'syntax',
  'unknown-key',
] as const)('bounds %s retained evidence errors without changing source bytes', async (variant) => {
  const marker = 'ROW_SECRET_X9';
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-evidence-error-'));
  const db = openWorkspaceDb(dataRoot, 'ws_demo');
  applyScopedMigrations(db);
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
  const app = createApp({ coreDb, dataRoot, store: createDemoStore() });
  try {
    recordWorkspaceEvidenceBundle(db, {
      id: 'evb_probe',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_probe',
      goalId: null,
      agentSessionId: null,
      backendType: null,
      sourceKind: 'worker-runtime',
      summary: 'Evidence control',
      rawEvidenceRefs: [],
      redactedEvidenceRefs: [],
      contentDigests: [],
      retentionClass: 'restricted-raw',
      sensitivityClass: 'restricted',
      importStatus: 'promoted',
      requiredFeatures: [],
      createdAt: '2026-07-18T01:00:07.000Z',
    });
    const healthy = await app.request(
      ...operationRequest('evidence.bundle-list', { workspaceId: 'ws_demo' }, {})
    );
    expect(healthy.status).toBe(200);
    expect(await healthy.json()).toMatchObject({ evidenceBundles: [{ id: 'evb_probe' }] });
    const bytes =
      variant === 'syntax'
        ? marker
        : JSON.stringify([{ kind: 'artifact', ref: 'artifact:ar_demo', [marker]: 'private' }]);
    db.sqlite.prepare('UPDATE evidence_bundles SET raw_evidence_refs_json = ?').run(bytes);
    const response = await app.request(
      ...operationRequest('evidence.bundle-list', { workspaceId: 'ws_demo' }, {})
    );
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toMatchObject({
      code: 'not_found',
      message: 'The retained record could not be read.',
    });
    expect(JSON.stringify(body)).not.toContain(marker);
    expect(
      db.sqlite.prepare('SELECT raw_evidence_refs_json AS bytes FROM evidence_bundles').get()
    ).toEqual({ bytes });
  } finally {
    db.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

it('lists a Workspace grant runtime-env injection plan through the public route', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-injection-plan-list-'));
  const coreDb = openCoreDb(dataRoot);

  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
    const app = createApp({ coreDb, dataRoot, store: createDemoStore() });
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      displayName: 'Worker GitHub token',
      ownerScope: 'server',
      referenceId: 'vault_github',
      secretKind: 'repository-token',
    });
    createVaultGrant(coreDb, {
      allowedInjectionPaths: ['runtime-env'],
      grantId: 'grant_github_turn',
      lifetime: 'turn',
      ownerScope: 'workspace',
      vaultReferenceId: 'vault_github',
      workspaceId: 'ws_demo',
    });
    const plan = createVaultInjectionPlan(coreDb, {
      backendCapabilityRequirement: 'encrypted-file:resolve',
      expirationBehavior: 'unset-env-on-turn-end',
      grantId: 'grant_github_turn',
      injectionVisibility: 'runtime-env',
      planId: 'plan_github_env',
      redactionRule: 'name-only',
      revocationBehavior: 'mark-session-stale',
      targetEnvVarName: 'GITHUB_TOKEN',
    });

    const response = await app.request(
      ...operationRequest('vault.injection-plan-list', { workspaceId: 'ws_demo' })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ workspaceId: 'ws_demo', items: [plan] });
  } finally {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { expect, it } from 'vitest';
import type { AuthVariables } from './auth/middleware.js';
import { recordWorkspaceEvidenceBundle } from './evidence-bundles.js';
import { registerGovernanceRoutes } from './governance-routes.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createDemoStore } from './test-support/demo-store.js';
import { createVaultGrant } from './vault/vault-grants.js';
import { createVaultReference } from './vault/vault-references.js';
import { createVaultInjectionPlan } from './vault-injection-plans.js';

it.each([
  'syntax',
  'unknown-key',
] as const)('bounds %s retained evidence errors without changing source bytes', async (variant) => {
  const marker = 'ROW_SECRET_X9';
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-evidence-error-'));
  const db = openWorkspaceDb(dataRoot, 'ws_demo');
  applyScopedMigrations(db);
  const app = new Hono<{ Variables: AuthVariables }>();
  registerGovernanceRoutes({
    app,
    coreDb: undefined,
    repositoryWorkspaceDb: (id) => openWorkspaceDb(dataRoot, id),
    requestStore: () => createDemoStore(),
  });
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
    const healthy = await app.request('/api/app/workspaces/ws_demo/evidence-bundles');
    expect(healthy.status).toBe(200);
    expect(await healthy.json()).toMatchObject({ evidenceBundles: [{ id: 'evb_probe' }] });
    const bytes =
      variant === 'syntax'
        ? marker
        : JSON.stringify([{ kind: 'artifact', ref: 'artifact:ar_demo', [marker]: 'private' }]);
    db.sqlite.prepare('UPDATE evidence_bundles SET raw_evidence_refs_json = ?').run(bytes);
    const response = await app.request('/api/app/workspaces/ws_demo/evidence-bundles');
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
  }
});

it('lists a Workspace grant runtime-env injection plan through the public route', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-injection-plan-list-'));
  const coreDb = openCoreDb(dataRoot);

  try {
    applyMigrations(coreDb);
    const app = new Hono<{ Variables: AuthVariables }>();
    registerGovernanceRoutes({
      app,
      coreDb,
      repositoryWorkspaceDb: (id) => openWorkspaceDb(dataRoot, id),
      requestStore: () => createDemoStore(),
    });
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

    const response = await app.request('/api/app/workspaces/ws_demo/vault/injection-plans');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ workspaceId: 'ws_demo', items: [plan] });
  } finally {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

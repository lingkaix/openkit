import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { expect, it } from 'vitest';
import type { AuthVariables } from './auth/middleware.js';
import { recordWorkspaceEvidenceBundle } from './evidence-bundles.js';
import { registerGovernanceRoutes } from './governance-routes.js';
import { openWorkspaceDb } from './storage/db.js';
import { applyScopedMigrations } from './storage/migrate.js';
import { createDemoStore } from './test-support/demo-store.js';

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

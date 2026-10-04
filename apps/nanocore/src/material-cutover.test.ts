import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ensureLocalUser } from './auth/identity.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { operationRequest } from './test-support/operation-request.js';
import { createWorkspaceMaterial, saveWorkspaceMaterialRevision } from './workspace-materials.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/** Isolated native records with explicit local Workspace authority. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'material-cutover-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: 'ws_demo', ownerUserId: 'user_local' });
  const db = openWorkspaceDb(dataRoot, 'ws_demo');
  applyScopedMigrations(db);
  const content = 'Cutover exact bytes';
  const contentDigest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
  const { materialId } = createWorkspaceMaterial(db, {
    title: 'Cutover',
    kind: 'text',
    sensitivity: 'internal',
    requestId: randomUUID(),
    actorId: 'user_local',
    acceptedAt: new Date().toISOString(),
  });
  const { revisionId } = saveWorkspaceMaterialRevision(db, {
    materialId,
    content,
    contentDigest,
    expectedRevisionId: null,
    requestId: randomUUID(),
    actorId: 'user_local',
    acceptedAt: new Date().toISOString(),
  });
  const app = createApp({ coreDb, dataRoot, store });
  return { coreDb, db, store, app, materialId, revisionId, content, contentDigest };
}

it('removes all eleven authorized former Material bindings without a row or receipt write', async () => {
  const f = fixture();
  try {
    const base = '/api/app/workspaces/ws_demo';
    const material = `${base}/materials/${f.materialId}`;
    const thread = `${base}/threads/th_demo`;
    const cases = [
      [`${base}/materials`, 'GET', null],
      [`${base}/materials`, 'POST', { title: 'Retired', kind: 'text', sensitivity: 'internal' }],
      [material, 'GET', null],
      [`${material}/revisions`, 'GET', null],
      [`${material}/revisions/${f.revisionId}`, 'GET', null],
      [
        `${material}/revisions`,
        'POST',
        { expectedRevisionId: f.revisionId, content: f.content, contentDigest: f.contentDigest },
      ],
      [`${thread}/material`, 'GET', null],
      ...['bind', 'exclude', 'restore', 'unbind'].map((action) => [
        `${thread}/materials/${f.materialId}/${action}`,
        'POST',
        {
          expectedBindingState: action === 'bind' ? 'not_bound' : 'bound',
          ...(action === 'exclude'
            ? { expectedInclusionState: 'included', expectedQueuedRevisionId: f.revisionId }
            : action === 'restore'
              ? { expectedInclusionState: 'excluded' }
              : {}),
        },
      ]),
    ] as const;
    const rows = () => ({
      materials: f.db.sqlite.prepare('SELECT * FROM workspace_materials').all(),
      revisions: f.db.sqlite.prepare('SELECT * FROM workspace_material_revisions').all(),
      bindings: f.db.sqlite.prepare('SELECT * FROM thread_material_bindings').all(),
      receipts: f.store.listCommandRequests(),
    });
    const before = rows();
    let latestRevisionId = f.revisionId;
    for (const [path, method, body] of cases) {
      const response = await f.app.request(path as string, {
        method: method as string,
        ...(body
          ? {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                ...body,
                ...(String(path).endsWith('/exclude')
                  ? { expectedQueuedRevisionId: latestRevisionId }
                  : {}),
                requestId: randomUUID(),
              }),
            }
          : {}),
      });
      if (method === 'POST' && path === `${material}/revisions` && response.status === 201) {
        latestRevisionId = (await response.json()).revisionId;
      }
      expect.soft(response.status, `${method} ${path}`).toBe(404);
    }
    expect(rows()).toEqual(before);
  } finally {
    f.db.sqlite.close();
    f.coreDb.sqlite.close();
  }
});

it('reaches all eleven canonical Material outcomes and exact binding replay', async () => {
  const f = fixture();
  try {
    const selectors = { workspaceId: 'ws_demo', materialId: f.materialId };
    const thread = { ...selectors, threadId: 'th_demo' };
    const call = async (
      id: Parameters<typeof operationRequest>[0],
      input: object,
      status = 200
    ) => {
      const response = await f.app.request(
        ...operationRequest(id, {}, { body: JSON.stringify(input) })
      );
      expect(response.status, id).toBe(status);
      return response.json();
    };
    expect((await call('material.list', { workspaceId: 'ws_demo' })).materials).toHaveLength(1);
    expect((await call('material.read', selectors)).material.materialId).toBe(f.materialId);
    expect((await call('material.revision-list', selectors)).revisions).toHaveLength(1);
    expect(
      (await call('material.revision-read', { ...selectors, revisionId: f.revisionId })).revision
        .content
    ).toBe(f.content);
    const created = await call(
      'material.create',
      {
        workspaceId: 'ws_demo',
        requestId: randomUUID(),
        title: 'Canonical',
        kind: 'text',
        sensitivity: 'public',
      },
      201
    );
    expect(created.materialId).toBeTruthy();
    const saved = await call(
      'material.revision-save',
      {
        ...selectors,
        requestId: randomUUID(),
        expectedRevisionId: f.revisionId,
        content: f.content,
        contentDigest: f.contentDigest,
      },
      201
    );
    const bind = { ...thread, requestId: randomUUID(), expectedBindingState: 'not_bound' };
    const bound = await call('material.bind', bind);
    const receipt = f.store.listCommandRequests();
    expect(await call('material.bind', bind)).toEqual(bound);
    expect(f.store.listCommandRequests()).toEqual(receipt);
    const read = await call('material.thread-read', {
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
    });
    expect(read.material).toMatchObject({
      resource: { materialId: f.materialId },
      currentRevision: { revisionId: saved.revisionId },
      inclusionState: 'included',
      latestQueuedRevisionId: saved.revisionId,
      lastWorkerSeenRevisionId: null,
      currentTurnRevisionId: null,
      activeDelivery: null,
    });
    expect(
      (
        await call('material.exclude', {
          ...thread,
          requestId: randomUUID(),
          expectedBindingState: 'bound',
          expectedInclusionState: 'included',
          expectedQueuedRevisionId: saved.revisionId,
        })
      ).outcome
    ).toBe('excluded');
    expect(
      (
        await call('material.restore', {
          ...thread,
          requestId: randomUUID(),
          expectedBindingState: 'bound',
          expectedInclusionState: 'excluded',
        })
      ).outcome
    ).toBe('included');
    expect(
      (
        await call('material.unbind', {
          ...thread,
          requestId: randomUUID(),
          expectedBindingState: 'bound',
        })
      ).outcome
    ).toBe('unbound');
  } finally {
    f.db.sqlite.close();
    f.coreDb.sqlite.close();
  }
});

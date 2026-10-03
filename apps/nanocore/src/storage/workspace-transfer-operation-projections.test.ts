import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BootReadinessSnapshot } from '@openkit/app-api-schemas';
import { PROTOCOL_VERSION } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import { ensureLocalUser } from '../auth/identity.js';
import {
  isCurrentDeploymentAdministrator,
  isWorkspaceOperationAuthorized,
} from '../auth/operation-authorizer.js';
import { computeBootReadinessSnapshot } from '../bootstrap/readiness.js';
import { createDemoWorkspaceForUser, FsStore } from '../lib/store.js';
import { createApp } from '../test-support/app.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';

const fixtures: Array<{ root: string; db: ReturnType<typeof openCoreDb> }> = [];
afterEach(() => {
  for (const { root, db } of fixtures.splice(0)) {
    if (db.sqlite.open) db.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/** Owns explicit local identity, membership and portable data for the projection proof. */
function fixture(getBootReadiness?: () => BootReadinessSnapshot) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-b14-'));
  const db = openCoreDb(root);
  applyMigrations(db);
  ensureLocalUser(db);
  const store = new FsStore({ dataRoot: root });
  const demo = createDemoWorkspaceForUser('user_local');
  store.importWorkspaceSnapshot({
    workspace: demo.workspace,
    threads: [demo.thread],
    knowledge: [],
    turns: [],
    itemRevisions: [],
    artifacts: [],
    agentSessions: [],
    turnEvents: [],
  });
  recordWorkspaceOwnerMembership({
    coreDb: db,
    ownerUserId: 'user_local',
    workspaceId: demo.workspace.id,
  });
  fixtures.push({ root, db });
  return {
    root,
    db,
    store,
    app: createApp({
      dataRoot: root,
      coreDb: db,
      store,
      ...(getBootReadiness ? { getBootReadiness } : {}),
    }),
  };
}

/** Sends caller-owned bytes without supplying authority or fixture defaults. */
function request(path: string, body: unknown) {
  return [
    path,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  ] as const;
}

/** Reads the specific native export usage owner without acquiring authority for the caller. */
function exportUsage(root: string) {
  const workspaceDb = openWorkspaceDb(root, 'ws_demo');
  try {
    applyScopedMigrations(workspaceDb);
    return workspaceDb.sqlite
      .prepare("SELECT * FROM usage_records WHERE category = 'storage' ORDER BY usage_id")
      .all();
  } finally {
    workspaceDb.sqlite.close();
  }
}

describe('Workspace JSON transfer cutover', () => {
  it.each([
    'workspace.import-dry-run',
    'workspace.import',
  ] as const)('%s preserves canonical-user HTTP admission with a valid creator handle', async (operation) => {
    const { app, db, root, store } = fixture();
    const exported = await app.request(
      ...request('/api/app/operations/workspace.export', { workspaceId: 'ws_demo' })
    );
    expect(exported.status).toBe(200);
    const { exportId } = await exported.json();
    const input = { sourceWorkspaceId: 'ws_demo', exportId };
    const sessionApp = createApp({
      dataRoot: root,
      coreDb: db,
      store,
      mode: 'server',
      auth: {
        api: {
          getSession: async () => ({
            session: { id: 'creator_session' },
            user: { id: 'user_local' },
          }),
        },
        handler: async () => Response.json({ status: 'auth-ok' }),
      },
    });
    const ordinary = createOpenKitAccessTokenRecord(db, {
      ownerUserId: 'user_local',
      scope: 'workspace',
      workspaceIds: ['ws_demo'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const admin = createOpenKitAccessTokenRecord(db, {
      ownerUserId: 'user_local',
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const registry = db.sqlite
      .prepare('SELECT * FROM workspace_registry ORDER BY workspace_id')
      .all();
    const published = readdirSync(join(root, 'workspaces'));
    const [url, init] = request(`/api/app/operations/${operation}`, input);
    const refused = await sessionApp.request(url, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${ordinary.secret}` },
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'workspace_access_denied' });
    expect(
      db.sqlite.prepare('SELECT * FROM workspace_registry ORDER BY workspace_id').all()
    ).toEqual(registry);
    expect(readdirSync(join(root, 'workspaces'))).toEqual(published);
    const session = await sessionApp.request(url, init);
    expect(session.status, await session.clone().text()).toBe(200);
    const administrator = await sessionApp.request(url, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${admin.secret}` },
    });
    expect(administrator.status, await administrator.clone().text()).toBe(200);
  });

  it('refuses private export consumption after its source-owner creator loses administrator eligibility', async () => {
    const { db, root, store } = fixture();
    const now = Date.now();
    db.sqlite
      .prepare(
        "INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind) VALUES ('user_private', 'Private owner', 'private@example.test', 0, ?, ?, 'human')"
      )
      .run(now, now);
    store.createThread('ws_demo', 'Another user private history', undefined, undefined, {
      visibility: 'private',
      privateOwnerUserId: 'user_private',
    });
    const token = createOpenKitAccessTokenRecord(db, {
      ownerUserId: 'user_local',
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const app = createApp({
      dataRoot: root,
      coreDb: db,
      store,
      mode: 'server',
      auth: {
        api: {
          getSession: async () => ({
            session: { id: 'creator_session' },
            user: { id: 'user_local' },
          }),
        },
        handler: async () => Response.json({ status: 'auth-ok' }),
      },
    });
    const [url, init] = request('/api/app/operations/workspace.export', { workspaceId: 'ws_demo' });
    const exported = await app.request(url, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${token.secret}` },
    });
    expect(exported.status, await exported.clone().text()).toBe(200);
    const { exportId } = await exported.json();
    const archivePath = `/api/app/workspaces/ws_demo/exports/${exportId}/archive`;
    const eligible = await app.request(archivePath, {
      headers: { authorization: `Bearer ${token.secret}` },
    });
    expect(eligible.status).toBe(200);
    expect((await eligible.arrayBuffer()).byteLength).toBeGreaterThan(0);
    for (const operation of ['workspace.import-dry-run', 'workspace.import']) {
      const [operationUrl, operationInit] = request(`/api/app/operations/${operation}`, {
        sourceWorkspaceId: 'ws_demo',
        exportId,
      });
      const response = await app.request(operationUrl, {
        ...operationInit,
        headers: { ...operationInit.headers, authorization: `Bearer ${token.secret}` },
      });
      expect(response.status, await response.clone().text()).toBe(200);
    }
    revokeOpenKitAccessTokenRecord(db, token.record.tokenId);
    expect(isCurrentDeploymentAdministrator(db, { kind: 'session', userId: 'user_local' })).toBe(
      false
    );
    expect(
      isWorkspaceOperationAuthorized(db, { kind: 'session', userId: 'user_local' }, 'ws_demo', {
        mutating: false,
        policyOperation: 'workspace.export',
      })
    ).toBe(true);
    const registry = db.sqlite
      .prepare('SELECT * FROM workspace_registry ORDER BY workspace_id')
      .all();
    const published = readdirSync(join(root, 'workspaces'));
    const archive = await app.request(archivePath);
    const body = Buffer.from(await archive.arrayBuffer());
    expect.soft(archive.status).toBe(403);
    expect.soft(archive.headers.get('content-type')).toContain('application/json');
    // Parsing the complete response as this exact refusal proves no archive bytes were released.
    expect(JSON.parse(body.toString())).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      code: 'workspace_export_archive_forbidden',
      message: 'Workspace export archive is unavailable.',
    });
    for (const operation of ['workspace.import-dry-run', 'workspace.import']) {
      const response = await app.request(
        ...request(`/api/app/operations/${operation}`, { sourceWorkspaceId: 'ws_demo', exportId })
      );
      expect.soft(response.status).toBe(403);
      expect.soft(await response.json()).toMatchObject({ code: 'workspace_import_forbidden' });
    }
    expect(
      db.sqlite.prepare('SELECT * FROM workspace_registry ORDER BY workspace_id').all()
    ).toEqual(registry);
    expect(readdirSync(join(root, 'workspaces'))).toEqual(published);
  });

  it('retires the authorized former bindings without an alias', async () => {
    const { app, store, root } = fixture();
    const usage = exportUsage(root);
    const before = store.listWorkspaces().map(({ id }) => id);
    for (const path of [
      '/api/app/workspaces/ws_demo/export',
      '/api/app/workspace-imports/dry-run',
      '/api/app/workspace-imports',
    ]) {
      const response = await app.request(
        ...request(path, { sourceWorkspaceId: 'ws_demo', exportId: 'absent' })
      );
      expect(response.status, path).toBe(404);
    }
    expect(store.listWorkspaces().map(({ id }) => id)).toEqual(before);
    expect(exportUsage(root)).toEqual(usage);
  });

  it('canonical export, dry-run and import reach their existing owners', async () => {
    const { app, store, db } = fixture();
    const exported = await app.request(
      ...request('/api/app/operations/workspace.export', { workspaceId: 'ws_demo' })
    );
    expect(exported.status, await exported.clone().text()).toBe(200);
    const { exportId } = await exported.json();
    const input = { sourceWorkspaceId: 'ws_demo', exportId };
    const before = db.sqlite
      .prepare('SELECT * FROM workspace_registry ORDER BY workspace_id')
      .all();
    const preview = await app.request(
      ...request('/api/app/operations/workspace.import-dry-run', input)
    );
    expect(preview.status, await preview.clone().text()).toBe(200);
    expect((await preview.json()).mode).toBe('dry-run');
    expect(
      db.sqlite.prepare('SELECT * FROM workspace_registry ORDER BY workspace_id').all()
    ).toEqual(before);
    const [url, init] = request('/api/app/operations/workspace.import', input);
    const imported = await app.request(url, {
      ...init,
      headers: { ...init.headers, 'x-openkit-request-id': '00000000-0000-4000-8000-000000000051' },
    });
    expect(imported.status, await imported.clone().text()).toBe(200);
    const result = await imported.json();
    expect(result.requestId).toBe('00000000-0000-4000-8000-000000000051');
    expect(store.getWorkspace(result.importedWorkspaceId).id).toBe(result.importedWorkspaceId);
    expect(
      db.sqlite
        .prepare('SELECT owner_user_id FROM workspace_registry WHERE workspace_id = ?')
        .get(result.importedWorkspaceId)
    ).toEqual({ owner_user_id: 'user_local' });
  });

  it('HTTP and MCP readiness refuse export and import without tree or registry writes', async () => {
    let readiness = computeBootReadinessSnapshot({ bootId: 'b14-readiness' });
    const { app, db, root } = fixture(() => readiness);
    const exportedResponse = await app.request(
      ...request('/api/app/operations/workspace.export', { workspaceId: 'ws_demo' })
    );
    expect(exportedResponse.status).toBe(200);
    const { exportId } = await exportedResponse.json();
    const token = createOpenKitAccessTokenRecord(db, {
      ownerUserId: 'user_local',
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const exportsRoot = join(root, 'server', 'exports', 'workspaces', 'ws_demo');
    const trees = readdirSync(exportsRoot);
    const registry = db.sqlite
      .prepare('SELECT * FROM workspace_registry ORDER BY workspace_id')
      .all();
    readiness = computeBootReadinessSnapshot({
      bootId: 'b14-readiness',
      subsystems: {
        storage: {
          state: 'failed',
          reasons: [
            { code: 'storage.failed', message: 'Storage unavailable.', blocks: ['product_work'] },
          ],
        },
      },
    });
    for (const [operation, input] of [
      ['workspace.export', { workspaceId: 'ws_demo' }],
      ['workspace.import', { sourceWorkspaceId: 'ws_demo', exportId }],
    ] as const) {
      const response = await app.request(...request(`/api/app/operations/${operation}`, input));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'product_work_unavailable' });
      const rpc = await app.request('http://127.0.0.1/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token.secret}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'call', arguments: { operation, input } },
        }),
      });
      expect(rpc.status).toBe(200);
      const result = (await rpc.json()).result;
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        code: 'product_work_unavailable',
      });
    }
    const preview = await app.request(
      ...request('/api/app/operations/workspace.import-dry-run', {
        sourceWorkspaceId: 'ws_demo',
        exportId,
      })
    );
    expect(preview.status).toBe(200);
    expect(readdirSync(exportsRoot)).toEqual(trees);
    expect(
      db.sqlite.prepare('SELECT * FROM workspace_registry ORDER BY workspace_id').all()
    ).toEqual(registry);
  });

  it('refuses read-only and revoked export credentials before export usage or tree writes', async () => {
    const { db, root, store } = fixture();
    const app = createApp({ dataRoot: root, coreDb: db, store, mode: 'server' });
    const readonly = createOpenKitAccessTokenRecord(db, {
      ownerUserId: 'user_local',
      scope: 'workspace-readonly',
      workspaceIds: ['ws_demo'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const revoked = createOpenKitAccessTokenRecord(db, {
      ownerUserId: 'user_local',
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    revokeOpenKitAccessTokenRecord(db, revoked.record.tokenId);
    const registry = db.sqlite
      .prepare('SELECT * FROM workspace_registry ORDER BY workspace_id')
      .all();
    const exports = readdirSync(join(root, 'server', 'exports'));
    const usage = exportUsage(root);
    for (const [secret, status] of [
      [readonly.secret, 403],
      [revoked.secret, 401],
    ] as const) {
      const [url, init] = request('/api/app/operations/workspace.export', {
        workspaceId: 'ws_demo',
      });
      const response = await app.request(url, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${secret}` },
      });
      expect(response.status).toBe(status);
    }
    expect(readdirSync(join(root, 'server', 'exports'))).toEqual(exports);
    expect(exportUsage(root)).toEqual(usage);
    expect(
      db.sqlite.prepare('SELECT * FROM workspace_registry ORDER BY workspace_id').all()
    ).toEqual(registry);
  });

  it('rejects caller-selected administrator eligibility without creating an export', async () => {
    const { app, root } = fixture();
    const before = exportUsage(root);
    const trees = readdirSync(join(root, 'server', 'exports'));
    const response = await app.request(
      ...request('/api/app/operations/workspace.export', {
        workspaceId: 'ws_demo',
        administratorEligible: true,
      })
    );
    expect(response.status).toBe(400);
    expect(exportUsage(root)).toEqual(before);
    expect(readdirSync(join(root, 'server', 'exports'))).toEqual(trees);
  });

  it('keeps an administrator private export inaccessible to the non-creating source owner', async () => {
    const { app, store, db, root } = fixture();
    const now = Date.now();
    db.sqlite
      .prepare(
        "INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind) VALUES ('user_source', 'Source', 'source@example.test', 0, ?, ?, 'human')"
      )
      .run(now, now);
    const workspace = store.createWorkspace('Source-owned private data');
    recordWorkspaceOwnerMembership({
      coreDb: db,
      ownerUserId: 'user_source',
      workspaceId: workspace.id,
    });
    store.createThread(workspace.id, 'Private project', undefined, undefined, {
      visibility: 'private',
      privateOwnerUserId: 'user_local',
    });
    const exported = await app.request(
      ...request('/api/app/operations/workspace.export', { workspaceId: workspace.id })
    );
    expect(exported.status, await exported.clone().text()).toBe(200);
    const { exportId } = await exported.json();
    const ownerApp = createApp({
      dataRoot: root,
      coreDb: db,
      store,
      mode: 'server',
      auth: {
        api: {
          getSession: async () => ({
            session: { id: 'source_session' },
            user: { id: 'user_source' },
          }),
        },
        handler: async () => Response.json({ status: 'auth-ok' }),
      },
    });
    const archive = await ownerApp.request(
      `/api/app/workspaces/${workspace.id}/exports/${exportId}/archive`
    );
    expect(archive.status).toBe(403);
    const creatorDownload = await app.request(
      `/api/app/workspaces/${workspace.id}/exports/${exportId}/archive`
    );
    expect(creatorDownload.status).toBe(200);
    expect((await creatorDownload.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it.each([
    ['missing call', 'DELETE FROM capability_calls WHERE call_id = ?'],
    ['missing creator proof', 'DELETE FROM usage_records WHERE capability_call_id = ?'],
    [
      'different recorded actor',
      "UPDATE usage_records SET responsible_user_id = 'user_other' WHERE capability_call_id = ?",
    ],
    [
      'contradictory recorded actor',
      "UPDATE usage_records SET responsible_user_id = 'user_other' WHERE capability_call_id = ? AND unit = 'bytes'",
    ],
  ])('fails closed on %s without publishing an imported Workspace', async (_case, mutation) => {
    const { app, db, root } = fixture();
    const exported = await app.request(
      ...request('/api/app/operations/workspace.export', { workspaceId: 'ws_demo' })
    );
    expect(exported.status).toBe(200);
    const { exportId } = await exported.json();
    const workspaceDb = openWorkspaceDb(root, 'ws_demo');
    try {
      workspaceDb.sqlite.prepare(mutation).run(`cap_storage_export_${exportId}`);
    } finally {
      workspaceDb.sqlite.close();
    }
    const registry = db.sqlite
      .prepare('SELECT * FROM workspace_registry ORDER BY workspace_id')
      .all();
    const archive = await app.request(`/api/app/workspaces/ws_demo/exports/${exportId}/archive`);
    expect(archive.status).toBe(403);
    expect(await archive.json()).toMatchObject({ code: 'workspace_export_archive_forbidden' });
    for (const operation of ['workspace.import-dry-run', 'workspace.import']) {
      const response = await app.request(
        ...request(`/api/app/operations/${operation}`, { sourceWorkspaceId: 'ws_demo', exportId })
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'workspace_import_forbidden' });
    }
    expect(
      db.sqlite.prepare('SELECT * FROM workspace_registry ORDER BY workspace_id').all()
    ).toEqual(registry);
  });
});

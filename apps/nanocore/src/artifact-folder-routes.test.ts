import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthVariables } from './auth/middleware.js';
import { FsStore } from './lib/store.js';
import { registerOperationJsonRoutes } from './operation-json-routes.js';
import { FileStorageAdmission } from './storage/artifacts/file-admission.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createAppWithWorkspaceAuthority as createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID as LOCAL_USER_ID } from './test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

const corpus = JSON.parse(
  readFileSync(new URL('../../../tests/fixtures/large-context/cases.json', import.meta.url), 'utf8')
) as { archives: Array<{ id: string; base64: string }> };
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** Exercises the real upload, canonical original, JSON composition and ZIP processor together. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'artifact-folder-route-'));
  cleanups.push(() => rmSync(dataRoot, { recursive: true, force: true }));
  const coreDb = openCoreDb(dataRoot);
  cleanups.push(() => coreDb.sqlite.close());
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = createDemoStore({ dataRoot });
  const workspace = store.createWorkspace('ZIP folder intake');
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: LOCAL_USER_ID, workspaceId: workspace.id });
  const app = createApp({ coreDb, dataRoot, store });
  return { dataRoot, coreDb, workspace, store, app };
}

/** Uploads frozen independently generated ZIP bytes through the exact-file operation. */
async function upload(state: ReturnType<typeof fixture>, id: string) {
  const bytes = Buffer.from(corpus.archives.find((entry) => entry.id === id)!.base64, 'base64');
  const query = new URLSearchParams({
    workspaceId: state.workspace.id,
    title: `${id}.zip`,
    mediaType: 'application/zip',
    byteLength: String(bytes.length),
    contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  });
  const requestId = randomUUID();
  const response = await state.app.request(`/api/app/operations/artifact.import?${query}`, {
    method: 'POST',
    headers: { 'x-openkit-request-id': requestId, 'content-type': 'application/zip' },
    body: bytes,
  });
  expect(response.status).toBe(201);
  const accepted = (await response.json()) as { artifactId: string; artifactVersion: number };
  return { ...accepted, workspaceId: state.workspace.id, bytes, query, requestId };
}

/** Uses governed JSON operations; no test-only folder route is mounted. */
function folder(
  state: ReturnType<typeof fixture>,
  operation: 'read' | 'extract',
  input: { workspaceId: string; artifactId: string; artifactVersion: number }
) {
  return state.app.request(`/api/app/operations/artifact.folder-${operation}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      workspaceId: input.workspaceId,
      artifactId: input.artifactId,
      artifactVersion: input.artifactVersion,
    }),
  });
}

/** Injects an ordinary authenticated session while retaining real native authorization and JSON dispatch. */
function ordinarySessionApp(state: ReturnType<typeof fixture>) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use('*', async (context, next) => {
    context.set('actor', { kind: 'session', userId: LOCAL_USER_ID });
    await next();
  });
  registerOperationJsonRoutes({
    app,
    coreDb: state.coreDb,
    dataRoot: state.dataRoot,
    store: state.store,
    requestStore: () => state.store,
    fileAdmission: new FileStorageAdmission(state.dataRoot, () => 0n),
    workspaceMutationAdmission: new WorkspaceMutationAdmission(),
  });
  return app;
}

describe('explicit ZIP folder intake', () => {
  it('keeps ordinary ZIP transfer separate, explicitly extracts, and reuses cache after restart', async () => {
    const state = fixture(),
      imported = await upload(state, 'valid-file');
    expect(await (await folder(state, 'read', imported)).json()).toMatchObject({
      status: 'unavailable',
      reason: 'not_extracted',
      originalRetained: true,
    });
    const result = await folder(state, 'extract', imported);
    expect(result.status).toBe(200);
    const ready = await result.json();
    expect(ready).toMatchObject({
      status: 'ready',
      originalRetained: true,
      fileCount: 1,
      expandedBytes: 9,
      entries: [{ relativePath: 'note.txt', byteLength: 9 }],
    });
    state.app = createApp({
      coreDb: state.coreDb,
      dataRoot: state.dataRoot,
      store: new FsStore({ dataRoot: state.dataRoot }),
    });
    expect(await (await folder(state, 'read', imported)).json()).toEqual(ready);
    const download = await state.app.request(
      `/api/app/operations/artifact.download?${new URLSearchParams({ workspaceId: imported.workspaceId, artifactId: imported.artifactId, artifactVersion: '1' })}`
    );
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(imported.bytes);
    expect(state.store.listCommandRequests()).toHaveLength(1);
  });

  it('reports failed extraction with exact original retained and never publishes a partial folder', async () => {
    const state = fixture(),
      imported = await upload(state, 'traversal');
    const response = await folder(state, 'extract', imported);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'unavailable',
      reason: 'extraction_failed',
      originalRetained: true,
    });
    expect(await (await folder(state, 'read', imported)).json()).toMatchObject({
      status: 'unavailable',
      reason: 'not_extracted',
    });
    const replay = await state.app.request(
      `/api/app/operations/artifact.import?${imported.query}`,
      {
        method: 'POST',
        headers: { 'x-openkit-request-id': imported.requestId },
        body: Buffer.from('changed retry bytes'),
      }
    );
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual({ artifactId: imported.artifactId, artifactVersion: 1 });
  });

  it('rechecks current caller eligibility before returning cached inventory or rebuilding', async () => {
    const state = fixture(),
      imported = await upload(state, 'valid-file');
    expect((await folder(state, 'extract', imported)).status).toBe(200);
    state.app = ordinarySessionApp(state);
    expect((await folder(state, 'read', imported)).status).toBe(200);
    state.coreDb.sqlite
      .prepare("UPDATE users SET status = 'disabled', disabled_at = ? WHERE id = ?")
      .run(new Date().toISOString(), LOCAL_USER_ID);
    for (const operation of ['read', 'extract'] as const) {
      const response = await folder(state, operation, imported);
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain('note.txt');
    }
  });

  it('does not disclose a private-origin folder to another ordinary member', async () => {
    const state = fixture(),
      imported = await upload(state, 'valid-file');
    const thread = state.store.createThread(
      state.workspace.id,
      'Private ZIP source',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: 'usr_00000000-0000-7000-8000-000000000002' }
    );
    const turn = state.store.createTurn(state.workspace.id, thread.id, 'Produce ZIP', {
      kind: 'user',
      id: 'usr_00000000-0000-7000-8000-000000000002',
    });
    const artifact = state.store.getArtifact(state.workspace.id, imported.artifactId);
    const staged = join(state.dataRoot, 'private-zip-stage');
    writeFileSync(staged, imported.bytes);
    const privateArtifactId = 'ar_00000000-0000-7000-8000-000000999991';
    state.store.createArtifact(
      {
        ...artifact,
        id: privateArtifactId,
        threadId: thread.id,
        turnId: turn.id,
        origin: {
          kind: 'turn-output',
          threadId: thread.id,
          turnId: turn.id,
          requestId: 'private-zip-output',
        },
        lastMutationRequestId: 'private-zip-output',
        createdAt: turn.startedAt!,
        updatedAt: turn.startedAt!,
      },
      {
        path: staged,
        byteLength: imported.bytes.length,
        contentDigest: artifact.contentDigest,
        remove: async () => {},
      }
    );
    const selected = { ...imported, artifactId: privateArtifactId };
    expect((await folder(state, 'extract', selected)).status).toBe(200);
    state.app = ordinarySessionApp(state);
    for (const operation of ['read', 'extract'] as const) {
      const response = await folder(state, operation, selected);
      expect(response.status).toBe(404);
      const body = await response.text();
      expect(body).not.toContain('note.txt');
      expect(body).not.toContain(artifact.contentDigest);
    }
  });

  it('refuses an unavailable requested version without substituting current inventory', async () => {
    const state = fixture(),
      imported = await upload(state, 'valid-file');
    expect((await folder(state, 'extract', { ...imported, artifactVersion: 2 })).status).toBe(404);
  });
});

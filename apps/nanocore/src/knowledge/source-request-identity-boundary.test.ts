// openkit-test-platform: posix
// The public command must reject identities that its retained Notebook admission cannot represent.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RegisterKnowledgeSourceResponseSchema } from '@openkit/app-api-schemas';
import { PROTOCOL_VERSION } from '@openkit/protocol';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { FsStore } from '../lib/store.js';
import { closeRetrievalServices } from '../retrieval-service.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createApp } from '../test-support/app.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { readTestWorkspaceNotebookSelection } from '../test-support/workspace-notebook.js';
import { readWorkspaceSourceFixture } from '../test-support/workspace-source.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import * as sourcePublication from './source-publication.js';

afterEach(() => vi.restoreAllMocks());

/** One real current owner; requests cross the public parser, native publisher and actual local Storage. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'source-request-identity-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Source request identity');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  applyScopedMigrations(workspaceDb);
  const app = createApp({ coreDb, dataRoot, store });
  const root = join(dataRoot, 'workspaces', workspace.id, 'knowledge');
  const register = (requestId: string, fields: Record<string, unknown> = {}) =>
    app.request(
      ...operationRequest(
        'knowledge.source.register',
        { workspaceId: workspace.id },
        {
          body: JSON.stringify({
            requestId,
            kind: 'document',
            title: 'One admitted original',
            content: 'Exact UUID-command original.\r\nUnicode Ω 雪.\n',
            ...fields,
          }),
        }
      )
    );
  onTestFinished(async () => {
    await closeRetrievalServices();
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  return {
    dataRoot,
    coreDb,
    userId,
    store,
    workspace,
    workspaceDb,
    get notebook() {
      return readTestWorkspaceNotebookSelection(dataRoot, workspace.id).notebook;
    },
    root,
    register,
  };
}

/** Observe all managed original file bytes, including any orphan from a refused capture. */
function rawFiles(root: string): Record<string, string> {
  if (!existsSync(root)) return {};
  const files: Record<string, string> = {};
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const [path, bytes] of Object.entries(rawFiles(join(root, entry.name))))
        files[`${entry.name}/${path}`] = bytes;
    } else files[entry.name] = readFileSync(join(root, entry.name)).toString('base64');
  }
  return files;
}

describe('public Source request identity', () => {
  it('refuses an opaque request ID before Source, raw original or command receipt effects', async () => {
    const f = await fixture();
    const before = {
      revision: f.notebook.publishedRevision(),
      raw: rawFiles(join(f.root, 'raw')),
      sources: f.store.listKnowledgeSources(f.workspace.id),
      receipts: f.store.listCommandRequests(),
    };
    const response = await f.register('opaque-source-command');
    expect.soft(response.status).toBe(400);
    expect.soft(await response.json()).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      code: 'invalid_request',
    });
    expect({
      revision: f.notebook.publishedRevision(),
      raw: rawFiles(join(f.root, 'raw')),
      sources: f.store.listKnowledgeSources(f.workspace.id),
      receipts: f.store.listCommandRequests(),
    }).toEqual(before);
    expect(
      f.workspaceDb.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_events WHERE request_id = ? AND action IN ('knowledge.source.register', 'knowledge.notebook.admit')"
        )
        .get('opaque-source-command')
    ).toEqual({ count: 0 });
  });

  it('captures and replays one UUID request with exact original bytes and retained request identity', async () => {
    const f = await fixture();
    const requestId = randomUUID();
    const response = await f.register(requestId);
    expect(response.status).toBe(200);
    const result = RegisterKnowledgeSourceResponseSchema.parse(await response.json());
    const original = 'Exact UUID-command original.\r\nUnicode Ω 雪.\n';
    const revision = f.notebook.publishedRevision();
    const raw = rawFiles(join(f.root, 'raw'));
    const receipts = f.store.listCommandRequests();
    expect(result.source).toMatchObject({
      workspaceId: f.workspace.id,
      contentDigest: `sha256:${createHash('sha256').update(original).digest('hex')}`,
    });
    expect(Object.keys(f.notebook.readSourcePointers(revision))).toEqual([result.source.id]);
    expect(f.notebook.readRevision(revision).metadata.changeRequest.requestId).toBe(requestId);
    expect(
      await readWorkspaceSourceFixture({
        dataRoot: f.dataRoot,
        coreDb: f.coreDb,
        store: f.store,
        userId: f.userId,
        workspaceId: f.workspace.id,
        sourceId: result.source.id,
      })
    ).toEqual({ status: 'ok', value: original });
    const replay = await f.register(requestId);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(result);
    expect(f.notebook.publishedRevision()).toBe(revision);
    expect(rawFiles(join(f.root, 'raw'))).toEqual(raw);
    expect(f.store.listCommandRequests()).toEqual(receipts);
    expect(f.store.listKnowledgeSources(f.workspace.id)).toEqual([result.source]);
    expect(
      f.workspaceDb.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_events WHERE request_id = ? AND action = 'knowledge.source.register'"
        )
        .get(requestId)
    ).toEqual({ count: 1 });
  });
  it.each([
    'success',
    'refusal',
  ] as const)('closes its publication database after %s', async (outcome) => {
    const f = await fixture();
    const publish = sourcePublication.publishCapturedSource;
    let publicationDb: WorkspaceDb | undefined;
    vi.spyOn(sourcePublication, 'publishCapturedSource').mockImplementation(async (...args) => {
      if (args[0].database.kind === 'workspace') publicationDb = args[0].database.workspaceDb;
      return publish(...args);
    });
    const response = await f.register(
      randomUUID(),
      outcome === 'refusal' ? { originatingTurnId: 'tu_00000000-0000-7577-9378-7e96d0d15fd2' } : {}
    );
    expect(response.status).toBe(outcome === 'success' ? 200 : 404);
    expect(publicationDb).toBeDefined();
    expect(publicationDb!.sqlite.open).toBe(false);
    if (outcome === 'refusal') expect(f.store.listKnowledgeSources(f.workspace.id)).toEqual([]);
  });
});

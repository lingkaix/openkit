import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonOperationId } from '@openkit/app-api-schemas';
import { allocateEntityId } from '@openkit/protocol';
import { expect, it, onTestFinished } from 'vitest';
import { initializeDefaultKnowledgeBaseId } from './config/knowledge-base.js';
import { FsStore } from './lib/store.js';
import { createOperationInvocation } from './operation-composition.js';
import { closeRetrievalServices } from './retrieval-service.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

/** Hashes the exact UTF-8 input independently of the Material owner. */
function digest(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

/** Uses public operation admission and real Store/SQLite on a private data root. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'material-content-bound-'));
  const coreDb = openCoreDb(root);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  initializeDefaultKnowledgeBaseId({
    dataRoot: root,
    scope: { kind: 'server' },
    knowledgeBaseId: allocateEntityId('kb'),
  });
  let store = new FsStore({ dataRoot: root });
  const workspace = await store.createWorkspace('Material content bounds');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  let db = openWorkspaceDb(root, workspace.id);
  const compose = () =>
    createOperationInvocation({
      coreDb,
      store,
      dataRoot: root,
      inflightCommands: new WeakMap(),
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      repositoryWorkspaceDb: (id) => openWorkspaceDb(root, id),
    });
  let invoke = compose();
  const call = <K extends JsonOperationId>(id: K, input: object) =>
    invoke(
      id,
      { workspaceId: workspace.id, ...input },
      {
        kind: 'public',
        actor: { kind: 'session', userId },
      }
    );
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    closeRetrievalServices();
    if (db.sqlite.open) db.sqlite.close();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  const { materialId } = await call('material.create', {
    requestId: 'create-material',
    title: 'Exact source',
    kind: 'text',
    sensitivity: 'internal',
  });
  return {
    root,
    materialId,
    call,
    get db() {
      return db;
    },
    async reopen() {
      await shutdownControlStoreWorkerClient();
      db.sqlite.close();
      store = new FsStore({ dataRoot: root });
      db = openWorkspaceDb(root, workspace.id);
      invoke = compose();
    },
  };
}

it.each([
  {
    name: 'exactly 16,777,216 UTF-8 bytes',
    content: () => 'a'.repeat(16_777_216),
    bytes: 16_777_216,
  },
  {
    name: 'escape-heavy content at the byte limit',
    content: () => `${'\0'.repeat(16_777_214)}Z\n`,
    bytes: 16_777_216,
  },
  {
    name: 'an ordinary small save',
    content: () => 'An ordinary Material.\r\n',
    bytes: 23,
  },
])('public Material save preserves $name with its original receipt', async ({ content, bytes }) => {
  const f = await fixture();
  const text = content();
  const expectedBytes = Buffer.from(text, 'utf8');
  expect(expectedBytes.byteLength).toBe(bytes);
  const input = {
    materialId: f.materialId,
    requestId: 'save-content',
    expectedRevisionId: null,
    content: text,
    contentDigest: digest(text),
  };
  const result = await f.call('material.revision-save', input);
  for (const cold of [false, true]) {
    if (cold) await f.reopen();
    const { revision } = await f.call('material.revision-read', {
      materialId: f.materialId,
      revisionId: result.revisionId,
    });
    // A boolean comparison prevents a failed boundary from dumping a 16 MiB diff.
    expect(Buffer.from(revision.content, 'utf8').equals(expectedBytes)).toBe(true);
    expect(revision.contentDigest).toBe(input.contentDigest);
    expect(await f.call('material.read', { materialId: f.materialId })).toMatchObject({
      material: { currentRevisionId: result.revisionId },
    });
    expect(
      f.db.sqlite
        .prepare(
          'SELECT command_name, response_kind, response_id FROM idempotency_requests WHERE request_id = ?'
        )
        .all(input.requestId)
    ).toEqual([
      {
        command_name: 'material.save',
        response_kind: 'material_revision',
        response_id: result.revisionId,
      },
    ]);
  }
});

it.each([
  {
    name: '16,777,217 ASCII bytes',
    content: () => 'a'.repeat(16_777_217),
    bytes: 16_777_217,
  },
  {
    name: 'multibyte content below the character limit but above the UTF-8 byte limit',
    content: () => '€'.repeat(5_592_406),
    bytes: 16_777_218,
  },
])('public Material save refuses $name before effects', async ({ content, bytes }) => {
  const f = await fixture();
  const text = content();
  expect(Buffer.byteLength(text, 'utf8')).toBe(bytes);
  if (bytes === 16_777_218) expect(text.length).toBeLessThan(16_777_216);
  const beforeMaterial = await f.call('material.read', { materialId: f.materialId });
  const beforeReceipts = f.db.sqlite
    .prepare('SELECT * FROM idempotency_requests ORDER BY request_key')
    .all();
  const beforeFiles = readdirSync(f.root, { recursive: true }).sort();
  const outcome = await f
    .call('material.revision-save', {
      materialId: f.materialId,
      requestId: 'oversized-content',
      expectedRevisionId: null,
      content: text,
      contentDigest: digest(text),
    })
    .then(
      () => ({ status: 'accepted' }),
      (error: unknown) => ({ status: 'refused', error })
    );
  expect.soft(outcome).toMatchObject({
    status: 'refused',
    error: { status: 400, code: 'invalid_request' },
  });
  expect.soft(await f.call('material.read', { materialId: f.materialId })).toEqual(beforeMaterial);
  expect
    .soft(f.db.sqlite.prepare('SELECT revision_id FROM workspace_material_revisions').all())
    .toEqual([]);
  expect
    .soft(f.db.sqlite.prepare('SELECT * FROM idempotency_requests ORDER BY request_key').all())
    .toEqual(beforeReceipts);
  expect.soft(readdirSync(f.root, { recursive: true }).sort()).toEqual(beforeFiles);
});

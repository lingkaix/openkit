import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { LocalStorage, type StorageAccess, type StorageResult } from '@openkit/storage';
import { expect, it, onTestFinished } from 'vitest';
import { KnowledgeNotebook } from '../knowledge/notebook.js';
import { DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT } from '../knowledge/okf.js';
import {
  type ControlKnowledgeHead,
  controlKnowledgeHeadStatements,
  prepareControlKnowledgeHead,
  readControlKnowledgeHead,
} from './control-store-knowledge.js';
import { getControlStoreWorkerClient } from './control-store-worker-client.js';
import { openWorkspaceDb } from './db.js';
import { workspaceDbPath } from './fs-layout.js';
import { type ImmutableContentHandoff, publishImmutableContent } from './immutable-content.js';
import { applyScopedMigrations } from './migrate.js';

/** Requires genuine Storage publication; a refused setup cannot prove a native head. */
function storageValue<T>(result: StorageResult<T>): T {
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error(`Storage setup refused: ${result.status}`);
  return result.value;
}

/** Owns an isolated Workspace journal, real Git commits and an admitted immutable mount. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'control-knowledge-head-'));
  const workspaceId = allocateEntityId('ws');
  const knowledgeBaseId = allocateEntityId('kb');
  const owner = { kind: 'workspace' as const, workspaceId };
  let db = openWorkspaceDb(root, workspaceId);
  applyScopedMigrations(db);
  const client = getControlStoreWorkerClient();
  const contentRoot = join(root, 'immutable');
  const stagingRoot = join(root, 'staging');
  mkdirSync(contentRoot);
  mkdirSync(stagingRoot);
  const storage = new LocalStorage({
    mounts: [{ knowledgeBaseId, ownerScope: owner, name: 'private', root: contentRoot }],
    stagingRoot,
  });
  onTestFinished(async () => {
    await client.shutdown();
    db.sqlite.close();
    await storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  const access: StorageAccess = {
    basis: 'lease',
    grantId: allocateEntityId('grant'),
    knowledgeBaseId,
    ownerScope: owner,
    mount: 'private',
    pathPrefix: '',
    mode: 'staged-write',
    expiresAt: '2099-01-01T00:00:00.000Z',
    revoked: false,
  };
  const stageContent = async (text: string): Promise<ImmutableContentHandoff> => {
    const bytes = Buffer.from(text);
    const { handle } = storageValue(
      await storage.beginStage({
        access,
        locator: { ownerScope: owner, mount: 'private', path: 'schema.yaml' },
        maxByteLength: bytes.length,
      })
    );
    storageValue(await storage.writeStage({ access, handle, data: bytes.toString('base64') }));
    const stage = storageValue(await storage.finishStage({ access, handle }));
    return { storage, access, stage, mountRoot: contentRoot };
  };
  const discard = async (content: ImmutableContentHandoff) =>
    storageValue(await storage.discardStage({ access, handle: content.stage.handle }));
  const publish = async (text: string) => {
    const content = await stageContent(text);
    try {
      return await publishImmutableContent(content);
    } finally {
      await discard(content);
    }
  };
  const notebook = new KnowledgeNotebook({ repositoryPath: join(root, 'notebook.git') });
  const metadata = {
    summary: 'Native head content fixture',
    changeRequest: { requestId: 'head-content', inputDigest: `sha256:${'1'.repeat(64)}` },
    producer: { kind: 'user' as const, id: allocateEntityId('usr') },
    authority: { kind: 'direct' as const, instructionReference: 'item:head-content' },
    sourceReferences: [],
  };
  const notebookCommit = notebook.initialize({ metadata });
  await client.open({
    database: 'knowledge',
    path: workspaceDbPath(root, workspaceId),
    create: false,
    initialize: 'workspace',
    productOwner: owner,
    contentMount: { root: contentRoot, knowledgeBaseId, mount: 'private' },
  });
  const head: ControlKnowledgeHead = {
    workspaceId,
    knowledgeBaseId,
    notebookCommit,
    schemaContent: await publish(DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT),
  };
  return {
    client,
    head,
    publish,
    stageContent,
    discard,
    notebook,
    metadata,
    contentEntries: () => readdirSync(contentRoot, { recursive: true }).sort(),
    db: () => db,
    bytes: (value: ControlKnowledgeHead) =>
      readFileSync(join(contentRoot, value.schemaContent.reference.locator.path), 'utf8'),
    reopen: async () => {
      await client.shutdown();
      db.sqlite.close();
      db = openWorkspaceDb(root, workspaceId);
    },
  };
}

it('commits the exact Git and schema tuple, refuses either stale identity and survives cold reopen', async () => {
  const f = await fixture();
  expect(readControlKnowledgeHead(f.db(), f.head.knowledgeBaseId)).toBeNull();
  await f.client.write('knowledge', controlKnowledgeHeadStatements(f.head, null));
  expect(readControlKnowledgeHead(f.db(), f.head.knowledgeBaseId)).toEqual(f.head);
  const schemaText = `# Exact original schema: précis\r\n${DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT}`;
  const schemaOnly = { ...f.head, schemaContent: await f.publish(schemaText) };
  await f.client.write('knowledge', controlKnowledgeHeadStatements(schemaOnly, f.head));
  const next = {
    ...schemaOnly,
    notebookCommit: f.notebook.prepare({
      baseRevision: f.head.notebookCommit,
      changes: { 'index.md': '# Changed immutable content\n' },
      metadata: { ...f.metadata, summary: 'Next Git content' },
    }),
  };
  // NotebookEditing11/DX147-148: schema-only advancement invalidates a prepared base.
  await expect(
    f.client.write('knowledge', controlKnowledgeHeadStatements(next, f.head))
  ).rejects.toThrow();
  expect(readControlKnowledgeHead(f.db(), f.head.knowledgeBaseId)).toEqual(schemaOnly);
  await expect(
    f.client.write('knowledge', controlKnowledgeHeadStatements(next, next))
  ).rejects.toThrow();
  expect(readControlKnowledgeHead(f.db(), f.head.knowledgeBaseId)).toEqual(schemaOnly);
  await f.client.write('knowledge', controlKnowledgeHeadStatements(next, schemaOnly));
  await f.reopen();
  expect(readControlKnowledgeHead(f.db(), f.head.knowledgeBaseId)).toEqual(next);
  expect(f.bytes(f.head)).toBe(DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT);
  expect(f.bytes(next)).toBe(schemaText);
});

it('tolerates inert retained additions and refuses malformed or foreign head authority', async () => {
  const f = await fixture();
  await f.client.write('knowledge', controlKnowledgeHeadStatements(f.head, null));
  const retained = f
    .db()
    .sqlite.prepare(
      'SELECT record_json FROM knowledge_notebook_heads WHERE workspace_id = ? AND knowledge_base_id = ?'
    )
    .get(f.head.workspaceId, f.head.knowledgeBaseId) as { record_json: string };
  const record = JSON.parse(retained.record_json);
  const replace = (value: unknown) =>
    f
      .db()
      .sqlite.prepare(
        'UPDATE knowledge_notebook_heads SET record_json = ? WHERE workspace_id = ? AND knowledge_base_id = ?'
      )
      .run(JSON.stringify(value), f.head.workspaceId, f.head.knowledgeBaseId);
  replace({ note: 'Inert annotation', ...record });
  expect(readControlKnowledgeHead(f.db(), f.head.knowledgeBaseId)).toEqual(f.head);
  // COMPAT-001: additive annotations cannot turn semantic CAS into JSON-order equality.
  await f.client.write('knowledge', controlKnowledgeHeadStatements(f.head, f.head));
  for (const fault of [
    { ...record, requiredFeatures: ['unsupported-head-authority'] },
    { ...record, workspaceId: allocateEntityId('ws') },
    { ...record, knowledgeBaseId: allocateEntityId('kb') },
    { ...record, schemaContent: { ...record.schemaContent, byteLength: -1 } },
  ]) {
    replace(fault);
    expect(() => readControlKnowledgeHead(f.db(), f.head.knowledgeBaseId)).toThrow();
  }
  const closedOwnerFault = {
    ...record,
    schemaContent: {
      ...record.schemaContent,
      reference: {
        ...record.schemaContent.reference,
        locator: {
          ...record.schemaContent.reference.locator,
          ownerScope: {
            ...record.schemaContent.reference.locator.ownerScope,
            extraUserId: allocateEntityId('usr'),
          },
        },
      },
    },
  };
  // COMPAT-001: unknown authority-bearing owner fields must not be overwritten as inert data.
  replace(closedOwnerFault);
  expect(() => readControlKnowledgeHead(f.db(), f.head.knowledgeBaseId)).toThrow();
  await expect(
    f.client.write('knowledge', controlKnowledgeHeadStatements(f.head, f.head))
  ).rejects.toThrow();
  expect(
    f
      .db()
      .sqlite.prepare(
        'SELECT record_json FROM knowledge_notebook_heads WHERE workspace_id = ? AND knowledge_base_id = ?'
      )
      .get(f.head.workspaceId, f.head.knowledgeBaseId)
  ).toEqual({ record_json: JSON.stringify(closedOwnerFault) });
  const duplicateCommit = f.notebook.prepare({
    baseRevision: f.head.notebookCommit,
    changes: { 'index.md': '# Another genuine immutable commit\n' },
    metadata: { ...f.metadata, summary: 'Duplicate-key fault content' },
  });
  const duplicateCore = JSON.stringify({ ...record, notebookCommit: duplicateCommit }).replace(
    '{',
    `{"notebookCommit":${JSON.stringify(f.head.notebookCommit)},`
  );
  // COMPAT-001: native SQL and retained decoding must not choose different core identities.
  f.db()
    .sqlite.prepare(
      'UPDATE knowledge_notebook_heads SET record_json = ? WHERE workspace_id = ? AND knowledge_base_id = ?'
    )
    .run(duplicateCore, f.head.workspaceId, f.head.knowledgeBaseId);
  expect(() => readControlKnowledgeHead(f.db(), f.head.knowledgeBaseId)).toThrow();
  await expect(
    f.client.write('knowledge', controlKnowledgeHeadStatements(f.head, f.head))
  ).rejects.toThrow();
  expect(
    f
      .db()
      .sqlite.prepare(
        'SELECT record_json FROM knowledge_notebook_heads WHERE workspace_id = ? AND knowledge_base_id = ?'
      )
      .get(f.head.workspaceId, f.head.knowledgeBaseId)
  ).toEqual({ record_json: duplicateCore });
  replace(record);
  expect(readControlKnowledgeHead(f.db(), f.head.knowledgeBaseId)).toEqual(f.head);
});

it('prepares exact original schema bytes without SQL effects and refuses invalid preparation inputs', async () => {
  const f = await fixture();
  const schemaText = `# Original schema: précis\r\n${DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT.replace(/\n/g, '\r\n')}# Retained comment.\r\n`;
  const content = await f.stageContent(schemaText);
  const input = {
    db: f.db(),
    knowledgeBaseId: f.head.knowledgeBaseId,
    notebook: f.notebook,
    notebookCommit: f.head.notebookCommit,
    schemaText,
    content,
  };
  const before = f.db().sqlite.serialize();
  try {
    const prepared = await prepareControlKnowledgeHead(input);
    // Storage51/DX148: the admitted head retains original bytes, not re-encoded YAML.
    expect(prepared).toMatchObject({
      workspaceId: f.head.workspaceId,
      knowledgeBaseId: f.head.knowledgeBaseId,
      notebookCommit: f.head.notebookCommit,
      schemaContent: {
        byteLength: Buffer.byteLength(schemaText),
        mediaType: content.stage.content.mediaType,
        reference: {
          contentDigest: `sha256:${createHash('sha256').update(schemaText).digest('hex')}`,
        },
      },
    });
    expect(f.bytes(prepared)).toBe(schemaText);
    expect(readControlKnowledgeHead(f.db(), f.head.knowledgeBaseId)).toBeNull();
    const publishedEntries = f.contentEntries();

    const invalidSchema = 'schema_version: openkit-scope-knowledge-schema-v999\r\n';
    const invalidContent = await f.stageContent(invalidSchema);
    try {
      await expect(
        prepareControlKnowledgeHead({
          ...input,
          schemaText: invalidSchema,
          content: invalidContent,
        })
      ).rejects.toThrow();
    } finally {
      await f.discard(invalidContent);
    }
    // Equal UTF8 lengths make this an independent digest check, not a length-only refusal.
    await expect(
      prepareControlKnowledgeHead({
        ...input,
        schemaText: schemaText.replace('précis', 'précix'),
      })
    ).rejects.toThrow();
    const foreign = openWorkspaceDb(f.db().dataRoot, allocateEntityId('ws'));
    try {
      applyScopedMigrations(foreign);
      await expect(prepareControlKnowledgeHead({ ...input, db: foreign })).rejects.toThrow();
    } finally {
      foreign.sqlite.close();
    }
    await expect(
      prepareControlKnowledgeHead({
        ...input,
        knowledgeBaseId: allocateEntityId('kb'),
      })
    ).rejects.toThrow();
    await expect(
      prepareControlKnowledgeHead({
        ...input,
        notebookCommit: 'f'.repeat(40),
      })
    ).rejects.toThrow();
    expect(readControlKnowledgeHead(f.db(), f.head.knowledgeBaseId)).toBeNull();
    expect(f.contentEntries()).toEqual(publishedEntries);
    expect(f.db().sqlite.serialize()).toEqual(before);
    expect(f.notebook.publishedRevision()).toBe(f.head.notebookCommit);
    await f.client.write('knowledge', controlKnowledgeHeadStatements(prepared, null));
    await f.reopen();
    expect(readControlKnowledgeHead(f.db(), f.head.knowledgeBaseId)).toEqual(prepared);
    expect(f.bytes(prepared)).toBe(schemaText);
  } finally {
    await f.discard(content);
  }
});

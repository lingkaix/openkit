// openkit-test-platform: posix
// Real Notebook publication and LocalStorage original delivery require local filesystem effects.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  allocateEntityId,
  ContentReferenceSchema,
  formatReferenceUri,
  type KnowledgeOwnerScope,
} from '@openkit/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import { isWorkspaceOperationAuthorized } from '../auth/operation-authorizer.js';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { FsStore } from '../lib/store.js';
import { type KnowledgeRetrievalAccess, threadReadable } from '../retrieval-knowledge-adapter.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { resolveKnowledgeMeaningReference } from './knowledge-meaning-reference.js';
import { KnowledgeNotebook } from './notebook.js';
import { parseOkfDocument, updateOkfFrontmatter } from './okf.js';
import {
  readServerKnowledgeSource,
  registerServerKnowledgeSource,
} from './server-knowledge-owner.js';
import { parseSourcePointer } from './source-pointers.js';
import { publishCapturedSource, type SourcePublication } from './source-publication.js';
import { readManagedSourceText } from './source-reading.js';

const content = 'Exact raw domain meaning.\r\nUnicode Ω 雪.\n';
const digest = `sha256:${createHash('sha256').update(Buffer.from(content)).digest('hex')}`;
const unavailable = (reference: string) => ({ status: 'unavailable', reference });

/** Actual Core, Workspace membership and scoped publication; no Storage or admission double. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'source-meaning-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Shared raw meaning');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  applyScopedMigrations(workspaceDb);
  const access: KnowledgeRetrievalAccess = {
    store,
    coreDb,
    actor: { kind: 'user', id: userId },
    requestActor: { kind: 'local', userId },
  };
  onTestFinished(() => {
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const read = (reference: string) =>
    resolveKnowledgeMeaningReference({ workspaceId: workspace.id, reference, access });
  return { dataRoot, coreDb, workspaceDb, userId, store, workspace, access, read };
}

/** Build the URI from the governed published pointer, never from an assumed raw filename. */
function retained(
  f: Awaited<ReturnType<typeof fixture>>,
  scope: Exclude<KnowledgeOwnerScope, { kind: 'user' }>,
  sourceId: string
) {
  const root =
    scope.kind === 'server'
      ? join(f.dataRoot, 'server', 'knowledge')
      : join(f.dataRoot, 'workspaces', scope.workspaceId, 'knowledge');
  const notebook = new KnowledgeNotebook({ repositoryPath: join(root, 'notebook.git') });
  const revision = notebook.publishedRevision();
  const pointer = notebook.readSourcePointers(revision)[sourceId]!;
  const parsed = parseOkfDocument({ path: `sources/${sourceId}.md`, content: pointer });
  if (!parsed.ok) throw new Error('Fixture requires a published canonical SourceSummary.');
  expect(parsed.document.frontmatter).toMatchObject({ type: 'SourceSummary', scope });
  const descriptor = ContentReferenceSchema.parse(parsed.document.frontmatter.contentRef);
  expect(descriptor.locator.ownerScope).toEqual(scope);
  expect(descriptor.knowledgeBaseId).toBe(
    readDefaultKnowledgeBaseId({ dataRoot: f.dataRoot, scope })
  );
  expect(descriptor.locator.mount).toBe('managed');
  expect(descriptor.contentDigest).toBe(digest);
  const rawRoot = resolve(root, 'raw');
  const rawPath = resolve(rawRoot, descriptor.locator.path);
  const confined = relative(rawRoot, rawPath);
  expect(isAbsolute(confined) || confined === '..' || confined.startsWith('../')).toBe(false);
  expect(readFileSync(rawPath)).toEqual(Buffer.from(content));
  const scopeId =
    scope.kind === 'server'
      ? `raw/server/${descriptor.knowledgeBaseId}`
      : `raw/workspace/${scope.workspaceId}/${descriptor.knowledgeBaseId}`;
  const object = { scopeId, objectId: descriptor.locator.path };
  const reference = formatReferenceUri(object, digest);
  return { root, notebook, revision, pointer, descriptor, rawPath, object, reference };
}

describe('pinned raw Source meaning receiver', () => {
  it('delivers admitted Server original UTF-8 and refuses wrong pins, KBs and changed bytes uniformly', async () => {
    const f = await fixture();
    const writer = {
      coreDb: f.coreDb,
      store: f.store,
      actor: { kind: 'local' as const, userId: f.userId },
      inflightCommands: new WeakMap(),
    };
    const source = await registerServerKnowledgeSource(writer, {
      requestId: randomUUID(),
      kind: 'document',
      title: 'Shared Server meaning',
      content,
    });
    expect(await readServerKnowledgeSource(writer, source.id)).toEqual({ source, content });
    const saved = retained(f, { kind: 'server' }, source.id);
    expect.soft(await f.read(saved.reference)).toEqual({
      status: 'available',
      reference: saved.reference,
      content,
      contentDigest: digest,
      notebookRevision: saved.revision,
    });
    for (const reference of [
      formatReferenceUri(saved.object, `sha256:${'0'.repeat(64)}`),
      formatReferenceUri(
        { ...saved.object, scopeId: `raw/server/${allocateEntityId('kb')}` },
        digest
      ),
      formatReferenceUri(saved.object),
    ]) {
      expect(await f.read(reference)).toEqual(unavailable(reference));
    }
    writeFileSync(saved.rawPath, 'Changed current original.');
    expect(await f.read(saved.reference)).toEqual(unavailable(saved.reference));
    expect(saved.notebook.readSourcePointers(saved.notebook.publishedRevision())[source.id]).toBe(
      saved.pointer
    );
    writeFileSync(saved.rawPath, content);
    expect.soft(await f.read(saved.reference)).toMatchObject({ status: 'available', content });
    // The same retained URI cannot keep Server authority after its current actor is disabled.
    f.coreDb.sqlite.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(f.userId);
    expect(await f.read(saved.reference)).toEqual(unavailable(saved.reference));
  });

  it('uses the path-governing Workspace Source and current audience and sensitivity before disclosure', async () => {
    const f = await fixture();
    f.access.requestActor = { kind: 'session', userId: f.userId };
    const scope = { kind: 'workspace' as const, workspaceId: f.workspace.id };
    const origin = await f.store.createThread(
      f.workspace.id,
      'Source origin',
      undefined,
      'conversation',
      {
        visibility: 'workspace',
      }
    );
    const destination = await f.store.createThread(
      f.workspace.id,
      'Shared meaning destination',
      undefined,
      'conversation',
      { visibility: 'workspace' }
    );
    f.access.outputThreadId = destination.id;
    const now = new Date().toISOString();
    const source = {
      id: allocateEntityId('ks'),
      kind: 'document' as const,
      title: 'Workspace domain meaning',
      uri: null,
      contentDigest: digest,
      originatingThreadId: origin.id,
      originatingTurnId: null,
      originatingFileId: null,
      capturedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const owner = { dataRoot: f.dataRoot, ownerScope: scope };
    const publication: SourcePublication = {
      owner,
      database: { kind: 'workspace', workspaceDb: f.workspaceDb },
      access: f.access,
      producer: { kind: 'user', id: f.userId },
      requestId: randomUUID(),
      commandInput: source,
      captureChannel: 'knowledge.source.register',
      revalidatePublication: () => {
        if (
          !isWorkspaceOperationAuthorized(f.coreDb, f.access.requestActor!, f.workspace.id, {
            mutating: true,
            policyOperation: 'knowledge.write',
          })
        )
          throw new Error('Fixture publication requires current Workspace Knowledge authority.');
      },
    };
    const captured = await publishCapturedSource(publication, source, Buffer.from(content));
    const otherSource = {
      ...source,
      id: allocateEntityId('ks'),
      title: 'Separate public Source with identical original bytes',
      originatingThreadId: null,
    };
    const other = await publishCapturedSource(
      { ...publication, requestId: randomUUID(), commandInput: otherSource },
      otherSource,
      Buffer.from(content)
    );
    const saved = retained(f, scope, source.id);
    expect(await readManagedSourceText({ owner, pointer: captured, access: f.access })).toEqual({
      status: 'ok',
      value: content,
    });
    expect(threadReadable({ workspaceId: f.workspace.id, access: f.access }, origin.id)).toBe(true);
    expect.soft(await f.read(saved.reference)).toEqual({
      status: 'available',
      reference: saved.reference,
      content,
      contentDigest: digest,
      notebookRevision: saved.revision,
    });
    Object.assign(origin, { visibility: 'private', privateOwnerUserId: allocateEntityId('usr') });
    expect(threadReadable({ workspaceId: f.workspace.id, access: f.access }, origin.id)).toBe(
      false
    );
    expect(await readManagedSourceText({ owner, pointer: other, access: f.access })).toEqual({
      status: 'ok',
      value: content,
    });
    const publicReference = retained(f, scope, otherSource.id).reference;
    expect.soft(await f.read(publicReference)).toMatchObject({ status: 'available', content });
    expect(await f.read(saved.reference)).toEqual(unavailable(saved.reference));
    Object.assign(origin, { visibility: 'workspace', privateOwnerUserId: undefined });
    // A descriptive pointer edit cannot turn a shared meaning read into confidential inspection.
    const confidential = updateOkfFrontmatter({
      path: `sources/${source.id}.md`,
      content: saved.pointer,
      updates: { sensitivity: 'confidential' },
    });
    const baseRevision = saved.notebook.publishedRevision();
    const candidateRevision = saved.notebook.prepareSourcePointers({
      baseRevision,
      changes: { [source.id]: confidential },
      metadata: saved.notebook.readRevision(baseRevision).metadata,
    });
    saved.notebook.publish({ baseRevision, candidateRevision });
    expect(parseSourcePointer(owner, source.id, confidential).source.contentDigest).toBe(digest);
    expect(await f.read(saved.reference)).toEqual(unavailable(saved.reference));
  });
});

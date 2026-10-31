// openkit-test-platform: posix
// Workspace transfer consumes actual canonical Sources, Git and managed Storage originals.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { allocateEntityId, ContentReferenceSchema } from '@openkit/protocol';
import { LocalStorage } from '@openkit/storage';
import { describe, expect, it, onTestFinished } from 'vitest';
import { readDefaultKnowledgeBaseId, readKnowledgeMounts } from '../config/knowledge-base.js';
import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import { deriveManagedSourceAccess } from '../knowledge/managed-source-access.js';
import type { NotebookUpdate } from '../knowledge/notebook-publication.js';
import { readWorkspaceNotebookAdmission } from '../knowledge/notebook-workspace-admission.js';
import { parseOkfDocument } from '../knowledge/okf.js';
import { readSourceByteRange } from '../knowledge/source-bytes.js';
import { parseSourcePointer } from '../knowledge/source-pointers.js';
import { publishCapturedSource } from '../knowledge/source-publication.js';
import { FsStore } from '../lib/store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { readTestWorkspaceNotebookSelection } from '../test-support/workspace-notebook.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';
import {
  createVerifiedWorkspaceExport,
  existingWorkspaceExportRoot,
  importVerifiedWorkspace,
} from './workspace-transfer-routes.js';

const original = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9l8AAAAASUVORK5CYII=',
    'base64'
  )
);
const digest = `sha256:${createHash('sha256').update(original).digest('hex')}`;

/** Real deployment owners establish both export admission and current imported membership. */
function deployment() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'workspace-source-raw-portability-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  onTestFinished(async () => {
    coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  return { dataRoot, coreDb, userId, store };
}

/** The common native publisher supplies a governed binary Source with actual portable lineage. */
async function capturedSource() {
  const f = deployment();
  const workspace = await f.store.createWorkspace('Portable binary Source');
  recordWorkspaceOwnerMembership({
    coreDb: f.coreDb,
    workspaceId: workspace.id,
    ownerUserId: f.userId,
  });
  const workspaceDb = openWorkspaceDb(f.dataRoot, workspace.id);
  applyScopedMigrations(workspaceDb);
  onTestFinished(() => workspaceDb.sqlite.close());
  const actor = { kind: 'user' as const, id: f.userId };
  const requestActor = { kind: 'local' as const, userId: f.userId };
  const thread = await f.store.createThread(workspace.id, 'Original binary evidence');
  const turn = await f.store.createTurn(
    workspace.id,
    thread.id,
    'Capture the exact original.',
    actor,
    null
  );
  await f.store.updateTurn(turn.id, { status: 'completed', completedAt: new Date().toISOString() });
  const scope = { kind: 'workspace' as const, workspaceId: workspace.id };
  const owner = { dataRoot: f.dataRoot, ownerScope: scope };
  const selection = () => readTestWorkspaceNotebookSelection(f.dataRoot, workspace.id);
  const snapshot = createInMemoryRuntimeConfigSnapshot({ dataRoot: f.dataRoot });
  const workspaceMutationAdmission = new WorkspaceMutationAdmission();
  const requestId = randomUUID();
  const now = new Date().toISOString();
  const source = {
    id: allocateEntityId('ks'),
    kind: 'document' as const,
    title: 'Exact binary original',
    contentDigest: digest,
    uri: null,
    originatingThreadId: thread.id,
    originatingTurnId: turn.id,
    originatingFileId: null,
    capturedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const admission = (request: NotebookUpdate) =>
    readWorkspaceNotebookAdmission({
      ...f,
      workspaceDb,
      notebook: selection().notebook,
      actor,
      requestActor,
      request,
      runtimeConfigManager: { current: () => snapshot },
      workspaceMutationAdmission,
    });
  await publishCapturedSource(
    {
      owner,
      database: { kind: 'workspace', workspaceDb },
      access: { store: f.store, coreDb: f.coreDb, actor, requestActor },
      producer: actor,
      requestId,
      commandInput: source,
      captureChannel: 'knowledge.source.register',
      revalidatePublication: () => {
        admission({
          workspaceId: workspace.id,
          requestId,
          baseRevision: selection().head.notebookCommit,
          changes: [],
          summary: 'Capture the binary original.',
        });
      },
    },
    source,
    original
  );
  const revision = selection().head.notebookCommit;
  const pointer = selection().notebook.readSourcePointers(revision)[source.id]!;
  const selected = parseSourcePointer(owner, source.id, pointer, selection());
  expect(selected.fields).toMatchObject({
    byteLength: original.byteLength,
    mediaType: 'image/png',
    contentRef: { availability: 'available', contentDigest: digest },
  });
  const rawRoot = resolve(f.dataRoot, 'workspaces', workspace.id, 'knowledge', 'raw');
  const rawPath = resolve(rawRoot, selected.fields.contentRef.locator.path);
  const confined = relative(rawRoot, rawPath);
  expect(isAbsolute(confined) || confined === '..' || confined.startsWith('../')).toBe(false);
  expect(readFileSync(rawPath)).toEqual(Buffer.from(original));
  const exportWorkspace = () =>
    createVerifiedWorkspaceExport({
      authorityUserId: f.userId,
      authorityActor: actor,
      requestActor,
      coreDb: f.coreDb,
      dataRoot: f.dataRoot,
      store: f.store,
      workspaceId: workspace.id,
      repositoryWorkspaceDb: (workspaceId) => openWorkspaceDb(f.dataRoot, workspaceId),
    });
  return {
    ...f,
    workspace,
    thread,
    turn,
    source,
    scope,
    get notebook() {
      return selection().notebook;
    },
    revision,
    pointer,
    reference: selected.fields.contentRef,
    rawPath,
    exportWorkspace,
  };
}

describe('canonical Source originals in Workspace transfer', () => {
  it('exports and remints a binary Source into a new current Workspace KB that reopens and reads through Storage', async () => {
    const f = await capturedSource();
    const exported = await f.exportWorkspace();
    const inventory = exported.verified.manifest.contentInventory;
    const paths = inventory.map(({ path }) => path);
    expect(paths).not.toContain('records/knowledge-sources.jsonl');
    expect(paths.some((path) => /(^|\/)sources\/(registry|materials)(\/|$)/.test(path))).toBe(
      false
    );
    const pointers = paths.filter(
      (path) => path === `sources/${f.source.id}.md` || path.endsWith(`/sources/${f.source.id}.md`)
    );
    expect(pointers).toHaveLength(1);
    const exportRoot = existingWorkspaceExportRoot(
      f.dataRoot,
      f.workspace.id,
      exported.verified.manifest.id
    );
    expect(readFileSync(join(exportRoot, pointers[0]!), 'utf8')).toBe(f.pointer);
    const originals = inventory.filter(
      (entry) => entry.digest === digest && entry.bytes === original.byteLength
    );
    expect(originals).toHaveLength(1);
    expect(readFileSync(join(exportRoot, originals[0]!.path))).toEqual(Buffer.from(original));
    const imported = await importVerifiedWorkspace({
      authorityUserId: f.userId,
      coreDb: f.coreDb,
      dataRoot: f.dataRoot,
      requestId: randomUUID(),
      store: f.store,
      verified: exported.verified,
    });
    expect(imported.workspace.id).not.toBe(f.workspace.id);
    const scope = { kind: 'workspace' as const, workspaceId: imported.workspace.id };
    const owner = { dataRoot: f.dataRoot, ownerScope: scope };
    const knowledgeBaseId = readDefaultKnowledgeBaseId({ dataRoot: f.dataRoot, scope });
    expect(knowledgeBaseId).not.toBe(f.reference.knowledgeBaseId);
    const reopened = new FsStore({ dataRoot: f.dataRoot });
    const targetRoot = join(f.dataRoot, 'workspaces', imported.workspace.id, 'knowledge');
    const importedSelection = readTestWorkspaceNotebookSelection(f.dataRoot, imported.workspace.id);
    const sources = reopened.listKnowledgeSources(imported.workspace.id);
    expect(sources).toHaveLength(1);
    const source = sources[0]!;
    expect(source.id).not.toBe(f.source.id);
    const thread = reopened
      .listThreads(imported.workspace.id)
      .find((entry) => entry.title === f.thread.title)!;
    const turns = reopened.listThreadTurns(imported.workspace.id, thread.id);
    expect(turns).toHaveLength(1);
    expect(thread.id).not.toBe(f.thread.id);
    expect(turns[0]!.id).not.toBe(f.turn.id);
    expect(source).toMatchObject({
      contentDigest: digest,
      originatingThreadId: thread.id,
      originatingTurnId: turns[0]!.id,
      originatingFileId: null,
    });
    const revision = importedSelection.head.notebookCommit;
    const pointerBytes = importedSelection.notebook.readSourcePointers(revision)[source.id]!;
    const pointer = parseSourcePointer(owner, source.id, pointerBytes, importedSelection);
    expect(pointer.fields).toMatchObject({
      byteLength: original.byteLength,
      mediaType: 'image/png',
      contentRef: {
        knowledgeBaseId,
        contentDigest: digest,
        availability: 'available',
        locator: { ownerScope: scope, mount: 'managed' },
      },
    });
    expect(pointer.fields.contentRef.locator.path).toBe(
      f.reference.locator.path
        .split('/')
        .map((segment) => (segment === f.source.id ? source.id : segment))
        .join('/')
    );
    const parsed = parseOkfDocument({ path: `sources/${source.id}.md`, content: pointerBytes });
    expect(parsed.document?.frontmatter).toMatchObject({
      type: 'SourceSummary',
      scope,
      originatingThreadId: thread.id,
      originatingTurnId: turns[0]!.id,
    });
    const rawRoot = resolve(targetRoot, 'raw');
    const rawPath = resolve(rawRoot, pointer.fields.contentRef.locator.path);
    const confined = relative(rawRoot, rawPath);
    expect(isAbsolute(confined) || confined === '..' || confined.startsWith('../')).toBe(false);
    expect(readFileSync(rawPath)).toEqual(Buffer.from(original));
    const mount = readKnowledgeMounts({ dataRoot: f.dataRoot, scope }).find(
      (entry) => entry.default
    )!;
    const access = {
      store: reopened,
      coreDb: f.coreDb,
      actor: { kind: 'user' as const, id: f.userId },
      requestActor: { kind: 'local' as const, userId: f.userId },
    };
    const admission = {
      owner,
      knowledgeBaseId,
      mount,
      access,
      consumer: 'native' as const,
      mode: 'read-only' as const,
    };
    expect(
      deriveManagedSourceAccess({ ...admission, knowledgeBaseId: f.reference.knowledgeBaseId })
    ).toBeNull();
    const storage = new LocalStorage({
      mounts: [
        { name: mount.name, ownerScope: scope, knowledgeBaseId, root: rawRoot, managed: true },
      ],
      stagingRoot: join(targetRoot, '.source-staging'),
    });
    try {
      const result = await readSourceByteRange({
        pointer,
        storage,
        admit: () => deriveManagedSourceAccess(admission),
        offset: 8,
        length: 13,
      });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok')
        throw new Error('Imported current original must remain available.');
      expect(Array.from(result.value)).toEqual(Array.from(original.subarray(8, 21)));
    } finally {
      await storage.close();
    }
    expect(importedSelection.notebook.readSourcePointers(revision)[source.id]).toBe(pointerBytes);
    expect(f.notebook.readSourcePointers(f.revision)[f.source.id]).toBe(f.pointer);
    expect(readFileSync(f.rawPath)).toEqual(Buffer.from(original));
  });

  it('refuses a changed supposedly-available original before any import destination effects', async () => {
    const f = await capturedSource();
    const target = deployment();
    const targetWorkspaces = join(target.dataRoot, 'workspaces');
    const before = existsSync(targetWorkspaces) ? readdirSync(targetWorkspaces) : null;
    const changed = Uint8Array.from(original);
    changed[10] = changed[10]! ^ 0xff;
    writeFileSync(f.rawPath, changed);
    let destinationStarted = false;
    await expect(async () => {
      const exported = await f.exportWorkspace();
      destinationStarted = true;
      await importVerifiedWorkspace({
        authorityUserId: target.userId,
        coreDb: target.coreDb,
        dataRoot: target.dataRoot,
        requestId: randomUUID(),
        store: target.store,
        verified: exported.verified,
      });
    }).rejects.toThrow();
    expect.soft(destinationStarted).toBe(false);
    expect(target.store.listWorkspaces()).toEqual([]);
    expect(existsSync(targetWorkspaces) ? readdirSync(targetWorkspaces) : null).toEqual(before);
    expect(f.notebook.publishedRevision()).toBe(f.revision);
    expect(f.notebook.readSourcePointers(f.revision)[f.source.id]).toBe(f.pointer);
    expect(
      ContentReferenceSchema.parse(
        parseOkfDocument({ path: `sources/${f.source.id}.md`, content: f.pointer }).document!
          .frontmatter.contentRef
      ).availability
    ).toBe('available');
    expect(readFileSync(f.rawPath)).toEqual(Buffer.from(changed));
  });
});

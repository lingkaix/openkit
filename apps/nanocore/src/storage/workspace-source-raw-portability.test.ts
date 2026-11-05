// openkit-test-platform: posix
// Workspace transfer consumes actual canonical Sources, Git and managed Storage originals.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { allocateEntityId, ContentReferenceSchema } from '@openkit/protocol';
import { LocalStorage } from '@openkit/storage';
import { describe, expect, it, onTestFinished } from 'vitest';
import { readKnowledgeMounts } from '../config/knowledge-base.js';
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
import { disposeTestStore } from '../test-support/store.js';
import { readTestWorkspaceNotebookSelection } from '../test-support/workspace-notebook.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';
import { createVerifiedWorkspaceExport } from './workspace-transfer-routes.js';

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
    await disposeTestStore(dataRoot);
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
  it('exports a binary Source and still reads it from the source Workspace', async () => {
    const f = await capturedSource();
    const exported = await f.exportWorkspace();
    const verified = exported.verified;
    const inventory = verified.manifest.contentInventory;
    const paths = inventory.map(({ path }) => path);
    expect(paths).not.toContain('records/knowledge-sources.jsonl');
    expect(paths.some((path) => /(^|\/)sources\/(registry|materials)(\/|$)/.test(path))).toBe(
      false
    );
    const pointers = paths.filter(
      (path) => path === `sources/${f.source.id}.md` || path.endsWith(`/sources/${f.source.id}.md`)
    );
    expect(pointers).toHaveLength(1);
    expect(verified.fileContents.get(pointers[0]!)).toBe(f.pointer);
    const originals = inventory.filter(
      (entry) => entry.digest === digest && entry.bytes === original.byteLength
    );
    expect(originals).toHaveLength(1);
    expect(readFileSync(verified.artifactPayloadFiles.get(originals[0]!.path)!)).toEqual(
      Buffer.from(original)
    );
    const scope = f.scope;
    const owner = { dataRoot: f.dataRoot, ownerScope: scope };
    const knowledgeBaseId = f.reference.knowledgeBaseId;
    const selection = readTestWorkspaceNotebookSelection(f.dataRoot, f.workspace.id);
    const pointer = parseSourcePointer(owner, f.source.id, f.pointer, selection);
    const rawRoot = resolve(f.dataRoot, 'workspaces', f.workspace.id, 'knowledge', 'raw');
    const mount = readKnowledgeMounts({ dataRoot: f.dataRoot, scope }).find(
      (entry) => entry.default
    )!;
    const access = {
      store: f.store,
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
      deriveManagedSourceAccess({ ...admission, knowledgeBaseId: allocateEntityId('kb') })
    ).toBeNull();
    const storage = new LocalStorage({
      mounts: [
        { name: mount.name, ownerScope: scope, knowledgeBaseId, root: rawRoot, managed: true },
      ],
      stagingRoot: join(f.dataRoot, 'workspaces', f.workspace.id, 'knowledge', '.source-staging'),
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
      if (result.status !== 'ok') throw new Error('The current original must remain available.');
      expect(Array.from(result.value)).toEqual(Array.from(original.subarray(8, 21)));
    } finally {
      await storage.close();
    }
    expect(f.notebook.readSourcePointers(f.revision)[f.source.id]).toBe(f.pointer);
    expect(readFileSync(f.rawPath)).toEqual(Buffer.from(original));
  });

  it('refuses a changed supposedly-available original during export and leaves the source unchanged', async () => {
    const f = await capturedSource();
    const changed = Uint8Array.from(original);
    changed[10] = changed[10]! ^ 0xff;
    writeFileSync(f.rawPath, changed);
    await expect(f.exportWorkspace()).rejects.toThrow();
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

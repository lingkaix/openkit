// openkit-test-platform: posix
// Workspace transfer consumes actual canonical Sources, Git and managed Storage originals.
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { WorkspaceConfigSchema } from '@openkit/config-schema';
import { allocateEntityId, ContentReferenceSchema } from '@openkit/protocol';
import { LocalStorage } from '@openkit/storage';
import { applyEdits, modify } from 'jsonc-parser';
import { describe, expect, it, onTestFinished } from 'vitest';
import { parseJsoncObject } from '../config/jsonc.js';
import { readKnowledgeMounts } from '../config/knowledge-base.js';
import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import { deriveManagedSourceAccess } from '../knowledge/managed-source-access.js';
import type { NotebookUpdate } from '../knowledge/notebook-publication.js';
import { readWorkspaceNotebookAdmission } from '../knowledge/notebook-workspace-admission.js';
import { readWorkspaceNotebookSelection } from '../knowledge/notebook-workspace-selection.js';
import { parseOkfDocument } from '../knowledge/okf.js';
import { readSourceByteRange } from '../knowledge/source-bytes.js';
import { parseSourcePointer } from '../knowledge/source-pointers.js';
import { publishCapturedSource } from '../knowledge/source-publication.js';
import { FsStore } from '../lib/store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { disposeTestStore } from '../test-support/store.js';
import { readTestWorkspaceNotebookSelection } from '../test-support/workspace-notebook.js';
import { captureWorkspaceSourceFixture } from '../test-support/workspace-source.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { openCoreDb, openWorkspaceDb, openWorkspaceDbAtRoot } from './db.js';
import { readDataRootLayoutMarker } from './fs-layout.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';
import {
  type VerifiedWorkspaceExportTree,
  type WriteWorkspaceExportTreeInput,
  writeWorkspaceExportTree,
} from './workspace-export.js';
import { readWorkspacePortableFileState } from './workspace-portable-file-state.js';
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
  onTestFinished(() => {
    workspaceDb.sqlite.close();
  });
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

describe('Source export explicit workspace root', () => {
  const original = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9l8AAAAASUVORK5CYII=',
    'base64'
  );
  const originalDigest = `sha256:${createHash('sha256').update(original).digest('hex')}`;

  /** Captures actual binary evidence with native publication, lineage and retained configuration. */
  async function sourceSnapshot() {
    const root = mkdtempSync(join(tmpdir(), 'source-export-root-boundary-'));
    const dataRoot = join(root, 'deployment');
    const coreDb = openCoreDb(dataRoot);
    onTestFinished(async () => {
      coreDb.sqlite.close();
      await disposeTestStore(root);
    });
    applyMigrations(coreDb);
    const userId = ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = await store.createWorkspace('Source snapshot root');
    recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
    const actor = { kind: 'user' as const, id: userId };
    const thread = await store.createThread(workspace.id, 'Original evidence');
    const turn = await store.createTurn(workspace.id, thread.id, 'Capture the PNG.', actor, null);
    await store.updateTurn(turn.id, { status: 'completed', completedAt: new Date().toISOString() });
    const now = new Date().toISOString();
    const source = await captureWorkspaceSourceFixture({
      dataRoot,
      store,
      coreDb,
      userId,
      source: {
        id: allocateEntityId('ks'),
        workspaceId: workspace.id,
        kind: 'document',
        title: 'Exact PNG original',
        contentDigest: originalDigest,
        uri: null,
        originatingThreadId: thread.id,
        originatingTurnId: turn.id,
        originatingFileId: null,
        capturedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      content: original,
    });
    const workspaceRoot = join(dataRoot, 'workspaces', workspace.id);
    const selection = readTestWorkspaceNotebookSelection(dataRoot, workspace.id);
    const notebook = selection.notebook;
    const revision = notebook.publishedRevision();
    const pointer = notebook.readSourcePointers(revision)[source.id]!;
    const selected = parseSourcePointer(
      { dataRoot, ownerScope: { kind: 'workspace', workspaceId: workspace.id } },
      source.id,
      pointer,
      selection
    );
    expect(selected.fields).toMatchObject({
      byteLength: original.byteLength,
      mediaType: 'image/png',
      contentRef: { availability: 'available', contentDigest: originalDigest },
    });
    const originalPath = `knowledge/raw/${selected.fields.contentRef.locator.path}`;
    expect(readFileSync(join(workspaceRoot, originalPath))).toEqual(original);
    const portableFileState = readWorkspacePortableFileState(workspaceRoot, {
      workspaceId: workspace.id,
      threads: [{ threadId: thread.id }],
      turns: [{ threadId: thread.id, turnId: turn.id }],
    });
    expect(portableFileState.notebookRevision).toBe(revision);
    expect(portableFileState.workspaceConfig).not.toBeNull();
    expect(portableFileState.workspaceSchema).not.toBeNull();
    const captured: Omit<
      WriteWorkspaceExportTreeInput,
      'sourceWorkspaceRoot' | 'exportRoot' | 'exportId'
    > = {
      sourceNotebookSelection: selection,
      sourceDeploymentId: readDataRootLayoutMarker(dataRoot).deploymentId,
      createdAt: now,
      workspace: store.getWorkspace(workspace.id),
      threads: store.listThreads(workspace.id),
      turns: store.listThreadTurns(workspace.id, thread.id),
      knowledge: store.listKnowledge(workspace.id),
      knowledgeSources: store.listKnowledgeSources(workspace.id),
      itemRevisions: [],
      artifacts: [],
      artifactReviews: [],
      threadMaterialBindings: [],
      workspaceMaterialRevisions: [],
      workspaceMaterials: [],
      agentSessions: [],
      turnEvents: [[turn.id, []]],
      portableFileState,
    };
    return {
      root,
      dataRoot,
      workspaceRoot,
      get notebook() {
        return readTestWorkspaceNotebookSelection(dataRoot, workspace.id).notebook;
      },
      source,
      pointer,
      revision,
      originalPath,
      captured,
    };
  }

  /** Checks exact canonical pointer text and digest-verified file-backed originals. */
  function assertSourceExport(
    verified: VerifiedWorkspaceExportTree,
    exportRoot: string,
    snapshot: Awaited<ReturnType<typeof sourceSnapshot>>
  ): void {
    const pointerPath = `workspace-files/knowledge/sources/${snapshot.source.id}.md`;
    const rawPath = `workspace-files/${snapshot.originalPath}`;
    expect(verified.manifest.knowledgeNotebookRevision).toBe(snapshot.revision);
    expect(verified.fileContents.get(pointerPath)).toBe(snapshot.pointer);
    expect(readFileSync(join(exportRoot, pointerPath), 'utf8')).toBe(snapshot.pointer);
    expect(
      verified.manifest.contentInventory.filter((entry) => entry.digest === originalDigest)
    ).toEqual([{ path: rawPath, bytes: original.byteLength, digest: originalDigest }]);
    expect(verified.checkedFiles).toContain(rawPath);
    expect(verified.artifactPayloadFiles.get(rawPath)).toBe(join(exportRoot, rawPath));
    expect(readFileSync(verified.artifactPayloadFiles.get(rawPath)!)).toEqual(original);
  }

  it('refuses an unpublished Source-only candidate with valid captured fields', async () => {
    const snapshot = await sourceSnapshot();
    const exportRoot = join(snapshot.root, 'published-control-export');
    assertSourceExport(
      writeWorkspaceExportTree({
        ...snapshot.captured,
        sourceWorkspaceRoot: snapshot.workspaceRoot,
        exportRoot,
        exportId: allocateEntityId('wsexp'),
      }),
      exportRoot,
      snapshot
    );
    const candidatePointer = `${snapshot.pointer}\nUnpublished Source summary.\n`;
    const { workspaceId, ...sourceMetadata } = snapshot.source;
    expect(
      parseSourcePointer(
        { dataRoot: snapshot.dataRoot, ownerScope: { kind: 'workspace', workspaceId } },
        snapshot.source.id,
        candidatePointer,
        snapshot.captured.sourceNotebookSelection
      ).source
    ).toEqual(sourceMetadata);
    const candidateRevision = snapshot.notebook.prepareSourcePointers({
      baseRevision: snapshot.revision,
      changes: { [snapshot.source.id]: candidatePointer },
      metadata: snapshot.notebook.readRevision(snapshot.revision).metadata,
    });
    expect(candidateRevision).not.toBe(snapshot.revision);
    expect(snapshot.notebook.readSourcePointers(candidateRevision)[snapshot.source.id]).toBe(
      candidatePointer
    );
    // A caller's wrong physical root or Workspace remains an internal invariant failure,
    // even when the requested revision is also an unpublished candidate.
    const selection = snapshot.captured.sourceNotebookSelection;
    for (const sourceNotebookSelection of [
      { ...selection, workspaceRoot: join(snapshot.root, 'wrong-workspace') },
      { ...selection, head: { ...selection.head, workspaceId: allocateEntityId('ws') } },
    ]) {
      let refusal: unknown;
      try {
        writeWorkspaceExportTree({
          ...snapshot.captured,
          sourceNotebookSelection,
          sourceWorkspaceRoot: snapshot.workspaceRoot,
          exportRoot: join(snapshot.root, 'mismatched-selection-export'),
          exportId: allocateEntityId('wsexp'),
          portableFileState: {
            ...snapshot.captured.portableFileState!,
            notebookRevision: candidateRevision,
          },
        });
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(Error);
      expect(refusal).toHaveProperty(
        'message',
        'Source export selection does not match the pinned Workspace.'
      );
      expect(refusal).not.toHaveProperty('code');
    }
    expect(snapshot.notebook.publishedRevision()).toBe(snapshot.revision);
    expect(() => snapshot.notebook.history({ revision: candidateRevision, limit: 1 })).toThrowError(
      expect.objectContaining({ code: 'invalid_request' })
    );
    expect(() =>
      writeWorkspaceExportTree({
        ...snapshot.captured,
        sourceWorkspaceRoot: snapshot.workspaceRoot,
        exportRoot: join(snapshot.root, 'unpublished-export'),
        exportId: allocateEntityId('wsexp'),
        portableFileState: {
          ...snapshot.captured.portableFileState!,
          notebookRevision: candidateRevision,
        },
      })
    ).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
    expect(snapshot.notebook.publishedRevision()).toBe(snapshot.revision);
  });

  it('refuses captured mount declarations that shadow the managed Source namespace', async () => {
    const snapshot = await sourceSnapshot();
    const exportRoot = join(snapshot.root, 'unshadowed-control-export');
    assertSourceExport(
      writeWorkspaceExportTree({
        ...snapshot.captured,
        sourceWorkspaceRoot: snapshot.workspaceRoot,
        exportRoot,
        exportId: allocateEntityId('wsexp'),
      }),
      exportRoot,
      snapshot
    );
    const state = snapshot.captured.portableFileState!;
    const configuration = state.workspaceConfig!;
    const workspace = WorkspaceConfigSchema.parse(parseJsoncObject(configuration)).workspace;
    const mounts = workspace.knowledgeMounts!;
    const shadow = {
      knowledgeBaseId: workspace.defaultKnowledgeBaseId!,
      name: 'sources',
      backend: 'local',
      root: 'raw/sources',
      default: false,
    };
    const shadowedConfiguration = applyEdits(
      configuration,
      modify(configuration, ['workspace', 'knowledgeMounts', mounts.length], shadow, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      })
    );
    expect(
      WorkspaceConfigSchema.parse(parseJsoncObject(shadowedConfiguration)).workspace.knowledgeMounts
    ).toEqual([...mounts, shadow]);
    expect(snapshot.originalPath).toBe(`knowledge/raw/sources/${snapshot.source.id}/original`);
    expect(readFileSync(join(snapshot.workspaceRoot, snapshot.originalPath))).toEqual(original);
    expect(snapshot.notebook.readSourcePointers(snapshot.revision)[snapshot.source.id]).toBe(
      snapshot.pointer
    );
    expect(() =>
      writeWorkspaceExportTree({
        ...snapshot.captured,
        sourceWorkspaceRoot: snapshot.workspaceRoot,
        exportRoot: join(snapshot.root, 'shadowed-export'),
        exportId: allocateEntityId('wsexp'),
        portableFileState: { ...state, workspaceConfig: shadowedConfiguration },
      })
    ).toThrow();
  });

  it('exports the pinned PNG Source from a detached snapshot and refuses a changed snapshot original', async () => {
    const snapshot = await sourceSnapshot();
    const canonicalExportRoot = join(snapshot.root, 'canonical-export');
    const canonical = writeWorkspaceExportTree({
      ...snapshot.captured,
      sourceWorkspaceRoot: snapshot.workspaceRoot,
      exportRoot: canonicalExportRoot,
      exportId: allocateEntityId('wsexp'),
    });
    assertSourceExport(canonical, canonicalExportRoot, snapshot);

    // A trusted snapshot has no DATA_ROOT/workspaces/<id> ancestry requirement.
    const detachedRoot = join(snapshot.root, 'snapshots', 'selected-workspace');
    cpSync(snapshot.workspaceRoot, detachedRoot, { recursive: true });
    const detachedDb = openWorkspaceDbAtRoot({
      dataRoot: snapshot.dataRoot,
      workspaceId: snapshot.captured.workspace.id,
      workspaceRoot: detachedRoot,
    });
    const detachedSelection = (() => {
      try {
        return readWorkspaceNotebookSelection({
          workspaceDb: detachedDb,
          workspaceRoot: detachedRoot,
          knowledgeBaseId: snapshot.captured.sourceNotebookSelection!.head.knowledgeBaseId,
        });
      } finally {
        detachedDb.sqlite.close();
      }
    })();
    const detachedNotebook = detachedSelection.notebook;
    expect(detachedNotebook.publishedRevision()).toBe(snapshot.revision);
    expect(detachedNotebook.readSourcePointers(snapshot.revision)[snapshot.source.id]).toBe(
      snapshot.pointer
    );
    expect(readFileSync(join(detachedRoot, snapshot.originalPath))).toEqual(original);
    const detachedExportRoot = join(snapshot.root, 'detached-export');
    const detached = writeWorkspaceExportTree({
      ...snapshot.captured,
      sourceWorkspaceRoot: detachedRoot,
      sourceNotebookSelection: detachedSelection,
      exportRoot: detachedExportRoot,
      exportId: allocateEntityId('wsexp'),
    });
    assertSourceExport(detached, detachedExportRoot, snapshot);

    const changed = Buffer.from(original);
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    writeFileSync(join(detachedRoot, snapshot.originalPath), changed);
    expect(() =>
      writeWorkspaceExportTree({
        ...snapshot.captured,
        sourceWorkspaceRoot: detachedRoot,
        sourceNotebookSelection: detachedSelection,
        exportRoot: join(snapshot.root, 'changed-original-export'),
        exportId: allocateEntityId('wsexp'),
      })
    ).toThrow('Source original integrity is inconsistent.');
  });
});

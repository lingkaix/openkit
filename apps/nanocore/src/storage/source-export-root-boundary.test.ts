// openkit-test-platform: posix
// Compose the native Source publisher and export writer across an explicit snapshot root.
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceConfigSchema } from '@openkit/config-schema';
import { allocateEntityId } from '@openkit/protocol';
import { applyEdits, modify } from 'jsonc-parser';
import { describe, expect, it, onTestFinished } from 'vitest';
import { parseJsoncObject } from '../config/jsonc.js';
import { readWorkspaceNotebookSelection } from '../knowledge/notebook-workspace-selection.js';
import { parseSourcePointer } from '../knowledge/source-pointers.js';
import { FsStore } from '../lib/store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { readTestWorkspaceNotebookSelection } from '../test-support/workspace-notebook.js';
import { captureWorkspaceSourceFixture } from '../test-support/workspace-source.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDbAtRoot } from './db.js';
import { readDataRootLayoutMarker } from './fs-layout.js';
import { applyMigrations } from './migrate.js';
import {
  type VerifiedWorkspaceExportTree,
  type WriteWorkspaceExportTreeInput,
  writeWorkspaceExportTree,
} from './workspace-export.js';
import { readWorkspacePortableFileState } from './workspace-portable-file-state.js';

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
    await shutdownControlStoreWorkerClient();
    rmSync(root, { recursive: true, force: true });
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

describe('Source export explicit workspace root', () => {
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

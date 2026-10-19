import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeBaseIdSchema } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  seedDemoWorkspaceAuthority,
  seedDemoWorkspaceDataRoot,
} from '../../../../tests/support/demo-data.mjs';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { readWorkspaceNotebookIndexSource } from '../knowledge/notebook-index-source.js';
import { FsStore } from '../lib/store.js';
import { readWorkspaceKnowledgeDerivedIndexes } from '../storage/index-rebuild.js';
import { DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from './demo-store.js';

const workspaceIds = [DEMO_WORKSPACE_ID, 'ws_7d54f339-a119-5221-bbbf-bfbf3e8a3f28'];
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Creates only a disposable root; the shared black-box producer owns all fixture records. */
function dataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openkit-demo-contract-'));
  roots.push(root);
  return root;
}

describe('shared black-box demo fixture contract', () => {
  it('loads both current Workspace records and the starter Thread through the native store', async () => {
    const root = dataRoot();
    seedDemoWorkspaceDataRoot(root);
    await seedDemoWorkspaceAuthority(root);

    const store = new FsStore({ dataRoot: root });
    expect(
      store
        .listWorkspaces()
        .map((workspace) => workspace.id)
        .sort()
    ).toEqual([...workspaceIds].sort());
    expect(store.getWorkspace(DEMO_WORKSPACE_ID)).toMatchObject({
      kind: 'code',
      name: 'Demo Workspace',
      status: 'active',
    });
    expect(store.getWorkspace(workspaceIds[1]!)).toMatchObject({
      kind: 'personal',
      name: 'Personal',
      status: 'active',
    });
    expect(store.getThread(DEMO_WORKSPACE_ID, DEMO_THREAD_ID)).toMatchObject({
      entryPath: 'conversation',
      visibility: 'workspace',
      name: 'Protocol design review',
    });
  });

  it('rebuilds canonical Git pages and preserves each scope default across seed retry and reopen', async () => {
    const root = dataRoot();
    seedDemoWorkspaceDataRoot(root);
    await seedDemoWorkspaceAuthority(root);

    const bindings = new Map<string, string>();
    const publications = new Map<string, ReturnType<typeof readWorkspaceNotebookIndexSource>>();
    for (const workspaceId of workspaceIds) {
      const indexes = readWorkspaceKnowledgeDerivedIndexes({ dataRoot: root, workspaceId });
      const binding = readDefaultKnowledgeBaseId({
        dataRoot: root,
        scope: { kind: 'workspace', workspaceId },
      });
      expect(KnowledgeBaseIdSchema.safeParse(binding).success).toBe(true);
      bindings.set(workspaceId, binding);
      const source = readWorkspaceNotebookIndexSource(join(root, 'workspaces', workspaceId));
      publications.set(workspaceId, source);
      expect(indexes.validation.notebookRevision).toBe(source.notebookRevision);
      expect(indexes.validation.records.map((record) => record.conceptId)).toEqual(
        workspaceId === DEMO_WORKSPACE_ID ? ['mem_project'] : []
      );
      expect(indexes.validation.records.every((record) => record.errors.length === 0)).toBe(true);
    }
    expect(new Set(bindings.values()).size).toBe(workspaceIds.length);
    expect(publications.get(DEMO_WORKSPACE_ID)!.pages.get('mem_project')).toContain(
      'Drive the workspace protocol through a real Codex-backed local agent adapter.'
    );

    seedDemoWorkspaceDataRoot(root);
    await seedDemoWorkspaceAuthority(root);
    const reopened = new FsStore({ dataRoot: root });
    expect(reopened.listKnowledge(DEMO_WORKSPACE_ID)).toMatchObject([
      { id: 'mem_project', title: 'Product focus' },
    ]);
    for (const workspaceId of workspaceIds) {
      expect(
        readDefaultKnowledgeBaseId({
          dataRoot: root,
          scope: { kind: 'workspace', workspaceId },
        })
      ).toBe(bindings.get(workspaceId));
      expect(readWorkspaceNotebookIndexSource(join(root, 'workspaces', workspaceId))).toEqual(
        publications.get(workspaceId)
      );
      expect(
        readWorkspaceKnowledgeDerivedIndexes({ dataRoot: root, workspaceId }).validation
          .notebookRevision
      ).toBe(publications.get(workspaceId)!.notebookRevision);
    }
  });

  it.each([
    undefined,
    999,
  ])('refuses retained Workspace marker %s without rewriting it on seed retry', async (schemaVersion) => {
    const root = dataRoot();
    seedDemoWorkspaceDataRoot(root);
    await seedDemoWorkspaceAuthority(root);
    const path = join(root, 'workspaces', DEMO_WORKSPACE_ID, 'workspace-record.json');
    const record = JSON.parse(readFileSync(path, 'utf8'));
    delete record.schemaVersion;
    if (schemaVersion !== undefined) record.schemaVersion = schemaVersion;
    const bytes = `${JSON.stringify(record)}\n`;
    writeFileSync(path, bytes);

    seedDemoWorkspaceDataRoot(root);
    await seedDemoWorkspaceAuthority(root);
    expect(() => new FsStore({ dataRoot: root })).toThrow('Unsupported retained record format.');
    expect(readFileSync(path, 'utf8')).toBe(bytes);
  });
});

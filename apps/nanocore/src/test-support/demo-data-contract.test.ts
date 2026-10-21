// openkit-test-platform: posix
// The refusal helper preserves raw symbolic-link targets under the POSIX contract.
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeBaseIdSchema } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  seedDemoWorkspaceAuthority,
  seedDemoWorkspaceDataRoot,
} from '../../../../tests/support/demo-data.mjs';
import { scopeAdmissionFailures } from '../bootstrap/readiness.js';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { readWorkspaceNotebookIndexSource } from '../knowledge/notebook-index-source.js';
import { parseOkfDocument } from '../knowledge/okf.js';
import { FsStore } from '../lib/store.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { workspaceDbPath } from '../storage/fs-layout.js';
import { readWorkspaceKnowledgeDerivedIndexes } from '../storage/index-rebuild.js';
import { DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from './demo-store.js';
import { createTestStore } from './store.js';

const workspaceIds = [DEMO_WORKSPACE_ID, 'ws_7d54f339-a119-5221-bbbf-bfbf3e8a3f28'];
const roots: string[] = [];

afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Creates only a disposable root; the shared black-box producer owns all fixture records. */
function dataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openkit-demo-contract-'));
  roots.push(root);
  return root;
}

/**
 * Validates one retained fault in a fresh admission lifetime without resetting process state.
 *
 * Copies exact authority, seeds an independent healthy sibling, and checks refusal and preservation.
 * Each copy has a new root identity, so later faults cannot reuse an earlier refusal.
 *
 * @param dataRoot Source fixture containing the injected fault.
 * @param workspaceId Owning Workspace that must be quarantined.
 * @returns Reopened Store and isolated root for additional native readback checks.
 */
async function expectLocalWorkspaceRefusal(dataRoot: string, workspaceId: string) {
  await shutdownControlStoreWorkerClient();
  const restartRoot = mkdtempSync(join(tmpdir(), 'openkit-local-refusal-'));
  roots.push(restartRoot);
  const seed = createTestStore({ dataRoot: restartRoot });
  const sibling = await seed.createWorkspace('Healthy refusal control');
  const siblingThread = await seed.createThread(sibling.id, 'Retained sibling thread');
  const siblingBefore = seed.getWorkspace(sibling.id);
  await shutdownControlStoreWorkerClient();
  // Initialize readonly SQLite sidecars before cloning; preserve the original database bytes.
  const authorityPath = workspaceDbPath(dataRoot, workspaceId);
  const authorityBeforeRead = readFileSync(authorityPath);
  readWorkspaceMetadata(dataRoot, workspaceId);
  expect(readFileSync(authorityPath).equals(authorityBeforeRead)).toBe(true);
  cpSync(dataRoot, restartRoot, { recursive: true, verbatimSymlinks: true });

  /** Records every directory, link target and file byte, including the absence of deleted entries. */
  function snapshot(root: string): Record<string, Buffer | string> {
    const entries: Record<string, Buffer | string> = {};
    const visit = (directory: string, prefix = '') => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const key = join(prefix, entry.name);
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          entries[key] = 'directory';
          visit(path, key);
        } else {
          entries[key] = entry.isSymbolicLink() ? `link:${readlinkSync(path)}` : readFileSync(path);
        }
      }
    };
    visit(root);
    return entries;
  }

  const refusedRoot = join(restartRoot, 'workspaces', workspaceId);
  const before = snapshot(refusedRoot);
  const reopened = new FsStore({ dataRoot: restartRoot });
  expect(scopeAdmissionFailures(restartRoot)).toContainEqual(
    expect.objectContaining({ scope: 'workspace', id: workspaceId })
  );
  expect(() => reopened.getWorkspace(workspaceId)).toThrow(
    expect.objectContaining({ code: 'recovery_required' })
  );
  await expect(reopened.createThread(workspaceId, 'Must remain refused')).rejects.toThrow(
    expect.objectContaining({ code: 'recovery_required' })
  );
  expect(reopened.getWorkspace(sibling.id)).toEqual(siblingBefore);
  expect(reopened.getThread(sibling.id, siblingThread.id)).toEqual(siblingThread);
  const progress = await reopened.createThread(sibling.id, 'Healthy sibling progress');
  await shutdownControlStoreWorkerClient();
  expect(new FsStore({ dataRoot: restartRoot }).getThread(sibling.id, progress.id)).toEqual(
    progress
  );
  for (const root of [refusedRoot, join(dataRoot, 'workspaces', workspaceId)]) {
    const after = snapshot(root);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const [key, expected] of Object.entries(before)) {
      const actual = after[key];
      // Compare every byte without expanding a whole database into the failure log.
      if (Buffer.isBuffer(expected)) {
        expect(Buffer.isBuffer(actual) && actual.equals(expected), `${root}:${key}`).toBe(true);
      } else {
        expect(actual, `${root}:${key}`).toBe(expected);
      }
    }
  }
  return { store: reopened, dataRoot: restartRoot };
}

/** Reads raw retained JSON without initialization, migration, decoding or repair. */
function readWorkspaceMetadata(dataRoot: string, workspaceId: string): string {
  const sqlite = new Database(workspaceDbPath(dataRoot, workspaceId), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const row = sqlite
      .prepare('SELECT record_json FROM control_workspaces WHERE id = ?')
      .get(workspaceId) as { record_json: string } | undefined;
    if (!row) throw new Error('The retained Workspace metadata row is missing.');
    return row.record_json;
  } finally {
    sqlite.close();
  }
}

describe('shared black-box demo fixture contract', () => {
  it('loads both current Workspace records and the starter Thread through the native store', async () => {
    const root = dataRoot();
    await seedDemoWorkspaceDataRoot(root);
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
    await seedDemoWorkspaceDataRoot(root);
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

    await seedDemoWorkspaceDataRoot(root);
    await seedDemoWorkspaceAuthority(root);
    const reopened = new FsStore({ dataRoot: root });
    const pages = reopened.listKnowledge(DEMO_WORKSPACE_ID);
    const content = publications.get(DEMO_WORKSPACE_ID)!.pages.get('mem_project')!;
    expect(pages).toEqual([
      {
        id: 'mem_project',
        path: 'mem_project.md',
        content,
        contentDigest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
      },
    ]);
    expect(parseOkfDocument({ path: pages[0]!.path, content: pages[0]!.content })).toMatchObject({
      ok: true,
      document: { frontmatter: { title: 'Product focus' } },
    });
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
    await seedDemoWorkspaceDataRoot(root);
    await seedDemoWorkspaceAuthority(root);
    const siblingId = workspaceIds[1]!;
    const sibling = new FsStore({ dataRoot: root }).getWorkspace(siblingId);
    await shutdownControlStoreWorkerClient();
    const record = JSON.parse(readWorkspaceMetadata(root, DEMO_WORKSPACE_ID));
    delete record.schemaVersion;
    if (schemaVersion !== undefined) record.schemaVersion = schemaVersion;
    const bytes = `${JSON.stringify(record)}\n`;
    const sqlite = new Database(workspaceDbPath(root, DEMO_WORKSPACE_ID), {
      fileMustExist: true,
    });
    try {
      const result = sqlite
        .prepare('UPDATE control_workspaces SET record_json = ? WHERE id = ?')
        .run(bytes, DEMO_WORKSPACE_ID);
      expect(result.changes).toBe(1);
    } finally {
      sqlite.close();
    }

    await seedDemoWorkspaceDataRoot(root);
    await seedDemoWorkspaceAuthority(root);
    const restarted = await expectLocalWorkspaceRefusal(root, DEMO_WORKSPACE_ID);
    expect(restarted.store.getWorkspace(siblingId)).toEqual(sibling);
    const progress = await restarted.store.createThread(
      siblingId,
      'Other demo Workspace progresses'
    );
    await shutdownControlStoreWorkerClient();
    expect(new FsStore({ dataRoot: restarted.dataRoot }).getThread(siblingId, progress.id)).toEqual(
      progress
    );
    expect(readWorkspaceMetadata(restarted.dataRoot, DEMO_WORKSPACE_ID)).toBe(bytes);
    expect(readWorkspaceMetadata(root, DEMO_WORKSPACE_ID)).toBe(bytes);
  });
});

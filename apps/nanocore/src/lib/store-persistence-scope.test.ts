import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { createTestStore } from '../test-support/store.js';
// openkit-test-platform: posix

import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { KnowledgeNotebook } from '../knowledge/notebook.js';
import { listRecoverableWorkerCheckpoints } from '../runtime/worker-checkpoints.js';
import {
  listExistingWorkspaceDatabaseScopes,
  openBootVerifiedWorkspaceDb,
  openCoreDb,
} from '../storage/db.js';
import { applyMigrations, listAppliedNativeMigrationIds } from '../storage/migrate.js';
import { createApp } from '../test-support/app.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { knowledgePageFixture } from '../test-support/knowledge-page.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { notebookImportFixture } from '../test-support/notebook-import.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { FsStore, StoreRecordNotFoundError } from './store.js';

/**
 * Computes the canonical S16 digest for exact UTF-8 Artifact content.
 *
 * @param content Exact Artifact body.
 * @returns Lowercase SHA-256 digest with the required prefix.
 */
function artifactDigest(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

describe('FsStore workspace persistence scope', () => {
  it('persists one owner-independent workspace tree without a user storage scope', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-owner-independent-'));
    const firstStore = createTestStore({ dataRoot });
    const workspace = await firstStore.createWorkspace('Owner-independent workspace');
    const workspaceRoot = join(dataRoot, 'workspaces', workspace.id);
    const canonicalRecord = workspaceSql(dataRoot, workspace.id, (db) =>
      db.prepare('SELECT record_json FROM control_workspaces WHERE id=?').get(workspace.id)
    ) as { record_json: string };
    const canonicalConfigPath = join(workspaceRoot, 'config', 'workspace.jsonc');
    const ownerNestedRecordPath = join(
      dataRoot,
      'users',
      'usr_00000000-0000-7000-8000-000000000001',
      'workspaces',
      workspace.id,
      'workspace-record.json'
    );

    expect.soft(canonicalRecord).toBeDefined();
    expect.soft(existsSync(canonicalConfigPath)).toBe(true);
    expect.soft(existsSync(join(workspaceRoot, 'workspace.json'))).toBe(false);
    expect.soft(existsSync(ownerNestedRecordPath)).toBe(false);
    expect.soft(JSON.parse(canonicalRecord.record_json)).not.toHaveProperty('name');
    expect.soft(JSON.parse(canonicalRecord.record_json)).not.toHaveProperty('counts');
    expect.soft(JSON.parse(canonicalRecord.record_json)).not.toHaveProperty('defaults');
    expect.soft(JSON.parse(readFileSync(canonicalConfigPath, 'utf8')).workspace).toMatchObject({
      name: 'Owner-independent workspace',
      defaultAgentId: null,
    });

    const secondStore = new FsStore({ dataRoot });
    expect(() => secondStore.getWorkspace(workspace.id)).not.toThrow();
  });

  it('rejects the retired workspace.json layout instead of skipping it', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-retired-workspace-layout-'));
    const store = createTestStore({ dataRoot });
    const workspace = await store.createWorkspace('Retired layout workspace');
    const workspaceRoot = join(dataRoot, 'workspaces', workspace.id);
    const healthy = await store.createWorkspace('Healthy layout sibling');
    const retainedThread = await store.createThread(healthy.id, 'Retained sibling history');

    writeFileSync(join(workspaceRoot, 'workspace.json'), JSON.stringify(workspace));
    const bytes = readFileSync(join(workspaceRoot, 'workspace.json'));
    const database = readFileSync(join(workspaceRoot, 'db', 'workspace.sqlite'));
    const entries = readdirSync(workspaceRoot, { recursive: true }).sort();
    const reopened = new FsStore({ dataRoot });
    const refusal = expect.objectContaining({ code: 'recovery_required' });
    expect(() => reopened.getWorkspace(workspace.id)).toThrow(refusal);
    await expect(reopened.createThread(workspace.id, 'Must not recreate')).rejects.toThrow(refusal);
    expect(reopened.listWorkspaces().map(({ id }) => id)).not.toContain(workspace.id);
    expect(reopened.getThread(healthy.id, retainedThread.id)).toEqual(retainedThread);
    const added = await reopened.createThread(healthy.id, 'New sibling history');
    expect(new FsStore({ dataRoot }).getThread(healthy.id, added.id)).toEqual(added);
    expect(readFileSync(join(workspaceRoot, 'workspace.json'))).toEqual(bytes);
    expect(readFileSync(join(workspaceRoot, 'db', 'workspace.sqlite'))).toEqual(database);
    expect(readdirSync(workspaceRoot, { recursive: true }).sort()).toEqual(entries);
    expect(existsSync(join(workspaceRoot, 'workspace-record.json'))).toBe(false);
  });

  it('persists one workspace when another workspace canonical tree is blocked', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-workspace-scope-'));
    const store = createTestStore({ dataRoot });
    const blockedWorkspace = await store.createWorkspace('Blocked workspace');
    const targetWorkspace = await store.createWorkspace('Target workspace');
    const blockedArtifactsRoot = join(dataRoot, 'workspaces', blockedWorkspace.id, 'artifacts');

    rmSync(blockedArtifactsRoot, { recursive: true });
    writeFileSync(blockedArtifactsRoot, 'not a directory');
    let updateError: unknown;
    try {
      await store.updateWorkspace(targetWorkspace.id, { name: 'Updated target workspace' });
    } catch (error) {
      updateError = error;
    } finally {
      await shutdownControlStoreWorkerClient();
      rmSync(blockedArtifactsRoot);
      mkdirSync(blockedArtifactsRoot);
    }

    expect.soft(updateError).toBeUndefined();
    const restarted = new FsStore({ dataRoot });
    expect(restarted.getWorkspace(targetWorkspace.id).name).toBe('Updated target workspace');
  });

  it('does not overwrite an authored Workspace name during unrelated persistence', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-authored-workspace-name-'));
    const store = createTestStore({ dataRoot });
    const workspace = await store.createWorkspace('Initial workspace name');
    const configPath = join(dataRoot, 'workspaces', workspace.id, 'config', 'workspace.jsonc');
    const authored = `{
      // Authored outside the record store.
      "schemaVersion": 1,
      "workspace": { "name": "Authored workspace name", "defaultAgentId": null }
    }`;

    writeFileSync(configPath, authored);
    await store.createThread(workspace.id, 'Unrelated thread');

    expect(readFileSync(configPath, 'utf8')).toBe(authored);
  });

  it('retains Artifact authority when its reference append has an ambiguous outcome', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-artifact-lineage-failure-'));
    const store = createTestStore({ dataRoot });
    const workspace = await store.createWorkspace('Artifact lineage failure workspace');
    const thread = await store.createThread(workspace.id, 'Artifact lineage failure thread');
    const turn = await store.createTurn(
      workspace.id,
      thread.id,
      'Reject partial Artifact lineage',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const timestamp = turn.startedAt ?? new Date().toISOString();
    const artifactId = 'ar_00000000-0000-70b9-8815-cc8754a1bfdb';
    const requestId = 'artifact-create-reference-append-failure';
    const body = 'This Artifact remains authoritative after an ambiguous append.';
    const artifactInput = {
      id: artifactId,
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      kind: 'summary',
      title: 'Ambiguous Artifact reference append',
      status: 'ready',
      summary: null,
      version: 1,
      content: { format: 'text', body },
      contentDigest: artifactDigest(body),
      lastMutationRequestId: requestId,
      origin: {
        kind: 'turn-output',
        threadId: thread.id,
        turnId: turn.id,
        requestId,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    } as const;
    const createItem = store.createItem.bind(store);
    store.createItem = async (item) => {
      await createItem(item);
      throw new Error('Injected ambiguous Artifact reference append failure.');
    };

    try {
      await expect(store.createArtifact(artifactInput)).rejects.toThrow(
        'Injected ambiguous Artifact reference append failure.'
      );
    } finally {
      store.createItem = createItem;
    }

    expect.soft(store.listArtifacts(workspace.id)).toEqual([artifactInput]);
    expect
      .soft(
        store
          .listAllItems()
          .filter((item) => item.type === 'artifact-reference' && item.artifactId === artifactId)
      )
      .toHaveLength(1);
    const restarted = new FsStore({ dataRoot });
    expect.soft(restarted.listArtifacts(workspace.id)).toEqual([artifactInput]);
    expect
      .soft(
        restarted
          .listAllItems()
          .filter((item) => item.type === 'artifact-reference' && item.artifactId === artifactId)
      )
      .toHaveLength(1);
    let retryError: unknown;
    try {
      await store.createArtifact(artifactInput);
    } catch (error) {
      retryError = error;
    }
    expect(retryError).toMatchObject({ code: 'recovery_required', status: 409 });
  });

  it('restores the prior canonical state when Artifact introduction persistence fails', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-artifact-introduction-failure-'));
    const store = createTestStore({ dataRoot });
    const workspace = await store.createWorkspace('Artifact introduction failure workspace');
    const thread = await store.createThread(workspace.id, 'Artifact introduction failure thread');
    const acceptedAt = '2026-07-18T00:04:00.000Z';
    const requestId = 'artifact-import-before-introduction-failure';
    const body = 'Preserve this workspace-only Artifact.';
    const contentDigest = artifactDigest(body);
    const artifact = store.createArtifact({
      id: 'ar_00000000-0000-7641-b04f-e54d51e067af',
      workspaceId: workspace.id,
      threadId: null,
      turnId: null,
      kind: 'file',
      title: 'Stable Artifact',
      status: 'ready',
      summary: null,
      version: 1,
      content: { format: 'text', body },
      contentDigest,
      lastMutationRequestId: requestId,
      origin: {
        kind: 'imported',
        sourceKind: 'direct-import',
        sourceId: requestId,
        sourceDigest: contentDigest,
        actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        requestId,
        recordedAt: acceptedAt,
      },
      createdAt: acceptedAt,
      updatedAt: acceptedAt,
    });
    const faultDb = new Database(
      join(dataRoot, 'workspaces', workspace.id, 'db', 'workspace.sqlite'),
      { fileMustExist: true }
    );
    faultDb.exec(`CREATE TRIGGER refuse_introduction BEFORE INSERT ON control_product_entries
      WHEN NEW.kind='item' BEGIN SELECT RAISE(ABORT,'refuse_introduction'); END`);
    const introduction = {
      workspaceId: workspace.id,
      threadId: thread.id,
      artifactId: artifact.id,
      expectedArtifactVersion: 1,
      requestId: 'artifact-introduction-persistence-failure',
      acceptedAt: '2026-07-18T00:05:00.000Z',
      turnId: 'tu_00000000-0000-766e-836f-c2d0eadf5a64',
      triggerActor: { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' },
    };
    try {
      await expect(store.introduceArtifact(introduction)).rejects.toMatchObject({
        code: 'constraint',
        commit: 'not-committed',
      });
      expect(
        faultDb
          .prepare('SELECT count(*) AS count FROM control_turns WHERE id=?')
          .get('tu_00000000-0000-766e-836f-c2d0eadf5a64')
      ).toEqual({ count: 0 });
      expect(
        faultDb.prepare('SELECT count(*) AS count FROM control_product_entries').get()
      ).toEqual({ count: 0 });
    } finally {
      faultDb.exec('DROP TRIGGER refuse_introduction');
      faultDb.close();
    }

    expect(store.getArtifact(workspace.id, artifact.id)).toEqual(artifact);
    expect(store.listThreadTurns(workspace.id, thread.id)).toEqual([]);
    expect(store.listAllItems()).toEqual([]);

    const restarted = new FsStore({ dataRoot });
    expect(restarted.getArtifact(workspace.id, artifact.id)).toEqual(artifact);
    expect(restarted.listThreadTurns(workspace.id, thread.id)).toEqual([]);
    expect(restarted.listAllItems()).toEqual([]);
    const accepted = await store.introduceArtifact(introduction);
    expect(accepted).toMatchObject({ artifactId: artifact.id, turnId: introduction.turnId });
    expect(store.listThreadTurns(workspace.id, thread.id)).toHaveLength(1);
    expect(store.listAllItems()).toHaveLength(1);
    expect(
      new FsStore({ dataRoot }).getTurn(workspace.id, thread.id, introduction.turnId).items
    ).toEqual(store.listAllItems());
  });

  it('does not resurrect deleted knowledge when a disposable Thread projection is blocked', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-knowledge-delete-failure-'));
    const store = createTestStore({ dataRoot });
    const workspace = await store.createWorkspace('Knowledge deletion workspace');
    const thread = await store.createThread(workspace.id, 'Knowledge deletion thread');
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: FIXTURE_LOCAL_USER_ID,
      workspaceId: workspace.id,
    });
    onTestFinished(async () => {
      coreDb.sqlite.close();
      await shutdownControlStoreWorkerClient();
      rmSync(dataRoot, { recursive: true, force: true });
    });
    const app = createApp({ coreDb, dataRoot, store });
    const notebook = new KnowledgeNotebook({
      repositoryPath: join(dataRoot, 'workspaces', workspace.id, 'knowledge', 'notebook.git'),
    });
    const timestamp = new Date().toISOString();
    const knowledge = knowledgePageFixture(
      {
        id: 'delete-me',
        title: 'Delete this knowledge',
        content: 'This page must not return after restart.',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      { kind: 'workspace', workspaceId: workspace.id }
    );
    const created = await app.request('/api/app/operations/knowledge.notebook.create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openkit-request-id': randomUUID() },
      body: JSON.stringify({
        workspaceId: workspace.id,
        baseRevision: notebook.publishedRevision(),
        path: knowledge.path,
        content: knowledge.content,
        summary: 'Create the page for the deletion persistence test.',
      }),
    });
    expect(created.status, await created.clone().text()).toBe(200);
    const revision = notebook.publishedRevision();
    const content = notebook.readRevision(revision).files[`${knowledge.id}.md`]!;
    const deleted = await app.request('/api/app/operations/knowledge.notebook.delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openkit-request-id': randomUUID() },
      body: JSON.stringify({
        workspaceId: workspace.id,
        baseRevision: revision,
        path: knowledge.path,
        expectedContentDigest: artifactDigest(content),
        confirmRemoval: true,
        summary: 'Delete the page before the unrelated projection failure.',
      }),
    });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    const threadRecordPath = join(
      dataRoot,
      'workspaces',
      workspace.id,
      'threads',
      thread.id,
      'thread.json'
    );
    mkdirSync(dirname(threadRecordPath), { recursive: true });
    mkdirSync(threadRecordPath);
    await store.updateThread(workspace.id, thread.id, { name: 'Later projection' });
    rmSync(threadRecordPath, { recursive: true });
    expect(store.getThread(workspace.id, thread.id).name).toBe('Later projection');

    const restarted = new FsStore({ dataRoot });
    expect(() => restarted.getKnowledgePage(workspace.id, knowledge.id)).toThrow(
      `Knowledge page not found: ${knowledge.id}`
    );
  });
});

const trace = vi.hoisted(() => ({
  beforeRename: undefined as ((from: string, to: string) => void) | undefined,
  descriptors: new Map<number, string>(),
  events: [] as Array<{
    op: 'write' | 'sync' | 'rename';
    path: string;
    from?: string;
    directory?: boolean;
  }>,
  fail: undefined as ((path: string, directory: boolean) => boolean) | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: ((...args: Parameters<typeof actual.writeFileSync>) => {
      const path =
        typeof args[0] === 'number'
          ? (trace.descriptors.get(args[0]) ?? '<untracked>')
          : String(args[0]);
      trace.events.push({ op: 'write', path });
      return actual.writeFileSync(...args);
    }) as typeof actual.writeFileSync,
    openSync: ((...args: Parameters<typeof actual.openSync>) => {
      const descriptor = actual.openSync(...args);
      trace.descriptors.set(descriptor, String(args[0]));
      return descriptor;
    }) as typeof actual.openSync,
    closeSync: ((descriptor: number) => {
      trace.descriptors.delete(descriptor);
      return actual.closeSync(descriptor);
    }) as typeof actual.closeSync,
    fsyncSync: ((descriptor: number) => {
      const path = trace.descriptors.get(descriptor) ?? '<untracked>';
      const directory = actual.fstatSync(descriptor).isDirectory();
      trace.events.push({ op: 'sync', path, directory });
      if (trace.fail?.(path, directory)) throw new Error('Injected tree synchronization failure');
      return actual.fsyncSync(descriptor);
    }) as typeof actual.fsyncSync,
    renameSync: ((
      from: Parameters<typeof actual.renameSync>[0],
      to: Parameters<typeof actual.renameSync>[1]
    ) => {
      trace.beforeRename?.(String(from), String(to));
      trace.events.push({ op: 'rename', path: String(to), from: String(from) });
      return actual.renameSync(from, to);
    }) as typeof actual.renameSync,
  };
});

const roots: string[] = [];
afterEach(async () => {
  trace.beforeRename = undefined;
  trace.fail = undefined;
  await shutdownControlStoreWorkerClient();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Builds an imported Workspace with opaque staged bytes to exercise the whole-tree seam. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-tree-durability-'));
  roots.push(dataRoot);
  const store = createTestStore({ dataRoot });
  const workspaceId = testEntityId('ws', 'ws_durable_import');
  const finalRoot = join(dataRoot, 'workspaces', workspaceId);
  const timestamp = '2026-07-12T00:00:00.000Z';
  const publish = () =>
    store.importWorkspaceSnapshot({
      ...notebookImportFixture({ workspaceId: workspaceId, knowledge: [] }),
      workspace: {
        id: workspaceId,
        name: 'Durable import',
        kind: 'general',
        status: 'active',
        counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      threads: [],
      knowledge: [],
      turns: [],
      itemRevisions: [],
      artifacts: [],
      agentSessions: [],
      turnEvents: [],
      stageWorkspace: ({ workspaceRoot }) => {
        mkdirSync(join(workspaceRoot, 'opaque', 'nested'), { recursive: true });
        writeFileSync(
          join(workspaceRoot, 'opaque', 'nested', 'retained.bin'),
          Buffer.from([0, 1, 255])
        );
      },
    });
  trace.events.length = 0;
  return { dataRoot, finalRoot, publish, workspaceId };
}

describe('Workspace directory publication durability', () => {
  it('syncs complete nested staged bytes and both renamed parents before successful restart readback', async () => {
    const f = fixture();
    await f.publish();
    const renameAt = trace.events.findIndex(
      (event) => event.op === 'rename' && event.path === f.finalRoot
    );
    expect(renameAt).toBeGreaterThan(0);
    const staged = trace.events[renameAt].from as string;
    const before = trace.events.slice(0, renameAt);
    const nestedFileAt = before.findLastIndex(
      (event) =>
        event.op === 'sync' &&
        event.path === join(staged, 'opaque', 'nested', 'retained.bin') &&
        !event.directory
    );
    const nestedDirectoryAt = before.findLastIndex(
      (event) =>
        event.op === 'sync' && event.path === join(staged, 'opaque', 'nested') && event.directory
    );
    const opaqueDirectoryAt = before.findLastIndex(
      (event) => event.op === 'sync' && event.path === join(staged, 'opaque') && event.directory
    );
    const rootAt = before.findLastIndex(
      (event) => event.op === 'sync' && event.path === staged && event.directory
    );
    expect(nestedFileAt).toBeGreaterThanOrEqual(0);
    expect(nestedDirectoryAt).toBeGreaterThan(nestedFileAt);
    expect(opaqueDirectoryAt).toBeGreaterThan(nestedDirectoryAt);
    expect(rootAt).toBeGreaterThan(opaqueDirectoryAt);
    for (const parent of [dirname(f.finalRoot), dirname(staged)]) {
      expect(
        trace.events
          .slice(renameAt + 1)
          .some((event) => event.op === 'sync' && event.path === parent && event.directory)
      ).toBe(true);
    }
    expect(new FsStore({ dataRoot: f.dataRoot }).getWorkspace(f.workspaceId).name).toBe(
      'Durable import'
    );
    expect(readFileSync(join(f.finalRoot, 'opaque', 'nested', 'retained.bin'))).toEqual(
      Buffer.from([0, 1, 255])
    );
  });

  it('leaves no published Workspace after a staged descendant synchronization failure', async () => {
    const f = fixture();
    trace.fail = (path, directory) => !directory && path.endsWith('/opaque/nested/retained.bin');
    await expect(f.publish()).rejects.toThrow('Injected tree synchronization failure');
    expect(existsSync(f.finalRoot)).toBe(false);
    expect(new FsStore({ dataRoot: f.dataRoot }).listWorkspaces()).toEqual([]);
  });

  it.each([
    'destination',
    'source',
  ] as const)('does not acknowledge publication when the %s parent sync fails after rename', async (parent) => {
    const f = fixture();
    trace.fail = (path, directory) => {
      const publication = trace.events.find(
        (event) => event.op === 'rename' && event.path === f.finalRoot
      );
      return (
        directory &&
        publication !== undefined &&
        path ===
          (parent === 'destination' ? dirname(f.finalRoot) : dirname(publication.from as string))
      );
    };
    await expect(f.publish()).rejects.toThrow('Injected tree synchronization failure');
    trace.fail = undefined;
    expect(new FsStore({ dataRoot: f.dataRoot }).getWorkspace(f.workspaceId).name).toBe(
      'Durable import'
    );
    expect(readFileSync(join(f.finalRoot, 'opaque', 'nested', 'retained.bin'))).toEqual(
      Buffer.from([0, 1, 255])
    );
  });
});

/** Creates a fresh Workspace through either public creation path. */
function freshWorkspaceDatabaseFixture(kind: 'general' | 'personal') {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-fresh-workspace-db-'));
  roots.push(dataRoot);
  const store = createTestStore({ dataRoot });
  const create = async () =>
    kind === 'general'
      ? await store.createWorkspace('Ready for maintenance')
      : await store.ensureQuickChatWorkspace('usr_00000000-0000-7000-8000-000000000001');
  return { dataRoot, store, create };
}

/** Checks integrity and every migration required by the packaged Workspace journal. */
function expectCompleteWorkspaceJournal(sqlite: Database.Database): void {
  const journal = JSON.parse(
    readFileSync(join(process.cwd(), 'drizzle', 'workspace', 'meta', '_journal.json'), 'utf8')
  ) as { entries: Array<{ tag: string }> };
  expect(journal.entries.length).toBeGreaterThan(0);
  expect(sqlite.pragma('quick_check', { simple: true })).toBe('ok');
  expect(listAppliedNativeMigrationIds(sqlite, 'workspace')).toEqual(
    journal.entries.map(({ tag }) => `workspace_${tag}`)
  );
}

describe('fresh Workspace database publication', () => {
  it.each([
    'general',
    'personal',
  ] as const)('publishes %s with a migrated database ready for existing-only maintenance and reopen', async (kind) => {
    const f = freshWorkspaceDatabaseFixture(kind);
    const workspace = await f.create();
    expect(workspace.kind).toBe(kind);
    expect(listExistingWorkspaceDatabaseScopes(f.dataRoot)).toEqual([
      { workspaceId: workspace.id },
    ]);
    const db = openBootVerifiedWorkspaceDb(f.dataRoot, workspace.id);
    try {
      expectCompleteWorkspaceJournal(db.sqlite);
      expect(listRecoverableWorkerCheckpoints(db)).toEqual([]);
    } finally {
      db.sqlite.close();
    }
    expect(new FsStore({ dataRoot: f.dataRoot }).getWorkspace(workspace.id).kind).toBe(kind);
    const reopened = openBootVerifiedWorkspaceDb(f.dataRoot, workspace.id);
    try {
      expectCompleteWorkspaceJournal(reopened.sqlite);
      expect(listRecoverableWorkerCheckpoints(reopened)).toEqual([]);
    } finally {
      reopened.sqlite.close();
    }
  });

  it.each([
    'general',
    'personal',
  ] as const)('completes the %s database in staging before the canonical rename', async (kind) => {
    const f = freshWorkspaceDatabaseFixture(kind);
    let inspected = 0;
    trace.beforeRename = (from, to) => {
      if (
        dirname(from) !== join(f.dataRoot, 'workspaces', '.staging') ||
        dirname(to) !== join(f.dataRoot, 'workspaces')
      )
        return;
      inspected += 1;
      expect(listExistingWorkspaceDatabaseScopes(f.dataRoot)).toEqual([]);
      expect(existsSync(join(from, 'config', 'workspace.jsonc'))).toBe(true);
      const stagedDatabase = join(from, 'db', 'workspace.sqlite');
      expect(existsSync(stagedDatabase)).toBe(true);
      // Reading only the main file proves schema readiness does not depend on a live WAL sidecar.
      const snapshot = join(f.dataRoot, 'before-publication.sqlite');
      copyFileSync(stagedDatabase, snapshot);
      const sqlite = new Database(snapshot, { fileMustExist: true, readonly: true });
      try {
        expectCompleteWorkspaceJournal(sqlite);
      } finally {
        sqlite.close();
      }
    };
    const workspace = await f.create();
    expect(inspected).toBe(1);
    expect(listExistingWorkspaceDatabaseScopes(f.dataRoot)).toEqual([
      { workspaceId: workspace.id },
    ]);
    const db = openBootVerifiedWorkspaceDb(f.dataRoot, workspace.id);
    try {
      expect(listRecoverableWorkerCheckpoints(db)).toEqual([]);
    } finally {
      db.sqlite.close();
    }
  });

  it.each([
    'general',
    'personal',
  ] as const)('does not publish %s when a staged Workspace migration fails', async (kind) => {
    const f = freshWorkspaceDatabaseFixture(kind);
    const originalPrepare = Database.prototype.prepare;
    let faults = 0;
    const fault = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
      this: Database.Database,
      source: string
    ) {
      const [operation, entity, table] = source.trimStart().split(/\s+/, 3);
      if (
        this.name.includes('/workspaces/.staging/') &&
        operation === 'CREATE' &&
        entity === 'TABLE' &&
        table === '`worker_turn_checkpoints`'
      ) {
        faults += 1;
        throw new Error('Injected Workspace migration failure');
      }
      return originalPrepare.call(this, source);
    } as typeof originalPrepare);
    trace.events.length = 0;
    try {
      await expect(f.create()).rejects.toThrow(
        expect.objectContaining({ code: 'migration_failed' })
      );
      expect(faults).toBe(1);
      expect(f.store.listWorkspaces()).toEqual([]);
      expect(listExistingWorkspaceDatabaseScopes(f.dataRoot)).toEqual([]);
      expect(
        trace.events.some(
          (event) => event.op === 'rename' && dirname(event.path) === join(f.dataRoot, 'workspaces')
        )
      ).toBe(false);
    } finally {
      fault.mockRestore();
    }
  });
});

/** Opens a separate existing fixture connection and always closes it; no schema or authority is synthesized. */
function workspaceSql<T>(
  dataRoot: string,
  workspaceId: string,
  read: (db: Database.Database) => T
): T {
  const db = new Database(join(dataRoot, 'workspaces', workspaceId, 'db', 'workspace.sqlite'), {
    fileMustExist: true,
  });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/** Builds acknowledged Threads and retains their exact SQL rows for scope comparisons. */
async function threadPublicationFixture(count = 3) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-thread-publication-count-'));
  roots.push(dataRoot);
  const store = createTestStore({ dataRoot });
  const workspace = await store.createWorkspace('Thread publication');
  const threads = [];
  for (let index = 0; index < count; index++)
    threads.push(await store.createThread(workspace.id, `Thread ${index}`));
  await store.updateWorkspace(workspace.id, { name: 'Settled Thread publication' });
  const paths = threads.map((thread) =>
    join(dataRoot, 'workspaces', workspace.id, 'threads', thread.id, 'thread.json')
  );
  const rows = () =>
    workspaceSql(dataRoot, workspace.id, (db) =>
      db.prepare('SELECT * FROM control_threads ORDER BY id').all()
    );
  trace.events.length = 0;
  return { dataRoot, store, workspace, threads, paths, rows };
}

/** Lists disposable Thread projection replacements only. */
function threadReplacements(): string[] {
  return trace.events
    .filter((event) => event.op === 'rename' && basename(event.path) === 'thread.json')
    .map((event) => event.path);
}

/** Reads the exact retained SQL metadata independently of Store caches and decoders. */
function threadRecord(
  f: Awaited<ReturnType<typeof threadPublicationFixture>>,
  id: string
): Record<string, unknown> {
  const row = workspaceSql(f.dataRoot, f.workspace.id, (db) =>
    db.prepare('SELECT record_json FROM control_threads WHERE id=?').get(id)
  ) as { record_json: string };
  return JSON.parse(row.record_json);
}

/** Injects retained corruption only after stopping the native writer. */
async function replaceThreadRecord(
  f: Awaited<ReturnType<typeof threadPublicationFixture>>,
  id: string,
  record: Record<string, unknown>
): Promise<void> {
  await shutdownControlStoreWorkerClient();
  workspaceSql(f.dataRoot, f.workspace.id, (db) =>
    db
      .prepare('UPDATE control_threads SET record_json=? WHERE id=?')
      .run(JSON.stringify(record), id)
  );
}

describe('native Thread publication', () => {
  it('performs no Thread file writes or file fsyncs for an unrelated mutation across eight Threads', async () => {
    const f = await threadPublicationFixture(8);
    const before = f.rows();
    await f.store.updateWorkspace(f.workspace.id, { name: 'Workspace-only change' });
    expect(threadReplacements()).toEqual([]);
    expect(
      trace.events.filter(
        (event) =>
          !event.directory &&
          (event.op === 'write' || event.op === 'sync') &&
          (basename(event.path) === 'thread.json' ||
            basename(event.path).startsWith('.thread.json.'))
      )
    ).toEqual([]);
    expect(f.rows()).toEqual(before);
    expect(new FsStore({ dataRoot: f.dataRoot }).getWorkspace(f.workspace.id).name).toBe(
      'Workspace-only change'
    );
  });

  it('changes only the selected native Thread and preserves descriptive additions through reopen', async () => {
    const f = await threadPublicationFixture(4);
    const target = f.threads[1];
    const record = threadRecord(f, target.id);
    record.futureNote = 'retained annotation';
    record.extensions = { 'example.thread-note': { description: 'retained open extension' } };
    await replaceThreadRecord(f, target.id, record);
    const before = f.rows();
    await f.store.updateThread(f.workspace.id, target.id, { name: 'Changed Thread' });
    expect(threadReplacements()).toEqual([]);
    expect(f.rows().filter((row) => (row as { id: string }).id !== target.id)).toEqual(
      before.filter((row) => (row as { id: string }).id !== target.id)
    );
    const retained = threadRecord(f, target.id);
    expect(retained.futureNote).toBe(record.futureNote);
    expect(retained.extensions).toEqual(record.extensions);
    expect(new FsStore({ dataRoot: f.dataRoot }).getThread(f.workspace.id, target.id).name).toBe(
      'Changed Thread'
    );
  });

  it('does not rewrite native Thread authority because a disposable projection has different formatting', async () => {
    const f = await threadPublicationFixture();
    const path = f.paths[1];
    mkdirSync(dirname(path), { recursive: true });
    const compact = `${JSON.stringify({ ...f.threads[1], name: 'Uncommitted file name' })}\n`;
    writeFileSync(path, compact);
    const before = f.rows();
    await f.store.updateWorkspace(f.workspace.id, { name: 'Unrelated mutation' });
    expect(threadReplacements()).toEqual([]);
    expect(f.rows()).toEqual(before);
    expect(readFileSync(path, 'utf8')).toBe(compact);
    expect(
      new FsStore({ dataRoot: f.dataRoot }).getThread(f.workspace.id, f.threads[1].id).name
    ).toBe('Thread 1');
  });

  it('keeps prior native Thread authority when its SQL transaction fails', async () => {
    const f = await threadPublicationFixture();
    const before = f.rows();
    workspaceSql(f.dataRoot, f.workspace.id, (db) =>
      db.exec(
        `CREATE TRIGGER refuse_thread BEFORE UPDATE ON control_threads BEGIN SELECT RAISE(ABORT,'refuse_thread'); END`
      )
    );
    try {
      await expect(
        f.store.updateThread(f.workspace.id, f.threads[1].id, { name: 'Uncommitted Thread' })
      ).rejects.toMatchObject({ code: 'constraint', commit: 'not-committed' });
      expect(f.rows()).toEqual(before);
      expect(f.store.getThread(f.workspace.id, f.threads[1].id).name).toBe('Thread 1');
    } finally {
      workspaceSql(f.dataRoot, f.workspace.id, (db) => db.exec('DROP TRIGGER refuse_thread'));
    }
    expect(
      new FsStore({ dataRoot: f.dataRoot }).getThread(f.workspace.id, f.threads[1].id).name
    ).toBe('Thread 1');
  });

  it('does not follow a symlinked disposable Thread projection or grant it authority', async () => {
    const f = await threadPublicationFixture();
    const path = f.paths[1];
    mkdirSync(dirname(path), { recursive: true });
    const outside = join(f.dataRoot, 'outside-thread.json');
    const before = Buffer.from(JSON.stringify({ ...f.threads[1], name: 'Outside authority' }));
    writeFileSync(outside, before);
    symlinkSync(outside, path, 'file');
    const rows = f.rows();
    await f.store.updateWorkspace(f.workspace.id, { name: 'Ignore redirected projection' });
    expect(readFileSync(outside)).toEqual(before);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(f.rows()).toEqual(rows);
    expect(
      new FsStore({ dataRoot: f.dataRoot }).getThread(f.workspace.id, f.threads[1].id).name
    ).toBe('Thread 1');
  });

  it('does not skip unsupported required semantics on an otherwise unchanged native Thread', async () => {
    const f = await threadPublicationFixture();
    const record = threadRecord(f, f.threads[1].id);
    record.requiredFeatures = ['example.unsupported-thread-feature'];
    await replaceThreadRecord(f, f.threads[1].id, record);
    const before = f.rows();
    const reopened = new FsStore({ dataRoot: f.dataRoot });
    expect(() => reopened.getThread(f.workspace.id, f.threads[1].id)).toThrow(
      expect.objectContaining({ code: 'recovery_required' })
    );
    await expect(
      reopened.updateWorkspace(f.workspace.id, { name: 'Reject unsupported semantics' })
    ).rejects.toThrow();
    expect(f.rows()).toEqual(before);
  });

  it('retains committed Thread authority while its native acknowledgement is withheld', async () => {
    const f = await threadPublicationFixture();
    const other = await f.store.createWorkspace('Unaffected Workspace');
    const client = getControlStoreWorkerClient() as unknown as {
      receive(value: unknown, host: unknown): void;
    };
    const receive = client.receive.bind(client);
    let release!: () => void;
    let committed!: () => void;
    let failed!: (reason: unknown) => void;
    const observed = new Promise<void>((resolve, reject) => {
      committed = resolve;
      failed = reject;
    });
    const hold = vi.spyOn(client, 'receive').mockImplementation((value, host) => {
      if (
        (value as { status?: string; operation?: string }).status === 'ok' &&
        (value as { operation?: string }).operation === 'products'
      ) {
        release = () => receive(value, host);
        committed();
      } else receive(value, host);
    });
    let acknowledged = false;
    const mutation = f.store
      .updateThread(f.workspace.id, f.threads[1].id, { name: 'Committed before ACK' })
      .then((value) => {
        acknowledged = true;
        return value;
      });
    void mutation.catch(failed);
    try {
      await observed;
      expect(acknowledged).toBe(false);
      expect(threadRecord(f, f.threads[1].id).name).toBe('Committed before ACK');
      expect(
        new FsStore({ dataRoot: f.dataRoot }).getThread(f.workspace.id, f.threads[1].id).name
      ).toBe('Committed before ACK');
    } finally {
      hold.mockRestore();
      release?.();
    }
    await expect(mutation).resolves.toMatchObject({ name: 'Committed before ACK' });
    await f.store.updateWorkspace(other.id, { name: 'Still available' });
    expect(f.store.getWorkspace(other.id).name).toBe('Still available');
    expect(
      new FsStore({ dataRoot: f.dataRoot }).getThread(f.workspace.id, f.threads[1].id).name
    ).toBe('Committed before ACK');
  });
});

describe('native Thread byte authority', () => {
  it('preserves exact native descriptive bytes while ignoring invalid disposable projection bytes', async () => {
    const f = await threadPublicationFixture();
    const record = threadRecord(f, f.threads[1].id);
    record.futureNote = 'Retained \uFFFD annotation';
    await replaceThreadRecord(f, f.threads[1].id, record);
    const before = f.rows();
    const path = f.paths[1];
    mkdirSync(dirname(path), { recursive: true });
    const bytes = Buffer.from([0xff]);
    writeFileSync(path, bytes);
    await f.store.updateWorkspace(f.workspace.id, { name: 'Keep native bytes' });
    expect(threadReplacements()).toEqual([]);
    expect(f.rows()).toEqual(before);
    expect(readFileSync(path)).toEqual(bytes);
    expect(threadRecord(f, f.threads[1].id).futureNote).toBe(record.futureNote);
    expect(
      new FsStore({ dataRoot: f.dataRoot }).getThread(f.workspace.id, f.threads[1].id)
    ).toEqual(f.store.getThread(f.workspace.id, f.threads[1].id));
  });
});

describe('native Workspace absence classification', () => {
  it.each([
    'never-published',
    'retained-registered',
  ] as const)('distinguishes %s absence without changing retained authority or healthy siblings', async (kind) => {
    const f = await threadPublicationFixture(1);
    const healthy = await f.store.createWorkspace('Healthy absence sibling');
    const healthyThread = await f.store.createThread(healthy.id, 'Retained healthy history');
    const coreDb = openCoreDb(f.dataRoot);
    onTestFinished(() => coreDb.sqlite.close());
    ensureLocalUser(coreDb);
    for (const workspaceId of [f.workspace.id, healthy.id]) {
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: FIXTURE_LOCAL_USER_ID,
        workspaceId,
      });
    }
    const absentId =
      kind === 'never-published'
        ? testEntityId('ws', 'ws_never_published_absence')
        : f.workspace.id;
    const canonicalRoot = join(f.dataRoot, 'workspaces', absentId);
    const retainedRoot = join(f.dataRoot, 'retained-workspace-root');
    const healthyBefore = f.store.getWorkspace(healthy.id);
    const healthyRows = () =>
      workspaceSql(f.dataRoot, healthy.id, (db) => ({
        workspaces: db.prepare('SELECT * FROM control_workspaces ORDER BY id').all(),
        threads: db.prepare('SELECT * FROM control_threads ORDER BY id').all(),
      }));
    const serverRows = () => ({
      registry: coreDb.sqlite
        .prepare('SELECT * FROM workspace_registry ORDER BY workspace_id')
        .all(),
      membership: coreDb.sqlite
        .prepare('SELECT * FROM workspace_members ORDER BY workspace_id, user_id')
        .all(),
    });
    const healthyAuthority = healthyRows();
    const serverAuthority = serverRows();
    expect(serverAuthority.registry).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workspace_id: f.workspace.id, status: 'active' }),
        expect.objectContaining({ workspace_id: healthy.id, status: 'active' }),
      ])
    );
    expect(serverAuthority.membership).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspace_id: f.workspace.id,
          user_id: FIXTURE_LOCAL_USER_ID,
          status: 'active',
        }),
        expect.objectContaining({
          workspace_id: healthy.id,
          user_id: FIXTURE_LOCAL_USER_ID,
          status: 'active',
        }),
      ])
    );
    // Stop the Workspace writer before relocating complete retained authority.
    await shutdownControlStoreWorkerClient();
    if (kind === 'retained-registered') renameSync(canonicalRoot, retainedRoot);
    else {
      expect(
        coreDb.sqlite.prepare('SELECT * FROM workspace_registry WHERE workspace_id=?').all(absentId)
      ).toEqual([]);
      expect(
        coreDb.sqlite.prepare('SELECT * FROM workspace_members WHERE workspace_id=?').all(absentId)
      ).toEqual([]);
    }
    expect(existsSync(canonicalRoot)).toBe(false);
    const retainedFiles = () =>
      existsSync(retainedRoot)
        ? readdirSync(retainedRoot, { recursive: true })
            .map(String)
            .sort()
            .filter((path) => lstatSync(join(retainedRoot, path)).isFile())
            .map((path) => ({ path, bytes: readFileSync(join(retainedRoot, path)) }))
        : [];
    const retainedBytes = retainedFiles();
    const entries = readdirSync(f.dataRoot, { recursive: true }).sort();
    trace.events.length = 0;
    const reopened = new FsStore({ dataRoot: f.dataRoot });
    expect(reopened.getWorkspace(healthy.id)).toEqual(healthyBefore);
    expect(reopened.getThread(healthy.id, healthyThread.id)).toEqual(healthyThread);
    for (const reader of [reopened, f.store]) {
      if (kind === 'never-published') {
        expect(() => reader.getWorkspace(absentId)).toThrow(StoreRecordNotFoundError);
        expect(() => reader.getWorkspace(absentId)).toThrow(
          expect.objectContaining({ message: `Workspace not found: ${absentId}` })
        );
      } else {
        expect(() => reader.getWorkspace(absentId)).toThrow(
          expect.objectContaining({
            code: 'recovery_required',
            status: 409,
            message: expect.stringContaining(`workspace ${absentId} quarantined`),
          })
        );
      }
    }
    expect(reopened.getWorkspace(healthy.id)).toEqual(healthyBefore);
    expect(reopened.getThread(healthy.id, healthyThread.id)).toEqual(healthyThread);
    expect(existsSync(canonicalRoot)).toBe(false);
    expect(serverRows()).toEqual(serverAuthority);
    expect(healthyRows()).toEqual(healthyAuthority);
    expect(retainedFiles()).toEqual(retainedBytes);
    expect(readdirSync(f.dataRoot, { recursive: true }).sort()).toEqual(entries);
    expect(trace.events).toEqual([]);
  });
});

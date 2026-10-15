// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { listRecoverableWorkerCheckpoints } from '../runtime/worker-checkpoints.js';
import { listExistingWorkspaceDatabaseScopes, openBootVerifiedWorkspaceDb } from '../storage/db.js';
import { listAppliedNativeMigrationIds } from '../storage/migrate.js';
import { FsStore } from './store.js';

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
  it('persists one owner-independent workspace tree without a user storage scope', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-owner-independent-'));
    const firstStore = new FsStore({ dataRoot });
    const workspace = firstStore.createWorkspace('Owner-independent workspace');
    const workspaceRoot = join(dataRoot, 'workspaces', workspace.id);
    const canonicalRecordPath = join(workspaceRoot, 'workspace-record.json');
    const canonicalConfigPath = join(workspaceRoot, 'config', 'workspace.jsonc');
    const ownerNestedRecordPath = join(
      dataRoot,
      'users',
      'user_local',
      'workspaces',
      workspace.id,
      'workspace-record.json'
    );

    expect.soft(existsSync(canonicalRecordPath)).toBe(true);
    expect.soft(existsSync(canonicalConfigPath)).toBe(true);
    expect.soft(existsSync(join(workspaceRoot, 'workspace.json'))).toBe(false);
    expect.soft(existsSync(ownerNestedRecordPath)).toBe(false);
    expect.soft(JSON.parse(readFileSync(canonicalRecordPath, 'utf8'))).not.toHaveProperty('name');
    expect.soft(JSON.parse(readFileSync(canonicalRecordPath, 'utf8'))).not.toHaveProperty('counts');
    expect
      .soft(JSON.parse(readFileSync(canonicalRecordPath, 'utf8')))
      .not.toHaveProperty('defaults');
    expect.soft(JSON.parse(readFileSync(canonicalConfigPath, 'utf8')).workspace).toMatchObject({
      name: 'Owner-independent workspace',
      defaultAgentId: null,
    });

    const secondStore = new FsStore({ dataRoot });
    expect(() => secondStore.getWorkspace(workspace.id)).not.toThrow();
  });

  it('rejects the retired workspace.json layout instead of skipping it', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-retired-workspace-layout-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Retired layout workspace');
    const workspaceRoot = join(dataRoot, 'workspaces', workspace.id);

    renameSync(join(workspaceRoot, 'workspace-record.json'), join(workspaceRoot, 'workspace.json'));

    expect(() => new FsStore({ dataRoot })).toThrow(/unsupported.*workspace\.json/i);
  });

  it('persists one workspace when another workspace canonical tree is blocked', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-workspace-scope-'));
    const store = new FsStore({ dataRoot });
    const blockedWorkspace = store.createWorkspace('Blocked workspace');
    const targetWorkspace = store.createWorkspace('Target workspace');
    const blockedArtifactsRoot = join(dataRoot, 'workspaces', blockedWorkspace.id, 'artifacts');

    rmSync(blockedArtifactsRoot, { recursive: true });
    writeFileSync(blockedArtifactsRoot, 'not a directory');
    let updateError: unknown;
    try {
      store.updateWorkspace(targetWorkspace.id, { name: 'Updated target workspace' });
    } catch (error) {
      updateError = error;
    } finally {
      rmSync(blockedArtifactsRoot);
      mkdirSync(blockedArtifactsRoot);
    }

    expect.soft(updateError).toBeUndefined();
    const restarted = new FsStore({ dataRoot });
    expect(restarted.getWorkspace(targetWorkspace.id).name).toBe('Updated target workspace');
  });

  it('does not overwrite an authored Workspace name during unrelated persistence', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-authored-workspace-name-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Initial workspace name');
    const configPath = join(dataRoot, 'workspaces', workspace.id, 'config', 'workspace.jsonc');
    const authored = `{
      // Authored outside the record store.
      "schemaVersion": 1,
      "workspace": { "name": "Authored workspace name", "defaultAgentId": null }
    }`;

    writeFileSync(configPath, authored);
    store.createThread(workspace.id, 'Unrelated thread');

    expect(readFileSync(configPath, 'utf8')).toBe(authored);
  });

  it('retains Artifact authority when its reference append has an ambiguous outcome', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-artifact-lineage-failure-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Artifact lineage failure workspace');
    const thread = store.createThread(workspace.id, 'Artifact lineage failure thread');
    const turn = store.createTurn(workspace.id, thread.id, 'Reject partial Artifact lineage', {
      kind: 'user',
      id: 'user_local',
    });
    const timestamp = turn.startedAt ?? new Date().toISOString();
    const artifactId = 'ar_reference_append_failure';
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
    store.createItem = (item) => {
      createItem(item);
      throw new Error('Injected ambiguous Artifact reference append failure.');
    };

    try {
      expect(() => store.createArtifact(artifactInput)).toThrow(
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
      store.createArtifact(artifactInput);
    } catch (error) {
      retryError = error;
    }
    expect(retryError).toMatchObject({ code: 'recovery_required', status: 409 });
  });

  it('restores the prior canonical state when Artifact introduction persistence fails', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-artifact-introduction-failure-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Artifact introduction failure workspace');
    const thread = store.createThread(workspace.id, 'Artifact introduction failure thread');
    const acceptedAt = '2026-07-18T00:04:00.000Z';
    const requestId = 'artifact-import-before-introduction-failure';
    const body = 'Preserve this workspace-only Artifact.';
    const contentDigest = artifactDigest(body);
    const artifact = store.createArtifact({
      id: 'ar_introduction_write_failure',
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
        actor: { kind: 'user', id: 'user_local' },
        requestId,
        recordedAt: acceptedAt,
      },
      createdAt: acceptedAt,
      updatedAt: acceptedAt,
    });
    const persistence = store as unknown as {
      persist: (workspaceId: string) => void;
    };
    const persist = persistence.persist.bind(store);
    let failed = false;
    persistence.persist = (workspaceId) => {
      if (!failed && workspaceId === workspace.id) {
        failed = true;
        throw new Error('Injected Artifact introduction persistence failure.');
      }
      persist(workspaceId);
    };

    try {
      expect(() =>
        store.introduceArtifact({
          workspaceId: workspace.id,
          threadId: thread.id,
          artifactId: artifact.id,
          expectedArtifactVersion: 1,
          requestId: 'artifact-introduction-persistence-failure',
          acceptedAt: '2026-07-18T00:05:00.000Z',
          turnId: 'tu_artifact_introduction_persistence_failure',
          triggerActor: { kind: 'user', id: 'user_local' },
        })
      ).toThrow('Injected Artifact introduction persistence failure.');
    } finally {
      persistence.persist = persist;
    }

    expect(store.getArtifact(workspace.id, artifact.id)).toEqual(artifact);
    expect(store.listThreadTurns(workspace.id, thread.id)).toEqual([]);
    expect(store.listAllItems()).toEqual([]);

    const restarted = new FsStore({ dataRoot });
    expect(restarted.getArtifact(workspace.id, artifact.id)).toEqual(artifact);
    expect(restarted.listThreadTurns(workspace.id, thread.id)).toEqual([]);
    expect(restarted.listAllItems()).toEqual([]);
  });

  it('does not resurrect deleted knowledge after a later projection write fails', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-knowledge-delete-failure-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Knowledge deletion workspace');
    const thread = store.createThread(workspace.id, 'Knowledge deletion thread');
    const knowledge = store.createKnowledgeEntry(workspace.id, {
      kind: 'project-context',
      title: 'Delete this knowledge',
      content: 'This record must not return after restart.',
    });
    const threadRecordPath = join(
      dataRoot,
      'workspaces',
      workspace.id,
      'threads',
      thread.id,
      'thread.json'
    );
    const threadRecord = readFileSync(threadRecordPath);

    rmSync(threadRecordPath);
    mkdirSync(threadRecordPath);
    expect(() => store.deleteKnowledgeEntry(workspace.id, knowledge.id)).toThrow(/regular file/);
    rmSync(threadRecordPath, { recursive: true });
    writeFileSync(threadRecordPath, threadRecord);

    const restarted = new FsStore({ dataRoot });
    expect(() => restarted.getKnowledgeEntry(workspace.id, knowledge.id)).toThrow(
      `Knowledge entry not found: ${knowledge.id}`
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
afterEach(() => {
  trace.beforeRename = undefined;
  trace.fail = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Builds an imported Workspace with opaque staged bytes to exercise the whole-tree seam. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-tree-durability-'));
  roots.push(dataRoot);
  const store = new FsStore({ dataRoot });
  const workspaceId = 'ws_durable_import';
  const finalRoot = join(dataRoot, 'workspaces', workspaceId);
  const timestamp = '2026-07-12T00:00:00.000Z';
  const publish = () =>
    store.importWorkspaceSnapshot({
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
  it('syncs complete nested staged bytes and both renamed parents before successful restart readback', () => {
    const f = fixture();
    f.publish();
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

  it('leaves no published Workspace after a staged descendant synchronization failure', () => {
    const f = fixture();
    trace.fail = (path, directory) => !directory && path.endsWith('/opaque/nested/retained.bin');
    expect(f.publish).toThrow('Injected tree synchronization failure');
    expect(existsSync(f.finalRoot)).toBe(false);
    expect(new FsStore({ dataRoot: f.dataRoot }).listWorkspaces()).toEqual([]);
  });

  it.each([
    'destination',
    'source',
  ] as const)('does not acknowledge publication when the %s parent sync fails after rename', (parent) => {
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
    expect(f.publish).toThrow('Injected tree synchronization failure');
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
function freshWorkspaceDatabaseFixture(kind: 'general' | 'quick-chat') {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-fresh-workspace-db-'));
  roots.push(dataRoot);
  const store = new FsStore({ dataRoot });
  const create = () =>
    kind === 'general'
      ? store.createWorkspace('Ready for maintenance')
      : store.ensureQuickChatWorkspace('user_local');
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
    'quick-chat',
  ] as const)('publishes %s with a migrated database ready for existing-only maintenance and reopen', (kind) => {
    const f = freshWorkspaceDatabaseFixture(kind);
    const workspace = f.create();
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
    'quick-chat',
  ] as const)('completes the %s database in staging before the canonical rename', (kind) => {
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
      expect(existsSync(join(from, 'workspace-record.json'))).toBe(true);
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
    const workspace = f.create();
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
    'quick-chat',
  ] as const)('does not publish %s when a staged Workspace migration fails', (kind) => {
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
      expect(f.create).toThrow(expect.objectContaining({ code: 'migration_failed' }));
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

/** Creates multiple Threads and settles existing canonical formatting before measuring writes. */
function threadPublicationFixture(count = 3) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-thread-publication-count-'));
  roots.push(dataRoot);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Thread publication');
  const threads = Array.from({ length: count }, (_, index) =>
    store.createThread(workspace.id, `Thread ${index}`)
  );
  store.updateWorkspace(workspace.id, { name: 'Settled Thread publication' });
  const paths = threads.map((thread) =>
    join(dataRoot, 'workspaces', workspace.id, 'threads', thread.id, 'thread.json')
  );
  trace.events.length = 0;
  return { dataRoot, store, workspace, threads, paths };
}

/** Lists only canonical Thread file replacements, excluding unrelated record publication. */
function threadReplacements(): string[] {
  return trace.events
    .filter((event) => event.op === 'rename' && basename(event.path) === 'thread.json')
    .map((event) => event.path);
}

describe('unchanged canonical Thread publication', () => {
  it('performs no Thread file writes or file fsyncs for an unrelated mutation across eight Threads', () => {
    const f = threadPublicationFixture(8);
    const before = f.paths.map((path) => readFileSync(path));
    f.store.updateWorkspace(f.workspace.id, { name: 'Workspace-only change' });
    expect(threadReplacements()).toEqual([]);
    const threadFileOperations = trace.events.filter(
      (event) =>
        !event.directory &&
        (event.op === 'write' || event.op === 'sync') &&
        (basename(event.path) === 'thread.json' || basename(event.path).startsWith('.thread.json.'))
    );
    expect(threadFileOperations).toEqual([]);
    for (const [index, path] of f.paths.entries())
      expect(readFileSync(path)).toEqual(before[index]);
    expect(new FsStore({ dataRoot: f.dataRoot }).getWorkspace(f.workspace.id).name).toBe(
      'Workspace-only change'
    );
  });

  it('publishes only the changed Thread and preserves descriptive envelope content through reopen', () => {
    const f = threadPublicationFixture(4);
    const target = f.threads[1];
    const path = f.paths[1];
    const envelope = JSON.parse(readFileSync(path, 'utf8'));
    envelope.futureNote = 'retained annotation';
    envelope.extensions['example.thread-note'] = { description: 'retained open extension' };
    writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`);
    const otherBytes = f.paths.map((candidate) => readFileSync(candidate));
    trace.events.length = 0;
    f.store.updateThread(f.workspace.id, target.id, { name: 'Changed Thread' });
    expect(threadReplacements()).toEqual([path]);
    const renameAt = trace.events.findIndex(
      (event) => event.op === 'rename' && event.path === path
    );
    const temporary = trace.events[renameAt].from;
    expect(
      trace.events
        .slice(0, renameAt)
        .some((event) => event.op === 'sync' && !event.directory && event.path === temporary)
    ).toBe(true);
    expect(
      trace.events
        .slice(renameAt + 1)
        .some((event) => event.op === 'sync' && event.directory && event.path === dirname(path))
    ).toBe(true);
    for (const [index, candidate] of f.paths.entries())
      if (index !== 1) expect(readFileSync(candidate)).toEqual(otherBytes[index]);
    const reopened = new FsStore({ dataRoot: f.dataRoot });
    const thread = reopened.getThread(f.workspace.id, target.id);
    expect(thread.name).toBe('Changed Thread');
    const retained = JSON.parse(readFileSync(path, 'utf8'));
    expect(retained.futureNote).toBe(envelope.futureNote);
    expect(retained.extensions).toEqual(envelope.extensions);
    expect(retained.lineage).toEqual({ workspaceId: f.workspace.id, threadId: target.id });
    expect(retained.requiredFeatures).toEqual(envelope.requiredFeatures);
    expect(retained.contentDigest).not.toBe(envelope.contentDigest);
    expect(retained.contentDigest).toBe(
      `sha256:${createHash('sha256').update(JSON.stringify(thread)).digest('hex')}`
    );
  });

  it('publishes differing canonical bytes even when the known Thread core is unchanged', () => {
    const f = threadPublicationFixture();
    const path = f.paths[1];
    const canonical = readFileSync(path, 'utf8');
    const compact = `${JSON.stringify(JSON.parse(canonical))}\n`;
    expect(compact).not.toBe(canonical);
    writeFileSync(path, compact);
    trace.events.length = 0;
    f.store.updateWorkspace(f.workspace.id, { name: 'Normalize retained bytes' });
    expect(threadReplacements()).toEqual([path]);
    expect(readFileSync(path, 'utf8')).toBe(canonical);
  });

  it('keeps prior readable Thread authority when changed file synchronization fails', () => {
    const f = threadPublicationFixture();
    const path = f.paths[1];
    const before = readFileSync(path);
    trace.fail = (candidate, directory) =>
      !directory &&
      dirname(candidate) === dirname(path) &&
      basename(candidate).startsWith('.thread.json.');
    expect(() =>
      f.store.updateThread(f.workspace.id, f.threads[1].id, { name: 'Uncommitted Thread' })
    ).toThrow('Injected tree synchronization failure');
    trace.fail = undefined;
    expect(readFileSync(path)).toEqual(before);
    expect(
      new FsStore({ dataRoot: f.dataRoot }).getThread(f.workspace.id, f.threads[1].id).name
    ).toBe('Thread 1');
  });

  it('rejects a symlinked Thread file even when its target contains byte-equivalent canonical content', () => {
    const f = threadPublicationFixture();
    const path = f.paths[1];
    const before = readFileSync(path);
    const outside = join(f.dataRoot, 'outside-thread.json');
    writeFileSync(outside, before);
    rmSync(path);
    symlinkSync(outside, path, 'file');
    expect(() =>
      f.store.updateWorkspace(f.workspace.id, { name: 'Reject redirected unchanged bytes' })
    ).toThrow();
    expect(readFileSync(outside)).toEqual(before);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
  });

  it('does not skip unsupported required semantics on an otherwise unchanged Thread', () => {
    const f = threadPublicationFixture();
    const path = f.paths[1];
    const envelope = JSON.parse(readFileSync(path, 'utf8'));
    envelope.requiredFeatures.push('example.unsupported-thread-feature');
    const bytes = `${JSON.stringify(envelope, null, 2)}\n`;
    writeFileSync(path, bytes);
    expect(() =>
      f.store.updateWorkspace(f.workspace.id, { name: 'Reject unsupported semantics' })
    ).toThrow();
    expect(readFileSync(path, 'utf8')).toBe(bytes);
  });

  it('retries a failed Thread parent commit before acknowledging an unchanged-byte persistence', () => {
    const f = threadPublicationFixture();
    const path = f.paths[1];
    const threadRoot = dirname(path);
    trace.fail = (candidate, directory) =>
      directory &&
      candidate === threadRoot &&
      trace.events.some((event) => event.op === 'rename' && event.path === path);
    expect(() =>
      f.store.updateThread(f.workspace.id, f.threads[1].id, { name: 'Visible pending commit' })
    ).toThrow('Injected tree synchronization failure');
    const visibleBytes = readFileSync(path);
    expect(JSON.parse(visibleBytes.toString('utf8')).name).toBe('Visible pending commit');
    trace.events.length = 0;
    trace.fail = (candidate, directory) => directory && candidate === threadRoot;
    expect(() =>
      f.store.updateWorkspace(f.workspace.id, { name: 'Retry unchanged Thread commit' })
    ).toThrow('Injected tree synchronization failure');
    expect(
      trace.events.some(
        (event) => event.op === 'sync' && event.directory && event.path === threadRoot
      )
    ).toBe(true);
    expect(threadReplacements()).toEqual([]);
    trace.events.length = 0;
    trace.fail = undefined;
    f.store.updateWorkspace(f.workspace.id, { name: 'Accepted unchanged Thread commit' });
    expect(threadReplacements()).toEqual([]);
    expect(
      trace.events.some(
        (event) => event.op === 'sync' && event.directory && event.path === threadRoot
      )
    ).toBe(true);
    expect(readFileSync(path)).toEqual(visibleBytes);
    expect(
      new FsStore({ dataRoot: f.dataRoot }).getThread(f.workspace.id, f.threads[1].id).name
    ).toBe('Visible pending commit');
  });
});

describe('canonical Thread byte comparison', () => {
  it('normalizes raw bytes that decode to unchanged canonical Thread text', () => {
    const f = threadPublicationFixture();
    const path = f.paths[1];
    const envelope = JSON.parse(readFileSync(path, 'utf8'));
    envelope.futureNote = 'Retained \uFFFD annotation';
    writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`);
    f.store.updateWorkspace(f.workspace.id, { name: 'Settled annotation bytes' });
    const canonical = readFileSync(path);
    const replacementCharacter = Buffer.from('\uFFFD', 'utf8');
    const offset = canonical.indexOf(replacementCharacter);
    expect(offset).toBeGreaterThanOrEqual(0);
    const noncanonical = Buffer.concat([
      canonical.subarray(0, offset),
      Buffer.from([0xff]),
      canonical.subarray(offset + replacementCharacter.length),
    ]);
    expect(noncanonical.equals(canonical)).toBe(false);
    expect(noncanonical.toString('utf8')).toBe(canonical.toString('utf8'));
    writeFileSync(path, noncanonical);
    const siblings = f.paths.map((candidate) => readFileSync(candidate));
    trace.events.length = 0;
    f.store.updateWorkspace(f.workspace.id, { name: 'Normalize exact canonical bytes' });
    expect(threadReplacements()).toEqual([path]);
    expect(readFileSync(path)).toEqual(canonical);
    for (const [index, candidate] of f.paths.entries())
      if (index !== 1) expect(readFileSync(candidate)).toEqual(siblings[index]);
    const retained = JSON.parse(readFileSync(path, 'utf8'));
    expect(retained.futureNote).toBe(envelope.futureNote);
    expect(retained.contentDigest).toBe(envelope.contentDigest);
    expect(retained.lineage).toEqual(envelope.lineage);
    expect(
      new FsStore({ dataRoot: f.dataRoot }).getThread(f.workspace.id, f.threads[1].id)
    ).toEqual(f.store.getThread(f.workspace.id, f.threads[1].id));
  });
});

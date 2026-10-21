// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { openWorkspaceDb } from '../storage/db.js';
import { discardAbandonedWorkspaceStaging } from '../storage/workspace-file-records.js';
import { initializeTestCore } from '../test-support/store.js';

const require = createRequire(import.meta.url);
const nodeFs = require('node:fs') as typeof import('node:fs');
const originalRename = nodeFs.renameSync;
const originalMkdir = nodeFs.mkdirSync;
const originalCopy = nodeFs.cpSync;
const localActor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;
const timestamp = '2026-07-06T00:00:00.000Z';
const temporaryRoots: string[] = [];

afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type FsStoreCtor = typeof import('./store.js').FsStore;
type InterruptPoint = 'staging-directory' | 'before-rename' | 'after-rename';
type RecordKind = 'thread' | 'turn' | 'artifact' | 'session';

/**
 * Computes the canonical digest for exact UTF-8 Artifact content.
 *
 * @param content Exact Artifact body.
 * @returns Lowercase SHA-256 digest with the required prefix.
 */
function artifactDigest(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

/** Returns whether this path is `workspaces/.staging/record-<uuid>`. */
function isRecordStagingDirectory(target: string): boolean {
  return basename(target).startsWith('record-') && basename(dirname(target)) === '.staging';
}

/**
 * Copies a data root with the filesystem bindings saved before the fault was installed.
 *
 * @param source Data root to freeze.
 * @returns Private copy that the writer's catch cannot clean.
 */
function copyDataRoot(source: string): string {
  const snapshot = join(newDataRoot('snapshot'), 'root');
  originalCopy(source, snapshot, { recursive: true });
  return snapshot;
}

/**
 * Runs one store mutation and freezes the data root at the armed publication step.
 *
 * The copy happens before the fault throws. A killed process does not run the writer's catch,
 * so the fresh store must reload this copy rather than the original data root.
 *
 * @param point Publication step that should fail.
 * @param faults Counter incremented when the armed step runs.
 * @param dataRoot Live data root whose writer is interrupted.
 * @param run Mutation to attempt under the fault.
 * @returns The frozen data root and the path that matched the fault.
 */
async function withCrashFault(
  point: InterruptPoint,
  faults: { count: number },
  dataRoot: string,
  run: () => void | Promise<void>
): Promise<{ snapshot: string; matchedPath: string }> {
  let copying = false;
  let snapshot = '';
  let matchedPath = '';
  const capture = (target: string): void => {
    faults.count += 1;
    matchedPath = target;
    copying = true;
    try {
      snapshot = copyDataRoot(dataRoot);
    } finally {
      copying = false;
    }
    throw new Error('publication-fault');
  };
  nodeFs.renameSync = ((
    from: Parameters<typeof originalRename>[0],
    to: Parameters<typeof originalRename>[1]
  ) => {
    const source = String(from);
    if (!copying && point !== 'staging-directory' && isRecordStagingDirectory(source)) {
      if (point === 'after-rename') originalRename(from, to);
      capture(source);
    }
    return originalRename(from, to);
  }) as typeof nodeFs.renameSync;
  nodeFs.mkdirSync = ((
    path: Parameters<typeof originalMkdir>[0],
    options?: Parameters<typeof originalMkdir>[1]
  ) => {
    const result = originalMkdir(path, options);
    const target = String(path);
    if (!copying && point === 'staging-directory' && isRecordStagingDirectory(target))
      capture(target);
    return result;
  }) as typeof nodeFs.mkdirSync;
  syncBuiltinESMExports();
  try {
    await run();
  } finally {
    nodeFs.renameSync = originalRename;
    nodeFs.mkdirSync = originalMkdir;
    syncBuiltinESMExports();
  }
  return { snapshot, matchedPath };
}

/** Lists direct child directory names. */
function childDirectories(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/** Lists `workspaces/.staging/record-*` directories in one data root. */
function stagedRecordDirectories(dataRoot: string): string[] {
  return childDirectories(join(dataRoot, 'workspaces', '.staging'))
    .filter((name) => name.startsWith('record-'))
    .map((name) => join(dataRoot, 'workspaces', '.staging', name));
}

/** Returns whether an Artifact directory contains its metadata and text body. */
function artifactFilesReady(directory: string): boolean {
  return (
    existsSync(join(directory, 'artifact.json')) &&
    existsSync(join(directory, 'files', 'content.txt')) &&
    existsSync(join(directory, 'versions', '1', 'version-record.json')) &&
    existsSync(join(directory, 'versions', '1', 'payload'))
  );
}

/** Creates a private data root. */
function newDataRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `openkit-publication-${label}-`));
  temporaryRoots.push(root);
  return root;
}

/** Runs exclusive stopped-fixture recovery, then reloads after the filesystem fault is removed. */
async function reload(dataRoot: string): Promise<InstanceType<FsStoreCtor>> {
  discardAbandonedWorkspaceStaging(dataRoot);
  const { FsStore } = await import('./store.js');
  return new FsStore({ dataRoot });
}

/** Checks the independent Artifact directory owner's complete immutable version. */
function assertNoTornArtifactDirectories(dataRoot: string, workspaceId: string): void {
  const root = join(dataRoot, 'workspaces', workspaceId, 'artifacts');
  for (const id of childDirectories(root)) expect(artifactFilesReady(join(root, id))).toBe(true);
}

/** Builds an imported Artifact whose required files are the directory itself. */
function importedArtifact(workspaceId: string) {
  const body = 'Artifact body.';
  return {
    id: 'ar_00000000-0000-7191-9414-45fcac2c3cdb',
    workspaceId,
    threadId: null,
    turnId: null,
    kind: 'file' as const,
    title: 'Partial artifact',
    status: 'ready' as const,
    summary: null,
    version: 1,
    content: { format: 'text' as const, body },
    contentDigest: artifactDigest(body),
    lastMutationRequestId: 'artifact-publication-fault',
    origin: {
      kind: 'imported' as const,
      sourceKind: 'direct-import' as const,
      sourceId: 'artifact-publication-fault',
      sourceDigest: artifactDigest(body),
      actor: localActor,
      requestId: 'artifact-publication-fault',
      recordedAt: timestamp,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

const crashPoints: readonly InterruptPoint[] = [
  'staging-directory',
  'before-rename',
  'after-rename',
];
const crashKinds: readonly RecordKind[] = ['thread', 'turn', 'artifact', 'session'];

for (const kind of crashKinds) {
  for (const point of crashPoints) {
    const nativePoint = {
      'staging-directory': 'before-native-dispatch',
      'before-rename': 'native-rollback',
      'after-rename': 'after-native-commit-before-ack',
    }[point];
    it(`reloads a ${kind} interrupted at ${kind === 'artifact' ? point : nativePoint}`, async () => {
      const dataRoot = newDataRoot(`${kind}-${point}`);
      const { FsStore } = await import('./store.js');
      initializeTestCore(dataRoot);
      const store = new FsStore({ dataRoot });
      const kept = await store.createWorkspace('Kept workspace');
      await store.createThread(kept.id, 'Kept thread');
      const workspace = await store.createWorkspace('Record workspace');
      const thread = await store.createThread(workspace.id, 'Original preview');
      if (kind === 'artifact') {
        const faults = { count: 0 };
        // All SQL setup has settled before the independent Artifact file-owner fault.
        await shutdownControlStoreWorkerClient();
        const captured = await withCrashFault(point, faults, dataRoot, () => {
          expect(() => store.createArtifact(importedArtifact(workspace.id))).toThrow(
            'publication-fault'
          );
        });
        expect(faults.count).toBe(1);
        expect(isRecordStagingDirectory(captured.matchedPath)).toBe(true);
        const staged = stagedRecordDirectories(captured.snapshot);
        const canonical = join(
          captured.snapshot,
          'workspaces',
          workspace.id,
          'artifacts',
          importedArtifact(workspace.id).id
        );
        if (point === 'after-rename') {
          expect(staged).toEqual([]);
          expect(artifactFilesReady(canonical)).toBe(true);
        } else {
          expect(staged).toHaveLength(1);
          expect(existsSync(canonical)).toBe(false);
          expect(artifactFilesReady(staged[0]!)).toBe(point === 'before-rename');
        }
        const reloaded = await reload(captured.snapshot);
        expect(reloaded.getWorkspace(kept.id).name).toBe('Kept workspace');
        expect(reloaded.getWorkspace(workspace.id).name).toBe('Record workspace');
        expect(existsSync(join(captured.snapshot, 'workspaces', '.staging'))).toBe(false);
        assertNoTornArtifactDirectories(captured.snapshot, workspace.id);
        expect(reloaded.listArtifacts(workspace.id).map(({ id }) => id)).toEqual(
          point === 'after-rename' ? [importedArtifact(workspace.id).id] : []
        );
        return;
      }
      const id =
        kind === 'thread'
          ? 'th_00000000-0000-7317-b428-c81ba6501ea3'
          : kind === 'turn'
            ? 'tu_00000000-0000-7097-8c23-6c30c55457e6'
            : 'as_00000000-0000-77a2-94b7-507e5fd22bf9';
      const table =
        kind === 'thread'
          ? 'control_threads'
          : kind === 'turn'
            ? 'control_turns'
            : 'control_agent_sessions';
      const client = getControlStoreWorkerClient();
      const products = client.products.bind(client);
      if (point === 'before-rename') {
        const db = openWorkspaceDb(dataRoot, workspace.id);
        try {
          db.sqlite.exec(
            `CREATE TRIGGER interrupt_native BEFORE INSERT ON ${table} WHEN NEW.id='${id}' BEGIN SELECT RAISE(ABORT, 'publication-fault'); END`
          );
        } finally {
          db.sqlite.close();
        }
      }
      let snapshot = '';
      let interceptions = 0;
      const interception = vi.spyOn(client, 'products').mockImplementationOnce(async (...args) => {
        interceptions++;
        if (point === 'before-rename') {
          await expect(products(...args)).rejects.toMatchObject({ commit: 'not-committed' });
        } else if (point === 'after-rename') await products(...args);
        await shutdownControlStoreWorkerClient();
        snapshot = copyDataRoot(dataRoot);
        throw new ControlStoreWorkerError(
          'unavailable',
          point === 'after-rename' ? 'unknown' : 'not-committed'
        );
      });
      try {
        const mutation =
          kind === 'thread'
            ? store.createThread(workspace.id, 'Partial thread', id)
            : kind === 'turn'
              ? store.createTurn(
                  workspace.id,
                  thread.id,
                  'partial publication input',
                  localActor,
                  null,
                  { turnId: id }
                )
              : store.createAgentSession({
                  id,
                  agentId: 'agent_codex_host',
                  workspaceId: workspace.id,
                  threadId: thread.id,
                  status: 'busy',
                  message: null,
                  createdAt: timestamp,
                  updatedAt: timestamp,
                });
        await expect(mutation).rejects.toMatchObject({
          commit: point === 'after-rename' ? 'unknown' : 'not-committed',
        });
        expect(interceptions).toBe(1);
      } finally {
        interception.mockRestore();
      }
      const reloaded = await reload(snapshot);
      expect(reloaded.getWorkspace(kept.id).name).toBe('Kept workspace');
      expect(reloaded.getWorkspace(workspace.id).name).toBe('Record workspace');
      const db = openWorkspaceDb(snapshot, workspace.id);
      try {
        expect(db.sqlite.prepare(`SELECT id FROM ${table} WHERE id=?`).all(id)).toEqual(
          point === 'after-rename' ? [{ id }] : []
        );
      } finally {
        db.sqlite.close();
      }
      if (kind === 'thread')
        expect(
          reloaded
            .listThreads(workspace.id)
            .map(({ name }) => name)
            .sort()
        ).toEqual(
          point === 'after-rename'
            ? ['Original preview', 'Partial thread'].sort()
            : ['Original preview']
        );
      if (kind === 'turn') {
        expect(reloaded.listThreadTurns(workspace.id, thread.id).map(({ id }) => id)).toEqual(
          point === 'after-rename' ? [id] : []
        );
        expect(reloaded.getThread(workspace.id, thread.id).preview).toBe(
          point === 'after-rename' ? 'partial publication input' : 'Original preview'
        );
      }
      if (kind === 'session')
        expect(reloaded.listWorkspaceAgentSessions(workspace.id).map(({ id }) => id)).toEqual(
          point === 'after-rename' ? [id] : []
        );
    });
  }
}

it('drops staging left by a real interrupted Artifact write', async () => {
  const dataRoot = newDataRoot('planted-staging');
  const { FsStore } = await import('./store.js');
  initializeTestCore(dataRoot);
  const store = new FsStore({ dataRoot });
  const kept = await store.createWorkspace('Kept workspace');
  await store.createThread(kept.id, 'Kept thread');
  const workspace = await store.createWorkspace('Staging workspace');
  await store.createThread(workspace.id, 'Original preview');
  const faults = { count: 0 };
  await shutdownControlStoreWorkerClient();
  const captured = await withCrashFault('before-rename', faults, dataRoot, () => {
    expect(() => store.createArtifact(importedArtifact(workspace.id))).toThrow('publication-fault');
  });

  expect(faults.count).toBe(1);
  const staged = stagedRecordDirectories(captured.snapshot);
  expect(staged).toHaveLength(1);
  expect(readFileSync(join(staged[0] ?? '', 'artifact.json'), 'utf8')).toContain(
    'ar_00000000-0000-7191-9414-45fcac2c3cdb'
  );
  expect(readFileSync(join(staged[0] ?? '', 'files', 'content.txt'), 'utf8')).toBe(
    'Artifact body.'
  );

  const reloaded = await reload(captured.snapshot);
  expect(reloaded.getWorkspace(workspace.id).name).toBe('Staging workspace');
  expect(reloaded.listArtifacts(workspace.id)).toEqual([]);
  expect(reloaded.listWorkspaceAgentSessions(workspace.id)).toEqual([]);
  expect(existsSync(join(captured.snapshot, 'workspaces', '.staging'))).toBe(false);
  expect(
    existsSync(
      join(
        captured.snapshot,
        'workspaces',
        workspace.id,
        'artifacts',
        'ar_00000000-0000-7191-9414-45fcac2c3cdb'
      )
    )
  ).toBe(false);
});

it('loads a published Turn beside the Thread preview from before that Turn', async () => {
  const { FsStore } = await import('./store.js');
  const dataRoot = newDataRoot('preview');
  initializeTestCore(dataRoot);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Preview workspace');
  const thread = await store.createThread(workspace.id, 'Original preview');
  const db = openWorkspaceDb(dataRoot, workspace.id);
  const beforeTurn = (
    db.sqlite.prepare('SELECT record_json FROM control_threads WHERE id=?').get(thread.id) as {
      record_json: string;
    }
  ).record_json;
  await store.createTurn(workspace.id, thread.id, 'partial publication input', localActor, null, {
    turnId: 'tu_00000000-0000-7ab2-8211-16142303a54d',
  });
  await shutdownControlStoreWorkerClient();
  // A stale descriptive Thread preview must not erase an independently committed Turn.
  db.sqlite
    .prepare('UPDATE control_threads SET record_json=? WHERE id=?')
    .run(beforeTurn, thread.id);
  db.sqlite.close();

  const reloaded = new FsStore({ dataRoot });

  expect(reloaded.listThreads(workspace.id).find((item) => item.id === thread.id)?.preview).toBe(
    'Original preview'
  );
  expect(reloaded.listThreadTurns(workspace.id, thread.id).map((item) => item.id)).toEqual([
    'tu_00000000-0000-7ab2-8211-16142303a54d',
  ]);
  const reopened = openWorkspaceDb(dataRoot, workspace.id);
  try {
    expect(
      reopened.sqlite
        .prepare('SELECT id FROM control_turns WHERE id=?')
        .get('tu_00000000-0000-7ab2-8211-16142303a54d')
    ).toEqual({ id: 'tu_00000000-0000-7ab2-8211-16142303a54d' });
  } finally {
    reopened.sqlite.close();
  }
});

for (const point of ['before-rename', 'after-rename'] as const) {
  it(`retains real binary v1 at initial Artifact directory ${point}`, async () => {
    const dataRoot = newDataRoot(`binary-${point}`);
    const { FsStore } = await import('./store.js');
    initializeTestCore(dataRoot);
    const store = new FsStore({ dataRoot });
    const workspace = await store.createWorkspace('Binary publication');
    const bytes = Buffer.from([0, 255, 128, 13, 10]);
    const contentDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const payloadPath = join(dataRoot, 'private-original');
    writeFileSync(payloadPath, bytes);
    const base = importedArtifact(workspace.id);
    const artifact = {
      ...base,
      content: {
        format: 'file' as const,
        mediaType: 'application/octet-stream',
        byteLength: bytes.length,
      },
      contentDigest,
      origin: { ...base.origin, sourceDigest: contentDigest },
    };
    const faults = { count: 0 };
    await shutdownControlStoreWorkerClient();
    const captured = await withCrashFault(point, faults, dataRoot, () => {
      expect(() =>
        store.createArtifact(artifact, {
          path: payloadPath,
          byteLength: bytes.length,
          contentDigest,
          remove: async () => {},
        })
      ).toThrow('publication-fault');
    });
    expect(faults.count).toBe(1);
    const canonical = join(captured.snapshot, 'workspaces', workspace.id, 'artifacts', artifact.id);
    const directory =
      point === 'after-rename' ? canonical : stagedRecordDirectories(captured.snapshot)[0]!;
    const descriptor = JSON.parse(
      readFileSync(join(directory, 'versions', '1', 'version-record.json'), 'utf8')
    );
    expect(descriptor).toMatchObject({
      schemaVersion: 1,
      version: { actor: localActor },
      artifact: { version: 1, contentDigest },
    });
    expect(readFileSync(join(directory, 'versions', '1', 'payload'))).toEqual(bytes);
    const reopened = await reload(captured.snapshot);
    expect(reopened.listArtifacts(workspace.id)).toEqual(
      point === 'after-rename' ? [artifact] : []
    );
  });
}

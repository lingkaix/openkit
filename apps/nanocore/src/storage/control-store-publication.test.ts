// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { allocateEntityId, ItemSchema } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isScopeAdmitted } from '../bootstrap/readiness.js';
import { createTestStore } from '../test-support/store.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { workspaceDbPath } from './fs-layout.js';
import { prepareImmutableProductJson } from './immutable-content.js';
import {
  discardAbandonedWorkspaceStaging,
  nativeProductScope,
  readNativeProductEntries,
} from './workspace-file-records.js';
import { verifyAndMigrateExistingScopedDatabases } from './workspace-storage-migration.js';

const instrumentation = vi.hoisted(() => ({
  trace: undefined as SharedArrayBuffer | undefined,
  root: '',
  source: '',
}));

// Preserve the actual entry, SQLite implementation and reply channel.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        if (!instrumentation.trace) {
          super(filename, options);
          return;
        }
        const prelude = `
          const publicationRecord = (${instrumentation.source})(
            require, require('node:worker_threads').workerData.publicationTrace,
            require('node:worker_threads').workerData.publicationRoot, 'worker'
          ).record;
          const Database = require(require('node:worker_threads').workerData.databaseModule);
          const execute = Database.prototype.exec;
          Database.prototype.exec = function(sql) {
            publicationRecord({phase: 'sql-before', sql});
            const result = execute.call(this, sql);
            publicationRecord({phase: 'sql-after', sql});
            return result;
          };
          const publicationPort = require('node:worker_threads').parentPort;
          const publicationPost = publicationPort.postMessage;
          publicationPort.postMessage = function(message, ...args) {
            publicationRecord({phase: 'ack', operation: message.operation, status: message.status});
            return publicationPost.call(this, message, ...args);
          };
        `;
        const entry = options?.eval
          ? String(filename)
          : `import(${JSON.stringify(String(filename))});`;
        super(prelude + entry, {
          ...options,
          eval: true,
          workerData: {
            ...options?.workerData,
            databaseModule: createRequire(import.meta.url).resolve('better-sqlite3'),
            publicationTrace: instrumentation.trace,
            publicationRoot: instrumentation.root,
          },
        });
      }
    },
  };
});

type TraceRow = {
  phase: string;
  where: 'main' | 'worker';
  kind?: 'file' | 'parent';
  path?: string;
  identity?: string;
  digest?: string;
  sql?: string;
  operation?: string;
  status?: string;
};

/** Observes real barriers in either thread; the selected native barrier alone can fail. */
function installObservation(
  require: NodeRequire,
  trace: SharedArrayBuffer,
  root: string,
  where: 'main' | 'worker'
) {
  const fs = require('node:fs') as typeof import('node:fs');
  const promises = require('node:fs/promises') as typeof import('node:fs/promises');
  const state = new Int32Array(trace, 0, 4);
  const bytes = new Uint8Array(trace, 16);
  const width = 2048;
  let parallelArrivals = 0;
  const descriptors = new Map<number, string>();
  const saved = {
    open: promises.open,
    openSync: fs.openSync,
    closeSync: fs.closeSync,
    fsyncSync: fs.fsyncSync,
    fdatasyncSync: fs.fdatasyncSync,
  };
  /** Fixed slots prevent Main and Worker records from overwriting each other. */
  function record(row: Omit<TraceRow, 'where'>) {
    if (!Atomics.load(state, 0)) return;
    const at = Atomics.add(state, 1, 1) * width;
    const encoded = Buffer.from(JSON.stringify({ ...row, where }));
    if (encoded.length >= width || at + width > bytes.length) {
      Atomics.store(state, 2, 1);
      return;
    }
    bytes.set(encoded, at);
    // Reused slots must terminate the current record instead of retaining an earlier JSON suffix.
    bytes[at + encoded.length] = 0;
  }
  /** A separate read preserves write-only descriptor state and identifies bytes across copied aliases. */
  function barrier(fd: number, path: string) {
    if (!Atomics.load(state, 0) || !(path === root || path.startsWith(`${root}/`))) return;
    const stat = fs.fstatSync(fd);
    const kind = stat.isDirectory() ? 'parent' : 'file';
    let digest: string | undefined;
    if (kind === 'file') {
      digest = require('node:crypto')
        .createHash('sha256')
        .update(fs.readFileSync(path))
        .digest('hex');
    }
    const row = { kind, path, identity: `${stat.dev}:${stat.ino}`, digest } as const;
    const fault = Atomics.load(state, 3);
    if (
      where === 'worker' &&
      ((fault === 1 && kind === 'file') || (fault === 2 && kind === 'parent'))
    ) {
      record({ phase: 'sync-failed', ...row });
      throw new Error('Injected native publication barrier failure');
    }
    return row;
  }
  promises.open = (async (...args: Parameters<typeof promises.open>) => {
    const handle = await saved.open(...args);
    for (const name of ['sync', 'datasync'] as const) {
      const synchronize = handle[name].bind(handle);
      handle[name] = async () => {
        const row = barrier(handle.fd, String(args[0]));
        if (row) record({ phase: 'sync-start', ...row });
        // Gate the real async boundary so differing read preparation cannot fake serial publication.
        if (row?.kind === 'file' && where === 'worker' && Atomics.load(state, 3) === 3) {
          parallelArrivals += 1;
          if (parallelArrivals >= 2) {
            Atomics.store(state, 3, 0);
            Atomics.notify(state, 3);
          } else await Atomics.waitAsync(state, 3, 3).value;
        }
        await synchronize();
        if (row) record({ phase: 'sync', ...row });
      };
    }
    return handle;
  }) as typeof promises.open;
  fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
    const fd = saved.openSync(...args);
    descriptors.set(fd, String(args[0]));
    return fd;
  }) as typeof fs.openSync;
  fs.closeSync = (fd: number) => {
    try {
      return saved.closeSync(fd);
    } finally {
      descriptors.delete(fd);
    }
  };
  for (const name of ['fsyncSync', 'fdatasyncSync'] as const) {
    fs[name] = (fd: number) => {
      const path = descriptors.get(fd);
      const row = path === undefined ? undefined : barrier(fd, path);
      if (row) record({ phase: 'sync-start', ...row });
      saved[name](fd);
      if (row) record({ phase: 'sync', ...row });
    };
  }
  require('node:module').syncBuiltinESMExports();
  return {
    record,
    restore() {
      promises.open = saved.open;
      fs.openSync = saved.openSync;
      fs.closeSync = saved.closeSync;
      fs.fsyncSync = saved.fsyncSync;
      fs.fdatasyncSync = saved.fdatasyncSync;
      require('node:module').syncBuiltinESMExports();
    },
  };
}

const roots: string[] = [];
let observation: ReturnType<typeof installObservation> | undefined;
const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;

afterEach(async () => {
  if (instrumentation.trace) {
    const state = new Int32Array(instrumentation.trace, 0, 4);
    Atomics.store(state, 0, 0);
    // A serial-publication RED uses the existing deadline; teardown must release its pending barrier.
    Atomics.store(state, 3, 0);
    Atomics.notify(state, 3);
  }
  await shutdownControlStoreWorkerClient();
  observation?.restore();
  observation = undefined;
  instrumentation.trace = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Establishes every accepted dependency through the existing shared Store builder. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-publication-'));
  roots.push(root);
  instrumentation.root = root;
  instrumentation.source = installObservation.toString();
  instrumentation.trace = new SharedArrayBuffer(16 + 2048 * 512);
  observation = installObservation(
    createRequire(import.meta.url),
    instrumentation.trace,
    root,
    'main'
  );
  const store = createTestStore({ dataRoot: root });
  const workspace = await store.createWorkspace('Publication seam');
  const thread = await store.createThread(workspace.id, 'Native publication');
  const turn = await store.createTurn(workspace.id, thread.id, 'Input', actor);
  const scope = nativeProductScope(root, { kind: 'workspace', workspaceId: workspace.id });
  const item = ItemSchema.parse({
    id: allocateEntityId('it'),
    owner: turn.owner,
    threadId: thread.id,
    turnId: turn.id,
    type: 'user-message',
    actor,
    text: 'Exact new native bytes'.repeat(3_200),
    status: 'completed',
    createdAt: turn.startedAt!,
    completedAt: turn.startedAt!,
  });
  const state = new Int32Array(instrumentation.trace, 0, 4);
  return {
    root,
    store,
    workspace,
    thread,
    turn,
    scope,
    item,
    arm(fault: 0 | 1 | 2 | 3 = 0) {
      Atomics.store(state, 1, 0);
      Atomics.store(state, 2, 0);
      Atomics.store(state, 3, fault);
      Atomics.store(state, 0, 1);
    },
    stop() {
      Atomics.store(state, 0, 0);
      expect(Atomics.load(state, 2)).toBe(0);
      const bytes = new Uint8Array(instrumentation.trace!, 16);
      return Array.from({ length: Atomics.load(state, 1) }, (_, index) => {
        const slot = bytes.subarray(index * 2048, (index + 1) * 2048);
        return JSON.parse(Buffer.from(slot.subarray(0, slot.indexOf(0))).toString()) as TraceRow;
      });
    },
    history: () => readNativeProductEntries(scope, turn.id, 'item'),
  };
}

/** Finds the exact admitted body without assuming private names or following directory links. */
function bodyFor(root: string, id: string): string {
  const matches: string[] = [];
  function visit(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        try {
          if (JSON.parse(readFileSync(path, 'utf8')).id === id) matches.push(path);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
      }
    }
  }
  visit(root);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

describe('FsStore to native publication ownership', () => {
  it('synchronizes new bytes once in the worker before SQL and preserves the acknowledged cut on cold reopen', async () => {
    const f = await fixture();
    f.arm();
    const accepted = await f.store.createItem(f.item);
    const rows = f.stop();
    const path = bodyFor(f.scope.contentMount.root, f.item.id);
    const bytes = readFileSync(path);
    const stat = statSync(path);
    const identity = `${stat.dev}:${stat.ino}`;
    const digest = createHash('sha256').update(bytes).digest('hex');
    // DX Write And Space Budget: exactly one successful first file barrier, owned by the worker.
    const bodySyncs = rows.filter(
      (row) => row.phase === 'sync' && row.kind === 'file' && row.digest === digest
    );
    expect(bodySyncs).toHaveLength(1);
    expect(bodySyncs[0]).toMatchObject({ where: 'worker', kind: 'file', identity });
    // The established mount is unchanged; the new canonical entry changes this parent exactly once.
    const parentSyncs = rows.filter(
      (row) => row.phase === 'sync' && row.kind === 'parent' && row.path === dirname(path)
    );
    expect(parentSyncs).toHaveLength(1);
    expect(parentSyncs[0]!.where).toBe('worker');
    expect(rows.indexOf(parentSyncs[0]!)).toBeGreaterThan(rows.indexOf(bodySyncs[0]!));
    const begin = rows.findIndex(
      (row) => row.phase === 'sql-before' && /^BEGIN\b/i.test(row.sql ?? '')
    );
    const commit = rows.findIndex(
      (row) => row.phase === 'sql-after' && /^COMMIT$/i.test(row.sql ?? '')
    );
    const ack = rows.findIndex(
      (row) => row.phase === 'ack' && row.status === 'ok' && row.operation !== 'open'
    );
    expect(begin).toBeGreaterThan(rows.indexOf(bodySyncs[0]!));
    expect(begin).toBeGreaterThan(rows.indexOf(parentSyncs[0]!));
    expect(commit).toBeGreaterThan(begin);
    expect(ack).toBeGreaterThan(commit);
    const retained = f.history();
    expect(retained.some((entry) => entry.id === accepted.id)).toBe(true);
    const turn = structuredClone(f.store.getTurnById(f.turn.id));
    await shutdownControlStoreWorkerClient();
    const cold = createTestStore({ dataRoot: f.root });
    expect(cold.getTurnById(f.turn.id)).toEqual(turn);
    expect(f.history()).toEqual(retained);
    expect(readFileSync(path)).toEqual(bytes);
  });

  it.each([
    ['file', 1],
    ['parent', 2],
  ] as const)('refuses a native %s sync failure without an accepted reference after cold reopen', async (_kind, fault) => {
    const f = await fixture();
    const before = f.history();
    const turn = structuredClone(f.store.getTurnById(f.turn.id));
    f.arm(fault);
    await expect(f.store.createItem(f.item)).rejects.toThrow();
    const rows = f.stop();
    expect(
      rows.some(
        (row) => row.phase === 'sync-failed' && row.where === 'worker' && row.kind === _kind
      )
    ).toBe(true);
    // DX: failed publication may leave unreferenced bytes, never an accepted dangling reference.
    expect(f.history()).toEqual(before);
    expect(f.store.getTurnById(f.turn.id)).toEqual(turn);
    await shutdownControlStoreWorkerClient();
    const cold = createTestStore({ dataRoot: f.root });
    expect(cold.getTurnById(f.turn.id)).toEqual(turn);
    expect(f.history()).toEqual(before);
    // A definite refusal does not invent an accepted record or prevent a fresh owner invocation.
    await expect(cold.createItem(f.item)).resolves.toEqual(f.item);
    expect(f.history().some((entry) => entry.id === f.item.id)).toBe(true);
  });
});

/** Records exact bytes and link targets without traversing symbolic links. */
function treeBytes(root: string): Record<string, Buffer | string> {
  const snapshot: Record<string, Buffer | string> = {};
  function visit(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        snapshot[path] = 'directory';
        visit(path);
      } else if (entry.isSymbolicLink()) snapshot[path] = `link:${readlinkSync(path)}`;
      else if (entry.isFile()) snapshot[path] = readFileSync(path);
    }
  }
  visit(root);
  return snapshot;
}

/** Lists actual immutable files without treating a link as a content grant. */
function contentFiles(root: string): string[] {
  return Object.entries(treeBytes(root))
    .filter(([, bytes]) => Buffer.isBuffer(bytes))
    .map(([path]) => path);
}

/** Obtains an actual abandoned private name from the public preparation seam. */
async function abandon(f: Awaited<ReturnType<typeof fixture>>, scope = f.scope) {
  const prepared = await prepareImmutableProductJson(
    scope.contentMount,
    scope.owner,
    join(dirname(dirname(scope.path)), 'runtime', 'staging'),
    { privatePreparation: allocateEntityId('it') }
  );
  expect(prepared.publication).toBeDefined();
  const path = join(scope.contentMount.root, prepared.publication!.temporary);
  expect(readFileSync(path).length).toBeGreaterThan(0);
  return { path, temporary: prepared.publication!.temporary };
}

describe('native publication cleanup, retained reuse and file cohorts', () => {
  it('cleans an actual private preparation while preserving canonical, similar-name, sibling and linked bytes', async () => {
    const f = await fixture();
    await f.store.createItem(f.item);
    const canonical = bodyFor(f.scope.contentMount.root, f.item.id);
    const canonicalBytes = readFileSync(canonical);
    const prepared = await abandon(f);
    const similar = join(f.scope.contentMount.root, `${prepared.temporary}.keep`);
    const unrelated = join(f.scope.contentMount.root, 'operator-notes.tmp');
    writeFileSync(similar, 'Not an exact native private name');
    writeFileSync(unrelated, 'Operator bytes');
    const sibling = await f.store.createWorkspace('Unrelated sibling files');
    const siblingPath = join(f.root, 'workspaces', sibling.id, 'artifacts', prepared.temporary);
    mkdirSync(dirname(siblingPath), { recursive: true });
    writeFileSync(siblingPath, 'Same spelling outside the native content root');
    const outside = join(f.root, 'operator-owned');
    mkdirSync(outside);
    writeFileSync(join(outside, prepared.temporary), 'Outside bytes');
    const link = join(f.scope.contentMount.root, 'operator-link');
    symlinkSync(outside, link, 'dir');
    const outsideBefore = treeBytes(outside);
    const target = readlinkSync(link);
    await shutdownControlStoreWorkerClient();
    // DX startup-cleanup rule: exact abandoned native names only, under exclusive admission.
    discardAbandonedWorkspaceStaging(f.root);
    expect(existsSync(prepared.path)).toBe(false);
    expect(readFileSync(canonical)).toEqual(canonicalBytes);
    expect(readFileSync(similar, 'utf8')).toBe('Not an exact native private name');
    expect(readFileSync(unrelated, 'utf8')).toBe('Operator bytes');
    expect(readFileSync(siblingPath, 'utf8')).toBe('Same spelling outside the native content root');
    expect(readlinkSync(link)).toBe(target);
    expect(treeBytes(outside)).toEqual(outsideBefore);
    expect(createTestStore({ dataRoot: f.root }).getTurnById(f.turn.id).items).toContainEqual(
      f.item
    );
  });

  it('does not touch a quarantined Workspace or traverse its link while cleaning an admitted sibling', async () => {
    const f = await fixture();
    const bad = await f.store.createWorkspace('Quarantined publication');
    const scope = nativeProductScope(f.root, { kind: 'workspace', workspaceId: bad.id });
    const privateBad = await abandon(f, scope);
    const privateGood = await abandon(f);
    const outside = join(f.root, 'quarantine-outside');
    mkdirSync(outside);
    writeFileSync(join(outside, privateBad.temporary), 'Outside quarantine bytes');
    await shutdownControlStoreWorkerClient();
    // Deliberate corruption follows valid owner setup and precedes the real boot verifier.
    writeFileSync(workspaceDbPath(f.root, bad.id), 'Unreadable stopped Workspace database');
    await verifyAndMigrateExistingScopedDatabases(f.root);
    expect(isScopeAdmitted(f.root, 'workspace', bad.id)).toBe(false);
    expect(isScopeAdmitted(f.root, 'workspace', f.workspace.id)).toBe(true);
    // Inject retained link bytes after boot quarantine; global layout validation still refuses links.
    symlinkSync(outside, join(scope.contentMount.root, 'foreign-directory'), 'dir');
    const badRoot = join(f.root, 'workspaces', bad.id);
    const before = treeBytes(badRoot);
    const outsideBefore = treeBytes(outside);
    discardAbandonedWorkspaceStaging(f.root);
    expect(existsSync(privateGood.path)).toBe(false);
    expect(treeBytes(badRoot)).toEqual(before);
    expect(treeBytes(outside)).toEqual(outsideBefore);
  });

  it('replays an SQL-proven terminal body after cold reopen without another body or unchanged-parent barrier', async () => {
    const f = await fixture();
    const patch = { status: 'completed' as const, completedAt: f.turn.startedAt! };
    const publication = { items: [f.item] };
    const accepted = await f.store.completeTurn(f.turn.id, patch, publication);
    const retained = f.history();
    const events = f.store.getTurnEventsForExport(f.turn.id);
    const files = contentFiles(f.scope.contentMount.root);
    const originalBytes = new Map(files.map((path) => [path, readFileSync(path)]));
    const digests = new Set(
      [...originalBytes.values()].map((bytes) => createHash('sha256').update(bytes).digest('hex'))
    );
    const parents = new Set(files.map(dirname));
    await shutdownControlStoreWorkerClient();
    const cold = createTestStore({ dataRoot: f.root });
    // First-open ancestry preparation is distinct from a repeated retained-body publication barrier.
    await cold.updateThread(f.workspace.id, f.thread.id, { name: f.thread.name });
    f.arm(1);
    await expect(cold.completeTurn(f.turn.id, patch, publication)).resolves.toEqual(accepted);
    const rows = f.stop();
    const repeated = rows.filter(
      (row) =>
        ['sync', 'sync-failed'].includes(row.phase) &&
        ((row.kind === 'file' && digests.has(row.digest ?? '')) ||
          (row.kind === 'parent' && parents.has(row.path ?? '')))
    );
    // DX: only verified retained durability permits reuse; it must not repeat a successful barrier.
    expect(repeated).toEqual([]);
    expect(f.history()).toEqual(retained);
    expect(cold.getTurnEventsForExport(f.turn.id)).toEqual(events);
    for (const [path, bytes] of originalBytes) expect(readFileSync(path)).toEqual(bytes);
    await shutdownControlStoreWorkerClient();
    expect(createTestStore({ dataRoot: f.root }).getTurnById(f.turn.id)).toEqual(accepted);
  });

  it('overlaps the new file barriers of one real terminal tuple and synchronizes each changed parent once', async () => {
    const f = await fixture();
    const second = ItemSchema.parse({
      ...f.item,
      id: allocateEntityId('it'),
      text: 'Second terminal body'.repeat(3_500),
    });
    const before = new Set(contentFiles(f.scope.contentMount.root));
    f.arm(3);
    const accepted = await f.store.completeTurn(
      f.turn.id,
      { status: 'completed', completedAt: f.turn.startedAt! },
      { items: [f.item, second] }
    );
    const rows = f.stop();
    const paths = contentFiles(f.scope.contentMount.root).filter((path) => !before.has(path));
    // The actual producer creates these two complete Items and its one final terminal event.
    expect(accepted.items).toEqual([f.item, second]);
    expect(f.store.getTurnEventsForExport(f.turn.id)).toHaveLength(1);
    expect(paths).toHaveLength(3);
    const digests = new Set(
      paths.map((path) => createHash('sha256').update(readFileSync(path)).digest('hex'))
    );
    const successes = rows.filter(
      (row) => row.phase === 'sync' && row.kind === 'file' && digests.has(row.digest ?? '')
    );
    const starts = rows.filter(
      (row) => row.phase === 'sync-start' && row.kind === 'file' && digests.has(row.digest ?? '')
    );
    // DX parallel-cohort rule permits bounded concurrency below the total cohort size.
    expect(successes).toHaveLength(3);
    expect(starts).toHaveLength(3);
    for (const digest of digests) {
      expect(successes.filter((row) => row.digest === digest)).toHaveLength(1);
      expect(successes.find((row) => row.digest === digest)!.where).toBe('worker');
    }
    expect(
      starts.filter((row) => rows.indexOf(row) < rows.indexOf(successes[0]!)).length
    ).toBeGreaterThanOrEqual(2);
    const begin = rows.findIndex(
      (row) => row.phase === 'sql-before' && /^BEGIN\b/i.test(row.sql ?? '')
    );
    const commit = rows.findIndex(
      (row) => row.phase === 'sql-after' && /^COMMIT$/i.test(row.sql ?? '')
    );
    const ack = rows.findIndex(
      (row) => row.phase === 'ack' && row.status === 'ok' && row.operation !== 'open'
    );
    const lastFile = Math.max(...successes.map((row) => rows.indexOf(row)));
    // Directory layout is selected by the content owner; the rule applies once to each actual parent.
    for (const parent of new Set(paths.map(dirname))) {
      const syncs = rows.filter(
        (row) => row.phase === 'sync' && row.kind === 'parent' && row.path === parent
      );
      expect(syncs).toHaveLength(1);
      expect(syncs[0]!.where).toBe('worker');
      expect(rows.indexOf(syncs[0]!)).toBeGreaterThan(lastFile);
      expect(rows.indexOf(syncs[0]!)).toBeLessThan(begin);
    }
    expect(begin).toBeGreaterThan(lastFile);
    expect(commit).toBeGreaterThan(begin);
    expect(ack).toBeGreaterThan(commit);
    const retained = f.history();
    await shutdownControlStoreWorkerClient();
    expect(createTestStore({ dataRoot: f.root }).getTurnById(f.turn.id)).toEqual(accepted);
    expect(f.history()).toEqual(retained);
  });
});

it('publishes warm and cold nonterminal revisions of SQL-proven bytes without another content barrier', async () => {
  const f = await fixture();
  await f.store.createItem(f.item);
  const path = bodyFor(f.scope.contentMount.root, f.item.id);
  const bytes = readFileSync(path);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const original = f.history();
  expect(original.map((entry) => entry.revision)).toEqual([1]);
  let store = f.store;
  for (const cold of [false, true]) {
    if (cold) {
      await shutdownControlStoreWorkerClient();
      store = createTestStore({ dataRoot: f.root });
      f.arm();
      await store.updateThread(f.workspace.id, f.thread.id, { name: f.thread.name });
      const preparation = f.stop();
      // Scope ancestry preparation cannot turn accepted body bytes into a new first publication.
      expect(
        preparation.filter(
          (row) =>
            ['sync', 'sync-failed'].includes(row.phase) &&
            row.kind === 'file' &&
            row.digest === digest
        )
      ).toEqual([]);
    }
    f.arm(1);
    await expect(store.updateItem(f.item.id, {})).resolves.toEqual(f.item);
    const rows = f.stop();
    // DX pipeline: a new SQL reference reuses the completed barrier, including after cold reopen.
    expect(
      rows.filter(
        (row) =>
          ['sync', 'sync-failed'].includes(row.phase) &&
          ((row.kind === 'file' && row.digest === digest) ||
            (row.kind === 'parent' && row.path === dirname(path)))
      )
    ).toEqual([]);
    const retained = f.history();
    expect(retained.map((entry) => entry.revision)).toEqual(cold ? [1, 2, 3] : [1, 2]);
    expect(retained.map((entry) => entry.value)).toEqual(
      Array.from({ length: cold ? 3 : 2 }, () => original[0]!.value)
    );
    expect(bodyFor(f.scope.contentMount.root, f.item.id)).toBe(path);
    expect(readFileSync(path)).toEqual(bytes);
  }
  const retained = f.history();
  const turn = structuredClone(store.getTurnById(f.turn.id));
  await shutdownControlStoreWorkerClient();
  expect(createTestStore({ dataRoot: f.root }).getTurnById(f.turn.id)).toEqual(turn);
  expect(f.history()).toEqual(retained);
  expect(readFileSync(path)).toEqual(bytes);
});

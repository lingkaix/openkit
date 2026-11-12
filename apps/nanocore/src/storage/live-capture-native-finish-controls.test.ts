// openkit-test-platform: posix
/** Storage65 and Workspace backup: native finish preserves cold admission, uncertainty and first-terminal truth. */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { allocateEntityId } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { requireAdministratorOperation } from '../auth/operation-authorizer.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceReadDb } from './db.js';
import { readDataRootLayoutMarker, workspaceDbPath } from './fs-layout.js';
import { createWorkspaceBackup, WORKSPACE_BACKUP_POLICY } from './workspace-backup.js';
import { withVerifiedWorkspaceSnapshotSource } from './workspace-backup-bundle.js';
import { inspectCapture, type WorkspaceCaptureRecord } from './workspace-capture-protection.js';

type Frame = { worker: NativeWorker; message: Record<string, unknown>; order: number };
const probe = vi.hoisted(() => ({
  selected: undefined as
    | undefined
    | { path: string; captureId: string; gate: SharedArrayBuffer; holdFinish: boolean },
  order: 0,
  phase: '',
  onDrain: undefined as undefined | ((paths: readonly string[]) => void),
  posts: [] as Frame[],
  replies: [] as Frame[],
  events: [] as Record<string, unknown>[],
  errors: [] as string[],
  asynchronous: [] as Promise<unknown>[],
  onPhase: undefined as undefined | ((phase: string) => Promise<void>),
  onFinish: undefined as
    | undefined
    | ((worker: NativeWorker, event: Record<string, unknown>) => Promise<void>),
  onReply: undefined as undefined | ((request: Frame, reply: Frame) => void),
}));

// Reuse the existing capture/Native Worker seam. Each original entry, request, SQL run and reply is forwarded once.
// The sole SQL hold is after the real selected UPDATE and before its actual owning COMMIT.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        const selected = probe.selected;
        if (!selected) {
          super(filename, options);
          return;
        }
        const role = String(filename).includes('workspace-backup-worker') ? 'capture' : 'native';
        const prelude = String.raw`
        const threads = require('node:worker_threads');
        const facts = threads.workerData.__finishControl;
        delete threads.workerData.__finishControl;
        const fs = require('node:fs');
        const Driver = require(facts.sqliteModule);
        const post = threads.parentPort.postMessage.bind(threads.parentPort);
        const gate = new Int32Array(facts.gate);
        const calibration = new Driver(':memory:');
        const statement = calibration.prepare('SELECT 1');
        const prototype = Object.getPrototypeOf(statement), run = prototype.run;
        const pragma = Driver.prototype.pragma;
        prototype.run = function(...values) {
          const result = run.apply(this, values), db = this.database;
          if (facts.role === 'native' && db.name === facts.path && values[0] === 'finished' &&
              values[2] === facts.captureId && /UPDATE\s+workspace_capture_records\s+SET\s+state/i.test(this.source)) {
            const metadata = fs.statSync(db.name);
            post({__finishControl: true, kind: 'actual-native-finish-update', path: db.name,
              captureId: values[2], workspaceId: values[3], state: values[0], changes: result.changes,
              inode: metadata.dev + ':' + metadata.ino, readonly: db.readonly,
              synchronous: pragma.call(db, 'synchronous', {simple:true}), inTransaction: db.inTransaction,
              threadId: threads.threadId, isMainThread: threads.isMainThread});
            if (facts.holdFinish) Atomics.wait(gate, 0, 0);
          }
          return result;
        };
        calibration.close();
      `;
        const entry = options?.eval
          ? String(filename)
          : `import(${JSON.stringify(String(filename))});`;
        const source = prelude + '\n' + entry;
        super(source, {
          ...options,
          eval: true,
          workerData: {
            ...options?.workerData,
            __finishControl: {
              ...selected,
              role,
              sqliteModule: createRequire(import.meta.url).resolve('better-sqlite3'),
            },
          },
        });
        probe.events.push({
          kind: 'constructed-worker',
          role,
          entryWrapperSha256: createHash('sha256').update(entry).digest('hex'),
          constructedBootstrapSha256: createHash('sha256').update(source).digest('hex'),
        });
      }
      override postMessage(...args: Parameters<NativeWorker['postMessage']>): void {
        probe.posts.push({
          worker: this,
          message: args[0] as Record<string, unknown>,
          order: ++probe.order,
        });
        super.postMessage(...args);
      }
      override emit(event: string | symbol, ...args: unknown[]): boolean {
        const value = args[0];
        if (event === 'message' && typeof value === 'object' && value !== null) {
          const message = value as Record<string, unknown>;
          if (message.__finishControl) {
            probe.events.push({ ...message, order: ++probe.order });
            const action = probe.onFinish?.(this, message);
            if (action)
              probe.asynchronous.push(
                action.catch((error) => {
                  probe.errors.push(String(error));
                })
              );
            return true;
          }
          if (typeof message.phase === 'string') {
            probe.phase = message.phase;
            probe.events.push({ kind: 'phase', phase: message.phase, order: ++probe.order });
            const boundary = probe.onPhase?.(message.phase);
            if (boundary) {
              probe.asynchronous.push(
                boundary
                  .catch((error) => {
                    probe.errors.push(String(error));
                  })
                  .then(() => {
                    super.emit(event, ...args);
                  })
              );
              return true;
            }
          }
          if (message.status === 'ok' || message.status === 'error') {
            const reply = { worker: this, message, order: ++probe.order };
            probe.replies.push(reply);
            const request = probe.posts.find(
              (row) => row.worker === this && row.message.id === message.id
            );
            if (request) probe.onReply?.(request, reply);
          }
        }
        return super.emit(event, ...args);
      }
    },
  };
});
// A call-through notification witnesses the real tracked-reader drain, not a fabricated close barrier.
vi.mock('./control-store-product-records.js', async (load) => {
  const actual = await load<typeof import('./control-store-product-records.js')>();
  return {
    ...actual,
    drainMainScopeReadHandles: (paths: readonly string[]) => {
      const result = actual.drainMainScopeReadHandles(paths);
      probe.onDrain?.(paths);
      return result;
    },
  };
});
const roots: string[] = [];
const handles: Array<{ sqlite: Database.Database }> = [];
afterEach(async () => {
  if (probe.selected) {
    const gate = new Int32Array(probe.selected.gate);
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
  }
  for (const task of probe.asynchronous) await task;
  probe.onPhase = undefined;
  probe.onFinish = undefined;
  probe.onReply = undefined;
  probe.onDrain = undefined;
  for (const handle of handles.splice(0)) if (handle.sqlite.open) handle.sqlite.close();
  try {
    await shutdownControlStoreWorkerClient();
  } finally {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }
  probe.selected = undefined;
  probe.order = 0;
  probe.posts = [];
  probe.replies = [];
  probe.events = [];
  probe.errors = [];
  probe.asynchronous = [];
});
function posts(operation: string, database: string) {
  return probe.posts.filter(
    (row) => row.message.operation === operation && row.message.database === database
  );
}
function terminal(operation: string, database: string) {
  return posts(operation, database).flatMap((request) =>
    probe.replies
      .filter((reply) => reply.worker === request.worker && reply.message.id === request.message.id)
      .map((reply) => ({ request, reply }))
  );
}
function acks(operation: string, database: string) {
  return terminal(operation, database).filter((row) => row.reply.message.status === 'ok');
}
function selectedCapture(dataRoot: string, captureId: string): WorkspaceCaptureRecord | null {
  const reader = openWorkspaceReadDb(dataRoot, DEMO_WORKSPACE_ID);
  try {
    return inspectCapture(reader, DEMO_WORKSPACE_ID, captureId);
  } finally {
    reader.sqlite.close();
  }
}
function requirePin(value: WorkspaceCaptureRecord | null): WorkspaceCaptureRecord {
  if (!value) throw new Error('The actual original capture pin was not observed.');
  return value;
}
function retainedRows(path: string) {
  const sqlite = new Database(path, { readonly: true, fileMustExist: true });
  try {
    sqlite.pragma('query_only = ON');
    const rows: Record<string, unknown[]> = {};
    for (const table of [
      'control_workspaces',
      'control_threads',
      'control_turns',
      'control_product_entries',
      'idempotency_requests',
      'audit_events',
      'pending_requests',
      '__drizzle_migrations',
    ]) {
      rows[table] = sqlite
        .prepare(`SELECT * FROM "${table}"`)
        .all()
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    rows.sqlite_schema = sqlite
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"
      )
      .all();
    return rows;
  } finally {
    sqlite.close();
  }
}
async function fixture(holdFinish = false) {
  const root = mkdtempSync(join(tmpdir(), 'q06-native-finish-controls-'));
  roots.push(root);
  const dataRoot = join(root, 'source'),
    captureId = allocateEntityId('wsbak'),
    path = workspaceDbPath(dataRoot, DEMO_WORKSPACE_ID),
    gate = new SharedArrayBuffer(4);
  probe.selected = { path, captureId, gate, holdFinish };
  const store = await createDemoStore({ dataRoot, knowledge: [] }),
    core = openCoreDb(dataRoot);
  handles.push(core);
  const ownerId = ensureLocalUser(core),
    actor = { kind: 'local' as const, userId: ownerId };
  recordWorkspaceOwnerMembership({
    coreDb: core,
    workspaceId: DEMO_WORKSPACE_ID,
    ownerUserId: ownerId,
  });
  const thread = await store.createThread(
    DEMO_WORKSPACE_ID,
    'Original native finish control history'
  );
  const turn = await store.createTurn(DEMO_WORKSPACE_ID, thread.id, 'Retained source input', {
    kind: 'user',
    id: ownerId,
  });
  await store.completeTurn(turn.id, { status: 'completed', completedAt: new Date().toISOString() });
  const mutationAdmission = new WorkspaceMutationAdmission(),
    client = getControlStoreWorkerClient(mutationAdmission),
    database = `workspace:${path}`;
  const stagingParent = join(root, 'staging');
  mkdirSync(stagingParent);
  const policy = {
    ...WORKSPACE_BACKUP_POLICY,
    stagingParent,
    admission: new FileStorageAdmission(root, () => 0n),
    expectedRelease: {
      version: '0.1.0-q06-controls',
      buildId: 'independent-native-finish-controls',
    },
  };
  const authorityFault = new Error('Actual post-acknowledgement capture authority loss');
  let authorityLost = false;
  const input = {
    ...policy,
    workspaceId: DEMO_WORKSPACE_ID,
    backupId: captureId,
    purpose: 'backup' as const,
    expectedSourceDeploymentId: readDataRootLayoutMarker(dataRoot).deploymentId,
    bundleRoot: join(dataRoot, 'server/backups/workspaces', DEMO_WORKSPACE_ID, captureId),
    source: {
      kind: 'live-workspace' as const,
      dataRoot,
      coreDb: core,
      store,
      mutationAdmission,
      actor,
      currentAuthority: () => {
        requireAdministratorOperation(core, actor, 'api.call');
        if (authorityLost) throw authorityFault;
      },
    },
  };
  const metadata = statSync(path),
    inode = `${metadata.dev}:${metadata.ino}`;
  return {
    root,
    dataRoot,
    captureId,
    path,
    database,
    store,
    core,
    thread,
    turn,
    mutationAdmission,
    client,
    input,
    policy,
    inode,
    authorityFault,
    loseAuthority: () => {
      authorityLost = true;
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function verifyRetainedSeal(
  f: Fixture,
  before: ReturnType<typeof retainedRows>,
  pinned: WorkspaceCaptureRecord
) {
  expect(existsSync(join(f.input.bundleRoot, 'seal.json'))).toBe(true);
  await withVerifiedWorkspaceSnapshotSource(
    {
      ...f.policy,
      dataRoot: f.dataRoot,
      source: { kind: 'local-snapshot', workspaceId: DEMO_WORKSPACE_ID, backupId: f.captureId },
    },
    async (bundle) => {
      const parts: Buffer[] = [];
      for await (const part of bundle.readFile('db/workspace.sqlite'))
        parts.push(Buffer.from(part));
      const copy = join(f.root, 'verified-captured.sqlite');
      writeFileSync(copy, Buffer.concat(parts));
      expect(retainedRows(copy)).toEqual(before);
      const sqlite = new Database(copy, { readonly: true, fileMustExist: true });
      try {
        expect(
          sqlite
            .prepare(
              'SELECT capture_id,workspace_id,state,created_at,ended_at FROM workspace_capture_records WHERE capture_id=?'
            )
            .get(f.captureId)
        ).toEqual({
          capture_id: f.captureId,
          workspace_id: DEMO_WORKSPACE_ID,
          state: 'active',
          created_at: pinned.createdAt,
          ended_at: null,
        });
      } finally {
        sqlite.close();
      }
    }
  );
  const manifest = JSON.parse(readFileSync(join(f.input.bundleRoot, 'manifest.json'), 'utf8')) as {
    capture: { startedAt: string };
  };
  expect(manifest.capture.startedAt).toBe(pinned.createdAt);
}
function sealedMetadata(f: Fixture) {
  return Object.fromEntries(
    ['manifest.json', 'seal.json'].map((name) => [
      name,
      createHash('sha256')
        .update(readFileSync(join(f.input.bundleRoot, name)))
        .digest('hex'),
    ])
  );
}
function finishTuple(f: Fixture) {
  const events = probe.events.filter((row) => row.kind === 'actual-native-finish-update');
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    path: f.path,
    inode: f.inode,
    captureId: f.captureId,
    workspaceId: DEMO_WORKSPACE_ID,
    state: 'finished',
    changes: 1,
    readonly: false,
    synchronous: 2,
    inTransaction: true,
    isMainThread: false,
  });
}
function report(name: string, facts: Record<string, unknown>) {
  process.stderr.write(
    `${JSON.stringify({ nativeCaptureFinishControl: { name, ...facts, events: probe.events, posts: probe.posts.map(({ message, order }) => ({ message, order })), replies: probe.replies.map(({ message, order }) => ({ message, order })), errors: probe.errors } })}\n`
  );
}

it('opens the genuinely cold existing Workspace native owner before acknowledging the original sealed capture finish', async () => {
  const f = await fixture(),
    before = retainedRows(f.path);
  await f.client.close(f.database);
  const closed = acks('close', f.database);
  expect(closed).toHaveLength(1);
  const previousOffers = posts('open', f.database).length;
  let pinned: WorkspaceCaptureRecord | null = null,
    finishBoundary = 0;
  let sealedBefore: ReturnType<typeof sealedMetadata> | undefined;
  probe.onPhase = async (phase) => {
    if (phase === 'pin-end') pinned = selectedCapture(f.dataRoot, f.captureId);
    if (phase === 'finish') {
      expect(existsSync(join(f.input.bundleRoot, 'seal.json'))).toBe(true);
      expect(posts('open', f.database)).toHaveLength(previousOffers);
      expect(f.mutationAdmission.isClosed(DEMO_WORKSPACE_ID)).toBe(false);
      sealedBefore = sealedMetadata(f);
      finishBoundary = ++probe.order;
    }
  };
  const result = await createWorkspaceBackup(f.input);
  expect(probe.errors).toEqual([]);
  expect(result).toMatchObject({ disposition: 'sealed', purpose: 'backup' });
  expect(pinned).toMatchObject({ captureId: f.captureId, state: 'active', endedAt: null });
  const offered = posts('open', f.database).slice(previousOffers),
    opened = acks('open', f.database).filter((row) => row.request.order > finishBoundary);
  expect(offered).toHaveLength(1);
  expect(offered[0]!.message).toMatchObject({
    path: f.path,
    create: false,
    initialize: 'workspace',
  });
  expect(offered[0]!.order).toBeGreaterThan(finishBoundary);
  expect(opened).toHaveLength(1);
  const finished = acks('recovery-capture', f.database);
  expect(finished).toHaveLength(1);
  expect(finished[0]!.request.order).toBeGreaterThan(opened[0]!.reply.order);
  finishTuple(f);
  expect(selectedCapture(f.dataRoot, f.captureId)).toEqual({
    ...requirePin(pinned),
    state: 'finished',
    endedAt: expect.any(String),
  });
  expect(retainedRows(f.path)).toEqual(before);
  expect(sealedBefore).toBeDefined();
  expect(sealedMetadata(f)).toEqual(sealedBefore);
  await verifyRetainedSeal(f, before, requirePin(pinned));
  report('cold-existing-native-owner', {
    originalCloseAck: closed[0]!.reply.order,
    finishBoundary,
    actualOpenAck: opened[0]!.reply.order,
    actualFinishAck: finished[0]!.reply.order,
  });
});

it('retains the genuine seal and reports unknown after a posted native finish loses its real Worker while retained truth is still active', async () => {
  const f = await fixture(true),
    before = retainedRows(f.path);
  let pinned: WorkspaceCaptureRecord | null = null,
    activeDuringUnknown: WorkspaceCaptureRecord | null = null,
    joinedExit: number | undefined;
  let sealedBefore: ReturnType<typeof sealedMetadata> | undefined;
  probe.onPhase = async (phase) => {
    if (phase === 'pin-end') pinned = selectedCapture(f.dataRoot, f.captureId);
    if (phase === 'finish') sealedBefore = sealedMetadata(f);
  };
  probe.onFinish = async (worker, event) => {
    try {
      expect(event).toMatchObject({
        path: f.path,
        captureId: f.captureId,
        changes: 1,
        inTransaction: true,
      });
      expect(sealedBefore).toBeDefined();
      expect(sealedMetadata(f)).toEqual(sealedBefore);
      expect(posts('recovery-capture', f.database)).toHaveLength(1);
      expect(acks('recovery-capture', f.database)).toHaveLength(0);
      activeDuringUnknown = selectedCapture(f.dataRoot, f.captureId);
      expect(activeDuringUnknown).toEqual(pinned);
    } finally {
      joinedExit = await worker.terminate(); // Genuine owner exit loses the covering reply; no success/error ACK is synthesized.
    }
  };
  const outcome = await createWorkspaceBackup(f.input).then(
    (value) => ({ value }),
    (error) => ({ error: error as unknown })
  );
  await Promise.all(probe.asynchronous);
  report('posted-finish-worker-loss', {
    joinedExit,
    activeDuringUnknown,
    sealRetained: existsSync(join(f.input.bundleRoot, 'seal.json')),
    outcome:
      'error' in outcome
        ? { error: String(outcome.error), commit: (outcome.error as { commit?: unknown })?.commit }
        : outcome,
  });
  expect(probe.errors).toEqual([]);
  expect(joinedExit).toBeTypeOf('number');
  expect(activeDuringUnknown).toMatchObject({ state: 'active', endedAt: null });
  expect(outcome).toHaveProperty('error');
  if (!('error' in outcome)) throw new Error('Unknown posted finish returned success.');
  expect(outcome.error).toBeInstanceOf(ControlStoreWorkerError);
  expect(outcome.error).toMatchObject({ commit: 'unknown' });
  expect(acks('recovery-capture', f.database)).toHaveLength(0);
  finishTuple(f);
  expect(selectedCapture(f.dataRoot, f.captureId)).toEqual(pinned);
  expect(retainedRows(f.path)).toEqual(before);
  expect(sealedBefore).toBeDefined();
  expect(sealedMetadata(f)).toEqual(sealedBefore);
  await verifyRetainedSeal(f, before, requirePin(pinned));
});

it('keeps the exact sealed generation but rejects the operation when current authority is lost after the real native finish ACK', async () => {
  const f = await fixture(),
    before = retainedRows(f.path);
  let pinned: WorkspaceCaptureRecord | null = null,
    acknowledged = 0;
  let sealedBefore: ReturnType<typeof sealedMetadata> | undefined;
  probe.onPhase = async (phase) => {
    if (phase === 'pin-end') pinned = selectedCapture(f.dataRoot, f.captureId);
    if (phase === 'finish') sealedBefore = sealedMetadata(f);
  };
  probe.onReply = (request, reply) => {
    const input = request.message.input as { captureId?: unknown; state?: unknown } | undefined;
    if (
      request.message.operation === 'recovery-capture' &&
      input?.captureId === f.captureId &&
      input.state === 'finished' &&
      reply.message.status === 'ok'
    ) {
      acknowledged = reply.order;
      f.loseAuthority();
    }
  };
  const outcome = await createWorkspaceBackup(f.input).then(
    (value) => ({ value }),
    (error) => ({ error: error as unknown })
  );
  expect(probe.errors).toEqual([]);
  expect(acknowledged).toBeGreaterThan(0);
  expect(outcome).toEqual({ error: f.authorityFault });
  finishTuple(f);
  expect(selectedCapture(f.dataRoot, f.captureId)).toEqual({
    ...requirePin(pinned),
    state: 'finished',
    endedAt: expect.any(String),
  });
  expect(retainedRows(f.path)).toEqual(before);
  expect(sealedBefore).toBeDefined();
  expect(sealedMetadata(f)).toEqual(sealedBefore);
  await verifyRetainedSeal(f, before, requirePin(pinned));
  report('authority-loss-after-covering-ack', {
    acknowledged,
    sealRetained: true,
    retainedDecision: selectedCapture(f.dataRoot, f.captureId),
  });
});

it('removes the seal only after a genuine acknowledged abandon and the conflicting finish is proved not committed', async () => {
  const f = await fixture(),
    before = retainedRows(f.path);
  let abandoned: WorkspaceCaptureRecord | null = null;
  probe.onPhase = async (phase) => {
    if (phase !== 'finish') return;
    expect(existsSync(join(f.input.bundleRoot, 'seal.json'))).toBe(true);
    await f.client.recoveryCapture(f.database, {
      workspaceId: DEMO_WORKSPACE_ID,
      captureId: f.captureId,
      state: 'abandoned',
    });
    abandoned = selectedCapture(f.dataRoot, f.captureId);
    expect(abandoned).toMatchObject({ state: 'abandoned', endedAt: expect.any(String) });
  };
  const outcome = await createWorkspaceBackup(f.input).then(
    (value) => ({ value }),
    (error) => ({ error: error as unknown })
  );
  expect(probe.errors).toEqual([]);
  expect(abandoned).not.toBeNull();
  const all = terminal('recovery-capture', f.database),
    abandon = all.filter(
      (row) => (row.request.message.input as { state?: unknown }).state === 'abandoned'
    ),
    finish = all.filter(
      (row) => (row.request.message.input as { state?: unknown }).state === 'finished'
    );
  expect(abandon).toHaveLength(1);
  expect(abandon[0]!.reply.message.status).toBe('ok');
  expect(finish).toHaveLength(1);
  expect(finish[0]!.request.order).toBeGreaterThan(abandon[0]!.reply.order);
  expect(finish[0]!.reply.message).toMatchObject({ status: 'error', commit: 'not-committed' });
  expect(outcome).toHaveProperty('error');
  if (!('error' in outcome)) throw new Error('Conflicting finished decision returned success.');
  expect(outcome.error).toBeInstanceOf(ControlStoreWorkerError);
  expect(outcome.error).toMatchObject({ commit: 'not-committed' });
  expect(selectedCapture(f.dataRoot, f.captureId)).toEqual(abandoned);
  expect(retainedRows(f.path)).toEqual(before);
  expect(existsSync(join(f.input.bundleRoot, 'seal.json'))).toBe(false);
  expect(probe.events.filter((row) => row.kind === 'actual-native-finish-update')).toHaveLength(0);
  report('proved-noncommit-after-native-abandon', {
    abandoned,
    finishReply: finish[0]!.reply.message,
    sealRetained: false,
  });
});

it('removes an unfinished seal when actual Workspace retirement refuses OPEN before any finish is posted', async () => {
  const f = await fixture(),
    before = retainedRows(f.path),
    previousOffers = posts('open', f.database).length;
  let pinned: WorkspaceCaptureRecord | null = null;
  let held: ReturnType<typeof openWorkspaceReadDb> | undefined, closing: Promise<void> | undefined;
  let reachedDrain = false;
  probe.onPhase = async (phase) => {
    if (phase === 'pin-end') pinned = selectedCapture(f.dataRoot, f.captureId);
    if (phase !== 'finish') return;
    expect(existsSync(join(f.input.bundleRoot, 'seal.json'))).toBe(true);
    held = openWorkspaceReadDb(f.dataRoot, DEMO_WORKSPACE_ID);
    handles.push(held);
    expect(held.sqlite.readonly).toBe(true);
    expect(held.sqlite.pragma('query_only', { simple: true })).toBe(1);
    expect(inspectCapture(held, DEMO_WORKSPACE_ID, f.captureId)).toEqual(requirePin(pinned));
    const drained = new Promise<void>((resolve) => {
      probe.onDrain = (paths) => {
        if (paths.includes(f.path)) {
          reachedDrain = true;
          resolve();
        }
      };
    });
    closing = f.client.close(f.database);
    await drained;
    expect(held.sqlite.open).toBe(true);
    expect(posts('close', f.database)).toHaveLength(0);
  };
  const outcome = await createWorkspaceBackup(f.input).then(
    (value) => ({ value }),
    (error) => ({ error: error as unknown })
  );
  try {
    report('unposted-finish-refused-by-real-retirement', {
      reachedDrain,
      readerStillOpen: held?.sqlite.open,
      extraNativeOpenOffers: posts('open', f.database).length - previousOffers,
      nativeFinishOffers: posts('recovery-capture', f.database).length,
      sealRetained: existsSync(join(f.input.bundleRoot, 'seal.json')),
      retainedDecision: held ? inspectCapture(held, DEMO_WORKSPACE_ID, f.captureId) : null,
      error:
        'error' in outcome
          ? {
              text: String(outcome.error),
              code: (outcome.error as { code?: unknown })?.code,
              commit: (outcome.error as { commit?: unknown })?.commit,
            }
          : null,
    });
    expect(probe.errors).toEqual([]);
    expect(reachedDrain).toBe(true);
    expect(closing).toBeDefined();
    expect(held?.sqlite.open).toBe(true);
    expect(outcome).toHaveProperty('error');
    if (!('error' in outcome))
      throw new Error('The actual retiring Workspace admitted a later finish.');
    expect(outcome.error).toBeInstanceOf(ControlStoreWorkerError);
    expect(outcome.error).toMatchObject({ code: 'busy', commit: 'not-committed' });
    expect(posts('open', f.database)).toHaveLength(previousOffers);
    expect(posts('recovery-capture', f.database)).toHaveLength(0);
    expect(probe.events.filter((row) => row.kind === 'actual-native-finish-update')).toHaveLength(
      0
    );
    expect(acks('close', f.database)).toHaveLength(0);
    expect(inspectCapture(held!, DEMO_WORKSPACE_ID, f.captureId)).toEqual(requirePin(pinned));
    expect(retainedRows(f.path)).toEqual(before);
    expect(existsSync(join(f.input.bundleRoot, 'seal.json'))).toBe(false);
  } finally {
    probe.onDrain = undefined;
    if (held?.sqlite.open) held.sqlite.close();
    if (closing) await closing;
  }
  expect(acks('close', f.database)).toHaveLength(1);
  expect(held?.sqlite.open).toBe(false);
});

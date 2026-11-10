import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { expect, it, onTestFinished, vi } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import { verifyOpenKitAccessTokenRecord } from '../auth/access-token-verification.js';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { KnowledgeNotebook } from '../knowledge/notebook.js';
import {
  initializeScopedNotebook,
  resolveScopedNotebookOwner,
} from '../knowledge/scoped-notebook-owner.js';
import {
  publishScopedNotebook,
  readScopedNotebookHistory,
} from '../knowledge/scoped-notebook-publication.js';
import { FsStore } from '../lib/store.js';
import { commandInputHash, type InflightIdempotentCommand } from '../runtime/idempotent-command.js';
import { serializeKnowledgePageFixture } from '../test-support/knowledge-page.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { openCoreDb, openUserDb, openWorkspaceDb } from './db.js';
import { coreDbPath, userDbPath } from './fs-layout.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';
import { nativeProductScope } from './workspace-file-records.js';

// Native storage integration tests for scoped Notebook publication.
// Accepted owners: Core Storage, Physical Database Ownership; Notebook Editing, Implementation Cutover And Acceptance.
// Observe the actual SQLite COMMIT because a returned rejection cannot identify its durable prefix.
const faults = vi.hoisted(() => ({
  workers: [] as NativeWorker[],
  readOnlyMain: false,
  maintenanceDatabase: undefined as string | undefined,
  maintenanceCommand: undefined as string | undefined,
  gate: new SharedArrayBuffer(6 * Int32Array.BYTES_PER_ELEMENT),
  request: new SharedArrayBuffer(36),
  open: undefined as undefined | { reached: () => void; deliver?: () => void },
  messages: [] as Array<{
    id?: number;
    operation?: string;
    database?: string;
    workerIndex?: number;
  }>,
  replies: [] as Array<{
    id?: number;
    status?: string;
    code?: string;
    commit?: string;
    workerIndex: number;
  }>,
}));

vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        const index = faults.workers.length;
        // Keep the real native Worker, physical scope, SQL body, savepoint and FULL commit.
        const prelude = `
          const {workerData} = require('node:worker_threads');
          const Database = require(workerData.scopedSqlModule);
          const originalExec = Database.prototype.exec;
          const gate = workerData.scopedSqlGate;
          Database.prototype.exec = function(sql) {
            const result = originalExec.call(this, sql);
            if (!/^COMMIT$/i.test(sql) || Atomics.load(gate, 1) === 0) return result;
            const request = Buffer.from(workerData.scopedSqlRequest).toString('ascii');
            if (!this.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_events'").get()) return result;
            const rows = this.prepare('SELECT action FROM audit_events WHERE request_id=?').all(request);
            const receipts = this.prepare('SELECT request_id FROM idempotency_requests WHERE request_id=?').all(request);
            const admitted = rows.some(row => row.action === 'knowledge.notebook.admit');
            const completed = rows.some(row => row.action === 'knowledge.notebook.update');
            const initialized = rows.some(row => row.action === 'knowledge.notebook.initialize');
            const captured = rows.some(row => row.action === 'knowledge.source.register');
            const stage = Atomics.load(gate, 1);
            const selected = (stage === 1 && admitted && !completed && receipts.length === 0)
              || (stage === 2 && admitted && completed && receipts.length === 0)
              || (stage === 3 && admitted && completed && receipts.length === 1)
              || (stage === 4 && admitted && !initialized && receipts.length === 0)
              || (stage === 5 && admitted && initialized && receipts.length === 0)
              || (stage === 6 && admitted && !captured && receipts.length === 0)
              || (stage === 7 && admitted && captured && receipts.length === 0)
              || (stage === 8 && captured && receipts.length === 1)
              || ((stage === 9 || (stage === 10 && Atomics.load(gate, 3) === 1)) && this.prepare("SELECT 1 FROM idempotency_requests WHERE request_id=? AND command_name IN ('knowledge.maintain','knowledge.tell')").get(request));
            if (selected && Atomics.compareExchange(gate, 0, 0, 1) === 0) {
              Atomics.store(gate, 4, this.pragma('synchronous', {simple:true}));
              Atomics.store(gate, 5, workerData.scopedSqlWorkerIndex);
              Atomics.wait(gate, 2, 0);
            }
            return result;
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
            scopedSqlModule: require.resolve('better-sqlite3'),
            scopedSqlGate: new Int32Array(faults.gate),
            scopedSqlRequest: new Uint8Array(faults.request),
            scopedSqlWorkerIndex: index,
          },
        });
        faults.workers.push(this);
      }
      override postMessage(...args: Parameters<NativeWorker['postMessage']>) {
        faults.messages.push({ ...args[0], workerIndex: faults.workers.indexOf(this) });
        const posted = args[0] as {
          operation?: string;
          database?: string;
          input?: { action?: string; command?: string };
        };
        if (
          posted.operation === 'scoped-notebook-sql' &&
          posted.database === faults.maintenanceDatabase &&
          posted.input?.action === 'user-receipt-maintenance' &&
          posted.input.command === faults.maintenanceCommand
        )
          Atomics.store(new Int32Array(faults.gate), 3, 1);
        return super.postMessage(...args);
      }
      override emit(event: string | symbol, ...args: unknown[]): boolean {
        const reply = args[0];
        if (event === 'message' && reply && typeof reply === 'object' && 'id' in reply)
          faults.replies.push({ ...reply, workerIndex: faults.workers.indexOf(this) });
        const hold = faults.open;
        if (
          event === 'message' &&
          hold &&
          !hold.deliver &&
          reply &&
          typeof reply === 'object' &&
          'operation' in reply &&
          reply.operation === 'open'
        ) {
          hold.deliver = () => super.emit(event, ...args);
          hold.reached();
          return true;
        }
        return super.emit(event, ...args);
      }
    },
  };
});

// Protect newly opened public-operation connections too; Worker connections load the actual module in their own isolate.
vi.mock('./db.js', async (load) => {
  const actual = await load<typeof import('./db.js')>();
  const protect = <T extends { sqlite: { pragma: (sql: string) => unknown } }>(db: T): T => {
    if (faults.readOnlyMain) db.sqlite.pragma('query_only = ON');
    return db;
  };
  return {
    ...actual,
    openCoreDb: (...args: Parameters<typeof actual.openCoreDb>) =>
      protect(actual.openCoreDb(...args)),
    openUserDb: (...args: Parameters<typeof actual.openUserDb>) =>
      protect(actual.openUserDb(...args)),
  };
});

type Kind = 'user' | 'server';

/** Release all fault holds before native drain and private-root removal, including assertion failures. */
function release() {
  const gate = new Int32Array(faults.gate);
  Atomics.store(gate, 1, 0);
  Atomics.store(gate, 2, 1);
  Atomics.notify(gate, 2);
  const open = faults.open;
  faults.open = undefined;
  open?.deliver?.();
}

/** Real canonical local identity, current bearer, scoped initialization and existing physical owners. */
async function fixture(kind: Kind, fresh = false) {
  release();
  faults.readOnlyMain = false;
  const root = mkdtempSync(join(tmpdir(), 'scoped-sql-native-'));
  const coreDb = openCoreDb(root);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const userDb = openUserDb(root, userId);
  applyScopedMigrations(userDb);
  const actor = { kind: 'local' as const, userId };
  const token = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: userId,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  const verified = await verifyOpenKitAccessTokenRecord(coreDb, token.secret);
  if (!verified) throw new Error('Fixture bearer must authenticate.');
  const administrator = {
    kind: 'token' as const,
    userId: verified.ownerUserId,
    tokenId: verified.tokenId,
    tokenScope: verified.scope,
  };
  const store = new FsStore({ dataRoot: root });
  const runtimeConfigManager = createRuntimeConfigManager({ dataRoot: root });
  const common = {
    coreDb,
    store,
    runtimeConfigManager,
    inflightCommands: new WeakMap<FsStore, Map<string, InflightIdempotentCommand>>(),
  };
  const input =
    kind === 'user'
      ? { ...common, actor, target: { kind: 'user' as const }, userDb }
      : { ...common, actor: administrator, target: { kind: 'server' as const } };
  const initialization = {
    requestId: randomUUID(),
    instructionReference: 'test:scoped-sql-native',
  };
  const initialize = () => initializeScopedNotebook({ ...input, initialization });
  const base = fresh ? '' : initialize();
  const owner = resolveScopedNotebookOwner(input);
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(owner.notebookRoot, 'notebook.git'),
  });
  const db = kind === 'user' ? userDb : coreDb;
  const client = getControlStoreWorkerClient();
  const database = `${kind === 'user' ? 'user' : 'core'}:${kind === 'user' ? userDbPath(root, userId) : coreDbPath(root)}`;
  if (kind === 'user')
    await client.open({
      database,
      path: userDbPath(root, userId),
      create: false,
      initialize: 'user',
    });
  else {
    const scope = nativeProductScope(root, { kind: 'server' });
    await client.open({
      database,
      path: scope.path,
      dataRoot: root,
      create: false,
      initialize: 'core',
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
  }
  onTestFinished(async () => {
    release();
    faults.readOnlyMain = false;
    vi.useRealTimers();
    vi.restoreAllMocks();
    await shutdownControlStoreWorkerClient();
    if (userDb.sqlite.open) userDb.sqlite.close();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  const request = {
    requestId: randomUUID(),
    baseRevision: base,
    changes: [
      {
        path: 'note.md',
        content: serializeKnowledgePageFixture(
          {
            title: 'Exact scoped bytes',
            content: 'Preserve exact scoped bytes.\r\n',
            sourceReferences: [],
            createdAt: '2026-10-17T00:00:00.000Z',
            updatedAt: '2026-10-17T00:00:00.000Z',
          },
          owner.ownerScope
        ),
      },
    ],
    summary: 'Save exact scoped bytes',
  };
  const rows = () => ({
    audits: db.sqlite
      .prepare(
        'SELECT action,notebook_admission_json AS evidence FROM audit_events WHERE request_id=? ORDER BY rowid'
      )
      .all(request.requestId),
    receipts: db.sqlite
      .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
      .all(request.requestId),
  });
  const queryOnly = () => {
    faults.readOnlyMain = true;
    for (const connection of [coreDb, userDb]) {
      connection.sqlite.pragma('query_only = ON');
      expect(connection.sqlite.pragma('query_only', { simple: true })).toBe(1);
    }
  };
  const revoke = () => {
    const revoker = openCoreDb(root);
    revoker.sqlite.pragma('query_only = OFF'); // Only the real authority-change owner remains writable during this fault.
    try {
      if (kind === 'user')
        revoker.sqlite.transaction(() => disableCanonicalUser(revoker, userId))();
      else revokeOpenKitAccessTokenRecord(revoker, administrator.tokenId);
    } finally {
      revoker.sqlite.close();
    }
  };
  return {
    root,
    coreDb,
    userDb,
    db,
    input,
    owner,
    notebook,
    base,
    initialize,
    initialization,
    request,
    rows,
    client,
    database,
    queryOnly,
    revoke,
  };
}

/** Start handling a rejection before the Worker can lose its actual reply. */
function observed<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error })
  );
}

/** Select an original SQL prefix without depending on the new typed family operation's name. */
async function held(
  f: Awaited<ReturnType<typeof fixture>>,
  stage: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10,
  start: () => Promise<unknown> = () => publishScopedNotebook(f.input, f.request)
) {
  const gate = new Int32Array(faults.gate);
  gate.fill(0);
  new Uint8Array(faults.request).set(new TextEncoder().encode(f.request.requestId));
  Atomics.store(gate, 1, stage);
  const result = observed(start());
  await vi.waitFor(() => expect(Atomics.load(gate, 0)).toBe(1), { timeout: 5000 });
  expect(Atomics.load(gate, 4)).toBe(2); // SQLite FULL, as in the existing native COMMIT fixture.
  return { gate, result };
}

it.each(['user', 'server'] as const)(
  'publishes and cold-replays exact %s bytes with actual Main connections query-only',
  async (kind) => {
    const f = await fixture(kind);
    f.queryOnly();
    const first = await publishScopedNotebook(f.input, f.request);
    expect(f.notebook.readRevision(first.notebookRevision).files['note.md']).toBe(
      f.request.changes[0]!.content
    );
    expect(first).toMatchObject({
      ownerScope: f.owner.ownerScope,
      baseRevision: f.base,
      receiptRef: {
        operation: 'knowledge.notebook.update',
        requestId: f.request.requestId,
        ownerScope: f.owner.ownerScope,
      },
    });
    const original = f.rows();
    expect(original.audits.map((row: any) => row.action)).toEqual([
      'knowledge.notebook.admit',
      'knowledge.notebook.update',
    ]);
    expect(original.receipts).toHaveLength(1);
    const receipt = f.input.store.getCommandRequest(
      'knowledge.notebook.update',
      f.request.requestId,
      kind === 'user'
        ? { userId: f.userDb.userId, actorId: f.input.actor.userId }
        : { coreId: 'server' as const, actorId: f.input.actor.userId },
      f.db
    )!;
    expect(receipt.inputHash).toBe(
      commandInputHash({ ...f.request, ownerScope: f.owner.ownerScope })
    );
    expect(receipt.response).toEqual({
      kind: 'knowledge_notebook_revision',
      id: first.notebookRevision,
    });
    await shutdownControlStoreWorkerClient();
    f.coreDb.sqlite.close();
    f.userDb.sqlite.close();
    const coldCore = openCoreDb(f.root);
    const coldUser = openUserDb(f.root, f.userDb.userId);
    onTestFinished(() => {
      if (coldCore.sqlite.open) coldCore.sqlite.close();
      if (coldUser.sqlite.open) coldUser.sqlite.close();
    });
    coldCore.sqlite.pragma('query_only = ON');
    coldUser.sqlite.pragma('query_only = ON');
    const cold = {
      ...f.input,
      coreDb: coldCore,
      ...(kind === 'user' ? { userDb: coldUser } : {}),
      store: new FsStore({ dataRoot: f.root }),
      inflightCommands: new WeakMap(),
    };
    await expect(publishScopedNotebook(cold, f.request)).resolves.toEqual(first);
    expect(readScopedNotebookHistory(cold).revisions[0]?.revision).toBe(first.notebookRevision);
    await expect(
      publishScopedNotebook(cold, { ...f.request, summary: 'Changed input' })
    ).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
    expect(
      cold.store.getCommandRequest(
        receipt.command,
        receipt.requestId,
        receipt.scope,
        kind === 'user' ? coldUser : coldCore
      )
    ).toEqual(receipt);
  }
);

it.each(['user', 'server'] as const)(
  'refuses %s admission SQL before Git and preserves no completion or receipt',
  async (kind) => {
    const f = await fixture(kind);
    f.db.sqlite.exec(
      "CREATE TRIGGER refuse_scoped_admit BEFORE INSERT ON audit_events WHEN NEW.action='knowledge.notebook.admit' BEGIN SELECT RAISE(ABORT,'scoped admission fault'); END"
    );
    f.queryOnly();
    await expect(publishScopedNotebook(f.input, f.request)).rejects.toMatchObject({
      commit: 'not-committed',
    });
    expect(f.notebook.publishedRevision()).toBe(f.base);
    expect(f.rows()).toEqual({ audits: [], receipts: [] });
  }
);

it.each(['user', 'server'] as const)(
  'preserves %s Git and admission after completion SQL refusal without reconstructing a receipt',
  async (kind) => {
    const f = await fixture(kind);
    f.db.sqlite.exec(
      "CREATE TRIGGER refuse_scoped_complete BEFORE INSERT ON audit_events WHEN NEW.action='knowledge.notebook.update' BEGIN SELECT RAISE(ABORT,'scoped completion fault'); END"
    );
    f.queryOnly();
    await expect(publishScopedNotebook(f.input, f.request)).rejects.toMatchObject({
      commit: 'not-committed',
    });
    const published = f.notebook.publishedRevision();
    expect(published).not.toBe(f.base);
    const prefix = f.rows();
    expect(prefix.audits.map((row: any) => row.action)).toEqual(['knowledge.notebook.admit']);
    expect(prefix.receipts).toEqual([]);
    await expect(
      publishScopedNotebook(
        { ...f.input, store: new FsStore({ dataRoot: f.root }), inflightCommands: new WeakMap() },
        f.request
      )
    ).rejects.toMatchObject({ code: 'recovery_required' });
    expect(f.notebook.publishedRevision()).toBe(published);
    expect(f.rows()).toEqual(prefix);
  }
);

it.each(['user', 'server'] as const)(
  'preserves every original %s prefix when an actual FULL reply is lost, without retry',
  async (kind) => {
    // This loop is sequential: each stage needs a fresh isolated owner and request.
    for (const stage of [1, 2, 3] as const) {
      const f = await fixture(kind);
      f.queryOnly();
      const hold = await held(f, stage);
      const prefix = f.rows();
      expect(prefix.audits.map((row: any) => row.action)).toEqual(
        stage === 1
          ? ['knowledge.notebook.admit']
          : ['knowledge.notebook.admit', 'knowledge.notebook.update']
      );
      expect(prefix.receipts).toHaveLength(stage === 3 ? 1 : 0);
      const head = f.notebook.publishedRevision();
      expect(head === f.base).toBe(stage === 1);
      const posts = faults.messages.length;
      const workers = faults.workers.length;
      await faults.workers[Atomics.load(hold.gate, 5)]!.terminate();
      expect(await hold.result).toMatchObject({ ok: false, error: { commit: 'unknown' } });
      expect(faults.messages).toHaveLength(posts);
      expect(faults.workers).toHaveLength(workers);
      expect(f.rows()).toEqual(prefix);
      expect(f.notebook.publishedRevision()).toBe(head);
      await shutdownControlStoreWorkerClient();
      release();
    }
  }
);

it.each(['user', 'server'] as const)(
  'refuses a Main rewrite of an original moved %s receipt',
  async (kind) => {
    const f = await fixture(kind);
    // Keep Main writable for this deliberate bypass attempt; query_only could conceal missing membership.
    const first = await publishScopedNotebook(f.input, f.request);
    const scope =
      kind === 'user'
        ? { userId: f.userDb.userId, actorId: f.input.actor.userId }
        : { coreId: 'server' as const, actorId: f.input.actor.userId };
    const receipt = f.input.store.getCommandRequest(
      'knowledge.notebook.update',
      f.request.requestId,
      scope,
      f.db
    )!;
    expect(receipt.response.id).toBe(first.notebookRevision);
    const prefix = f.rows();
    expect(() => f.input.store.recordCommandRequest(receipt, f.db)).toThrow();
    expect(f.rows()).toEqual(prefix);
  }
);

it.each(['user', 'server'] as const)(
  'rechecks current %s authority after the actual admission FULL wait before Git and later transport',
  async (kind) => {
    const f = await fixture(kind);
    f.queryOnly();
    const hold = await held(f, 1);
    const prefix = f.rows();
    f.revoke();
    const posts = faults.messages.length;
    release();
    expect(await hold.result).toMatchObject({
      ok: false,
      error: { message: 'Scoped notebook access denied.' },
    });
    expect(f.notebook.publishedRevision()).toBe(f.base);
    expect(f.rows()).toEqual(prefix);
    expect(faults.messages).toHaveLength(posts);
  }
);

it.each(['user', 'server'] as const)(
  'rechecks current %s authority after native opening before a family request is posted',
  async (kind) => {
    const f = await fixture(kind);
    await f.client.close(f.database);
    f.queryOnly();
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    faults.open = { reached };
    const result = observed(publishScopedNotebook(f.input, f.request));
    // Existing tests use the same 5000 ms explicit native hold bound.
    await vi.waitFor(() => expect(faults.open?.deliver).toBeTypeOf('function'), { timeout: 5000 });
    await waiting;
    f.revoke();
    const posts = faults.messages.length;
    release();
    expect(await result).toMatchObject({
      ok: false,
      error: { message: 'Scoped notebook access denied.' },
    });
    expect(f.notebook.publishedRevision()).toBe(f.base);
    expect(f.rows()).toEqual({ audits: [], receipts: [] });
    expect(faults.messages).toHaveLength(posts);
  }
);

it.each(['user', 'server'] as const)(
  'prunes the owned %s Notebook and Source partition without pruning another physical scope',
  async (kind) => {
    const f = await fixture(kind);
    const { registerUserKnowledgeSource } = await import(
      '../knowledge/scoped-knowledge-sources.js'
    );
    const { registerServerKnowledgeSource } = await import(
      '../knowledge/server-knowledge-owner.js'
    );
    // Produce every row through its real owner. A fake Main Date makes naturally expired receipts,
    // while native timers and real Worker scheduling remain unchanged.
    vi.useFakeTimers({ toFake: ['Date'] });
    let peerRequestId: string;
    let oldRequestId: string;
    try {
      vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'));
      peerRequestId = randomUUID();
      const source = {
        requestId: peerRequestId,
        kind: 'document' as const,
        title: 'Expired peer receipt',
        content: 'Retain this peer partition.',
      };
      if (kind === 'user')
        await registerUserKnowledgeSource({ ...f.input, userDb: f.userDb }, source);
      else await registerServerKnowledgeSource(f.input, source);
      // The other real physical owner stays outside this scope's maintenance partition.
      if (kind === 'user')
        await registerServerKnowledgeSource(
          { ...f.input, actor: { kind: 'local', userId: f.userDb.userId } },
          source
        );
      else
        await registerUserKnowledgeSource(
          { ...f.input, actor: { kind: 'local', userId: f.userDb.userId }, userDb: f.userDb },
          source
        );
      f.request.baseRevision = f.notebook.publishedRevision();
      oldRequestId = f.request.requestId;
      await publishScopedNotebook(f.input, f.request);
    } finally {
      vi.useRealTimers();
    }
    const peer = f.db.sqlite
      .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
      .all(peerRequestId!);
    expect(peer).toHaveLength(1);
    const foreignDb = kind === 'user' ? f.coreDb : f.userDb;
    const foreign = foreignDb.sqlite
      .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
      .all(peerRequestId!);
    expect(foreign).toHaveLength(1);
    expect(
      f.db.sqlite
        .prepare('SELECT request_id FROM idempotency_requests WHERE request_id=?')
        .all(oldRequestId!)
    ).toHaveLength(1);
    f.queryOnly();
    await publishScopedNotebook(f.input, {
      ...f.request,
      requestId: randomUUID(),
      baseRevision: f.notebook.publishedRevision(),
      summary: 'Fresh publication after exact expiry boundary',
      changes: [
        {
          ...f.request.changes[0]!,
          content: f.request.changes[0]!.content.replace(
            'Preserve exact scoped bytes.',
            'Fresh scoped content after expiry.'
          ),
        },
      ],
    });
    expect(
      f.db.sqlite
        .prepare('SELECT request_id FROM idempotency_requests WHERE request_id=?')
        .all(oldRequestId!)
    ).toEqual([]);
    expect(
      f.db.sqlite
        .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
        .all(peerRequestId!)
    ).toEqual([]);
    expect(
      foreignDb.sqlite
        .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
        .all(peerRequestId!)
    ).toEqual(foreign);
  }
);

it('publishes and replays through public memory.create while every Main User open is query-only', async () => {
  const f = await fixture('user');
  const { createOperationInvocation } = await import('../operation-composition.js');
  const request = {
    requestId: f.request.requestId,
    baseRevision: f.base,
    pageId: 'note',
    content: f.request.changes[0]!.content,
    summary: f.request.summary,
  };
  const human = { kind: 'public' as const, actor: f.input.actor, delivery: 'human' as const };
  f.queryOnly();
  const invoke = createOperationInvocation(f.input);
  const first = await invoke('memory.create', request, human);
  const prefix = f.rows();
  expect(prefix.audits).toHaveLength(2);
  expect(prefix.receipts).toHaveLength(1);
  const cold = createOperationInvocation({
    ...f.input,
    store: new FsStore({ dataRoot: f.root }),
    inflightCommands: new WeakMap(),
  });
  await expect(cold('memory.create', request, human)).resolves.toEqual(first);
  expect(f.rows()).toEqual(prefix);
  expect(f.notebook.readRevision(f.notebook.publishedRevision()).files['note.md']).toBe(
    request.content
  );
});

it('publishes and replays exact human Server Review through the public operation with Main Core query-only', async () => {
  const f = await fixture('server');
  const { createOperationInvocation } = await import('../operation-composition.js');
  const { serverNotebookAdmission } = await import('../knowledge/server-knowledge-maintenance.js');
  const { createServerNotebookProposal, readServerNotebookProposal } = await import(
    '../knowledge/server-notebook-proposals.js'
  );
  const dependencies = {
    ...f.input,
    pin: () => {
      throw new Error('No model pin belongs to this decision.');
    },
    run: async () => {
      throw new Error('No model run belongs to this decision.');
    },
  };
  const context = {
    ...dependencies,
    revalidate: (files?: Readonly<Record<string, string>>) =>
      serverNotebookAdmission(dependencies, f.input.actor, files),
  };
  const proposal = createServerNotebookProposal(
    context,
    f.request,
    { kind: 'agent', id: 'knowledge-manager', responsibleUserId: f.input.actor.userId },
    []
  );
  const selected = readServerNotebookProposal(context, proposal.id);
  const request = {
    requestId: f.request.requestId,
    proposalId: proposal.id,
    proposalDigest: selected.proposalDigest,
    baseRevision: proposal.baseRevision,
    candidateRevision: proposal.candidateRevision,
    decision: 'accepted' as const,
  };
  const human = { kind: 'public' as const, actor: f.input.actor, delivery: 'human' as const };
  f.queryOnly();
  const invoke = createOperationInvocation({
    ...f.input,
    serverKnowledgeMaintenance: dependencies,
  });
  const first = await invoke('knowledge.server.proposal.decide', request, human);
  expect(f.notebook.publishedRevision()).toBe(proposal.candidateRevision);
  expect(readServerNotebookProposal(context, proposal.id).reviews).toHaveLength(1);
  const prefix = f.rows();
  expect(prefix.audits.map((row: any) => row.action)).toEqual([
    'knowledge.notebook.admit',
    'knowledge.proposal.decide',
  ]);
  expect(prefix.receipts).toHaveLength(1);
  const cold = createOperationInvocation({
    ...f.input,
    store: new FsStore({ dataRoot: f.root }),
    inflightCommands: new WeakMap(),
    serverKnowledgeMaintenance: {
      ...dependencies,
      store: new FsStore({ dataRoot: f.root }),
      inflightCommands: new WeakMap(),
    },
  });
  await expect(cold('knowledge.server.proposal.decide', request, human)).resolves.toEqual(first);
  expect(f.rows()).toEqual(prefix);
  expect(readServerNotebookProposal(context, proposal.id).reviews).toHaveLength(1);
});

it.each(['user', 'server'] as const)(
  'prunes an expired native %s Notebook receipt when its owning Source producer publishes',
  async (kind) => {
    const f = await fixture(kind);
    const { registerUserKnowledgeSource } = await import(
      '../knowledge/scoped-knowledge-sources.js'
    );
    const { registerServerKnowledgeSource } = await import(
      '../knowledge/server-knowledge-owner.js'
    );
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'));
      await publishScopedNotebook(f.input, f.request);
    } finally {
      vi.useRealTimers();
    }
    const original = f.rows().receipts;
    expect(original).toHaveLength(1);
    // Source now shares this physical scope's native receipt maintenance owner.
    const source = {
      requestId: randomUUID(),
      kind: 'document' as const,
      title: 'Fresh peer publication',
      content: 'Keep native Notebook receipts with their owner.',
    };
    if (kind === 'user')
      await registerUserKnowledgeSource({ ...f.input, userDb: f.userDb }, source);
    else await registerServerKnowledgeSource(f.input, source);
    expect(f.rows().receipts).toEqual([]);
    expect(
      f.db.sqlite
        .prepare('SELECT request_id FROM idempotency_requests WHERE request_id=?')
        .all(source.requestId)
    ).toHaveLength(1);
  }
);

it.each(['user', 'server'] as const)(
  'reads original %s Notebook receipts by path without Main writes or expiry pruning',
  async (kind) => {
    const f = await fixture(kind);
    f.queryOnly();
    const first = await publishScopedNotebook(f.input, f.request);
    const scope =
      kind === 'user'
        ? { userId: f.userDb.userId, actorId: f.input.actor.userId }
        : { coreId: 'server' as const, actorId: f.input.actor.userId };
    const original = f.rows();
    expect(original.receipts).toHaveLength(1);
    const receipt = f.input.store.getCommandRequest(
      'knowledge.notebook.update',
      f.request.requestId,
      scope,
      f.db
    )!;
    expect(receipt).toMatchObject({
      command: 'knowledge.notebook.update',
      requestId: f.request.requestId,
      scope,
      inputHash: commandInputHash({ ...f.request, ownerScope: f.owner.ownerScope }),
      response: { kind: 'knowledge_notebook_revision', id: first.notebookRevision },
    });
    // Core Storage requires one physical writer; this lookup must observe the original receipt.
    expect(
      f.input.store.getCommandRequest('knowledge.notebook.update', f.request.requestId, scope)
    ).toEqual(receipt);
    expect(f.rows()).toEqual(original);
    // Core Protocol makes the exact expiry boundary absent; only the native owner may prune it.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(receipt.expiresAt));
      expect(
        f.input.store.getCommandRequest('knowledge.notebook.update', f.request.requestId, scope)
      ).toBeNull();
      expect(f.rows()).toEqual(original);
    } finally {
      vi.useRealTimers();
    }
  }
);

// Fresh creation and Source capture retain their original separate SQL/Git/file stages.
it.each(['user', 'server'] as const)(
  'retains original %s initialization prefixes after real admission and completion SQLite faults',
  async (kind) => {
    for (const stage of ['admission', 'completion'] as const) {
      const f = await fixture(kind, true);
      const action =
        stage === 'admission' ? 'knowledge.notebook.admit' : 'knowledge.notebook.initialize';
      f.db.sqlite.exec(
        `CREATE TRIGGER refuse_initialization BEFORE INSERT ON audit_events WHEN NEW.action = '${action}' BEGIN SELECT RAISE(ABORT, 'initialization stage fault'); END`
      );
      const result = await observed(Promise.resolve().then(f.initialize));
      expect(result.ok).toBe(false);
      const rows = f.db.sqlite
        .prepare('SELECT * FROM audit_events WHERE request_id=? ORDER BY rowid')
        .all(f.initialization.requestId);
      expect(rows).toHaveLength(stage === 'admission' ? 0 : 1);
      if (stage === 'completion') {
        const revision = f.notebook.publishedRevision();
        expect(f.notebook.readRevision(revision).metadata.changeRequest.requestId).toBe(
          f.initialization.requestId
        );
        expect(f.notebook.readRevision(revision).files).toHaveProperty('index.md');
      } else expect(() => f.notebook.publishedRevision()).toThrow();
      expect(existsSync(join(f.owner.notebookRoot, 'schema', 'scope-schema.yaml'))).toBe(false);
      expect(f.db.sqlite.prepare('SELECT * FROM idempotency_requests').all()).toEqual([]);
      await shutdownControlStoreWorkerClient();
      f.userDb.sqlite.close();
      f.coreDb.sqlite.close();
      const cold = kind === 'user' ? openUserDb(f.root, f.userDb.userId) : openCoreDb(f.root);
      try {
        expect(
          cold.sqlite
            .prepare('SELECT * FROM audit_events WHERE request_id=? ORDER BY rowid')
            .all(f.initialization.requestId)
        ).toEqual(rows);
        expect(cold.sqlite.prepare('SELECT * FROM idempotency_requests').all()).toEqual([]);
      } finally {
        cold.sqlite.close();
      }
    }
  }
);

it.each(['user', 'server'] as const)(
  'retains original %s Source Git and exact bytes after real completion and receipt SQLite faults',
  async (kind) => {
    const { registerUserKnowledgeSource } = await import(
      '../knowledge/scoped-knowledge-sources.js'
    );
    const { registerServerKnowledgeSource } = await import(
      '../knowledge/server-knowledge-owner.js'
    );
    for (const stage of ['completion', 'receipt'] as const) {
      const f = await fixture(kind);
      const request = {
        requestId: f.request.requestId,
        kind: 'document' as const,
        title: 'Original source stage',
        content: 'Exact source.\r\nΩ 雪.\n',
      };
      const publish = () =>
        kind === 'user'
          ? registerUserKnowledgeSource({ ...f.input, userDb: f.userDb }, request)
          : registerServerKnowledgeSource(f.input, request);
      f.db.sqlite.exec(
        stage === 'completion'
          ? "CREATE TRIGGER refuse_source_stage BEFORE INSERT ON audit_events WHEN NEW.action = 'knowledge.source.register' BEGIN SELECT RAISE(ABORT, 'source completion fault'); END"
          : "CREATE TRIGGER refuse_source_stage BEFORE INSERT ON idempotency_requests WHEN NEW.command_name = 'knowledge.source.register' BEGIN SELECT RAISE(ABORT, 'source receipt fault'); END"
      );
      expect((await observed(publish())).ok).toBe(false);
      const prefix = f.rows();
      expect(prefix.audits.map((row) => (row as { action: string }).action)).toEqual(
        stage === 'completion'
          ? ['knowledge.notebook.admit']
          : ['knowledge.notebook.admit', 'knowledge.source.register']
      );
      expect(prefix.receipts).toEqual([]);
      const revision = f.notebook.publishedRevision();
      expect(revision).not.toBe(f.base);
      const pointers = f.notebook.readSourcePointers(revision);
      expect(Object.keys(pointers)).toHaveLength(1);
      const { parseOkfDocument } = await import('../knowledge/okf.js');
      const pointer = parseOkfDocument({
        path: `sources/${Object.keys(pointers)[0]}.md`,
        content: Object.values(pointers)[0]!,
      });
      expect(pointer.ok).toBe(true);
      if (!pointer.ok) throw new Error('Expected owner-produced Source pointer.');
      const reference = pointer.document.frontmatter.contentRef as { locator: { path: string } };
      const raw = join(f.owner.notebookRoot, 'raw', reference.locator.path);
      expect(readFileSync(raw)).toEqual(Buffer.from(request.content));
      f.db.sqlite.exec('DROP TRIGGER refuse_source_stage');
      await expect(publish()).rejects.toMatchObject({ code: 'recovery_required' });
      expect(f.rows()).toEqual(prefix);
      expect(f.notebook.publishedRevision()).toBe(revision);
      await shutdownControlStoreWorkerClient();
      f.userDb.sqlite.close();
      f.coreDb.sqlite.close();
      const cold = kind === 'user' ? openUserDb(f.root, f.userDb.userId) : openCoreDb(f.root);
      try {
        expect(
          cold.sqlite
            .prepare(
              'SELECT action,notebook_admission_json AS evidence FROM audit_events WHERE request_id=? ORDER BY rowid'
            )
            .all(request.requestId)
        ).toEqual(prefix.audits);
        expect(
          cold.sqlite
            .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
            .all(request.requestId)
        ).toEqual([]);
        expect(
          new KnowledgeNotebook({
            repositoryPath: join(f.owner.notebookRoot, 'notebook.git'),
          }).publishedRevision()
        ).toBe(revision);
        expect(readFileSync(raw)).toEqual(Buffer.from(request.content));
      } finally {
        cold.sqlite.close();
      }
    }
  }
);

it('natively initializes and receipts the public first Memory save with every Main connection query-only', async () => {
  const f = await fixture('user', true);
  const { createOperationInvocation } = await import('../operation-composition.js');
  const request = {
    requestId: f.request.requestId,
    baseRevision: null,
    pageId: 'note',
    content: f.request.changes[0]!.content,
    summary: f.request.summary,
  };
  f.queryOnly();
  const first = await createOperationInvocation(f.input)('memory.create', request, {
    kind: 'public',
    actor: f.input.actor,
    delivery: 'human',
  });
  expect(first).toMatchObject({ outcome: 'published', baseRevision: null });
  expect(f.notebook.readRevision(f.notebook.publishedRevision()).files['note.md']).toBe(
    request.content
  );
  expect(f.rows().audits.map((row) => (row as { action: string }).action)).toEqual([
    'knowledge.notebook.admit',
    'knowledge.notebook.initialize',
  ]);
  expect(f.rows().receipts).toHaveLength(1);
});

it.each(['user', 'server'] as const)(
  'natively captures exact %s Source bytes and original receipt with every Main connection query-only',
  async (kind) => {
    const f = await fixture(kind);
    const { registerUserKnowledgeSource } = await import(
      '../knowledge/scoped-knowledge-sources.js'
    );
    const { registerServerKnowledgeSource } = await import(
      '../knowledge/server-knowledge-owner.js'
    );
    const request = {
      requestId: f.request.requestId,
      kind: 'document' as const,
      title: 'Native exact source',
      content: 'Original source.\r\nΩ 雪.\n',
    };
    // Observe the genuine original SQL refusal even when the public User owner sanitizes it.
    const prepare = f.db.sqlite.prepare.bind(f.db.sqlite);
    vi.spyOn(f.db.sqlite, 'prepare').mockImplementation((sql) => {
      const statement = prepare(sql);
      const run = statement.run.bind(statement);
      statement.run = (...parameters) => {
        try {
          return run(...parameters);
        } catch (error) {
          if ((error as { code?: string }).code === 'SQLITE_READONLY')
            console.info('Main Source SQL refused', { kind, code: 'SQLITE_READONLY' });
          throw error;
        }
      };
      return statement;
    });
    f.queryOnly();
    const source =
      kind === 'user'
        ? await registerUserKnowledgeSource({ ...f.input, userDb: f.userDb }, request)
        : await registerServerKnowledgeSource(f.input, request);
    expect(source).toMatchObject({ title: request.title, ownerScope: f.owner.ownerScope });
    expect(f.rows().audits.map((row) => (row as { action: string }).action)).toEqual([
      'knowledge.notebook.admit',
      'knowledge.source.register',
    ]);
    expect(f.rows().receipts).toHaveLength(1);
    const { readUserKnowledgeSource } = await import('../knowledge/scoped-knowledge-sources.js');
    const { readServerKnowledgeSource } = await import('../knowledge/server-knowledge-owner.js');
    expect(
      kind === 'user'
        ? await readUserKnowledgeSource({ ...f.input, userDb: f.userDb }, source.id)
        : await readServerKnowledgeSource(f.input, source.id)
    ).toEqual({ source, content: request.content });
    const prefix = f.rows();
    const head = f.notebook.publishedRevision();
    await shutdownControlStoreWorkerClient();
    const coldCore = openCoreDb(f.root);
    const coldUser = openUserDb(f.root, f.userDb.userId);
    try {
      const cold = {
        ...f.input,
        coreDb: coldCore,
        userDb: coldUser,
        store: new FsStore({ dataRoot: f.root }),
        inflightCommands: new WeakMap(),
      };
      const replay = () =>
        kind === 'user'
          ? registerUserKnowledgeSource(cold, request)
          : registerServerKnowledgeSource(cold, request);
      expect(await replay()).toEqual(source);
      await expect(
        kind === 'user'
          ? registerUserKnowledgeSource(cold, { ...request, content: 'Different input.' })
          : registerServerKnowledgeSource(cold, { ...request, content: 'Different input.' })
      ).rejects.toThrow('requestId');
      expect(
        kind === 'user'
          ? await readUserKnowledgeSource(cold, source.id)
          : await readServerKnowledgeSource(cold, source.id)
      ).toEqual({ source, content: request.content });
      expect(f.rows()).toEqual(prefix);
      expect(f.notebook.publishedRevision()).toBe(head);
    } finally {
      coldUser.sqlite.close();
      coldCore.sqlite.close();
    }
  }
);

it.each(['user', 'server'] as const)(
  'fences later fresh %s initialization stages at each original FULL ACK and retains cold prefixes after ACK loss',
  async (kind) => {
    for (const stage of [4, 5] as const) {
      const f = await fixture(kind, true);
      const { createOperationInvocation } = await import('../operation-composition.js');
      const { registerServerKnowledgeSource } = await import(
        '../knowledge/server-knowledge-owner.js'
      );
      const start = () =>
        kind === 'user'
          ? createOperationInvocation(f.input)(
              'memory.create',
              {
                requestId: f.request.requestId,
                baseRevision: null,
                pageId: 'note',
                content: f.request.changes[0]!.content,
                summary: f.request.summary,
              },
              { kind: 'public', actor: f.input.actor, delivery: 'human' }
            )
          : registerServerKnowledgeSource(f.input, {
              requestId: f.request.requestId,
              kind: 'document',
              title: 'Fresh shared Source',
              content: 'Exact fresh original.',
            });
      f.queryOnly();
      let settled = false;
      const hold = await held(f, stage, () =>
        start().finally(() => {
          settled = true;
        })
      );
      expect(settled).toBe(false);
      const prefix = f.rows();
      expect(prefix.audits).toHaveLength(stage === 4 ? 1 : 2);
      expect(prefix.receipts).toEqual([]);
      expect(existsSync(join(f.owner.notebookRoot, 'schema', 'scope-schema.yaml'))).toBe(false);
      if (stage === 4) expect(() => f.notebook.publishedRevision()).toThrow();
      else
        expect(
          f.notebook.inspectRevision(f.notebook.publishedRevision()).parentRevision
        ).toBeNull();
      const posts = faults.messages.length;
      const workers = faults.workers.length;
      await faults.workers[Atomics.load(hold.gate, 5)]!.terminate();
      expect((await hold.result).ok).toBe(false);
      expect(settled).toBe(true);
      expect(faults.messages).toHaveLength(posts);
      expect(faults.workers).toHaveLength(workers);
      expect(f.rows()).toEqual(prefix);
      expect(existsSync(join(f.owner.notebookRoot, 'schema', 'scope-schema.yaml'))).toBe(false);
      await shutdownControlStoreWorkerClient();
      release();
      const cold = kind === 'user' ? openUserDb(f.root, f.userDb.userId) : openCoreDb(f.root);
      try {
        expect(
          cold.sqlite
            .prepare(
              'SELECT action,notebook_admission_json AS evidence FROM audit_events WHERE request_id=? ORDER BY rowid'
            )
            .all(f.request.requestId)
        ).toEqual(prefix.audits);
        expect(
          cold.sqlite
            .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
            .all(f.request.requestId)
        ).toEqual([]);
      } finally {
        cold.sqlite.close();
      }
    }
  }
);

it.each(['user', 'server'] as const)(
  'refuses fresh %s initialization continuation after current authority is lost behind admission ACK',
  async (kind) => {
    for (const stage of [4, 5] as const) {
      const f = await fixture(kind, true);
      const { createOperationInvocation } = await import('../operation-composition.js');
      const { registerServerKnowledgeSource } = await import(
        '../knowledge/server-knowledge-owner.js'
      );
      const start = () =>
        kind === 'user'
          ? createOperationInvocation(f.input)(
              'memory.create',
              {
                requestId: f.request.requestId,
                baseRevision: null,
                pageId: 'note',
                content: f.request.changes[0]!.content,
                summary: f.request.summary,
              },
              { kind: 'public', actor: f.input.actor, delivery: 'human' }
            )
          : registerServerKnowledgeSource(f.input, {
              requestId: f.request.requestId,
              kind: 'document',
              title: 'Current shared Source',
              content: 'Exact current original.',
            });
      f.queryOnly();
      const hold = await held(f, stage, start);
      f.revoke();
      release();
      expect((await hold.result).ok).toBe(false);
      if (stage === 4) expect(() => f.notebook.publishedRevision()).toThrow();
      else
        expect(
          f.notebook.inspectRevision(f.notebook.publishedRevision()).parentRevision
        ).toBeNull();
      expect(f.rows().audits).toHaveLength(stage === 4 ? 1 : 2);
      expect(f.rows().receipts).toEqual([]);
      expect(existsSync(join(f.owner.notebookRoot, 'schema', 'scope-schema.yaml'))).toBe(false);
    }
  }
);

it.each(['user', 'server'] as const)(
  'keeps every original %s Source prefix after genuine FULL ACK loss without recapture or receipt reconstruction',
  async (kind) => {
    const { registerUserKnowledgeSource } = await import(
      '../knowledge/scoped-knowledge-sources.js'
    );
    const { registerServerKnowledgeSource } = await import(
      '../knowledge/server-knowledge-owner.js'
    );
    for (const stage of [6, 7, 8] as const) {
      const f = await fixture(kind);
      const request = {
        requestId: f.request.requestId,
        kind: 'document' as const,
        title: 'Original native prefix',
        content: 'Exact retained source.\r\nΩ 雪.\n',
      };
      const start = () =>
        kind === 'user'
          ? registerUserKnowledgeSource({ ...f.input, userDb: f.userDb }, request)
          : registerServerKnowledgeSource(f.input, request);
      f.queryOnly();
      let settled = false;
      const hold = await held(f, stage, () =>
        start().finally(() => {
          settled = true;
        })
      );
      expect(settled).toBe(false);
      const prefix = f.rows();
      expect(prefix.audits).toHaveLength(stage === 6 ? 1 : 2);
      expect(prefix.receipts).toHaveLength(stage === 8 ? 1 : 0);
      const head = f.notebook.publishedRevision();
      expect(head === f.base).toBe(stage === 6);
      const posts = faults.messages.length;
      const workers = faults.workers.length;
      await faults.workers[Atomics.load(hold.gate, 5)]!.terminate();
      expect((await hold.result).ok).toBe(false);
      expect(settled).toBe(true);
      expect(faults.messages).toHaveLength(posts);
      expect(faults.workers).toHaveLength(workers);
      expect(f.rows()).toEqual(prefix);
      expect(f.notebook.publishedRevision()).toBe(head);
      await shutdownControlStoreWorkerClient();
      release();
      const cold = kind === 'user' ? openUserDb(f.root, f.userDb.userId) : openCoreDb(f.root);
      try {
        expect(
          cold.sqlite
            .prepare(
              'SELECT action,notebook_admission_json AS evidence FROM audit_events WHERE request_id=? ORDER BY rowid'
            )
            .all(request.requestId)
        ).toEqual(prefix.audits);
        expect(
          cold.sqlite
            .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
            .all(request.requestId)
        ).toEqual(prefix.receipts);
        expect(
          new KnowledgeNotebook({
            repositoryPath: join(f.owner.notebookRoot, 'notebook.git'),
          }).publishedRevision()
        ).toBe(head);
      } finally {
        cold.sqlite.close();
      }
    }
  }
);

it.each(['maintain', 'tell'] as const)(
  'holds the original %s User receipt FULL ACK after real Workspace preparation and starts no inference on lost ACK',
  async (kind) => {
    const f = await fixture('user');
    const { runUserMemoryMaintenanceCommand } = await import(
      '../knowledge/user-memory-agent-maintenance.js'
    );
    const run = vi.fn(async () => {
      throw new Error('External inference must remain fenced.');
    });
    const dependencies = {
      coreDb: f.coreDb,
      userDb: f.userDb,
      store: f.input.store,
      runtimeConfigManager: f.input.runtimeConfigManager,
      inflightCommands: f.input.inflightCommands,
      openWorkspace: (id: string) => openWorkspaceDb(f.root, id),
      pin: async () => {},
      run,
    };
    const input = {
      requestId: f.request.requestId,
      requestActor: f.input.actor,
      trigger: 'request' as const,
      instructions: 'Original User request.',
      sources: [],
      ...(kind === 'tell' ? { tellContent: 'Exact explicit personal fact.' } : {}),
      signal: new AbortController().signal,
    };
    f.queryOnly();
    let settled = false;
    const hold = await held(f, 9, () =>
      runUserMemoryMaintenanceCommand(dependencies, input).finally(() => {
        settled = true;
      })
    );
    expect(settled).toBe(false);
    expect(run).not.toHaveBeenCalled();
    const prefix = f.rows().receipts;
    expect(prefix).toHaveLength(1);
    const receipt = prefix[0] as { command_name: string; response_id: string };
    expect(receipt.command_name).toBe(kind === 'tell' ? 'knowledge.tell' : 'knowledge.maintain');
    const turn = f.input.store.getTurnById(receipt.response_id);
    expect(turn).toMatchObject({
      agentId: 'knowledge-manager',
      triggerActor: { kind: 'user', id: f.userDb.userId },
    });
    const { workspaceIdForOwner } = await import('@openkit/protocol');
    expect(f.input.store.getThread(workspaceIdForOwner(turn.owner), turn.threadId)).toMatchObject({
      visibility: 'private',
      privateOwnerUserId: f.userDb.userId,
    });
    const posts = faults.messages.length;
    await faults.workers[Atomics.load(hold.gate, 5)]!.terminate();
    expect(await hold.result).toMatchObject({ ok: false, error: { commit: 'unknown' } });
    expect(run).not.toHaveBeenCalled();
    expect(faults.messages).toHaveLength(posts);
    expect(f.rows().receipts).toEqual(prefix);
    await shutdownControlStoreWorkerClient();
    release();
    const cold = openUserDb(f.root, f.userDb.userId);
    try {
      expect(
        cold.sqlite
          .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
          .all(input.requestId)
      ).toEqual(prefix);
      const reopened = new FsStore({ dataRoot: f.root });
      expect(reopened.getTurnById(turn.id)).toEqual(turn);
      await expect(
        runUserMemoryMaintenanceCommand(
          { ...dependencies, userDb: cold, store: reopened, inflightCommands: new WeakMap() },
          input
        )
      ).rejects.toMatchObject({ code: 'recovery_required' });
      expect(run).not.toHaveBeenCalled();
    } finally {
      cold.sqlite.close();
    }
  }
);

it.each(['maintain', 'tell'] as const)(
  'starts %s inference only after User receipt ACK and refuses continuation after actual self revocation',
  async (kind) => {
    const { runUserMemoryMaintenanceCommand } = await import(
      '../knowledge/user-memory-agent-maintenance.js'
    );
    for (const revoke of [false, true]) {
      const f = await fixture('user');
      const run = vi.fn(async () => {
        throw new Error('External role failure after acknowledged admission.');
      });
      const dependencies = {
        coreDb: f.coreDb,
        userDb: f.userDb,
        store: f.input.store,
        runtimeConfigManager: f.input.runtimeConfigManager,
        inflightCommands: f.input.inflightCommands,
        openWorkspace: (id: string) => openWorkspaceDb(f.root, id),
        pin: async () => {},
        run,
      };
      const input = {
        requestId: f.request.requestId,
        requestActor: f.input.actor,
        trigger: 'request' as const,
        instructions: 'Original acknowledged User request.',
        sources: [],
        ...(kind === 'tell' ? { tellContent: 'Original explicit personal fact.' } : {}),
        signal: new AbortController().signal,
      };
      f.queryOnly();
      const hold = await held(f, 9, () => runUserMemoryMaintenanceCommand(dependencies, input));
      const prefix = f
        .rows()
        .receipts.filter(
          (row) =>
            (row as { command_name: string }).command_name ===
            (kind === 'tell' ? 'knowledge.tell' : 'knowledge.maintain')
        );
      expect(prefix).toHaveLength(1);
      expect(run).not.toHaveBeenCalled();
      if (revoke) f.revoke();
      release();
      const outcome = await hold.result;
      expect(outcome.ok).toBe(!revoke);
      expect(run).toHaveBeenCalledTimes(revoke ? 0 : 1);
      expect(
        f
          .rows()
          .receipts.filter(
            (row) =>
              (row as { command_name: string }).command_name ===
              (kind === 'tell' ? 'knowledge.tell' : 'knowledge.maintain')
          )
      ).toEqual(prefix);
    }
  }
);

it.each(['user', 'server'] as const)(
  'retains the %s Source admission and original bytes but refuses Git after authority loss behind ACK',
  async (kind) => {
    const f = await fixture(kind);
    const { registerUserKnowledgeSource } = await import(
      '../knowledge/scoped-knowledge-sources.js'
    );
    const { registerServerKnowledgeSource } = await import(
      '../knowledge/server-knowledge-owner.js'
    );
    const request = {
      requestId: f.request.requestId,
      kind: 'document' as const,
      title: 'Current Source admission',
      content: 'Exact original before revocation.\r\nΩ 雪.\n',
    };
    const start = () =>
      kind === 'user'
        ? registerUserKnowledgeSource({ ...f.input, userDb: f.userDb }, request)
        : registerServerKnowledgeSource(f.input, request);
    f.queryOnly();
    const hold = await held(f, 6, start);
    const prefix = f.rows();
    expect(prefix.audits).toHaveLength(1);
    expect(prefix.receipts).toEqual([]);
    const evidence = JSON.parse((prefix.audits[0] as { evidence: string }).evidence) as {
      candidateRevision: string;
    };
    const pointers = f.notebook.readSourcePointers(evidence.candidateRevision);
    expect(Object.keys(pointers)).toHaveLength(1);
    const { parseOkfDocument } = await import('../knowledge/okf.js');
    const pointer = parseOkfDocument({
      path: `sources/${Object.keys(pointers)[0]}.md`,
      content: Object.values(pointers)[0]!,
    });
    if (!pointer.ok) throw new Error('Expected owner-produced Source candidate.');
    const reference = pointer.document.frontmatter.contentRef as { locator: { path: string } };
    const raw = join(f.owner.notebookRoot, 'raw', reference.locator.path);
    expect(readFileSync(raw)).toEqual(Buffer.from(request.content));
    f.revoke();
    release();
    expect((await hold.result).ok).toBe(false);
    expect(f.notebook.publishedRevision()).toBe(f.base);
    expect(f.rows()).toEqual(prefix);
    expect(readFileSync(raw)).toEqual(Buffer.from(request.content));
  }
);

it('initializes fresh public Memory search with query-only Main owners without inventing a command receipt or replacing lost storage', async () => {
  const f = await fixture('user', true);
  const workspace = await f.input.store.createWorkspace('Fresh private query');
  const { recordWorkspaceOwnerMembership } = await import('../workspace-membership.js');
  recordWorkspaceOwnerMembership({
    coreDb: f.coreDb,
    workspaceId: workspace.id,
    ownerUserId: f.userDb.userId,
  });
  const { openAssistantTimeline } = await import('../internal-agents/assistant-timeline.js');
  await openAssistantTimeline(f.input.store, workspace.id, f.userDb.userId, 'Private query');
  const { createOperationInvocation } = await import('../operation-composition.js');
  const invoke = createOperationInvocation(f.input);
  const human = { kind: 'public' as const, actor: f.input.actor, delivery: 'human' as const };
  f.queryOnly();
  const request = { workspaceId: workspace.id, query: 'No personal facts exist.' };
  expect(await invoke('memory.search', request, human)).toMatchObject({ selected: [] });
  const audits = f.db.sqlite.prepare('SELECT * FROM audit_events ORDER BY rowid').all();
  expect(audits.map((row) => (row as { action: string }).action)).toEqual([
    'knowledge.notebook.admit',
    'knowledge.notebook.initialize',
  ]);
  expect(f.db.sqlite.prepare('SELECT * FROM idempotency_requests').all()).toEqual([]);
  expect(f.notebook.inspectRevision(f.notebook.publishedRevision()).parentRevision).toBeNull();
  expect(Object.keys(f.notebook.readRevision(f.notebook.publishedRevision()).files)).toEqual([
    'index.md',
  ]);
  await invoke('memory.search', request, human);
  expect(f.db.sqlite.prepare('SELECT * FROM audit_events ORDER BY rowid').all()).toEqual(audits);
  rmSync(f.owner.notebookRoot, { recursive: true });
  await expect(invoke('memory.search', request, human)).rejects.toMatchObject({
    code: 'recovery_required',
  });
  expect(f.db.sqlite.prepare('SELECT * FROM audit_events ORDER BY rowid').all()).toEqual(audits);
  expect(existsSync(f.owner.notebookRoot)).toBe(false);
});

it.each(['maintain', 'tell'] as const)(
  'initializes fresh Server Knowledge through the actual %s caller while Main Core remains query-only',
  async (kind) => {
    const f = await fixture('server', true);
    const { runServerKnowledgeMaintenanceCommand } = await import(
      '../knowledge/server-knowledge-maintenance.js'
    );
    const run = vi.fn(async () => {
      throw new Error('External role failed after fresh initialization.');
    });
    const dependencies = {
      coreDb: f.coreDb,
      store: f.input.store,
      runtimeConfigManager: f.input.runtimeConfigManager,
      inflightCommands: f.input.inflightCommands,
      pin: async () => {},
      run,
    };
    const input = {
      requestId: f.request.requestId,
      requestActor: f.input.actor,
      actor: { kind: 'user' as const, id: f.userDb.userId },
      trigger: 'request' as const,
      instructions: 'Current Server maintenance.',
      sources: [],
      ...(kind === 'tell' ? { tellContent: 'Exact fresh Server fact.' } : {}),
      signal: new AbortController().signal,
    };
    f.queryOnly();
    const result = await runServerKnowledgeMaintenanceCommand(dependencies, input);
    expect(result.outcome).toBe('failed');
    expect(run).toHaveBeenCalledTimes(1);
    const initialization = f.db.sqlite
      .prepare(
        "SELECT action FROM audit_events WHERE request_id=? AND action IN ('knowledge.notebook.admit','knowledge.notebook.initialize') AND resource LIKE 'knowledge-notebook:%' ORDER BY rowid"
      )
      .all(input.requestId);
    expect(initialization.map((row) => (row as { action: string }).action)).toEqual([
      'knowledge.notebook.admit',
      'knowledge.notebook.initialize',
    ]);
    expect(existsSync(join(f.owner.notebookRoot, 'schema', 'scope-schema.yaml'))).toBe(true);
    expect(f.notebook.publishedRevision()).toBeTruthy();
    expect(
      f.db.sqlite
        .prepare(
          'SELECT command_name FROM idempotency_requests WHERE request_id=? AND command_name=?'
        )
        .all(
          input.requestId,
          kind === 'tell' ? 'knowledge.server.tell' : 'knowledge.server.maintain'
        )
    ).toHaveLength(1);
  }
);

it.each(['user', 'server'] as const)(
  'settles the original %s Source receipt after completion ACK despite revocation while withholding public metadata',
  async (kind) => {
    const f = await fixture(kind);
    const { registerUserKnowledgeSource } = await import(
      '../knowledge/scoped-knowledge-sources.js'
    );
    const { registerServerKnowledgeSource } = await import(
      '../knowledge/server-knowledge-owner.js'
    );
    const request = {
      requestId: f.request.requestId,
      kind: 'document' as const,
      title: 'Completed historical Source',
      content: 'Exact already-published original.\r\nΩ 雪.\n',
    };
    const start = () =>
      kind === 'user'
        ? registerUserKnowledgeSource({ ...f.input, userDb: f.userDb }, request)
        : registerServerKnowledgeSource(f.input, request);
    f.queryOnly();
    const hold = await held(f, 7, start);
    const head = f.notebook.publishedRevision();
    expect(head).not.toBe(f.base);
    const pointers = f.notebook.readSourcePointers(head);
    const sourceId = Object.keys(pointers)[0]!;
    expect(Object.keys(pointers)).toHaveLength(1);
    expect(f.rows().audits).toHaveLength(2);
    expect(f.rows().receipts).toEqual([]);
    f.revoke();
    release();
    const outcome = await hold.result;
    // Historical settlement must survive later revocation; it grants no new disclosure authority.
    expect(f.rows().receipts).toHaveLength(1);
    expect(f.rows().receipts[0]).toMatchObject({
      command_name: 'knowledge.source.register',
      request_id: request.requestId,
      response_kind: 'knowledge_source',
      response_id: sourceId,
    });
    expect(f.rows().audits).toHaveLength(2);
    expect(f.notebook.publishedRevision()).toBe(head);
    expect(outcome.ok).toBe(false);
    expect(outcome).not.toHaveProperty('value');
    const { parseOkfDocument } = await import('../knowledge/okf.js');
    const pointer = parseOkfDocument({
      path: `sources/${sourceId}.md`,
      content: pointers[sourceId]!,
    });
    if (!pointer.ok) throw new Error('Expected originally published Source pointer.');
    const reference = pointer.document.frontmatter.contentRef as { locator: { path: string } };
    const raw = join(f.owner.notebookRoot, 'raw', reference.locator.path);
    expect(readFileSync(raw)).toEqual(Buffer.from(request.content));
    const prefix = f.rows();
    await shutdownControlStoreWorkerClient();
    const cold = kind === 'user' ? openUserDb(f.root, f.userDb.userId) : openCoreDb(f.root);
    try {
      expect(
        cold.sqlite
          .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
          .all(request.requestId)
      ).toEqual(prefix.receipts);
      expect(
        cold.sqlite
          .prepare(
            'SELECT action,notebook_admission_json AS evidence FROM audit_events WHERE request_id=? ORDER BY rowid'
          )
          .all(request.requestId)
      ).toEqual(prefix.audits);
      expect(readFileSync(raw)).toEqual(Buffer.from(request.content));
    } finally {
      cold.sqlite.close();
    }
  }
);

it.each(['user', 'server'] as const)(
  'retains the new %s Source receipt when original post-receipt pruning fails and cold-replays without recapture',
  async (kind) => {
    const f = await fixture(kind);
    const { registerUserKnowledgeSource, readUserKnowledgeSource } = await import(
      '../knowledge/scoped-knowledge-sources.js'
    );
    const { registerServerKnowledgeSource, readServerKnowledgeSource } = await import(
      '../knowledge/server-knowledge-owner.js'
    );
    const priorRequest = {
      requestId: randomUUID(),
      kind: 'document' as const,
      title: 'Originally expired Source',
      content: 'Exact originally expired bytes.',
    };
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'));
      if (kind === 'user')
        await registerUserKnowledgeSource({ ...f.input, userDb: f.userDb }, priorRequest);
      else await registerServerKnowledgeSource(f.input, priorRequest);
    } finally {
      vi.useRealTimers();
    }
    const priorReceipt = f.db.sqlite
      .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
      .all(priorRequest.requestId);
    expect(priorReceipt).toHaveLength(1);
    f.db.sqlite.exec(
      `CREATE TRIGGER refuse_original_pruning BEFORE DELETE ON idempotency_requests WHEN OLD.request_id = '${priorRequest.requestId}' BEGIN SELECT RAISE(ABORT, 'original post-receipt pruning failure'); END`
    );
    let mainPruneTriggerReached = false;
    const prepare = f.db.sqlite.prepare.bind(f.db.sqlite);
    vi.spyOn(f.db.sqlite, 'prepare').mockImplementation((sql) => {
      const statement = prepare(sql);
      const run = statement.run.bind(statement);
      statement.run = (...parameters) => {
        try {
          return run(...parameters);
        } catch (error) {
          const sqlite = error as { code?: string; message?: string };
          if (
            sqlite.code?.startsWith('SQLITE_CONSTRAINT') &&
            sqlite.message === 'original post-receipt pruning failure'
          )
            mainPruneTriggerReached = true;
          throw error;
        }
      };
      return statement;
    });
    const request = {
      requestId: f.request.requestId,
      kind: 'document' as const,
      title: 'Completed before maintenance',
      content: 'Exact fresh Source bytes.\r\nΩ 雪.\n',
    };
    const outcome = await observed(
      kind === 'user'
        ? registerUserKnowledgeSource({ ...f.input, userDb: f.userDb }, request)
        : registerServerKnowledgeSource(f.input, request)
    );
    // Original autocommit INSERT precedes the independently failing DELETE maintenance effect.
    const prefix = f.rows();
    expect(prefix.receipts).toHaveLength(1);
    expect(prefix.receipts[0]).toMatchObject({
      command_name: 'knowledge.source.register',
      request_id: request.requestId,
      response_kind: 'knowledge_source',
    });
    expect(outcome.ok).toBe(false);
    const maintenance = faults.messages.findLast((message) => {
      const input = (message as { input?: { action?: string; command?: string } }).input;
      return (
        message.database === f.database &&
        input?.action === `${kind === 'user' ? 'user' : 'server'}-receipt-maintenance` &&
        input.command === 'knowledge.source.register'
      );
    });
    const nativePruneTriggerReached =
      maintenance !== undefined &&
      faults.replies.some(
        (reply) =>
          reply.id === maintenance.id &&
          reply.workerIndex === maintenance.workerIndex &&
          reply.status === 'error' &&
          reply.code === 'constraint' &&
          reply.commit === 'not-committed'
      );
    // Original Main or actual native maintenance must reach the real SQLite trigger, never a routing refusal.
    expect(mainPruneTriggerReached || nativePruneTriggerReached).toBe(true);
    expect(prefix.audits).toHaveLength(2);
    expect(
      f.db.sqlite
        .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
        .all(priorRequest.requestId)
    ).toEqual(priorReceipt);
    const head = f.notebook.publishedRevision();
    const sourceId = (prefix.receipts[0] as { response_id: string }).response_id;
    expect(Object.keys(f.notebook.readSourcePointers(head))).toHaveLength(2);
    expect(
      kind === 'user'
        ? await readUserKnowledgeSource({ ...f.input, userDb: f.userDb }, sourceId)
        : await readServerKnowledgeSource(f.input, sourceId)
    ).toMatchObject({ content: request.content });
    // A cold replay returns the original committed Source; it must not retry failed maintenance.
    await shutdownControlStoreWorkerClient();
    const coldCore = openCoreDb(f.root);
    const coldUser = openUserDb(f.root, f.userDb.userId);
    try {
      const cold = {
        ...f.input,
        coreDb: coldCore,
        userDb: coldUser,
        store: new FsStore({ dataRoot: f.root }),
        inflightCommands: new WeakMap(),
      };
      const replay =
        kind === 'user'
          ? await registerUserKnowledgeSource(cold, request)
          : await registerServerKnowledgeSource(cold, request);
      expect(replay.id).toBe(sourceId);
      expect(
        kind === 'user'
          ? await readUserKnowledgeSource(cold, sourceId)
          : await readServerKnowledgeSource(cold, sourceId)
      ).toMatchObject({ content: request.content });
      expect(f.notebook.publishedRevision()).toBe(head);
      expect(f.rows()).toEqual(prefix);
      expect(
        (kind === 'user' ? coldUser : coldCore).sqlite
          .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
          .all(priorRequest.requestId)
      ).toEqual(priorReceipt);
    } finally {
      coldUser.sqlite.close();
      coldCore.sqlite.close();
    }
  }
);

it.each(['maintain', 'tell'] as const)(
  'retains the original %s User receipt and starts no inference after its separate maintenance FULL ACK is lost',
  async (kind) => {
    const f = await fixture('user');
    const { runUserMemoryMaintenanceCommand } = await import(
      '../knowledge/user-memory-agent-maintenance.js'
    );
    const run = vi.fn(async () => {
      throw new Error('Inference must remain behind maintenance acknowledgement.');
    });
    const dependencies = {
      coreDb: f.coreDb,
      userDb: f.userDb,
      store: f.input.store,
      runtimeConfigManager: f.input.runtimeConfigManager,
      inflightCommands: f.input.inflightCommands,
      openWorkspace: (id: string) => openWorkspaceDb(f.root, id),
      pin: async () => {},
      run,
    };
    const input = {
      requestId: f.request.requestId,
      requestActor: f.input.actor,
      trigger: 'request' as const,
      instructions: 'Original maintenance request.',
      sources: [],
      ...(kind === 'tell' ? { tellContent: 'Exact explicit original.' } : {}),
      signal: new AbortController().signal,
    };
    const command = kind === 'tell' ? 'knowledge.tell' : 'knowledge.maintain';
    faults.maintenanceDatabase = f.database;
    faults.maintenanceCommand = command;
    f.queryOnly();
    const hold = await held(f, 10, () => runUserMemoryMaintenanceCommand(dependencies, input));
    const prefix = f.rows().receipts;
    expect(prefix).toHaveLength(1);
    expect(prefix[0]).toMatchObject({ command_name: command });
    expect(run).not.toHaveBeenCalled();
    const maintenancePosts = () =>
      faults.messages.filter((message) => {
        const posted = message as {
          database?: string;
          input?: { action?: string; command?: string };
        };
        return (
          posted.database === f.database &&
          posted.input?.action === 'user-receipt-maintenance' &&
          posted.input.command === command
        );
      });
    expect(maintenancePosts()).toHaveLength(1);
    const posts = faults.messages.length;
    await faults.workers[Atomics.load(hold.gate, 5)]!.terminate();
    expect(await hold.result).toMatchObject({ ok: false, error: { commit: 'unknown' } });
    expect(run).not.toHaveBeenCalled();
    expect(faults.messages).toHaveLength(posts);
    expect(f.rows().receipts).toEqual(prefix);
    await shutdownControlStoreWorkerClient();
    release();
    const cold = openUserDb(f.root, f.userDb.userId);
    try {
      expect(
        cold.sqlite
          .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
          .all(input.requestId)
      ).toEqual(prefix);
      await expect(
        runUserMemoryMaintenanceCommand(
          {
            ...dependencies,
            userDb: cold,
            store: new FsStore({ dataRoot: f.root }),
            inflightCommands: new WeakMap(),
          },
          input
        )
      ).rejects.toMatchObject({ code: 'recovery_required' });
      expect(run).not.toHaveBeenCalled();
      expect(maintenancePosts()).toHaveLength(1);
    } finally {
      cold.sqlite.close();
    }
  }
);

it('uses original post-publication Main time for Source receipt maintenance when a real peer expires during Git publication', async () => {
  const f = await fixture('user');
  const { registerUserKnowledgeSource } = await import('../knowledge/scoped-knowledge-sources.js');
  const priorRequest = {
    requestId: randomUUID(),
    kind: 'document' as const,
    title: 'Original expiry owner',
    content: 'Exact peer bytes.',
  };
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'));
    await registerUserKnowledgeSource({ ...f.input, userDb: f.userDb }, priorRequest);
    const peer = f.db.sqlite
      .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
      .get(priorRequest.requestId) as { expires_at: string };
    expect(peer).toBeDefined();
    const expiry = Date.parse(peer.expires_at);
    const admittedAt = new Date(expiry - 60_000).toISOString();
    vi.setSystemTime(new Date(admittedAt));
    const publish = KnowledgeNotebook.prototype.publishAsync;
    let published = false;
    vi.spyOn(KnowledgeNotebook.prototype, 'publishAsync').mockImplementation(
      async function (input) {
        const result = await publish.call(this, input);
        published = true;
        // Only Main Date advances, after the genuine Git publisher completed the protected effect.
        vi.setSystemTime(new Date(expiry + 60_000));
        return result;
      }
    );
    const request = {
      requestId: f.request.requestId,
      kind: 'document' as const,
      title: 'Source across original expiry',
      content: 'Exact newly published bytes.',
    };
    const source = await registerUserKnowledgeSource({ ...f.input, userDb: f.userDb }, request);
    expect(published).toBe(true);
    expect(source.title).toBe(request.title);
    expect(f.rows().receipts).toHaveLength(1);
    expect(f.rows().receipts[0]).toMatchObject({ created_at: admittedAt });
    expect(
      f.db.sqlite
        .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
        .all(priorRequest.requestId)
    ).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

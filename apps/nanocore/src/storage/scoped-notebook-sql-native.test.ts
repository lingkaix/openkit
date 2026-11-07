import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { openCoreDb, openUserDb } from './db.js';
import { coreDbPath, userDbPath } from './fs-layout.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';
import { nativeProductScope } from './workspace-file-records.js';

// Native storage integration tests for scoped Notebook publication.
// Accepted owners: Core Storage, Physical Database Ownership; Notebook Editing, Implementation Cutover And Acceptance.
// Observe the actual SQLite COMMIT because a returned rejection cannot identify its durable prefix.
const faults = vi.hoisted(() => ({
  workers: [] as NativeWorker[],
  readOnlyMain: false,
  gate: new SharedArrayBuffer(6 * Int32Array.BYTES_PER_ELEMENT),
  request: new SharedArrayBuffer(36),
  open: undefined as undefined | { reached: () => void; deliver?: () => void },
  messages: [] as Array<{ id?: number; operation?: string; database?: string }>,
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
            const stage = Atomics.load(gate, 1);
            const selected = (stage === 1 && admitted && !completed && receipts.length === 0)
              || (stage === 2 && admitted && completed && receipts.length === 0)
              || (stage === 3 && admitted && completed && receipts.length === 1);
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
        faults.messages.push(args[0]);
        return super.postMessage(...args);
      }
      override emit(event: string | symbol, ...args: unknown[]): boolean {
        const reply = args[0];
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
async function fixture(kind: Kind) {
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
  const base = initializeScopedNotebook({
    ...input,
    initialization: { requestId: randomUUID(), instructionReference: 'test:scoped-sql-native' },
  });
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
async function held(f: Awaited<ReturnType<typeof fixture>>, stage: 1 | 2 | 3) {
  const gate = new Int32Array(faults.gate);
  gate.fill(0);
  new Uint8Array(faults.request).set(new TextEncoder().encode(f.request.requestId));
  Atomics.store(gate, 1, stage);
  const result = observed(publishScopedNotebook(f.input, f.request));
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
  'prunes only owned %s Notebook receipts and preserves an expired Source peer partition',
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
    ).toEqual(peer);
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
  'keeps an expired moved %s Notebook receipt when an unmoved Source owner publishes',
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
    // The peer keeps its existing writer. A query-only Main connection could mask a bad prune partition.
    const source = {
      requestId: randomUUID(),
      kind: 'document' as const,
      title: 'Fresh peer publication',
      content: 'Keep native Notebook receipts with their owner.',
    };
    if (kind === 'user')
      await registerUserKnowledgeSource({ ...f.input, userDb: f.userDb }, source);
    else await registerServerKnowledgeSource(f.input, source);
    expect(f.rows().receipts).toEqual(original);
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

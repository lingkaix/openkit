// openkit-test-platform: posix
// Policy-only increment: the separately frozen strict cold normal-close F oracle remains unresolved.
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { KnowledgeNotebook } from './knowledge/notebook.js';
import { closeRetrievalServices } from './retrieval-service.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { openCoreDb } from './storage/db.js';
import { userDbPath, workspaceDbPath } from './storage/fs-layout.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from './test-support/demo-store.js';
import { serializeKnowledgePageFixture } from './test-support/knowledge-page.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/** Exercises actual Memory and approval HTTP handlers with canonical SQLite/Git and synthetic User authority. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'memory-forget-public-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: userId, workspaceId: DEMO_WORKSPACE_ID });
  const app = createApp({ coreDb, dataRoot, store });
  onTestFinished(async () => {
    await closeRetrievalServices();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const call = async (
    operation: string,
    input: Record<string, unknown> = {},
    target = app,
    authorization?: string
  ) => {
    const { requestId, ...body } = input;
    const response = await target.request(`/api/app/operations/${operation}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(requestId ? { 'x-openkit-request-id': String(requestId) } : {}),
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const content = (ownerUserId: string, body: string) =>
    serializeKnowledgePageFixture(
      {
        title: 'Personal preference',
        content: body,
        sourceReferences: [],
        createdAt: '2026-10-17T00:00:00.000Z',
        updatedAt: '2026-10-17T00:00:00.000Z',
      },
      { kind: 'user', userId: ownerUserId }
    );
  return { app, call, content, coreDb, dataRoot, store, userId };
}

/** Observes the genuine selected Main SQLite instances without throwing policy assertions into HTTP. */
function observeSourcePreviewReader(path: string) {
  const prepare = Database.prototype.prepare;
  const close = Database.prototype.close;
  const exec = Database.prototype.exec;
  const readers = new Map<Database.Database, { readonly: boolean; queryOnly: unknown }>();
  const businessReaders = new Set<Database.Database>();
  const closed: Array<{
    reader: Database.Database;
    readonly: boolean;
    queryOnly: unknown;
    code: string | null;
    unchanged: boolean;
    closed: boolean;
    observationError?: string;
  }> = [];
  let inside = false;
  const prepared = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    if (!inside && this.name === path) {
      // The physical flag is intrinsic. Supported-ledger preflight precedes ready query policy.
      if (!readers.has(this)) readers.set(this, { readonly: this.readonly, queryOnly: undefined });
      if (/\bFROM\s+audit_events\b/i.test(sql) && sql.includes('knowledge.source.register')) {
        inside = true;
        try {
          businessReaders.add(this);
          readers.get(this)!.queryOnly = this.pragma('query_only', { simple: true });
        } finally {
          inside = false;
        }
      }
    }
    return prepare.call(this, sql);
  });
  const closing = vi.spyOn(Database.prototype, 'close').mockImplementation(function (
    this: Database.Database
  ) {
    if (this.name !== path) return close.call(this);
    const row = {
      reader: this,
      readonly: this.readonly,
      queryOnly: this.pragma('query_only', { simple: true }) as unknown,
      code: null as string | null,
      unchanged: false,
      closed: false,
      observationError: undefined as string | undefined,
    };
    // Preflight has no published business-read phase; require its configured close policy.
    const ready = readers.get(this);
    if (ready && ready.queryOnly === undefined) ready.queryOnly = row.queryOnly;
    inside = true;
    try {
      const before = prepare.call(this, 'SELECT * FROM __drizzle_migrations ORDER BY id').all();
      if (!before.length || this.inTransaction)
        throw new Error('Unusable protected-row challenge.');
      exec.call(this, 'SAVEPOINT source_preview_reader_challenge');
      try {
        prepare
          .call(
            this,
            'DELETE FROM __drizzle_migrations WHERE id = (SELECT id FROM __drizzle_migrations ORDER BY id LIMIT 1)'
          )
          .run();
      } catch (error) {
        row.code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : 'UNCLASSIFIED';
      } finally {
        exec.call(this, 'ROLLBACK TO source_preview_reader_challenge');
        exec.call(this, 'RELEASE source_preview_reader_challenge');
      }
      row.unchanged =
        JSON.stringify(
          prepare.call(this, 'SELECT * FROM __drizzle_migrations ORDER BY id').all()
        ) === JSON.stringify(before);
    } catch (error) {
      row.observationError = error instanceof Error ? error.message : String(error);
    } finally {
      inside = false;
    }
    try {
      return close.call(this);
    } finally {
      row.closed = !this.open;
      closed.push(row);
    }
  });
  return {
    readers,
    businessReaders,
    closed,
    restore() {
      prepared.mockRestore();
      closing.mockRestore();
    },
  };
}

/** Observes actual User-owner posting and replies, leaving worker construction and protocol untouched. */
function observePreviewUserNative(path: string) {
  const database = `user:${path}`;
  const state = {
    phase: 'setup',
    posts: [] as Array<{ phase: string; operation: string; id: number; create?: boolean }>,
    acks: [] as Array<{ phase: string; operation: string; id: number }>,
    errors: [] as Array<{ operation: string; id: number }>,
    hosts: new Set<Worker>(),
  };
  const pending = new Map<Worker, Map<number, { phase: string; operation: string }>>();
  const listeners: Array<{ worker: Worker; listener: (reply: unknown) => void }> = [];
  const postMessage = Worker.prototype.postMessage;
  const posting = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
    this: Worker,
    ...args: Parameters<Worker['postMessage']>
  ) {
    const message = args[0] as {
      id?: number;
      operation?: string;
      database?: string;
      create?: boolean;
    } | null;
    if (
      message &&
      typeof message.id === 'number' &&
      typeof message.operation === 'string' &&
      (message.database === database || (message.operation === 'shutdown' && pending.has(this)))
    ) {
      if (!pending.has(this)) {
        pending.set(this, new Map());
        const listener = (reply: unknown) => {
          const row = reply as { id?: number; status?: string } | null;
          if (!row || typeof row.id !== 'number') return;
          const request = pending.get(this)?.get(row.id);
          if (!request) return;
          pending.get(this)!.delete(row.id);
          if (row.status === 'ok') state.acks.push({ ...request, id: row.id });
          else state.errors.push({ operation: request.operation, id: row.id });
        };
        this.on('message', listener);
        listeners.push({ worker: this, listener });
      }
      if (message.database === database) state.hosts.add(this);
      state.posts.push({
        phase: state.phase,
        operation: message.operation,
        id: message.id,
        ...(message.create === undefined ? {} : { create: message.create }),
      });
      pending.get(this)!.set(message.id, { phase: state.phase, operation: message.operation });
    }
    return Reflect.apply(postMessage, this, args);
  });
  return {
    state,
    pending,
    restore() {
      posting.mockRestore();
      for (const { worker, listener } of listeners) worker.off('message', listener);
    },
  };
}

/** Reads only this fixture's exact managed Source original tree, never a user or credential directory. */
function sourceOriginalBytes(root: string) {
  const files = new Map<string, Buffer>();
  const walk = (relative: string) => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const name = join(relative, entry.name);
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile()) files.set(name, readFileSync(join(root, name)));
      else throw new Error('The Source fixture contains a noncanonical entry.');
    }
  };
  walk('');
  return files;
}

/** Produces the real self-owned Source, Memory page and pending confirmation through public operations. */
async function sourcePreviewFixture() {
  const f = await fixture();
  const path = userDbPath(realpathSync(f.dataRoot), f.userId);
  const native = observePreviewUserNative(path);
  onTestFinished(() => native.restore());
  const sourceText = 'Original personally retained Source bytes.\r\n';
  const registered = await f.call('memory.source.register', {
    requestId: randomUUID(),
    kind: 'document',
    title: 'Preview Source evidence',
    content: sourceText,
  });
  expect(registered.status).toBe(200);
  const source = registered.body.source;
  const read = await f.call('memory.source.read', { sourceId: source.id });
  expect(read).toMatchObject({
    status: 200,
    body: { source: { id: source.id, contentDigest: source.contentDigest, content: sourceText } },
  });
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(f.dataRoot, 'users', f.userId, 'memory', 'notebook.git'),
  });
  const pageId = 'source-preview-preference';
  const content = serializeKnowledgePageFixture(
    {
      title: 'Source-backed preference',
      content: 'Exact captured preference.\r\n',
      sourceReferences: [`source:${source.id}`, `source:${source.id}@${source.contentDigest}`],
      createdAt: '2026-10-17T00:00:00.000Z',
      updatedAt: '2026-10-17T00:00:00.000Z',
    },
    { kind: 'user', userId: f.userId }
  );
  const saved = await f.call('memory.create', {
    requestId: randomUUID(),
    baseRevision: notebook.publishedRevision(),
    pageId,
    content,
    summary: 'Retain the exact Source-backed preference.',
  });
  expect(saved.status).toBe(200);
  const requestId = randomUUID();
  const digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
  const prepared = await f.call('memory.forget.prepare', {
    requestId,
    workspaceId: DEMO_WORKSPACE_ID,
    pageId,
    notebookRevision: saved.body.notebookRevision,
    digest,
  });
  expect(prepared).toMatchObject({
    status: 200,
    body: {
      pendingRequestId: requestId,
      ownerScope: { kind: 'user', userId: f.userId },
      pageId,
      digest,
    },
  });
  expect(native.state.acks.some((row) => row.operation !== 'open')).toBe(true);
  return {
    ...f,
    path,
    native,
    notebook,
    source,
    pageId,
    content,
    digest,
    prepared: prepared.body,
    notebookRevision: saved.body.notebookRevision as string,
  };
}

describe('public Item-confirmed self Memory forget', () => {
  it('denies an absent Workspace before either forget operation creates its storage', async () => {
    const f = await fixture();
    const content = f.content(f.userId, 'Keep this existing personal preference.');
    const saved = await f.call('memory.create', {
      requestId: randomUUID(),
      baseRevision: null,
      pageId: 'preferences',
      content,
      summary: 'Save my preference',
    });
    expect(saved.status).toBe(200);
    const workspaceId = 'ws_00000000-0000-7000-8000-000000000099';
    const directory = join(f.dataRoot, 'workspaces', workspaceId);
    const database = workspaceDbPath(f.dataRoot, workspaceId);
    expect(existsSync(directory)).toBe(false);
    expect(existsSync(database)).toBe(false);
    const requestId = randomUUID();
    const prepared = await f.call('memory.forget.prepare', {
      requestId,
      workspaceId,
      pageId: 'preferences',
      notebookRevision: saved.body.notebookRevision,
      digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    });
    const afterPrepare = { directory: existsSync(directory), database: existsSync(database) };
    const applied = await f.call('memory.forget', {
      requestId,
      pendingRequestId: requestId,
      workspaceId,
      threadId: 'th_00000000-0000-7000-8000-000000000099',
    });
    expect(prepared.status).toBe(403);
    expect(applied.status).toBe(403);
    expect({
      afterPrepare,
      afterForget: { directory: existsSync(directory), database: existsSync(database) },
    }).toEqual({
      afterPrepare: { directory: false, database: false },
      afterForget: { directory: false, database: false },
    });
    expect(await f.call('memory.read', { pageId: 'preferences' })).toMatchObject({
      status: 200,
      body: { page: { content, notebookRevision: saved.body.notebookRevision } },
    });
  });

  it('separates the public approval grant from removal and suppresses public projections while preserving exact replay', async () => {
    const f = await fixture();
    const pageId = 'private-preference';
    const content = f.content(f.userId, 'Exact forgotten preference.\r\n');
    const summary = 'Private save summary that must become unavailable';
    const saved = await f.call('memory.create', {
      requestId: randomUUID(),
      baseRevision: null,
      pageId,
      content,
      summary,
    });
    expect(saved.status).toBe(200);
    const selected = await f.call('memory.read', { pageId });
    const digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    expect(selected).toMatchObject({ status: 200, body: { page: { content, digest } } });
    const requestId = randomUUID();
    const prepared = await f.call('memory.forget.prepare', {
      requestId,
      workspaceId: DEMO_WORKSPACE_ID,
      pageId,
      notebookRevision: saved.body.notebookRevision,
      digest,
    });
    expect(prepared).toMatchObject({
      status: 200,
      body: {
        pendingRequestId: requestId,
        ownerScope: { kind: 'user', userId: f.userId },
        pageId,
        notebookRevision: saved.body.notebookRevision,
        digest,
        workspaceId: DEMO_WORKSPACE_ID,
        threadId: expect.any(String),
        turnId: expect.any(String),
        itemId: expect.any(String),
      },
    });
    const context = { workspaceId: prepared.body.workspaceId, threadId: prepared.body.threadId };
    expect(f.store.getThread(context.workspaceId, context.threadId)).toMatchObject({
      entryPath: 'conversation',
      visibility: 'private',
      privateOwnerUserId: f.userId,
    });
    const turn = f.store.getTurnById(prepared.body.turnId);
    expect(turn).toMatchObject({
      threadId: context.threadId,
      owner: { kind: 'workspace', workspaceId: context.workspaceId },
      triggerActor: { kind: 'user', id: f.userId },
    });
    expect(f.store.getTurnExecutor(turn.id)).toBe('person');
    expect(turn.agentSessionId).toBeUndefined();
    const requestItem = turn.items.find(({ id }) => id === prepared.body.itemId);
    expect(requestItem).toMatchObject({ type: 'approval-request', approvalRequestId: requestId });
    const before = await f.call('thread.dashboard', context);
    expect(before.status).toBe(200);
    const preview = before.body.pendingRequests.find(
      (row: { requestId: string }) => row.requestId === requestId
    ).approvalEffect;
    expect(preview.status).toBe('available');
    expect(JSON.parse(preview.detail)).toMatchObject({
      ownerScope: { kind: 'user', userId: f.userId },
      pageId,
      notebookRevision: saved.body.notebookRevision,
      digest,
      content,
      disclosure: {
        suppression: expect.any(String),
        git: expect.any(String),
        source: expect.any(String),
        evidence: expect.any(String),
        backup: expect.any(String),
      },
    });
    const apply = { requestId, pendingRequestId: prepared.body.pendingRequestId, ...context };
    expect(await f.call('memory.forget', apply)).toMatchObject({
      status: 409,
      body: { code: 'approval_required' },
    });
    const granted = await f.call('approval.respond', {
      requestId: randomUUID(),
      ...context,
      turnId: turn.id,
      approvalRequestId: prepared.body.pendingRequestId,
      decision: 'granted',
    });
    expect(granted.status).toBe(200);
    const notebook = new KnowledgeNotebook({
      repositoryPath: join(f.dataRoot, 'users', f.userId, 'memory', 'notebook.git'),
    });
    expect(notebook.publishedRevision()).toBe(saved.body.notebookRevision);
    expect(await f.call('memory.read', { pageId })).toMatchObject({
      status: 200,
      body: { page: { content, notebookRevision: saved.body.notebookRevision } },
    });
    const removed = await f.call('memory.forget', apply);
    expect(removed).toMatchObject({
      status: 200,
      body: {
        outcome: 'published',
        ownerScope: { kind: 'user', userId: f.userId },
        baseRevision: saved.body.notebookRevision,
        changedPageIds: [pageId],
        receiptRef: { operation: 'knowledge.notebook.delete', requestId },
      },
    });
    expect(notebook.publishedRevision()).toBe(removed.body.notebookRevision);
    expect(
      notebook.readRevision(removed.body.notebookRevision).files[`${pageId}.md`]
    ).toBeUndefined();
    expect(notebook.readRevision(saved.body.notebookRevision).files[`${pageId}.md`]).toBe(content);
    expect(await f.call('memory.read', { pageId })).toMatchObject({
      status: 200,
      body: { page: null },
    });
    expect(await f.call('memory.list')).toMatchObject({ status: 200, body: { pages: [] } });
    const after = await f.call('thread.dashboard', context);
    expect(after.status).toBe(200);
    expect(
      after.body.pendingRequests.find((row: { requestId: string }) => row.requestId === requestId)
    ).toMatchObject({
      state: 'resolved',
      resolution: 'granted',
      approvalEffect: { status: 'unavailable' },
    });
    expect(JSON.stringify(after.body)).not.toContain('Exact forgotten preference.');
    const history = await f.call('memory.notebook.history');
    expect(history.status).toBe(200);
    expect(
      history.body.revisions.find(
        (row: { revision: string }) => row.revision === saved.body.notebookRevision
      )
    ).toMatchObject({ availability: 'unavailable' });
    expect(JSON.stringify(history.body)).not.toContain(summary);
    expect(JSON.stringify(history.body)).not.toContain(`${pageId}.md`);
    expect(JSON.stringify(history.body)).not.toContain('Exact forgotten preference.');
    const historicalDiff = await f.call('memory.notebook.diff', {
      baseRevision: removed.body.notebookRevision,
      fromRevision: saved.body.notebookRevision,
      pageIds: [pageId],
    });
    expect(historicalDiff.status).toBe(404);
    expect(JSON.stringify(historicalDiff.body)).not.toContain('Exact forgotten preference.');
    const restore = await f.call('memory.notebook.restore', {
      requestId: randomUUID(),
      baseRevision: removed.body.notebookRevision,
      fromRevision: saved.body.notebookRevision,
      pageIds: [pageId],
      summary: 'Try restoring forgotten content',
    });
    expect(restore.status).toBe(404);
    expect(JSON.stringify(restore.body)).not.toContain('Exact forgotten preference.');
    expect(notebook.publishedRevision()).toBe(removed.body.notebookRevision);
    const laterContent = f.content(f.userId, 'A later explicit preference.');
    const later = await f.call('memory.create', {
      requestId: randomUUID(),
      baseRevision: removed.body.notebookRevision,
      pageId: 'new-preference',
      content: laterContent,
      summary: 'Save a new preference',
    });
    expect(later.status).toBe(200);
    expect(await f.call('memory.forget', apply)).toEqual(removed);
    expect(notebook.publishedRevision()).toBe(later.body.notebookRevision);
    expect(await f.call('memory.read', { pageId: 'new-preference' })).toMatchObject({
      status: 200,
      body: { page: { content: laterContent } },
    });
  });

  it('keeps two current authenticated selves separate and refuses foreign selectors and unauthenticated access', async () => {
    const f = await fixture();
    const otherUserId = 'usr_00000000-0000-7000-8000-000000000002';
    const now = new Date().toISOString();
    f.coreDb.sqlite
      .prepare(
        "INSERT INTO users (id, kind, display_name, email, email_verified, created_at, updated_at) VALUES (?, 'human', 'Other fixture', ?, 0, ?, ?)"
      )
      .run(otherUserId, [otherUserId, 'example.invalid'].join('@'), now, now);
    const server = createApp({
      mode: 'server',
      coreDb: f.coreDb,
      dataRoot: f.dataRoot,
      store: f.store,
    });
    const own = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: f.userId,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const other = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: otherUserId,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    for (const [userId, issued, body] of [
      [f.userId, own, 'First private preference.'],
      [otherUserId, other, 'Second private preference.'],
    ] as const) {
      const authorization = `Bearer ${issued.secret}`;
      const content = f.content(userId, body);
      const saved = await f.call(
        'memory.create',
        {
          requestId: randomUUID(),
          baseRevision: null,
          pageId: 'same-id',
          content,
          summary: 'Save my own preference',
        },
        server,
        authorization
      );
      expect(saved).toMatchObject({
        status: 200,
        body: { ownerScope: { kind: 'user', userId } },
      });
    }
    const first = await f.call(
      'memory.read',
      { pageId: 'same-id' },
      server,
      `Bearer ${own.secret}`
    );
    const second = await f.call(
      'memory.read',
      { pageId: 'same-id' },
      server,
      `Bearer ${other.secret}`
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.page.content).toBe(f.content(f.userId, 'First private preference.'));
    expect(second.body.page.content).toBe(f.content(otherUserId, 'Second private preference.'));
    expect(
      await f.call(
        'memory.read',
        { pageId: 'same-id', userId: otherUserId },
        server,
        `Bearer ${own.secret}`
      )
    ).toMatchObject({ status: 403, body: { code: 'bound_input_conflict' } });
    const denied = await f.call('memory.read', { pageId: 'same-id' }, server);
    expect(denied.status).toBe(401);
    expect(JSON.stringify(denied.body)).not.toContain('private preference.');
  });
  it.each(['policy', 'acknowledged-host-dead'] as const)(
    'keeps actual public self Source preview authority and bytes with %s User storage',
    async (scenario) => {
      const f = await sourcePreviewFixture();
      const inode = statSync(f.path);
      const beforeNotebook = f.notebook.readRevision(f.notebookRevision).files;
      const originalRoot = join(f.dataRoot, 'users', f.userId, 'memory', 'raw');
      const originalBytes = sourceOriginalBytes(originalRoot);
      expect(originalBytes.size).toBeGreaterThan(0);
      if (scenario === 'acknowledged-host-dead') {
        // The actual acknowledged User owner is selected by its genuine protocol, never a host index.
        expect(f.native.state.hosts.size).toBe(1);
        await [...f.native.state.hosts][0]!.terminate();
      }
      const observed = observeSourcePreviewReader(f.path);
      try {
        f.native.state.phase = 'preview';
        const dashboard = await f.call('thread.dashboard', {
          workspaceId: f.prepared.workspaceId,
          threadId: f.prepared.threadId,
        });
        expect(dashboard.status).toBe(200);
        const pending = dashboard.body.pendingRequests.find(
          (row: { requestId: string }) => row.requestId === f.prepared.pendingRequestId
        );
        expect(pending.approvalEffect.status).toBe('available');
        expect(JSON.parse(pending.approvalEffect.detail)).toMatchObject({
          operation: 'memory.forget',
          ownerScope: { kind: 'user', userId: f.userId },
          pageId: f.pageId,
          notebookRevision: f.notebookRevision,
          digest: f.digest,
          content: f.content,
          sourceFingerprints: [`source:${f.source.id}@${f.source.contentDigest}`],
          disclosure: { source: expect.stringContaining('Registered Source versions') },
        });
        observed.restore();
        expect(f.notebook.publishedRevision()).toBe(f.notebookRevision);
        expect(f.notebook.readRevision(f.notebookRevision).files).toEqual(beforeNotebook);
        expect(sourceOriginalBytes(originalRoot)).toEqual(originalBytes);
        expect({ dev: statSync(f.path).dev, ino: statSync(f.path).ino }).toEqual({
          dev: inode.dev,
          ino: inode.ino,
        });
        const previewOpens = f.native.state.posts.filter(
          (row) => row.phase === 'preview' && row.operation === 'open'
        );
        // Existing-only native participation may be legitimate. Creation is not read admission.
        expect(previewOpens.every((row) => row.create === false)).toBe(true);
        f.native.state.phase = 'final-native-close';
        await shutdownControlStoreWorkerClient();
        if (scenario !== 'acknowledged-host-dead')
          expect(
            f.native.state.acks.some(
              (row) => row.phase === 'final-native-close' && row.operation === 'shutdown'
            )
          ).toBe(true);
        expect(f.native.state.errors).toEqual([]);
        expect([...f.native.pending.values()].every((requests) => requests.size === 0)).toBe(true);
        expect(observed.readers.size).toBeGreaterThan(0);
        expect(observed.businessReaders.size).toBeGreaterThan(0);
        expect(observed.closed).toHaveLength(observed.readers.size);
        for (const [reader, ready] of observed.readers) {
          expect(ready).toEqual({ readonly: true, queryOnly: 1 });
          expect(observed.closed.filter((row) => row.reader === reader)).toEqual([
            {
              reader,
              readonly: true,
              queryOnly: 1,
              code: 'SQLITE_READONLY',
              unchanged: true,
              closed: true,
              observationError: undefined,
            },
          ]);
          expect(reader.open).toBe(false);
        }
      } finally {
        observed.restore();
        f.native.restore();
      }
    }
  );
});

// Drain and stop the native fixture owner before the next test can remove or reuse its roots.
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
});

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { KnowledgeNotebook } from './knowledge/notebook.js';
import { closeRetrievalServices } from './retrieval-service.js';
import { openCoreDb } from './storage/db.js';
import { workspaceDbPath } from './storage/fs-layout.js';
import { applyMigrations } from './storage/migrate.js';
import { serializeUserAuthoredKnowledgePage } from './storage/workspace-file-records.js';
import { createApp } from './test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from './test-support/demo-store.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/** Exercises actual Memory and approval HTTP handlers with canonical SQLite/Git and synthetic User authority. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'memory-forget-public-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = createDemoStore({ dataRoot });
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
  const content = (ownerUserId: string, pageId: string, body: string) =>
    serializeUserAuthoredKnowledgePage(
      {
        id: pageId,
        kind: 'preference',
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

describe('public Item-confirmed self Memory forget', () => {
  it('denies an absent Workspace before either forget operation creates its storage', async () => {
    const f = fixture();
    const content = f.content(f.userId, 'preferences', 'Keep this existing personal preference.');
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
    const f = fixture();
    const pageId = 'private-preference';
    const content = f.content(f.userId, pageId, 'Exact forgotten preference.\r\n');
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
      ...context,
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
        receiptRef: { operation: 'knowledge.delete', requestId },
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
    const laterContent = f.content(f.userId, 'new-preference', 'A later explicit preference.');
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
    const f = fixture();
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
      const content = f.content(userId, 'same-id', body);
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
    expect(first.body.page.content).toBe(
      f.content(f.userId, 'same-id', 'First private preference.')
    );
    expect(second.body.page.content).toBe(
      f.content(otherUserId, 'same-id', 'Second private preference.')
    );
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
});

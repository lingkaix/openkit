// openkit-test-platform: posix

import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { KnowledgeNotebook } from './knowledge/notebook.js';
import { FsStore } from './lib/store.js';
import { admitOperation } from './operation-resolvers.js';
import { closeRetrievalServices } from './retrieval-service.js';
import { openCoreDb } from './storage/db.js';
import { userMemoryRoot } from './storage/fs-layout.js';
import { applyMigrations } from './storage/migrate.js';
import { serializeUserAuthoredKnowledgePage } from './storage/workspace-file-records.js';
import { createApp } from './test-support/app.js';
import { testEntityId } from './test-support/entity-ids.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/** Real bearer authentication selects each User; every page is published through the public operation. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'memory-search-public-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userIds = [
    testEntityId('usr', 'memory-search-alice'),
    testEntityId('usr', 'memory-search-bob'),
  ];
  const now = '2026-10-17T00:00:00.000Z';
  const credentials = userIds.map((userId) => {
    coreDb.sqlite
      .prepare(
        "INSERT INTO users (id, kind, display_name, email, email_verified, created_at, updated_at, status) VALUES (?, 'human', 'Memory search fixture', ?, 0, ?, ?, 'active')"
      )
      .run(userId, `${userId}@example.invalid`, now, now);
    return createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: userId,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
  });
  const store = new FsStore({ dataRoot });
  const app = createApp({ coreDb, dataRoot, store, mode: 'server' });
  const workspace = store.createWorkspace('Memory query context', {
    requestId: randomUUID(),
    producer: { kind: 'user', id: userIds[0]! },
    instructionReference: 'test-fixture:memory-search-context',
  });
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userIds[0]! });
  onTestFinished(async () => {
    await closeRetrievalServices();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const call = async (user: number, operation: string, input: Record<string, unknown>) => {
    const { requestId, ...body } = input;
    const response = await app.request(`https://localhost/api/app/operations/${operation}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${credentials[user]!.secret}`,
        ...(requestId ? { 'x-openkit-request-id': String(requestId) } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const content = (user: number, id: string, body: string) =>
    serializeUserAuthoredKnowledgePage(
      {
        id,
        kind: 'preference',
        title: 'My saved preference',
        content: body,
        sourceReferences: [],
        createdAt: now,
        updatedAt: now,
      },
      { kind: 'user', userId: userIds[user]! }
    );
  return { call, content, coreDb, dataRoot, store, userIds, workspace };
}

describe('public self Memory search', () => {
  it('uses the authenticated User private Timeline and returns exact Kernel selections without widening scope', async () => {
    const f = fixture();
    const pages = new Map<string, string>();
    let baseRevision: string | null = null;
    for (let index = 0; index < 6; index += 1) {
      const pageId = `preference-${index}`;
      const content = f.content(0, pageId, 'I prefer auroramarker explanations.\r\n');
      const saved = await f.call(0, 'memory.create', {
        requestId: randomUUID(),
        baseRevision,
        pageId,
        content,
        summary: 'Save my explicit preference',
      });
      expect(saved.status).toBe(200);
      baseRevision = saved.body.notebookRevision;
      pages.set(pageId, content);
    }
    const foreign = await f.call(1, 'memory.create', {
      requestId: randomUUID(),
      baseRevision: null,
      pageId: 'preference-0',
      content: f.content(1, 'preference-0', 'auroramarker foreign-private-body'),
      summary: 'Save another User preference',
    });
    expect(foreign.status).toBe(200);
    const request = { workspaceId: f.workspace.id, query: 'auroramarker' };

    // A shared conversation cannot supply the private recall context or cause search to create one.
    f.store.createThread(f.workspace.id, 'Shared conversation', undefined, 'conversation');
    const withoutTimeline = await f.call(0, 'memory.search', request);
    expect([400, 403]).toContain(withoutTimeline.status);
    expect(withoutTimeline.body).not.toHaveProperty('selected');
    expect(f.store.listThreads(f.workspace.id)).toHaveLength(1);
    const timeline = f.store.createThread(
      f.workspace.id,
      'My private Assistant Timeline',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: f.userIds[0]! }
    );
    const result = await f.call(0, 'memory.search', request);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      workspaceId: f.workspace.id,
      queryContext: {
        workspaceId: f.workspace.id,
        actor: { kind: 'user', id: f.userIds[0] },
        threadId: timeline.id,
      },
      sourceScope: `page/user/${f.userIds[0]}`,
      notebookRevision: baseRevision,
      retrievalParameters: { limit: 5, states: ['active'] },
    });
    expect(result.body.selected).toHaveLength(5);
    expect(result.body.retrievalTraceRef).toEqual({
      scopeId: `retrieval-trace/thread/${f.workspace.id}/${timeline.id}`,
      objectId: expect.stringMatching(/^krt_/),
    });
    const notebook = new KnowledgeNotebook({
      repositoryPath: join(userMemoryRoot(f.dataRoot, f.userIds[0]!), 'notebook.git'),
    });
    const canonical = notebook.readRevision(baseRevision!);
    for (const selected of result.body.selected) {
      const content = pages.get(selected.reference.objectId);
      expect(content).toBeDefined();
      expect(canonical.files[`${selected.reference.objectId}.md`]).toBe(content);
      expect(selected).toMatchObject({
        reference: { scopeId: `page/user/${f.userIds[0]}` },
        revision: baseRevision,
        contentDigest: `sha256:${createHash('sha256').update(content!).digest('hex')}`,
        sourceReferences: [],
      });
    }
    const tracesRoot = join(
      f.dataRoot,
      'workspaces',
      f.workspace.id,
      'threads',
      timeline.id,
      'retrieval-traces'
    );
    const traceBytes = readFileSync(
      join(tracesRoot, `${result.body.retrievalTraceRef.objectId}.json`),
      'utf8'
    );
    const trace = JSON.parse(traceBytes);
    expect(trace).toMatchObject({
      traceId: result.body.retrievalTraceRef.objectId,
      queryContext: result.body.queryContext,
      sourceScope: `page/user/${f.userIds[0]}`,
      notebookRevision: baseRevision,
      requestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(trace.selected).toEqual(
      result.body.selected.map(({ score: _score, ...fact }: { score: number }) => fact)
    );
    expect(traceBytes).not.toContain('auroramarker');
    expect(traceBytes).not.toContain(f.userIds[1]!);
    expect(JSON.stringify(result.body)).not.toContain('foreign-private-body');

    const pin = { scopeId: `page/user/${f.userIds[0]}`, objectId: 'preference-5' };
    const pinned = await f.call(0, 'memory.search', {
      ...request,
      limit: 1,
      pinnedReferences: [pin],
      states: ['active'],
    });
    expect(pinned.status).toBe(200);
    expect(pinned.body.selected.map((row: { reference: unknown }) => row.reference)).toEqual([pin]);
    const traceFiles = readdirSync(tracesRoot).sort();
    for (const extension of [
      { userId: f.userIds[1] },
      { sourceScope: 'server' },
      { scopeId: `page/user/${f.userIds[1]}` },
      { caller: 'task-mode' },
      { limit: 0 },
      { limit: 21 },
      { pinnedReferences: [{ ...pin, scopeId: `page/user/${f.userIds[1]}` }] },
    ]) {
      const refused = await f.call(0, 'memory.search', { ...request, ...extension });
      expect([400, 403]).toContain(refused.status);
      expect(refused.body).not.toHaveProperty('selected');
    }
    expect((await f.call(0, 'memory.search', { query: request.query })).status).toBe(400);
    expect(readdirSync(tracesRoot).sort()).toEqual(traceFiles);

    // Workers fail the real credential gate before any unproved package lineage can be consumed.
    const definition = OPERATION_DEFINITIONS['memory.search'];
    expect(definition.credentials).not.toContain('worker-package');
    expect(() =>
      admitOperation(
        definition,
        request,
        {
          kind: 'worker',
          actor: { kind: 'agent', id: 'search-probe-worker', responsibleUserId: f.userIds[0]! },
          requestId: randomUUID(),
          bindings: {},
          lineage: {
            workspaceId: f.workspace.id,
            threadId: timeline.id,
            turnId: testEntityId('tu', 'memory-search-unproved-turn'),
            agentSessionId: testEntityId('as', 'memory-search-unproved-session'),
            packageSnapshotId: 'unproved-package',
          },
        },
        { coreDb: f.coreDb, store: f.store }
      )
    ).toThrowError(expect.objectContaining({ code: 'workspace_access_denied', status: 403 }));
    expect(readdirSync(tracesRoot).sort()).toEqual(traceFiles);
    expect(notebook.publishedRevision()).toBe(baseRevision);
    expect(f.store.listThreadTurns(f.workspace.id, timeline.id)).toEqual([]);
  });
});

// openkit-test-platform: posix

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeConfigManager } from './config/runtime-config.js';
import { FsStore } from './lib/store.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { operationRequest } from './test-support/operation-request.js';
import { readTestWorkspaceNotebookSelection } from './test-support/workspace-notebook.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const fixtures: Array<Awaited<ReturnType<typeof fixture>>> = [];

/** Real current identity, configuration, SQLite receipts and Git content share one isolated scope. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-notebook-page-admission-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Notebook admission', {
    requestId: randomUUID(),
    producer: { kind: 'user', id: userId },
    instructionReference: 'Create an isolated Notebook admission fixture',
  });
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  applyScopedMigrations(workspaceDb);
  const f = {
    dataRoot,
    coreDb,
    workspaceDb,
    store,
    userId,
    workspaceId: workspace.id,
    repositoryPath: join(dataRoot, 'workspaces', workspace.id, 'knowledge', 'notebook.git'),
    app: createApp({
      coreDb,
      dataRoot,
      store,
      runtimeConfigManager: createRuntimeConfigManager({ dataRoot }),
    }),
  };
  fixtures.push(f);
  return f;
}

/** Observe immutable publication independently of the API projection. */
function git(f: Awaited<ReturnType<typeof fixture>>, ...args: string[]): string {
  return execFileSync('git', ['--git-dir', f.repositoryPath, ...args], { encoding: 'utf8' });
}

/** Digest the exact selected page rather than a body-only projection. */
function digest(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/** Submit public native commands with the actual local actor and request identity. */
async function call(
  f: Awaited<ReturnType<typeof fixture>>,
  operation: string,
  input: Record<string, unknown> = {}
) {
  const { requestId, ...body } = input;
  const response = await f.app.request(`/api/app/operations/${operation}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(requestId ? { 'x-openkit-request-id': String(requestId) } : {}),
    },
    body: JSON.stringify({ workspaceId: f.workspaceId, ...body }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: response.headers.get('content-type')?.includes('application/json')
      ? JSON.parse(text)
      : text,
  };
}

/** Full authored OKF bytes retain the exact registered Source when selected. */
function page(f: Awaited<ReturnType<typeof fixture>>, sourceReferences: string[] = []): string {
  return [
    '---',
    'type: KnowledgePage',
    'title: Admission note',
    'schema_version: openkit-scope-knowledge-schema-v4',
    'requiredFeatures: [openkit.knowledge-owner-scope.v1, openkit.knowledge-git-notebook.v1]',
    'openkit_status: active',
    'status: stable',
    `scope: {kind: workspace, workspaceId: ${f.workspaceId}}`,
    `source_refs: ${JSON.stringify(sourceReferences)}`,
    'review_state: user-authored',
    'sensitivity: normal',
    'freshness: current',
    'created_at: "2026-10-19T00:00:00.000Z"',
    'updated_at: "2026-10-19T00:00:00.000Z"',
    '---',
    'SOURCE-BACKED-PAGE-MARKER',
    '',
  ].join('\n');
}

/** Establish successful native publication and a matching full-page read before injecting a failure. */
async function createPage(f: Awaited<ReturnType<typeof fixture>>, sourceReferences: string[] = []) {
  const request = {
    requestId: randomUUID(),
    baseRevision: readTestWorkspaceNotebookSelection(f.dataRoot, f.workspaceId).head.notebookCommit,
    path: 'notes/admission.md',
    content: page(f, sourceReferences),
    summary: 'Create admission note',
  };
  const result = await call(f, 'knowledge.notebook.create', request);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(result.body).toMatchObject({
    outcome: 'published',
    receiptRef: { operation: 'knowledge.notebook.create', requestId: request.requestId },
  });
  const revision = result.body.notebookRevision as string;
  const content = git(f, 'show', `${revision}:pages/${request.path}`);
  const listed = await call(f, 'knowledge.notebook.list');
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  expect(listed.body).toMatchObject({
    notebookRevision: revision,
    pages: [{ id: 'notes/admission', path: request.path, content, contentDigest: digest(content) }],
  });
  return { request, result, revision, content };
}

/** The selected full-page bytes and current base define one exact confirmed deletion. */
function removal(created: Awaited<ReturnType<typeof createPage>>) {
  return {
    requestId: randomUUID(),
    baseRevision: created.revision,
    path: created.request.path,
    expectedContentDigest: digest(created.content),
    confirmRemoval: true,
    summary: 'Remove the inspected page; history remains',
  };
}

/** Applies an exact Source Thread audience through the current request, decision and configuration owners. */
async function restrictSourceThread(
  f: {
    dataRoot: string;
    coreDb: ReturnType<typeof openCoreDb>;
    store: FsStore;
    workspaceId: string;
    userId: string;
  },
  sourceThreadId: string
) {
  const manager = createRuntimeConfigManager({ dataRoot: f.dataRoot });
  const app = createApp({
    coreDb: f.coreDb,
    dataRoot: f.dataRoot,
    store: f.store,
    runtimeConfigManager: manager,
  });
  const decisionThread = await f.store.createThread(f.workspaceId, 'Source policy decision');
  const owner = { kind: 'workspace' as const, workspaceId: f.workspaceId };
  const scope = {
    subjects: [],
    actions: [],
    resources: [{ kind: 'container', container: { owner, kind: 'thread', id: sourceThreadId } }],
  };
  const common = {
    author: { kind: 'human', id: f.userId },
    authority: { kind: 'human', userId: f.userId },
    authoredAt: new Date().toISOString(),
    state: 'active',
    lifetime: { anchor: { owner, kind: 'workspace', id: f.workspaceId } },
  };
  const statements = [
    { ...common, id: 'source-current-audience', kind: 'managed-boundary', scope },
  ];
  const requested = await app.request(
    ...operationRequest(
      'workspace.resource-access-request',
      {
        workspaceId: f.workspaceId,
        threadId: decisionThread.id,
        change: {
          resource: { family: 'thread', id: sourceThreadId },
          replacement: { schemaVersion: 1, statements },
        },
      },
      { body: JSON.stringify({ requestId: randomUUID() }) }
    )
  );
  expect(requested.status, await requested.clone().text()).toBe(200);
  const request = (await requested.json()) as { id: string };
  await f.store.applyPendingRequestCommand(f.workspaceId, {
    action: 'grant-command',
    workspaceId: f.workspaceId,
    threadId: decisionThread.id,
    requestId: request.id,
    actor: { kind: 'user', id: f.userId },
    now: new Date().toISOString(),
    decisionContext: { kind: 'local', userId: f.userId },
  });
  const applied = await app.request(
    ...operationRequest('workspace.resource-access-apply', {
      workspaceId: f.workspaceId,
      threadId: decisionThread.id,
      approvalRequestId: request.id,
      confirmation: 'APPLY WORKSPACE RESOURCE POLICY',
    })
  );
  expect(applied.status, await applied.clone().text()).toBe(200);
  expect(await applied.json()).toMatchObject({ reloadStatus: 'applied' });
}

afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const f of fixtures.splice(0)) {
    if (f.workspaceDb.sqlite.open) f.workspaceDb.sqlite.close();
    if (f.coreDb.sqlite.open) f.coreDb.sqlite.close();
    rmSync(f.dataRoot, { recursive: true, force: true });
  }
});

describe('Notebook page commands retain current Source and request identity admission', () => {
  it.each([
    'new deletion',
    'completed deletion replay',
  ] as const)('rechecks the current originating Source audience for %s', async (stage) => {
    const f = await fixture();
    const origin = await f.store.createThread(f.workspaceId, 'Initially shared Source');
    expect(origin.visibility).toBe('workspace');
    const registered = await call(f, 'knowledge.source.register', {
      requestId: randomUUID(),
      kind: 'document',
      title: 'Shared Source',
      content: 'SOURCE-CONTROL-MARKER',
      originatingThreadId: origin.id,
    });
    expect(registered.status, JSON.stringify(registered.body)).toBe(200);
    expect(registered.body.source).toMatchObject({
      originatingThreadId: origin.id,
      contentDigest: digest('SOURCE-CONTROL-MARKER'),
    });
    const sourceRead = await call(f, 'knowledge.source.read', {
      sourceId: registered.body.source.id,
    });
    expect(sourceRead.status, JSON.stringify(sourceRead.body)).toBe(200);
    const created = await createPage(f, [
      `source:${registered.body.source.id}@${registered.body.source.contentDigest}`,
    ]);
    const request = removal(created);
    let expectedRevision = created.revision;
    if (stage === 'completed deletion replay') {
      const removed = await call(f, 'knowledge.notebook.delete', request);
      expect(removed.status, JSON.stringify(removed.body)).toBe(200);
      expect(removed.body).toMatchObject({
        outcome: 'published',
        receiptRef: { operation: 'knowledge.notebook.delete', requestId: request.requestId },
      });
      expectedRevision = removed.body.notebookRevision;
      expect(await call(f, 'knowledge.notebook.delete', request)).toEqual(removed);
      expect(
        git(f, 'ls-tree', '-r', '--name-only', expectedRevision, 'pages/notes/admission.md')
      ).toBe('');
    }
    await restrictSourceThread(f, origin.id);
    expect(f.store.getThread(f.workspaceId, origin.id).visibility).toBe('workspace');
    const denied = await call(f, 'knowledge.notebook.delete', request);
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(denied.body).toMatchObject({ code: 'workspace_access_denied' });
    expect(JSON.stringify(denied.body)).not.toContain('SOURCE-BACKED-PAGE-MARKER');
    expect(readTestWorkspaceNotebookSelection(f.dataRoot, f.workspaceId).head.notebookCommit).toBe(
      expectedRevision
    );
    expect(git(f, 'show', `${created.revision}:pages/${request.path}`)).toBe(created.content);
  });

  it('returns the request identity conflict when a completed create collides with its now-existing path', async () => {
    const f = await fixture();
    const created = await createPage(f);
    expect(await call(f, 'knowledge.notebook.create', created.request)).toEqual(created.result);
    const collision = await call(f, 'knowledge.notebook.create', {
      ...created.request,
      baseRevision: created.revision,
    });
    expect(collision.status, JSON.stringify(collision.body)).toBe(409);
    expect(collision.body).toMatchObject({ code: 'idempotency_key_conflict' });
    expect(readTestWorkspaceNotebookSelection(f.dataRoot, f.workspaceId).head.notebookCommit).toBe(
      created.revision
    );
    expect(await call(f, 'knowledge.notebook.create', created.request)).toEqual(created.result);
  });

  it('returns the request identity conflict before changed digest checks on a completed delete', async () => {
    const f = await fixture();
    const created = await createPage(f);
    const request = removal(created);
    const removed = await call(f, 'knowledge.notebook.delete', request);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(await call(f, 'knowledge.notebook.delete', request)).toEqual(removed);
    const collision = await call(f, 'knowledge.notebook.delete', {
      ...request,
      expectedContentDigest: `sha256:${'0'.repeat(64)}`,
    });
    expect(collision.status, JSON.stringify(collision.body)).toBe(409);
    expect(collision.body).toMatchObject({ code: 'idempotency_key_conflict' });
    expect(readTestWorkspaceNotebookSelection(f.dataRoot, f.workspaceId).head.notebookCommit).toBe(
      removed.body.notebookRevision
    );
    expect(await call(f, 'knowledge.notebook.delete', request)).toEqual(removed);
  });
});

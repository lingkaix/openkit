import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoreClient } from '@openkit/core-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeConfigManager } from './config/runtime-config.js';
import { parseOkfDocument, updateOkfFrontmatter } from './knowledge/okf.js';
import { FsStore } from './lib/store.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createApp, createLoopbackAppFetch } from './test-support/app.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from './test-support/demo-store.js';
import {
  ensureLocalUser,
  FIXTURE_LOCAL_USER_ID as LOCAL_USER_ID,
} from './test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const OWNER_SCOPE = { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID } as const;
const OPERATION = 'knowledge.notebook.update';

/** Restricts the exact retained Source Thread through the real request, grant and apply owners. */
async function restrictSourceThread(
  f: { dataRoot: string; coreDb: ReturnType<typeof openCoreDb>; store: FsStore },
  threadId: string
) {
  const manager = createRuntimeConfigManager({ dataRoot: f.dataRoot });
  const app = createApp({
    coreDb: f.coreDb,
    dataRoot: f.dataRoot,
    store: f.store,
    runtimeConfigManager: manager,
  });
  const client = createCoreClient({
    baseUrl: 'http://test.invalid',
    fetch: createLoopbackAppFetch(app),
  });
  const decision = await f.store.createThread(DEMO_WORKSPACE_ID, 'Source policy decision');
  const owner = { kind: 'workspace' as const, workspaceId: DEMO_WORKSPACE_ID };
  const requested = await client.operations['workspace.resource-access-request']({
    workspaceId: DEMO_WORKSPACE_ID,
    threadId: decision.id,
    requestId: crypto.randomUUID(),
    change: {
      resource: { family: 'thread', id: threadId },
      replacement: {
        schemaVersion: 1,
        statements: [
          {
            id: 'source-current-audience',
            kind: 'managed-boundary',
            author: { kind: 'human', id: LOCAL_USER_ID },
            authority: { kind: 'human', userId: LOCAL_USER_ID },
            authoredAt: new Date().toISOString(),
            state: 'active',
            lifetime: { anchor: { owner, kind: 'workspace', id: DEMO_WORKSPACE_ID } },
            scope: {
              subjects: [],
              actions: [],
              resources: [
                { kind: 'container', container: { owner, kind: 'thread', id: threadId } },
              ],
            },
          },
        ],
      },
    },
  });
  await f.store.applyPendingRequestCommand(DEMO_WORKSPACE_ID, {
    action: 'grant-command',
    workspaceId: DEMO_WORKSPACE_ID,
    threadId: decision.id,
    requestId: requested.id,
    actor: { kind: 'user', id: LOCAL_USER_ID },
    now: new Date().toISOString(),
    decisionContext: { kind: 'local', userId: LOCAL_USER_ID },
  });
  const applied = await client.operations['workspace.resource-access-apply']({
    workspaceId: DEMO_WORKSPACE_ID,
    threadId: decision.id,
    approvalRequestId: requested.id,
    confirmation: 'APPLY WORKSPACE RESOURCE POLICY',
  });
  if (applied.reloadStatus !== 'applied') throw new Error('Source restriction was not applied.');
}

/** Exact public result facts; the receipt points to this immutable commit rather than current pages. */
interface Published {
  outcome: 'published';
  ownerScope: typeof OWNER_SCOPE;
  baseRevision: string;
  notebookRevision: string;
  changedPageIds: string[];
  receiptRef: { operation: string; requestId: string; ownerScope: typeof OWNER_SCOPE };
}

/** One direct editor submission; HTTP carries request identity in the shared header. */
interface Edit {
  requestId: string;
  baseRevision: string;
  changes: Array<{ path: string; content: string | null }>;
  summary: string;
}

const fixtures: Array<ReturnType<typeof fixture>> = [];

/** Compose actual public admission, Store, SQLite and Git through the existing fresh-scope initializer. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-notebook-publication-'));
  const coreDb = openCoreDb(dataRoot);
  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({
      coreDb,
      workspaceId: DEMO_WORKSPACE_ID,
      ownerUserId: LOCAL_USER_ID,
    });
    const workspaceDb = openWorkspaceDb(dataRoot, DEMO_WORKSPACE_ID);
    applyScopedMigrations(workspaceDb);
    const f = {
      dataRoot,
      coreDb,
      store,
      workspaceDb,
      app: createApp({ coreDb, dataRoot, store }),
      repositoryPath: join(dataRoot, 'workspaces', DEMO_WORKSPACE_ID, 'knowledge', 'notebook.git'),
    };
    fixtures.push(f);
    return f;
  } catch (error) {
    coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { recursive: true, force: true });
    throw error;
  }
}

/** Reopen retained product owners without reseeding, initializing Git, or repairing command evidence. */
function reopen(f: ReturnType<typeof fixture>) {
  f.workspaceDb.sqlite.close();
  f.coreDb.sqlite.close();
  f.coreDb = openCoreDb(f.dataRoot);
  applyMigrations(f.coreDb);
  f.workspaceDb = openWorkspaceDb(f.dataRoot, DEMO_WORKSPACE_ID);
  applyScopedMigrations(f.workspaceDb);
  f.store = new FsStore({ dataRoot: f.dataRoot });
  f.app = createApp({ coreDb: f.coreDb, dataRoot: f.dataRoot, store: f.store });
}

/** Native read-only Git observations do not use the publisher's tree or metadata reader. */
function git(f: ReturnType<typeof fixture>, args: string[]): string {
  return execFileSync('git', ['--git-dir', f.repositoryPath, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      LANG: 'C',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
}

/** Fix page expectations from the accepted v4 profile, including unknown metadata that must survive. */
function page(id: string, body: string): string {
  return [
    '---',
    'type: KnowledgePage',
    `title: ${JSON.stringify(id)}`,
    'schema_version: openkit-scope-knowledge-schema-v4',
    'requiredFeatures: [openkit.knowledge-owner-scope.v1, openkit.knowledge-git-notebook.v1]',
    'openkit_status: active',
    'status: stable',
    `scope: {kind: workspace, workspaceId: ${DEMO_WORKSPACE_ID}}`,
    'source_refs: []',
    'review_state: user-authored',
    'sensitivity: normal',
    'freshness: current',
    `openkit_entry_id: ${id}`,
    'created_at: "2026-10-16T00:00:00.000Z"',
    'updated_at: "2026-10-16T00:00:00.000Z"',
    'custom: {preserved: [one, two]}',
    '---',
    body,
    '',
  ].join('\n');
}

/** Read the public pinned revision; missing initialization is a product failure, never a fake base. */
async function listing(f: ReturnType<typeof fixture>) {
  const response = await f.app.request('/api/app/operations/knowledge.notebook.list', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: DEMO_WORKSPACE_ID }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    notebookRevision: string;
    knowledgeBaseId: string;
    pages: Array<{ id: string; path: string; content: string; contentDigest: string }>;
  };
  expect(body, 'fresh scope initialization must expose its actual published Git revision').toEqual(
    expect.objectContaining({
      notebookRevision: expect.any(String),
      knowledgeBaseId: expect.any(String),
      pages: expect.any(Array),
    })
  );
  expect(body.notebookRevision).not.toBe('');
  return body;
}

/** Execute the derived public JSON route with its actual input and current authority. */
async function submit(f: ReturnType<typeof fixture>, edit: Edit) {
  const { requestId, ...body } = edit;
  const response = await f.app.request(`/api/app/operations/${OPERATION}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-openkit-request-id': requestId },
    body: JSON.stringify({ workspaceId: DEMO_WORKSPACE_ID, ...body }),
  });
  return { status: response.status, body: await response.json() };
}

/** Require success evidence before treating a prepared object or trace as a publication. */
async function publish(f: ReturnType<typeof fixture>, edit: Edit): Promise<Published> {
  const response = await submit(f, edit);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body).toEqual({
    outcome: 'published',
    ownerScope: OWNER_SCOPE,
    baseRevision: edit.baseRevision,
    notebookRevision: expect.any(String),
    changedPageIds: edit.changes.map(({ path }) => path.slice(0, -3)).sort(),
    receiptRef: { operation: OPERATION, requestId: edit.requestId, ownerScope: OWNER_SCOPE },
  });
  return response.body as Published;
}

/** Fresh request identity and deterministic text make duplicate and changed-input cases distinct. */
function edit(baseRevision: string, body = 'Alpha version one.'): Edit {
  return {
    requestId: randomUUID(),
    baseRevision,
    changes: [{ path: 'alpha.md', content: page('alpha', body) }],
    summary: 'Edit alpha',
  };
}

/** Count only immutable commits reachable from the sole published ref. */
function publishedCount(f: ReturnType<typeof fixture>): number {
  return Number(git(f, ['rev-list', '--count', 'refs/heads/published']).trim());
}

afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  vi.useRealTimers();
  for (const f of fixtures.splice(0)) {
    if (f.workspaceDb.sqlite.open) f.workspaceDb.sqlite.close();
    if (f.coreDb.sqlite.open) f.coreDb.sqlite.close();
    rmSync(f.dataRoot, { recursive: true, force: true });
  }
});

/** Submit public commands through their actual native binding and original receipt identity. */
async function command(
  f: ReturnType<typeof fixture>,
  operation: string,
  requestId: string,
  input: Record<string, unknown>
) {
  const response = await f.app.request(`/api/app/operations/${operation}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-openkit-request-id': requestId },
    body: JSON.stringify({ workspaceId: DEMO_WORKSPACE_ID, ...input }),
  });
  return { status: response.status, body: await response.json() };
}

describe('native Workspace notebook publication with real Git and SQLite', () => {
  it('publishes page commands once and replays their exact old bytes after later edits and reopen', async () => {
    const f = await fixture();
    const initial = await listing(f);
    const baseRevision = initial.notebookRevision;
    const createRequestId = randomUUID();
    const input = {
      baseRevision,
      path: 'notes/human-entry.md',
      content: updateOkfFrontmatter({
        path: 'notes/human-entry.md',
        content: page('notes/human-entry', 'Original human bytes.'),
        updates: { title: 'Original human title' },
      }),
      summary: 'Create original human page',
    };
    const created = await command(f, 'knowledge.notebook.create', createRequestId, input);
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body).toMatchObject({
      outcome: 'published',
      baseRevision,
      changedPageIds: ['notes/human-entry'],
      receiptRef: { operation: 'knowledge.notebook.create', requestId: createRequestId },
    });
    for (const operation of ['workspace.read', 'workspace.dashboard']) {
      const response = await f.app.request(`/api/app/operations/${operation}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: DEMO_WORKSPACE_ID }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        counts: { knowledgeEntryCount: number };
      };
      expect(body.counts.knowledgeEntryCount).toBe(initial.pages.length + 1);
    }
    const createdRevision = (await listing(f)).notebookRevision;
    expect(createdRevision).not.toBe(baseRevision);
    const laterBytes = updateOkfFrontmatter({
      path: input.path,
      content: input.content,
      updates: { title: 'Later title' },
      body: 'Later bytes.\n',
    });
    const updated = await command(f, 'knowledge.notebook.update', randomUUID(), {
      baseRevision: createdRevision,
      changes: [{ path: input.path, content: laterBytes }],
      summary: 'Update human page',
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    const currentRevision = (await listing(f)).notebookRevision;
    reopen(f);
    const replay = await command(f, 'knowledge.notebook.create', createRequestId, input);
    expect(replay).toEqual(created);
    expect((await listing(f)).notebookRevision).toBe(currentRevision);
    expect(
      (await listing(f)).pages.find((entry) => entry.id === 'notes/human-entry')?.content
    ).toBe(laterBytes);
    expect(git(f, ['show', `${currentRevision}:pages/${input.path}`])).toBe(laterBytes);
    expect(git(f, ['show', `${created.body.notebookRevision}:pages/${input.path}`])).toBe(
      input.content
    );
    const receipts = f.workspaceDb.sqlite
      .prepare(
        'SELECT command_name AS command, response_kind AS kind FROM idempotency_requests WHERE request_id = ?'
      )
      .all(createRequestId);
    expect(receipts).toEqual([
      { command: 'knowledge.notebook.create', kind: 'knowledge_notebook_revision' },
    ]);
    expect(
      f.workspaceDb.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM idempotency_requests WHERE command_name = 'knowledge.notebook.update' AND request_id = ?"
        )
        .get(createRequestId)
    ).toEqual({ count: 0 });
    const changed = await command(f, 'knowledge.notebook.create', createRequestId, {
      ...input,
      content: page('notes/human-entry', 'Changed under the old key.'),
    });
    expect(changed.status).toBe(409);
    expect(changed.body).toMatchObject({ code: 'idempotency_key_conflict' });
    expect((await listing(f)).notebookRevision).toBe(currentRevision);
  });

  it('replays an updated page after removal without resurrection and still rechecks its Source audience', async () => {
    const f = await fixture();
    const source = await command(f, 'knowledge.source.register', randomUUID(), {
      kind: 'document',
      title: 'Replay source',
      content: 'Independent retained source.',
      originatingThreadId: DEMO_THREAD_ID,
    });
    expect(source.status, JSON.stringify(source.body)).toBe(200);
    const id = 'notes/replay';
    const created = await command(f, 'knowledge.notebook.create', randomUUID(), {
      baseRevision: (await listing(f)).notebookRevision,
      path: `${id}.md`,
      content: updateOkfFrontmatter({
        path: `${id}.md`,
        content: page(id, 'Original bytes.'),
        updates: {
          title: 'Replay page',
          source_refs: [`source:${source.body.source.id}@${source.body.source.contentDigest}`],
        },
      }),
      summary: 'Create replay page',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const requestId = randomUUID();
    const input = {
      baseRevision: (await listing(f)).notebookRevision,
      changes: [
        {
          path: `${id}.md`,
          content: updateOkfFrontmatter({
            path: `${id}.md`,
            content: git(f, ['show', `${created.body.notebookRevision}:pages/${id}.md`]),
            updates: {},
            body: 'Updated historical bytes.\n',
          }),
        },
      ],
      summary: 'Update historical page',
    };
    const updated = await command(f, 'knowledge.notebook.update', requestId, input);
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    const revision = (await listing(f)).notebookRevision;
    const content = git(f, ['show', `${revision}:pages/${id}.md`]);
    const deleted = await command(f, 'knowledge.notebook.delete', randomUUID(), {
      baseRevision: revision,
      path: `${id}.md`,
      summary: 'Remove replay page',
      expectedContentDigest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
      confirmRemoval: true,
    });
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    const removedRevision = (await listing(f)).notebookRevision;
    reopen(f);
    expect(await command(f, 'knowledge.notebook.update', requestId, input)).toEqual(updated);
    expect((await listing(f)).notebookRevision).toBe(removedRevision);
    expect((await listing(f)).pages.some((entry) => entry.id === id)).toBe(false);
    expect(git(f, ['show', `${revision}:pages/${id}.md`])).toBe(content);

    // Current Source policy also governs replay after the page has been removed.
    await restrictSourceThread(f, DEMO_THREAD_ID);
    const denied = await command(f, 'knowledge.notebook.update', requestId, input);
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(JSON.stringify(denied.body)).not.toContain('Updated historical bytes.');
    expect(git(f, ['rev-parse', 'refs/heads/published']).trim()).toBe(removedRevision);
  });

  it('preserves unknown nested OKF metadata through the native full-page update and restart', async () => {
    const f = await fixture();
    const id = 'notes/metadata';
    const created = await command(f, 'knowledge.notebook.create', randomUUID(), {
      baseRevision: (await listing(f)).notebookRevision,
      path: `${id}.md`,
      content: updateOkfFrontmatter({
        path: `${id}.md`,
        content: page(id, 'Original body.'),
        updates: { title: 'Original title' },
      }),
      summary: 'Create metadata page',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const originalRevision = (await listing(f)).notebookRevision;
    const original = git(f, ['show', `${originalRevision}:pages/${id}.md`]);
    const sources = [{ id: 'upstream', credibility: { author: 'human:owner' } }];
    const generated = { by: 'reference_agent/test', at: '2026-09-06T00:00:00Z' };
    const annotated = await publish(f, {
      requestId: randomUUID(),
      baseRevision: originalRevision,
      changes: [
        {
          path: `${id}.md`,
          content: updateOkfFrontmatter({
            path: `${id}.md`,
            content: original,
            updates: { sources, generated },
          }),
        },
      ],
      summary: 'Retain authored extension metadata',
    });
    reopen(f);
    const updated = await command(f, 'knowledge.notebook.update', randomUUID(), {
      baseRevision: annotated.notebookRevision,
      changes: [
        {
          path: `${id}.md`,
          content: updateOkfFrontmatter({
            path: `${id}.md`,
            content: git(f, ['show', `${annotated.notebookRevision}:pages/${id}.md`]),
            updates: { title: 'Updated title' },
            body: 'Updated body.\n',
          }),
        },
      ],
      summary: 'Update metadata page',
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    const revision = (await listing(f)).notebookRevision;
    const content = git(f, ['show', `${revision}:pages/${id}.md`]);
    const parsed = parseOkfDocument({ path: `${id}.md`, content });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('Published page is invalid OKF.');
    expect(parsed.document.frontmatter.sources).toEqual(sources);
    expect(parsed.document.frontmatter.generated).toEqual(generated);
    expect(parsed.document.frontmatter.title).toBe('Updated title');
    expect(parsed.document.body).toBe('Updated body.\n');
    reopen(f);
    expect((await listing(f)).pages).toContainEqual({
      id,
      path: `${id}.md`,
      content,
      contentDigest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    });
    expect(git(f, ['show', `${revision}:pages/${id}.md`])).toBe(content);
    expect(git(f, ['show', `${originalRevision}:pages/${id}.md`])).toBe(original);
  });

  it('retains generic valid pages without managed entry fields or body text across reopen', async () => {
    const f = await fixture();
    const initial = await listing(f);
    const raw = page('rough', '').replace(/^openkit_entry_id:.*\n/m, '');
    const published = await publish(f, {
      requestId: randomUUID(),
      baseRevision: initial.notebookRevision,
      changes: [{ path: 'rough.md', content: raw }],
      summary: 'Keep an unfinished note',
    });
    expect(git(f, ['show', `${published.notebookRevision}:pages/rough.md`])).toBe(raw);
    expect((await listing(f)).pages).toContainEqual({
      id: 'rough',
      path: 'rough.md',
      content: raw,
      contentDigest: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
    });
    reopen(f);
    expect((await listing(f)).pages).toContainEqual({
      id: 'rough',
      path: 'rough.md',
      content: raw,
      contentDigest: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
    });
    expect(git(f, ['show', `${published.notebookRevision}:pages/rough.md`])).toBe(raw);
  });

  it('publishes the initial notebook inside fresh Workspace creation before any notebook read', async () => {
    const f = await fixture();
    expect(existsSync(f.repositoryPath)).toBe(true);
    const revision = git(f, ['rev-parse', 'refs/heads/published']).trim();
    expect(git(f, ['rev-list', '--parents', '-1', revision]).trim()).toBe(revision);
    expect(git(f, ['show', `${revision}:pages/index.md`])).toContain('# Knowledge');
    const metadata = JSON.parse(git(f, ['show', '-s', '--format=%B', revision]));
    expect(metadata).toMatchObject({
      producer: { kind: 'user', id: LOCAL_USER_ID },
      authority: { kind: 'direct' },
      sourceReferences: [],
    });
    reopen(f);
    expect(git(f, ['rev-parse', 'refs/heads/published']).trim()).toBe(revision);
  });

  it('publishes two pages once and replays the exact old receipt after a later edit and reopen', async () => {
    const f = await fixture();
    const initial = await listing(f);
    const initialTree = git(f, ['rev-parse', `${initial.notebookRevision}^{tree}`]).trim();
    const firstEdit = edit(initial.notebookRevision, 'Alpha links to [[beta]].');
    firstEdit.changes.push({ path: 'beta.md', content: page('beta', 'Beta links to [[alpha]].') });
    firstEdit.summary = 'Publish two related pages\n{"authority":"untrusted display text"}';
    const beforeCount = publishedCount(f);
    const [first, duplicate] = await Promise.all([publish(f, firstEdit), publish(f, firstEdit)]);
    expect(duplicate).toEqual(first);
    expect(publishedCount(f)).toBe(beforeCount + 1);
    expect(git(f, ['rev-list', '--parents', '-1', first.notebookRevision]).trim()).toBe(
      `${first.notebookRevision} ${initial.notebookRevision}`
    );
    expect(
      git(f, ['diff-tree', '--no-commit-id', '--name-only', '-r', first.notebookRevision])
        .trim()
        .split('\n')
    ).toEqual(['pages/alpha.md', 'pages/beta.md']);
    const oldAlpha = git(f, ['show', `${first.notebookRevision}:pages/alpha.md`]);
    const oldBeta = git(f, ['show', `${first.notebookRevision}:pages/beta.md`]);
    expect(oldAlpha).toContain('Alpha links to [[beta]].');
    expect(oldAlpha).toContain('preserved: [one, two]');
    expect(oldBeta).toContain('Beta links to [[alpha]].');
    expect(git(f, ['rev-parse', `${initial.notebookRevision}^{tree}`]).trim()).toBe(initialTree);

    const metadata = JSON.parse(git(f, ['show', '-s', '--format=%B', first.notebookRevision]));
    expect(metadata).toMatchObject({
      summary: firstEdit.summary,
      changeRequest: {
        requestId: firstEdit.requestId,
        inputDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
      producer: { kind: 'user', id: LOCAL_USER_ID },
      authority: { kind: 'direct', instructionReference: expect.any(String) },
      sourceReferences: [],
    });
    const admission = f.workspaceDb.sqlite
      .prepare(
        'SELECT notebook_admission_json AS admission FROM audit_events WHERE request_id = ? AND action = ?'
      )
      .get(firstEdit.requestId, 'knowledge.notebook.admit') as { admission: string };
    expect(JSON.parse(admission.admission)).toEqual({
      ownerScope: OWNER_SCOPE,
      requestId: firstEdit.requestId,
      inputDigest: metadata.changeRequest.inputDigest,
      baseRevision: initial.notebookRevision,
      candidateRevision: first.notebookRevision,
      producer: metadata.producer,
      authority: metadata.authority,
      sourceReferences: [],
    });
    expect(
      f.workspaceDb.sqlite
        .prepare(
          'SELECT response_kind AS kind, response_id AS id, response_json AS extra FROM idempotency_requests WHERE command_name = ? AND request_id = ?'
        )
        .get(OPERATION, firstEdit.requestId)
    ).toEqual({ kind: 'knowledge_notebook_revision', id: first.notebookRevision, extra: null });

    const second = await publish(f, edit(first.notebookRevision, 'Alpha version two.'));
    expect(second.notebookRevision).not.toBe(first.notebookRevision);
    const completedCount = publishedCount(f);
    expect(await publish(f, firstEdit)).toEqual(first);
    reopen(f);
    expect(await publish(f, firstEdit)).toEqual(first);
    expect(publishedCount(f)).toBe(completedCount);
    expect((await listing(f)).notebookRevision).toBe(second.notebookRevision);
    expect(git(f, ['show', `${first.notebookRevision}:pages/alpha.md`])).toBe(oldAlpha);
    expect(git(f, ['show', `${first.notebookRevision}:pages/beta.md`])).toBe(oldBeta);
    expect(git(f, ['show', `${second.notebookRevision}:pages/alpha.md`])).toContain(
      'Alpha version two.'
    );
    expect(git(f, ['show', `${second.notebookRevision}:pages/beta.md`])).toBe(oldBeta);
  });

  it('rejects changed input under a completed request without another commit', async () => {
    const f = await fixture();
    const request = edit((await listing(f)).notebookRevision);
    const first = await publish(f, request);
    const count = publishedCount(f);
    const conflict = await submit(f, { ...request, summary: 'Different exact input' });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: 'idempotency_key_conflict' });
    expect((await listing(f)).notebookRevision).toBe(first.notebookRevision);
    expect(publishedCount(f)).toBe(count);
  });

  it('rejects a stale base even after an ABA edit restores exactly the original page bytes', async () => {
    // Fix service-owned attribution time so this ABA returns to the same exact content tree.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T01:00:00.000Z'));
    const f = await fixture();
    const first = await publish(f, edit((await listing(f)).notebookRevision));
    const original = git(f, ['show', `${first.notebookRevision}:pages/alpha.md`]);
    const second = await publish(f, edit(first.notebookRevision, 'Alpha version two.'));
    const third = await publish(f, {
      ...edit(second.notebookRevision),
      changes: [{ path: 'alpha.md', content: original }],
      summary: 'Restore original page text at current base',
    });
    const count = publishedCount(f);
    expect(git(f, ['rev-parse', `${third.notebookRevision}^{tree}`])).toBe(
      git(f, ['rev-parse', `${first.notebookRevision}^{tree}`])
    );
    const stale = await submit(f, edit(first.notebookRevision, 'This stale edit must lose.'));
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      code: 'conflict',
      details: { currentRevision: third.notebookRevision },
    });
    expect((await listing(f)).notebookRevision).toBe(third.notebookRevision);
    expect(publishedCount(f)).toBe(count);
    expect(git(f, ['rev-list', '--parents', '-1', third.notebookRevision]).trim()).toBe(
      `${third.notebookRevision} ${second.notebookRevision}`
    );
    expect(git(f, ['show', `${third.notebookRevision}:pages/alpha.md`])).not.toContain(
      'This stale edit'
    );
  });

  it('keeps unrelated FsStore persistence from rewriting the notebook through a stale page projection', async () => {
    const f = await fixture();
    const initial = await listing(f);
    const staleStore = new FsStore({ dataRoot: f.dataRoot });
    const published = await publish(
      f,
      edit(initial.notebookRevision, 'Only the notebook owns these bytes.')
    );
    const exactBytes = git(f, ['show', `${published.notebookRevision}:pages/alpha.md`]);
    const count = publishedCount(f);
    // An unstamped optional materialization is inert; broad persistence must not publish or delete it.
    const pagesRoot = join(f.dataRoot, 'workspaces', DEMO_WORKSPACE_ID, 'knowledge', 'pages');
    mkdirSync(pagesRoot, { recursive: true });
    const sentinelPath = join(pagesRoot, 'materialization-sentinel.md');
    const sentinel = page('materialization-sentinel', 'Inert materialization bytes.');
    writeFileSync(sentinelPath, sentinel);
    await staleStore.updateThread(DEMO_WORKSPACE_ID, DEMO_THREAD_ID, {
      name: 'Unrelated persisted Thread title',
    });
    expect(readFileSync(sentinelPath, 'utf8')).toBe(sentinel);
    reopen(f);
    const retained = await listing(f);
    expect(retained.notebookRevision).toBe(published.notebookRevision);
    expect(retained.pages.find((item) => item.id === 'alpha')?.content).toContain(
      'Only the notebook owns these bytes.'
    );
    expect(publishedCount(f)).toBe(count);
    expect(git(f, ['show', `${retained.notebookRevision}:pages/alpha.md`])).toBe(exactBytes);
  });

  it('cannot publish when the real SQLite admission Audit write fails', async () => {
    const f = await fixture();
    const initial = await listing(f);
    const request = edit(initial.notebookRevision);
    f.workspaceDb.sqlite.exec(
      "CREATE TRIGGER reject_notebook_admission BEFORE INSERT ON audit_events WHEN NEW.action = 'knowledge.notebook.admit' BEGIN SELECT RAISE(ABORT, 'test admission failure'); END"
    );
    const count = publishedCount(f);
    const failed = await submit(f, request);
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(git(f, ['rev-parse', 'refs/heads/published']).trim()).toBe(initial.notebookRevision);
    expect(publishedCount(f)).toBe(count);
    expect(
      f.workspaceDb.sqlite
        .prepare(
          'SELECT count(*) AS count FROM idempotency_requests WHERE command_name = ? AND request_id = ?'
        )
        .get(OPERATION, request.requestId)
    ).toEqual({ count: 0 });
    f.workspaceDb.sqlite.exec('DROP TRIGGER reject_notebook_admission');
    // The same valid command must publish after removing only the injected Audit fault.
    const completed = await publish(f, request);
    expect(publishedCount(f)).toBe(count + 1);
    reopen(f);
    expect((await listing(f)).notebookRevision).toBe(completed.notebookRevision);
  });

  it('retains committed admission and the old published ref when actual Git ref publication fails', async () => {
    const f = await fixture();
    const initial = await listing(f);
    const request = edit(initial.notebookRevision);
    const count = publishedCount(f);
    const lockPath = join(f.repositoryPath, 'refs', 'heads', 'published.lock');
    writeFileSync(lockPath, 'Test-owned ref lock.\n', { flag: 'wx' });
    const failed = await submit(f, request);
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(git(f, ['rev-parse', 'refs/heads/published']).trim()).toBe(initial.notebookRevision);
    expect(publishedCount(f)).toBe(count);
    expect(
      f.workspaceDb.sqlite
        .prepare('SELECT count(*) AS count FROM audit_events WHERE request_id = ? AND action = ?')
        .get(request.requestId, 'knowledge.notebook.admit')
    ).toEqual({ count: 1 });
    expect(
      f.workspaceDb.sqlite
        .prepare(
          'SELECT count(*) AS count FROM idempotency_requests WHERE command_name = ? AND request_id = ?'
        )
        .get(OPERATION, request.requestId)
    ).toEqual({ count: 0 });
    rmSync(lockPath);
  });

  it.each([
    'receipt',
    'completion Audit',
  ] as const)('requires recovery when a published command loses its exact %s evidence', async (missing) => {
    const f = await fixture();
    const request = edit((await listing(f)).notebookRevision);
    const published = await publish(f, request);
    const count = publishedCount(f);
    const bytes = git(f, ['show', `${published.notebookRevision}:pages/alpha.md`]);
    const deleted =
      missing === 'receipt'
        ? f.workspaceDb.sqlite
            .prepare('DELETE FROM idempotency_requests WHERE command_name = ? AND request_id = ?')
            .run(OPERATION, request.requestId)
        : f.workspaceDb.sqlite
            .prepare('DELETE FROM audit_events WHERE action = ? AND request_id = ?')
            .run(OPERATION, request.requestId);
    expect(deleted.changes).toBe(1);
    reopen(f);
    const replay = await submit(f, request);
    expect(replay.status).toBeGreaterThanOrEqual(400);
    expect(replay.body).toMatchObject({ code: 'recovery_required' });
    expect(git(f, ['rev-parse', 'refs/heads/published']).trim()).toBe(published.notebookRevision);
    expect(publishedCount(f)).toBe(count);
    expect(git(f, ['show', `${published.notebookRevision}:pages/alpha.md`])).toBe(bytes);
    if (missing === 'receipt')
      expect(
        f.workspaceDb.sqlite
          .prepare(
            'SELECT count(*) AS count FROM idempotency_requests WHERE command_name = ? AND request_id = ?'
          )
          .get(OPERATION, request.requestId)
      ).toEqual({ count: 0 });
    else
      expect(
        f.workspaceDb.sqlite
          .prepare('SELECT count(*) AS count FROM audit_events WHERE action = ? AND request_id = ?')
          .get(OPERATION, request.requestId)
      ).toEqual({ count: 0 });
  });
});

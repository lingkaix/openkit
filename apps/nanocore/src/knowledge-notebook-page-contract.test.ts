// openkit-test-platform: posix
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeConfigManager } from './config/runtime-config.js';
import { parseOkfDocument } from './knowledge/okf.js';
import { FsStore } from './lib/store.js';
import { readAuthorizedWorkspaceNotebookPages } from './retrieval-knowledge-adapter.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const fixtures: Array<ReturnType<typeof fixture>> = [];

/** Compose the real native publisher and authorized reader with fresh canonical configuration. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-notebook-page-contract-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('One Notebook page contract', {
    requestId: randomUUID(),
    producer: { kind: 'user', id: userId },
    instructionReference: 'Create a fresh test-owned Workspace',
  });
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  applyScopedMigrations(workspaceDb);
  const f = {
    dataRoot,
    coreDb,
    store,
    workspaceDb,
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

/** Reopen retained owners without reseeding or replaying a publication. */
function reopen(f: ReturnType<typeof fixture>) {
  f.workspaceDb.sqlite.close();
  f.coreDb.sqlite.close();
  f.coreDb = openCoreDb(f.dataRoot);
  applyMigrations(f.coreDb);
  f.workspaceDb = openWorkspaceDb(f.dataRoot, f.workspaceId);
  applyScopedMigrations(f.workspaceDb);
  f.store = new FsStore({ dataRoot: f.dataRoot });
  f.app = createApp({
    coreDb: f.coreDb,
    dataRoot: f.dataRoot,
    store: f.store,
    runtimeConfigManager: createRuntimeConfigManager({ dataRoot: f.dataRoot }),
  });
}

/** Read immutable bytes independently of the Notebook content reader. */
function git(f: ReturnType<typeof fixture>, ...args: string[]): string {
  return execFileSync('git', ['--git-dir', f.repositoryPath, ...args], { encoding: 'utf8' });
}

/** Hash complete Markdown, including frontmatter, independently of the public read projection. */
function digest(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/** A valid human page has one existing OKF type and descriptive extension metadata. */
function page(f: ReturnType<typeof fixture>, body = 'Original human body.'): string {
  return [
    '---',
    'type: KnowledgePage',
    'title: Human title',
    'schema_version: openkit-scope-knowledge-schema-v4',
    'requiredFeatures: [openkit.knowledge-owner-scope.v1, openkit.knowledge-git-notebook.v1]',
    'openkit_status: active',
    'status: stable',
    `scope: {kind: workspace, workspaceId: ${f.workspaceId}}`,
    'source_refs: []',
    'review_state: user-authored',
    'sensitivity: normal',
    'freshness: current',
    'created_at: "2026-10-19T00:00:00.000Z"',
    'updated_at: "2026-10-19T00:00:00.000Z"',
    'custom: {preserved: [one, two]}',
    '---',
    body,
    '',
  ].join('\n');
}

/** Exercise the existing HTTP-to-native binding with actual current user authority. */
async function call(
  f: ReturnType<typeof fixture>,
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

/** Public listing must expose the actual pinned reader facts and complete page bytes. */
async function listing(f: ReturnType<typeof fixture>) {
  const result = await call(f, 'knowledge.notebook.list');
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  const authorized = readAuthorizedWorkspaceNotebookPages({
    dataRoot: f.dataRoot,
    workspaceId: f.workspaceId,
    access: {
      store: f.store,
      coreDb: f.coreDb,
      actor: { kind: 'user', id: f.userId },
      requestActor: { kind: 'session', userId: f.userId },
    },
  });
  expect(result.body).toEqual({
    knowledgeBaseId: authorized.knowledgeBaseId,
    notebookRevision: authorized.notebookRevision,
    pages: authorized.pages,
  });
  return authorized;
}

/** One completed command points to the existing immutable revision and the actual admitted command. */
function publication(
  f: ReturnType<typeof fixture>,
  result: Awaited<ReturnType<typeof call>>,
  operation: string,
  input: { requestId: string; baseRevision: string }
) {
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  const ownerScope = { kind: 'workspace', workspaceId: f.workspaceId };
  expect(result.body).toEqual({
    outcome: 'published',
    ownerScope,
    baseRevision: input.baseRevision,
    notebookRevision: expect.any(String),
    changedPageIds: ['notes/human'],
    receiptRef: { operation, requestId: input.requestId, ownerScope },
  });
  expect(
    f.workspaceDb.sqlite
      .prepare(
        'SELECT command_name AS operation, response_kind AS kind FROM idempotency_requests WHERE request_id = ?'
      )
      .all(input.requestId)
  ).toEqual([{ operation, kind: 'knowledge_notebook_revision' }]);
  return result.body.notebookRevision as string;
}

afterEach(() => {
  for (const f of fixtures.splice(0)) {
    if (f.workspaceDb.sqlite.open) f.workspaceDb.sqlite.close();
    if (f.coreDb.sqlite.open) f.coreDb.sqlite.close();
    rmSync(f.dataRoot, { recursive: true, force: true });
  }
});

describe('canonical page commands compose the native Notebook publisher and reader', () => {
  it('keeps the existing full-page update and authorized reader as the fixture control', async () => {
    const f = fixture();
    const input = {
      requestId: randomUUID(),
      baseRevision: git(f, 'rev-parse', 'refs/heads/published').trim(),
      changes: [{ path: 'notes/human.md', content: page(f) }],
      summary: 'Direct full-page human edit',
    };
    const result = await call(f, 'knowledge.notebook.update', input);
    const revision = publication(f, result, 'knowledge.notebook.update', input);
    const read = readAuthorizedWorkspaceNotebookPages({
      dataRoot: f.dataRoot,
      workspaceId: f.workspaceId,
      pageIds: ['notes/human'],
      access: {
        store: f.store,
        coreDb: f.coreDb,
        actor: { kind: 'user', id: f.userId },
        requestActor: { kind: 'session', userId: f.userId },
      },
    });
    const bytes = git(f, 'show', `${revision}:pages/notes/human.md`);
    expect(read.pages).toEqual([
      { id: 'notes/human', path: 'notes/human.md', content: bytes, contentDigest: digest(bytes) },
    ]);
    expect(bytes).toContain('Original human body.');
    expect(bytes).not.toContain('openkit_entry_kind');
    expect(f.store.getWorkspaceResources(f.workspaceId).knowledge).toEqual(read.pages);
  });

  it('creates, lists, edits and removes one canonical page with exact conflicts, retained history and truthful replay', async () => {
    const f = fixture();
    const initial = await listing(f);
    const create = {
      requestId: randomUUID(),
      baseRevision: initial.notebookRevision,
      path: 'notes/human.md',
      content: page(f),
      summary: 'Create a direct human note',
    };
    const created = await call(f, 'knowledge.notebook.create', create);
    const createdRevision = publication(f, created, 'knowledge.notebook.create', create);
    const original = git(f, 'show', `${createdRevision}:pages/notes/human.md`);
    expect((await listing(f)).pages).toContainEqual({
      id: 'notes/human',
      path: create.path,
      content: original,
      contentDigest: digest(original),
    });
    const duplicate = await call(f, 'knowledge.notebook.create', {
      ...create,
      requestId: randomUUID(),
      baseRevision: createdRevision,
    });
    expect(duplicate.status).toBe(409);
    expect(git(f, 'rev-parse', 'refs/heads/published').trim()).toBe(createdRevision);

    const edit = {
      requestId: randomUUID(),
      baseRevision: createdRevision,
      changes: [
        {
          path: create.path,
          content: original
            .replace('title: Human title', 'title: Edited human title')
            .replace('Original human body.', 'Edited human body.')
            .replace('review_state: user-authored', 'review_state: accepted'),
        },
      ],
      summary: 'Edit complete page while retaining extension metadata',
    };
    const updated = await call(f, 'knowledge.notebook.update', edit);
    const updatedRevision = publication(f, updated, 'knowledge.notebook.update', edit);
    const changed = git(f, 'show', `${updatedRevision}:pages/notes/human.md`);
    const parsed = parseOkfDocument({ path: create.path, content: changed });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('Published page must be valid OKF.');
    expect(parsed.document.frontmatter).toMatchObject({
      type: 'KnowledgePage',
      title: 'Edited human title',
      custom: { preserved: ['one', 'two'] },
      review_state: 'user-authored',
    });
    expect(parsed.document.body).toBe('Edited human body.\n');
    expect(changed).not.toContain('openkit_entry_kind');
    const stale = await call(f, 'knowledge.notebook.update', {
      ...edit,
      requestId: randomUUID(),
      changes: [{ path: create.path, content: page(f, 'Stale overwrite.') }],
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      code: 'conflict',
      details: { currentRevision: updatedRevision },
    });

    const remove = {
      requestId: randomUUID(),
      baseRevision: updatedRevision,
      path: create.path,
      expectedContentDigest: digest(changed),
      confirmRemoval: true,
      summary: 'Remove selected current page; retained history remains',
    };
    for (const override of [
      { confirmRemoval: false },
      { expectedContentDigest: digest(original) },
    ]) {
      const denied = await call(f, 'knowledge.notebook.delete', {
        ...remove,
        ...override,
        requestId: randomUUID(),
      });
      expect(denied.status).toBeGreaterThanOrEqual(400);
      expect(denied.status).toBeLessThan(500);
      expect(git(f, 'rev-parse', 'refs/heads/published').trim()).toBe(updatedRevision);
    }
    const removed = await call(f, 'knowledge.notebook.delete', remove);
    const removedRevision = publication(f, removed, 'knowledge.notebook.delete', remove);
    reopen(f);
    expect(await call(f, 'knowledge.notebook.create', create)).toEqual(created);
    expect(await call(f, 'knowledge.notebook.update', edit)).toEqual(updated);
    expect(await call(f, 'knowledge.notebook.delete', remove)).toEqual(removed);
    const current = await listing(f);
    expect(current.notebookRevision).toBe(removedRevision);
    expect(current.pages.some(({ id }) => id === 'notes/human')).toBe(false);
    expect(git(f, 'show', `${createdRevision}:pages/notes/human.md`)).toBe(original);
    expect(git(f, 'show', `${updatedRevision}:pages/notes/human.md`)).toBe(changed);
    const conflict = await call(f, 'knowledge.notebook.create', {
      ...create,
      content: page(f, 'Changed request bytes.'),
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: 'idempotency_key_conflict' });
    expect(git(f, 'rev-parse', 'refs/heads/published').trim()).toBe(removedRevision);
  });
});

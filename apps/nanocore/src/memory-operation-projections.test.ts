import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { readDefaultKnowledgeBaseId } from './config/knowledge-base.js';
import { openAssistantTimeline } from './internal-agents/assistant-timeline.js';
import { KnowledgeNotebook } from './knowledge/notebook.js';
import { updateOkfFrontmatter } from './knowledge/okf.js';
import { initializeScopedNotebook } from './knowledge/scoped-notebook-owner.js';
import { FsStore } from './lib/store.js';
import { closeRetrievalServices } from './retrieval-service.js';
import { openCoreDb, openUserDb } from './storage/db.js';
import { userDbPath, userMemoryRoot } from './storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { serializeUserAuthoredKnowledgePage } from './storage/workspace-file-records.js';
import { createApp } from './test-support/app.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/** Real self authority and isolated canonical storage exercise the public Memory boundary. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'memory-public-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const app = createApp({ coreDb, dataRoot, store });
  onTestFinished(async () => {
    await closeRetrievalServices();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const call = async (operation: string, input: Record<string, unknown> = {}) => {
    const { requestId, ...body } = input;
    const response = await app.request(`/api/app/operations/${operation}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(requestId ? { 'x-openkit-request-id': String(requestId) } : {}),
      },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: response.headers.get('content-type')?.includes('application/json')
        ? await response.json()
        : { text: await response.text() },
    };
  };
  const content = (body: string, id = 'preferences') =>
    serializeUserAuthoredKnowledgePage(
      {
        id,
        kind: 'preference',
        title: 'My preference',
        content: body,
        sourceReferences: [],
        createdAt: '2026-10-17T00:00:00.000Z',
        updatedAt: '2026-10-17T00:00:00.000Z',
      },
      { kind: 'user', userId }
    );
  return { call, content, userId, coreDb, dataRoot, store };
}

describe('public explicit self Memory', () => {
  it('retains the first-save User base before public reads of its exact published bytes', async () => {
    const f = fixture();
    const owner = { dataRoot: f.dataRoot, scope: { kind: 'user' as const, userId: f.userId } };
    expect(() => readDefaultKnowledgeBaseId(owner)).toThrow();
    const content = f.content('Keep this first preference exactly.\r\n');
    const saved = await f.call('memory.create', {
      requestId: randomUUID(),
      baseRevision: null,
      pageId: 'preferences',
      content,
      summary: 'First public save',
    });
    expect(saved.status).toBe(200);
    const knowledgeBaseId = readDefaultKnowledgeBaseId(owner);
    expect(await f.call('memory.read', { pageId: 'preferences' })).toMatchObject({
      status: 200,
      body: { page: { content, notebookRevision: saved.body.notebookRevision } },
    });
    expect(readDefaultKnowledgeBaseId(owner)).toBe(knowledgeBaseId);
  });

  it('publishes exact personally authored bytes through self-only operations and refuses a stale edit', async () => {
    const f = fixture();
    const content = f.content('Keep this exact personal preference.\r\n');
    const saved = await f.call('memory.create', {
      requestId: randomUUID(),
      baseRevision: null,
      pageId: 'preferences',
      content,
      summary: 'Save my preference',
    });
    expect(saved.status).toBe(200);
    const read = await f.call('memory.read', { pageId: 'preferences' });
    expect(read).toMatchObject({ status: 200, body: { page: { content } } });
    const listed = await f.call('memory.list');
    expect(listed).toMatchObject({ status: 200, body: { pages: [{ id: 'preferences' }] } });
    const edited = await f.call('memory.update', {
      requestId: randomUUID(),
      baseRevision: saved.body.notebookRevision,
      pageId: 'preferences',
      content: f.content('My changed preference.\n'),
      summary: 'Correct my preference',
    });
    expect(edited.status).toBe(200);
    const stale = await f.call('memory.update', {
      requestId: randomUUID(),
      baseRevision: saved.body.notebookRevision,
      pageId: 'preferences',
      content,
      summary: 'Stale edit',
    });
    expect(stale).toMatchObject({ status: 409, body: { code: 'conflict' } });
    expect((await f.call('memory.read', { pageId: 'preferences' })).body.page.content).toBe(
      f.content('My changed preference.\n')
    );
  });

  it('replays the first save without replacing later content and refuses a lost initialized root', async () => {
    const f = fixture();
    const input = {
      requestId: randomUUID(),
      baseRevision: null,
      pageId: 'preferences',
      content: f.content('Original preference.'),
      summary: 'First save',
    };
    const first = await f.call('memory.create', input);
    expect(first.status).toBe(200);
    const corrected = f.content('Corrected preference.');
    const update = await f.call('memory.update', {
      requestId: randomUUID(),
      baseRevision: first.body.notebookRevision,
      pageId: 'preferences',
      content: corrected,
      summary: 'Correction',
    });
    expect(update.status).toBe(200);
    expect(await f.call('memory.create', input)).toEqual(first);
    expect((await f.call('memory.read', { pageId: 'preferences' })).body.page.content).toBe(
      corrected
    );
    rmSync(userMemoryRoot(f.dataRoot, f.userId), { recursive: true });
    const refused = await f.call('memory.create', { ...input, requestId: randomUUID() });
    expect(refused).toMatchObject({ status: 503, body: { code: 'recovery_required' } });
  });

  it('rejects caller-selected owners and unsupported source-bearing content without publication', async () => {
    const f = fixture();
    const initialized = await f.call('memory.create', {
      requestId: randomUUID(),
      baseRevision: null,
      pageId: 'starter',
      content: f.content('Retain this page.', 'starter'),
      summary: 'First explicit save',
    });
    expect(initialized.status).toBe(200);
    expect((await f.call('memory.list', { userId: f.userId })).status).toBe(403);
    const refused = await f.call('memory.create', {
      requestId: randomUUID(),
      baseRevision: initialized.body.notebookRevision,
      pageId: 'preferences',
      content: f
        .content('Private source.')
        .replace('source_refs: []', 'source_refs: ["source:hidden"]'),
      summary: 'Unsupported source save',
    });
    expect(refused.status).toBe(400);
    expect((await f.call('memory.list')).body.pages.map((page: { id: string }) => page.id)).toEqual(
      ['starter']
    );
  });

  it('refuses a missing User database before first-save admission can replace its retained authority', async () => {
    const f = fixture();
    const content = f.content('Retain my exact preference.\r\n');
    const first = await f.call('memory.create', {
      requestId: randomUUID(),
      baseRevision: null,
      pageId: 'preferences',
      content,
      summary: 'First explicit save',
    });
    expect(first.status).toBe(200);
    const repositoryPath = join(userMemoryRoot(f.dataRoot, f.userId), 'notebook.git');
    const notebook = new KnowledgeNotebook({ repositoryPath });
    const before = notebook.readRevision(first.body.notebookRevision);
    const published = join(repositoryPath, 'refs', 'heads', 'published');
    const publishedBytes = readFileSync(published);
    const database = userDbPath(f.dataRoot, f.userId);
    // Public calls close their UserDb handle before returning, so this removes only the closed authority fixture.
    rmSync(database);
    expect(existsSync(database)).toBe(false);

    const response = await f.call('memory.create', {
      requestId: randomUUID(),
      baseRevision: null,
      pageId: 'replacement',
      content: f.content('Do not create a replacement.', 'replacement'),
      summary: 'Another first-save attempt',
    });
    expect({ response, databaseExists: existsSync(database) }).toMatchObject({
      response: { status: 503, body: { code: 'recovery_required' } },
      databaseExists: false,
    });
    expect(readFileSync(published)).toEqual(publishedBytes);
    expect(notebook.readRevision(first.body.notebookRevision)).toEqual(before);
    expect(before.files['preferences.md']).toBe(content);
  });
});

it('forwards inherited optional metadata selectors through private native Memory search', async () => {
  const f = fixture();
  const userDb = openUserDb(f.dataRoot, f.userId);
  applyScopedMigrations(userDb);
  const baseRevision = initializeScopedNotebook({
    coreDb: f.coreDb,
    userDb,
    actor: { kind: 'local', userId: f.userId },
    target: { kind: 'user' },
    initialization: { requestId: randomUUID(), instructionReference: 'test:domain-memory' },
  });
  userDb.sqlite.close();
  const workspace = f.store.createWorkspace('Private typed selection');
  recordWorkspaceOwnerMembership({
    coreDb: f.coreDb,
    workspaceId: workspace.id,
    ownerUserId: f.userId,
  });
  openAssistantTimeline(f.store, workspace.id, f.userId, 'Private Assistant');
  const content = updateOkfFrontmatter({
    path: 'preferences.md',
    content: f.content('personal-selector evidence.'),
    updates: { type: 'Rule', applies_to: ['tool:personal.check'] },
  });
  expect(
    await f.call('memory.create', {
      requestId: randomUUID(),
      baseRevision,
      pageId: 'preferences',
      content,
      summary: 'Save typed personal context',
    })
  ).toMatchObject({ status: 200 });
  const ordinary = await f.call('memory.search', {
    workspaceId: workspace.id,
    query: 'personal-selector',
  });
  expect(ordinary.status).toBe(200);
  expect(ordinary.body.selected).toHaveLength(1);
  const filters = { types: ['Effect'], appliesTo: ['tool:missing'] };
  const filtered = await f.call('memory.search', {
    workspaceId: workspace.id,
    query: 'personal-selector',
    ...filters,
  });
  expect(filtered).toMatchObject({
    status: 200,
    body: { selected: [], retrievalParameters: filters },
  });
});

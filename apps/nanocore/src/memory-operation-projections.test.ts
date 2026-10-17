import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { FsStore } from './lib/store.js';
import { closeRetrievalServices } from './retrieval-service.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { serializeUserAuthoredKnowledgePage } from './storage/workspace-file-records.js';
import { createApp } from './test-support/app.js';
import { ensureLocalUser } from './test-support/local-user.js';

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
  const content = (body: string) =>
    serializeUserAuthoredKnowledgePage(
      {
        id: 'preferences',
        kind: 'preference',
        title: 'My preference',
        content: body,
        sourceReferences: [],
        createdAt: '2026-10-17T00:00:00.000Z',
        updatedAt: '2026-10-17T00:00:00.000Z',
      },
      { kind: 'user', userId }
    );
  return { call, content, userId, coreDb };
}

describe('public explicit self Memory', () => {
  it('publishes exact personally authored bytes through self-only operations and refuses a stale edit', async () => {
    const f = fixture();
    const initialized = await f.call('memory.notebook.initialize', { requestId: randomUUID() });
    expect(initialized.status).toBe(200);
    const content = f.content('Keep this exact personal preference.\r\n');
    const saved = await f.call('memory.create', {
      requestId: randomUUID(),
      baseRevision: initialized.body.notebookRevision,
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
    expect(stale).toMatchObject({ status: 409, body: { error: { code: 'conflict' } } });
    expect((await f.call('memory.read', { pageId: 'preferences' })).body.page.content).toBe(
      f.content('My changed preference.\n')
    );
  });

  it('rejects caller-selected owners and unsupported source-bearing content without publication', async () => {
    const f = fixture();
    const initialized = await f.call('memory.notebook.initialize', { requestId: randomUUID() });
    expect(initialized.status).toBe(200);
    expect((await f.call('memory.list', { userId: f.userId })).status).toBe(400);
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
    expect((await f.call('memory.list')).body.pages).toEqual([]);
  });
});

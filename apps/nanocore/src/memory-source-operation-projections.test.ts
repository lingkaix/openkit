import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { appendMemorySuppression } from './knowledge/memory-maintenance.js';
import { FsStore } from './lib/store.js';
import { closeRetrievalServices } from './retrieval-service.js';
import { openCoreDb } from './storage/db.js';
import { userDbPath, userMemoryRoot } from './storage/fs-layout.js';
import { applyMigrations } from './storage/migrate.js';
import { serializeUserAuthoredKnowledgePage } from './storage/workspace-file-records.js';
import { createApp } from './test-support/app.js';
import { ensureLocalUser } from './test-support/local-user.js';

/** Actual User authority and isolated canonical files exercise explicit Source intake through HTTP. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'memory-source-public-'));
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
  return { app, call, coreDb, dataRoot, userId };
}

describe('public explicit self Source intake', () => {
  it('retains exact text and replays its original Source without recreating a notebook or another Source', async () => {
    const f = fixture();
    const content = 'Keep this exact document.\r\nSecond line.\n';
    const input = {
      requestId: randomUUID(),
      kind: 'document',
      title: 'An explicit document',
      content,
    };
    const first = await f.call('memory.source.register', input);
    expect(first.status).toBe(200);
    expect(first.body.source).toMatchObject({
      ownerScope: { kind: 'user', userId: f.userId },
      kind: 'document',
      title: input.title,
      contentDigest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
      uri: null,
      originatingThreadId: null,
      originatingTurnId: null,
      originatingFileId: null,
    });
    expect(first.body.source.id).toMatch(
      /^ks_[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
    );
    const read = await f.call('memory.source.read', { sourceId: first.body.source.id });
    expect(read).toMatchObject({
      status: 200,
      body: { source: { ...first.body.source, content } },
    });
    const second = await f.call('memory.source.register', {
      ...input,
      requestId: randomUUID(),
      title: 'A separate explicit document',
      content: 'A separate retained input.',
    });
    expect(second.status).toBe(200);
    expect(await f.call('memory.source.register', input)).toEqual(first);
    const conflict = await f.call('memory.source.register', {
      ...input,
      content: 'Changed input.',
    });
    expect(conflict).toMatchObject({ status: 409, body: { code: 'idempotency_key_conflict' } });
    const listed = await f.call('memory.source.list');
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((row: { id: string }) => row.id).sort()).toEqual(
      [first.body.source.id, second.body.source.id].sort()
    );
    expect(existsSync(userMemoryRoot(f.dataRoot, f.userId))).toBe(false);
  });

  it('publishes and inspects an explicitly authored page against the exact current self Source', async () => {
    const f = fixture();
    const captured = await f.call('memory.source.register', {
      requestId: randomUUID(),
      kind: 'document',
      title: 'My stated preference',
      content: 'I explicitly prefer concise reports.',
    });
    expect(captured.status).toBe(200);
    const sourceReference = `source:${captured.body.source.id}@${captured.body.source.contentDigest}`;
    const page = (body: string) =>
      serializeUserAuthoredKnowledgePage(
        {
          id: 'cited-preference',
          kind: 'preference',
          title: 'My cited preference',
          content: body,
          sourceReferences: [sourceReference],
          createdAt: '2026-10-17T00:00:00.000Z',
          updatedAt: '2026-10-17T00:00:00.000Z',
        },
        { kind: 'user', userId: f.userId }
      );
    const input = {
      requestId: randomUUID(),
      baseRevision: null,
      pageId: 'cited-preference',
      content: page('Keep my explicit preference.\n'),
      summary: 'Save my cited preference',
    };
    const first = await f.call('memory.create', input);
    expect(first.status).toBe(200);
    expect(await f.call('memory.read', { pageId: input.pageId })).toMatchObject({
      status: 200,
      body: { page: { content: input.content } },
    });
    const updatedContent = page('Keep my corrected explicit preference.\n');
    const updated = await f.call('memory.update', {
      ...input,
      requestId: randomUUID(),
      baseRevision: first.body.notebookRevision,
      content: updatedContent,
    });
    expect(updated.status).toBe(200);
    expect(await f.call('memory.create', input)).toEqual(first);
    expect((await f.call('memory.list')).body.pages.map((row: { id: string }) => row.id)).toEqual([
      input.pageId,
    ]);
    expect((await f.call('memory.read', { pageId: input.pageId })).body.page.content).toBe(
      updatedContent
    );
    expect(await f.call('memory.source.read', { sourceId: captured.body.source.id })).toMatchObject(
      {
        status: 200,
        body: { source: { content: 'I explicitly prefer concise reports.' } },
      }
    );
  });

  it('withholds suppressed Source versions from actual model MCP reads while retaining human inspection', async () => {
    const f = fixture();
    const captured = await f.call('memory.source.register', {
      requestId: randomUUID(),
      kind: 'document',
      title: 'A retained input',
      content: 'A forgotten source sentence.',
    });
    expect(captured.status).toBe(200);
    const other = await f.call('memory.source.register', {
      requestId: randomUUID(),
      kind: 'document',
      title: 'An independent input',
      content: 'This independent Source remains available.',
    });
    expect(other.status).toBe(200);
    const reference = `source:${captured.body.source.id}@${captured.body.source.contentDigest}`;
    const content = serializeUserAuthoredKnowledgePage(
      {
        id: 'suppressed-context',
        kind: 'preference',
        title: 'My cited entry',
        content: 'My personally saved understanding.',
        sourceReferences: [reference],
        createdAt: '2026-10-17T00:00:00.000Z',
        updatedAt: '2026-10-17T00:00:00.000Z',
      },
      { kind: 'user', userId: f.userId }
    );
    const saved = await f.call('memory.create', {
      requestId: randomUUID(),
      baseRevision: null,
      pageId: 'suppressed-context',
      content,
      summary: 'Save my cited entry',
    });
    expect(saved.status).toBe(200);
    const credential = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: f.userId,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const model = async (operation: string, input: Record<string, unknown> = {}) => {
      const response = await f.app.request('/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${credential.secret}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'openkit_call', arguments: { operation, input } },
        }),
      });
      expect(response.status).toBe(200);
      const envelope = await response.json();
      expect(envelope.error).toBeUndefined();
      expect(envelope.result.isError).toBeUndefined();
      return JSON.parse(envelope.result.content[0].text);
    };
    expect(await model('memory.source.read', { sourceId: captured.body.source.id })).toMatchObject({
      source: { content: 'A forgotten source sentence.' },
    });
    // The native forget tests establish confirmation; this canonical fixture isolates disclosure before Git cleanup.
    appendMemorySuppression(userMemoryRoot(f.dataRoot, f.userId), {
      userId: f.userId,
      requestId: randomUUID(),
      pageId: 'suppressed-context',
      lastRevision: saved.body.notebookRevision,
      digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
      actorId: f.userId,
      sourceFingerprints: [reference],
    });
    expect(await model('memory.source.read', { sourceId: captured.body.source.id })).toEqual({
      source: null,
    });
    const listed = await model('memory.source.list');
    expect(listed.items.map((row: { id: string }) => row.id)).toEqual([other.body.source.id]);
    expect(await f.call('memory.source.read', { sourceId: captured.body.source.id })).toMatchObject(
      {
        status: 200,
        body: { source: { content: 'A forgotten source sentence.' } },
      }
    );
  });

  it('refuses to replace a missing User database while established Source bytes remain', async () => {
    const f = fixture();
    const input = {
      requestId: randomUUID(),
      kind: 'document',
      title: 'A retained Source',
      content: 'Keep the original Source and its command authority.',
    };
    const first = await f.call('memory.source.register', input);
    expect(first.status).toBe(200);
    const registry = join(f.dataRoot, 'users', f.userId, 'sources', 'registry');
    const database = userDbPath(f.dataRoot, f.userId);
    rmSync(database);
    const refused = await f.call('memory.source.register', {
      ...input,
      requestId: randomUUID(),
    });
    expect(refused).toMatchObject({ status: 503, body: { code: 'recovery_required' } });
    expect(existsSync(database)).toBe(false);
    expect(readdirSync(registry)).toEqual([`${first.body.source.id}.json`]);
  });

  it('refuses another owner and unjoined transcript provenance without capturing them', async () => {
    const f = fixture();
    const first = await f.call('memory.source.register', {
      requestId: randomUUID(),
      kind: 'document',
      title: 'My explicit input',
      content: 'This text belongs to my Source scope.',
    });
    expect(first.status).toBe(200);
    expect(
      (
        await f.call('memory.source.list', {
          userId: 'usr_00000000-0000-7000-8000-000000000002',
        })
      ).status
    ).toBe(403);
    expect(
      (
        await f.call('memory.source.register', {
          requestId: randomUUID(),
          kind: 'transcript',
          title: 'No invented conversation capture',
          content: 'This payload has no trusted conversation provenance.',
        })
      ).status
    ).toBe(400);
    expect((await f.call('memory.source.list')).body.items).toEqual([first.body.source]);
  });
});

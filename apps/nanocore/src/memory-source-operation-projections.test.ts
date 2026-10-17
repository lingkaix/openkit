import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { FsStore } from './lib/store.js';
import { closeRetrievalServices } from './retrieval-service.js';
import { openCoreDb } from './storage/db.js';
import { userMemoryRoot } from './storage/fs-layout.js';
import { applyMigrations } from './storage/migrate.js';
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
  return { call, dataRoot, userId };
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

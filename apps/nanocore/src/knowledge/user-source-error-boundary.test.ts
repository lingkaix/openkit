// openkit-test-platform: posix
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserMemorySourceSchema } from '@openkit/app-api-schemas';
import { PROTOCOL_VERSION } from '@openkit/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import { FsStore } from '../lib/store.js';
import { closeRetrievalServices } from '../retrieval-service.js';
import { openCoreDb } from '../storage/db.js';
import { userMemoryRoot } from '../storage/fs-layout.js';
import { applyMigrations } from '../storage/migrate.js';
import { createApp } from '../test-support/app.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { KnowledgeNotebook } from './notebook.js';

/** Creates actual self authority and public operations over private local Storage. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'user-source-error-boundary-'));
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
  const register = (title: string, content: string) =>
    app.request(
      ...operationRequest(
        'memory.source.register',
        {},
        { body: JSON.stringify({ requestId: randomUUID(), kind: 'document', title, content }) }
      )
    );
  return { dataRoot, userId, store, app, register };
}

/** Includes every original byte so a refused capture cannot leave an unnoticed orphan. */
function rawFiles(root: string): Record<string, string> {
  if (!existsSync(root)) return {};
  const files: Record<string, string> = {};
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const [path, bytes] of Object.entries(rawFiles(join(root, entry.name))))
        files[`${entry.name}/${path}`] = bytes;
    } else files[entry.name] = readFileSync(join(root, entry.name)).toString('base64');
  }
  return files;
}

describe('public User Source error contract', () => {
  it('returns JSON invalid_request for an invalid new profile without capture effects', async () => {
    const f = fixture();
    const healthyContent = 'Exact admitted User original.\r\nUnicode Ω 雪.\n';
    const captured = await f.register('Valid User original', healthyContent);
    expect(captured.status).toBe(200);
    const source = UserMemorySourceSchema.parse((await captured.json()).source);
    expect(source.ownerScope).toEqual({ kind: 'user', userId: f.userId });
    const read = await f.app.request(
      ...operationRequest('memory.source.read', { sourceId: source.id })
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ source: { ...source, content: healthyContent } });
    const root = userMemoryRoot(f.dataRoot, f.userId);
    const notebook = new KnowledgeNotebook({ repositoryPath: join(root, 'notebook.git') });
    const before = {
      revision: notebook.publishedRevision(),
      pointers: notebook.readSourcePointers(notebook.publishedRevision()),
      raw: rawFiles(join(root, 'raw')),
      receipts: f.store.listCommandRequests(),
    };
    expect(Object.keys(before.pointers)).toEqual([source.id]);

    // Keep the governed secret-like title refusal; this literal contains no credential.
    const rejectedContent = 'Harmless rejected User original that must not appear in errors.\n';
    const response = await f.register('Foreign secret title', rejectedContent);
    const text = await response.text();
    expect.soft(response.status).toBe(400);
    expect.soft(response.headers.get('content-type')).toContain('application/json');
    const body: unknown = response.headers.get('content-type')?.includes('application/json')
      ? JSON.parse(text)
      : text;
    expect.soft(body).toMatchObject({ protocolVersion: PROTOCOL_VERSION, code: 'invalid_request' });
    expect.soft(Buffer.byteLength(text)).toBeLessThanOrEqual(64 * 1024);
    expect.soft(text).not.toContain('Harmless rejected User original');
    expect.soft(text).not.toContain(f.dataRoot);
    expect({
      revision: notebook.publishedRevision(),
      pointers: notebook.readSourcePointers(notebook.publishedRevision()),
      raw: rawFiles(join(root, 'raw')),
      receipts: f.store.listCommandRequests(),
    }).toEqual(before);
  });
});

// openkit-test-platform: posix
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RegisterKnowledgeSourceResponseSchema } from '@openkit/app-api-schemas';
import { describe, expect, it, onTestFinished } from 'vitest';
import { FsStore } from '../lib/store.js';
import { closeRetrievalServices } from '../retrieval-service.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createApp } from '../test-support/app.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { KnowledgeNotebook } from './notebook.js';

const ORIGINAL =
  'Harmless literal original used only to check error disclosure.\r\nUnicode Ω 雪.\n';

/** Creates an authorized owner and the real HTTP, Notebook, SQLite and Storage boundary. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'source-error-boundary-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Source error boundary');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  applyScopedMigrations(workspaceDb);
  const app = createApp({ coreDb, dataRoot, store });
  const root = join(dataRoot, 'workspaces', workspace.id, 'knowledge');
  const notebook = new KnowledgeNotebook({ repositoryPath: join(root, 'notebook.git') });
  const register = (title: string) =>
    app.request(
      ...operationRequest(
        'knowledge.source.register',
        { workspaceId: workspace.id },
        {
          body: JSON.stringify({
            requestId: randomUUID(),
            kind: 'document',
            title,
            content: ORIGINAL,
          }),
        }
      )
    );
  onTestFinished(async () => {
    await closeRetrievalServices();
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  return { app, dataRoot, store, workspace, notebook, root, register };
}

/** Observes every managed original, including files orphaned by a refused capture. */
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

/** Checks the native error envelope without letting a non-JSON failure hide state assertions. */
async function expectError(response: Response, status: number, code: string, dataRoot: string) {
  const text = await response.text();
  expect.soft(response.status).toBe(status);
  expect.soft(response.headers.get('content-type')).toContain('application/json');
  const body: unknown = response.headers.get('content-type')?.includes('application/json')
    ? JSON.parse(text)
    : text;
  expect.soft(body).toMatchObject({ protocolVersion: '0.6.0', code });
  expect.soft(Buffer.byteLength(text)).toBeLessThanOrEqual(64 * 1024);
  expect.soft(text).not.toContain(ORIGINAL.trim());
  expect.soft(text).not.toContain('Harmless literal original');
  expect.soft(text).not.toContain(dataRoot);
}

describe('public Source error contract', () => {
  it('refuses an invalid new profile as JSON invalid_request without capture effects', async () => {
    const f = fixture();
    const before = {
      revision: f.notebook.publishedRevision(),
      pointers: f.notebook.readSourcePointers(f.notebook.publishedRevision()),
      sources: f.store.listKnowledgeSources(f.workspace.id),
      raw: rawFiles(join(f.root, 'raw')),
      receipts: f.store.listCommandRequests(),
    };

    // The governed profile rejects this harmless title; capture must not relax that rule.
    const response = await f.register('Foreign secret title');
    await expectError(response, 400, 'invalid_request', f.dataRoot);
    expect({
      revision: f.notebook.publishedRevision(),
      pointers: f.notebook.readSourcePointers(f.notebook.publishedRevision()),
      sources: f.store.listKnowledgeSources(f.workspace.id),
      raw: rawFiles(join(f.root, 'raw')),
      receipts: f.store.listCommandRequests(),
    }).toEqual(before);
  });

  it.each([
    'knowledge.source.list',
    'knowledge.source.read',
  ] as const)('preserves a typed failure for a corrupt retained pointer through %s without repair', async (operation) => {
    const f = fixture();
    const captured = await f.register('Valid original evidence');
    expect(captured.status).toBe(200);
    const { source } = RegisterKnowledgeSourceResponseSchema.parse(await captured.json());
    const selectors = {
      workspaceId: f.workspace.id,
      ...(operation === 'knowledge.source.read' ? { sourceId: source.id } : {}),
    };
    const healthy = await f.app.request(...operationRequest(operation, selectors));
    expect(healthy.status).toBe(200);
    expect(await healthy.json()).toMatchObject(
      operation === 'knowledge.source.read' ? { source } : { items: [source] }
    );
    const baseRevision = f.notebook.publishedRevision();
    const pointers = f.notebook.readSourcePointers(baseRevision);
    const pointer = pointers[source.id]!;
    const corrupt = pointer.replace(/^capturedAt:.*\n/m, '');
    expect(corrupt).not.toBe(pointer);
    // Test-owned corruption of one retained required field; all other Source bytes remain exact.
    const candidateRevision = f.notebook.prepareSourcePointers({
      baseRevision,
      changes: { [source.id]: corrupt },
      metadata: f.notebook.inspectRevision(baseRevision).metadata,
    });
    f.notebook.publish({ baseRevision, candidateRevision });
    const before = {
      revision: f.notebook.publishedRevision(),
      pointers: f.notebook.readSourcePointers(candidateRevision),
      raw: rawFiles(join(f.root, 'raw')),
      receipts: f.store.listCommandRequests(),
    };
    expect(before.pointers).toEqual({ ...pointers, [source.id]: corrupt });

    const response = await f.app.request(...operationRequest(operation, selectors));
    // A corrupt pointer cannot establish Source audience; exact reads keep the uniform refusal.
    await expectError(
      response,
      operation === 'knowledge.source.read' ? 403 : 409,
      operation === 'knowledge.source.read' ? 'workspace_access_denied' : 'recovery_required',
      f.dataRoot
    );
    expect({
      revision: f.notebook.publishedRevision(),
      pointers: f.notebook.readSourcePointers(f.notebook.publishedRevision()),
      raw: rawFiles(join(f.root, 'raw')),
      receipts: f.store.listCommandRequests(),
    }).toEqual(before);
  });
});

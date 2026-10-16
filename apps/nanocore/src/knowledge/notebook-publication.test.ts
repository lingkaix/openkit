import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { FsStore } from '../lib/store.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { KnowledgeNotebook } from './notebook.js';
import { publishWorkspaceNotebook } from './notebook-publication.js';
import { DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT } from './okf.js';

const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const producer = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;

/** Real Git, existing Workspace Audit and existing receipts; current authorization stays a native caller duty. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'notebook-publisher-'));
  const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
  applyScopedMigrations(workspaceDb);
  const store = new FsStore();
  const repositoryPath = join(dataRoot, 'notebook.git');
  const notebook = new KnowledgeNotebook({ repositoryPath });
  const initial = notebook.initialize({
    metadata: {
      summary: 'Create notebook',
      changeRequest: { requestId: randomUUID(), inputDigest: commandInputHash('initialize') },
      producer,
      authority: { kind: 'direct', instructionReference: 'creation:fixture' },
      sourceReferences: [],
    },
  });
  onTestFinished(() => {
    workspaceDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const revalidate = vi.fn(() => ({
    scopeSchemaText: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
    registeredSources: new Map<string, string | null>(),
    resolvedReferences: new Map<string, ReadonlySet<string>>(),
  }));
  const dependencies = {
    store,
    workspaceDb,
    notebook,
    producer,
    revalidate,
    inflightCommands: new WeakMap(),
  };
  const request = {
    workspaceId,
    requestId: randomUUID(),
    baseRevision: initial,
    summary: 'Update index',
    changes: [{ path: 'index.md', content: '---\nokf_version: "0.2"\n---\n# Updated notebook\n' }],
  };
  return {
    ...dependencies,
    dataRoot,
    repositoryPath,
    initial,
    request,
    publish: (value = request) => publishWorkspaceNotebook(dependencies, value),
  };
}

describe('Notebook publication through existing Audit and command receipts', () => {
  it('publishes once, retains exact facts, and replays the old commit after a later publication', async () => {
    const f = fixture();
    const [first, duplicate] = await Promise.all([f.publish(), f.publish()]);
    expect(duplicate).toEqual(first);
    expect(first).toMatchObject({
      outcome: 'published',
      baseRevision: f.initial,
      changedPageIds: ['index'],
      notebookRevision: expect.any(String),
    });
    expect(f.notebook.readRevision(first.notebookRevision).metadata.changeRequest.inputDigest).toBe(
      commandInputHash(f.request)
    );
    const next = await f.publish({
      ...f.request,
      requestId: randomUUID(),
      baseRevision: first.notebookRevision,
      summary: 'Later change',
    });
    expect(await f.publish()).toEqual(first);
    expect(f.notebook.publishedRevision()).toBe(next.notebookRevision);
    expect(
      f.workspaceDb.sqlite
        .prepare(
          'SELECT response_kind AS kind, response_id AS id, response_json AS extra FROM idempotency_requests WHERE request_id = ?'
        )
        .get(f.request.requestId)
    ).toEqual({ kind: 'knowledge_notebook_revision', id: first.notebookRevision, extra: null });
  });

  it('rejects changed input and a stale base without changing the winner', async () => {
    const f = fixture();
    const first = await f.publish();
    await expect(f.publish({ ...f.request, summary: 'Changed input' })).rejects.toMatchObject({
      code: 'idempotency_key_conflict',
    });
    await expect(f.publish({ ...f.request, requestId: randomUUID() })).rejects.toMatchObject({
      code: 'conflict',
      currentRevision: first.notebookRevision,
    });
    expect(f.notebook.publishedRevision()).toBe(first.notebookRevision);
  });

  it('refuses publication if admission Audit fails, then admits the unchanged request after fault removal', async () => {
    const f = fixture();
    f.workspaceDb.sqlite.exec(
      "CREATE TRIGGER reject_admission BEFORE INSERT ON audit_events WHEN NEW.action = 'knowledge.notebook.admit' BEGIN SELECT RAISE(ABORT, 'test fault'); END"
    );
    await expect(f.publish()).rejects.toThrow();
    expect(f.notebook.publishedRevision()).toBe(f.initial);
    f.workspaceDb.sqlite.exec('DROP TRIGGER reject_admission');
    expect((await f.publish()).outcome).toBe('published');
  });

  it('retains admission when actual ref publication fails and never creates a receipt', async () => {
    const f = fixture();
    writeFileSync(join(f.repositoryPath, 'refs/heads/published.lock'), 'Test-owned lock.\n');
    await expect(f.publish()).rejects.toMatchObject({ code: 'recovery_required' });
    expect(f.notebook.publishedRevision()).toBe(f.initial);
    expect(
      f.workspaceDb.sqlite
        .prepare(
          "SELECT count(*) AS count FROM audit_events WHERE action = 'knowledge.notebook.admit'"
        )
        .get()
    ).toEqual({ count: 1 });
    expect(
      f.workspaceDb.sqlite.prepare('SELECT count(*) AS count FROM idempotency_requests').get()
    ).toEqual({ count: 0 });
  });

  it.each([
    'receipt',
    'completion',
  ] as const)('refuses a previously published request with missing %s evidence', async (missing) => {
    const f = fixture();
    const first = await f.publish();
    if (missing === 'receipt')
      f.workspaceDb.sqlite
        .prepare('DELETE FROM idempotency_requests WHERE request_id = ?')
        .run(f.request.requestId);
    else
      f.workspaceDb.sqlite
        .prepare('DELETE FROM audit_events WHERE action = ? AND request_id = ?')
        .run('knowledge.notebook.update', f.request.requestId);
    await expect(f.publish()).rejects.toMatchObject({ code: 'recovery_required' });
    expect(f.notebook.publishedRevision()).toBe(first.notebookRevision);
  });

  it.each([
    'receipt',
    'completion',
  ] as const)('keeps the published commit inspectable after an actual %s write fault', async (fault) => {
    const f = fixture();
    f.workspaceDb.sqlite.exec(
      fault === 'receipt'
        ? "CREATE TRIGGER reject_completion BEFORE INSERT ON idempotency_requests BEGIN SELECT RAISE(ABORT, 'test receipt fault'); END"
        : "CREATE TRIGGER reject_completion BEFORE INSERT ON audit_events WHEN NEW.action = 'knowledge.notebook.update' BEGIN SELECT RAISE(ABORT, 'test completion fault'); END"
    );
    await expect(f.publish()).rejects.toThrow();
    const published = f.notebook.publishedRevision();
    expect(published).not.toBe(f.initial);
    expect(f.notebook.readRevision(published).metadata.changeRequest.requestId).toBe(
      f.request.requestId
    );
    f.workspaceDb.sqlite.exec('DROP TRIGGER reject_completion');
    await expect(f.publish()).rejects.toMatchObject({ code: 'recovery_required' });
    expect(f.notebook.publishedRevision()).toBe(published);
    expect(
      f.workspaceDb.sqlite.prepare('SELECT count(*) AS count FROM idempotency_requests').get()
    ).toEqual({ count: 0 });
  });

  it('rechecks current admission before candidate reads and immediately before publication', async () => {
    const f = fixture();
    f.revalidate
      .mockImplementationOnce(() => ({
        scopeSchemaText: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
        registeredSources: new Map(),
        resolvedReferences: new Map(),
      }))
      .mockImplementationOnce(() => ({
        scopeSchemaText: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
        registeredSources: new Map(),
        resolvedReferences: new Map(),
      }))
      .mockImplementationOnce(() => {
        throw new Error('Current authority revoked.');
      });
    await expect(f.publish()).rejects.toThrow('Current authority revoked.');
    expect(f.notebook.publishedRevision()).toBe(f.initial);
    expect(
      f.workspaceDb.sqlite.prepare('SELECT count(*) AS count FROM audit_events').get()
    ).toEqual({ count: 0 });
  });
});

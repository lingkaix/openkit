import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureLocalUser } from './auth/identity.js';
import { FsStore } from './lib/store.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const OWNER_SCOPE = { kind: 'workspace', workspaceId: 'ws_demo' } as const;
const OPERATION = 'knowledge.notebook.update';

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
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-notebook-publication-'));
  const coreDb = openCoreDb(dataRoot);
  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({ coreDb, workspaceId: 'ws_demo', ownerUserId: 'user_local' });
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
    applyScopedMigrations(workspaceDb);
    const f = {
      dataRoot,
      coreDb,
      store,
      workspaceDb,
      app: createApp({ coreDb, dataRoot, store }),
      repositoryPath: join(dataRoot, 'workspaces', 'ws_demo', 'knowledge', 'notebook.git'),
    };
    fixtures.push(f);
    return f;
  } catch (error) {
    coreDb.sqlite.close();
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
  f.workspaceDb = openWorkspaceDb(f.dataRoot, 'ws_demo');
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
    'scope: {kind: workspace, workspaceId: ws_demo}',
    'source_refs: []',
    'review_state: user-authored',
    'sensitivity: normal',
    'freshness: current',
    `openkit_entry_id: ${id}`,
    'openkit_entry_kind: project-context',
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
  const response = await f.app.request('/api/app/operations/knowledge.list', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: 'ws_demo' }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    notebookRevision: string;
    items: Array<{ id: string; content: string }>;
  };
  expect(body, 'fresh scope initialization must expose its actual published Git revision').toEqual(
    expect.objectContaining({ notebookRevision: expect.any(String), items: expect.any(Array) })
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
    body: JSON.stringify({ workspaceId: 'ws_demo', ...body }),
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

afterEach(() => {
  vi.useRealTimers();
  for (const f of fixtures.splice(0)) {
    if (f.workspaceDb.sqlite.open) f.workspaceDb.sqlite.close();
    if (f.coreDb.sqlite.open) f.coreDb.sqlite.close();
    rmSync(f.dataRoot, { recursive: true, force: true });
  }
});

describe('native Workspace notebook publication with real Git and SQLite', () => {
  it('retains generic valid pages without managed entry fields or body text across reopen', async () => {
    const f = fixture();
    const initial = await listing(f);
    const raw = page('rough', '')
      .replace(/^openkit_entry_id:.*\n/m, '')
      .replace(/^openkit_entry_kind:.*\n/m, '');
    const published = await publish(f, {
      requestId: randomUUID(),
      baseRevision: initial.notebookRevision,
      changes: [{ path: 'rough.md', content: raw }],
      summary: 'Keep an unfinished note',
    });
    expect(git(f, ['show', `${published.notebookRevision}:pages/rough.md`])).toBe(raw);
    expect((await listing(f)).items).toContainEqual(
      expect.objectContaining({ id: 'rough', content: '' })
    );
    reopen(f);
    expect((await listing(f)).items).toContainEqual(
      expect.objectContaining({ id: 'rough', content: '' })
    );
    expect(git(f, ['show', `${published.notebookRevision}:pages/rough.md`])).toBe(raw);
  });

  it('publishes the initial notebook inside fresh Workspace creation before any notebook read', () => {
    const f = fixture();
    expect(existsSync(f.repositoryPath)).toBe(true);
    const revision = git(f, ['rev-parse', 'refs/heads/published']).trim();
    expect(git(f, ['rev-list', '--parents', '-1', revision]).trim()).toBe(revision);
    expect(git(f, ['show', `${revision}:pages/index.md`])).toContain('# Notebook');
    const metadata = JSON.parse(git(f, ['show', '-s', '--format=%B', revision]));
    expect(metadata).toMatchObject({
      producer: { kind: 'user', id: 'user_local' },
      authority: { kind: 'direct' },
      sourceReferences: [],
    });
    reopen(f);
    expect(git(f, ['rev-parse', 'refs/heads/published']).trim()).toBe(revision);
  });

  it('publishes two pages once and replays the exact old receipt after a later edit and reopen', async () => {
    const f = fixture();
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
      producer: { kind: 'user', id: 'user_local' },
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
    const f = fixture();
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
    const f = fixture();
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
    const f = fixture();
    const initial = await listing(f);
    const staleStore = new FsStore({ dataRoot: f.dataRoot });
    const published = await publish(
      f,
      edit(initial.notebookRevision, 'Only the notebook owns these bytes.')
    );
    const exactBytes = git(f, ['show', `${published.notebookRevision}:pages/alpha.md`]);
    const count = publishedCount(f);
    // An unstamped optional materialization is inert; broad persistence must not publish or delete it.
    const pagesRoot = join(f.dataRoot, 'workspaces', 'ws_demo', 'knowledge', 'pages');
    mkdirSync(pagesRoot, { recursive: true });
    const sentinelPath = join(pagesRoot, 'materialization-sentinel.md');
    const sentinel = page('materialization-sentinel', 'Inert materialization bytes.');
    writeFileSync(sentinelPath, sentinel);
    staleStore.updateThread('ws_demo', 'th_demo', { name: 'Unrelated persisted Thread title' });
    expect(readFileSync(sentinelPath, 'utf8')).toBe(sentinel);
    reopen(f);
    const retained = await listing(f);
    expect(retained.notebookRevision).toBe(published.notebookRevision);
    expect(retained.items.find((item) => item.id === 'alpha')?.content).toContain(
      'Only the notebook owns these bytes.'
    );
    expect(publishedCount(f)).toBe(count);
    expect(git(f, ['show', `${retained.notebookRevision}:pages/alpha.md`])).toBe(exactBytes);
  });

  it('cannot publish when the real SQLite admission Audit write fails', async () => {
    const f = fixture();
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
    const f = fixture();
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
    const f = fixture();
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

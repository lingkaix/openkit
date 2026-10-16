import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureLocalUser } from './auth/identity.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const fixtures: Array<ReturnType<typeof fixture>> = [];

/** Compose actual public admission, Store, SQLite and Git through the existing fresh-scope initializer. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-notebook-history-'));
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

/** Fix page expectations from the accepted v4 profile, including unknown metadata that must survive. */
function page(id: string, body: string, source: string): string {
  return [
    '---',
    'type: KnowledgePage',
    `title: ${JSON.stringify(id)}`,
    'schema_version: openkit-scope-knowledge-schema-v4',
    'requiredFeatures: [openkit.knowledge-owner-scope.v1, openkit.knowledge-git-notebook.v1]',
    'openkit_status: active',
    'status: stable',
    'scope: {kind: workspace, workspaceId: ws_demo}',
    `source_refs: [${JSON.stringify(source)}]`,
    'review_state: accepted',
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

/** Independent raw Git observation of the actual published owner. */
function git(f: ReturnType<typeof fixture>, ...args: string[]) {
  return execFileSync('git', ['--git-dir', f.repositoryPath, ...args], {
    encoding: 'utf8',
  }).trimEnd();
}
/** Existing native route; request identity uses the common command header. */
async function call(
  f: ReturnType<typeof fixture>,
  operation: string,
  input: Record<string, unknown>
) {
  const { requestId, ...body } = input;
  const response = await f.app.request(`/api/app/operations/${operation}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(requestId ? { 'x-openkit-request-id': String(requestId) } : {}),
    },
    body: JSON.stringify({ workspaceId: 'ws_demo', ...body }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: response.headers.get('content-type')?.includes('application/json')
      ? JSON.parse(text)
      : text,
  };
}
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.workspaceDb.sqlite.close();
    f.coreDb.sqlite.close();
    rmSync(f.dataRoot, { recursive: true, force: true });
  }
});

/** Seed through current native source admission and fixed-base publication. */
async function seed(f: ReturnType<typeof fixture>) {
  const source = await call(f, 'knowledge.source.register', {
    requestId: randomUUID(),
    kind: 'document',
    title: 'Synthetic source',
    content: 'Independent evidence.',
  });
  expect(source.status, JSON.stringify(source.body)).toBe(200);
  const reference = `source:${source.body.source.id}@${source.body.source.contentDigest}`;
  const original = page('alpha', 'Original exact bytes.\n', reference).replace(
    'review_state: accepted',
    'review_state: user-authored'
  );
  const initial = git(f, 'rev-parse', 'refs/heads/published');
  const first = await call(f, 'knowledge.notebook.update', {
    requestId: randomUUID(),
    baseRevision: initial,
    changes: [{ path: 'alpha.md', content: original }],
    summary: 'Original human text',
  });
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  return { original, reference, initial, revision: first.body.notebookRevision };
}

describe('native Workspace Notebook history and restore', () => {
  it('returns authorized exact history/diff and restores with new evidence without overwriting a stale winner', async () => {
    const f = fixture();
    const s = await seed(f);
    const updated = s.original.replace('Original exact bytes.', 'Later exact bytes.');
    const edit = await call(f, 'knowledge.notebook.update', {
      requestId: randomUUID(),
      baseRevision: s.revision,
      changes: [{ path: 'alpha.md', content: updated }],
      summary: 'Later human text',
    });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    const baseRevision = edit.body.notebookRevision;
    const history = await call(f, 'knowledge.notebook.history', { limit: 2 });
    expect(history.status, JSON.stringify(history.body)).toBe(200);
    expect(history.body.revisions).toEqual([
      {
        revision: baseRevision,
        parentRevision: s.revision,
        availability: 'available',
        summary: 'Later human text',
        producer: { kind: 'user', id: 'user_local' },
        changedPaths: ['alpha.md'],
      },
      {
        revision: s.revision,
        parentRevision: s.initial,
        availability: 'available',
        summary: 'Original human text',
        producer: { kind: 'user', id: 'user_local' },
        changedPaths: ['alpha.md'],
      },
    ]);
    const diff = await call(f, 'knowledge.notebook.diff', {
      baseRevision,
      targetRevision: s.revision,
      paths: ['alpha.md'],
    });
    expect(diff.status, JSON.stringify(diff.body)).toBe(200);
    expect(diff.body.changes).toEqual([{ path: 'alpha.md', before: updated, after: s.original }]);
    const input = {
      requestId: randomUUID(),
      baseRevision,
      targetRevision: s.revision,
      paths: ['alpha.md'],
      summary: 'Restore original text',
    };
    const restore = await call(f, 'knowledge.notebook.restore', input);
    expect(restore.status, JSON.stringify(restore.body)).toBe(200);
    const winner = restore.body.notebookRevision;
    expect(winner).not.toBe(s.revision);
    expect(git(f, 'rev-parse', `${winner}^`)).toBe(baseRevision);
    expect(
      execFileSync('git', ['--git-dir', f.repositoryPath, 'show', `${winner}:pages/alpha.md`], {
        encoding: 'utf8',
      })
    ).toBe(s.original);
    expect(restore.body.receiptRef.operation).toBe('knowledge.notebook.restore');
    expect(await call(f, 'knowledge.notebook.restore', input)).toEqual(restore);
    const stale = await call(f, 'knowledge.notebook.restore', {
      ...input,
      requestId: randomUUID(),
    });
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect(git(f, 'rev-parse', 'refs/heads/published')).toBe(winner);
    const removal = {
      requestId: randomUUID(),
      baseRevision: winner,
      targetRevision: s.initial,
      paths: ['alpha.md'],
      summary: 'Explicit removal through restore',
    };
    expect((await call(f, 'knowledge.notebook.restore', removal)).status).toBe(400);
    expect(git(f, 'rev-parse', 'refs/heads/published')).toBe(winner);
    const removed = await call(f, 'knowledge.notebook.restore', {
      ...removal,
      confirmRemoval: true,
    });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(
      git(f, 'ls-tree', '--name-only', `${removed.body.notebookRevision}:pages`)
    ).not.toContain('alpha.md');
    expect(
      execFileSync('git', ['--git-dir', f.repositoryPath, 'show', `${s.revision}:pages/alpha.md`], {
        encoding: 'utf8',
      })
    ).toBe(s.original);
    const admissions = f.workspaceDb.sqlite
      .prepare(
        "SELECT notebook_admission_json AS admission FROM audit_events WHERE request_id = ? AND action = 'knowledge.notebook.published'"
      )
      .all(input.requestId);
    expect(admissions).toHaveLength(1);
  });
});

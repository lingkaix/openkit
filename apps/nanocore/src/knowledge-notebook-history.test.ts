import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from './auth/access-token-store.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID as LOCAL_USER_ID } from './test-support/local-user.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from './test-support/demo-store.js';
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
    recordWorkspaceOwnerMembership({ coreDb, workspaceId: DEMO_WORKSPACE_ID, ownerUserId: LOCAL_USER_ID });
    const workspaceDb = openWorkspaceDb(dataRoot, DEMO_WORKSPACE_ID);
    applyScopedMigrations(workspaceDb);
    const f = {
      dataRoot,
      coreDb,
      store,
      workspaceDb,
      app: createApp({ coreDb, dataRoot, store }),
      repositoryPath: join(dataRoot, 'workspaces', DEMO_WORKSPACE_ID, 'knowledge', 'notebook.git'),
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
    'requiredFeatures: [ openkit.knowledge-owner-scope.v1, openkit.knowledge-git-notebook.v1 ]',
    'openkit_status: active',
    'status: stable',
    `scope: { kind: workspace, workspaceId: ${DEMO_WORKSPACE_ID} }`,
    `source_refs: [ ${JSON.stringify(source)} ]`,
    'review_state: accepted',
    'sensitivity: normal',
    'freshness: current',
    `openkit_entry_id: ${id}`,
    'openkit_entry_kind: project-context',
    'created_at: "2026-10-16T00:00:00.000Z"',
    'updated_at: "2026-10-16T00:00:00.000Z"',
    'custom: { preserved: [ one, two ] }',
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
    body: JSON.stringify({ workspaceId: DEMO_WORKSPACE_ID, ...body }),
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
  const original = page('alpha', 'Original exact bytes.\n', reference);
  const initial = git(f, 'rev-parse', 'refs/heads/published');
  const proposal = await call(f, 'knowledge.proposal.draft', {
    requestId: randomUUID(),
    baseRevision: initial,
    knowledgePageId: 'alpha',
    canonicalPageBytes: original,
    contentDigest: `sha256:${createHash('sha256').update(original).digest('hex')}`,
    sourceReferences: [reference],
    rationale: 'Original human text',
    confidence: 0.9,
  });
  expect(proposal.status, JSON.stringify(proposal.body)).toBe(200);
  const saved = proposal.body.proposal;
  const proposalDigest = `sha256:${createHash('sha256')
    .update(
      readFileSync(join(f.dataRoot, `workspaces/${DEMO_WORKSPACE_ID}/knowledge/proposals`, `${saved.id}.md`))
    )
    .digest('hex')}`;
  const first = await call(f, 'knowledge.proposal.decide', {
    requestId: randomUUID(),
    proposalId: saved.id,
    decision: 'accepted',
    baseRevision: initial,
    candidateRevision: saved.candidateRevision,
    proposalDigest,
  });
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  return { original, reference, initial, revision: saved.candidateRevision };
}

describe('native Workspace Notebook history and restore', () => {
  it('returns authorized exact history/diff and restores with new evidence without overwriting a stale winner', async () => {
    const f = fixture();
    const s = await seed(f);
    const restored = s.original.replace('review_state: accepted', 'review_state: user-authored');
    const updated = restored.replace('Original exact bytes.', 'Later exact bytes.');
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
        producer: { kind: 'user', id: LOCAL_USER_ID },
        changedPaths: ['alpha.md'],
      },
      {
        revision: s.revision,
        parentRevision: s.initial,
        availability: 'available',
        summary: 'Original human text',
        producer: { kind: 'user', id: LOCAL_USER_ID },
        changedPaths: ['alpha.md'],
      },
    ]);
    expect(history.body.nextRevision).toBe(s.initial);
    const rootHistory = await call(f, 'knowledge.notebook.history', {
      revision: s.initial,
      limit: 1,
    });
    expect(rootHistory.status, JSON.stringify(rootHistory.body)).toBe(200);
    expect(rootHistory.body.revisions[0]).toMatchObject({
      revision: s.initial,
      parentRevision: null,
      availability: 'available',
      changedPaths: ['index.md', 'mem_project.md'],
    });
    expect(rootHistory.body.nextRevision).toBeNull();
    const diff = await call(f, 'knowledge.notebook.diff', {
      baseRevision,
      fromRevision: s.revision,
      pageIds: ['alpha'],
    });
    expect(diff.status, JSON.stringify(diff.body)).toBe(200);
    expect(diff.body.changes).toEqual([{ path: 'alpha.md', before: updated, after: s.original }]);
    const preview = await call(f, 'knowledge.notebook.diff', {
      baseRevision,
      fromRevision: s.revision,
      pageIds: ['alpha'],
      forRestore: true,
    });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.truncated).toBe(false);
    expect(preview.body.changes).toEqual([{ path: 'alpha.md', before: updated, after: restored }]);
    const missing = await call(f, 'knowledge.notebook.restore', {
      requestId: randomUUID(),
      baseRevision,
      fromRevision: s.revision,
      pageIds: ['unavailable'],
      summary: 'Missing historical page',
    });
    expect(missing.status, JSON.stringify(missing.body)).toBe(403);
    expect(git(f, 'rev-parse', 'refs/heads/published')).toBe(baseRevision);
    const input = {
      requestId: randomUUID(),
      baseRevision,
      fromRevision: s.revision,
      pageIds: ['alpha'],
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
    ).toBe(restored);
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
      fromRevision: s.initial,
      pageIds: ['alpha'],
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
        "SELECT notebook_admission_json AS admission FROM audit_events WHERE request_id = ? AND action = 'knowledge.notebook.restore'"
      )
      .all(input.requestId);
    expect(admissions).toHaveLength(1);
  });
  it('bounds ordinary UTF-8 diff display and refuses an oversized restore before publication', async () => {
    const f = fixture();
    const s = await seed(f);
    const large = page('large', '🧭'.repeat(10_000), s.reference).replace(
      'review_state: accepted',
      'review_state: user-authored'
    );
    const published = await call(f, 'knowledge.notebook.update', {
      requestId: randomUUID(),
      baseRevision: s.revision,
      changes: [{ path: 'large.md', content: large }],
      summary: 'Large synthetic page',
    });
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    const updated = large.replace('🧭', '🗺');
    const removed = page('removed', 'Selected removed text.', s.reference).replace(
      'review_state: accepted',
      'review_state: user-authored'
    );
    const current = await call(f, 'knowledge.notebook.update', {
      requestId: randomUUID(),
      baseRevision: published.body.notebookRevision,
      changes: [
        { path: 'large.md', content: updated },
        { path: 'removed.md', content: removed },
      ],
      summary: 'Large selected restore with removal',
    });
    expect(current.status, JSON.stringify(current.body)).toBe(200);
    const selection = {
      baseRevision: current.body.notebookRevision,
      fromRevision: published.body.notebookRevision,
      pageIds: ['large', 'removed'],
    };
    expect(Buffer.byteLength(updated)).toBeLessThan(64 * 1024);
    expect(Buffer.byteLength(large)).toBeLessThan(64 * 1024);
    expect(Buffer.byteLength(updated) + Buffer.byteLength(large)).toBeGreaterThan(64 * 1024);
    const diff = await call(f, 'knowledge.notebook.diff', selection);
    expect(diff.status, JSON.stringify(diff.body)).toBe(200);
    expect(diff.body.truncated).toBe(true);
    expect(diff.body.changes).toHaveLength(2);
    const [displayed, removal] = diff.body.changes;
    expect(displayed.path).toBe('large.md');
    expect(displayed.before).toBe(updated);
    expect(large.startsWith(displayed.after)).toBe(true);
    expect(displayed.after).not.toContain('\uFFFD');
    expect(displayed.after).not.toBe(large);
    expect(removal.path).toBe('removed.md');
    expect(removal.after).toBeNull();
    expect(removed.startsWith(removal.before)).toBe(true);
    expect(removal.before).not.toBe(removed);
    expect(
      diff.body.changes.reduce(
        (bytes: number, change: { before: string | null; after: string | null }) =>
          bytes + Buffer.byteLength(change.before ?? '') + Buffer.byteLength(change.after ?? ''),
        0
      )
    ).toBeLessThanOrEqual(64 * 1024);
    const receipts = f.store.listCommandRequests();
    for (const result of [
      await call(f, 'knowledge.notebook.diff', { ...selection, forRestore: true }),
      await call(f, 'knowledge.notebook.restore', {
        ...selection,
        requestId: randomUUID(),
        summary: 'Oversized removal confirmation',
        confirmRemoval: true,
      }),
    ]) {
      expect(result.status, JSON.stringify(result.body)).toBe(400);
      expect(result.body).toMatchObject({
        code: 'invalid_request',
        message: 'Selected Notebook diff exceeds the 64 KiB display limit. Select fewer pages.',
      });
    }
    expect(f.store.listCommandRequests()).toEqual(receipts);
    expect(git(f, 'rev-parse', 'refs/heads/published')).toBe(selection.baseRevision);
    expect(
      execFileSync(
        'git',
        ['--git-dir', f.repositoryPath, 'show', `${selection.baseRevision}:pages/large.md`],
        { encoding: 'utf8' }
      )
    ).toBe(updated);
    expect(
      execFileSync(
        'git',
        ['--git-dir', f.repositoryPath, 'show', `${selection.baseRevision}:pages/removed.md`],
        { encoding: 'utf8' }
      )
    ).toBe(removed);
  });
  it('withholds source-denied historical metadata and bytes and rechecks a revoked credential', async () => {
    const f = fixture();
    const origin = f.store.createThread(DEMO_WORKSPACE_ID, 'Source audience');
    const source = await call(f, 'knowledge.source.register', {
      requestId: randomUUID(),
      kind: 'document',
      title: 'Source',
      content: 'Independent fact.',
      originatingThreadId: origin.id,
    });
    expect(source.status, JSON.stringify(source.body)).toBe(200);
    const original = page(
      'denied-marker',
      'DENIED-BODY-MARKER',
      `source:${source.body.source.id}@${source.body.source.contentDigest}`
    ).replace('review_state: accepted', 'review_state: user-authored');
    const initial = git(f, 'rev-parse', 'refs/heads/published');
    const published = await call(f, 'knowledge.notebook.update', {
      requestId: randomUUID(),
      baseRevision: initial,
      changes: [{ path: 'denied-marker.md', content: original }],
      summary: 'DENIED-SUMMARY-MARKER',
    });
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    const baseRevision = published.body.notebookRevision;
    const issued = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: LOCAL_USER_ID,
      scope: 'workspace',
      workspaceIds: [DEMO_WORKSPACE_ID],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const server = createApp({
      mode: 'server',
      coreDb: f.coreDb,
      dataRoot: f.dataRoot,
      store: f.store,
    });
    const invoke = async (operation: string, input: Record<string, unknown>) => {
      const { requestId, ...body } = input;
      const response = await server.request(`/api/app/operations/${operation}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${issued.secret}`,
          ...(requestId ? { 'x-openkit-request-id': String(requestId) } : {}),
        },
        body: JSON.stringify({ workspaceId: DEMO_WORKSPACE_ID, ...body }),
      });
      return { status: response.status, body: await response.json() };
    };
    expect((await invoke('knowledge.notebook.history', { limit: 1 })).status).toBe(200);
    // Test-owned current audience facts, as in the existing canonical reader regressions; no new Thread transition API.
    Object.assign(origin, {
      visibility: 'private',
      privateOwnerUserId: 'usr_00000000-0000-7000-8000-000000000002',
    });
    const denied = await invoke('knowledge.notebook.history', { limit: 1 });
    expect(denied.status, JSON.stringify(denied.body)).toBe(200);
    expect(denied.body.revisions).toEqual([
      { revision: baseRevision, parentRevision: initial, availability: 'unavailable' },
    ]);
    for (const marker of [
      'denied-marker',
      'DENIED-BODY-MARKER',
      'DENIED-SUMMARY-MARKER',
      source.body.source.id,
      source.body.source.contentDigest,
    ])
      expect(JSON.stringify(denied.body)).not.toContain(marker);
    expect(
      (
        await invoke('knowledge.notebook.diff', {
          baseRevision: initial,
          fromRevision: baseRevision,
          pageIds: ['denied-marker'],
        })
      ).status
    ).toBe(403);
    const restore = {
      requestId: randomUUID(),
      baseRevision,
      fromRevision: initial,
      pageIds: ['denied-marker'],
      summary: 'Remove inaccessible old bytes',
      confirmRemoval: true,
    };
    const receipts = f.store.listCommandRequests();
    expect((await invoke('knowledge.notebook.restore', restore)).status).toBe(403);
    expect(f.store.listCommandRequests()).toEqual(receipts);
    expect(git(f, 'rev-parse', 'refs/heads/published')).toBe(baseRevision);
    revokeOpenKitAccessTokenRecord(f.coreDb, issued.record.tokenId);
    expect((await invoke('knowledge.notebook.history', { limit: 1 })).status).toBe(401);
    expect((await invoke('knowledge.notebook.restore', restore)).status).toBe(401);
    expect(git(f, 'rev-parse', 'refs/heads/published')).toBe(baseRevision);
  });
});

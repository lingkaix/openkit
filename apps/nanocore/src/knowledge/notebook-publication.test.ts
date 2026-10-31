import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { FsStore } from '../lib/store.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { closeWorkspaceProductReadHandles } from '../storage/control-store-products.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openWorkspaceDb } from '../storage/db.js';
import { createAppWithLocalIdentity } from '../test-support/app.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { serializeKnowledgePageFixture } from '../test-support/knowledge-page.js';
import {
  call,
  createOwners,
  currentNotebookRevision,
  decisionInput,
} from '../test-support/knowledge-proposal-authority.js';
import { publishWorkspaceNotebook } from './notebook-publication.js';
import { readWorkspaceNotebookSelection } from './notebook-workspace-selection.js';
import { parseOkfDocument } from './okf.js';

const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const producer = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;

/** Real Git, existing Workspace Audit and existing receipts; current authorization stays a native caller duty. */
async function fixture(initialFiles: Readonly<Record<string, string>> = {}) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'notebook-publisher-'));
  let workspaceDb: ReturnType<typeof openWorkspaceDb> | undefined;
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    closeWorkspaceProductReadHandles(dataRoot);
    if (workspaceDb?.sqlite.open) workspaceDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const store = await createDemoStore({
    dataRoot,
    knowledge: Object.entries(initialFiles).map(([path, content]) => ({
      id: path.replace(/\.md$/, ''),
      path,
      content,
      contentDigest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    })),
  });
  workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
  const workspaceRoot = join(dataRoot, 'workspaces', workspaceId);
  const knowledgeBaseId = readDefaultKnowledgeBaseId({
    dataRoot,
    scope: { kind: 'workspace', workspaceId },
  });
  const selectNotebook = () =>
    readWorkspaceNotebookSelection({
      workspaceDb: workspaceDb!,
      workspaceRoot,
      knowledgeBaseId,
    });
  const selection = selectNotebook();
  const initial = selection.head.notebookCommit;
  const retainedCounts = {
    audit: (
      workspaceDb.sqlite.prepare('SELECT count(*) AS count FROM audit_events').get() as {
        count: number;
      }
    ).count,
    receipts: (
      workspaceDb.sqlite.prepare('SELECT count(*) AS count FROM idempotency_requests').get() as {
        count: number;
      }
    ).count,
  };
  const repositoryPath = join(workspaceRoot, 'knowledge', 'notebook.git');
  const revalidate = vi.fn(() => ({
    pageScopeId: `page/workspace/${workspaceId}/${knowledgeBaseId}`,
    scopeSchemaText: selection.scopeSchemaText,
    reviewRequiredPageIds: [] as string[],
    registeredSources: new Map<string, string | null>(),
    resolvedReferences: new Map<string, ReadonlySet<string>>(),
  }));
  const dependencies = {
    store,
    workspaceDb,
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
    retainedCounts,
    request,
    get notebook() {
      return selectNotebook().notebook;
    },
    publish: (value = request) =>
      publishWorkspaceNotebook({ ...dependencies, notebook: selectNotebook().notebook }, value),
  };
}

function currentFixtureRevision(f: {
  readonly dataRoot: string;
  readonly workspaceDb: ReturnType<typeof openWorkspaceDb>;
}): string {
  return readWorkspaceNotebookSelection({
    workspaceDb: f.workspaceDb,
    workspaceRoot: join(f.dataRoot, 'workspaces', workspaceId),
    knowledgeBaseId: readDefaultKnowledgeBaseId({
      dataRoot: f.dataRoot,
      scope: { kind: 'workspace', workspaceId },
    }),
  }).head.notebookCommit;
}

describe('Notebook publication through existing Audit and command receipts', () => {
  it('edits an existing curated Page below the sources bundle directory', async () => {
    const path = 'sources/notes.md';
    const original = serializeKnowledgePageFixture(
      {
        title: 'Captured research notes',
        content: 'Existing curated interpretation.',
        createdAt: '2026-10-20T00:00:00.000Z',
        updatedAt: '2026-10-20T00:00:00.000Z',
      },
      { kind: 'workspace', workspaceId }
    );
    const corrected = original.replace(
      'Existing curated interpretation.',
      'Corrected curated interpretation.'
    );
    const f = await fixture({ [path]: original });
    expect(f.notebook.readRevision(f.initial).files[path]).toBe(original);
    expect(f.notebook.readSourcePointers(f.initial)).toEqual({});
    const result = await f.publish({
      ...f.request,
      changes: [{ path, content: corrected }],
    });
    expect(f.notebook.readRevision(result.notebookRevision).files[path]).toBe(corrected);
    expect(f.notebook.readSourcePointers(result.notebookRevision)).toEqual({});
    expect(f.notebook.readRevision(f.initial).files[path]).toBe(original);
  });

  it('replays completed bytes after a page becomes protected and refuses a fresh unreviewed change', async () => {
    const f = await fixture();
    const published = await f.publish();
    const facts = f.revalidate();
    f.revalidate.mockImplementation(() => ({ ...facts, reviewRequiredPageIds: ['index'] }));
    expect(await f.publish()).toEqual(published);
    await expect(
      f.publish({
        ...f.request,
        requestId: randomUUID(),
        baseRevision: published.notebookRevision,
        changes: [
          { path: 'index.md', content: '---\nokf_version: "0.2"\n---\n# Protected edit\n' },
        ],
      })
    ).rejects.toMatchObject({ code: 'review_required' });
    expect(currentFixtureRevision(f)).toBe(published.notebookRevision);
  });

  it('rechecks protected-page requirements immediately before ref publication', async () => {
    const f = await fixture();
    const facts = f.revalidate();
    f.revalidate.mockClear();
    f.revalidate.mockImplementation(() => ({
      ...facts,
      reviewRequiredPageIds: f.revalidate.mock.calls.length >= 3 ? ['index'] : [],
    }));
    await expect(f.publish()).rejects.toMatchObject({ code: 'review_required' });
    expect(currentFixtureRevision(f)).toBe(f.initial);
    expect(
      f.workspaceDb.sqlite.prepare('SELECT COUNT(*) AS count FROM audit_events').get()
    ).toEqual({ count: f.retainedCounts.audit });
  });

  it('reconstructs a page publication from its exact old commit after another edit and a new Store', async () => {
    const f = await fixture();
    const path = 'notes/human-entry.md';
    const originalBytes = serializeKnowledgePageFixture(
      {
        title: 'Original title',
        content: 'Original bytes.',
        createdAt: '2026-10-16T00:00:00.000Z',
        updatedAt: '2026-10-16T00:00:00.000Z',
      },
      { kind: 'workspace', workspaceId }
    );
    const input = {
      workspaceId,
      requestId: randomUUID(),
      baseRevision: f.initial,
      changes: [{ path, content: originalBytes }],
      summary: 'Create human page',
    };
    const command = { name: 'knowledge.notebook.create' as const, input };
    const created = await publishWorkspaceNotebook({ ...f, command }, input);
    expect(created).toMatchObject({
      outcome: 'published',
      baseRevision: f.initial,
      changedPageIds: ['notes/human-entry'],
      receiptRef: { operation: 'knowledge.notebook.create', requestId: input.requestId },
    });
    expect(f.notebook.readRevision(created.notebookRevision).files[path]).toBe(originalBytes);
    const laterBytes = serializeKnowledgePageFixture(
      {
        title: 'Original title',
        content: 'Later bytes.',
        createdAt: '2026-10-16T00:00:00.000Z',
        updatedAt: '2026-10-16T00:01:00.000Z',
      },
      { kind: 'workspace', workspaceId }
    );
    const updated = await publishWorkspaceNotebook(f, {
      workspaceId,
      requestId: randomUUID(),
      baseRevision: created.notebookRevision,
      changes: [{ path, content: laterBytes }],
      summary: 'Update human page',
    });
    expect(f.notebook.readRevision(updated.notebookRevision).files[path]).toBe(laterBytes);
    expect(
      await publishWorkspaceNotebook(
        { ...f, command, store: new FsStore({ dataRoot: f.dataRoot }) },
        input
      )
    ).toEqual(created);
    expect(currentFixtureRevision(f)).toBe(updated.notebookRevision);
    expect(f.notebook.readRevision(created.notebookRevision).files[path]).toBe(originalBytes);
    expect(
      f.workspaceDb.sqlite
        .prepare(
          'SELECT command_name AS command, response_kind AS kind FROM idempotency_requests ORDER BY command_name'
        )
        .all()
    ).toEqual([
      { command: 'knowledge.notebook.create', kind: 'knowledge_notebook_revision' },
      { command: 'knowledge.notebook.update', kind: 'knowledge_notebook_revision' },
    ]);
  });

  it('retains exact authored timestamps when an unchanged page request retries a ref failure', async () => {
    const f = await fixture();
    const path = 'retry-note.md';
    const content = serializeKnowledgePageFixture(
      {
        title: 'Retry note',
        content: 'Retained exact content.',
        createdAt: '2026-10-16T00:00:00.000Z',
        updatedAt: '2026-10-16T00:01:00.000Z',
      },
      { kind: 'workspace', workspaceId }
    );
    const input = {
      workspaceId,
      requestId: randomUUID(),
      baseRevision: f.initial,
      changes: [{ path, content }],
      summary: 'Create retry note',
    };
    const dependencies = {
      ...f,
      command: { name: 'knowledge.notebook.create' as const, input },
    };
    f.workspaceDb.sqlite.exec(
      "CREATE TRIGGER reject_head BEFORE UPDATE ON knowledge_notebook_heads BEGIN SELECT RAISE(ABORT, 'test head fault'); END"
    );
    await expect(publishWorkspaceNotebook(dependencies, input)).rejects.toThrow();
    expect(currentFixtureRevision(f)).toBe(f.initial);
    expect(
      f.workspaceDb.sqlite.prepare('SELECT count(*) AS count FROM audit_events').get()
    ).toEqual({ count: f.retainedCounts.audit });
    expect(
      f.workspaceDb.sqlite.prepare('SELECT count(*) AS count FROM idempotency_requests').get()
    ).toEqual({ count: f.retainedCounts.receipts });
    f.workspaceDb.sqlite.exec('DROP TRIGGER reject_head');
    const result = await publishWorkspaceNotebook(dependencies, input);
    expect(currentFixtureRevision(f)).toBe(result.notebookRevision);
    const originalBytes = f.notebook.readRevision(result.notebookRevision, [path]).files[path];
    expect(originalBytes).toBe(content);
    expect(parseOkfDocument({ path, content: originalBytes! }).document?.frontmatter).toMatchObject(
      {
        created_at: '2026-10-16T00:00:00.000Z',
        updated_at: '2026-10-16T00:01:00.000Z',
      }
    );
  });

  it('rolls back head, Audit and receipt when native head publication fails, then admits a retry', async () => {
    const f = await fixture();
    f.workspaceDb.sqlite.exec(
      "CREATE TRIGGER reject_head BEFORE UPDATE ON knowledge_notebook_heads BEGIN SELECT RAISE(ABORT, 'test head fault'); END"
    );
    await expect(f.publish()).rejects.toThrow();
    expect(currentFixtureRevision(f)).toBe(f.initial);
    expect(
      f.workspaceDb.sqlite.prepare('SELECT count(*) AS count FROM audit_events').get()
    ).toEqual({ count: f.retainedCounts.audit });
    expect(
      f.workspaceDb.sqlite.prepare('SELECT count(*) AS count FROM idempotency_requests').get()
    ).toEqual({ count: f.retainedCounts.receipts });
    f.workspaceDb.sqlite.exec('DROP TRIGGER reject_head');
    const result = await f.publish();
    expect(currentFixtureRevision(f)).toBe(result.notebookRevision);
  });

  it('marks an explicit human edit user-authored instead of accepting a supplied human-review label', async () => {
    const f = await fixture();
    const content = `---
type: KnowledgePage
title: Human note
schema_version: openkit-scope-knowledge-schema-v4
requiredFeatures: [openkit.knowledge-owner-scope.v1, openkit.knowledge-git-notebook.v1]
openkit_status: active
status: stable
scope: {kind: workspace, workspaceId: ${workspaceId}}
source_refs: []
review_state: accepted
sensitivity: normal
freshness: current
created_at: "2026-10-16T00:00:00.000Z"
updated_at: "2026-10-16T00:00:00.000Z"
custom: {keep: [one, two]}
---
Exact human body.\r\n\t  `;
    const request = { ...f.request, changes: [{ path: 'entry.md', content }] };
    const published = await f.publish(request);
    const exact = f.notebook.readRevision(published.notebookRevision).files['entry.md']!;
    expect(exact).toContain('review_state: user-authored');
    expect(
      parseOkfDocument({ path: 'entry.md', content: exact }).document?.frontmatter.custom
    ).toEqual({ keep: ['one', 'two'] });
    expect(exact.split('\n---\n')[1]).toBe(content.split('\n---\n')[1]);
    expect(await f.publish(request)).toEqual(published);
  });

  it('publishes Agent bytes under responsible human authority without claiming human authorship and preserves a later human winner', async () => {
    const f = await fixture();
    const content = `---
type: KnowledgePage
title: Agent note
schema_version: openkit-scope-knowledge-schema-v4
requiredFeatures: [openkit.knowledge-owner-scope.v1, openkit.knowledge-git-notebook.v1]
openkit_status: active
status: stable
scope: {kind: workspace, workspaceId: ${workspaceId}}
source_refs: []
review_state: user-authored
sensitivity: normal
freshness: current
created_at: "2026-10-16T00:00:00.000Z"
updated_at: "2026-10-16T00:00:00.000Z"
custom: {keep: [one, two]}
---
Exact Agent body.\r\n\t  `;
    const agent = {
      kind: 'agent',
      id: 'knowledge-manager',
      responsibleUserId: producer.id,
    } as const;
    const authority = {
      kind: 'delegated',
      settingReference: '{"enabled":true,"reviewRequiredPageIds":[]}',
      settingDigest: commandInputHash({ enabled: true, reviewRequiredPageIds: [] }),
    } as const;
    const dependencies = {
      ...f,
      producer: agent,
      actor: producer,
      publicationAuthority: authority,
    };
    const request = { ...f.request, changes: [{ path: 'entry.md', content }] };
    const result = await publishWorkspaceNotebook(dependencies, request);
    const revision = f.notebook.readRevision(result.notebookRevision);
    expect(revision.metadata.producer).toEqual(agent);
    expect(revision.metadata.authority).toEqual(authority);
    expect(revision.files['entry.md']).toContain('review_state: delegated');
    expect(revision.files['entry.md']!.split('\n---\n')[1]).toBe(content.split('\n---\n')[1]);
    expect(
      parseOkfDocument({ path: 'entry.md', content: revision.files['entry.md']! }).document
        ?.frontmatter.custom
    ).toEqual({ keep: ['one', 'two'] });
    expect(await publishWorkspaceNotebook(dependencies, request)).toEqual(result);
    const winner = await f.publish({
      ...f.request,
      requestId: randomUUID(),
      baseRevision: result.notebookRevision,
      summary: 'Human winner',
    });
    await expect(
      publishWorkspaceNotebook(
        { ...dependencies, notebook: f.notebook },
        { ...request, requestId: randomUUID() }
      )
    ).rejects.toMatchObject({ code: 'conflict', currentRevision: winner.notebookRevision });
    expect(currentFixtureRevision(f)).toBe(winner.notebookRevision);
  });

  it('retains an exact multi-page pending Proposal through restart and records Review against its full candidate', async () => {
    const f = await createOwners();
    let store = f.store;
    const baseRevision = currentNotebookRevision(f);
    const agent = {
      kind: 'agent',
      id: 'knowledge-manager',
      responsibleUserId: producer.id,
    } as const;
    const page = `---
type: KnowledgePage
title: Topic
schema_version: openkit-scope-knowledge-schema-v4
requiredFeatures: [openkit.knowledge-owner-scope.v1, openkit.knowledge-git-notebook.v1]
openkit_status: active
status: stable
scope: {kind: workspace, workspaceId: ${f.workspaceId}}
source_refs: []
review_state: delegated
sensitivity: normal
freshness: current
created_at: "2026-10-16T00:00:00.000Z"
updated_at: "2026-10-16T00:00:00.000Z"
custom: {keep: [one, two]}
---
Exact retained candidate.\r\n`;
    const changes = [
      {
        path: 'index.md',
        content: '---\nokf_version: "0.2"\n---\n# Notebook\n[Topic](topic.md)\n',
      },
      { path: 'topic.md', content: page },
    ];
    const proposal = await store.createKnowledgeProposal({
      workspaceId: f.workspaceId,
      requestId: randomUUID(),
      baseRevision,
      changes,
      summary: 'Organize pages',
      sourceReferences: [],
      verifiedExternalReferences: [],
      producer: agent,
      createdAt: '2026-10-17T00:00:00.000Z',
    });
    expect(proposal.changes).toEqual(changes);
    expect(proposal.knowledgePageId).toBeUndefined();
    expect(f.notebook.publishedRevision()).toBe(baseRevision);
    expect(f.notebook.retainedCandidate(proposal.id).revision).toBe(proposal.candidateRevision);
    store = new FsStore({ dataRoot: f.dataRoot });
    expect(store.projectKnowledgeProposalDraft(f.workspaceId, proposal.id)).toEqual(proposal);
    const app = createAppWithLocalIdentity({ coreDb: f.coreDb, dataRoot: f.dataRoot, store });
    const reviewed = await call(
      { ...f, store, app },
      'knowledge.proposal.decide',
      decisionInput({ ...f, store, app }, proposal, 'accepted', 'notebook-multi-review')
    );
    expect(reviewed.review.changedPageIds).toEqual(['index', 'topic']);
    expect(reviewed.application).toMatchObject({
      changedPageIds: ['index', 'topic'],
      notebookRevision: proposal.candidateRevision,
    });
    expect(f.notebook.readRevision(proposal.candidateRevision).files['topic.md']).toBe(page);
    expect(f.notebook.publishedRevision()).toBe(proposal.candidateRevision);
  });

  it('publishes once, retains exact facts, and replays the old commit after a later publication', async () => {
    const f = await fixture();
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
    expect(currentFixtureRevision(f)).toBe(next.notebookRevision);
    expect(
      f.workspaceDb.sqlite
        .prepare(
          'SELECT response_kind AS kind, response_id AS id, response_json AS extra FROM idempotency_requests WHERE request_id = ?'
        )
        .get(f.request.requestId)
    ).toEqual({ kind: 'knowledge_notebook_revision', id: first.notebookRevision, extra: null });
  });

  it('rejects changed input and a stale base without changing the winner', async () => {
    const f = await fixture();
    const first = await f.publish();
    await expect(f.publish({ ...f.request, summary: 'Changed input' })).rejects.toMatchObject({
      code: 'idempotency_key_conflict',
    });
    await expect(f.publish({ ...f.request, requestId: randomUUID() })).rejects.toMatchObject({
      code: 'conflict',
      currentRevision: first.notebookRevision,
    });
    expect(currentFixtureRevision(f)).toBe(first.notebookRevision);
  });

  it('refuses publication if admission Audit fails, then admits the unchanged request after fault removal', async () => {
    const f = await fixture();
    f.workspaceDb.sqlite.exec(
      "CREATE TRIGGER reject_admission BEFORE INSERT ON audit_events WHEN NEW.action = 'knowledge.notebook.admit' BEGIN SELECT RAISE(ABORT, 'test fault'); END"
    );
    await expect(f.publish()).rejects.toThrow();
    expect(currentFixtureRevision(f)).toBe(f.initial);
    f.workspaceDb.sqlite.exec('DROP TRIGGER reject_admission');
    expect((await f.publish()).outcome).toBe('published');
  });

  it.each([
    'receipt',
    'completion',
  ] as const)('refuses a previously published request with missing %s evidence', async (missing) => {
    const f = await fixture();
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
    expect(currentFixtureRevision(f)).toBe(first.notebookRevision);
  });

  it.each([
    'receipt',
    'completion',
  ] as const)('rolls back the native tuple after an actual %s write fault', async (fault) => {
    const f = await fixture();
    f.workspaceDb.sqlite.exec(
      fault === 'receipt'
        ? "CREATE TRIGGER reject_completion BEFORE INSERT ON idempotency_requests BEGIN SELECT RAISE(ABORT, 'test receipt fault'); END"
        : "CREATE TRIGGER reject_completion BEFORE INSERT ON audit_events WHEN NEW.action = 'knowledge.notebook.update' BEGIN SELECT RAISE(ABORT, 'test completion fault'); END"
    );
    await expect(f.publish()).rejects.toThrow();
    expect(currentFixtureRevision(f)).toBe(f.initial);
    expect(
      f.workspaceDb.sqlite.prepare('SELECT count(*) AS count FROM audit_events').get()
    ).toEqual({ count: f.retainedCounts.audit });
    expect(
      f.workspaceDb.sqlite.prepare('SELECT count(*) AS count FROM idempotency_requests').get()
    ).toEqual({ count: f.retainedCounts.receipts });
    f.workspaceDb.sqlite.exec('DROP TRIGGER reject_completion');
    const result = await f.publish();
    expect(currentFixtureRevision(f)).toBe(result.notebookRevision);
  });

  it('rechecks current admission before candidate reads and immediately before publication', async () => {
    const f = await fixture();
    const facts = f.revalidate();
    f.revalidate.mockClear();
    f.revalidate
      .mockImplementationOnce(() => facts)
      .mockImplementationOnce(() => facts)
      .mockImplementationOnce(() => {
        throw new Error('Current authority revoked.');
      });
    await expect(f.publish()).rejects.toThrow('Current authority revoked.');
    expect(currentFixtureRevision(f)).toBe(f.initial);
    expect(
      f.workspaceDb.sqlite.prepare('SELECT count(*) AS count FROM audit_events').get()
    ).toEqual({ count: f.retainedCounts.audit });
  });

  it.each([
    'authority',
    'sourceReferences',
    'baseRevision',
  ] as const)('rejects Audit %s facts that contradict the exact published commit', async (field) => {
    const f = await fixture();
    const first = await f.publish();
    const rows = f.workspaceDb.sqlite
      .prepare(
        'SELECT audit_event_id AS id, notebook_admission_json AS admission FROM audit_events WHERE request_id = ?'
      )
      .all(f.request.requestId) as { id: string; admission: string }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const value = JSON.parse(row.admission);
      if (field === 'authority') value.authority.instructionReference = 'invented instruction';
      if (field === 'sourceReferences') value.sourceReferences = ['source:invented'];
      if (field === 'baseRevision') value.baseRevision = '0'.repeat(40);
      f.workspaceDb.sqlite
        .prepare('UPDATE audit_events SET notebook_admission_json = ? WHERE audit_event_id = ?')
        .run(JSON.stringify(value), row.id);
    }
    await expect(f.publish()).rejects.toMatchObject({ code: 'recovery_required' });
    expect(currentFixtureRevision(f)).toBe(first.notebookRevision);
  });
});

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
import { publishWorkspaceNotebookEntry } from './notebook-entry-publication.js';
import { publishWorkspaceNotebook } from './notebook-publication.js';
import { DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT, parseOkfDocument } from './okf.js';

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
    reviewRequiredPageIds: [] as string[],
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
  it('replays completed bytes after a page becomes protected and refuses a fresh unreviewed change', async () => {
    const f = fixture();
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
    expect(f.notebook.publishedRevision()).toBe(published.notebookRevision);
  });

  it('rechecks protected-page requirements immediately before ref publication', async () => {
    const f = fixture();
    const facts = f.revalidate();
    f.revalidate.mockClear();
    f.revalidate.mockImplementation(() => ({
      ...facts,
      reviewRequiredPageIds: f.revalidate.mock.calls.length >= 3 ? ['index'] : [],
    }));
    await expect(f.publish()).rejects.toMatchObject({ code: 'review_required' });
    expect(f.notebook.publishedRevision()).toBe(f.initial);
    expect(
      f.workspaceDb.sqlite.prepare('SELECT COUNT(*) AS count FROM audit_events').get()
    ).toEqual({ count: 0 });
  });

  it('reconstructs an entry command response from its exact old commit after another edit and a new Store', async () => {
    const f = fixture();
    const input = {
      operation: 'knowledge.create' as const,
      workspaceId,
      requestId: randomUUID(),
      baseRevision: f.initial,
      knowledgePageId: 'notes/human-entry',
      kind: 'project-context' as const,
      title: 'Original title',
      content: 'Original bytes.',
    };
    const created = await publishWorkspaceNotebookEntry(f, input);
    const createdRevision = f.notebook.publishedRevision();
    expect(created).toMatchObject({
      id: input.knowledgePageId,
      title: input.title,
      content: input.content,
    });
    const updated = await publishWorkspaceNotebookEntry(f, {
      operation: 'knowledge.update',
      workspaceId,
      requestId: randomUUID(),
      baseRevision: createdRevision,
      knowledgeEntryId: created.id,
      content: 'Later bytes.',
    });
    expect(updated.content).toBe('Later bytes.');
    const current = f.notebook.publishedRevision();
    expect(await publishWorkspaceNotebookEntry({ ...f, store: new FsStore() }, input)).toEqual(
      created
    );
    expect(f.notebook.publishedRevision()).toBe(current);
    expect(
      f.workspaceDb.sqlite
        .prepare(
          'SELECT command_name AS command, response_kind AS kind FROM idempotency_requests ORDER BY command_name'
        )
        .all()
    ).toEqual([
      { command: 'knowledge.create', kind: 'knowledge_notebook_revision' },
      { command: 'knowledge.update', kind: 'knowledge_notebook_revision' },
    ]);
  });

  it('retains the first candidate timestamps when an explicit unchanged entry request retries a ref failure', async () => {
    const f = fixture();
    const input = {
      operation: 'knowledge.create' as const,
      workspaceId,
      requestId: randomUUID(),
      baseRevision: f.initial,
      knowledgePageId: 'retry-note',
      kind: 'preference' as const,
      title: 'Retry note',
      content: 'Retained exact content.',
    };
    const lock = join(f.repositoryPath, 'refs/heads/published.lock');
    writeFileSync(lock, 'Test-owned ref lock.');
    await expect(publishWorkspaceNotebookEntry(f, input)).rejects.toMatchObject({
      code: 'recovery_required',
    });
    const row = f.workspaceDb.sqlite
      .prepare(
        "SELECT notebook_admission_json AS admission FROM audit_events WHERE action = 'knowledge.notebook.admit'"
      )
      .get() as { admission: string };
    const admitted = JSON.parse(row.admission);
    const originalBytes = f.notebook.readRevision(admitted.candidateRevision, ['retry-note.md'])
      .files['retry-note.md'];
    rmSync(lock);
    const result = await publishWorkspaceNotebookEntry(f, input);
    expect(result.content).toBe(input.content);
    expect(
      f.notebook.readRevision(f.notebook.publishedRevision(), ['retry-note.md']).files[
        'retry-note.md'
      ]
    ).toBe(originalBytes);
  });

  it('refuses a contradictory unpublished admission before an explicit retry can publish another candidate', async () => {
    const f = fixture();
    const lock = join(f.repositoryPath, 'refs/heads/published.lock');
    writeFileSync(lock, 'Test-owned ref lock.');
    await expect(f.publish()).rejects.toMatchObject({ code: 'recovery_required' });
    rmSync(lock);
    const row = f.workspaceDb.sqlite
      .prepare(
        "SELECT audit_event_id AS id, notebook_admission_json AS admission FROM audit_events WHERE action = 'knowledge.notebook.admit'"
      )
      .get() as { id: string; admission: string };
    const admitted = JSON.parse(row.admission);
    admitted.sourceReferences = ['source:unproved'];
    f.workspaceDb.sqlite
      .prepare('UPDATE audit_events SET notebook_admission_json = ? WHERE audit_event_id = ?')
      .run(JSON.stringify(admitted), row.id);
    await expect(f.publish()).rejects.toMatchObject({ code: 'recovery_required' });
    expect(f.notebook.publishedRevision()).toBe(f.initial);
    expect(
      f.workspaceDb.sqlite.prepare('SELECT COUNT(*) AS count FROM idempotency_requests').get()
    ).toEqual({ count: 0 });
  });

  it('marks an explicit human edit user-authored instead of accepting a supplied human-review label', async () => {
    const f = fixture();
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
    const f = fixture();
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
      publishWorkspaceNotebook(dependencies, { ...request, requestId: randomUUID() })
    ).rejects.toMatchObject({ code: 'conflict', currentRevision: winner.notebookRevision });
    expect(f.notebook.publishedRevision()).toBe(winner.notebookRevision);
  });

  it('retains an exact multi-page pending Proposal through restart and records Review against its full candidate', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'notebook-multi-proposal-'));
    onTestFinished(() => rmSync(dataRoot, { recursive: true, force: true }));
    let store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Exact candidate', {
      requestId: randomUUID(),
      producer,
      instructionReference: 'fixture-create',
    });
    const notebook = new KnowledgeNotebook({
      repositoryPath: join(dataRoot, 'workspaces', workspace.id, 'knowledge', 'notebook.git'),
    });
    const baseRevision = notebook.publishedRevision();
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
scope: {kind: workspace, workspaceId: ${workspace.id}}
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
    const proposal = store.createKnowledgeProposal({
      workspaceId: workspace.id,
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
    expect(notebook.publishedRevision()).toBe(baseRevision);
    expect(notebook.retainedCandidate(proposal.id).revision).toBe(proposal.candidateRevision);
    store = new FsStore({ dataRoot });
    expect(store.projectKnowledgeProposalDraft(workspace.id, proposal.id)).toEqual(proposal);
    const reviewed = store.recordKnowledgeProposalReviewDecision({
      workspaceId: workspace.id,
      proposalId: proposal.id,
      requestId: randomUUID(),
      decision: 'accepted',
      baseRevision,
      candidateRevision: proposal.candidateRevision,
      proposalDigest: store.knowledgeProposalDigest(workspace.id, proposal.id),
      actor: producer,
      decidedAt: '2026-10-17T00:01:00.000Z',
      verifiedExternalReferences: [],
    });
    expect(reviewed.review.changedPageIds).toEqual(['index', 'topic']);
    expect(reviewed.application).toMatchObject({
      changedPageIds: ['index', 'topic'],
      notebookRevision: proposal.candidateRevision,
    });
    expect(notebook.readRevision(proposal.candidateRevision).files['topic.md']).toBe(page);
    expect(notebook.publishedRevision()).toBe(baseRevision);
  });

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
        reviewRequiredPageIds: [] as string[],
        registeredSources: new Map(),
        resolvedReferences: new Map(),
      }))
      .mockImplementationOnce(() => ({
        scopeSchemaText: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
        reviewRequiredPageIds: [] as string[],
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

  it.each([
    'authority',
    'sourceReferences',
    'baseRevision',
  ] as const)('rejects Audit %s facts that contradict the exact published commit', async (field) => {
    const f = fixture();
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
    expect(f.notebook.publishedRevision()).toBe(first.notebookRevision);
  });
});

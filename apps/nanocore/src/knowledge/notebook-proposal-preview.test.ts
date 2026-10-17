import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { FsStore } from '../lib/store.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { serializeUserAuthoredKnowledgePage } from '../storage/workspace-file-records.js';
import { createApp } from '../test-support/app.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { KnowledgeNotebook } from './notebook.js';

it('previews every exact multi-page candidate byte with bounded paging and refuses changed authority or candidate tuples', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'proposal-preview-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Exact Proposal preview');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const app = createApp({ coreDb, dataRoot, store });
  onTestFinished(() => {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const call = async (operation: string, input: Record<string, unknown>) => {
    const { requestId, ...body } = input;
    const response = await app.request(`/api/app/operations/${operation}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(requestId ? { 'x-openkit-request-id': String(requestId) } : {}),
      },
      body: JSON.stringify({ workspaceId: workspace.id, ...body }),
    });
    const text = await response.text();
    return { status: response.status, body: text.startsWith('{') ? JSON.parse(text) : text };
  };
  const origin = store.createThread(workspace.id, 'Shared Source audience');
  const registered = await call('knowledge.source.register', {
    requestId: randomUUID(),
    kind: 'document',
    title: 'Literal fact',
    content: 'Literal shared evidence.',
    originatingThreadId: origin.id,
  });
  expect(registered.status).toBe(200);
  const sourceReference = `source:${registered.body.source.id}@${registered.body.source.contentDigest}`;
  const page = (id: string, body: string) =>
    serializeUserAuthoredKnowledgePage(
      {
        id,
        title: id,
        kind: 'project-context',
        content: body,
        sourceReferences: [sourceReference],
        createdAt: '2026-10-17T00:00:00.000Z',
        updatedAt: '2026-10-17T00:00:00.000Z',
      },
      { kind: 'workspace', workspaceId: workspace.id }
    );
  const repositoryPath = join(dataRoot, 'workspaces', workspace.id, 'knowledge', 'notebook.git');
  const notebook = new KnowledgeNotebook({ repositoryPath });
  const published = await call('knowledge.notebook.update', {
    requestId: randomUUID(),
    baseRevision: notebook.publishedRevision(),
    summary: 'Initial pages',
    changes: [
      { path: 'edit.md', content: page('edit', '😀Original body.'.repeat(220)) },
      { path: 'remove.md', content: page('remove', 'Removed exact body.') },
    ],
  });
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  const baseRevision = notebook.publishedRevision();
  const proposal = store.createKnowledgeProposal({
    workspaceId: workspace.id,
    requestId: randomUUID(),
    baseRevision,
    changes: [
      { path: 'add.md', content: page('add', 'Added exact body.') },
      { path: 'edit.md', content: page('edit', 'x😀Changed body.'.repeat(350)) },
      { path: 'remove.md', content: null },
    ],
    summary: 'Edit, add and remove',
    sourceReferences: [sourceReference],
    verifiedExternalReferences: [],
    producer: { kind: 'agent', id: 'knowledge-manager', responsibleUserId: userId },
    createdAt: '2026-10-17T00:00:00.000Z',
  });
  const request = { proposalId: proposal.id };
  const inventory = await call('knowledge.proposal.read', request);
  expect(inventory.status, JSON.stringify(inventory.body)).toBe(200);
  const tuple = {
    proposalId: proposal.id,
    proposalDigest: store.knowledgeProposalDigest(workspace.id, proposal.id),
    baseRevision,
    candidateRevision: proposal.candidateRevision,
    paths: ['add.md', 'edit.md', 'remove.md'],
  };
  expect(inventory.body).toEqual(tuple);
  const before = notebook.readRevision(baseRevision).files;
  const after = notebook.readRevision(proposal.candidateRevision).files;
  for (const path of tuple.paths) {
    let offset = 0;
    let oldText: string | null = before[path] === undefined ? null : '';
    let newText: string | null = after[path] === undefined ? null : '';
    let complete = false;
    do {
      const response = await call('knowledge.proposal.read', { ...request, path, offset });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).toMatchObject({ ...tuple, path });
      expect(Buffer.byteLength(JSON.stringify(response.body))).toBeLessThan(64 * 1024);
      for (const text of [response.body.before, response.body.after])
        if (text !== null) {
          expect(text.length).toBeLessThanOrEqual(4096);
          expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(text)).toBe(false);
        }
      if (oldText !== null) oldText += response.body.before;
      if (newText !== null) newText += response.body.after;
      complete = response.body.nextOffset === null;
      if (!complete) {
        expect(response.body.nextOffset).toBeGreaterThan(offset);
        offset = response.body.nextOffset;
      }
    } while (!complete);
    expect(oldText).toBe(before[path] ?? null);
    expect(newText).toBe(after[path] ?? null);
  }
  const invalidOffset =
    Math.max(Array.from(before['edit.md']!).length, Array.from(after['edit.md']!).length) + 1;
  expect(
    (await call('knowledge.proposal.read', { ...request, path: 'edit.md', offset: invalidOffset }))
      .status
  ).toBe(400);
  expect((await call('knowledge.proposal.read', { ...request, path: 'unknown.md' })).status).toBe(
    400
  );
  // Existing reader regressions use test-owned current audience facts; this creates no transition API.
  Object.assign(origin, { visibility: 'private', privateOwnerUserId: userId });
  for (const input of [request, { ...request, path: 'add.md', offset: 4096 }]) {
    const denied = await call('knowledge.proposal.read', input);
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(JSON.stringify(denied.body)).not.toContain('Added exact body');
    expect(JSON.stringify(denied.body)).not.toContain(proposal.candidateRevision);
  }
  Object.assign(origin, { visibility: 'workspace', privateOwnerUserId: undefined });
  const later = await call('knowledge.notebook.update', {
    requestId: randomUUID(),
    baseRevision,
    summary: 'Later independent publication',
    changes: [{ path: 'later.md', content: page('later', 'Later exact body.') }],
  });
  expect(later.status, JSON.stringify(later.body)).toBe(200);
  expect((await call('knowledge.proposal.read', request)).status).toBe(409);
  execFileSync('git', [
    '--git-dir',
    repositoryPath,
    'update-ref',
    `refs/proposals/${proposal.id}`,
    baseRevision,
  ]);
  const changed = await call('knowledge.proposal.read', request);
  expect(changed.status).toBe(503);
  expect(JSON.stringify(changed.body)).not.toContain(proposal.candidateRevision);
  expect(notebook.publishedRevision()).toBe(later.body.notebookRevision);
  expect(store.getKnowledgeProposalReviewDecision(proposal.id)).toBeNull();
});

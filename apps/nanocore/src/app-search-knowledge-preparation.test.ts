import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppSearchResponseSchema } from '@openkit/app-api-schemas';
import { formatReferenceUri } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readDefaultKnowledgeBaseId } from './config/knowledge-base.js';
import { KnowledgeNotebook } from './knowledge/notebook.js';
import { updateOkfFrontmatter } from './knowledge/okf.js';
import { closeRetrievalServices } from './retrieval-service.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import * as retrieval from './storage/index-rebuild.js';
import { createAppWithWorkspaceAuthority as createApp } from './test-support/app.js';
import { serializeKnowledgePageFixture } from './test-support/knowledge-page.js';
import { operationRequest } from './test-support/operation-request.js';
import { createTestStore } from './test-support/store.js';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await closeRetrievalServices();
  await shutdownControlStoreWorkerClient();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Publishes two lexical hits and their shared source through current human Notebook admission. */
async function searchFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'app-search-knowledge-preparation-'));
  roots.push(dataRoot);
  const store = createTestStore({ dataRoot });
  const workspace = await store.createWorkspace('Knowledge preparation');
  const app = createApp({ dataRoot, store });
  const knowledgeBaseId = readDefaultKnowledgeBaseId({
    dataRoot,
    scope: { kind: 'workspace', workspaceId: workspace.id },
  });
  const sourceReference = formatReferenceUri({
    scopeId: `page/workspace/${workspace.id}/${knowledgeBaseId}`,
    objectId: 'support',
  });
  const pages = [
    { id: 'support', title: 'Supporting evidence', content: 'A current supporting fact.' },
    {
      id: 'selected-alpha',
      title: 'Alpha evidence title',
      content: 'apppreparationmarker exact selected bytes.',
    },
    {
      id: 'selected-zeta',
      title: 'Zeta evidence title',
      content: 'apppreparationmarker exact selected bytes.',
    },
  ].map((page) => ({
    ...page,
    bytes: serializeKnowledgePageFixture(
      {
        ...page,
        sourceReferences: page.id === 'support' ? [] : [sourceReference],
        createdAt: '2026-10-19T00:00:00.000Z',
        updatedAt: '2026-10-19T00:00:00.000Z',
      },
      { kind: 'workspace', workspaceId: workspace.id }
    ),
  }));
  const listed = await app.request(
    ...operationRequest('knowledge.notebook.list', { workspaceId: workspace.id })
  );
  expect(listed.status, await listed.clone().text()).toBe(200);
  let baseRevision: string = (await listed.json()).notebookRevision;
  for (const page of pages) {
    const created = await app.request(
      ...operationRequest(
        'knowledge.notebook.create',
        {
          workspaceId: workspace.id,
          path: `${page.id}.md`,
          content: page.bytes,
          baseRevision,
          summary: 'Publish App search preparation evidence',
        },
        { body: JSON.stringify({ requestId: randomUUID() }) }
      )
    );
    expect(created.status, await created.clone().text()).toBe(200);
    const publication = await created.json();
    expect(publication).toMatchObject({ outcome: 'published', changedPageIds: [page.id] });
    baseRevision = publication.notebookRevision;
  }
  return { app, workspaceId: workspace.id, baseRevision, supportContent: pages[0]!.bytes };
}

describe('App search Knowledge preparation', () => {
  it('returns exact selected identities and titles without synchronous immutable Notebook body reads', async () => {
    const f = await searchFixture();
    // Task 3 caller routing: observe owned body I/O, not latency or private helper order.
    const bodyReads = vi.spyOn(KnowledgeNotebook.prototype, 'readRevision');
    const response = await f.app.request(
      ...operationRequest('app.search', { query: 'apppreparationmarker' })
    );
    expect(response.status, await response.clone().text()).toBe(200);
    // S61 Retrieval pipeline: App projects the governed selection, not a second selector.
    expect(AppSearchResponseSchema.parse(await response.json()).items).toEqual([
      {
        kind: 'knowledge',
        id: 'selected-alpha',
        title: 'Alpha evidence title',
        workspaceId: f.workspaceId,
      },
      {
        kind: 'knowledge',
        id: 'selected-zeta',
        title: 'Zeta evidence title',
        workspaceId: f.workspaceId,
      },
    ]);
    expect(bodyReads).not.toHaveBeenCalled();
  });

  it('refuses a selected page when its current source is restricted during post-selection body preparation', async () => {
    const f = await searchFixture();
    const retrieve = retrieval.retrieveWorkspaceKnowledge;
    const read = KnowledgeNotebook.prototype.readRevisionWithSourcesAsync;
    let restrictionApplied = false;
    // Both observers call the real owners and return their unchanged results. The fault
    // changes a real published source only after selection, while the next body read awaits.
    vi.spyOn(retrieval, 'retrieveWorkspaceKnowledge').mockImplementationOnce(async (input) => {
      const selection = await retrieve(input);
      expect(selection.selected.map(({ reference }) => reference.objectId)).toEqual([
        'selected-alpha',
        'selected-zeta',
      ]);
      vi.spyOn(KnowledgeNotebook.prototype, 'readRevisionWithSourcesAsync').mockImplementationOnce(
        async function (this: KnowledgeNotebook, revision, input) {
          const content = await read.call(this, revision, input);
          const restricted = await f.app.request(
            ...operationRequest(
              'knowledge.notebook.update',
              {
                workspaceId: f.workspaceId,
                baseRevision: f.baseRevision,
                changes: [
                  {
                    path: 'support.md',
                    content: updateOkfFrontmatter({
                      path: 'support.md',
                      content: f.supportContent,
                      updates: { sensitivity: 'confidential' },
                    }),
                  },
                ],
                summary: 'Restrict the current source during App preparation',
              },
              { body: JSON.stringify({ requestId: randomUUID() }) }
            )
          );
          expect(restricted.status, await restricted.clone().text()).toBe(200);
          const publication = await restricted.json();
          expect(publication).toMatchObject({ outcome: 'published' });
          expect(publication.notebookRevision).not.toBe(f.baseRevision);
          restrictionApplied = true;
          return content;
        }
      );
      return selection;
    });
    const response = await f.app.request(
      ...operationRequest('app.search', { query: 'apppreparationmarker' })
    );
    expect(
      restrictionApplied,
      'Search must reach post-selection asynchronous body preparation.'
    ).toBe(true);
    // Core Policy and S61: retained selection and immutable bytes are not a current read grant.
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'workspace_access_denied' });
  });
});

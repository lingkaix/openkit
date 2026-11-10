import childProcess from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { formatReferenceUri } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import { serializeKnowledgePageFixture } from '../test-support/knowledge-page.js';
import {
  call,
  createOwners,
  currentNotebookRevision,
  PRODUCER,
  workspacePageScope,
} from '../test-support/knowledge-proposal-authority.js';
import { KnowledgeNotebook } from './notebook.js';

/** Real published content and native Proposal authority; seed work precedes observation. */
async function fixture() {
  const f = await createOwners();
  const pages = Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [
      `page-${index}.md`,
      serializeKnowledgePageFixture(
        {
          title: `Page ${index}`,
          content: `Original exact Page ${index}.`,
          createdAt: '2026-10-20T00:00:00.000Z',
          updatedAt: '2026-10-20T00:00:00.000Z',
        },
        { kind: 'workspace', workspaceId: f.workspaceId }
      ),
    ])
  );
  await call(f, 'knowledge.notebook.update', {
    workspaceId: f.workspaceId,
    requestId: randomUUID(),
    baseRevision: currentNotebookRevision(f),
    summary: 'Initial native Pages',
    changes: Object.entries(pages).map(([path, content]) => ({ path, content })),
  });
  const baseRevision = currentNotebookRevision(f);
  const input = {
    workspaceId: f.workspaceId,
    requestId: randomUUID(),
    baseRevision,
    summary: 'One exact Proposal edit',
    changes: [
      {
        path: 'page-0.md',
        content: pages['page-0.md']!.replace('Original exact', 'Proposed exact'),
      },
    ],
    sourceReferences: [],
    verifiedExternalReferences: [],
    producer: PRODUCER,
    createdAt: '2026-10-20T01:00:00.000Z',
  };
  return { ...f, pages, input, baseRevision };
}

it.each(['notebook-change', 'single-page'] as const)(
  'creates the exact native %s Proposal without synchronous Git and leaves publication unchanged',
  async (form) => {
    const f = await fixture();
    const sourceBytes = f.notebook.readRevision(f.baseRevision, ['page-1.md']).files['page-1.md']!;
    const sourceReference = formatReferenceUri(
      { scopeId: workspacePageScope(f), objectId: 'page-1' },
      `sha256:${createHash('sha256').update(sourceBytes).digest('hex')}`
    );
    const synchronous = vi.spyOn(childProcess, 'execFileSync');
    syncBuiltinESMExports();
    onTestFinished(() => {
      synchronous.mockRestore();
      syncBuiltinESMExports();
    });
    const canonicalPageBytes = f.input.changes[0]!.content.replace(
      'review_state: "user-authored"',
      'review_state: "accepted"'
    ).replace('source_refs: []', `source_refs: ${JSON.stringify([sourceReference])}`);
    const proposal = await f.store.createKnowledgeProposal(
      form === 'notebook-change'
        ? f.input
        : {
            workspaceId: f.workspaceId,
            requestId: f.input.requestId,
            baseRevision: f.baseRevision,
            knowledgePageId: 'page-0',
            canonicalPageBytes,
            contentDigest: `sha256:${createHash('sha256').update(canonicalPageBytes).digest('hex')}`,
            sourceReferences: [sourceReference],
            verifiedExternalReferences: [],
            rationale: f.input.summary,
            confidence: 0.9,
            producer: PRODUCER,
            createdAt: f.input.createdAt,
          }
    );
    expect(synchronous).not.toHaveBeenCalled();
    synchronous.mockRestore();
    syncBuiltinESMExports();
    expect(currentNotebookRevision(f)).toBe(f.baseRevision);
    expect(f.notebook.retainedCandidate(proposal.id).revision).toBe(proposal.candidateRevision);
    expect(f.store.projectKnowledgeProposalDraft(f.workspaceId, proposal.id)).toEqual(proposal);
    const candidate = f.notebook.readRevision(proposal.candidateRevision);
    expect(candidate.parentRevision).toBe(f.baseRevision);
    expect(candidate.files['page-0.md']).toContain('Proposed exact Page 0.');
    if (form === 'single-page') expect(candidate.files['page-0.md']).toBe(canonicalPageBytes);
    for (const [path, content] of Object.entries(f.pages))
      if (path !== 'page-0.md') expect(candidate.files[path]).toBe(content);
  }
);

it.each([1, 2])(
  'refuses after %s real head advances with at most one fresh immutable preparation',
  async (advances) => {
    const f = await fixture();
    const original = KnowledgeNotebook.prototype.withPreparedReadsAsync;
    let preparations = 0;
    let publishing = false;
    let winner = f.baseRevision;
    const prepare = vi
      .spyOn(KnowledgeNotebook.prototype, 'withPreparedReadsAsync')
      .mockImplementation(async function (this: KnowledgeNotebook, ...args) {
        const prepared = await original.apply(this, args);
        if (!publishing) {
          preparations++;
          if (preparations <= advances) {
            publishing = true;
            try {
              await call(f, 'knowledge.notebook.update', {
                workspaceId: f.workspaceId,
                requestId: randomUUID(),
                baseRevision: winner,
                summary: 'A real concurrent winning edit',
                changes: [
                  {
                    path: 'index.md',
                    content: `---\nokf_version: "0.2"\n---\n# Winner ${preparations}\n`,
                  },
                ],
              });
              winner = currentNotebookRevision(f);
            } finally {
              publishing = false;
            }
          }
        }
        return prepared;
      });
    onTestFinished(() => prepare.mockRestore());
    await expect(f.store.createKnowledgeProposal(f.input)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(preparations).toBe(2);
    expect(winner).not.toBe(f.baseRevision);
    expect(currentNotebookRevision(f)).toBe(winner);
    expect(f.store.listKnowledgeProposals(f.workspaceId)).toEqual([]);
  }
);

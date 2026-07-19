import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FsStore } from '../lib/store.js';

const TIMESTAMP = '2026-07-12T00:00:00.000Z';

/**
 * Creates one file-backed pending knowledge proposal.
 *
 * @returns Store, data root, workspace id, proposal id, and proposal Markdown path.
 */
function createFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-proposal-authority-'));
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Knowledge proposal authority');
  const proposal = store.createKnowledgeProposal({
    id: 'kp_authority',
    workspaceId: workspace.id,
    title: 'Keep one decision authority',
    summary: 'The review record owns the proposal decision.',
    status: 'pending',
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  });
  const workspaceRoot = join(dataRoot, 'workspaces', workspace.id);

  return {
    dataRoot,
    proposal,
    proposalPath: join(workspaceRoot, 'knowledge', 'proposals', `${proposal.id}.md`),
    reviewPath: join(workspaceRoot, 'knowledge', 'reviews', `${proposal.id}.json`),
    store,
    workspaceId: workspace.id,
  };
}

describe('knowledge proposal decision authority', () => {
  it('rejects a proposal decision without a review record', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-proposal-decision-create-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Knowledge proposal decision creation');

    expect(() =>
      store.createKnowledgeProposal({
        id: 'kp_unreviewed_decision',
        workspaceId: workspace.id,
        title: 'Unreviewed decision',
        summary: 'A review record must own this decision.',
        status: 'accepted',
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      })
    ).toThrow();
  });

  it('keeps decision status out of proposal Markdown', () => {
    const { dataRoot, proposal, proposalPath, workspaceId } = createFixture();

    expect(readFileSync(proposalPath, 'utf8')).not.toMatch(/^status:/m);
    expect(new FsStore({ dataRoot }).getKnowledgeProposal(proposal.id)).toMatchObject({
      workspaceId,
      status: 'pending',
    });
  });

  it('derives the proposal decision from its review record after reload', () => {
    const { dataRoot, proposal, proposalPath, store, workspaceId } = createFixture();
    store.recordKnowledgeProposalReviewDecision({
      proposalId: proposal.id,
      workspaceId,
      status: 'accepted',
      requestId: 'proposal-authority-review',
      message: null,
      decidedAt: TIMESTAMP,
    });

    expect(readFileSync(proposalPath, 'utf8')).not.toMatch(/^status:/m);
    expect(new FsStore({ dataRoot }).getKnowledgeProposal(proposal.id)).toMatchObject({
      status: 'accepted',
    });
  });

  it('falls back to pending when the decision record is absent', () => {
    const { dataRoot, proposal, reviewPath, store, workspaceId } = createFixture();
    store.recordKnowledgeProposalReviewDecision({
      proposalId: proposal.id,
      workspaceId,
      status: 'accepted',
      requestId: 'proposal-authority-removed-review',
      message: null,
      decidedAt: TIMESTAMP,
    });
    rmSync(reviewPath);

    expect(new FsStore({ dataRoot }).getKnowledgeProposal(proposal.id)).toMatchObject({
      status: 'pending',
    });
  });
});

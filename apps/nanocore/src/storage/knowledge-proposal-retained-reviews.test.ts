import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, onTestFinished } from 'vitest';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { readWorkspaceNotebookSelection } from '../knowledge/notebook-workspace-selection.js';
import { FsStore } from '../lib/store.js';
import { createAppWithLocalIdentity } from '../test-support/app.js';
import { testEntityId } from '../test-support/entity-ids.js';
import {
  authorityRequestId,
  candidatePage,
  createFixture,
  currentNotebookRevision,
  currentPage,
  decide,
  digest,
  expectAuthorityFailure,
  type Fixture,
  replaceRetainedProposalReviews,
  retainedProposalState,
} from '../test-support/knowledge-proposal-authority.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import {
  KnowledgeProposalReviewFileSchema,
  loadWorkspace,
  readWorkspaceKnowledgeProposalInventory,
} from './workspace-file-records.js';

describe('knowledge proposal authority', () => {
  describe('annotated retained Reviews', () => {
    let baseline: Fixture;
    let deferred: Awaited<ReturnType<typeof decide>>;
    let accepted: Awaited<ReturnType<typeof decide>>;
    let annotatedBytes: string;
    let dispose: (() => void | Promise<void>) | undefined;
    let preparation: Promise<void> | undefined;
    let preparationSettled = false;
    let preparationAbandoned = false;
    afterAll(async () => {
      await preparation?.catch(() => undefined);
      await shutdownControlStoreWorkerClient();
      await dispose?.();
    });

    /** Shares one closed native baseline within the first case's original budget; never retries it. */
    async function reviewedFixture(): Promise<Fixture> {
      let finished = false;
      let dataRoot: string | undefined;
      let coreDb: ReturnType<typeof openCoreDb> | undefined;
      onTestFinished(async () => {
        finished = true;
        if (!preparationSettled) preparationAbandoned = true;
        await preparation?.catch(() => undefined);
        await shutdownControlStoreWorkerClient();
        if (coreDb?.sqlite.open) coreDb.sqlite.close();
        if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
      });
      const requireActivePreparation = () => {
        if (finished || preparationAbandoned) {
          throw new Error('Annotated Review fixture preparation ended before completion');
        }
      };
      preparation ??= (async () => {
        baseline = await createFixture('proposal-annotated-review', true, (cleanup) => {
          dispose = cleanup;
        });
        requireActivePreparation();
        deferred = await decide(baseline, 'deferred', 'review-annotated-deferred');
        requireActivePreparation();
        accepted = await decide(baseline, 'accepted', 'review-annotated-accepted');
        requireActivePreparation();
        const retained = JSON.parse(
          retainedProposalState(baseline, baseline.proposal.id).reviewsJson
        );
        for (const review of retained) {
          review.futureNote = 'Retained decision description';
          review.actor.futureNote = 'Retained attribution description';
        }
        annotatedBytes = JSON.stringify(retained);
        replaceRetainedProposalReviews(baseline, baseline.proposal.id, annotatedBytes);
        await shutdownControlStoreWorkerClient();
        requireActivePreparation();
        baseline.coreDb.sqlite.close();
      })().finally(() => {
        preparationSettled = true;
      });
      await preparation;
      requireActivePreparation();
      dataRoot = mkdtempSync(join(tmpdir(), 'openkit-annotated-review-'));
      cpSync(baseline.dataRoot, dataRoot, { recursive: true });
      coreDb = openCoreDb(dataRoot);
      const store = new FsStore({ dataRoot });
      const workspaceRoot = join(dataRoot, 'workspaces', baseline.workspaceId);
      const repositoryPath = join(workspaceRoot, 'knowledge', 'notebook.git');
      const workspaceDb = openWorkspaceDb(dataRoot, baseline.workspaceId);
      const notebook = (() => {
        try {
          return readWorkspaceNotebookSelection({
            workspaceDb,
            workspaceRoot,
            knowledgeBaseId: readDefaultKnowledgeBaseId({
              dataRoot,
              scope: { kind: 'workspace', workspaceId: baseline.workspaceId },
            }),
          }).notebook;
        } finally {
          workspaceDb.sqlite.close();
        }
      })();
      const fixture = {
        ...baseline,
        dataRoot,
        coreDb,
        store,
        workspaceRoot,
        repositoryPath,
        notebook,
        app: createAppWithLocalIdentity({ coreDb, dataRoot, store }),
      };
      return {
        ...fixture,
        proposalPath: retainedProposalState(fixture, baseline.proposal.id).proposalPath,
      };
    }

    it('projects annotated retained Reviews without rewriting their bytes', async () => {
      const f = await reviewedFixture();
      expect(accepted.review.proposalDigest).toBe(digest(readFileSync(f.proposalPath, 'utf8')));
      expect(accepted.review.proposalDigest).not.toBe(f.contentDigest);
      f.store = new FsStore({ dataRoot: f.dataRoot });
      f.app = createAppWithLocalIdentity({
        coreDb: f.coreDb,
        dataRoot: f.dataRoot,
        store: f.store,
      });
      expect(
        f.store.projectKnowledgeProposalDecision(f.workspaceId, deferred.review.reviewId)
      ).toEqual(deferred);
      expect(
        f.store.projectKnowledgeProposalDecision(f.workspaceId, accepted.review.reviewId)
      ).toEqual(accepted);
      expect(await decide(f, 'accepted', 'review-annotated-accepted')).toEqual(accepted);
      expect(retainedProposalState(f, f.proposal.id).reviewsJson).toBe(annotatedBytes);
    });

    it('reads a fresh canonical Proposal and Review census and refuses contradictory or orphan Reviews', async () => {
      const f = await reviewedFixture();
      const proposalBytes = readFileSync(f.proposalPath, 'utf8');
      const revision = currentNotebookRevision(f);
      const history = f.notebook.readRevision(revision);
      const first = readWorkspaceKnowledgeProposalInventory(f.workspaceRoot, f.workspaceId);
      expect(first.knowledgeProposals).toEqual([f.proposal]);
      expect(first.knowledgeProposalReviews).toEqual([deferred.review, accepted.review]);

      const later = await f.store.createKnowledgeProposal({
        workspaceId: f.workspaceId,
        requestId: authorityRequestId('inventory-later-proposal'),
        baseRevision: revision,
        changes: ['review/inventory-a', 'review/inventory-b'].map((id) => ({
          path: `${id}.md`,
          content: candidatePage(f.workspaceId, id, f.sourceReference),
        })),
        summary: 'Retain a later multi-page candidate.',
        sourceReferences: [f.sourceReference],
        verifiedExternalReferences: [],
        producer: f.proposal.producer,
        createdAt: f.proposal.createdAt,
      });
      const laterDecision = await decide(
        { ...f, proposal: later },
        'deferred',
        'inventory-later-review'
      );
      const laterState = retainedProposalState(f, later.id);
      const laterProposalPath = laterState.proposalPath;
      const laterProposalBytes = readFileSync(laterProposalPath, 'utf8');
      const laterReviewBytes = laterState.reviewsJson;
      const fresh = readWorkspaceKnowledgeProposalInventory(f.workspaceRoot, f.workspaceId);
      expect(fresh.knowledgeProposals.map(({ id }) => id).sort()).toEqual(
        [f.proposal.id, later.id].sort()
      );
      expect(fresh.knowledgeProposals.find(({ id }) => id === later.id)).toEqual(later);
      expect(fresh.knowledgeProposalReviews.map(({ reviewId }) => reviewId).sort()).toEqual(
        [deferred.review.reviewId, accepted.review.reviewId, laterDecision.review.reviewId].sort()
      );
      expect(
        fresh.knowledgeProposalReviews.find(({ proposalId }) => proposalId === later.id)
      ).toEqual(laterDecision.review);
      expect(loadWorkspace(f.workspaceRoot, f.workspaceId).knowledgeProposalReviews).toContainEqual(
        laterDecision.review
      );
      expect(readFileSync(f.proposalPath, 'utf8')).toBe(proposalBytes);
      expect(retainedProposalState(f, f.proposal.id).reviewsJson).toBe(annotatedBytes);
      expect(currentNotebookRevision(f)).toBe(revision);
      expect(f.notebook.readRevision(revision)).toEqual(history);

      const changed = JSON.parse(laterReviewBytes);
      changed[0].changedPageIds = ['review/inventory-foreign'];
      expect(
        KnowledgeProposalReviewFileSchema.safeParse({
          proposalId: later.id,
          workspaceId: f.workspaceId,
          decisions: changed,
        }).success
      ).toBe(true);
      replaceRetainedProposalReviews(f, later.id, JSON.stringify(changed));
      try {
        expect(() =>
          readWorkspaceKnowledgeProposalInventory(f.workspaceRoot, f.workspaceId)
        ).toThrow();
        expect(() => loadWorkspace(f.workspaceRoot, f.workspaceId)).toThrow();
      } finally {
        replaceRetainedProposalReviews(f, later.id, laterReviewBytes);
      }

      rmSync(laterProposalPath);
      try {
        expect(() =>
          readWorkspaceKnowledgeProposalInventory(f.workspaceRoot, f.workspaceId)
        ).toThrow();
        expect(retainedProposalState(f, later.id).reviewsJson).toBe(laterReviewBytes);
      } finally {
        writeFileSync(laterProposalPath, laterProposalBytes);
      }
      expect(currentNotebookRevision(f)).toBe(revision);
      expect(f.notebook.readRevision(revision)).toEqual(history);
    });

    it.each([
      ['decision', 'rejected'],
      ['proposalDigest', `sha256:${'0'.repeat(64)}`],
      ['contentDigest', `sha256:${'1'.repeat(64)}`],
      ['knowledgePageId', 'review/foreign-page'],
      ['requestId', authorityRequestId('foreign-review-request')],
      ['reviewId', testEntityId('kr', 'foreign-review')],
      ['workspaceId', testEntityId('ws', 'foreign-workspace')],
      ['ownerScope', { kind: 'workspace', workspaceId: testEntityId('ws', 'foreign-owner') }],
      ['baseRevision', '0'.repeat(40)],
      ['candidateRevision', '1'.repeat(40)],
      ['actor', { kind: 'user', id: testEntityId('usr', 'foreign-reviewer') }],
    ] as const)('refuses changed ordered decision core: %s', async (key, value) => {
      const f = await reviewedFixture();
      const changed = JSON.parse(annotatedBytes);
      changed[1][key] = value;
      replaceRetainedProposalReviews(f, f.proposal.id, JSON.stringify(changed));
      await expectAuthorityFailure(
        () => f.store.projectKnowledgeProposalDecision(f.workspaceId, accepted.review.reviewId),
        'recovery_required'
      );
      await expectAuthorityFailure(
        async () => await decide(f, 'accepted', 'review-annotated-accepted'),
        'recovery_required'
      );
      expect(currentPage(f, f.knowledgePageId)).toBe(f.canonicalPageBytes);
    });

    it('refuses reversed retained decision order', async () => {
      const f = await reviewedFixture();
      const retained = JSON.parse(annotatedBytes);
      retained.reverse();
      replaceRetainedProposalReviews(f, f.proposal.id, JSON.stringify(retained));
      await expectAuthorityFailure(
        () => f.store.projectKnowledgeProposalDecision(f.workspaceId, accepted.review.reviewId),
        'recovery_required'
      );
    });
  });
});

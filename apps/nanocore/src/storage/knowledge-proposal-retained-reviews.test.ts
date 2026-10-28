import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { KnowledgeNotebook } from '../knowledge/notebook.js';
import { FsStore } from '../lib/store.js';
import { createAppWithLocalIdentity } from '../test-support/app.js';
import { testEntityId } from '../test-support/entity-ids.js';
import {
  authorityRequestId,
  createFixture,
  currentPage,
  decide,
  digest,
  expectAuthorityFailure,
  type Fixture,
} from '../test-support/knowledge-proposal-authority.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb } from './db.js';

describe('knowledge proposal authority', () => {
  describe('annotated retained Reviews', () => {
    let baseline: Fixture;
    let deferred: Awaited<ReturnType<typeof decide>>;
    let accepted: Awaited<ReturnType<typeof decide>>;
    let annotatedBytes: string;
    let dispose: (() => void) | undefined;
    beforeAll(async () => {
      baseline = await createFixture('proposal-annotated-review', true, (cleanup) => {
        dispose = cleanup;
      });
      deferred = await decide(baseline, 'deferred', 'review-annotated-deferred');
      accepted = await decide(baseline, 'accepted', 'review-annotated-accepted');
      const retained = JSON.parse(readFileSync(baseline.reviewPath, 'utf8'));
      retained.futureNote = 'Retained Review description';
      for (const review of retained.decisions) {
        review.futureNote = 'Retained decision description';
        review.actor.futureNote = 'Retained attribution description';
      }
      annotatedBytes = `${JSON.stringify(retained, null, 2)}\n`;
      writeFileSync(baseline.reviewPath, annotatedBytes);
      await shutdownControlStoreWorkerClient();
      baseline.coreDb.sqlite.close();
    });
    afterAll(() => dispose?.());

    /** Copies closed native owners; each corruption gets independent bytes, receipts and Git objects. */
    function reviewedFixture(): Fixture {
      const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-annotated-review-'));
      cpSync(baseline.dataRoot, dataRoot, { recursive: true });
      const coreDb = openCoreDb(dataRoot);
      onTestFinished(async () => {
        coreDb.sqlite.close();
        await shutdownControlStoreWorkerClient();
        rmSync(dataRoot, { recursive: true, force: true });
      });
      const store = new FsStore({ dataRoot });
      const workspaceRoot = join(dataRoot, 'workspaces', baseline.workspaceId);
      const repositoryPath = join(workspaceRoot, 'knowledge', 'notebook.git');
      return {
        ...baseline,
        dataRoot,
        coreDb,
        store,
        workspaceRoot,
        repositoryPath,
        notebook: new KnowledgeNotebook({ repositoryPath }),
        app: createAppWithLocalIdentity({ coreDb, dataRoot, store }),
        proposalPath: join(workspaceRoot, 'knowledge', 'proposals', `${baseline.proposal.id}.md`),
        reviewPath: join(workspaceRoot, 'knowledge', 'reviews', `${baseline.proposal.id}.json`),
      };
    }

    it('projects annotated retained Reviews without rewriting their bytes', async () => {
      const f = reviewedFixture();
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
      expect(readFileSync(f.reviewPath, 'utf8')).toBe(annotatedBytes);
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
      const f = reviewedFixture();
      const changed = JSON.parse(annotatedBytes);
      changed.decisions[1][key] = value;
      writeFileSync(f.reviewPath, `${JSON.stringify(changed, null, 2)}\n`);
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
      const f = reviewedFixture();
      const retained = JSON.parse(annotatedBytes);
      retained.decisions.reverse();
      writeFileSync(f.reviewPath, `${JSON.stringify(retained, null, 2)}\n`);
      await expectAuthorityFailure(
        () => f.store.projectKnowledgeProposalDecision(f.workspaceId, accepted.review.reviewId),
        'recovery_required'
      );
    });
  });
});

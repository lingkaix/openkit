import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId, formatReferenceUri } from '@openkit/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import { readHumanAttention, readScopedHumanAttention } from '../action-center.js';
import * as authorization from '../auth/operation-authorizer.js';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { readWorkspaceNotebookSelection } from '../knowledge/notebook-workspace-selection.js';
import { executeGoalOperation } from '../runtime/goal-owner.js';
import { recordWorkspaceReconciliationRecord } from '../runtime/workspace-reconciliation-records.js';
import { recordWorkspaceSyncReview } from '../runtime/workspace-sync-records.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { testGoalDomainProposal } from '../test-support/goal-domain.js';
import { serializeKnowledgePageFixture } from '../test-support/knowledge-page.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { createTestCoreDb, disposeTestStore } from '../test-support/store.js';
import { recordTestWorkspaceReviewMaterialization } from '../test-support/workspace-sync.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { openWorkspaceDb } from './db.js';

const cleanups: Array<() => Promise<void>> = [];
const now = '2026-11-13T01:00:00.000Z';
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Real product and review owners; the existing shared builder supplies trusted materialization. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'thread-attention-parity-'));
  const coreDb = createTestCoreDb(root);
  const userId = ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot: root });
  const workspaceDb = openWorkspaceDb(root, DEMO_WORKSPACE_ID);
  cleanups.push(() => disposeTestStore(root, workspaceDb, coreDb));
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: DEMO_WORKSPACE_ID, ownerUserId: userId });
  const thread = await store.createThread(DEMO_WORKSPACE_ID, 'Canonical review scope');
  const other = await store.createThread(DEMO_WORKSPACE_ID, 'Unrelated thread');
  const turn = await store.createTurn(DEMO_WORKSPACE_ID, thread.id, 'Produce Workspace changes', {
    kind: 'user',
    id: userId,
  });
  const input = {
    store,
    coreDb,
    workspaceDb,
    workspaceId: DEMO_WORKSPACE_ID,
    actor: { kind: 'local' as const, userId },
    administratorEligible: false,
  };
  /** Reads the same clock so row age cannot make a parity comparison flaky. */
  function rows(threadIds = [thread.id]) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    try {
      return {
        full: readHumanAttention({
          ...input,
          repositoryWorkspaceDb: () => openWorkspaceDb(root, DEMO_WORKSPACE_ID),
        }).items,
        scoped: readScopedHumanAttention({ ...input, threadIds }).items,
      };
    } finally {
      vi.useRealTimers();
    }
  }
  async function review(scoped: boolean) {
    const artifactId = allocateEntityId('ar');
    const requestId = scoped ? 'review-canonical' : 'review-workspace-only';
    const content = '{"changes":"owner-produced"}';
    const contentDigest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    await store.createArtifact({
      id: artifactId,
      workspaceId: DEMO_WORKSPACE_ID,
      threadId: scoped ? thread.id : null,
      turnId: scoped ? turn.id : null,
      kind: scoped ? 'diff' : 'file',
      title: 'Workspace changes',
      status: 'ready',
      summary: null,
      version: 1,
      content: { format: 'json', body: content },
      contentDigest,
      lastMutationRequestId: requestId,
      origin: scoped
        ? { kind: 'turn-output', threadId: thread.id, turnId: turn.id, requestId }
        : {
            kind: 'imported',
            sourceKind: 'direct-import',
            sourceId: requestId,
            sourceDigest: contentDigest,
            actor: { kind: 'user', id: userId },
            requestId,
            recordedAt: now,
          },
      createdAt: now,
      updatedAt: now,
    });
    const reviewId = `wsr_${requestId}`;
    const changeSetId = `wcs_${requestId}`;
    const patchText = 'diff --git a/example.txt b/example.txt\n';
    const digest = `sha256:${createHash('sha256').update(patchText).digest('hex')}`;
    const item = {
      artifactId,
      changeSet: {
        id: changeSetId,
        materializationRecordId: `wmr_${requestId}`,
        inputSnapshotId: `wis_${requestId}`,
        workspaceId: DEMO_WORKSPACE_ID,
        resourceId: 'repo_default',
        strategy: 'git' as const,
        base: { commit: 'abc123', contentDigest: null },
        head: { commit: 'def456', contentDigest: null },
        changedPaths: [{ path: 'example.txt', status: 'modified' as const, binary: false }],
        patch: { ref: 'artifact://patch', digest, bytes: Buffer.byteLength(patchText) },
        bundle: null,
        artifactIds: [artifactId],
        evidenceRefs: [],
        redaction: { status: 'redacted' as const, notes: [] },
        createdAt: now,
      },
      patchPayload: {
        mediaType: 'text/x-diff',
        text: patchText,
        digest,
        bytes: Buffer.byteLength(patchText),
      },
      review: {
        id: reviewId,
        changeSetId,
        workspaceId: DEMO_WORKSPACE_ID,
        status: 'pending' as const,
        staging: {
          strategy: 'git_worktree' as const,
          ref: `staging://workspace/${changeSetId}`,
          branch: `openkit/review/${reviewId}`,
        },
        diffSummary: { filesChanged: 1, additions: 0, deletions: 0 },
        riskSummary: 'One changed path awaits review.',
        validation: [],
        actionCenterRowId: `workspace-review:${reviewId}`,
        createdAt: now,
        updatedAt: now,
      },
    };
    recordTestWorkspaceReviewMaterialization(workspaceDb, item);
    recordWorkspaceSyncReview(workspaceDb, { item });
    return `workspace-review:${reviewId}`;
  }
  return { ...input, thread, other, turn, rows, review };
}

// Goal Plan/completion requests come only from the Goal command owner, never fixture records.
it('keeps owner-produced Goal Plan and completion requests identical in both attention reads', async () => {
  const f = await fixture();
  let serial = 400;
  const requestId = () => `00000000-0000-4000-8000-${String(serial++).padStart(12, '0')}`;
  const human = { actor: f.actor };
  const created = await executeGoalOperation(
    'goal.create',
    { workspaceId: DEMO_WORKSPACE_ID, requestId: requestId(), intent: 'Produce a design' },
    human,
    f.store,
    f.workspaceDb
  );
  const scope = {
    workspaceId: DEMO_WORKSPACE_ID,
    threadId: created.goal!.threadId,
    goalId: created.goal!.goalId,
  };
  const turn = await f.store.createTurn(
    DEMO_WORKSPACE_ID,
    scope.threadId,
    'Coordinate',
    { kind: 'user', id: f.actor.userId },
    undefined,
    { executorKind: 'coordinator', agentId: 'goal-coordinator' }
  );
  const coordinator = { ...human, coordinatorTurnId: turn.id };
  const cardView = await executeGoalOperation(
    'goal.card.create',
    { ...scope, requestId: requestId(), description: 'Design the schema', priority: 1 },
    human,
    f.store,
    f.workspaceDb
  );
  const card = cardView.cards[0]!;
  const current = await executeGoalOperation('goal.read', scope, human, f.store, f.workspaceDb);
  const proposed = await executeGoalOperation(
    'goal.plan.propose',
    {
      ...scope,
      requestId: requestId(),
      expectedRevision: current.goal!.changeRevision,
      goalDomain: testGoalDomainProposal(scope.workspaceId, scope.goalId),
      commitment: {
        intentBasis: { revision: 0, intent: 'Produce a design' },
        cards: [
          {
            cardId: card.cardId,
            revision: 0,
            description: card.description,
            priority: card.priority,
          },
        ],
        permittedAdjustments: 'Refine the design without deployment',
        completionEvidence: ['Reviewed design'],
        boundaries: 'No deployment',
      },
    },
    coordinator,
    f.store,
    f.workspaceDb
  );
  const plan = proposed.versions.at(-1)!;
  const compare = (pendingRequestId: string) => {
    const { full, scoped } = f.rows([scope.threadId]);
    const row = full.find((candidate) => candidate.id === `approval:${pendingRequestId}`);
    expect(row).toMatchObject({ threadId: scope.threadId, turnId: turn.id });
    expect(scoped.find((candidate) => candidate.id === row!.id)).toEqual(row);
    expect(f.rows([f.other.id]).scoped.some((candidate) => candidate.id === row!.id)).toBe(false);
  };
  compare(plan.pendingRequestId);
  await executeGoalOperation(
    'goal.plan.approve',
    {
      ...scope,
      requestId: requestId(),
      pendingRequestId: plan.pendingRequestId,
      decision: 'granted',
    },
    human,
    f.store,
    f.workspaceDb
  );
  // This is the owner test's existing caller-admission seam, not a manufactured grant record.
  await executeGoalOperation(
    'goal.plan.approve',
    {
      ...scope,
      requestId: requestId(),
      pendingRequestId: plan.pendingRequestId,
      decision: 'granted',
    },
    coordinator,
    f.store,
    f.workspaceDb,
    { grantAuthority: () => true }
  );
  const raised = await executeGoalOperation(
    'goal.completion.accept',
    {
      ...scope,
      requestId: requestId(),
      candidate: {
        intentRevision: 0,
        intent: 'Produce a design',
        planVersionId: plan.planVersionId,
        evidence: [],
        unresolvedWork: ['Human review remains'],
        summary: 'Review this exact candidate.',
      },
    },
    coordinator,
    f.store,
    f.workspaceDb
  );
  const completion = raised.requests.find(
    (request) => request.operation === 'goal.completion.accept'
  );
  expect(completion).toBeDefined();
  compare(completion!.requestId);
});

// G6/TB4 still requires parity. TB-EXT-2's explicit stop-join instruction forbids inventing
// records/indexes when existing bounded sources cannot prove the join. The staged-review
// owner only lists the whole Workspace or reads an already-known review id; its Artifact
// index cannot enumerate a Thread's reviews. This is a source-gap witness, not parity proof.
it('witnesses the bounded-source gap for a canonical Workspace Review without inventing a timeline row', async () => {
  const f = await fixture();
  const id = await f.review(true);
  const { full, scoped } = f.rows();
  const source = full.find((row) => row.id === id);
  expect(source).toMatchObject({
    threadId: f.thread.id,
    turnId: f.turn.id,
    source: { type: 'workspace_review' },
  });
  expect(scoped.some((row) => row.id === id)).toBe(false);
  expect(f.rows([f.other.id]).scoped.some((row) => row.id === id)).toBe(false);
});

// Source authorization must remain independent of canonical lineage.
it('omits the canonical Workspace Review from both reads when its Review authority is denied', async () => {
  const f = await fixture();
  const id = await f.review(true);
  expect(f.rows().full.some((row) => row.id === id)).toBe(true);
  const authorize = authorization.isWorkspaceOperationAuthorized;
  vi.spyOn(authorization, 'isWorkspaceOperationAuthorized').mockImplementation(
    (core, actor, workspaceId, options) =>
      options.policyOperation === 'review.apply'
        ? false
        : authorize(core, actor, workspaceId, options)
  );
  const { full, scoped } = f.rows();
  expect(full.some((row) => row.id === id)).toBe(false);
  expect(scoped.some((row) => row.id === id)).toBe(false);
});

// The Proposal owner retains no canonical Thread selector. A responsible human is not lineage.
it('leaves an owner-produced Knowledge Proposal on Knowledge instead of guessing a Thread', async () => {
  const f = await fixture();
  const source = f.store.getWorkspaceResources(DEMO_WORKSPACE_ID).knowledge[0]!;
  const dataRoot = f.store.getDataRoot()!;
  const knowledgeBaseId = readDefaultKnowledgeBaseId({
    dataRoot,
    scope: { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID },
  });
  const selection = readWorkspaceNotebookSelection({
    workspaceDb: f.workspaceDb,
    workspaceRoot: join(dataRoot, 'workspaces', DEMO_WORKSPACE_ID),
    knowledgeBaseId,
  });
  const baseRevision = selection.head.notebookCommit;
  const bytes = selection.notebook.readRevision(baseRevision).files[`${source.id}.md`];
  expect(bytes).toBeDefined();
  const sourceReference = formatReferenceUri(
    {
      scopeId: `page/workspace/${DEMO_WORKSPACE_ID}/${knowledgeBaseId}`,
      objectId: source.id,
    },
    `sha256:${createHash('sha256').update(bytes!, 'utf8').digest('hex')}`
  );
  const canonicalPageBytes = serializeKnowledgePageFixture(
    {
      title: 'Proposal scope',
      content: 'An owner-produced proposal has Workspace scope.',
      sourceReferences: [sourceReference],
      createdAt: now,
      updatedAt: now,
    },
    { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID }
  ).replace('review_state: "user-authored"', 'review_state: "accepted"');
  const proposal = await f.store.createKnowledgeProposal({
    workspaceId: DEMO_WORKSPACE_ID,
    baseRevision,
    requestId: '00000000-0000-4000-8000-000000000321',
    knowledgePageId: 'parity/proposal-scope',
    canonicalPageBytes,
    contentDigest: `sha256:${createHash('sha256').update(canonicalPageBytes).digest('hex')}`,
    sourceReferences: [sourceReference],
    rationale: 'Review the exact proposal.',
    confidence: 0.9,
    verifiedExternalReferences: [],
    producer: { kind: 'system', id: 'system_parity', responsibleUserId: f.actor.userId },
    createdAt: now,
  });
  const { full, scoped } = f.rows();
  const row = full.find((candidate) => candidate.id === `knowledge:${proposal.id}`);
  expect(row).toMatchObject({
    kind: 'knowledge_review',
    source: { type: 'knowledge', knowledgeProposalId: proposal.id },
  });
  expect(row?.threadId).toBeUndefined();
  expect(row?.turnId).toBeUndefined();
  expect(scoped.some((candidate) => candidate.id === row!.id)).toBe(false);
});

// Workspace-only lineage must not be guessed from an evidence reference or the newest Thread.
it('leaves imported Workspace Reviews and Workspace recovery at their owning Workspace surface', async () => {
  const f = await fixture();
  const id = await f.review(false);
  recordWorkspaceReconciliationRecord(f.workspaceDb, {
    id: 'wrr_parity_workspace_only',
    workspaceId: DEMO_WORKSPACE_ID,
    triggerReason: 'restart',
    affectedRecordIds: [],
    backendHandleSummary: {},
    backendReachability: { status: 'unavailable', checkedAt: now, detail: null },
    collectedOutputManifestIds: [],
    evidenceBundleIds: [],
    stateBefore: 'ready',
    stateAfter: 'requires-human',
    quarantineRefs: [],
    requiredHumanDecision: 'inspect_recovery',
    retentionDecision: 'retain-backend',
    startedAt: now,
    finishedAt: null,
  });
  const { full, scoped } = f.rows();
  for (const rowId of [id, 'workspace-recovery:wrr_parity_workspace_only']) {
    const source = full.find((row) => row.id === rowId);
    expect(source).toBeDefined();
    expect(source?.threadId).toBeUndefined();
    expect(source?.turnId).toBeUndefined();
    expect(scoped.some((row) => row.id === rowId)).toBe(false);
  }
});

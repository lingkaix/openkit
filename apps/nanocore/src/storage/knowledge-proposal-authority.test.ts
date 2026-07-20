import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WORKSPACE_KNOWLEDGE_SCHEMA_VERSION,
  KnowledgePageValidationError,
} from '../knowledge/okf.js';
import { resolveWorkspaceKnowledgeReferenceProofs } from '../knowledge-manager.js';
import { FsStore } from '../lib/store.js';
import {
  resolveWorkspaceKnowledgeRetrievalPages,
  retrieveWorkspaceKnowledge,
} from './index-rebuild.js';

const CREATED_AT = '2026-07-12T00:00:00.000Z';
const DECIDED_AT = '2026-07-12T01:00:00.000Z';
const PRODUCER = { kind: 'agent', id: 'agent_knowledge', responsibleUserId: 'user_local' } as const;
const REVIEWER = { kind: 'user', id: 'user_local' } as const;

/** Computes the canonical SHA-256 digest used by Knowledge authority records. */
function digest(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

/** Derives the identifier required by the S61 canonical JSON tuple. */
function deterministicId(prefix: 'kp_' | 'kr_', tuple: object): string {
  return `${prefix}${createHash('sha256').update(JSON.stringify(tuple), 'utf8').digest('hex')}`;
}

/** Derives one deterministic protocol UUID from a readable authority-test label. */
function authorityRequestId(label: string): string {
  const suffix = createHash('sha256').update(label, 'utf8').digest('hex').slice(0, 12);
  return `00000000-0000-4000-8000-${suffix}`;
}

/** Builds one valid accepted Knowledge Page byte sequence for proposal application. */
function candidatePage(knowledgePageId: string, sourceReference: string): string {
  return [
    '---',
    'type: "KnowledgePage"',
    'title: "Review authority lesson"',
    'openkit_entry_kind: "project-context"',
    `openkit_entry_id: ${JSON.stringify(knowledgePageId)}`,
    `schema_version: ${JSON.stringify(DEFAULT_WORKSPACE_KNOWLEDGE_SCHEMA_VERSION)}`,
    'status: "active"',
    'scope: "workspace"',
    `source_refs: ${JSON.stringify([sourceReference])}`,
    'review_state: "accepted"',
    'sensitivity: "normal"',
    'freshness: "current"',
    `created_at: ${JSON.stringify(CREATED_AT)}`,
    `updated_at: ${JSON.stringify(CREATED_AT)}`,
    '---',
    'Keep proposal application under one append-only human Review authority.',
    '',
  ].join('\n');
}

/** Creates one file-backed proposal with an existing Knowledge Page as its evidence. */
function createFixture(requestLabel = 'proposal-authority-draft') {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-proposal-authority-'));
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Knowledge proposal authority');
  const source = store.createKnowledgeEntry(workspace.id, {
    kind: 'project-context',
    title: 'Existing review evidence',
    content: 'A human Review is the only activation authority.',
    sourceReferences: [],
  });
  const workspaceRoot = join(dataRoot, 'workspaces', workspace.id);
  const sourceBytes = readFileSync(
    join(workspaceRoot, 'knowledge', 'pages', `${source.id}.md`),
    'utf8'
  );
  const sourceReference = `knowledge:${source.id}@${digest(sourceBytes)}`;
  const knowledgePageId = 'review/review-authority-lesson';
  const canonicalPageBytes = candidatePage(knowledgePageId, sourceReference);
  const contentDigest = digest(canonicalPageBytes);
  const proposal = store.createKnowledgeProposal({
    workspaceId: workspace.id,
    requestId: authorityRequestId(requestLabel),
    knowledgePageId,
    canonicalPageBytes,
    contentDigest,
    sourceReferences: [sourceReference],
    rationale: 'This bounded rule is supported by the cited Workspace page.',
    confidence: 0.9,
    verifiedExternalReferences: [],
    producer: PRODUCER,
    createdAt: CREATED_AT,
  });

  return {
    canonicalPageBytes,
    contentDigest,
    dataRoot,
    knowledgePageId,
    pagePath: join(workspaceRoot, 'knowledge', 'pages', `${knowledgePageId}.md`),
    proposal,
    proposalPath: join(workspaceRoot, 'knowledge', 'proposals', `${proposal.id}.md`),
    reviewPath: join(workspaceRoot, 'knowledge', 'reviews', `${proposal.id}.json`),
    sourceReference,
    store,
    workspaceId: workspace.id,
  };
}

/** Records one decision through the proposed append-only store boundary. */
function decide(
  fixture: ReturnType<typeof createFixture>,
  decision: 'accepted' | 'deferred' | 'rejected',
  requestLabel: string
) {
  return fixture.store.recordKnowledgeProposalReviewDecision({
    workspaceId: fixture.workspaceId,
    proposalId: fixture.proposal.id,
    requestId: authorityRequestId(requestLabel),
    decision,
    verifiedExternalReferences: [],
    actor: REVIEWER,
    decidedAt: DECIDED_AT,
  });
}

/** Asserts one bounded authority failure without depending on an HTTP adapter. */
function expectAuthorityFailure(action: () => unknown, code: 'conflict' | 'recovery_required') {
  try {
    action();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected Knowledge authority failure: ${code}`);
}

describe('knowledge proposal authority', () => {
  it('derives deterministic ids and freezes the exact candidate tuple in the proposal owner', () => {
    const fixture = createFixture();
    const proposalBytes = readFileSync(fixture.proposalPath, 'utf8');

    expect(fixture.proposal).toMatchObject({
      id: deterministicId('kp_', {
        workspaceId: fixture.workspaceId,
        requestId: authorityRequestId('proposal-authority-draft'),
      }),
      workspaceId: fixture.workspaceId,
      operation: 'create',
      knowledgePageId: fixture.knowledgePageId,
      canonicalPageBytes: fixture.canonicalPageBytes,
      contentDigest: fixture.contentDigest,
      sourceReferences: [fixture.sourceReference],
      producer: PRODUCER,
    });
    expect(proposalBytes.endsWith(fixture.canonicalPageBytes)).toBe(true);
    const proposalHeader = proposalBytes.slice(0, proposalBytes.indexOf('\n---\n', 4));
    expect(proposalHeader).not.toMatch(/^status:/m);
  });

  it.each([
    {
      name: 'changed',
      alter: (path: string) => writeFileSync(path, 'Changed captured source bytes.\n'),
    },
    {
      name: 'missing',
      alter: (path: string) => rmSync(path),
    },
  ])('rejects proposal draft and acceptance when registered source bytes are $name', ({
    alter,
    name,
  }) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-proposal-source-authority-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Knowledge proposal source authority');
    const sourceId = 'ks_00000000-0000-4000-8000-000000000001';
    const sourceContent = 'Captured source bytes remain immutable evidence.\n';
    const sourceReference = `source:${sourceId}@${digest(sourceContent)}`;
    store.createKnowledgeSource(
      {
        id: sourceId,
        workspaceId: workspace.id,
        kind: 'document',
        title: 'Captured proposal evidence',
        uri: null,
        contentDigest: digest(sourceContent),
        originatingThreadId: null,
        originatingTurnId: null,
        originatingFileId: null,
        capturedAt: CREATED_AT,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
      sourceContent
    );
    /** Creates one proposal bound to the registered source fixture. */
    const createSourceProposal = (requestLabel: string, knowledgePageId: string) => {
      const canonicalPageBytes = candidatePage(knowledgePageId, sourceReference);
      return store.createKnowledgeProposal({
        workspaceId: workspace.id,
        requestId: authorityRequestId(requestLabel),
        knowledgePageId,
        canonicalPageBytes,
        contentDigest: digest(canonicalPageBytes),
        sourceReferences: [sourceReference],
        rationale: 'The proposal cites exact registered source bytes.',
        confidence: 0.9,
        verifiedExternalReferences: [],
        producer: PRODUCER,
        createdAt: CREATED_AT,
      });
    };
    const proposal = createSourceProposal(
      `source-valid-before-${name}`,
      `source/accepted-before-${name}`
    );
    alter(
      join(dataRoot, 'workspaces', workspace.id, 'sources', 'materials', sourceId, 'content.txt')
    );

    expect(() => createSourceProposal(`source-${name}-draft`, `source/${name}-draft`)).toThrow(
      KnowledgePageValidationError
    );
    expect(() =>
      store.recordKnowledgeProposalReviewDecision({
        workspaceId: workspace.id,
        proposalId: proposal.id,
        requestId: authorityRequestId(`source-${name}-acceptance`),
        decision: 'accepted',
        verifiedExternalReferences: [],
        actor: REVIEWER,
        decidedAt: DECIDED_AT,
      })
    ).toThrow(KnowledgePageValidationError);
    expect(store.listKnowledgeProposalReviewDecisions(workspace.id)).toEqual([]);
  });

  it.each([
    'accepted',
    'rejected',
  ] as const)('appends defer then %s and rejects every post-terminal decision', (terminalDecision) => {
    const fixture = createFixture(`proposal-${terminalDecision}`);
    const deferred = decide(fixture, 'deferred', `review-defer-${terminalDecision}`);
    const terminal = decide(fixture, terminalDecision, `review-terminal-${terminalDecision}`);
    const decisions = fixture.store.listKnowledgeProposalReviewDecisions(fixture.workspaceId);
    const proposalDigest = digest(readFileSync(fixture.proposalPath, 'utf8'));

    expect(deferred.review).toEqual({
      reviewId: deterministicId('kr_', {
        workspaceId: fixture.workspaceId,
        proposalId: fixture.proposal.id,
        requestId: authorityRequestId(`review-defer-${terminalDecision}`),
      }),
      proposalId: fixture.proposal.id,
      workspaceId: fixture.workspaceId,
      requestId: authorityRequestId(`review-defer-${terminalDecision}`),
      decision: 'deferred',
      actor: REVIEWER,
      proposalDigest,
      knowledgePageId: fixture.knowledgePageId,
      contentDigest: fixture.contentDigest,
      targetAbsentAtDecision: null,
      decidedAt: DECIDED_AT,
    });
    expect(terminal.review).toEqual({
      reviewId: deterministicId('kr_', {
        workspaceId: fixture.workspaceId,
        proposalId: fixture.proposal.id,
        requestId: authorityRequestId(`review-terminal-${terminalDecision}`),
      }),
      proposalId: fixture.proposal.id,
      workspaceId: fixture.workspaceId,
      requestId: authorityRequestId(`review-terminal-${terminalDecision}`),
      decision: terminalDecision,
      actor: REVIEWER,
      proposalDigest,
      knowledgePageId: fixture.knowledgePageId,
      contentDigest: fixture.contentDigest,
      targetAbsentAtDecision: terminalDecision === 'accepted' ? true : null,
      decidedAt: DECIDED_AT,
    });
    expect(decisions).toEqual([deferred.review, terminal.review]);
    expect(JSON.parse(readFileSync(fixture.reviewPath, 'utf8'))).toEqual({
      proposalId: fixture.proposal.id,
      workspaceId: fixture.workspaceId,
      decisions,
    });
    expect(deferred.application).toBeNull();
    if (terminalDecision === 'rejected') {
      expect(terminal.application).toBeNull();
      expect(existsSync(fixture.pagePath)).toBe(false);
    }
    expectAuthorityFailure(
      () => decide(fixture, 'deferred', `review-after-${terminalDecision}`),
      'conflict'
    );
  });

  it('publishes the accepted proposal exact bytes and can complete only its missing page effect', () => {
    const fixture = createFixture('proposal-accepted-page');
    const first = decide(fixture, 'accepted', 'review-accepted-page');

    expect(first).toMatchObject({
      review: {
        knowledgePageId: fixture.knowledgePageId,
        contentDigest: fixture.contentDigest,
        targetAbsentAtDecision: true,
      },
      application: {
        knowledgePageId: fixture.knowledgePageId,
        contentDigest: fixture.contentDigest,
        present: true,
      },
    });
    expect(readFileSync(fixture.pagePath, 'utf8')).toBe(fixture.canonicalPageBytes);

    rmSync(fixture.pagePath);
    fixture.store.recordKnowledgeConflict({
      id: 'kf_missing_page_retry',
      workspaceId: fixture.workspaceId,
      subjectReferences: [`knowledge:${fixture.knowledgePageId}`],
      sourceReferences: [],
      status: 'needs_review',
      summary: 'Resolve before completing the interrupted page write.',
      suggestedActions: ['Resolve before publication.'],
      producer: 'proposal-authority-test',
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    });
    const restarted = { ...fixture, store: new FsStore({ dataRoot: fixture.dataRoot }) };
    expectAuthorityFailure(() => decide(restarted, 'accepted', 'review-accepted-page'), 'conflict');
    expect(existsSync(fixture.pagePath)).toBe(false);
    expect(restarted.store.listKnowledgeProposalReviewDecisions(fixture.workspaceId)).toHaveLength(
      1
    );
    restarted.store.resolveKnowledgeConflict({
      workspaceId: fixture.workspaceId,
      conflictId: 'kf_missing_page_retry',
      status: 'resolved',
      resolution: 'The publication conflict was resolved.',
      resolvedBy: 'user_local',
      resolvedAt: DECIDED_AT,
    });
    const completed = decide(restarted, 'accepted', 'review-accepted-page');

    expect(completed).toEqual(first);
    expect(readFileSync(fixture.pagePath, 'utf8')).toBe(fixture.canonicalPageBytes);
    expect(restarted.store.listKnowledgeProposalReviewDecisions(fixture.workspaceId)).toHaveLength(
      1
    );
  });

  it('retrieves one hierarchical accepted page only through its exact proposal proof', () => {
    const fixture = createFixture('proposal-retrieval-proof');
    decide(fixture, 'accepted', 'review-retrieval-proof');
    const referenceProofs = resolveWorkspaceKnowledgeReferenceProofs({
      coreDb: undefined,
      store: fixture.store,
      workspaceDb: undefined,
      workspaceId: fixture.workspaceId,
    });
    const copiedPageId = 'review/copied-authority-lesson';
    const copiedPageBytes = candidatePage(copiedPageId, fixture.sourceReference);
    writeFileSync(
      join(
        fixture.dataRoot,
        'workspaces',
        fixture.workspaceId,
        'knowledge',
        'pages',
        `${copiedPageId}.md`
      ),
      copiedPageBytes
    );

    const retrieval = retrieveWorkspaceKnowledge({
      caller: 'task-mode',
      dataRoot: fixture.dataRoot,
      limit: 1,
      pinnedConceptIds: [copiedPageId],
      query: 'Review authority lesson',
      referenceProofs,
      traceId: 'krt_00000000-0000-4000-8000-000000000701',
      workspaceId: fixture.workspaceId,
      now: () => DECIDED_AT,
    });

    expect(retrieval.selected).toEqual([
      expect.objectContaining({
        contentDigest: fixture.contentDigest,
        knowledgePageId: fixture.knowledgePageId,
        sourceReferences: [fixture.sourceReference],
      }),
    ]);
    expect(retrieval.excluded).toContainEqual({
      contentDigest: digest(copiedPageBytes),
      knowledgePageId: copiedPageId,
      reason: 'lower_conformance',
    });
    expect(
      resolveWorkspaceKnowledgeRetrievalPages({
        caller: 'task-mode',
        dataRoot: fixture.dataRoot,
        referenceProofs,
        retrievalTraceId: retrieval.traceId,
        workspaceId: fixture.workspaceId,
      })
    ).toEqual([
      expect.objectContaining({
        content: fixture.canonicalPageBytes,
        contentDigest: fixture.contentDigest,
        knowledgePageId: fixture.knowledgePageId,
        sourceRefs: [fixture.sourceReference],
      }),
    ]);
  });

  it('projects an accepted decision for receipt replay without repairing a missing page', () => {
    const fixture = createFixture('proposal-replay-projection');
    const accepted = decide(fixture, 'accepted', 'review-replay-projection');

    expect(
      fixture.store.projectKnowledgeProposalDecision(fixture.workspaceId, accepted.review.reviewId)
    ).toEqual(accepted);

    rmSync(fixture.pagePath);
    expectAuthorityFailure(
      () =>
        fixture.store.projectKnowledgeProposalDecision(
          fixture.workspaceId,
          accepted.review.reviewId
        ),
      'recovery_required'
    );
    expect(existsSync(fixture.pagePath)).toBe(false);
  });

  it('fails closed when the durable Review bytes contradict the accepted proposal', () => {
    const fixture = createFixture('proposal-review-tamper');
    const accepted = decide(fixture, 'accepted', 'review-tamper');
    const reviewFile = JSON.parse(readFileSync(fixture.reviewPath, 'utf8')) as {
      decisions: Array<{ proposalDigest: string }>;
    };
    reviewFile.decisions[0]!.proposalDigest = `sha256:${'0'.repeat(64)}`;
    writeFileSync(fixture.reviewPath, `${JSON.stringify(reviewFile, null, 2)}\n`);

    expectAuthorityFailure(
      () =>
        fixture.store.projectKnowledgeProposalDecision(
          fixture.workspaceId,
          accepted.review.reviewId
        ),
      'recovery_required'
    );
    expectAuthorityFailure(() => decide(fixture, 'accepted', 'review-tamper'), 'recovery_required');
    expectAuthorityFailure(
      () =>
        fixture.store.reverseKnowledgeProposalApplication({
          workspaceId: fixture.workspaceId,
          proposalId: fixture.proposal.id,
          reviewId: accepted.review.reviewId,
          knowledgePageId: fixture.knowledgePageId,
          expectedContentDigest: fixture.contentDigest,
        }),
      'recovery_required'
    );
    expect(readFileSync(fixture.pagePath, 'utf8')).toBe(fixture.canonicalPageBytes);
  });

  it('does not block publication for an unrelated unresolved conflict', () => {
    const fixture = createFixture('proposal-unrelated-conflict');
    fixture.store.recordKnowledgeConflict({
      id: 'kf_unrelated_proposal',
      workspaceId: fixture.workspaceId,
      subjectReferences: ['knowledge:unrelated-page'],
      sourceReferences: [fixture.sourceReference],
      status: 'needs_review',
      summary: 'This conflict concerns another page.',
      suggestedActions: ['Review the unrelated page.'],
      producer: 'proposal-authority-test',
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    });

    const accepted = decide(fixture, 'accepted', 'review-unrelated-conflict');

    expect(accepted.application?.present).toBe(true);
    expect(readFileSync(fixture.pagePath, 'utf8')).toBe(fixture.canonicalPageBytes);
  });

  it.each([
    {
      name: 'the target page',
      subjectReference: (fixture: ReturnType<typeof createFixture>) =>
        `knowledge:${fixture.knowledgePageId}`,
    },
    {
      name: 'one proposal source',
      subjectReference: (fixture: ReturnType<typeof createFixture>) => fixture.sourceReference,
    },
  ])('blocks publication while $name has an unresolved conflict', ({ name, subjectReference }) => {
    const fixture = createFixture(`proposal-unresolved-${name.replaceAll(' ', '-')}`);
    const conflictId = `kf_${name.replaceAll(' ', '_')}`;
    fixture.store.recordKnowledgeConflict({
      id: conflictId,
      workspaceId: fixture.workspaceId,
      subjectReferences: [subjectReference(fixture)],
      sourceReferences: [],
      status: 'needs_review',
      summary: `Resolve the conflict affecting ${name}.`,
      suggestedActions: ['Resolve before publication.'],
      producer: 'proposal-authority-test',
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    });

    expectAuthorityFailure(
      () => decide(fixture, 'accepted', `review-unresolved-${name.replaceAll(' ', '-')}`),
      'conflict'
    );
    expect(existsSync(fixture.reviewPath)).toBe(false);
    expect(existsSync(fixture.pagePath)).toBe(false);

    fixture.store.resolveKnowledgeConflict({
      workspaceId: fixture.workspaceId,
      conflictId,
      status: 'resolved',
      resolution: 'The conflicting evidence was reviewed.',
      resolvedBy: 'user_local',
      resolvedAt: DECIDED_AT,
    });
    const accepted = decide(fixture, 'accepted', `review-resolved-${name.replaceAll(' ', '-')}`);

    expect(accepted.application?.present).toBe(true);
    expect(readFileSync(fixture.pagePath, 'utf8')).toBe(fixture.canonicalPageBytes);
  });

  it.each([
    {
      name: 'a target that already exists',
      prepare: (fixture: ReturnType<typeof createFixture>) => {
        mkdirSync(dirname(fixture.pagePath), { recursive: true });
        writeFileSync(fixture.pagePath, fixture.canonicalPageBytes);
      },
      code: 'conflict' as const,
    },
    {
      name: 'a proposal whose fixed bytes were changed',
      prepare: (fixture: ReturnType<typeof createFixture>) =>
        writeFileSync(
          fixture.proposalPath,
          readFileSync(fixture.proposalPath, 'utf8').replace(
            'Keep proposal application',
            'Tampered proposal application'
          )
        ),
      code: 'recovery_required' as const,
    },
  ])('fails closed without a review or page mutation for $name', ({ prepare, code }) => {
    const fixture = createFixture(`proposal-fail-${code}`);
    prepare(fixture);

    expectAuthorityFailure(() => decide(fixture, 'accepted', `review-fail-${code}`), code);
    expect(existsSync(fixture.reviewPath)).toBe(false);
    if (code === 'conflict') {
      expect(readFileSync(fixture.pagePath, 'utf8')).toBe(fixture.canonicalPageBytes);
    } else {
      expect(existsSync(fixture.pagePath)).toBe(false);
    }
  });

  it('reverses only the unchanged proposal-created page and retains proposal and review evidence', () => {
    const fixture = createFixture('proposal-reversal');
    const accepted = decide(fixture, 'accepted', 'review-reversal');
    const reversalInput = {
      workspaceId: fixture.workspaceId,
      proposalId: fixture.proposal.id,
      reviewId: accepted.review.reviewId,
      knowledgePageId: fixture.knowledgePageId,
      expectedContentDigest: fixture.contentDigest,
    };
    const reversed = fixture.store.reverseKnowledgeProposalApplication(reversalInput);

    expect(reversed).toEqual({
      proposalId: fixture.proposal.id,
      reviewId: accepted.review.reviewId,
      application: {
        knowledgePageId: fixture.knowledgePageId,
        contentDigest: fixture.contentDigest,
        present: false,
      },
    });
    expect(existsSync(fixture.pagePath)).toBe(false);
    expect(existsSync(fixture.proposalPath)).toBe(true);
    expect(existsSync(fixture.reviewPath)).toBe(true);
    expect(fixture.store.projectKnowledgeProposalReversal(reversalInput)).toEqual(reversed);
  });

  it('permanently reserves a page id after one accepted proposal', () => {
    const fixture = createFixture('proposal-page-id-reservation');
    const replacement = fixture.store.createKnowledgeProposal({
      workspaceId: fixture.workspaceId,
      requestId: authorityRequestId('pending-replacement-proposal'),
      knowledgePageId: fixture.knowledgePageId,
      canonicalPageBytes: fixture.canonicalPageBytes,
      contentDigest: fixture.contentDigest,
      sourceReferences: [fixture.sourceReference],
      rationale: 'This pending proposal must not replace later accepted authority.',
      confidence: 0.9,
      verifiedExternalReferences: [],
      producer: PRODUCER,
      createdAt: CREATED_AT,
    });
    const accepted = decide(fixture, 'accepted', 'review-page-id-reservation');
    fixture.store.reverseKnowledgeProposalApplication({
      workspaceId: fixture.workspaceId,
      proposalId: fixture.proposal.id,
      reviewId: accepted.review.reviewId,
      knowledgePageId: fixture.knowledgePageId,
      expectedContentDigest: fixture.contentDigest,
    });

    expectAuthorityFailure(
      () =>
        fixture.store.recordKnowledgeProposalReviewDecision({
          workspaceId: fixture.workspaceId,
          proposalId: replacement.id,
          requestId: authorityRequestId('review-pending-replacement'),
          decision: 'accepted',
          verifiedExternalReferences: [],
          actor: REVIEWER,
          decidedAt: DECIDED_AT,
        }),
      'conflict'
    );
    expectAuthorityFailure(
      () =>
        fixture.store.createKnowledgeProposal({
          workspaceId: fixture.workspaceId,
          requestId: authorityRequestId('new-replacement-proposal'),
          knowledgePageId: fixture.knowledgePageId,
          canonicalPageBytes: fixture.canonicalPageBytes,
          contentDigest: fixture.contentDigest,
          sourceReferences: [fixture.sourceReference],
          rationale: 'A later proposal must select a new Page identity.',
          confidence: 0.9,
          verifiedExternalReferences: [],
          producer: PRODUCER,
          createdAt: CREATED_AT,
        }),
      'conflict'
    );
    expect(existsSync(fixture.pagePath)).toBe(false);
  });

  it('rejects a generated proposal that cites another accepted generated page', () => {
    const fixture = createFixture('proposal-generated-source');
    decide(fixture, 'accepted', 'review-generated-source');
    const generatedReference = `knowledge:${fixture.knowledgePageId}@${fixture.contentDigest}`;
    const dependentPageId = 'review/dependent-generated-page';
    const canonicalPageBytes = candidatePage(dependentPageId, generatedReference);

    expect(() =>
      fixture.store.createKnowledgeProposal({
        workspaceId: fixture.workspaceId,
        requestId: authorityRequestId('dependent-generated-proposal'),
        knowledgePageId: dependentPageId,
        canonicalPageBytes,
        contentDigest: digest(canonicalPageBytes),
        sourceReferences: [generatedReference],
        rationale: 'Generated pages cannot form a transitive proposal-authority graph.',
        confidence: 0.9,
        verifiedExternalReferences: [],
        producer: PRODUCER,
        createdAt: CREATED_AT,
      })
    ).toThrow(KnowledgePageValidationError);
  });

  it('allows a directly edited user-authored page as later proposal evidence', () => {
    const fixture = createFixture('proposal-edited-source');
    decide(fixture, 'accepted', 'review-edited-source');
    fixture.store.updateKnowledgeEntry(fixture.workspaceId, fixture.knowledgePageId, {
      content: 'A human now owns these edited and revalidated Page bytes.',
    });
    const editedPageBytes = readFileSync(fixture.pagePath, 'utf8');
    const editedReference = `knowledge:${fixture.knowledgePageId}@${digest(editedPageBytes)}`;
    const dependentPageId = 'review/dependent-user-authored-page';
    const canonicalPageBytes = candidatePage(dependentPageId, editedReference);

    expect(
      fixture.store.createKnowledgeProposal({
        workspaceId: fixture.workspaceId,
        requestId: authorityRequestId('dependent-user-authored-proposal'),
        knowledgePageId: dependentPageId,
        canonicalPageBytes,
        contentDigest: digest(canonicalPageBytes),
        sourceReferences: [editedReference],
        rationale: 'The current directly edited Page is user-authored evidence.',
        confidence: 0.9,
        verifiedExternalReferences: [],
        producer: PRODUCER,
        createdAt: CREATED_AT,
      })
    ).toMatchObject({ knowledgePageId: dependentPageId });
  });

  it('does not erase a byte-only page edit before enforcing unchanged-page reversal', () => {
    const fixture = createFixture('proposal-byte-only-edit');
    const accepted = decide(fixture, 'accepted', 'review-byte-only-edit');
    writeFileSync(
      fixture.pagePath,
      fixture.canonicalPageBytes.replace(
        'title: "Review authority lesson"',
        'title: "Review authority lesson"\nmanual_note: "preserve this edit"'
      )
    );

    const restarted = new FsStore({ dataRoot: fixture.dataRoot });
    restarted.updateWorkspace(fixture.workspaceId, { name: 'Persist unrelated workspace change' });

    expectAuthorityFailure(
      () =>
        restarted.reverseKnowledgeProposalApplication({
          workspaceId: fixture.workspaceId,
          proposalId: fixture.proposal.id,
          reviewId: accepted.review.reviewId,
          knowledgePageId: fixture.knowledgePageId,
          expectedContentDigest: fixture.contentDigest,
        }),
      'conflict'
    );
  });

  it.each([
    {
      name: 'changed page bytes',
      prepare: (fixture: ReturnType<typeof createFixture>) =>
        writeFileSync(fixture.pagePath, `${fixture.canonicalPageBytes}\nchanged\n`),
      code: 'conflict' as const,
    },
    {
      name: 'a missing page without completed reversal evidence',
      prepare: (fixture: ReturnType<typeof createFixture>) => rmSync(fixture.pagePath),
      code: 'recovery_required' as const,
    },
  ])('fails closed when reversal sees $name', ({ prepare, code }) => {
    const fixture = createFixture(`proposal-reversal-${code}`);
    const accepted = decide(fixture, 'accepted', `review-reversal-${code}`);
    prepare(fixture);

    expectAuthorityFailure(
      () =>
        fixture.store.reverseKnowledgeProposalApplication({
          workspaceId: fixture.workspaceId,
          proposalId: fixture.proposal.id,
          reviewId: accepted.review.reviewId,
          knowledgePageId: fixture.knowledgePageId,
          expectedContentDigest: fixture.contentDigest,
        }),
      code
    );
    if (code === 'conflict') {
      expect(readFileSync(fixture.pagePath, 'utf8')).toBe(
        `${fixture.canonicalPageBytes}\nchanged\n`
      );
    } else {
      expect(existsSync(fixture.pagePath)).toBe(false);
    }
  });
});

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ApiErrorSchema, deriveEntityId } from '@openkit/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';

import { KnowledgeNotebook } from '../knowledge/notebook.js';
import { KnowledgePageValidationError } from '../knowledge/okf.js';
import { FsStore } from '../lib/store.js';
import { createApp } from '../test-support/app.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { openCoreDb } from './db.js';
import {
  assertKnowledgeRetrievalTraceReadable,
  resolveWorkspaceKnowledgeRetrievalPages,
  retrieveWorkspaceKnowledge,
} from './index-rebuild.js';
import { applyMigrations } from './migrate.js';

const CREATED_AT = '2026-07-12T00:00:00.000Z';
const DECIDED_AT = '2026-07-12T01:00:00.000Z';
const PRODUCER = {
  kind: 'agent',
  id: 'agent_knowledge',
  responsibleUserId: FIXTURE_LOCAL_USER_ID,
} as const;
const REVIEWER = { kind: 'user', id: FIXTURE_LOCAL_USER_ID } as const;
type Proposal = ReturnType<FsStore['createKnowledgeProposal']>;

/** Hashes exact retained bytes independently of the Proposal reader. */
function digest(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

/** Derives one deterministic command UUID from a readable fixture label. */
function authorityRequestId(label: string): string {
  const suffix = createHash('sha256').update(label, 'utf8').digest('hex').slice(0, 12);
  return `00000000-0000-4000-8000-${suffix}`;
}

/** Authors the current exact owner profile; accepted bytes still require a real human Review. */
function candidatePage(
  workspaceId: string,
  knowledgePageId: string,
  sourceReference: string,
  includeStandardStatus = true
): string {
  return [
    '---',
    'type: "KnowledgePage"',
    'title: "Review authority lesson"',
    'openkit_entry_kind: "project-context"',
    `openkit_entry_id: ${JSON.stringify(knowledgePageId)}`,
    'schema_version: "openkit-scope-knowledge-schema-v4"',
    'requiredFeatures: [openkit.knowledge-owner-scope.v1, openkit.knowledge-git-notebook.v1]',
    'openkit_status: "active"',
    ...(includeStandardStatus ? ['status: "stable"'] : []),
    `scope: ${JSON.stringify({ kind: 'workspace', workspaceId })}`,
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

/** Creates fresh real Git and current Core membership; no standalone page mutation is admitted. */
function createOwners() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-proposal-authority-'));
  const coreDb = openCoreDb(dataRoot);
  onTestFinished(() => {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspaceId = store.createWorkspace('Knowledge proposal authority').id;
  recordWorkspaceOwnerMembership({ coreDb, workspaceId, ownerUserId: FIXTURE_LOCAL_USER_ID });
  const workspaceRoot = join(dataRoot, 'workspaces', workspaceId);
  const repositoryPath = join(workspaceRoot, 'knowledge', 'notebook.git');
  return {
    dataRoot,
    coreDb,
    store,
    workspaceId,
    workspaceRoot,
    repositoryPath,
    notebook: new KnowledgeNotebook({ repositoryPath }),
    app: createApp({ coreDb, dataRoot, store }),
  };
}
type Owners = ReturnType<typeof createOwners>;

/** Calls the actual native operation and preserves its failure code and status for refusal assertions. */
async function call(f: Owners, operation: string, input: Record<string, unknown>) {
  const { requestId, ...body } = input;
  const response = await f.app.request(`/api/app/operations/${operation}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(requestId ? { 'x-openkit-request-id': String(requestId) } : {}),
    },
    body: JSON.stringify({ workspaceId: f.workspaceId, ...body }),
  });
  const result = await response.json();
  if (response.status !== 200) {
    const failure = ApiErrorSchema.parse(result);
    throw Object.assign(new Error(failure.message), failure, { status: response.status });
  }
  return result;
}

/** Reads exact bytes from the published tree, independent of materialized projections. */
function currentPage(f: Owners, id: string) {
  return f.notebook.readRevision(f.notebook.publishedRevision()).files[`${id}.md`];
}

/** Drafts through the existing Proposal owner against the actual current Git base. */
function draft(
  f: Owners,
  sourceReference: string,
  label: string,
  id: string,
  includeStatus = true
) {
  const canonicalPageBytes = candidatePage(f.workspaceId, id, sourceReference, includeStatus);
  return f.store.createKnowledgeProposal({
    workspaceId: f.workspaceId,
    requestId: authorityRequestId(label),
    baseRevision: f.notebook.publishedRevision(),
    knowledgePageId: id,
    canonicalPageBytes,
    contentDigest: digest(canonicalPageBytes),
    sourceReferences: [sourceReference],
    rationale: 'This bounded rule is supported by the cited Workspace evidence.',
    confidence: 0.9,
    verifiedExternalReferences: [],
    producer: PRODUCER,
    createdAt: CREATED_AT,
  });
}

/** Publishes genuine human evidence, then retains a fixed-base Agent candidate for human Review. */
async function createFixture(label = 'proposal-authority-draft', includeStatus = true) {
  const f = createOwners();
  const source = await call(f, 'knowledge.create', {
    requestId: authorityRequestId('human-source'),
    baseRevision: f.notebook.publishedRevision(),
    knowledgePageId: 'evidence/human-review',
    kind: 'project-context',
    title: 'Existing review evidence',
    content: 'A human Review is the only activation authority.',
    sourceReferences: [],
  });
  const sourceReference = `knowledge:${source.id}@${digest(currentPage(f, source.id)!)}`;
  const knowledgePageId = 'review/review-authority-lesson';
  const proposal = draft(f, sourceReference, label, knowledgePageId, includeStatus);
  return {
    ...f,
    proposal,
    knowledgePageId,
    sourceReference,
    canonicalPageBytes: proposal.canonicalPageBytes,
    contentDigest: proposal.contentDigest,
    proposalPath: join(f.workspaceRoot, 'knowledge', 'proposals', `${proposal.id}.md`),
    reviewPath: join(f.workspaceRoot, 'knowledge', 'reviews', `${proposal.id}.json`),
  };
}
type Fixture = Awaited<ReturnType<typeof createFixture>>;

/** Binds every human decision to the exact immutable Proposal document, base and candidate. */
function decisionInput(f: Owners, proposal: Proposal, decision: string, label: string) {
  return {
    requestId: authorityRequestId(label),
    proposalId: proposal.id,
    decision,
    proposalDigest: digest(
      readFileSync(join(f.workspaceRoot, 'knowledge', 'proposals', `${proposal.id}.md`), 'utf8')
    ),
    baseRevision: proposal.baseRevision,
    candidateRevision: proposal.candidateRevision,
  };
}

/** Uses the actual Review operation and shared publisher, including ordinary command receipts. */
function decide(f: Fixture, decision: 'accepted' | 'deferred' | 'rejected', label: string) {
  return call(f, 'knowledge.proposal.decide', decisionInput(f, f.proposal, decision, label));
}

/** Reverses through the common fixed-base publisher with exact human removal confirmation. */
function reverse(
  f: Fixture,
  reviewId: string,
  label = 'reverse',
  baseRevision = f.notebook.publishedRevision()
) {
  return call(f, 'knowledge.proposal.reverse', {
    requestId: authorityRequestId(label),
    proposalId: f.proposal.id,
    reviewId,
    knowledgePageId: f.knowledgePageId,
    expectedContentDigest: f.contentDigest,
    baseRevision,
    confirmRemoval: true,
  });
}

/** Applies an explicit direct human edit through the same production Notebook publisher. */
function edit(f: Owners, id: string, bytes: string, label: string) {
  return call(f, 'knowledge.notebook.update', {
    requestId: authorityRequestId(label),
    baseRevision: f.notebook.publishedRevision(),
    changes: [{ path: `${id}.md`, content: bytes }],
    summary: 'Explicit human edit',
  });
}

/** Observes Git directly; fixture corruption tests remove exactly one real loose page object. */
function removeCandidateBlob(f: Fixture) {
  const oid = execFileSync(
    'git',
    [
      '--git-dir',
      f.repositoryPath,
      'rev-parse',
      `${f.proposal.candidateRevision}:pages/${f.knowledgePageId}.md`,
    ],
    { encoding: 'utf8' }
  ).trim();
  const path = join(f.repositoryPath, 'objects', oid.slice(0, 2), oid.slice(2));
  expect(existsSync(path)).toBe(true);
  rmSync(path);
  return path;
}

/** Requires a named authority failure for both synchronous readers and native async operations. */
async function expectAuthorityFailure(
  action: () => unknown,
  code: 'conflict' | 'recovery_required'
) {
  await expect(Promise.resolve().then(action)).rejects.toMatchObject({ code });
}

/** Supplies real current caller identity and membership for retrieval and source-audience checks. */
function access(f: Owners) {
  return {
    coreDb: f.coreDb,
    store: f.store,
    actor: REVIEWER,
    requestActor: { kind: 'local', userId: FIXTURE_LOCAL_USER_ID } as const,
  };
}

/** Records the existing conflict owner without changing Proposal or published page bytes. */
function conflict(f: Fixture, subject: string, label: string) {
  const id = testEntityId('kf', label);
  f.store.recordKnowledgeConflict({
    id,
    workspaceId: f.workspaceId,
    subjectReferences: [subject],
    sourceReferences: [],
    status: 'needs_review',
    summary: 'Resolve conflicting evidence before publication.',
    suggestedActions: ['Review the conflicting evidence.'],
    producer: 'proposal-authority-test',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  return id;
}

describe('knowledge proposal authority', () => {
  it('derives deterministic ids and freezes the exact owner, base, candidate and byte tuple', async () => {
    const f = await createFixture();
    const bytes = readFileSync(f.proposalPath, 'utf8');
    expect(f.proposal).toMatchObject({
      id: `kp_${createHash('sha256')
        .update(
          JSON.stringify({
            workspaceId: f.workspaceId,
            requestId: authorityRequestId('proposal-authority-draft'),
          })
        )
        .digest('hex')}`,
      ownerScope: { kind: 'workspace', workspaceId: f.workspaceId },
      operation: 'notebook-change',
      baseRevision: f.notebook.publishedRevision(),
      knowledgePageId: f.knowledgePageId,
      canonicalPageBytes: f.canonicalPageBytes,
      contentDigest: f.contentDigest,
      sourceReferences: [f.sourceReference],
      producer: PRODUCER,
    });
    expect(f.proposal.candidateRevision).not.toBe(f.proposal.baseRevision);
    expect(
      f.notebook.readRevision(f.proposal.candidateRevision).files[`${f.knowledgePageId}.md`]
    ).toBe(f.canonicalPageBytes);
    expect(currentPage(f, f.knowledgePageId)).toBeUndefined();
    expect(bytes.endsWith(f.canonicalPageBytes)).toBe(true);
    expect(bytes.slice(0, bytes.indexOf('\n---\n', 4))).not.toMatch(/^status:/m);
  });

  it.each([
    'changed',
    'missing',
  ] as const)('rejects draft and native acceptance when registered source bytes are %s', async (name) => {
    const f = createOwners();
    const sourceContent = 'Captured source bytes remain immutable evidence.\n';
    const source = await call(f, 'knowledge.source.register', {
      requestId: authorityRequestId('register-source'),
      kind: 'document',
      title: 'Captured proposal evidence',
      content: sourceContent,
    });
    expect(source.source.contentDigest).toBe(digest(sourceContent));
    const sourceReference = `source:${source.source.id}@${digest(sourceContent)}`;
    const proposal = draft(
      f,
      sourceReference,
      `source-valid-before-${name}`,
      `source/accepted-before-${name}`
    );
    const path = join(f.workspaceRoot, 'sources', 'materials', source.source.id, 'content.txt');
    if (name === 'changed') writeFileSync(path, 'Changed captured source bytes.\n');
    else rmSync(path);
    expect(() => draft(f, sourceReference, `source-${name}-draft`, `source/${name}-draft`)).toThrow(
      KnowledgePageValidationError
    );
    expect(f.store.listKnowledgeProposals(f.workspaceId).map((value) => value.id)).toEqual([
      proposal.id,
    ]);
    const before = f.notebook.publishedRevision();
    await expect(
      call(f, 'knowledge.proposal.decide', decisionInput(f, proposal, 'accepted', `review-${name}`))
    ).rejects.toMatchObject({ code: 'recovery_required', status: 409 });
    expect(f.notebook.publishedRevision()).toBe(before);
    expect(f.store.listKnowledgeProposalReviewDecisions(f.workspaceId)).toHaveLength(0);
    expect(currentPage(f, proposal.knowledgePageId)).toBeUndefined();
  });

  it.each([
    'accepted',
    'rejected',
  ] as const)('appends defer then %s with exact binding and rejects post-terminal decisions', async (terminalDecision) => {
    const f = await createFixture(`proposal-${terminalDecision}`);
    const deferred = await decide(f, 'deferred', `review-defer-${terminalDecision}`);
    const terminal = await decide(f, terminalDecision, `review-terminal-${terminalDecision}`);
    const decisions = f.store.listKnowledgeProposalReviewDecisions(f.workspaceId);
    for (const [response, decision, label] of [
      [deferred, 'deferred', `review-defer-${terminalDecision}`],
      [terminal, terminalDecision, `review-terminal-${terminalDecision}`],
    ] as const) {
      expect(response.review).toEqual({
        reviewId: deriveEntityId('kr', {
          ownerScope: f.proposal.ownerScope,
          proposalId: f.proposal.id,
          requestId: authorityRequestId(label),
        }),
        proposalId: f.proposal.id,
        workspaceId: f.workspaceId,
        ownerScope: f.proposal.ownerScope,
        baseRevision: f.proposal.baseRevision,
        candidateRevision: f.proposal.candidateRevision,
        requestId: authorityRequestId(label),
        decision,
        actor: REVIEWER,
        proposalDigest: digest(readFileSync(f.proposalPath, 'utf8')),
        knowledgePageId: f.knowledgePageId,
        contentDigest: f.contentDigest,
        targetAbsentAtDecision: decision === 'accepted' ? true : null,
        decidedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
    }
    expect(decisions).toEqual([deferred.review, terminal.review]);
    expect(JSON.parse(readFileSync(f.reviewPath, 'utf8'))).toEqual({
      proposalId: f.proposal.id,
      workspaceId: f.workspaceId,
      decisions,
    });
    expect(deferred.application).toBeNull();
    expect(f.notebook.retainedCandidate(f.proposal.id).revision).toBe(f.proposal.candidateRevision);
    if (terminalDecision === 'rejected') {
      expect(terminal.application).toBeNull();
      expect(currentPage(f, f.knowledgePageId)).toBeUndefined();
    }
    await expectAuthorityFailure(
      () => decide(f, 'deferred', `review-after-${terminalDecision}`),
      'conflict'
    );
    expect(f.store.listKnowledgeProposalReviewDecisions(f.workspaceId)).toEqual(decisions);
  });

  it('publishes exact accepted bytes and replays the named commit without resurrecting a reversed page', async () => {
    const f = await createFixture('proposal-accepted-page');
    const first = await decide(f, 'accepted', 'review-accepted-page');
    expect(first.application).toEqual({
      knowledgePageId: f.knowledgePageId,
      contentDigest: f.contentDigest,
      present: true,
      notebookRevision: f.proposal.candidateRevision,
    });
    expect(currentPage(f, f.knowledgePageId)).toBe(f.canonicalPageBytes);
    const reversed = await reverse(f, first.review.reviewId);
    conflict(f, `knowledge:${f.knowledgePageId}`, 'post-completion-conflict');
    f.store = new FsStore({ dataRoot: f.dataRoot });
    f.app = createApp({ coreDb: f.coreDb, dataRoot: f.dataRoot, store: f.store });
    expect(await decide(f, 'accepted', 'review-accepted-page')).toEqual(first);
    expect(f.notebook.publishedRevision()).toBe(reversed.application.notebookRevision);
    expect(currentPage(f, f.knowledgePageId)).toBeUndefined();
    expect(f.store.listKnowledgeProposalReviewDecisions(f.workspaceId)).toHaveLength(1);
  });

  it('accepts missing standard status as the effective stable projection without rewriting bytes', async () => {
    const f = await createFixture('proposal-effective-stable-status', false);
    expect(
      (await decide(f, 'accepted', 'review-effective-stable-status')).application?.present
    ).toBe(true);
    expect(currentPage(f, f.knowledgePageId)).toBe(f.canonicalPageBytes);
    expect(f.canonicalPageBytes).not.toContain('\nstatus:');
  });

  it('retrieves the published accepted hierarchy and excludes an unpublished copied candidate', async () => {
    const f = await createFixture('proposal-retrieval-proof');
    await decide(f, 'accepted', 'review-retrieval-proof');
    const copiedPageId = 'review/copied-authority-lesson';
    const copied = draft(f, f.sourceReference, 'copied-unpublished', copiedPageId);
    const retrieval = await retrieveWorkspaceKnowledge({
      caller: 'app-api',
      dataRoot: f.dataRoot,
      limit: 1,
      pinnedReferences: [{ scopeId: `page/workspace/${f.workspaceId}`, objectId: copiedPageId }],
      query: 'Review authority lesson',
      access: access(f),
      workspaceId: f.workspaceId,
      now: () => DECIDED_AT,
    });
    expect(retrieval.selected).toEqual([
      expect.objectContaining({
        contentDigest: f.contentDigest,
        reference: { scopeId: `page/workspace/${f.workspaceId}`, objectId: f.knowledgePageId },
        revision: f.proposal.candidateRevision,
        sourceReferences: [f.sourceReference],
      }),
    ]);
    expect(
      [...retrieval.selected, ...retrieval.excluded].map((item) => item.reference.objectId)
    ).not.toContain(copiedPageId);
    expect(f.notebook.readRevision(copied.candidateRevision).files[`${copiedPageId}.md`]).toBe(
      copied.canonicalPageBytes
    );
    expect(retrieval).not.toHaveProperty('retrievalTraceRef');
    expect(
      resolveWorkspaceKnowledgeRetrievalPages({
        caller: 'app-api',
        dataRoot: f.dataRoot,
        access: access(f),
        selection: retrieval,
        workspaceId: f.workspaceId,
      })
    ).toEqual([
      expect.objectContaining({
        content: f.canonicalPageBytes,
        contentDigest: f.contentDigest,
        knowledgePageId: f.knowledgePageId,
        notebookRevision: f.proposal.candidateRevision,
        sourceRefs: [f.sourceReference],
      }),
    ]);
  });

  it('rejects arbitrary stored work-history references without disclosing their identity', async () => {
    const f = await createFixture('proposal-trace-source-proof');
    await decide(f, 'accepted', 'review-trace-source-proof');
    const thread = f.store.createThread(f.workspaceId, 'Trace source authority');
    const caller = { ...access(f), outputThreadId: thread.id };
    const traceId = testEntityId('krt', 'trace-source-authority');
    const retrieval = await retrieveWorkspaceKnowledge({
      access: caller,
      caller: 'task-mode',
      dataRoot: f.dataRoot,
      pinnedReferences: [
        { scopeId: `page/workspace/${f.workspaceId}`, objectId: f.knowledgePageId },
      ],
      query: 'Review authority lesson',
      traceId,
      workspaceId: f.workspaceId,
      now: () => DECIDED_AT,
    });
    const retrievalTraceRef = retrieval.retrievalTraceRef;
    expect(retrievalTraceRef).toEqual({
      scopeId: `retrieval-trace/thread/${f.workspaceId}/${thread.id}`,
      objectId: traceId,
    });
    if (!retrievalTraceRef) throw new Error('Retrieval trace fixture is missing.');
    const tracePath = join(
      f.workspaceRoot,
      'threads',
      thread.id,
      'retrieval-traces',
      `${traceId}.json`
    );
    const trace = JSON.parse(readFileSync(tracePath, 'utf8'));
    const unavailableTurnId = testEntityId('tu', 'unavailable-private-history');
    const arbitraryReferences = [
      `turn:${unavailableTurnId}`,
      `item:${testEntityId('it', 'unavailable-private-final')}`,
      `context-package:${unavailableTurnId}@ctxpkg_sha256_${'b'.repeat(64)}`,
    ];
    trace.selected[0].sourceReferences = [f.sourceReference, ...arbitraryReferences];
    writeFileSync(tracePath, JSON.stringify(trace));
    let failure: unknown;
    try {
      assertKnowledgeRetrievalTraceReadable({
        access: caller,
        dataRoot: f.dataRoot,
        retrievalTraceRef,
        workspaceId: f.workspaceId,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'workspace_access_denied',
      message: 'Knowledge trace or source is unavailable.',
      status: 403,
    });
    for (const reference of arbitraryReferences)
      expect(JSON.stringify(failure)).not.toContain(reference);
    expect(currentPage(f, f.knowledgePageId)).toBe(f.canonicalPageBytes);
  });

  it('projects receipt replay without repairing a missing immutable Git object', async () => {
    const f = await createFixture('proposal-replay-projection');
    const accepted = await decide(f, 'accepted', 'review-replay-projection');
    expect(
      f.store.projectKnowledgeProposalDecision(f.workspaceId, accepted.review.reviewId)
    ).toEqual(accepted);
    const before = f.notebook.publishedRevision();
    const missingObject = removeCandidateBlob(f);
    await expectAuthorityFailure(
      () => f.store.projectKnowledgeProposalDecision(f.workspaceId, accepted.review.reviewId),
      'recovery_required'
    );
    await expectAuthorityFailure(
      () => decide(f, 'accepted', 'review-replay-projection'),
      'recovery_required'
    );
    expect(existsSync(missingObject)).toBe(false);
    expect(f.notebook.publishedRevision()).toBe(before);
    expect(f.store.listKnowledgeProposalReviewDecisions(f.workspaceId)).toHaveLength(1);
  });

  it('projects annotated retained Reviews but refuses changed ordered decision core', async () => {
    const f = await createFixture('proposal-annotated-review');
    const deferred = await decide(f, 'deferred', 'review-annotated-deferred');
    const accepted = await decide(f, 'accepted', 'review-annotated-accepted');
    expect(accepted.review.proposalDigest).toBe(digest(readFileSync(f.proposalPath, 'utf8')));
    expect(accepted.review.proposalDigest).not.toBe(f.contentDigest);
    const retained = JSON.parse(readFileSync(f.reviewPath, 'utf8'));
    retained.futureNote = 'Retained Review description';
    for (const review of retained.decisions) {
      review.futureNote = 'Retained decision description';
      review.actor.futureNote = 'Retained attribution description';
    }
    const annotatedBytes = `${JSON.stringify(retained, null, 2)}\n`;
    writeFileSync(f.reviewPath, annotatedBytes);
    f.store = new FsStore({ dataRoot: f.dataRoot });
    f.app = createApp({ coreDb: f.coreDb, dataRoot: f.dataRoot, store: f.store });
    expect(
      f.store.projectKnowledgeProposalDecision(f.workspaceId, deferred.review.reviewId)
    ).toEqual(deferred);
    expect(
      f.store.projectKnowledgeProposalDecision(f.workspaceId, accepted.review.reviewId)
    ).toEqual(accepted);
    expect(await decide(f, 'accepted', 'review-annotated-accepted')).toEqual(accepted);
    expect(readFileSync(f.reviewPath, 'utf8')).toBe(annotatedBytes);
    for (const [key, value] of [
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
    ] as const) {
      const changed = JSON.parse(annotatedBytes);
      changed.decisions[1][key] = value;
      writeFileSync(f.reviewPath, `${JSON.stringify(changed, null, 2)}\n`);
      await expectAuthorityFailure(
        () => f.store.projectKnowledgeProposalDecision(f.workspaceId, accepted.review.reviewId),
        'recovery_required'
      );
      await expectAuthorityFailure(
        () => decide(f, 'accepted', 'review-annotated-accepted'),
        'recovery_required'
      );
      expect(currentPage(f, f.knowledgePageId)).toBe(f.canonicalPageBytes);
    }
    retained.decisions.reverse();
    writeFileSync(f.reviewPath, `${JSON.stringify(retained, null, 2)}\n`);
    await expectAuthorityFailure(
      () => f.store.projectKnowledgeProposalDecision(f.workspaceId, accepted.review.reviewId),
      'recovery_required'
    );
  });

  it('fails closed when durable Review bytes contradict the accepted proposal', async () => {
    const f = await createFixture('proposal-review-tamper');
    const accepted = await decide(f, 'accepted', 'review-tamper');
    const reviewFile = JSON.parse(readFileSync(f.reviewPath, 'utf8'));
    reviewFile.decisions[0].proposalDigest = `sha256:${'0'.repeat(64)}`;
    writeFileSync(f.reviewPath, `${JSON.stringify(reviewFile, null, 2)}\n`);
    await expectAuthorityFailure(
      () => f.store.projectKnowledgeProposalDecision(f.workspaceId, accepted.review.reviewId),
      'recovery_required'
    );
    await expectAuthorityFailure(() => decide(f, 'accepted', 'review-tamper'), 'recovery_required');
    await expectAuthorityFailure(() => reverse(f, accepted.review.reviewId), 'recovery_required');
    expect(currentPage(f, f.knowledgePageId)).toBe(f.canonicalPageBytes);
  });

  it('does not block publication for an unrelated unresolved conflict', async () => {
    const f = await createFixture('proposal-unrelated-conflict');
    conflict(f, 'knowledge:unrelated-page', 'unrelated-conflict');
    expect((await decide(f, 'accepted', 'review-unrelated-conflict')).application?.present).toBe(
      true
    );
    expect(currentPage(f, f.knowledgePageId)).toBe(f.canonicalPageBytes);
  });

  it.each([
    'target',
    'source',
  ] as const)('blocks publication while the %s has an unresolved conflict', async (subject) => {
    const f = await createFixture(`proposal-unresolved-${subject}`);
    const id = conflict(
      f,
      subject === 'target' ? `knowledge:${f.knowledgePageId}` : f.sourceReference,
      `conflict-${subject}`
    );
    const before = f.notebook.publishedRevision();
    await expectAuthorityFailure(
      () => decide(f, 'accepted', `review-unresolved-${subject}`),
      'conflict'
    );
    expect(existsSync(f.reviewPath)).toBe(false);
    expect(currentPage(f, f.knowledgePageId)).toBeUndefined();
    expect(f.notebook.publishedRevision()).toBe(before);
    f.store.resolveKnowledgeConflict({
      workspaceId: f.workspaceId,
      conflictId: id,
      status: 'resolved',
      resolution: 'The conflicting evidence was reviewed.',
      resolvedBy: FIXTURE_LOCAL_USER_ID,
      resolvedAt: DECIDED_AT,
    });
    expect((await decide(f, 'accepted', `review-resolved-${subject}`)).application?.present).toBe(
      true
    );
    expect(currentPage(f, f.knowledgePageId)).toBe(f.canonicalPageBytes);
  });

  it.each([
    'existing-target',
    'tampered-proposal',
  ] as const)('refuses without Review or page mutation for %s', async (kind) => {
    const f = await createFixture(`proposal-fail-${kind}`);
    let existing: string | undefined;
    if (kind === 'existing-target') {
      const published = await edit(
        f,
        f.knowledgePageId,
        f.canonicalPageBytes,
        'human-target-winner'
      );
      expect(published.notebookRevision).not.toBe(f.proposal.baseRevision);
      existing = currentPage(f, f.knowledgePageId);
    } else
      writeFileSync(
        f.proposalPath,
        readFileSync(f.proposalPath, 'utf8').replace(
          'Keep proposal application',
          'Tampered proposal application'
        )
      );
    const before = f.notebook.publishedRevision();
    await expectAuthorityFailure(
      () => decide(f, 'accepted', `review-fail-${kind}`),
      kind === 'existing-target' ? 'conflict' : 'recovery_required'
    );
    expect(existsSync(f.reviewPath)).toBe(false);
    expect(f.notebook.publishedRevision()).toBe(before);
    expect(currentPage(f, f.knowledgePageId)).toBe(existing);
  });

  it('reverses unchanged accepted bytes in a new commit and retains original Proposal and Review evidence', async () => {
    const f = await createFixture('proposal-reversal');
    const accepted = await decide(f, 'accepted', 'review-reversal');
    const proposalBytes = readFileSync(f.proposalPath, 'utf8');
    const reviewBytes = readFileSync(f.reviewPath, 'utf8');
    const reversed = await reverse(f, accepted.review.reviewId);
    expect(reversed).toEqual({
      proposalId: f.proposal.id,
      reviewId: accepted.review.reviewId,
      application: {
        knowledgePageId: f.knowledgePageId,
        contentDigest: f.contentDigest,
        present: false,
        notebookRevision: f.notebook.publishedRevision(),
      },
    });
    expect(reversed.application.notebookRevision).not.toBe(f.proposal.candidateRevision);
    expect(
      await reverse(f, accepted.review.reviewId, 'reverse', f.proposal.candidateRevision)
    ).toEqual(reversed);
    expect(f.notebook.publishedRevision()).toBe(reversed.application.notebookRevision);
    expect(currentPage(f, f.knowledgePageId)).toBeUndefined();
    expect(
      f.notebook.readRevision(f.proposal.candidateRevision).files[`${f.knowledgePageId}.md`]
    ).toBe(f.canonicalPageBytes);
    expect(readFileSync(f.proposalPath, 'utf8')).toBe(proposalBytes);
    expect(readFileSync(f.reviewPath, 'utf8')).toBe(reviewBytes);
    expect(
      f.store.projectKnowledgeProposalDecision(f.workspaceId, accepted.review.reviewId)
    ).toEqual(accepted);
  });

  it('refuses stale pending authority after reversal but permits a new proposal at the current base', async () => {
    const f = await createFixture('proposal-page-id-reuse');
    const pending = draft(f, f.sourceReference, 'pending-replacement', f.knowledgePageId);
    const accepted = await decide(f, 'accepted', 'review-page-id-reuse');
    await reverse(f, accepted.review.reviewId);
    await expectAuthorityFailure(
      () =>
        call(
          f,
          'knowledge.proposal.decide',
          decisionInput(f, pending, 'accepted', 'review-stale-pending')
        ),
      'conflict'
    );
    expect(f.store.getKnowledgeProposalReviewDecision(pending.id)).toBeNull();
    expect(currentPage(f, f.knowledgePageId)).toBeUndefined();
    const replacement = draft(f, f.sourceReference, 'fresh-replacement', f.knowledgePageId);
    expect(replacement.baseRevision).toBe(f.notebook.publishedRevision());
    expect(replacement.id).not.toBe(f.proposal.id);
    const reviewed = await call(
      f,
      'knowledge.proposal.decide',
      decisionInput(f, replacement, 'accepted', 'review-fresh-replacement')
    );
    expect(reviewed.application.notebookRevision).toBe(replacement.candidateRevision);
    expect(currentPage(f, f.knowledgePageId)).toBe(replacement.canonicalPageBytes);
    expect(
      f.store.projectKnowledgeProposalDecision(f.workspaceId, accepted.review.reviewId)
    ).toEqual(accepted);
  });

  it('rejects a generated proposal that cites another accepted generated page', async () => {
    const f = await createFixture('proposal-generated-source');
    await decide(f, 'accepted', 'review-generated-source');
    const reference = `knowledge:${f.knowledgePageId}@${f.contentDigest}`;
    expect(() =>
      draft(f, reference, 'dependent-generated-proposal', 'review/dependent-generated-page')
    ).toThrow(KnowledgePageValidationError);
  });

  it('allows a directly edited user-authored page as later proposal evidence', async () => {
    const f = await createFixture('proposal-edited-source');
    await decide(f, 'accepted', 'review-edited-source');
    await call(f, 'knowledge.update', {
      requestId: authorityRequestId('human-revalidation'),
      baseRevision: f.notebook.publishedRevision(),
      knowledgeEntryId: f.knowledgePageId,
      content: 'A human now owns these edited and revalidated Page bytes.',
    });
    const bytes = currentPage(f, f.knowledgePageId)!;
    expect(bytes).toContain('review_state: "user-authored"');
    expect(
      draft(
        f,
        `knowledge:${f.knowledgePageId}@${digest(bytes)}`,
        'dependent-user-authored-proposal',
        'review/dependent-user-authored-page'
      )
    ).toMatchObject({ knowledgePageId: 'review/dependent-user-authored-page' });
  });

  it('preserves a byte-only human page edit across restart and refuses unchanged-page reversal', async () => {
    const f = await createFixture('proposal-byte-only-edit');
    const accepted = await decide(f, 'accepted', 'review-byte-only-edit');
    await edit(
      f,
      f.knowledgePageId,
      f.canonicalPageBytes.replace(
        'title: "Review authority lesson"',
        'title: "Review authority lesson"\nmanual_note: "preserve this edit"'
      ),
      'byte-only-edit'
    );
    const edited = currentPage(f, f.knowledgePageId);
    expect(edited).toContain('manual_note: "preserve this edit"');
    f.store = new FsStore({ dataRoot: f.dataRoot });
    f.store.updateWorkspace(f.workspaceId, { name: 'Persist unrelated workspace change' });
    f.app = createApp({ coreDb: f.coreDb, dataRoot: f.dataRoot, store: f.store });
    await expectAuthorityFailure(() => reverse(f, accepted.review.reviewId), 'conflict');
    expect(currentPage(f, f.knowledgePageId)).toBe(edited);
  });

  it.each([
    'changed page bytes',
    'missing immutable page object',
  ] as const)('fails closed when reversal sees %s', async (kind) => {
    const f = await createFixture(`proposal-reversal-${kind}`);
    const accepted = await decide(f, 'accepted', `review-reversal-${kind}`);
    let edited: string | undefined;
    let missing: string | undefined;
    if (kind === 'changed page bytes') {
      await edit(f, f.knowledgePageId, `${f.canonicalPageBytes}\nchanged\n`, 'human-changed-page');
      edited = currentPage(f, f.knowledgePageId);
    } else missing = removeCandidateBlob(f);
    const before = f.notebook.publishedRevision();
    await expectAuthorityFailure(
      () => reverse(f, accepted.review.reviewId),
      kind === 'changed page bytes' ? 'conflict' : 'recovery_required'
    );
    expect(f.notebook.publishedRevision()).toBe(before);
    if (missing) expect(existsSync(missing)).toBe(false);
    else expect(currentPage(f, f.knowledgePageId)).toBe(edited);
    expect(f.store.listKnowledgeProposalReviewDecisions(f.workspaceId)).toHaveLength(1);
  });
});

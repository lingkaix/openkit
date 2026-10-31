import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiErrorSchema, formatReferenceUri } from '@openkit/protocol';
import { expect, onTestFinished } from 'vitest';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import type { KnowledgeNotebook } from '../knowledge/notebook.js';
import { readWorkspaceNotebookSelection } from '../knowledge/notebook-workspace-selection.js';
import { FsStore } from '../lib/store.js';
import { readControlKnowledgeProposal } from '../storage/control-store-knowledge.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { createAppWithLocalIdentity } from './app.js';
import { serializeKnowledgePageFixture } from './knowledge-page.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from './local-user.js';

const CREATED_AT = '2026-07-12T00:00:00.000Z';
export const PRODUCER = {
  kind: 'agent',
  id: 'agent_knowledge',
  responsibleUserId: FIXTURE_LOCAL_USER_ID,
} as const;
type Proposal = Awaited<ReturnType<FsStore['createKnowledgeProposal']>>;

/** Hashes exact retained bytes independently of the Proposal reader. */
export function digest(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

/** Derives one deterministic command UUID from a readable fixture label. */
export function authorityRequestId(label: string): string {
  const suffix = createHash('sha256').update(label, 'utf8').digest('hex').slice(0, 12);
  return `00000000-0000-4000-8000-${suffix}`;
}

/** Authors the current exact owner profile; accepted bytes still require a real human Review. */
export function candidatePage(
  workspaceId: string,
  knowledgePageId: string,
  sourceReference: string,
  includeStandardStatus = true
): string {
  return [
    '---',
    'type: "KnowledgePage"',
    'title: "Review authority lesson"',
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
export async function createOwners(registerCleanup = onTestFinished) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-proposal-authority-'));
  const coreDb = openCoreDb(dataRoot);
  registerCleanup(async () => {
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspaceId = (await store.createWorkspace('Knowledge proposal authority')).id;
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
    get notebook(): KnowledgeNotebook {
      return currentSelection(this).notebook;
    },
    app: createAppWithLocalIdentity({ coreDb, dataRoot, store }),
  };
}
export type Owners = Awaited<ReturnType<typeof createOwners>>;

/** Pins one current Workspace SQL selection for the duration of a fixture operation. */
function currentSelection(f: {
  readonly dataRoot: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
}) {
  const workspaceDb = openWorkspaceDb(f.dataRoot, f.workspaceId);
  try {
    return readWorkspaceNotebookSelection({
      workspaceDb,
      workspaceRoot: f.workspaceRoot,
      knowledgeBaseId: readDefaultKnowledgeBaseId({
        dataRoot: f.dataRoot,
        scope: { kind: 'workspace', workspaceId: f.workspaceId },
      }),
    });
  } finally {
    workspaceDb.sqlite.close();
  }
}

/** Reads the current native Notebook commit through its explicit Workspace owner. */
export function currentNotebookRevision(f: Owners): string {
  return currentSelection(f).head.notebookCommit;
}

/** Reads the actual immutable Proposal path and exact retained Review JSON from Workspace SQL. */
export function retainedProposalState(f: Owners, proposalId: string) {
  const workspaceDb = openWorkspaceDb(f.dataRoot, f.workspaceId);
  try {
    const retained = readControlKnowledgeProposal(workspaceDb, proposalId);
    const row = workspaceDb.sqlite
      .prepare('SELECT reviews_json FROM knowledge_notebook_proposals WHERE proposal_id = ?')
      .get(proposalId) as { reviews_json: string } | undefined;
    if (!retained || !row) throw new Error('Fixture Proposal authority is unavailable.');
    return {
      proposalPath: join(
        f.workspaceRoot,
        'knowledge',
        'content',
        retained.proposal.documentContent.reference.locator.path
      ),
      reviewsJson: row.reviews_json,
    };
  } finally {
    workspaceDb.sqlite.close();
  }
}

/** Replaces one existing retained Review array to inject a deliberate SQL-row fault. */
export function replaceRetainedProposalReviews(
  f: Owners,
  proposalId: string,
  reviewsJson: string
): void {
  const workspaceDb = openWorkspaceDb(f.dataRoot, f.workspaceId);
  try {
    const result = workspaceDb.sqlite
      .prepare('UPDATE knowledge_notebook_proposals SET reviews_json = ? WHERE proposal_id = ?')
      .run(reviewsJson, proposalId);
    if (result.changes !== 1) throw new Error('Fixture Proposal authority is unavailable.');
  } finally {
    workspaceDb.sqlite.close();
  }
}

/** Calls the actual native operation and preserves its failure code and status for refusal assertions. */
export async function call(f: Owners, operation: string, input: Record<string, unknown>) {
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
export function currentPage(f: Owners, id: string) {
  const selection = currentSelection(f);
  return selection.notebook.readRevision(selection.head.notebookCommit).files[`${id}.md`];
}

/** Drafts through the existing Proposal owner against the actual current Git base. */
export function draft(
  f: Owners,
  sourceReference: string,
  label: string,
  id: string,
  includeStatus = true
) {
  const selection = currentSelection(f);
  const canonicalPageBytes = candidatePage(f.workspaceId, id, sourceReference, includeStatus);
  return f.store.createKnowledgeProposal({
    workspaceId: f.workspaceId,
    requestId: authorityRequestId(label),
    baseRevision: selection.head.notebookCommit,
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
export async function createFixture(
  label = 'proposal-authority-draft',
  includeStatus = true,
  registerCleanup = onTestFinished
) {
  const f = await createOwners(registerCleanup);
  const publication = await call(f, 'knowledge.notebook.create', {
    requestId: authorityRequestId('human-source'),
    baseRevision: currentNotebookRevision(f),
    path: 'evidence/human-review' + '.md',
    content: serializeKnowledgePageFixture(
      {
        title: 'Existing review evidence',
        content: 'A human Review is the only activation authority.',
        sourceReferences: [],
        createdAt: '2026-10-19T00:00:00.000Z',
        updatedAt: '2026-10-19T00:00:00.000Z',
      },
      { kind: 'workspace', workspaceId: f.workspaceId }
    ),
    summary: 'Publish explicit full-page fixture',
  });
  expect(publication.changedPageIds).toEqual(['evidence/human-review']);
  const source = { id: 'evidence/human-review' };
  const sourceReference = formatReferenceUri(
    { scopeId: workspacePageScope(f), objectId: source.id },
    digest(currentPage(f, source.id)!)
  );
  const knowledgePageId = 'review/review-authority-lesson';
  const proposal = await draft(f, sourceReference, label, knowledgePageId, includeStatus);
  const { proposalPath } = retainedProposalState(f, proposal.id);
  return {
    ...f,
    get notebook(): KnowledgeNotebook {
      return currentSelection(this).notebook;
    },
    proposal,
    knowledgePageId,
    sourceReference,
    canonicalPageBytes: proposal.canonicalPageBytes,
    contentDigest: proposal.contentDigest,
    proposalPath,
  };
}
export type Fixture = Awaited<ReturnType<typeof createFixture>>;

/** Binds every human decision to the exact immutable Proposal document, base and candidate. */
export function decisionInput(f: Owners, proposal: Proposal, decision: string, label: string) {
  return {
    requestId: authorityRequestId(label),
    proposalId: proposal.id,
    decision,
    proposalDigest: f.store.knowledgeProposalDigest(f.workspaceId, proposal.id),
    baseRevision: proposal.baseRevision,
    candidateRevision: proposal.candidateRevision,
  };
}

/** Uses the actual Review operation and shared publisher, including ordinary command receipts. */
export function decide(f: Fixture, decision: 'accepted' | 'deferred' | 'rejected', label: string) {
  return call(f, 'knowledge.proposal.decide', decisionInput(f, f.proposal, decision, label));
}

/** Requires a named authority failure for both synchronous readers and native async operations. */
export async function expectAuthorityFailure(
  action: () => unknown,
  code: 'conflict' | 'recovery_required'
) {
  await expect(Promise.resolve().then(action)).rejects.toMatchObject({ code });
}

/** Reads the actual Workspace binding without allocating fixture authority. */
export function workspacePageScope(f: Owners): string {
  return `page/workspace/${f.workspaceId}/${readDefaultKnowledgeBaseId({ dataRoot: f.dataRoot, scope: { kind: 'workspace', workspaceId: f.workspaceId } })}`;
}

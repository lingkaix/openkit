import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FsStore } from './lib/store.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from './test-support/demo-store.js';
import {
  ensureLocalUser,
  FIXTURE_LOCAL_USER_ID as LOCAL_USER_ID,
} from './test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const fixtures: Array<ReturnType<typeof fixture>> = [];

/** Compose actual public admission, Store, SQLite and Git through the existing fresh-scope initializer. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-notebook-publication-'));
  const coreDb = openCoreDb(dataRoot);
  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({
      coreDb,
      workspaceId: DEMO_WORKSPACE_ID,
      ownerUserId: LOCAL_USER_ID,
    });
    const workspaceDb = openWorkspaceDb(dataRoot, DEMO_WORKSPACE_ID);
    applyScopedMigrations(workspaceDb);
    const f = {
      dataRoot,
      coreDb,
      store,
      workspaceDb,
      app: createApp({ coreDb, dataRoot, store }),
      repositoryPath: join(dataRoot, 'workspaces', DEMO_WORKSPACE_ID, 'knowledge', 'notebook.git'),
    };
    fixtures.push(f);
    return f;
  } catch (error) {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
    throw error;
  }
}

/** Fix page expectations from the accepted v4 profile, including unknown metadata that must survive. */
function page(id: string, body: string, source: string): string {
  return [
    '---',
    'type: KnowledgePage',
    `title: ${JSON.stringify(id)}`,
    'schema_version: openkit-scope-knowledge-schema-v4',
    'requiredFeatures: [openkit.knowledge-owner-scope.v1, openkit.knowledge-git-notebook.v1]',
    'openkit_status: active',
    'status: stable',
    `scope: {kind: workspace, workspaceId: ${DEMO_WORKSPACE_ID}}`,
    `source_refs: [${JSON.stringify(source)}]`,
    'review_state: accepted',
    'sensitivity: normal',
    'freshness: current',
    `openkit_entry_id: ${id}`,
    'openkit_entry_kind: project-context',
    'created_at: "2026-10-16T00:00:00.000Z"',
    'updated_at: "2026-10-16T00:00:00.000Z"',
    'custom: {preserved: [one, two]}',
    '---',
    body,
    '',
  ].join('\n');
}

/** Independent raw Git observation of the actual published owner. */
function git(f: ReturnType<typeof fixture>, ...args: string[]) {
  return execFileSync('git', ['--git-dir', f.repositoryPath, ...args], {
    encoding: 'utf8',
  }).trimEnd();
}
/** Existing native route; request identity uses the common command header. */
async function call(
  f: ReturnType<typeof fixture>,
  operation: string,
  input: Record<string, unknown>
) {
  const { requestId, ...body } = input;
  const response = await f.app.request(`/api/app/operations/${operation}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(requestId ? { 'x-openkit-request-id': String(requestId) } : {}),
    },
    body: JSON.stringify({ workspaceId: DEMO_WORKSPACE_ID, ...body }),
  });
  return { status: response.status, body: await response.json() };
}
/** Hash bytes independently of the Proposal reader. */
function digest(bytes: string) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
/** Draft against an actual native Source and a fixed published Git base. */
async function draft(f: ReturnType<typeof fixture>, id = 'alpha', agent = false) {
  const source = await call(f, 'knowledge.source.register', {
    requestId: randomUUID(),
    kind: 'document',
    title: 'Synthetic source',
    content: 'Synthetic fact.',
  });
  expect(source.status, JSON.stringify(source.body)).toBe(200);
  const reference = `source:${source.body.source.id}@${source.body.source.contentDigest}`;
  const bytes = page(id, 'Exact reviewed text.\n', reference);
  const baseRevision = git(f, 'rev-parse', 'refs/heads/published');
  const input = {
    requestId: randomUUID(),
    baseRevision,
    knowledgePageId: id,
    canonicalPageBytes: bytes,
    contentDigest: digest(bytes),
    sourceReferences: [reference],
    rationale: 'Synthetic reviewed change.',
    confidence: 0.9,
  };
  // Server-owned Agent attribution fixture exercises the native human decision, not Agent invocation assembly.
  const response = agent
    ? {
        status: 200,
        body: {
          proposal: f.store.createKnowledgeProposal({
            ...input,
            workspaceId: DEMO_WORKSPACE_ID,
            producer: { kind: 'agent', id: 'agent_synthetic', responsibleUserId: LOCAL_USER_ID },
            createdAt: new Date().toISOString(),
            verifiedExternalReferences: [],
          }),
        },
      }
    : await call(f, 'knowledge.proposal.draft', input);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const proposal = response.body.proposal;
  const proposalDigest = digest(
    readFileSync(
      join(f.dataRoot, `workspaces/${DEMO_WORKSPACE_ID}/knowledge/proposals`, `${proposal.id}.md`),
      'utf8'
    )
  );
  return { proposal, proposalDigest, bytes, reference, baseRevision };
}
/** Human decision names the exact retained tuple, never a mutable current page. */
async function accept(f: ReturnType<typeof fixture>, d: Awaited<ReturnType<typeof draft>>) {
  return call(f, 'knowledge.proposal.decide', {
    requestId: randomUUID(),
    proposalId: d.proposal.id,
    decision: 'accepted',
    proposalDigest: d.proposalDigest,
    baseRevision: d.baseRevision,
    candidateRevision: d.proposal.candidateRevision,
  });
}
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.workspaceDb.sqlite.close();
    f.coreDb.sqlite.close();
    rmSync(f.dataRoot, { recursive: true, force: true });
  }
});

describe('native fixed-base Knowledge Review and removal', () => {
  it('publishes the retained candidate and refuses a stale Review without changing the winner', async () => {
    const f = fixture();
    const d = await draft(f);
    expect(git(f, 'rev-parse', `refs/proposals/${d.proposal.id}`)).toBe(
      d.proposal.candidateRevision
    );
    const accepted = await accept(f, d);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(git(f, 'rev-parse', 'refs/heads/published')).toBe(d.proposal.candidateRevision);
    expect(
      execFileSync(
        'git',
        ['--git-dir', f.repositoryPath, 'show', `${d.proposal.candidateRevision}:pages/alpha.md`],
        { encoding: 'utf8' }
      )
    ).toBe(d.bytes);
    expect(accepted.body.review.actor).toEqual({ kind: 'user', id: LOCAL_USER_ID });
    // Reopen real owners: saved proposal bytes must resolve through their retained Git ref.
    f.store = new FsStore({ dataRoot: f.dataRoot });
    f.app = createApp({ coreDb: f.coreDb, dataRoot: f.dataRoot, store: f.store });
    expect(
      f.store.projectKnowledgeProposalDecision(DEMO_WORKSPACE_ID, accepted.body.review.reviewId)
    ).toEqual(accepted.body);
    const stale = await draft(f, 'beta');
    const winnerBytes = page('winner', 'Unrelated winning text.\n', d.reference).replace(
      'review_state: accepted',
      'review_state: user-authored'
    );
    const winner = await call(f, 'knowledge.notebook.update', {
      requestId: randomUUID(),
      baseRevision: stale.baseRevision,
      changes: [{ path: 'winner.md', content: winnerBytes }],
      summary: 'Winning edit',
    });
    expect(winner.status, JSON.stringify(winner.body)).toBe(200);
    const rejected = await accept(f, stale);
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(409);
    expect(git(f, 'rev-parse', 'refs/heads/published')).toBe(winner.body.notebookRevision);
    expect(
      execFileSync(
        'git',
        ['--git-dir', f.repositoryPath, 'show', `${winner.body.notebookRevision}:pages/winner.md`],
        { encoding: 'utf8' }
      )
    ).toBe(winnerBytes);
    expect(f.store.getKnowledgeProposalReviewDecision(stale.proposal.id)).toBeNull();
    expect(git(f, 'rev-parse', `refs/proposals/${stale.proposal.id}`)).toBe(
      stale.proposal.candidateRevision
    );
  });

  it('reverses and explicitly removes through new commits while retaining original bytes and receipts', async () => {
    const f = fixture();
    const d = await draft(f, 'alpha', true);
    const accepted = await accept(f, d);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const message = JSON.parse(git(f, 'show', '-s', '--format=%B', d.proposal.candidateRevision));
    expect(message.producer).toEqual({
      kind: 'agent',
      id: 'agent_synthetic',
      responsibleUserId: LOCAL_USER_ID,
    });
    expect(message.authority).toEqual({ kind: 'proposal', proposalId: d.proposal.id });
    expect(message.changeRequest.requestId).not.toBe(accepted.body.review.requestId);
    expect(accepted.body.review.actor).toEqual({ kind: 'user', id: LOCAL_USER_ID });
    const reverseInput = {
      requestId: randomUUID(),
      proposalId: d.proposal.id,
      reviewId: accepted.body.review.reviewId,
      knowledgePageId: 'alpha',
      expectedContentDigest: digest(d.bytes),
      baseRevision: d.proposal.candidateRevision,
      confirmRemoval: true,
    };
    const reversed = await call(f, 'knowledge.proposal.reverse', reverseInput);
    expect(reversed.status, JSON.stringify(reversed.body)).toBe(200);
    const removedRevision = git(f, 'rev-parse', 'refs/heads/published');
    expect(removedRevision).not.toBe(d.proposal.candidateRevision);
    expect(git(f, 'ls-tree', '-r', '--name-only', removedRevision)).not.toContain('alpha.md');
    expect(
      execFileSync(
        'git',
        ['--git-dir', f.repositoryPath, 'show', `${d.proposal.candidateRevision}:pages/alpha.md`],
        { encoding: 'utf8' }
      )
    ).toBe(d.bytes);
    const replacement = page('alpha', 'Later direct text.\n', d.reference).replace(
      'review_state: accepted',
      'review_state: user-authored'
    );
    const created = await call(f, 'knowledge.notebook.update', {
      requestId: randomUUID(),
      baseRevision: removedRevision,
      changes: [{ path: 'alpha.md', content: replacement }],
      summary: 'Later direct edit',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect((await call(f, 'knowledge.proposal.reverse', reverseInput)).status).toBe(200);
    expect(git(f, 'rev-parse', 'refs/heads/published')).toBe(created.body.notebookRevision);
    // A replacement reversal copies the original exact path from Git, rather than deleting it.
    const replacementDraft = await draft(f);
    const replacementReview = await accept(f, replacementDraft);
    expect(replacementReview.status, JSON.stringify(replacementReview.body)).toBe(200);
    const restored = await call(f, 'knowledge.proposal.reverse', {
      requestId: randomUUID(),
      proposalId: replacementDraft.proposal.id,
      reviewId: replacementReview.body.review.reviewId,
      knowledgePageId: 'alpha',
      expectedContentDigest: digest(replacementDraft.bytes),
      baseRevision: replacementDraft.proposal.candidateRevision,
    });
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(restored.body.application.present).toBe(true);
    expect(
      execFileSync(
        'git',
        [
          '--git-dir',
          f.repositoryPath,
          'show',
          `${restored.body.application.notebookRevision}:pages/alpha.md`,
        ],
        { encoding: 'utf8' }
      )
    ).toBe(replacement);
    const deletion = {
      requestId: randomUUID(),
      knowledgeEntryId: 'alpha',
      baseRevision: restored.body.application.notebookRevision,
      expectedContentDigest: digest(replacement),
    };
    expect((await call(f, 'knowledge.delete', deletion)).status).toBe(400);
    const deleted = await call(f, 'knowledge.delete', {
      ...deletion,
      requestId: randomUUID(),
      confirmRemoval: true,
    });
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(git(f, 'ls-tree', '-r', '--name-only', 'refs/heads/published')).not.toContain(
      'alpha.md'
    );
    expect(
      execFileSync(
        'git',
        ['--git-dir', f.repositoryPath, 'show', `${created.body.notebookRevision}:pages/alpha.md`],
        { encoding: 'utf8' }
      )
    ).toBe(replacement);
    const evidence = f.workspaceDb.sqlite
      .prepare(
        "SELECT action FROM audit_events WHERE action IN ('knowledge.proposal.decide','knowledge.proposal.reverse','knowledge.delete') AND outcome = 'succeeded'"
      )
      .all();
    expect(evidence).toHaveLength(5);
    expect(
      f.store.getCommandRequest(
        'knowledge.proposal.reverse',
        reverseInput.requestId,
        { workspaceId: DEMO_WORKSPACE_ID, actorId: LOCAL_USER_ID },
        f.workspaceDb
      )?.response
    ).toEqual({ kind: 'knowledge_notebook_revision', id: removedRevision });
  });
});

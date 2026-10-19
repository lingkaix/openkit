import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatReferenceUri } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { readDefaultKnowledgeBaseId } from './config/knowledge-base.js';
import { FsStore } from './lib/store.js';
import { closeRetrievalServices } from './retrieval-service.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from './test-support/demo-store.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from './test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/** Explicit fixture ownership avoids a recursive inferred return type through the cleanup registry. */
interface Fixture {
  dataRoot: string;
  coreDb: ReturnType<typeof openCoreDb>;
  workspaceDb: ReturnType<typeof openWorkspaceDb>;
  store: FsStore;
  app: ReturnType<typeof createApp>;
  knowledgeRoot: string;
  pageScopeId: string;
}

const fixtures: Fixture[] = [];

/** Compose the public operation producer and real Git, SQLite and retrieval consumers. */
function fixture(): Fixture {
  const dataRoot = mkdtempSync(join(tmpdir(), 'knowledge-consolidation-public-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({
    coreDb,
    workspaceId: DEMO_WORKSPACE_ID,
    ownerUserId: FIXTURE_LOCAL_USER_ID,
  });
  const workspaceDb = openWorkspaceDb(dataRoot, DEMO_WORKSPACE_ID);
  applyScopedMigrations(workspaceDb);
  const knowledgeBaseId = readDefaultKnowledgeBaseId({
    dataRoot,
    scope: { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID },
  });
  const f = {
    dataRoot,
    coreDb,
    workspaceDb,
    store,
    app: createApp({ coreDb, dataRoot, store }),
    knowledgeRoot: join(dataRoot, 'workspaces', DEMO_WORKSPACE_ID, 'knowledge'),
    pageScopeId: `page/workspace/${DEMO_WORKSPACE_ID}/${knowledgeBaseId}`,
  };
  fixtures.push(f);
  return f;
}

/** Reopen retained owners without reseeding or repairing the published notebook. */
async function reopen(f: ReturnType<typeof fixture>) {
  await closeRetrievalServices();
  f.workspaceDb.sqlite.close();
  f.coreDb.sqlite.close();
  f.coreDb = openCoreDb(f.dataRoot);
  applyMigrations(f.coreDb);
  f.workspaceDb = openWorkspaceDb(f.dataRoot, DEMO_WORKSPACE_ID);
  applyScopedMigrations(f.workspaceDb);
  f.store = new FsStore({ dataRoot: f.dataRoot });
  f.app = createApp({ coreDb: f.coreDb, dataRoot: f.dataRoot, store: f.store });
}

/** Use native JSON operation admission and its actual command-identity header. */
async function call(
  f: ReturnType<typeof fixture>,
  operation: string,
  input: Record<string, unknown> = {}
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

/** Require real public success before a fixture may supply a base or source. */
async function ok(
  f: ReturnType<typeof fixture>,
  operation: string,
  input: Record<string, unknown> = {}
) {
  const result = await call(f, operation, input);
  expect(result.status, `${operation}: ${JSON.stringify(result.body)}`).toBe(200);
  return result.body;
}

/** Observe exact retained bytes independently from the product's notebook reader. */
function git(f: ReturnType<typeof fixture>, ...args: string[]): string {
  return execFileSync('git', ['--git-dir', join(f.knowledgeRoot, 'notebook.git'), ...args], {
    encoding: 'utf8',
  });
}

/** Public list supplies the request's immutable publication base. */
async function revision(f: ReturnType<typeof fixture>): Promise<string> {
  return (await ok(f, 'knowledge.notebook.list')).notebookRevision;
}

/** Fix the accepted profile and assessment values before any implementation change. */
function page(
  type: 'Claim' | 'Observation' | 'KnowledgePage',
  body: string,
  fields: Record<string, unknown> = {}
): string {
  return `---\n${stringify({
    type,
    title: body,
    schema_version: 'openkit-scope-knowledge-schema-v4',
    requiredFeatures: ['openkit.knowledge-owner-scope.v1', 'openkit.knowledge-git-notebook.v1'],
    scope: { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID },
    openkit_status: 'active',
    status: 'stable',
    source_refs: [],
    review_state: 'user-authored',
    sensitivity: 'normal',
    freshness: 'current',
    created_at: '2026-10-19T00:00:00.000Z',
    updated_at: '2026-10-19T00:00:00.000Z',
    ...fields,
  })}---\n${body}\n`;
}

/** All reusable facts cross the existing fixed-base public notebook publisher. */
async function publish(f: ReturnType<typeof fixture>, changes: Record<string, string>) {
  return ok(f, 'knowledge.notebook.update', {
    requestId: randomUUID(),
    baseRevision: await revision(f),
    changes: Object.entries(changes).map(([path, content]) => ({ path, content })),
    summary: 'Publish reusable source-grounded understanding',
  });
}

/** Raw evidence remains with its real Source owner; assertions retain the exact digest pin. */
async function source(f: ReturnType<typeof fixture>, title = 'Release evidence') {
  const registered = await ok(f, 'knowledge.source.register', {
    requestId: randomUUID(),
    kind: 'document',
    title,
    content: 'The release cadence is fortnightly.',
  });
  return `source:${registered.source.id}@${registered.source.contentDigest}`;
}

/** Only current canonical notebook bytes supply the frontmatter observation. */
function metadata(f: ReturnType<typeof fixture>, id: string) {
  const bytes = git(f, 'show', `refs/heads/published:pages/${id}.md`);
  return parse(bytes.split('---\n')[1]!);
}

/** Enumerate every monthly file in the three retired semantic authorities, including nested files. */
function semanticLedgers(f: ReturnType<typeof fixture>) {
  return ['claims', 'observations', 'conflicts'].flatMap((kind) => {
    const root = join(f.knowledgeRoot, kind);
    return existsSync(root)
      ? readdirSync(root, { recursive: true }).filter((path) => String(path).endsWith('.jsonl'))
      : [];
  });
}

afterEach(async () => {
  await closeRetrievalServices();
  for (const f of fixtures.splice(0)) {
    f.workspaceDb.sqlite.close();
    f.coreDb.sqlite.close();
    rmSync(f.dataRoot, { recursive: true, force: true });
  }
});

describe('C01/C02 public canonical Knowledge consolidation', () => {
  it('preserves numeric Claim confidence and source pins through ordinary draft, active, archive and restart', async () => {
    const f = fixture();
    const reference = await source(f);
    for (const confidence of [0, 0.75, 1]) {
      const id = `release-${String(confidence).replace('.', '-')}`;
      const fields = { confidence, source_refs: [reference] };
      await publish(f, {
        [`${id}.md`]: page('Claim', 'fortnightly-release-marker', {
          ...fields,
          openkit_status: 'draft',
          status: 'draft',
        }),
      });
      const pin = { scopeId: f.pageScopeId, objectId: id };
      const draft = await ok(f, 'knowledge.retrieval', {
        query: 'unmatched',
        pinnedReferences: [pin],
      });
      expect(draft.selected).toEqual([]);
      await publish(f, { [`${id}.md`]: page('Claim', 'fortnightly-release-marker', fields) });
      const active = await ok(f, 'knowledge.retrieval', {
        query: 'unmatched',
        pinnedReferences: [pin],
      });
      expect(active.selected.map((row: { reference: unknown }) => row.reference)).toContainEqual(
        pin
      );
      expect(metadata(f, id)).toMatchObject({
        type: 'Claim',
        confidence,
        source_refs: [reference],
        scope: { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID },
        freshness: 'current',
        review_state: 'user-authored',
      });
      const activeRevision = await revision(f);
      await publish(f, {
        [`${id}.md`]: page('Claim', 'fortnightly-release-marker', {
          ...fields,
          openkit_status: 'archived',
          status: 'deprecated',
        }),
      });
      expect(
        (await ok(f, 'knowledge.retrieval', { query: 'unmatched', pinnedReferences: [pin] }))
          .selected
      ).toEqual([]);
      const restored = await ok(f, 'knowledge.notebook.restore', {
        requestId: randomUUID(),
        baseRevision: await revision(f),
        fromRevision: activeRevision,
        pageIds: [id],
        summary: 'Restore the retained Claim through normal publication',
      });
      expect(restored.notebookRevision).not.toBe(activeRevision);
      expect(metadata(f, id)).toMatchObject({
        confidence,
        source_refs: [reference],
        openkit_status: 'active',
      });
    }
    const beforeRestart = await revision(f);
    await reopen(f);
    expect(await revision(f)).toBe(beforeRestart);
    expect(semanticLedgers(f)).toEqual([]);
  }, 60_000);

  it('excludes subject-targeted unresolved OKF conflicts from public lexical and pinned retrieval after restart', async () => {
    const f = fixture();
    const reference = await source(f);
    const target = { scopeId: f.pageScopeId, objectId: 'release-cadence' };
    const conflict = (state: 'unresolved' | 'resolved', subjects: string[]) =>
      page('Observation', 'Competing release assessments need inspection.', {
        openkit_status: 'draft',
        status: 'draft',
        source_refs: [reference],
        subject_refs: subjects,
        conflict_status: state,
      });
    await publish(f, {
      'release-cadence.md': page('Claim', 'isolated-cadence-marker', {
        confidence: 0.75,
        source_refs: [reference],
      }),
      'unrelated-subject.md': page('Claim', 'An independent release assertion.', {
        confidence: 0.5,
        source_refs: [reference],
      }),
      'cadence-conflict.md': conflict('unresolved', [formatReferenceUri(target)]),
    });
    for (const restarted of [false, true]) {
      if (restarted) await reopen(f);
      for (const pinnedReferences of [[], [target]]) {
        const result = await ok(f, 'knowledge.retrieval', {
          query: pinnedReferences.length ? 'unmatched' : 'isolated-cadence-marker',
          pinnedReferences,
        });
        expect(
          result.selected,
          'a subject-bound conflict must withhold the otherwise active Claim'
        ).toEqual([]);
        expect(result.excluded).toContainEqual(
          expect.objectContaining({ reference: target, reason: 'lower_conformance' })
        );
      }
    }
    await publish(f, { 'cadence-conflict.md': conflict('resolved', [formatReferenceUri(target)]) });
    expect(
      (await ok(f, 'knowledge.retrieval', { query: 'unmatched', pinnedReferences: [target] }))
        .selected
    ).toContainEqual(expect.objectContaining({ reference: target }));
    // Supporting evidence alone does not make the Claim a conflict subject.
    await publish(f, {
      'cadence-conflict.md': conflict('unresolved', [
        formatReferenceUri({ ...target, objectId: 'unrelated-subject' }),
      ]),
    });
    expect(
      (await ok(f, 'knowledge.retrieval', { query: 'unmatched', pinnedReferences: [target] }))
        .selected
    ).toContainEqual(expect.objectContaining({ reference: target }));
    expect(semanticLedgers(f)).toEqual([]);
  }, 60_000);

  it('refuses an exact human Proposal acceptance while a published OKF Observation conflicts with its pinned source', async () => {
    const f = fixture();
    const reference = await source(f);
    const targetId = 'contested-result';
    await publish(f, {
      'existing-evidence.md': page('KnowledgePage', 'The release evidence needs interpretation.', {
        openkit_entry_id: 'existing-evidence',
        openkit_entry_kind: 'project-context',
        source_refs: [reference],
      }),
    });
    const evidenceBytes = git(f, 'show', 'refs/heads/published:pages/existing-evidence.md');
    const evidencePin = formatReferenceUri(
      { scopeId: f.pageScopeId, objectId: 'existing-evidence' },
      `sha256:${createHash('sha256').update(evidenceBytes).digest('hex')}`
    );
    await publish(f, {
      'contested-analysis.md': page('Observation', 'The target remains disputed.', {
        openkit_status: 'draft',
        status: 'draft',
        source_refs: [reference],
        subject_refs: [evidencePin],
        conflict_status: 'unresolved',
      }),
    });
    const baseRevision = await revision(f);
    const proposalReferences = [reference, evidencePin].sort();
    const bytes = page('KnowledgePage', 'A proposed interpretation of release evidence.', {
      openkit_entry_id: targetId,
      openkit_entry_kind: 'project-context',
      review_state: 'accepted',
      source_refs: proposalReferences,
    });
    const draft = await ok(f, 'knowledge.proposal.draft', {
      requestId: randomUUID(),
      baseRevision,
      knowledgePageId: targetId,
      canonicalPageBytes: bytes,
      contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      sourceReferences: proposalReferences,
      rationale: 'Retain the reviewed interpretation only after its conflict is resolved.',
      confidence: 0.75,
    });
    const preview = await ok(f, 'knowledge.proposal.read', {
      proposalId: draft.proposal.id,
      path: `${targetId}.md`,
    });
    expect(preview).toMatchObject({
      baseRevision,
      candidateRevision: draft.proposal.candidateRevision,
      before: null,
      after: bytes,
      nextOffset: null,
    });
    const reviews = () =>
      existsSync(join(f.knowledgeRoot, 'reviews'))
        ? readdirSync(join(f.knowledgeRoot, 'reviews'))
            .sort()
            .map((name) => [name, readFileSync(join(f.knowledgeRoot, 'reviews', name), 'utf8')])
        : [];
    const beforeReviews = reviews();
    const decision = await call(f, 'knowledge.proposal.decide', {
      requestId: randomUUID(),
      proposalId: preview.proposalId,
      proposalDigest: preview.proposalDigest,
      baseRevision: preview.baseRevision,
      candidateRevision: preview.candidateRevision,
      decision: 'accepted',
    });
    expect(
      decision.status,
      'an exact human decision cannot bypass unresolved canonical analysis'
    ).toBe(409);
    expect(decision.body.code).toBe('conflict');
    expect(await revision(f)).toBe(baseRevision);
    expect(reviews()).toEqual(beforeReviews);
    expect(semanticLedgers(f)).toEqual([]);
  }, 60_000);

  it('refuses a conflict subject whose exact page digest does not match its current reference owner', async () => {
    const f = fixture();
    await publish(f, {
      'actual-subject.md': page('Claim', 'An existing release assertion.', { confidence: 1 }),
    });
    const baseRevision = await revision(f);
    const result = await call(f, 'knowledge.notebook.update', {
      requestId: randomUUID(),
      baseRevision,
      changes: [
        {
          path: 'invalid-subject.md',
          content: page(
            'Observation',
            'A syntactically valid URI is not evidence of target validity.',
            {
              openkit_status: 'draft',
              status: 'draft',
              conflict_status: 'unresolved',
              subject_refs: [
                formatReferenceUri(
                  { scopeId: f.pageScopeId, objectId: 'actual-subject' },
                  `sha256:${'0'.repeat(64)}`
                ),
              ],
            }
          ),
        },
      ],
      summary: 'Reject a mismatched exact subject pin',
    });
    expect(result.status, 'a canonical URI must still resolve its exact subject version').toBe(400);
    expect(result.body.code).toBe('invalid_request');
    expect(await revision(f)).toBe(baseRevision);
  }, 60_000);
});

// openkit-test-platform: posix
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { lstat, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatReferenceUri, KnowledgeNotebookPageSchema } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureLocalUser } from './auth/identity.js';
import { readDefaultKnowledgeBaseId } from './config/knowledge-base.js';
import { createRuntimeConfigManager } from './config/runtime-config.js';
import { KnowledgeNotebook } from './knowledge/notebook.js';
import { updateOkfFrontmatter } from './knowledge/okf.js';
import { FsStore } from './lib/store.js';
import { OperationError } from './operation-error.js';
import {
  admitKnowledgeRetrieval,
  knowledgePageDelegated,
  prepareAuthorizedWorkspaceNotebookRead,
  readAuthorizedWorkspaceNotebookPages,
} from './retrieval-knowledge-adapter.js';
import { closeRetrievalServices, getRetrievalService } from './retrieval-service.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { type CoreDb, openCoreDb } from './storage/db.js';
import {
  type KnowledgeRetrievalAccess,
  retrieveWorkspaceKnowledge,
} from './storage/index-rebuild.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { testEntityId } from './test-support/entity-ids.js';
import {
  knowledgePageFixture,
  serializeKnowledgePageFixture,
} from './test-support/knowledge-page.js';
import { notebookImportFixture } from './test-support/notebook-import.js';
import { writeManagedThreadPolicyFixture } from './test-support/resource-policy.js';
import { captureWorkspaceSourceFixture } from './test-support/workspace-source.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const NOW = '2026-10-15T00:00:00.000Z';

const testRoots: string[] = [];
const testDbs: CoreDb[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await closeRetrievalServices();
  for (const db of testDbs.splice(0)) db.sqlite.close();
  await shutdownControlStoreWorkerClient();
  for (const root of testRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('canonical local retrieval identity', () => {
  it('uses current Core identity and refuses generation access without Core authority', async () => {
    const f = await createFixture('local-identity');
    expect(() =>
      admitKnowledgeRetrieval({ workspaceId: f.workspaceId, access: f.access })
    ).not.toThrow();
    const access = { ...f.access, coreDb: undefined };
    // Core Policy requires current authoritative facts; an implicit local identity cannot replace Core.
    expect(() => admitKnowledgeRetrieval({ workspaceId: f.workspaceId, access })).toThrow(
      'Knowledge retrieval access denied.'
    );
    for (const actorId of [
      'user_local',
      'usr_00000000-0000-4000-8000-000000000001',
      'usr_00000000-0000-7000-8000-000000000002',
    ]) {
      expect(() =>
        admitKnowledgeRetrieval({
          workspaceId: f.workspaceId,
          access: { ...f.access, actor: { kind: 'user', id: actorId } },
        })
      ).toThrow('Knowledge retrieval access denied.');
    }
    expect(() =>
      admitKnowledgeRetrieval({
        workspaceId: f.workspaceId,
        access: { ...access, requestActor: undefined },
      })
    ).toThrow('Knowledge retrieval access denied.');
  });
});

describe('governed Knowledge retrieval over the Retrieval Kernel', () => {
  it('refuses async preparation through a linked Knowledge root', async () => {
    const fixture = await createFixture('linked-knowledge-root');
    const input = {
      dataRoot: fixture.dataRoot,
      workspaceId: fixture.workspaceId,
      access: fixture.access,
    };
    await expect(prepareAuthorizedWorkspaceNotebookRead(input)).resolves.toHaveProperty(
      'selected.revision',
      fixture.notebook.publishedRevision()
    );
    const knowledgeRoot = join(fixture.workspaceRoot, 'knowledge');
    const retainedRoot = join(fixture.workspaceRoot, 'knowledge-retained');
    await rename(knowledgeRoot, retainedRoot);
    await symlink(retainedRoot, knowledgeRoot, 'dir');
    expect((await lstat(knowledgeRoot)).isSymbolicLink()).toBe(true);
    expect((await lstat(join(knowledgeRoot, 'notebook.git'))).isDirectory()).toBe(true);
    await expect(prepareAuthorizedWorkspaceNotebookRead(input)).rejects.toMatchObject({
      code: 'recovery_required',
    });
  });

  it.each([
    'restrict the referenced page',
    'publish an unrelated page',
  ])('rechecks current Source authority after prepared content: %s', async (change) => {
    const fixture = await createFixture('prepared-currency');
    const source = await createEntry(fixture, 'Supporting page', 'source-currency-marker');
    const dependent = await createEntry(fixture, 'Dependent page', 'dependent-currency-marker', [
      formatReferenceUri(pageReference(fixture, source.id)),
    ]);
    const input = {
      dataRoot: fixture.dataRoot,
      workspaceId: fixture.workspaceId,
      access: fixture.access,
    };
    const notebookRead = await prepareAuthorizedWorkspaceNotebookRead(input);
    const target = {
      ...input,
      notebookRead,
      notebookRevision: notebookRead.selected.revision,
      pageIds: [dependent.id],
    };
    const before = await readAuthorizedWorkspaceNotebookPages(target);
    expect(before.pages).toEqual([dependent]);
    if (change === 'restrict the referenced page')
      await updatePageFields(fixture, source.id, { sensitivity: 'confidential' });
    else await createEntry(fixture, 'Unrelated page', 'unrelated-currency-marker');
    expect(fixture.notebook.publishedRevision()).not.toBe(target.notebookRevision);
    if (change === 'restrict the referenced page') {
      const refusal = Promise.resolve().then(() => readAuthorizedWorkspaceNotebookPages(target));
      await expect(refusal).rejects.toBeInstanceOf(OperationError);
      await expect(refusal).rejects.toMatchObject({ code: 'workspace_access_denied' });
      const diagnostic = await refusal.catch(({ code, message, status }: OperationError) => ({
        code,
        message,
        status,
      }));
      for (const secret of [dependent.id, source.id, 'dependent-currency-marker'])
        expect(JSON.stringify(diagnostic)).not.toContain(secret);
    } else {
      const after = await readAuthorizedWorkspaceNotebookPages(target);
      expect(after.notebookRevision).toBe(target.notebookRevision);
      expect(after.pages).toEqual([dependent]);
      expect(after.pages[0]!.contentDigest).toBe(sha256(dependent.content));
    }
  });

  it('excludes an unpublished proposal despite its delegated label and exact candidate bytes', async () => {
    const fixture = await createFixture('unpublished-proposal');
    const id = 'pending-rule';
    const content = updateOkfFrontmatter({
      path: `${id}.md`,
      content: serializeKnowledgePageFixture(
        {
          title: 'Pending metric rule',
          content: 'pending-proposal-marker is not confirmed reusable meaning.',
          sourceReferences: [],
          createdAt: NOW,
          updatedAt: NOW,
        },
        { kind: 'workspace', workspaceId: fixture.workspaceId }
      ),
      updates: {
        type: 'Rule',
        review_state: 'delegated',
        applies_to: ['step:metric-close'],
      },
    });
    const baseRevision = fixture.notebook.publishedRevision();
    const proposalId = `kp_${'2'.repeat(64)}`;
    const candidateRevision = fixture.notebook.prepare({
      baseRevision,
      changes: { [`${id}.md`]: content },
      metadata: {
        summary: 'Retain an unreviewed rule candidate',
        producer: { kind: 'agent', id: 'knowledge-manager', responsibleUserId: fixture.userId },
        authority: { kind: 'proposal', proposalId },
        sourceReferences: [],
        changeRequest: { requestId: randomUUID(), inputDigest: sha256(content) },
      },
    });
    fixture.notebook.retainCandidate({ proposalId, candidateRevision });
    expect(fixture.notebook.retainedCandidate(proposalId).revision).toBe(candidateRevision);
    expect(fixture.notebook.readRevision(candidateRevision).files[`${id}.md`]).toBe(content);
    expect(() =>
      knowledgePageDelegated(
        {
          ...retrievalInput(fixture, 'pending-proposal-marker'),
          notebookRevision: candidateRevision,
        },
        id,
        content
      )
    ).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    const result = await retrieveWorkspaceKnowledge({
      ...retrievalInput(fixture, 'pending-proposal-marker'),
      types: ['Rule'],
      appliesTo: ['step:metric-close'],
      pinnedReferences: [pageReference(fixture, id)],
    });
    expect(result.selected).toEqual([]);
    expect(fixture.notebook.publishedRevision()).toBe(baseRevision);
  });

  it.each([
    'Claim',
    'Observation',
  ] as const)('excludes unresolved %s pages from active query and pinned selection until resolved', async (type) => {
    const fixture = await createFixture(`conflict-${type.toLowerCase()}`);
    const page = await createEntry(fixture, 'Conflict evidence', 'conflict-selection-marker');
    const reference = pageReference(fixture, page.id);
    await publishPages(fixture, [
      {
        path: `${page.id}.md`,
        content: updateOkfFrontmatter({
          path: `${page.id}.md`,
          content: readPage(fixture, page.id),
          updates: {
            type,
            ...(type === 'Claim'
              ? { confidence: 0 }
              : { subject_refs: [formatReferenceUri(reference)] }),
          },
        }),
      },
    ]);
    // No recorded assessment remains eligible; it does not fabricate a resolution.
    const unassessed = await retrieveWorkspaceKnowledge(
      retrievalInput(fixture, 'conflict-selection-marker')
    );
    expect(unassessed.selected.map(({ reference }) => reference.objectId)).toEqual([page.id]);
    expect(readPage(fixture, page.id)).not.toContain('conflict_status:');

    for (const conflict_status of ['unresolved', 'resolved'] as const) {
      await publishPages(fixture, [
        {
          path: `${page.id}.md`,
          content: updateOkfFrontmatter({
            path: `${page.id}.md`,
            content: readPage(fixture, page.id),
            updates: { conflict_status },
          }),
        },
      ]);
      for (const pinnedReferences of [[], [reference]]) {
        const trace = await retrieveWorkspaceKnowledge({
          ...retrievalInput(
            fixture,
            pinnedReferences.length ? 'unmatched-conflict-lookup' : 'conflict-selection-marker'
          ),
          pinnedReferences,
        });
        if (conflict_status === 'unresolved') {
          expect(trace.selected).toEqual([]);
          expect(exclusionReasons(trace)).toEqual({ [page.id]: 'lower_conformance' });
        } else {
          expect(trace.selected.map(({ reference }) => reference.objectId)).toEqual([page.id]);
          expect(trace.excluded).toEqual([]);
        }
      }
    }
    if (type === 'Claim') {
      // Current authorized inspection of non-active facts remains available.
      await publishPages(fixture, [
        {
          path: `${page.id}.md`,
          content: updateOkfFrontmatter({
            path: `${page.id}.md`,
            content: readPage(fixture, page.id),
            updates: {
              openkit_status: 'archived',
              status: 'deprecated',
              conflict_status: 'unresolved',
            },
          }),
        },
      ]);
      const inspected = await retrieveWorkspaceKnowledge({
        ...retrievalInput(fixture, 'conflict-selection-marker'),
        states: ['archived'],
      });
      expect(inspected.selected.map(({ reference }) => reference.objectId)).toEqual([page.id]);
      expect(inspected.excluded).toEqual([]);
    }
  });

  it('enumerates lexical matches before sensitivity, conflict, freshness, and budget dispositions', async () => {
    const fixture = await createFixture('enumeration');
    const selected = await createEntry(
      fixture,
      'Selected evidence',
      'selection-marker selection-marker'
    );
    const overflow = await createEntry(fixture, 'Overflow evidence', 'selection-marker');
    const stale = await createEntry(
      fixture,
      'Selection marker stale evidence',
      'selection-marker selection-marker selection-marker'
    );
    const conflicted = await createEntry(
      fixture,
      'Selection marker conflicted evidence',
      'selection-marker selection-marker selection-marker selection-marker'
    );
    const sensitive = await createEntry(
      fixture,
      'Selection marker private evidence',
      'selection-marker selection-marker selection-marker selection-marker selection-marker'
    );
    await updatePageFields(fixture, stale.id, { freshness: 'stale' });
    await updatePageFields(fixture, conflicted.id, { freshness: 'stale' });
    await updatePageFields(fixture, sensitive.id, {
      freshness: 'stale',
      sensitivity: 'confidential',
    });
    const analysisId = 'assessments/enumeration-conflict';
    await publishPages(fixture, [
      {
        path: `${analysisId}.md`,
        content: updateOkfFrontmatter({
          path: `${analysisId}.md`,
          content: readPage(fixture, conflicted.id),
          updates: {
            openkit_entry_id: analysisId,
            type: 'Observation',
            openkit_status: 'draft',
            status: 'draft',
            subject_refs: [
              formatReferenceUri(pageReference(fixture, conflicted.id)),
              formatReferenceUri(pageReference(fixture, sensitive.id)),
            ],
            conflict_status: 'unresolved',
          },
        }),
      },
    ]);

    const trace = await retrieveWorkspaceKnowledge({
      ...retrievalInput(fixture, 'selection-marker'),
      limit: 1,
    });

    expect(trace.selected).toEqual([
      expect.objectContaining({
        reference: {
          scopeId: `page/workspace/${fixture.workspaceId}/${readDefaultKnowledgeBaseId({ dataRoot: fixture.dataRoot, scope: { kind: 'workspace', workspaceId: fixture.workspaceId } })}`,
          objectId: selected.id,
        },
      }),
    ]);
    expect(exclusionReasons(trace)).toEqual(
      expect.objectContaining({
        [sensitive.id]: 'sensitive_content',
        [conflicted.id]: 'lower_conformance',
        [stale.id]: 'freshness_expired',
        [overflow.id]: 'budget_exceeded',
      })
    );

    const frontmatterOnly = await retrieveWorkspaceKnowledge({
      ...retrievalInput(fixture, 'confidential'),
      limit: 20,
    });
    expect(frontmatterOnly).toMatchObject({ selected: [], excluded: [] });
  });

  it('moves a pin first without changing either kernel score', async () => {
    const fixture = await createFixture('pin-score');
    const higher = await createEntry(
      fixture,
      'Release cadence release cadence',
      'release cadence release cadence'
    );
    const pinned = await createEntry(fixture, 'Other notes', 'release cadence');
    const ordinary = await retrieveWorkspaceKnowledge({
      ...retrievalInput(fixture, 'release cadence'),
      limit: 2,
    });
    const withPin = await retrieveWorkspaceKnowledge({
      ...retrievalInput(fixture, 'release cadence'),
      limit: 2,
      pinnedReferences: [pageReference(fixture, pinned.id)],
    });
    const ordinaryScores = new Map(
      ordinary.selected.map((candidate) => [candidate.reference.objectId, candidate.score])
    );

    expect(ordinary.selected[0]?.reference.objectId).toBe(higher.id);
    expect(withPin.selected.map((candidate) => candidate.reference.objectId)).toEqual([
      pinned.id,
      higher.id,
    ]);
    expect(withPin.selected.map((candidate) => candidate.score)).toEqual([
      ordinaryScores.get(pinned.id),
      ordinaryScores.get(higher.id),
    ]);
  });

  it('uses active-only defaults and one generation for explicit app state inspection', async () => {
    const fixture = await createFixture('states');
    const pages = {
      active: await createEntry(fixture, 'Active state', 'state-marker'),
      draft: await createEntry(fixture, 'Draft state', 'state-marker'),
      archived: await createEntry(fixture, 'Archived state', 'state-marker'),
      superseded: await createEntry(fixture, 'Superseded state', 'state-marker'),
    };
    for (const state of ['draft', 'archived', 'superseded'] as const) {
      await updatePageFields(fixture, pages[state].id, {
        openkit_status: state,
        status: state === 'draft' ? 'draft' : 'deprecated',
      });
    }

    const defaultTrace = await retrieveWorkspaceKnowledge({
      ...retrievalInput(fixture, 'state-marker'),
      limit: 20,
    });
    const firstGeneration = onlyRetrievalGeneration(fixture);
    const explicitTrace = await retrieveWorkspaceKnowledge({
      ...retrievalInput(fixture, 'state-marker'),
      limit: 20,
      states: ['active', 'draft', 'archived', 'superseded'],
    });

    expect(defaultTrace.selected.map((candidate) => candidate.reference.objectId)).toEqual([
      pages.active.id,
    ]);
    expect(defaultTrace.excluded.map((candidate) => candidate.reference.objectId).sort()).toEqual(
      [pages.archived.id, pages.draft.id, pages.superseded.id].sort()
    );
    expect(explicitTrace.selected.map((candidate) => candidate.reference.objectId).sort()).toEqual(
      Object.values(pages)
        .map((page) => page.id)
        .sort()
    );
    expect(onlyRetrievalGeneration(fixture)).toBe(firstGeneration);
    await expect(
      retrieveWorkspaceKnowledge({
        ...retrievalInput(fixture, 'state-marker'),
        caller: 'assistant',
        states: ['archived'],
      })
    ).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
  });

  it('removes a source after audience revocation without exposing its identity', async () => {
    const fixture = await createFixture('source-revocation');
    const destination = await fixture.store.createThread(
      fixture.workspaceId,
      'Private destination',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: fixture.userId }
    );
    const sourceThread = await fixture.store.createThread(
      fixture.workspaceId,
      'Private source',
      undefined,
      'conversation',
      { visibility: 'workspace' }
    );
    fixture.access.outputThreadId = destination.id;
    const material = 'source audience material';
    const source = await captureWorkspaceSourceFixture({
      ...fixture,
      coreDb: fixture.access.coreDb!,
      userId: fixture.userId,
      source: {
        id: 'ks_00000000-0000-78f8-b8d2-1dd7a79cb16e',
        workspaceId: fixture.workspaceId,
        kind: 'document',
        title: 'Private source',
        uri: null,
        contentDigest: sha256(material),
        originatingThreadId: sourceThread.id,
        originatingTurnId: null,
        originatingFileId: null,
        capturedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      },
      content: material,
    });
    const sourcePage = await createEntry(
      fixture,
      'Audience source page',
      'audience-marker source-backed',
      [`source:${source.id}@${source.contentDigest}`]
    );
    const control = await createEntry(fixture, 'Audience control page', 'audience-marker control');
    const before = await retrieveWorkspaceKnowledge({
      ...retrievalInput(fixture, 'audience-marker'),
      limit: 20,
    });
    expect(before.selected.map((candidate) => candidate.reference.objectId)).toEqual(
      expect.arrayContaining([sourcePage.id, control.id])
    );

    writeManagedThreadPolicyFixture({
      dataRoot: fixture.dataRoot,
      workspaceId: fixture.workspaceId,
      threadId: sourceThread.id,
      userId: fixture.userId,
    });
    expect(fixture.runtimeConfigManager.reload({ dryRun: false, mode: 'safe' }).status).toBe(
      'applied'
    );
    const after = await retrieveWorkspaceKnowledge({
      ...retrievalInput(fixture, 'audience-marker'),
      limit: 20,
    });

    expect(after.selected.map((candidate) => candidate.reference.objectId)).toEqual([control.id]);
    expect(JSON.stringify(after)).not.toContain(sourcePage.id);
    expect(JSON.stringify(after)).not.toContain('source-backed');
  });

  // Fresh attributed import of 1001 Git pages measured 81s; this is fixture setup, not a retrieval deadline.
  it('returns a typed failure and writes no trace when lexical enumeration exceeds 1000 matches', async () => {
    const initialKnowledge = Array.from({ length: 1001 }, (_, index) =>
      knowledgePageFixture(
        {
          id: `bulk-${String(index).padStart(4, '0')}`,
          title: `Bulk ${index}`,
          content: 'enumeration-overflow',
          createdAt: NOW,
          updatedAt: NOW,
        },
        { kind: 'workspace', workspaceId: testEntityId('ws', 'enumeration-incomplete') }
      )
    );
    const fixture = await createFixture('enumeration-incomplete', initialKnowledge);
    const traceThread = await fixture.store.createThread(
      fixture.workspaceId,
      'Enumeration trace owner'
    );
    fixture.access.outputThreadId = traceThread.id;
    const failedTraceId = traceId(10);

    await expect(
      retrieveWorkspaceKnowledge({
        ...retrievalInput(fixture, 'enumeration-overflow'),
        limit: 20,
        traceId: failedTraceId,
      })
    ).rejects.toMatchObject({
      code: 'knowledge_retrieval_failed',
      status: 503,
    });
    expect(readTraceBytes(fixture)).not.toContain(failedTraceId);
  }, 180_000);

  it('keeps selection and its trace at the pinned commit across a later content publication', async () => {
    const fixture = await createFixture('concurrent-change');
    const page = await createEntry(fixture, 'Concurrent page', 'before-change-marker');
    const pinnedRevision = fixture.notebook.publishedRevision();
    const pinnedBytes = readPage(fixture, page.id);
    const retrievalTraceId = traceId(11);
    const traceThread = await fixture.store.createThread(
      fixture.workspaceId,
      'Concurrent trace owner'
    );
    fixture.access.outputThreadId = traceThread.id;
    const service = getRetrievalService(fixture.dataRoot, fixture.workspaceRoot);
    const publish = service.publish.bind(service);
    // Keep the real kernel publication; change current content at its exact completion boundary.
    vi.spyOn(service, 'publish').mockImplementationOnce(async (...args) => {
      const generation = await publish(...args);
      await operation(fixture, 'knowledge.notebook.update', {
        baseRevision: fixture.notebook.publishedRevision(),
        changes: [
          {
            path: page.path,
            content: readPage(fixture, page.id).replace(
              'before-change-marker',
              'after-change-marker'
            ),
          },
        ],
        summary: 'Change evidence at publication boundary',
      });
      return generation;
    });
    const result = await retrieveWorkspaceKnowledge({
      ...retrievalInput(fixture, 'before-change-marker'),
      traceId: retrievalTraceId,
    });
    const selectedEvidence = {
      reference: pageReference(fixture, page.id),
      revision: pinnedRevision,
      contentDigest: sha256(pinnedBytes),
      sourceReferences: [],
    };
    expect(result.notebookRevision).toBe(pinnedRevision);
    expect(result.selected).toEqual([expect.objectContaining(selectedEvidence)]);
    expect(result.excluded).toEqual([]);
    expect(result.retrievalTraceRef).toEqual({
      scopeId: `retrieval-trace/thread/${fixture.workspaceId}/${traceThread.id}`,
      objectId: retrievalTraceId,
    });
    const retainedTrace = JSON.parse(
      readFileSync(
        join(
          fixture.workspaceRoot,
          'threads',
          traceThread.id,
          'retrieval-traces',
          `${retrievalTraceId}.json`
        ),
        'utf8'
      )
    );
    expect(retainedTrace).toMatchObject({
      traceId: retrievalTraceId,
      notebookRevision: pinnedRevision,
    });
    expect(retainedTrace.selected).toEqual([selectedEvidence]);
    expect(fixture.notebook.publishedRevision()).not.toBe(pinnedRevision);
    const currentBytes = readPage(fixture, page.id);
    expect(currentBytes).toContain('after-change-marker');
    expect(currentBytes).not.toContain('before-change-marker');
    expect(sha256(currentBytes)).not.toBe(sha256(pinnedBytes));
  });
});

interface Fixture {
  dataRoot: string;
  workspaceId: string;
  workspaceRoot: string;
  store: FsStore;
  access: KnowledgeRetrievalAccess;
  userId: string;
  notebook: KnowledgeNotebook;
  app: ReturnType<typeof createApp>;
  runtimeConfigManager: ReturnType<typeof createRuntimeConfigManager>;
}

/** Initializes retained owners and effective runtime configuration for governed retrieval. */
async function createFixture(
  label: string,
  initialKnowledge: Parameters<typeof notebookImportFixture>[0]['knowledge'] = []
): Promise<Fixture> {
  const dataRoot = mkdtempSync(join(tmpdir(), `openkit-retrieval-governance-${label}-`));
  testRoots.push(dataRoot);
  const coreDb = openCoreDb(dataRoot);
  testDbs.push(coreDb);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspaceId = testEntityId('ws', label);
  const workspace = await (initialKnowledge.length
    ? store.importWorkspaceSnapshot({
        ...notebookImportFixture({ workspaceId, knowledge: initialKnowledge, userId }),
        workspace: {
          id: workspaceId,
          name: label,
          kind: 'general',
          status: 'active',
          counts: {
            threadCount: 0,
            artifactCount: 0,
            knowledgeEntryCount: initialKnowledge.length,
          },
          createdAt: NOW,
          updatedAt: NOW,
        },
        knowledge: initialKnowledge,
        threads: [],
        turns: [],
        itemRevisions: [],
        artifacts: [],
        agentSessions: [],
        turnEvents: [],
      })
    : store.createWorkspace(label, {
        requestId: randomUUID(),
        producer: { kind: 'user', id: userId },
        instructionReference: 'test-fixture:retrieval-governance',
      }));
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const workspaceRoot = join(dataRoot, 'workspaces', workspace.id);
  const runtimeConfigManager = createRuntimeConfigManager({ dataRoot });
  return {
    dataRoot,
    workspaceId: workspace.id,
    workspaceRoot,
    store,
    userId,
    notebook: new KnowledgeNotebook({
      repositoryPath: join(workspaceRoot, 'knowledge', 'notebook.git'),
    }),
    app: createApp({ coreDb, dataRoot, store, runtimeConfigManager }),
    runtimeConfigManager,
    access: {
      store,
      coreDb,
      actor: { kind: 'user', id: userId },
      requestActor: { kind: 'local', userId },
    },
  };
}

/** Uses the actual native command/header and current shared Core root for every page publication. */
async function operation(fixture: Fixture, name: string, input: Record<string, unknown>) {
  const response = await fixture.app.request(`/api/app/operations/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-openkit-request-id': randomUUID() },
    body: JSON.stringify({ workspaceId: fixture.workspaceId, ...input }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}

/** Publishes source-free or source-admitted human evidence at the exact current base. */
async function createEntry(
  fixture: Fixture,
  title: string,
  content: string,
  sourceReferences: string[] = []
) {
  const files = fixture.notebook.inspectRevision(fixture.notebook.publishedRevision()).entries;
  const id = `page-${String(Object.keys(files).length).padStart(4, '0')}`;
  await operation(fixture, 'knowledge.notebook.create', {
    baseRevision: fixture.notebook.publishedRevision(),
    path: `${id}.md`,
    content: serializeKnowledgePageFixture(
      {
        title,
        content,
        sourceReferences,
        createdAt: '2026-10-19T00:00:00.000Z',
        updatedAt: '2026-10-19T00:00:00.000Z',
      },
      { kind: 'workspace', workspaceId: fixture.workspaceId }
    ),
    summary: 'Publish retrieval governance evidence',
  });
  const listed = await operation(fixture, 'knowledge.notebook.list', {});
  return KnowledgeNotebookPageSchema.parse(
    listed.pages.find((page: { id: string }) => page.id === id)
  );
}

/** Observes the same exact published Git bytes used by the retrieval owner. */
function readPage(fixture: Fixture, id: string): string {
  return fixture.notebook.readRevision(fixture.notebook.publishedRevision(), [`${id}.md`]).files[
    `${id}.md`
  ]!;
}

/** Keeps each native publication within the existing changed-file bound. */
async function publishPages(
  fixture: Fixture,
  changes: readonly { path: string; content: string }[]
) {
  return operation(fixture, 'knowledge.notebook.update', {
    baseRevision: fixture.notebook.publishedRevision(),
    changes,
    summary: 'Governed retrieval fixture',
  });
}

async function updatePageFields(
  fixture: Fixture,
  id: string,
  fields: Readonly<Record<string, string>>
): Promise<void> {
  let content = readPage(fixture, id);
  for (const [field, value] of Object.entries(fields)) {
    const expression = new RegExp(`^${field}: .+$`, 'm');
    if (!expression.test(content)) throw new Error(`Fixture field is missing: ${field}.`);
    content = content.replace(expression, `${field}: ${JSON.stringify(value)}`);
  }
  await publishPages(fixture, [{ path: `${id}.md`, content }]);
}

function retrievalInput(fixture: Fixture, query: string) {
  return {
    access: fixture.access,
    caller: 'app-api' as const,
    dataRoot: fixture.dataRoot,
    workspaceId: fixture.workspaceId,
    query,
    now: () => NOW,
  };
}

function pageReference(fixture: Fixture, objectId: string) {
  return {
    scopeId: `page/workspace/${fixture.workspaceId}/${readDefaultKnowledgeBaseId({ dataRoot: fixture.dataRoot, scope: { kind: 'workspace', workspaceId: fixture.workspaceId } })}`,
    objectId,
  };
}

function exclusionReasons(trace: {
  excluded: Array<{ reference: { objectId: string }; reason: string }>;
}): Record<string, string> {
  return Object.fromEntries(
    trace.excluded.map((candidate) => [candidate.reference.objectId, candidate.reason])
  );
}

function onlyRetrievalGeneration(fixture: Fixture): string {
  const pointers = findNamedFiles(join(fixture.workspaceRoot, 'indexes', 'retrieval'), 'CURRENT');
  expect(pointers).toHaveLength(1);
  return readFileSync(pointers[0]!, 'utf8');
}

function readTraceBytes(fixture: Fixture): string {
  const root = join(fixture.workspaceRoot, 'threads');
  if (!existsSync(root)) return '';
  return findNamedFiles(root, '.json', true)
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
}

function findNamedFiles(root: string, name: string, suffix = false): string[] {
  if (!existsSync(root)) return [];
  const paths: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...findNamedFiles(path, name, suffix));
    else if (entry.isFile() && (suffix ? entry.name.endsWith(name) : entry.name === name)) {
      paths.push(path);
    }
  }
  return paths;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function traceId(index: number): string {
  return testEntityId('krt', `retrieval-trace-${index}`);
}

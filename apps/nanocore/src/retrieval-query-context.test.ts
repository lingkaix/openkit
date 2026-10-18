// openkit-test-platform: posix

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KnowledgePageReferenceSchema,
  KnowledgeRetrievalTraceSchema,
  RetrieveKnowledgeRequestSchema,
} from '@openkit/app-api-schemas';
import {
  type ActorRef,
  formatReferenceUri,
  PageReferenceSchema,
  RetrievalTraceReferenceSchema,
  ScopeQualifiedReferenceSchema,
  WorkspaceRecordSchema,
} from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { readDefaultKnowledgeBaseId } from './config/knowledge-base.js';
import { KnowledgeNotebook } from './knowledge/notebook.js';
import { validateNotebookCandidate } from './knowledge/notebook-validation.js';
import { parseOkfDocument, stringListFrontmatterField } from './knowledge/okf.js';
import { FsStore } from './lib/store.js';
import {
  collectKnowledgeInventory,
  knowledgeSourceReferencesReadable,
} from './retrieval-knowledge-adapter.js';
import { closeRetrievalServices } from './retrieval-service.js';
import { readDataRootLayoutMarker } from './storage/fs-layout.js';
import {
  assertKnowledgeRetrievalTraceReadable,
  type KnowledgeRetrievalAccess,
  type RetrieveWorkspaceKnowledgeInput,
  resolveWorkspaceKnowledgeRetrievalPages,
  retrieveWorkspaceKnowledge,
} from './storage/index-rebuild.js';
import { serializeUserAuthoredKnowledgePage } from './storage/workspace-file-records.js';
import { testEntityId } from './test-support/entity-ids.js';
import { notebookImportFixture } from './test-support/notebook-import.js';

const ACTOR = {
  kind: 'user',
  id: 'usr_00000000-0000-7000-8000-000000000001',
} as const satisfies ActorRef;
const REQUEST_ACTOR = {
  kind: 'local',
  userId: 'usr_00000000-0000-7000-8000-000000000001',
} as const;
const NOW = '2026-10-15T12:00:00.000Z';

const testRoots: string[] = [];
afterEach(async () => {
  await closeRetrievalServices();
  for (const root of testRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('retrieval query context, references, and query-owned traces', () => {
  it('enforces the fixed scope grammar through current kind owners', async () => {
    const fixture = createFixture('scope-grammar');
    const thread = fixture.store.createThread(fixture.workspaceId, 'Query thread');
    const turn = fixture.store.createTurn(fixture.workspaceId, thread.id, 'Query', ACTOR);
    const page = { scopeId: pageScope(fixture), objectId: 'release/plan' };
    const turnTrace = {
      scopeId: `retrieval-trace/turn/${fixture.workspaceId}/${thread.id}/${turn.id}`,
      objectId: traceId(1),
    };
    const threadTrace = {
      scopeId: `retrieval-trace/thread/${fixture.workspaceId}/${thread.id}`,
      objectId: traceId(2),
    };

    expect(ScopeQualifiedReferenceSchema.safeParse(page).success).toBe(true);
    expect(ScopeQualifiedReferenceSchema.safeParse(turnTrace).success).toBe(true);
    expect(PageReferenceSchema.safeParse(page).success).toBe(true);
    expect(
      PageReferenceSchema.safeParse({
        scopeId: 'page/server/kb_00000000-0000-7000-8000-000000000001',
        objectId: 'release/plan',
      }).success
    ).toBe(true);
    expect(
      PageReferenceSchema.safeParse({
        scopeId: `page/user/${ACTOR.id}/kb_00000000-0000-7000-8000-000000000001`,
        objectId: 'release/plan',
      }).success
    ).toBe(true);
    expect(
      PageReferenceSchema.safeParse({
        scopeId: 'page/user/0123456789abcdefghijklmnopqrstuv',
        objectId: 'release/plan',
      }).success
    ).toBe(false);
    expect(RetrievalTraceReferenceSchema.safeParse(turnTrace).success).toBe(true);
    expect(RetrievalTraceReferenceSchema.safeParse(threadTrace).success).toBe(true);

    for (const invalid of [
      { scopeId: `page/workspace/${fixture.workspaceId}`, objectId: 'release/plan' },
      { scopeId: `page/user/${ACTOR.id}`, objectId: 'release/plan' },
      { scopeId: 'page/server', objectId: 'release/plan' },
      { scopeId: `page/workspace/${thread.id}`, objectId: 'release/plan' },
      { scopeId: `page/workspace/${fixture.workspaceId}/extra`, objectId: 'release/plan' },
      { scopeId: 'page/workspace//', objectId: 'release/plan' },
      { scopeId: 'page/workspace/.', objectId: 'release/plan' },
      { scopeId: 'page/workspace/..', objectId: 'release/plan' },
      { scopeId: `retrieval-trace/turn/${fixture.workspaceId}/${thread.id}`, objectId: traceId(1) },
      {
        scopeId: `retrieval-trace/thread/${fixture.workspaceId}/${thread.id}/${turn.id}`,
        objectId: traceId(1),
      },
    ]) {
      expect(
        ScopeQualifiedReferenceSchema.safeParse(invalid).success,
        JSON.stringify(invalid)
      ).toBe(false);
    }
    expect(PageReferenceSchema.safeParse(turnTrace).success).toBe(false);
    expect(RetrievalTraceReferenceSchema.safeParse(page).success).toBe(false);
    expect(
      KnowledgePageReferenceSchema.safeParse({ scopeId: page.scopeId, objectId: '../plan' }).success
    ).toBe(false);
  });

  it('accepts only narrowing sourceScope and scope-qualified pins in the public request', () => {
    const fixture = createFixture('request-schema');
    const pin = { scopeId: pageScope(fixture), objectId: 'release/plan' };

    expect(
      RetrieveKnowledgeRequestSchema.safeParse({ query: 'release', pinnedReferences: [pin] })
        .success
    ).toBe(true);
    expect(
      RetrieveKnowledgeRequestSchema.safeParse({
        query: 'release',
        pinnedReferences: [],
        sourceScope: 'workspace',
      }).success
    ).toBe(true);
    expect(
      RetrieveKnowledgeRequestSchema.safeParse({
        query: 'release',
        pinnedReferences: [],
        sourceScope: 'server',
      }).success
    ).toBe(true);
    expect(
      RetrieveKnowledgeRequestSchema.safeParse({
        query: 'release',
        pinnedReferences: [],
        sourceScope: 'user',
      }).success
    ).toBe(false);
    expect(
      RetrieveKnowledgeRequestSchema.safeParse({
        query: 'release',
        pinnedReferences: [],
        sourceScope: pageScope(fixture),
      }).success
    ).toBe(false);
    expect(
      RetrieveKnowledgeRequestSchema.safeParse({
        query: 'release',
        pinnedConceptIds: ['release/plan'],
      }).success
    ).toBe(false);
    expect(
      RetrieveKnowledgeRequestSchema.safeParse({
        query: 'release',
        pinnedReferences: [
          { scopeId: 'page/server/kb_00000000-0000-7000-8000-000000000001', objectId: '../plan' },
        ],
      }).success
    ).toBe(false);
  });

  it('returns qualified selection without publishing evidence for a threadless App query', async () => {
    const fixture = createFixture('threadless');
    const page = createEntry(fixture, 'Threadless marker', 'threadless-marker body-private-marker');
    const result = await retrieveWorkspaceKnowledge(fixture.input('threadless-marker'));

    expect(result.selected).toEqual([
      expect.objectContaining({
        reference: { scopeId: pageScope(fixture), objectId: page.id },
      }),
    ]);
    expect(result).not.toHaveProperty('traceId');
    expect(result).not.toHaveProperty('retrievalTraceRef');
    expect(JSON.stringify(result)).not.toContain('knowledgePageId');
    expect(
      resolveWorkspaceKnowledgeRetrievalPages({
        dataRoot: fixture.dataRoot,
        workspaceId: fixture.workspaceId,
        caller: 'app-api',
        access: fixture.access,
        selection: result,
      })
    ).toEqual([
      expect.objectContaining({
        reference: { scopeId: pageScope(fixture), objectId: page.id },
        content: expect.stringContaining('body-private-marker'),
      }),
    ]);
    await expect(
      retrieveWorkspaceKnowledge({ ...fixture.input('threadless-marker'), caller: 'assistant' })
    ).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
    expect(findTraceFiles(fixture.workspaceRoot)).toEqual([]);
    expect(existsSync(join(fixture.workspaceRoot, 'knowledge', 'traces'))).toBe(false);
  });

  it('refuses another Knowledge Base for the same owner and page before disclosure', async () => {
    const fixture = createFixture('wrong-knowledge-base');
    const page = createEntry(fixture, 'Exact base', 'exact-base-private-marker');
    const selected = await retrieveWorkspaceKnowledge(fixture.input('exact-base-private-marker'));
    expect(selected.selected[0]).not.toHaveProperty('contentRef');
    const knowledgeBaseId = readDefaultKnowledgeBaseId({
      dataRoot: fixture.dataRoot,
      scope: { kind: 'workspace', workspaceId: fixture.workspaceId },
    });
    const wrongBase = 'kb_00000000-0000-7000-8000-000000000009';
    expect(knowledgeBaseId).not.toBe(wrongBase);
    const reference = {
      scopeId: `page/workspace/${fixture.workspaceId}/${wrongBase}`,
      objectId: page.id,
    };
    await expect(
      retrieveWorkspaceKnowledge({
        ...fixture.input('exact-base-private-marker'),
        pinnedReferences: [reference],
      })
    ).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
    expect(() =>
      resolveWorkspaceKnowledgeRetrievalPages({
        dataRoot: fixture.dataRoot,
        workspaceId: fixture.workspaceId,
        caller: 'app-api',
        access: fixture.access,
        selection: {
          ...selected,
          sourceScope: reference.scopeId,
          selected: selected.selected.map((entry) => ({ ...entry, reference })),
        },
      })
    ).toThrowError(expect.objectContaining({ code: 'workspace_access_denied', status: 403 }));
    expect(
      JSON.parse(collectKnowledgeInventory(fixture.input('exact-base-private-marker')).view.scope)
    ).toContain(knowledgeBaseId);
    expect(
      resolveWorkspaceKnowledgeRetrievalPages({
        dataRoot: fixture.dataRoot,
        workspaceId: fixture.workspaceId,
        caller: 'app-api',
        access: fixture.access,
        selection: selected,
      })?.[0]
    ).toMatchObject({
      knowledgeBaseId,
      reference: { scopeId: pageScope(fixture), objectId: page.id },
    });
    const sourceReference = { scopeId: pageScope(fixture), objectId: page.id };
    const sourceDigest = sha256(readPage(fixture, page.id));
    const sourceInput = { ...fixture.input('exact-base-private-marker') };
    expect(
      knowledgeSourceReferencesReadable(sourceInput, 'consumer', [
        formatReferenceUri(sourceReference, sourceDigest),
      ])
    ).toBe(true);
    for (const invalid of [
      formatReferenceUri(reference, sourceDigest),
      formatReferenceUri(sourceReference, `sha256:${'0'.repeat(64)}`),
      formatReferenceUri({
        ...sourceReference,
        scopeId: sourceReference.scopeId.replace('page/', 'raw/'),
      }),
      `knowledge:${page.id}`,
    ]) {
      expect(knowledgeSourceReferencesReadable(sourceInput, 'consumer', [invalid]), invalid).toBe(
        false
      );
    }
    expect(findTraceFiles(fixture.workspaceRoot)).toEqual([]);
  });

  it('normalizes qualified pins and refuses source widening before a trace effect', async () => {
    const fixture = createFixture('pins');
    const higher = createEntry(
      fixture,
      'Release cadence release cadence',
      'release cadence release cadence'
    );
    const pinned = createEntry(fixture, 'Other notes', 'release cadence');
    const ordinary = await retrieveWorkspaceKnowledge({
      ...fixture.input('release cadence'),
      limit: 2,
    });
    const scores = new Map(
      ordinary.selected.map((candidate) => [candidate.reference.objectId, candidate.score])
    );
    const withPin = await retrieveWorkspaceKnowledge({
      ...fixture.input('release cadence'),
      limit: 2,
      pinnedReferences: [
        { scopeId: pageScope(fixture), objectId: pinned.id },
        { scopeId: pageScope(fixture), objectId: pinned.id },
      ],
    });

    expect(ordinary.selected[0]?.reference.objectId).toBe(higher.id);
    expect(withPin.selected.map((candidate) => candidate.reference.objectId)).toEqual([
      pinned.id,
      higher.id,
    ]);
    expect(withPin.selected.map((candidate) => candidate.score)).toEqual([
      scores.get(pinned.id),
      scores.get(higher.id),
    ]);
    expect(withPin.retrievalParameters.pinnedReferences).toEqual([
      { scopeId: pageScope(fixture), objectId: pinned.id },
    ]);
    await expect(
      retrieveWorkspaceKnowledge({
        ...fixture.input('release cadence'),
        pinnedReferences: [
          { scopeId: 'page/server/kb_00000000-0000-7000-8000-000000000001', objectId: pinned.id },
        ],
      })
    ).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
    await expect(
      retrieveWorkspaceKnowledge({
        ...fixture.input('release cadence'),
        pinnedReferences: [
          { scopeId: 'page/server/kb_00000000-0000-7000-8000-000000000001', objectId: pinned.id },
          { scopeId: pageScope(fixture), objectId: pinned.id },
        ],
      })
    ).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
    await expect(
      retrieveWorkspaceKnowledge({ ...fixture.input('release cadence'), sourceScope: 'server' })
    ).rejects.toMatchObject({ code: 'workspace_access_denied', status: 403 });
    expect(findTraceFiles(fixture.workspaceRoot)).toEqual([]);
  });

  it('validates trusted lineage and publishes one content-free immutable trace per query act', async () => {
    const fixture = createFixture('trace-placement');
    const page = createEntry(
      fixture,
      'Trace title private marker',
      'trace-placement-marker source-body-private-marker'
    );
    const overflow = createEntry(
      fixture,
      'Other trace page',
      'trace-placement-marker overflow-private-marker'
    );
    const thread = fixture.store.createThread(fixture.workspaceId, 'Retrieval thread');
    const turn = fixture.store.createTurn(fixture.workspaceId, thread.id, 'Trace request', ACTOR);
    const threadTraceId = traceId(10);
    const turnTraceId = traceId(11);
    const threadSelection = await retrieveWorkspaceKnowledge({
      ...fixture.input('trace-placement-marker'),
      access: { ...fixture.access, outputThreadId: thread.id },
      limit: 1,
      traceId: threadTraceId,
    });
    const turnSelection = await retrieveWorkspaceKnowledge({
      ...fixture.input('trace-placement-marker'),
      caller: 'task-mode',
      access: { ...fixture.access, outputThreadId: thread.id, outputTurnId: turn.id },
      limit: 1,
      traceId: turnTraceId,
    });
    const threadReference = {
      scopeId: `retrieval-trace/thread/${fixture.workspaceId}/${thread.id}`,
      objectId: threadTraceId,
    };
    const turnReference = {
      scopeId: `retrieval-trace/turn/${fixture.workspaceId}/${thread.id}/${turn.id}`,
      objectId: turnTraceId,
    };

    expect(threadSelection.retrievalTraceRef).toEqual(threadReference);
    expect(turnSelection.retrievalTraceRef).toEqual(turnReference);
    expect(threadSelection).not.toHaveProperty('traceId');
    expect(turnSelection).not.toHaveProperty('traceId');

    const threadPath = join(
      fixture.workspaceRoot,
      'threads',
      thread.id,
      'retrieval-traces',
      `${threadTraceId}.json`
    );
    const turnPath = join(
      fixture.workspaceRoot,
      'threads',
      thread.id,
      'turns',
      turn.id,
      'retrieval-traces',
      `${turnTraceId}.json`
    );
    const threadBytes = readFileSync(threadPath, 'utf8');
    const turnBytes = readFileSync(turnPath, 'utf8');
    const parsedThread = KnowledgeRetrievalTraceSchema.parse(JSON.parse(threadBytes));
    const parsedTurn = KnowledgeRetrievalTraceSchema.parse(JSON.parse(turnBytes));
    const serverId = readDataRootLayoutMarker(fixture.dataRoot).deploymentId;

    expect(parsedThread).toMatchObject({
      traceId: threadTraceId,
      queryContext: {
        serverId,
        workspaceId: fixture.workspaceId,
        actor: ACTOR,
        threadId: thread.id,
      },
      sourceScope: pageScope(fixture),
      selected: [
        expect.objectContaining({
          reference: { scopeId: pageScope(fixture), objectId: page.id },
        }),
      ],
      excluded: [
        expect.objectContaining({
          reference: { scopeId: pageScope(fixture), objectId: overflow.id },
          reason: 'budget_exceeded',
        }),
      ],
    });
    expect(parsedThread.queryContext.turnId).toBeUndefined();
    expect(parsedTurn).toMatchObject({
      traceId: turnTraceId,
      queryContext: {
        serverId,
        workspaceId: fixture.workspaceId,
        actor: ACTOR,
        threadId: thread.id,
        turnId: turn.id,
      },
      sourceScope: pageScope(fixture),
    });
    for (const bytes of [threadBytes, turnBytes]) {
      expect(bytes).not.toContain('trace-placement-marker');
      expect(bytes).not.toContain('source-body-private-marker');
      expect(bytes).not.toContain('Trace title private marker');
      expect(bytes).not.toContain('overflow-private-marker');
      expect(bytes).not.toContain('"score"');
      expect(bytes).not.toContain('knowledgePageId');
    }
    expect(findTraceFiles(fixture.workspaceRoot).sort()).toEqual([threadPath, turnPath].sort());

    const otherThread = fixture.store.createThread(fixture.workspaceId, 'Other thread');
    await expect(
      retrieveWorkspaceKnowledge({
        ...fixture.input('trace-placement-marker'),
        access: {
          ...fixture.access,
          outputThreadId: otherThread.id,
          outputTurnId: turn.id,
        },
        traceId: traceId(12),
      })
    ).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
    expect(findTraceFiles(fixture.workspaceRoot).sort()).toEqual([threadPath, turnPath].sort());

    await expect(
      retrieveWorkspaceKnowledge({
        ...fixture.input('trace-placement-marker changed'),
        access: { ...fixture.access, outputThreadId: thread.id },
        traceId: threadTraceId,
      })
    ).rejects.toMatchObject({ code: 'idempotency_key_conflict', status: 409 });
    expect(readFileSync(threadPath, 'utf8')).toBe(threadBytes);
    expect(
      readdirSync(join(fixture.workspaceRoot, 'threads', thread.id, 'retrieval-traces'))
    ).toEqual([`${threadTraceId}.json`]);
  });

  it('rechecks source access when resolving a persisted trace reference', async () => {
    const fixture = createFixture('revocation');
    const destination = fixture.store.createThread(
      fixture.workspaceId,
      'Private destination',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: ACTOR.id }
    );
    const sourceThread = fixture.store.createThread(
      fixture.workspaceId,
      'Private source',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: ACTOR.id }
    );
    const material = 'revocation source private bytes';
    const source = fixture.store.createKnowledgeSource(
      {
        id: 'ks_00000000-0000-7bb4-9e84-6db11783ad59',
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
      material
    );
    const page = createEntry(fixture, 'Revocation page', 'revocation-marker page-private-bytes', [
      `source:${source.id}@${source.contentDigest}`,
    ]);
    const selection = await retrieveWorkspaceKnowledge({
      ...fixture.input('revocation-marker'),
      access: { ...fixture.access, outputThreadId: destination.id },
      traceId: traceId(20),
    });
    expect(selection.selected[0]?.reference).toEqual({
      scopeId: pageScope(fixture),
      objectId: page.id,
    });
    expect(selection.retrievalTraceRef).toBeDefined();

    Object.assign(sourceThread, { privateOwnerUserId: 'usr_00000000-0000-73d4-904a-d4c4b905df7c' });
    expect(() =>
      resolveWorkspaceKnowledgeRetrievalPages({
        dataRoot: fixture.dataRoot,
        workspaceId: fixture.workspaceId,
        caller: 'app-api',
        access: { ...fixture.access, outputThreadId: destination.id },
        retrievalTraceRef: selection.retrievalTraceRef!,
      })
    ).toThrow(expect.objectContaining({ code: 'workspace_access_denied', status: 403 }));
  });

  it('denies a trace when its selected page is currently restricted', async () => {
    const fixture = createFixture('restricted-metadata');
    const page = createEntry(
      fixture,
      'Restricted metadata page',
      'restricted-metadata-marker private-page-content'
    );
    const thread = fixture.store.createThread(fixture.workspaceId, 'Restricted trace owner');
    const id = traceId(25);
    const selection = await retrieveWorkspaceKnowledge({
      ...fixture.input('restricted-metadata-marker'),
      access: { ...fixture.access, outputThreadId: thread.id },
      traceId: id,
    });
    const reference = selection.retrievalTraceRef!;
    const path = join(
      fixture.workspaceRoot,
      'threads',
      thread.id,
      'retrieval-traces',
      `${id}.json`
    );
    const restrictedPageBytes = readPage(fixture, page.id).replace(
      /^sensitivity: .+$/m,
      'sensitivity: restricted'
    );
    expect(restrictedPageBytes).toContain('sensitivity: restricted');
    publishFixturePage(fixture, page.id, restrictedPageBytes);
    const restrictedRevision = fixtureNotebook(fixture).publishedRevision();
    const restrictedDigest = sha256(restrictedPageBytes);
    const originalTrace = KnowledgeRetrievalTraceSchema.parse(
      JSON.parse(readFileSync(path, 'utf8'))
    );
    const restrictedTrace = KnowledgeRetrievalTraceSchema.parse({
      ...originalTrace,
      notebookRevision: restrictedRevision,
      selected: originalTrace.selected.map((candidate) =>
        candidate.reference.objectId === page.id
          ? { ...candidate, revision: restrictedRevision, contentDigest: restrictedDigest }
          : candidate
      ),
    });
    const restrictedTraceBytes = JSON.stringify(restrictedTrace);
    writeFileSync(path, restrictedTraceBytes);

    let caught: unknown;
    try {
      assertKnowledgeRetrievalTraceReadable({
        dataRoot: fixture.dataRoot,
        workspaceId: fixture.workspaceId,
        access: { ...fixture.access, outputThreadId: thread.id },
        retrievalTraceRef: reference,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 'workspace_access_denied',
      status: 403,
      message: 'Knowledge trace or source is unavailable.',
    });
    expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain(page.id);
    expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain('private-page-content');
    expect(readFileSync(path, 'utf8')).toBe(restrictedTraceBytes);
  });

  it('rejects contradictory source metadata and every wrong-scope projected reference', async () => {
    const fixture = createFixture('trace-source-projection');
    const page = createEntry(
      fixture,
      'Projection scope page',
      'trace-source-projection-marker private-projection-content'
    );
    const thread = fixture.store.createThread(fixture.workspaceId, 'Projection trace owner');
    const id = traceId(27);
    const selection = await retrieveWorkspaceKnowledge({
      ...fixture.input('trace-source-projection-marker'),
      access: { ...fixture.access, outputThreadId: thread.id },
      traceId: id,
    });
    const reference = selection.retrievalTraceRef!;
    const path = join(
      fixture.workspaceRoot,
      'threads',
      thread.id,
      'retrieval-traces',
      `${id}.json`
    );
    const original = KnowledgeRetrievalTraceSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    const selected = original.selected[0]!;
    const foreignReference = {
      scopeId:
        'page/workspace/ws_00000000-0000-7f9c-aa14-53566c621405/kb_00000000-0000-7000-8000-000000000001',
      objectId: page.id,
    };
    const variants = [
      {
        name: 'source metadata',
        trace: {
          ...original,
          sourceScope: 'page/server/kb_00000000-0000-7000-8000-000000000001',
          selected: [],
          excluded: [],
          retrievalParameters: { ...original.retrievalParameters, pinnedReferences: [] },
        },
      },
      {
        name: 'selected reference',
        trace: {
          ...original,
          selected: [{ ...selected, reference: foreignReference }],
          excluded: [],
          retrievalParameters: { ...original.retrievalParameters, pinnedReferences: [] },
        },
      },
      {
        name: 'excluded reference',
        trace: {
          ...original,
          selected: [],
          excluded: [
            {
              reference: foreignReference,
              revision: selected.revision,
              contentDigest: selected.contentDigest,
              sourceReferences: selected.sourceReferences,
              reason: 'budget_exceeded',
            },
          ],
          retrievalParameters: { ...original.retrievalParameters, pinnedReferences: [] },
        },
      },
      {
        name: 'pinned reference',
        trace: {
          ...original,
          selected: [],
          excluded: [],
          retrievalParameters: {
            ...original.retrievalParameters,
            pinnedReferences: [foreignReference],
          },
        },
      },
    ];

    for (const variant of variants) {
      const bytes = JSON.stringify(KnowledgeRetrievalTraceSchema.parse(variant.trace));
      writeFileSync(path, bytes);
      let caught: unknown;
      try {
        assertKnowledgeRetrievalTraceReadable({
          dataRoot: fixture.dataRoot,
          workspaceId: fixture.workspaceId,
          access: { ...fixture.access, outputThreadId: thread.id },
          retrievalTraceRef: reference,
        });
      } catch (error) {
        caught = error;
      }
      expect.soft(caught, variant.name).toMatchObject({
        code: 'workspace_access_denied',
        status: 403,
        message: 'Knowledge trace or source is unavailable.',
      });
      expect
        .soft(`${String(caught)} ${JSON.stringify(caught)}`, variant.name)
        .not.toContain(page.id);
      expect
        .soft(`${String(caught)} ${JSON.stringify(caught)}`, variant.name)
        .not.toContain('private-projection-content');
      expect.soft(readFileSync(path, 'utf8'), variant.name).toBe(bytes);
    }
  });

  it('withholds a stale private source reference after the page removes it', async () => {
    const fixture = createFixture('stale-source-reference');
    const destination = fixture.store.createThread(
      fixture.workspaceId,
      'Private destination',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: ACTOR.id }
    );
    const sourceThread = fixture.store.createThread(
      fixture.workspaceId,
      'Private source',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: ACTOR.id }
    );
    const material = 'stale source reference private material';
    const source = fixture.store.createKnowledgeSource(
      {
        id: 'ks_00000000-0000-7359-ac61-fab2907627df',
        workspaceId: fixture.workspaceId,
        kind: 'document',
        title: 'Former private source',
        uri: null,
        contentDigest: sha256(material),
        originatingThreadId: sourceThread.id,
        originatingTurnId: null,
        originatingFileId: null,
        capturedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      },
      material
    );
    const sourceReference = `source:${source.id}@${source.contentDigest}`;
    const page = createEntry(
      fixture,
      'Former source page',
      'stale-source-reference-marker current-page-content',
      [sourceReference]
    );
    const id = traceId(28);
    const selection = await retrieveWorkspaceKnowledge({
      ...fixture.input('stale-source-reference-marker'),
      access: { ...fixture.access, outputThreadId: destination.id },
      traceId: id,
    });
    const reference = selection.retrievalTraceRef!;
    const path = join(
      fixture.workspaceRoot,
      'threads',
      destination.id,
      'retrieval-traces',
      `${id}.json`
    );
    expect(
      assertKnowledgeRetrievalTraceReadable({
        dataRoot: fixture.dataRoot,
        workspaceId: fixture.workspaceId,
        access: { ...fixture.access, outputThreadId: destination.id },
        retrievalTraceRef: reference,
      }).selected[0]?.sourceReferences
    ).toEqual([sourceReference]);

    const immutableTraceBytes = readFileSync(path, 'utf8');
    const currentPageBytes = readPage(fixture, page.id);
    expect(currentPageBytes).toContain(`source_refs: ${JSON.stringify([sourceReference])}`);
    const withoutFormerSource = currentPageBytes.replace(/^source_refs: .+$/m, 'source_refs: []');
    publishFixturePage(fixture, page.id, withoutFormerSource);
    Object.assign(sourceThread, { privateOwnerUserId: 'usr_00000000-0000-73d4-904a-d4c4b905df7c' });

    let caught: unknown;
    try {
      assertKnowledgeRetrievalTraceReadable({
        dataRoot: fixture.dataRoot,
        workspaceId: fixture.workspaceId,
        access: { ...fixture.access, outputThreadId: destination.id },
        retrievalTraceRef: reference,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 'workspace_access_denied',
      status: 403,
      message: 'Knowledge trace or source is unavailable.',
    });
    expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain(source.id);
    expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain(source.contentDigest);
    expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain(material);
    expect(readFileSync(path, 'utf8')).toBe(immutableTraceBytes);
  });

  it('withholds restricted and closed-core-invalid Knowledge source pages', async () => {
    const fixture = createFixture('nested-knowledge-sensitivity');
    const provenance = createEntry(
      fixture,
      'Origin evidence page',
      'origin-evidence-private-content'
    );
    const sourceReference = formatReferenceUri({
      scopeId: pageScope(fixture),
      objectId: provenance.id,
    });
    const selected = createEntry(
      fixture,
      'Selected recursive source page',
      'recursive-target-needle-xyq selected-current-content',
      [sourceReference]
    );
    const thread = fixture.store.createThread(fixture.workspaceId, 'Nested source trace owner');
    const id = traceId(29);
    const selection = await retrieveWorkspaceKnowledge({
      ...fixture.input('recursive-target-needle-xyq'),
      access: { ...fixture.access, outputThreadId: thread.id },
      traceId: id,
    });
    expect(selection.selected).toEqual([
      expect.objectContaining({
        reference: { scopeId: pageScope(fixture), objectId: selected.id },
        sourceReferences: [sourceReference],
      }),
    ]);
    const reference = selection.retrievalTraceRef!;
    const path = join(
      fixture.workspaceRoot,
      'threads',
      thread.id,
      'retrieval-traces',
      `${id}.json`
    );
    const immutableTraceBytes = readFileSync(path, 'utf8');
    const provenanceBytes = readPage(fixture, provenance.id);
    const variants = [
      {
        name: 'restricted',
        bytes: provenanceBytes.replace(/^sensitivity: .+$/m, 'sensitivity: restricted'),
      },
      {
        name: 'missing sensitivity',
        bytes: provenanceBytes.replace(/^sensitivity: .+\n/m, ''),
      },
      { name: 'malformed page', bytes: 'origin-evidence-private-content\n' },
    ];
    expect(variants[0]!.bytes).toContain('sensitivity: restricted');
    expect(variants[1]!.bytes).not.toContain('sensitivity:');

    for (const variant of variants) {
      publishFixturePage(fixture, provenance.id, variant.bytes);
      let caught: unknown;
      try {
        assertKnowledgeRetrievalTraceReadable({
          dataRoot: fixture.dataRoot,
          workspaceId: fixture.workspaceId,
          access: { ...fixture.access, outputThreadId: thread.id },
          retrievalTraceRef: reference,
        });
      } catch (error) {
        caught = error;
      }
      expect.soft(caught, variant.name).toMatchObject({
        code: 'workspace_access_denied',
        status: 403,
        message: 'Knowledge trace or source is unavailable.',
      });
      expect
        .soft(`${String(caught)} ${JSON.stringify(caught)}`, variant.name)
        .not.toContain(provenance.id);
      expect
        .soft(`${String(caught)} ${JSON.stringify(caught)}`, variant.name)
        .not.toContain(sha256(variant.bytes));
      expect
        .soft(`${String(caught)} ${JSON.stringify(caught)}`, variant.name)
        .not.toContain('origin-evidence-private-content');
      expect.soft(readFileSync(path, 'utf8'), variant.name).toBe(immutableTraceBytes);
    }
  });

  it('keeps an imported Server reference unavailable under target-local context', async () => {
    const fixture = createFixture('imported-server', {
      sourceDeploymentId: 'dep_00000000-0000-7737-8fe7-61ca07c79d45',
      sourceWorkspaceId: 'ws_00000000-0000-71b1-9af2-985861a05396',
      exportCreatedAt: NOW,
      manifestDigest: sha256('source export manifest'),
    });
    const page = createEntry(
      fixture,
      'Target-only page title',
      'imported-server-marker target-private-content'
    );
    const thread = fixture.store.createThread(fixture.workspaceId, 'Imported trace owner');
    const id = traceId(30);
    const selection = await retrieveWorkspaceKnowledge({
      ...fixture.input('imported-server-marker'),
      access: { ...fixture.access, outputThreadId: thread.id },
      traceId: id,
    });
    const reference = selection.retrievalTraceRef!;
    const path = join(
      fixture.workspaceRoot,
      'threads',
      thread.id,
      'retrieval-traces',
      `${id}.json`
    );
    const original = KnowledgeRetrievalTraceSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    const targetServerId = readDataRootLayoutMarker(fixture.dataRoot).deploymentId;
    expect(fixture.store.getWorkspace(fixture.workspaceId).importedFrom).toMatchObject({
      sourceDeploymentId: 'dep_00000000-0000-7737-8fe7-61ca07c79d45',
      sourceWorkspaceId: 'ws_00000000-0000-71b1-9af2-985861a05396',
    });
    expect(
      fixture.store.getWorkspace(fixture.workspaceId).importedFrom?.sourceDeploymentId
    ).not.toBe(targetServerId);
    expect(original.queryContext.serverId).toBe(targetServerId);
    expect(original).not.toHaveProperty('importedFrom');
    expect(
      resolveWorkspaceKnowledgeRetrievalPages({
        dataRoot: fixture.dataRoot,
        workspaceId: fixture.workspaceId,
        caller: 'app-api',
        access: { ...fixture.access, outputThreadId: thread.id },
        retrievalTraceRef: reference,
      })
    ).toEqual([
      expect.objectContaining({
        reference: { scopeId: pageScope(fixture), objectId: page.id },
        content: expect.stringContaining('target-private-content'),
      }),
    ]);
    const sourceScope = 'page/server/kb_00000000-0000-7000-8000-000000000001';
    // Import remints the containing records while retaining the Server whose Knowledge was selected.
    const importedQueryContext = {
      ...original.queryContext,
      serverId: fixture.store.getWorkspace(fixture.workspaceId).importedFrom!.sourceDeploymentId,
    };
    const imported = KnowledgeRetrievalTraceSchema.parse({
      ...original,
      queryContext: importedQueryContext,
      sourceScope,
      requestDigest: sha256(
        canonicalJson({
          queryContext: importedQueryContext,
          sourceScope,
          caller: original.caller,
          request: {
            query: 'imported-server-marker',
            limit: 5,
            pinnedReferences: [],
            states: ['active'],
            sourceScope: 'server',
          },
        })
      ),
      retrievalParameters: {
        ...original.retrievalParameters,
        sourceScope: 'server',
        pinnedReferences: [],
      },
      selected: original.selected.map((candidate) => ({
        ...candidate,
        reference: { scopeId: sourceScope, objectId: candidate.reference.objectId },
      })),
    });
    expect(imported).not.toHaveProperty('importedFrom');
    const importedBytes = JSON.stringify(imported);
    writeFileSync(path, importedBytes);

    let caught: unknown;
    try {
      resolveWorkspaceKnowledgeRetrievalPages({
        dataRoot: fixture.dataRoot,
        workspaceId: fixture.workspaceId,
        caller: 'app-api',
        access: { ...fixture.access, outputThreadId: thread.id },
        retrievalTraceRef: reference,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 'workspace_access_denied',
      status: 403,
      message: 'Knowledge trace or source is unavailable.',
    });
    expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain(page.id);
    expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain('target-private-content');
    expect(readFileSync(path, 'utf8')).toBe(importedBytes);
  });
});

interface Fixture {
  dataRoot: string;
  workspaceId: string;
  workspaceRoot: string;
  store: FsStore;
  access: KnowledgeRetrievalAccess;
  input(query: string): RetrieveWorkspaceKnowledgeInput;
}

function createFixture(
  label: string,
  importedFrom?: {
    sourceDeploymentId: string;
    sourceWorkspaceId: string;
    exportCreatedAt: string;
    manifestDigest: string;
  }
): Fixture {
  const dataRoot = mkdtempSync(join(tmpdir(), `openkit-retrieval-context-${label}-`));
  testRoots.push(dataRoot);
  const store = new FsStore({ dataRoot });
  const workspace = importedFrom
    ? store.importWorkspaceSnapshot({
        ...notebookImportFixture({
          workspaceId: testEntityId('ws', `imported-${label}`),
          knowledge: [],
        }),
        workspace: WorkspaceRecordSchema.parse({
          id: testEntityId('ws', `imported-${label}`),
          name: label,
          kind: 'general',
          status: 'active',
          counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
          importedFrom,
          createdAt: NOW,
          updatedAt: NOW,
        }),
        threads: [],
        turns: [],
        knowledge: [],
        itemRevisions: [],
        artifacts: [],
        agentSessions: [],
        turnEvents: [],
      })
    : store.createWorkspace(label, {
        requestId: randomUUID(),
        producer: ACTOR,
        instructionReference: 'test-fixture:retrieval-query-context',
      });
  const workspaceRoot = join(dataRoot, 'workspaces', workspace.id);
  const access: KnowledgeRetrievalAccess = {
    store,
    actor: ACTOR,
    requestActor: REQUEST_ACTOR,
  };
  return {
    dataRoot,
    workspaceId: workspace.id,
    workspaceRoot,
    store,
    access,
    input: (query) => ({
      dataRoot,
      workspaceId: workspace.id,
      access,
      caller: 'app-api',
      query,
      now: () => NOW,
    }),
  };
}

/** Admits authored profile-v4 fixture content into the same Git tree that the retrieval reader observes. */
function createEntry(
  fixture: Fixture,
  title: string,
  content: string,
  sourceReferences?: string[]
) {
  const notebook = fixtureNotebook(fixture);
  const base = notebook.readRevision(notebook.publishedRevision());
  const entry = {
    id: `note-${String(Object.keys(base.files).length).padStart(4, '0')}`,
    kind: 'project-context' as const,
    title,
    content,
    sourceReferences: sourceReferences ?? [],
    createdAt: NOW,
    updatedAt: NOW,
  };
  const bytes = serializeUserAuthoredKnowledgePage(entry, {
    kind: 'workspace',
    workspaceId: fixture.workspaceId,
  });
  const checked = validateNotebookCandidate({
    ownerScope: { kind: 'workspace', workspaceId: fixture.workspaceId },
    pageScopeId: pageScope(fixture),
    base,
    candidate: { files: { ...base.files, [`${entry.id}.md`]: bytes } },
    scopeSchemaText: readFileSync(
      join(fixture.workspaceRoot, 'knowledge', 'schema', 'scope-schema.yaml'),
      'utf8'
    ),
    registeredSources: new Map(
      fixture.store
        .listKnowledgeSources(fixture.workspaceId)
        .map((source) => [source.id, source.contentDigest])
    ),
    resolvedReferences: new Map(),
  });
  expect(checked.errors).toEqual([]);
  publishFixturePage(fixture, entry.id, bytes);
  return entry;
}

function pageScope(fixture: Fixture): string {
  return `page/workspace/${fixture.workspaceId}/${readDefaultKnowledgeBaseId({ dataRoot: fixture.dataRoot, scope: { kind: 'workspace', workspaceId: fixture.workspaceId } })}`;
}

/** The same immutable Git owner used by retrieval; no materialized pages tree is authoritative. */
function fixtureNotebook(fixture: Fixture): KnowledgeNotebook {
  return new KnowledgeNotebook({
    repositoryPath: join(fixture.workspaceRoot, 'knowledge', 'notebook.git'),
  });
}

/** Reads the exact current page from its published commit. */
function readPage(fixture: Fixture, pageId: string): string {
  const notebook = fixtureNotebook(fixture);
  return notebook.readRevision(notebook.publishedRevision(), [`${pageId}.md`]).files[
    `${pageId}.md`
  ]!;
}

/** Seeds exact retained Git bytes, including deliberate corruption, without weakening the reader's oracle or invoking a retired Store writer. */
function publishFixturePage(fixture: Fixture, pageId: string, content: string): void {
  const notebook = fixtureNotebook(fixture);
  const baseRevision = notebook.publishedRevision();
  const parsed = parseOkfDocument({ path: `${pageId}.md`, content });
  const candidateRevision = notebook.prepare({
    baseRevision,
    changes: { [`${pageId}.md`]: content },
    metadata: {
      summary: 'Retrieval boundary fixture',
      producer: ACTOR,
      authority: { kind: 'direct', instructionReference: 'test-fixture:retrieval-query-context' },
      changeRequest: { requestId: randomUUID(), inputDigest: sha256(content) },
      sourceReferences: parsed.ok
        ? (stringListFrontmatterField(parsed.document, 'source_refs') ?? [])
        : [],
    },
  });
  notebook.publish({ baseRevision, candidateRevision });
}

function findTraceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const paths: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...findTraceFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.json') && path.includes('retrieval-traces')) {
      paths.push(path);
    }
  }
  return paths;
}

function traceId(index: number): string {
  return testEntityId('krt', `retrieval-trace-${index}`);
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonicalValue(value));
}

function sortCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
        .map(([key, nested]) => [key, sortCanonicalValue(nested)])
    );
  }
  return value;
}

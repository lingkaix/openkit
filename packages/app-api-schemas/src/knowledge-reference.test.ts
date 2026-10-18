import { describe, expect, it } from 'vitest';
import {
  KnowledgeManagerDraftProposalRequestSchema,
  KnowledgePageReferenceSchema,
  KnowledgeRetrievalCandidateSchema,
  KnowledgeRetrievalTraceReaderSchema,
  KnowledgeRetrievalTraceSchema,
  RetrieveKnowledgeRequestSchema,
} from './knowledge-manager.js';

const knowledgeBaseId = 'kb_00000000-0000-7000-8000-000000000001';
const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const userId = 'usr_00000000-0000-7000-8000-000000000001';
const scopeId = `page/workspace/${workspaceId}/${knowledgeBaseId}`;
const reference = { scopeId, objectId: 'notes/release' };
const trace = {
  traceId: 'krt_00000000-0000-7000-8000-000000000001',
  queryContext: { serverId: 'server', workspaceId, actor: { kind: 'user', id: userId } },
  sourceScope: scopeId,
  notebookRevision: 'notebook-commit',
  caller: 'app-api',
  requestDigest: `sha256:${'a'.repeat(64)}`,
  retrievalParameters: {
    limit: 3,
    pinnedReferences: [reference],
    states: ['active'],
    sourceScope: 'workspace',
  },
  selected: [
    {
      reference,
      revision: 'page-revision',
      contentDigest: `sha256:${'b'.repeat(64)}`,
      sourceReferences: [],
    },
  ],
  excluded: [
    {
      reference: { ...reference, objectId: 'notes/missing' },
      revision: null,
      contentDigest: null,
      sourceReferences: [],
      reason: 'source_unavailable',
    },
  ],
  createdAt: '2026-10-18T00:00:00.000Z',
};

describe('Knowledge page-reference boundaries', () => {
  it.each([
    `page/user/${userId}/${knowledgeBaseId}`,
    scopeId,
    `page/server/${knowledgeBaseId}`,
  ])('retains the exact Knowledge Base in a scoped page: %s', (scope) => {
    const page = { ...reference, scopeId: scope };
    expect(KnowledgePageReferenceSchema.parse(page)).toEqual(page);
    expect(
      RetrieveKnowledgeRequestSchema.parse({ query: 'release', pinnedReferences: [page] })
        .pinnedReferences
    ).toEqual([page]);
  });

  it.each([
    `page/user/${userId}`,
    `page/workspace/${workspaceId}`,
    'page/server',
    `page/workspace/${workspaceId}/${workspaceId}`,
    `page/server/kb_00000000-0000-5000-8000-000000000001`,
    `page/server/kb_invalid`,
    `raw/workspace/${workspaceId}/${knowledgeBaseId}`,
  ])('rejects an old, wrong-kind or malformed page scope: %s', (scope) => {
    const page = { ...reference, scopeId: scope };
    expect(KnowledgePageReferenceSchema.safeParse(page).success).toBe(false);
    expect(
      RetrieveKnowledgeRequestSchema.safeParse({ query: 'release', pinnedReferences: [page] })
        .success
    ).toBe(false);
  });

  it('preserves the binding in every retained reader position and ignores descriptive additions', () => {
    const annotated = { ...reference, annotation: 'future description' };
    expect(
      KnowledgeRetrievalTraceReaderSchema.parse({
        ...trace,
        retrievalParameters: { ...trace.retrievalParameters, pinnedReferences: [annotated] },
        selected: [{ ...trace.selected[0], reference: annotated }],
        excluded: [
          { ...trace.excluded[0], reference: { ...annotated, objectId: 'notes/missing' } },
        ],
      })
    ).toEqual(trace);
  });

  it('preserves optional original-content evidence without inferring it for ordinary Git page hits', () => {
    const contentRef = {
      knowledgeBaseId,
      contentDigest: `sha256:${'c'.repeat(64)}`,
      locator: {
        ownerScope: { kind: 'workspace', workspaceId },
        mount: 'primary',
        path: 'manual.pdf',
      },
      range: null,
      availability: 'available',
    };
    const candidate = { ...trace.selected[0], score: 2, contentRef };
    expect(KnowledgeRetrievalCandidateSchema.parse(candidate)).toEqual(candidate);
    expect(candidate.contentRef.contentDigest).not.toBe(candidate.contentDigest);
    const retained = { ...trace, selected: [{ ...trace.selected[0], contentRef }] };
    expect(KnowledgeRetrievalTraceSchema.parse(retained)).toEqual(retained);
    expect(KnowledgeRetrievalTraceReaderSchema.parse(retained)).toEqual(retained);
    expect(
      KnowledgeRetrievalCandidateSchema.parse({ ...trace.selected[0], score: 2 })
    ).not.toHaveProperty('contentRef');
    expect(KnowledgeRetrievalTraceReaderSchema.parse(trace).selected[0]).not.toHaveProperty(
      'contentRef'
    );
  });

  it('does not admit an unbound retained scope through a descriptive reader projection', () => {
    const oldScope = `page/workspace/${workspaceId}`;
    const oldReference = { ...reference, scopeId: oldScope };
    for (const invalid of [
      { ...trace, sourceScope: oldScope },
      {
        ...trace,
        retrievalParameters: { ...trace.retrievalParameters, pinnedReferences: [oldReference] },
      },
      { ...trace, selected: [{ ...trace.selected[0], reference: oldReference }] },
      { ...trace, excluded: [{ ...trace.excluded[0], reference: oldReference }] },
    ]) {
      expect(KnowledgeRetrievalTraceReaderSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe('Knowledge Proposal page proof references', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const pageUri = `openkit:${scopeId}/notes/release`;
  const request = {
    requestId: '00000000-0000-4000-8000-000000000001',
    baseRevision: 'notebook-commit',
    knowledgePageId: 'notes/release',
    canonicalPageBytes: '# Release\n',
    contentDigest: digest,
    sourceReferences: [`${pageUri}@${digest}`],
    rationale: 'Preserve the accepted release evidence.',
    confidence: 0.9,
  };

  it.each([
    `${pageUri}@${digest}`,
    `openkit:page/user/${userId}/${knowledgeBaseId}/notes/release@${digest}`,
    `openkit:page/server/${knowledgeBaseId}/notes/release@${digest}`,
    `source:ks_00000000-0000-7000-8000-000000000001@${digest}`,
    'turn:tu_00000000-0000-7000-8000-000000000001',
    'item:it_00000000-0000-7000-8000-000000000001',
    `context-package:tu_00000000-0000-7000-8000-000000000001@ctxpkg_sha256_${'a'.repeat(64)}`,
  ])('accepts canonical pinned pages and preserves other owned proofs: %s', (proof) => {
    const input = { ...request, sourceReferences: [proof] };
    expect(KnowledgeManagerDraftProposalRequestSchema.parse(input)).toEqual(input);
  });

  it('keeps the cited page digest distinct from the new candidate digest', () => {
    const input = {
      ...request,
      sourceReferences: [`${pageUri}@sha256:${'b'.repeat(64)}`],
    };
    expect(KnowledgeManagerDraftProposalRequestSchema.parse(input)).toEqual(input);
  });

  it.each([
    `knowledge:notes/release@${digest}`,
    pageUri,
    `openkit:raw/workspace/${workspaceId}/${knowledgeBaseId}/manual.pdf@${digest}`,
    `openkit:page/workspace/${workspaceId}/${workspaceId}/notes/release@${digest}`,
    `openkit:page/server/kb_00000000-0000-5000-8000-000000000001/notes/release@${digest}`,
    `openkit:page/server/${knowledgeBaseId}/index@${digest}`,
    `openkit:page/server/${knowledgeBaseId}/nested/log@${digest}`,
    `${pageUri}@sha256:abc`,
  ])('rejects old, raw, unpinned or invalid page proofs: %s', (proof) => {
    expect(
      KnowledgeManagerDraftProposalRequestSchema.safeParse({
        ...request,
        sourceReferences: [proof],
      }).success
    ).toBe(false);
  });
});

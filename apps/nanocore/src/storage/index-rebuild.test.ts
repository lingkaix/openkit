// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeRetrievalTraceSchema } from '@openkit/app-api-schemas';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION } from '../knowledge/okf.js';
import { FsStore, quickChatWorkspaceIdForUser } from '../lib/store.js';
import { closeRetrievalServices } from '../retrieval-service.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { LOCAL_USER_ID } from './fs-layout.js';
import {
  rebuildExistingWorkspaceDerivedIndexes,
  rebuildInvalidExistingWorkspaceDerivedIndexes,
  rebuildWorkspaceDerivedIndexes,
  resolveWorkspaceKnowledgeRetrievalPages,
  retrieveWorkspaceKnowledge,
} from './index-rebuild.js';

afterEach(closeRetrievalServices);

/**
 * Creates a temporary NanoCore data root for index rebuild tests.
 *
 * @returns Temporary data root path.
 */
function createDataRoot(): string {
  return mkdtempSync(join(tmpdir(), 'openkit-index-rebuild-'));
}

/** Builds trusted local-user access against the exact temporary data root under test. */
function localRetrievalAccess(dataRoot: string, store = new FsStore({ dataRoot })) {
  return {
    store,
    actor: { kind: 'user' as const, id: 'user_local' },
    requestActor: { kind: 'local' as const, userId: 'user_local' },
  };
}

/**
 * Computes the canonical digest for exact UTF-8 content.
 *
 * @param content Exact content.
 * @returns Lowercase SHA-256 digest with the required prefix.
 */
function sha256Digest(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

/** Builds exact accepted Page bytes with one declared registered-source reference. */
function sourceReferencePage(knowledgePageId: string, reference: string): string {
  return [
    '---',
    'type: KnowledgePage',
    'title: Registered source resolution',
    `schema_version: ${DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION}`,
    'openkit_status: active',
    'scope: workspace',
    `source_refs: ${JSON.stringify([reference])}`,
    'review_state: accepted',
    'sensitivity: normal',
    'freshness: current',
    'created_at: "2026-10-08T00:00:00.000Z"',
    'updated_at: "2026-10-08T00:00:00.000Z"',
    `openkit_entry_id: ${knowledgePageId}`,
    'openkit_entry_kind: project-context',
    '---',
    'Registered capture evidence.',
    '',
  ].join('\n');
}

describe('workspace derived index rebuild', () => {
  it('uses the same registered-source resolution for validation and reference indexing', () => {
    const dataRoot = createDataRoot();
    const store = createDemoStore({ dataRoot });
    const workspaceRoot = join(dataRoot, 'workspaces', 'ws_demo');
    const sourceId = 'ks_123e4567-e89b-42d3-a456-426614174000';
    const missingId = 'ks_123e4567-e89b-42d3-a456-426614174001';
    const noDigestId = 'ks_123e4567-e89b-42d3-a456-426614174002';
    const foreignId = 'ks_123e4567-e89b-42d3-a456-426614174003';
    const digest = sha256Digest('Registered capture evidence.');
    const source = store.createKnowledgeSource({
      id: sourceId,
      workspaceId: 'ws_demo',
      kind: 'document',
      title: 'Registered capture',
      uri: null,
      contentDigest: digest,
      originatingThreadId: null,
      originatingTurnId: null,
      originatingFileId: null,
      capturedAt: '2026-10-08T00:00:00.000Z',
      createdAt: '2026-10-08T00:00:00.000Z',
      updatedAt: '2026-10-08T00:00:00.000Z',
    });
    // Registry-only fixtures ensure rebuild does not require captured-file integrity proof.
    writeFileSync(
      join(workspaceRoot, 'sources', 'registry', `${noDigestId}.json`),
      JSON.stringify({ ...source, id: noDigestId, contentDigest: null })
    );
    writeFileSync(
      join(workspaceRoot, 'sources', 'registry', `${foreignId}.json`),
      JSON.stringify({ ...source, id: foreignId, workspaceId: 'ws_foreign' })
    );
    const cases = [
      { id: 'bare', reference: `source:${sourceId}`, targetId: sourceId, resolved: true },
      {
        id: 'matching',
        reference: `source:${sourceId}@${digest}`,
        targetId: sourceId,
        resolved: true,
      },
      {
        id: 'wrong-pin',
        reference: `source:${sourceId}@sha256:${'0'.repeat(64)}`,
        targetId: sourceId,
        resolved: false,
      },
      { id: 'missing', reference: `source:${missingId}`, targetId: missingId, resolved: false },
      {
        id: 'missing-pinned',
        reference: `source:${missingId}@${digest}`,
        targetId: missingId,
        resolved: false,
      },
      {
        id: 'missing-digest',
        reference: `source:${noDigestId}@${digest}`,
        targetId: noDigestId,
        resolved: false,
      },
      {
        id: 'bare-without-digest',
        reference: `source:${noDigestId}`,
        targetId: noDigestId,
        resolved: true,
      },
      {
        id: 'wrong-scope',
        reference: `source:${foreignId}@${digest}`,
        targetId: foreignId,
        resolved: false,
      },
      {
        id: 'wrong-scope-bare',
        reference: `source:${foreignId}`,
        targetId: foreignId,
        resolved: false,
      },
      {
        id: 'malformed',
        reference: `source:${sourceId}@sha256:invalid`,
        targetId: null,
        resolved: false,
      },
      { id: 'empty-pin', reference: `source:${sourceId}@`, targetId: null, resolved: false },
      {
        id: 'double-pin',
        reference: `source:${sourceId}@${digest}@${digest}`,
        targetId: null,
        resolved: false,
      },
      { id: 'invalid-id', reference: 'source:ks_invalid', targetId: null, resolved: false },
      {
        id: 'trailing-newline',
        reference: `source:${sourceId}@${digest}\n`,
        targetId: null,
        resolved: false,
      },
    ];
    for (const entry of cases) {
      writeFileSync(
        join(workspaceRoot, 'knowledge', 'pages', `${entry.id}.md`),
        sourceReferencePage(entry.id, entry.reference)
      );
    }
    rebuildWorkspaceDerivedIndexes({ dataRoot, workspaceId: 'ws_demo' });
    const indexes = join(workspaceRoot, 'indexes');
    const validation = JSON.parse(readFileSync(join(indexes, 'knowledge-validation.json'), 'utf8'));
    const references = JSON.parse(
      readFileSync(join(indexes, 'knowledge-source-refs.json'), 'utf8')
    );
    for (const entry of cases) {
      expect(
        validation.records.find((record: { conceptId: string }) => record.conceptId === entry.id),
        entry.id
      ).toMatchObject({
        conformance: 'scope-schema-valid',
        indexed: false,
        errors: entry.resolved
          ? []
          : [
              {
                code: 'reference.unresolved_source',
                field: 'source_refs',
                message: 'Knowledge source reference does not resolve.',
              },
            ],
      });
      expect(
        references.references.find(
          (record: { conceptId: string }) => record.conceptId === entry.id
        ),
        entry.id
      ).toEqual({
        conceptId: entry.id,
        path: `knowledge/pages/${entry.id}.md`,
        reference: entry.reference,
        kind: 'registered-source',
        targetId: entry.targetId,
        resolved: entry.resolved,
      });
    }
  });

  it('rebuilds an accepted matching-pin Page without rewriting bytes or contradicting resolution', () => {
    const dataRoot = createDataRoot();
    const store = createDemoStore({ dataRoot });
    const material = 'Registered capture evidence.';
    const source = store.createKnowledgeSource(
      {
        id: 'ks_123e4567-e89b-42d3-a456-426614174000',
        workspaceId: 'ws_demo',
        kind: 'document',
        title: 'Registered capture',
        uri: null,
        contentDigest: sha256Digest(material),
        originatingThreadId: null,
        originatingTurnId: null,
        originatingFileId: null,
        capturedAt: '2026-10-08T00:00:00.000Z',
        createdAt: '2026-10-08T00:00:00.000Z',
        updatedAt: '2026-10-08T00:00:00.000Z',
      },
      material
    );
    const reference = `source:${source.id}@${source.contentDigest}`;
    const canonicalPageBytes = sourceReferencePage('accepted-pin', reference);
    const proposal = store.createKnowledgeProposal({
      workspaceId: 'ws_demo',
      knowledgePageId: 'accepted-pin',
      canonicalPageBytes,
      contentDigest: sha256Digest(canonicalPageBytes),
      sourceReferences: [reference],
      requestId: '00000000-0000-4000-8000-000000000801',
      rationale: 'Preserve registered evidence.',
      confidence: 1,
      producer: { kind: 'user', id: 'user_local' },
      verifiedExternalReferences: [],
      createdAt: '2026-10-08T00:00:00.000Z',
    });
    store.recordKnowledgeProposalReviewDecision({
      workspaceId: 'ws_demo',
      proposalId: proposal.id,
      decision: 'accepted',
      requestId: '00000000-0000-4000-8000-000000000802',
      actor: { kind: 'user', id: 'user_local' },
      verifiedExternalReferences: [],
      decidedAt: '2026-10-08T00:00:00.000Z',
    });
    const workspaceRoot = join(dataRoot, 'workspaces', 'ws_demo');
    const pagePath = join(workspaceRoot, 'knowledge', 'pages', 'accepted-pin.md');
    const before = readFileSync(pagePath);
    expect(before).toEqual(Buffer.from(canonicalPageBytes));
    rebuildWorkspaceDerivedIndexes({ dataRoot, workspaceId: 'ws_demo' });
    expect(readFileSync(pagePath)).toEqual(before);
    const validation = JSON.parse(
      readFileSync(join(workspaceRoot, 'indexes', 'knowledge-validation.json'), 'utf8')
    );
    const references = JSON.parse(
      readFileSync(join(workspaceRoot, 'indexes', 'knowledge-source-refs.json'), 'utf8')
    );
    expect(
      validation.records.find(
        (record: { conceptId: string }) => record.conceptId === 'accepted-pin'
      )
    ).toMatchObject({ errors: [], indexed: false });
    expect(
      references.references.find(
        (record: { conceptId: string }) => record.conceptId === 'accepted-pin'
      )
    ).toMatchObject({ reference, targetId: source.id, resolved: true });
    expect(
      new FsStore({ dataRoot }).getWorkspaceResources('ws_demo').knowledge.map((entry) => entry.id)
    ).toContain('accepted-pin');
  });

  it('excludes reserved index and log files at every Knowledge bundle depth', () => {
    const dataRoot = createDataRoot();
    createDemoStore({ dataRoot });
    const workspaceRoot = join(dataRoot, 'workspaces', 'ws_demo');
    const nestedRoot = join(workspaceRoot, 'knowledge', 'pages', 'nested');
    mkdirSync(nestedRoot, { recursive: true });
    writeFileSync(join(nestedRoot, 'index.md'), '# Nested index\n\nNavigation only.\n');
    writeFileSync(join(nestedRoot, 'log.md'), '# Nested log\n\n## 2026-09-06\n* Update.\n');

    expect(() =>
      rebuildWorkspaceDerivedIndexes({ dataRoot, workspaceId: 'ws_demo' })
    ).not.toThrow();

    const validation = JSON.parse(
      readFileSync(join(workspaceRoot, 'indexes', 'knowledge-validation.json'), 'utf8')
    ) as { records: Array<{ path: string }> };
    const references = JSON.parse(
      readFileSync(join(workspaceRoot, 'indexes', 'knowledge-source-refs.json'), 'utf8')
    ) as { references: Array<{ path: string }> };
    expect(validation.records.map((record) => record.path)).not.toEqual(
      expect.arrayContaining(['knowledge/pages/nested/index.md', 'knowledge/pages/nested/log.md'])
    );
    expect(references.references.map((record) => record.path)).not.toEqual(
      expect.arrayContaining(['knowledge/pages/nested/index.md', 'knowledge/pages/nested/log.md'])
    );
  });
  it('persists the exact governed retrieval row and omits unaddressed pages', async () => {
    const dataRoot = createDataRoot();
    const store = createDemoStore({ dataRoot });
    const workspaceRoot = join(dataRoot, 'workspaces', 'ws_demo');
    const createdAt = '2026-07-12T00:00:00.000Z';
    const sourceId = 'ks_00000000-0000-4000-8000-000000000001';
    const sourceReference = `source:${sourceId}`;

    store.createKnowledgeSource(
      {
        id: sourceId,
        workspaceId: 'ws_demo',
        kind: 'document',
        title: 'Governed retrieval source',
        uri: null,
        contentDigest: sha256Digest('Governed retrieval source.'),
        originatingThreadId: null,
        originatingTurnId: null,
        originatingFileId: null,
        capturedAt: createdAt,
        createdAt,
        updatedAt: createdAt,
      },
      'Governed retrieval source.'
    );
    const selected = store.createKnowledgeEntry('ws_demo', {
      kind: 'project-context',
      title: 'Selected page',
      content: 'retrievalneedle',
      sourceReferences: [sourceReference],
    });
    const overflow = store.createKnowledgeEntry('ws_demo', {
      kind: 'project-context',
      title: 'Overflow page',
      content: 'retrievalneedle',
    });
    const zeroScore = store.createKnowledgeEntry('ws_demo', {
      kind: 'project-context',
      title: 'Unaddressed page',
      content: 'No matching term.',
    });
    const traceId = 'krt_00000000-0000-4000-8000-000000000003';
    const input = {
      access: { ...localRetrievalAccess(dataRoot, store), outputThreadId: 'th_demo' },
      dataRoot,
      workspaceId: 'ws_demo',
      caller: 'task-mode' as const,
      query: 'retrievalneedle',
      limit: 1,
      pinnedReferences: [
        { scopeId: 'page/workspace/ws_demo', objectId: overflow.id },
        { scopeId: 'page/workspace/ws_demo', objectId: selected.id },
        { scopeId: 'page/workspace/ws_demo', objectId: selected.id },
      ],
      traceId,
      now: () => createdAt,
    };

    const trace = await retrieveWorkspaceKnowledge(input);
    const selectedPageBytes = readFileSync(
      join(workspaceRoot, 'knowledge', 'pages', `${selected.id}.md`),
      'utf8'
    );

    expect(
      resolveWorkspaceKnowledgeRetrievalPages({
        caller: 'task-mode',
        dataRoot,
        access: { ...localRetrievalAccess(dataRoot, store), outputThreadId: 'th_demo' },
        workspaceId: 'ws_demo',
        retrievalTraceRef: trace.retrievalTraceRef!,
      })
    ).toEqual([
      {
        body: 'retrievalneedle',
        reference: { scopeId: 'page/workspace/ws_demo', objectId: selected.id },
        knowledgePageId: selected.id,
        contentDigest: sha256Digest(selectedPageBytes),
        kind: 'project-context',
        sourceRefs: [sourceReference],
        content: selectedPageBytes,
        title: 'Selected page',
      },
    ]);

    const tracePath = join(
      workspaceRoot,
      'threads',
      'th_demo',
      'retrieval-traces',
      `${traceId}.json`
    );
    const row = KnowledgeRetrievalTraceSchema.parse(JSON.parse(readFileSync(tracePath, 'utf8')));
    expect(row).toEqual({
      traceId,
      queryContext: {
        serverId: expect.any(String),
        workspaceId: 'ws_demo',
        actor: { kind: 'user', id: 'user_local' },
        threadId: 'th_demo',
      },
      sourceScope: 'page/workspace/ws_demo',
      notebookRevision: null,
      caller: 'task-mode',
      requestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      retrievalParameters: {
        limit: 1,
        pinnedReferences: [
          { scopeId: 'page/workspace/ws_demo', objectId: selected.id },
          { scopeId: 'page/workspace/ws_demo', objectId: overflow.id },
        ],
        states: ['active'],
        sourceScope: 'workspace',
      },
      selected: [
        {
          reference: { scopeId: 'page/workspace/ws_demo', objectId: selected.id },
          revision: sha256Digest(selectedPageBytes),
          contentDigest: sha256Digest(selectedPageBytes),
          sourceReferences: [sourceReference],
        },
      ],
      excluded: [
        {
          reference: { scopeId: 'page/workspace/ws_demo', objectId: overflow.id },
          revision: sha256Digest(
            readFileSync(join(workspaceRoot, 'knowledge', 'pages', `${overflow.id}.md`), 'utf8')
          ),
          contentDigest: sha256Digest(
            readFileSync(join(workspaceRoot, 'knowledge', 'pages', `${overflow.id}.md`), 'utf8')
          ),
          sourceReferences: [],
          reason: 'budget_exceeded',
        },
      ],
      createdAt,
    });
    expect(trace.selected[0]?.score).toBeGreaterThan(0);
    expect(JSON.stringify(row)).not.toContain('score');
    expect(JSON.stringify(row)).not.toContain('retrievalneedle');
    expect(JSON.stringify(row)).not.toContain(zeroScore.id);
  });

  it('does not let a persisted retrieval trace authorize an accepted page', async () => {
    const dataRoot = createDataRoot();
    const store = createDemoStore({ dataRoot });
    const workspaceRoot = join(dataRoot, 'workspaces', 'ws_demo');
    const knowledgePageId = 'reviewed-task-proof';
    const evidence = store.createKnowledgeEntry('ws_demo', {
      kind: 'project-context',
      title: 'Reviewed evidence source',
      content: 'The current page supplies exact proposal evidence.',
    });
    const evidenceBytes = readFileSync(
      join(workspaceRoot, 'knowledge', 'pages', `${evidence.id}.md`),
      'utf8'
    );
    const sourceReferences = [`knowledge:${evidence.id}@${sha256Digest(evidenceBytes)}`];
    const content = [
      '---',
      'type: "KnowledgePage"',
      'title: "Reviewed task proof"',
      'schema_version: "openkit-workspace-knowledge-schema-v2"',
      'openkit_status: "active"',
      'status: "stable"',
      'scope: "workspace"',
      `source_refs: ${JSON.stringify(sourceReferences)}`,
      'review_state: "accepted"',
      'sensitivity: "normal"',
      'freshness: "current"',
      'created_at: "2026-07-12T00:00:00.000Z"',
      'updated_at: "2026-07-12T00:00:00.000Z"',
      'openkit_entry_kind: "project-context"',
      `openkit_entry_id: ${JSON.stringify(knowledgePageId)}`,
      '---',
      'Only current owners can authorize this reviewed task proof.',
      '',
    ].join('\n');
    const contentDigest = sha256Digest(content);
    const proposal = store.createKnowledgeProposal({
      workspaceId: 'ws_demo',
      knowledgePageId,
      canonicalPageBytes: content,
      contentDigest,
      sourceReferences,
      requestId: '00000000-0000-4000-8000-000000000702',
      rationale: 'Retain the reviewed page for retrieval.',
      confidence: 1,
      producer: { kind: 'user', id: 'user_local' },
      verifiedExternalReferences: [],
      createdAt: '2026-07-12T00:00:00.000Z',
    });
    store.recordKnowledgeProposalReviewDecision({
      workspaceId: 'ws_demo',
      proposalId: proposal.id,
      decision: 'accepted',
      requestId: '00000000-0000-4000-8000-000000000703',
      actor: { kind: 'user', id: 'user_local' },
      verifiedExternalReferences: [],
      decidedAt: '2026-07-12T00:00:00.000Z',
    });
    const retrieval = await retrieveWorkspaceKnowledge({
      access: { ...localRetrievalAccess(dataRoot, store), outputThreadId: 'th_demo' },
      caller: 'task-mode',
      dataRoot,
      query: 'Reviewed task proof',
      traceId: 'krt_00000000-0000-4000-8000-000000000702',
      workspaceId: 'ws_demo',
      now: () => '2026-07-12T00:00:00.000Z',
    });

    expect(retrieval.selected).toContainEqual(
      expect.objectContaining({
        reference: { scopeId: 'page/workspace/ws_demo', objectId: knowledgePageId },
      })
    );
    rmSync(join(workspaceRoot, 'knowledge', 'reviews', `${proposal.id}.json`));
    const afterStore = new FsStore({ dataRoot });
    expect(() =>
      resolveWorkspaceKnowledgeRetrievalPages({
        access: { ...localRetrievalAccess(dataRoot, afterStore), outputThreadId: 'th_demo' },
        caller: 'task-mode',
        dataRoot,
        retrievalTraceRef: retrieval.retrievalTraceRef!,
        workspaceId: 'ws_demo',
      })
    ).toThrow('Knowledge retrieval trace no longer matches authoritative pages.');
  });

  it('requires exact page-bound proof for every accepted page', async () => {
    const dataRoot = createDataRoot();
    const store = createDemoStore({ dataRoot });
    const workspaceRoot = join(dataRoot, 'workspaces', 'ws_demo');
    const knowledgePageId = 'accepted-without-proof';
    const content = [
      '---',
      'type: "KnowledgePage"',
      'title: "Accepted page without proof"',
      'schema_version: "openkit-workspace-knowledge-schema-v2"',
      'openkit_status: "active"',
      'status: "stable"',
      'scope: "workspace"',
      'source_refs: []',
      'review_state: "accepted"',
      'sensitivity: "normal"',
      'freshness: "current"',
      'created_at: "2026-07-12T00:00:00.000Z"',
      'updated_at: "2026-07-12T00:00:00.000Z"',
      'openkit_entry_kind: "project-context"',
      `openkit_entry_id: ${JSON.stringify(knowledgePageId)}`,
      '---',
      'This accepted page must not become retrievable without its authority proof.',
      '',
    ].join('\n');
    writeFileSync(join(workspaceRoot, 'knowledge', 'pages', `${knowledgePageId}.md`), content);

    const retrieval = await retrieveWorkspaceKnowledge({
      access: { ...localRetrievalAccess(dataRoot, store), outputThreadId: 'th_demo' },
      caller: 'task-mode',
      dataRoot,
      pinnedReferences: [{ scopeId: 'page/workspace/ws_demo', objectId: knowledgePageId }],
      query: 'accepted page',
      traceId: 'krt_00000000-0000-4000-8000-000000000703',
      workspaceId: 'ws_demo',
      now: () => '2026-07-12T00:00:00.000Z',
    });
    const validationIndex = JSON.parse(
      readFileSync(join(workspaceRoot, 'indexes', 'knowledge-validation.json'), 'utf8')
    ) as { records: Array<{ conceptId: string; indexed: boolean }> };

    expect(retrieval.selected).toEqual([]);
    expect(retrieval.excluded).toContainEqual({
      contentDigest: sha256Digest(content),
      reference: { scopeId: 'page/workspace/ws_demo', objectId: knowledgePageId },
      revision: sha256Digest(content),
      sourceReferences: [],
      reason: 'lower_conformance',
    });
    expect(validationIndex.records.find((record) => record.conceptId === knowledgePageId)).toEqual(
      expect.objectContaining({ indexed: false })
    );
  });

  it('publishes one immutable trace beside an interrupted temporary file', async () => {
    const dataRoot = createDataRoot();
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Retrieval trace recovery');
    const thread = store.createThread(workspace.id, 'Retrieval owner');
    const traceRoot = join(
      dataRoot,
      'workspaces',
      workspace.id,
      'threads',
      thread.id,
      'retrieval-traces'
    );
    mkdirSync(traceRoot, { recursive: true });
    const interruptedPath = join(traceRoot, '.krt_interrupted.tmp');
    writeFileSync(interruptedPath, '{"interrupted":true');
    const input = {
      access: { ...localRetrievalAccess(dataRoot, store), outputThreadId: thread.id },
      dataRoot,
      workspaceId: workspace.id,
      caller: 'task-mode' as const,
      query: 'canonical recovery',
      now: () => '2026-07-12T00:00:00.000Z',
    };
    const firstTraceId = 'krt_00000000-0000-4000-8000-000000000001';

    const first = await retrieveWorkspaceKnowledge({ ...input, traceId: firstTraceId });
    const tracePath = join(traceRoot, `${firstTraceId}.json`);
    expect(
      KnowledgeRetrievalTraceSchema.parse(JSON.parse(readFileSync(tracePath, 'utf8')))
    ).toEqual(expect.objectContaining({ traceId: firstTraceId }));
    expect(first.retrievalTraceRef).toEqual({
      scopeId: `retrieval-trace/thread/${workspace.id}/${thread.id}`,
      objectId: firstTraceId,
    });
    expect(readFileSync(interruptedPath, 'utf8')).toBe('{"interrupted":true');
    const before = readFileSync(tracePath);
    await expect(retrieveWorkspaceKnowledge({ ...input, traceId: firstTraceId })).rejects.toThrow(
      'Knowledge retrieval trace already exists.'
    );
    expect(readFileSync(tracePath)).toEqual(before);
  });

  it('rejects a symlinked immutable retrieval-trace target without writing outside', async () => {
    const dataRoot = createDataRoot();
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Retrieval trace symlink');
    const thread = store.createThread(workspace.id, 'Retrieval owner');
    const traceId = 'krt_00000000-0000-4000-8000-000000000004';
    const tracePath = join(
      dataRoot,
      'workspaces',
      workspace.id,
      'threads',
      thread.id,
      'retrieval-traces',
      `${traceId}.json`
    );
    const outsideRoot = mkdtempSync(join(tmpdir(), 'openkit-index-trace-outside-'));
    const outsidePath = join(outsideRoot, 'sentinel.json');
    const input = {
      access: { ...localRetrievalAccess(dataRoot, store), outputThreadId: thread.id },
      dataRoot,
      workspaceId: workspace.id,
      caller: 'task-mode' as const,
      query: 'canonical symlink',
      now: () => '2026-07-12T00:00:00.000Z',
    };

    mkdirSync(join(tracePath, '..'), { recursive: true });
    writeFileSync(outsidePath, 'untouched\n');
    symlinkSync(outsidePath, tracePath);

    await expect(retrieveWorkspaceKnowledge({ ...input, traceId })).rejects.toThrow();
    expect(readFileSync(outsidePath, 'utf8')).toBe('untouched\n');
  });

  it('fails closed when the workspace projection is missing', () => {
    const dataRoot = createDataRoot();

    expect(() => rebuildWorkspaceDerivedIndexes({ dataRoot, workspaceId: 'missing' })).toThrow(
      'Workspace projection is missing: workspaces/missing/workspace-record.json'
    );
  });

  it('rejects a symlinked canonical subtree instead of reading external content', () => {
    const dataRoot = createDataRoot();
    createDemoStore({ dataRoot });
    const pagesRoot = join(dataRoot, 'workspaces', 'ws_demo', 'knowledge', 'pages');
    const outsidePagesRoot = mkdtempSync(join(tmpdir(), 'openkit-outside-pages-'));

    writeFileSync(join(outsidePagesRoot, 'outside.md'), 'External content must not be indexed.\n');
    rmSync(pagesRoot, { recursive: true });
    symlinkSync(outsidePagesRoot, pagesRoot, 'dir');

    expect(() =>
      rebuildWorkspaceDerivedIndexes({
        dataRoot,
        workspaceId: 'ws_demo',
      })
    ).toThrow();
  });

  it('rejects a symlinked indexes directory without deleting its external target', () => {
    const dataRoot = createDataRoot();
    createDemoStore({ dataRoot });
    const indexesRoot = join(dataRoot, 'workspaces', 'ws_demo', 'indexes');
    const outsideIndexesRoot = mkdtempSync(join(tmpdir(), 'openkit-outside-indexes-'));
    const sentinelPath = join(outsideIndexesRoot, 'sentinel.txt');

    writeFileSync(sentinelPath, 'outside sentinel\n');
    rmSync(indexesRoot, { recursive: true });
    symlinkSync(outsideIndexesRoot, indexesRoot, 'dir');

    let failure: unknown = null;
    try {
      rebuildWorkspaceDerivedIndexes({
        dataRoot,
        workspaceId: 'ws_demo',
      });
    } catch (error) {
      failure = error;
    }

    expect({
      rejected: failure instanceof Error,
      sentinel: existsSync(sentinelPath) ? readFileSync(sentinelPath, 'utf8') : null,
    }).toEqual({ rejected: true, sentinel: 'outside sentinel\n' });
  });

  it('rebuilds validation reports for file-backed knowledge pages', () => {
    const dataRoot = createDataRoot();
    createDemoStore({ dataRoot });
    const workspaceRoot = join(dataRoot, 'workspaces', 'ws_demo');
    const timestamp = '2026-07-07T00:00:00.000Z';

    writeFileSync(
      join(workspaceRoot, 'knowledge', 'pages', 'valid.md'),
      [
        '---',
        'type: "KnowledgePage"',
        'title: "Valid knowledge"',
        'schema_version: "openkit-workspace-knowledge-schema-v2"',
        'openkit_status: "active"',
        'status: "stable"',
        'scope: "workspace"',
        'source_refs: []',
        'review_state: "user-authored"',
        'sensitivity: "normal"',
        'freshness: "current"',
        `created_at: "${timestamp}"`,
        `updated_at: "${timestamp}"`,
        '---',
        'Valid body.',
        '',
      ].join('\n')
    );
    writeFileSync(
      join(workspaceRoot, 'knowledge', 'pages', 'missing-field.md'),
      [
        '---',
        'type: "KnowledgePage"',
        'title: "Missing field knowledge"',
        'schema_version: "openkit-workspace-knowledge-schema-v2"',
        'openkit_status: "active"',
        'status: "stable"',
        'scope: "workspace"',
        'source_refs: []',
        'review_state: "accepted"',
        'sensitivity: "normal"',
        'freshness: "current"',
        `created_at: "${timestamp}"`,
        '---',
        'Invalid body.',
        '',
      ].join('\n')
    );
    writeFileSync(
      join(workspaceRoot, 'knowledge', 'pages', 'missing-source.md'),
      [
        '---',
        'type: "KnowledgePage"',
        'title: "Missing source knowledge"',
        'schema_version: "openkit-workspace-knowledge-schema-v2"',
        'openkit_status: "active"',
        'status: "stable"',
        'scope: "workspace"',
        'source_refs: ["source:ks_missing"]',
        'review_state: "accepted"',
        'sensitivity: "normal"',
        'freshness: "current"',
        `created_at: "${timestamp}"`,
        `updated_at: "${timestamp}"`,
        '---',
        'Missing source body.',
        '',
      ].join('\n')
    );

    rebuildWorkspaceDerivedIndexes({
      dataRoot,
      workspaceId: 'ws_demo',
    });

    expect(
      JSON.parse(readFileSync(join(workspaceRoot, 'indexes', 'knowledge-validation.json'), 'utf8'))
    ).toMatchObject({
      schemaVersion: 1,
      workspaceId: 'ws_demo',
      records: expect.arrayContaining([
        expect.objectContaining({
          conceptId: 'valid',
          conformance: 'scope-schema-valid',
          indexed: true,
          errors: [],
        }),
        expect.objectContaining({
          conceptId: 'missing-field',
          conformance: 'OKF-compatible',
          indexed: false,
          errors: expect.arrayContaining([
            expect.objectContaining({
              code: 'profile.missing_required_field',
              field: 'updated_at',
            }),
          ]),
        }),
        expect.objectContaining({
          conceptId: 'missing-source',
          conformance: 'scope-schema-valid',
          indexed: false,
          errors: expect.arrayContaining([
            expect.objectContaining({
              code: 'reference.unresolved_source',
              field: 'source_refs',
            }),
          ]),
        }),
      ]),
    });
  });

  it('uses the workspace schema when rebuilding extension knowledge pages', () => {
    const dataRoot = createDataRoot();
    const store = createDemoStore({ dataRoot });
    store.createKnowledgeEntry('ws_demo', {
      kind: 'project-context',
      title: 'Seed knowledge',
      content: 'Seed body.',
    });
    const workspaceRoot = join(dataRoot, 'workspaces', 'ws_demo');
    writeFileSync(
      join(workspaceRoot, 'knowledge', 'schema', 'workspace-schema.yaml'),
      [
        'schema_version: "openkit-workspace-knowledge-schema-v2"',
        'status: "active"',
        'allowed_types: ["KnowledgePage", "RepoConvention"]',
        'allowed_statuses: ["active"]',
        'allowed_review_states: ["user-authored"]',
        'allowed_sensitivities: ["normal"]',
        'allowed_freshness: ["current"]',
        '',
      ].join('\n')
    );
    writeFileSync(
      join(workspaceRoot, 'knowledge', 'pages', 'repo.md'),
      [
        '---',
        'type: "RepoConvention"',
        'title: "Repo convention"',
        'schema_version: "openkit-workspace-knowledge-schema-v2"',
        'openkit_status: "active"',
        'status: "stable"',
        'scope: "workspace"',
        'source_refs: []',
        'review_state: "user-authored"',
        'sensitivity: "normal"',
        'freshness: "current"',
        'created_at: "2026-07-07T00:00:00.000Z"',
        'updated_at: "2026-07-07T00:00:00.000Z"',
        '---',
        'Extension schema body.',
        '',
      ].join('\n')
    );

    rebuildWorkspaceDerivedIndexes({
      dataRoot,
      workspaceId: 'ws_demo',
    });

    const validation = JSON.parse(
      readFileSync(join(workspaceRoot, 'indexes', 'knowledge-validation.json'), 'utf8')
    ) as { records: Array<{ conceptId: string; indexed: boolean; title?: string }> };

    expect(validation.records).toContainEqual(
      expect.objectContaining({ conceptId: 'repo', indexed: true, title: 'Repo convention' })
    );
  });

  it('does not rebuild knowledge pages when the workspace schema is invalid', () => {
    const dataRoot = createDataRoot();
    const store = createDemoStore({ dataRoot });
    store.createKnowledgeEntry('ws_demo', {
      kind: 'project-context',
      title: 'Schema blocked knowledge',
      content: 'This body should not be indexed.',
    });
    const workspaceRoot = join(dataRoot, 'workspaces', 'ws_demo');
    writeFileSync(
      join(workspaceRoot, 'knowledge', 'schema', 'workspace-schema.yaml'),
      'schema_version: "openkit-workspace-knowledge-schema-v2"\n'
    );

    rebuildWorkspaceDerivedIndexes({
      dataRoot,
      workspaceId: 'ws_demo',
    });

    const validation = JSON.parse(
      readFileSync(join(workspaceRoot, 'indexes', 'knowledge-validation.json'), 'utf8')
    ) as { records: Array<{ indexed: boolean; errors: unknown[] }> };

    expect(validation.records.every((record) => !record.indexed)).toBe(true);
    expect(validation.records.some((record) => record.errors.length > 0)).toBe(true);
  });

  it('requires active knowledge page source references to resolve to registered records', () => {
    const dataRoot = createDataRoot();
    const store = createDemoStore({ dataRoot });
    const workspaceRoot = join(dataRoot, 'workspaces', 'ws_demo');
    const timestamp = '2026-07-07T00:00:00.000Z';
    const knowledge = store.createKnowledgeEntry('ws_demo', {
      kind: 'project-context',
      title: 'Registered knowledge',
      content: 'Registered knowledge body.',
    });

    store.createKnowledgeSource({
      id: 'ks_123e4567-e89b-42d3-a456-426614174000',
      workspaceId: 'ws_demo',
      kind: 'document',
      title: 'Registered source',
      uri: null,
      contentDigest: `sha256:${'a'.repeat(64)}`,
      originatingThreadId: null,
      originatingTurnId: null,
      originatingFileId: null,
      capturedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    writeFileSync(
      join(workspaceRoot, 'knowledge', 'pages', 'source-backed.md'),
      [
        '---',
        'type: "KnowledgePage"',
        'title: "Source-backed knowledge"',
        'schema_version: "openkit-workspace-knowledge-schema-v2"',
        'openkit_status: "active"',
        'status: "stable"',
        'scope: "workspace"',
        'source_refs: ["source:ks_123e4567-e89b-42d3-a456-426614174000"]',
        'review_state: "user-authored"',
        'sensitivity: "normal"',
        'freshness: "current"',
        `created_at: "${timestamp}"`,
        `updated_at: "${timestamp}"`,
        '---',
        'This source-backed body should be indexed.',
        '',
      ].join('\n')
    );
    writeFileSync(
      join(workspaceRoot, 'knowledge', 'pages', 'knowledge-backed.md'),
      [
        '---',
        'type: "KnowledgePage"',
        'title: "Knowledge-backed knowledge"',
        'schema_version: "openkit-workspace-knowledge-schema-v2"',
        'openkit_status: "active"',
        'status: "stable"',
        'scope: "workspace"',
        `source_refs: ["knowledge:${knowledge.id}"]`,
        'review_state: "user-authored"',
        'sensitivity: "normal"',
        'freshness: "current"',
        `created_at: "${timestamp}"`,
        `updated_at: "${timestamp}"`,
        '---',
        'This knowledge-backed body should be indexed.',
        '',
      ].join('\n')
    );
    writeFileSync(
      join(workspaceRoot, 'knowledge', 'pages', 'missing-source.md'),
      [
        '---',
        'type: "KnowledgePage"',
        'title: "Missing source knowledge"',
        'schema_version: "openkit-workspace-knowledge-schema-v2"',
        'openkit_status: "active"',
        'status: "stable"',
        'scope: "workspace"',
        'source_refs: ["source:ks_missing"]',
        'review_state: "user-authored"',
        'sensitivity: "normal"',
        'freshness: "current"',
        `created_at: "${timestamp}"`,
        `updated_at: "${timestamp}"`,
        '---',
        'This missing-source body should not be indexed.',
        '',
      ].join('\n')
    );
    writeFileSync(
      join(workspaceRoot, 'knowledge', 'pages', 'missing-knowledge.md'),
      [
        '---',
        'type: "KnowledgePage"',
        'title: "Missing knowledge source"',
        'schema_version: "openkit-workspace-knowledge-schema-v2"',
        'openkit_status: "active"',
        'status: "stable"',
        'scope: "workspace"',
        'source_refs: ["knowledge:kn_missing"]',
        'review_state: "user-authored"',
        'sensitivity: "normal"',
        'freshness: "current"',
        `created_at: "${timestamp}"`,
        `updated_at: "${timestamp}"`,
        '---',
        'This missing-knowledge body should not be indexed.',
        '',
      ].join('\n')
    );
    writeFileSync(
      join(workspaceRoot, 'knowledge', 'pages', 'external-url.md'),
      [
        '---',
        'type: "KnowledgePage"',
        'title: "External URL knowledge"',
        'schema_version: "openkit-workspace-knowledge-schema-v2"',
        'openkit_status: "active"',
        'status: "stable"',
        'scope: "workspace"',
        'source_refs: ["https://example.com/source"]',
        'review_state: "user-authored"',
        'sensitivity: "normal"',
        'freshness: "current"',
        `created_at: "${timestamp}"`,
        `updated_at: "${timestamp}"`,
        '---',
        'This external-url body should be indexed.',
        '',
      ].join('\n')
    );
    writeFileSync(
      join(workspaceRoot, 'knowledge', 'pages', 'invalid-external.md'),
      [
        '---',
        'type: "KnowledgePage"',
        'title: "Invalid external source"',
        'schema_version: "openkit-workspace-knowledge-schema-v2"',
        'openkit_status: "active"',
        'status: "stable"',
        'scope: "workspace"',
        'source_refs: ["not-a-valid-external-reference"]',
        'review_state: "user-authored"',
        'sensitivity: "normal"',
        'freshness: "current"',
        `created_at: "${timestamp}"`,
        `updated_at: "${timestamp}"`,
        '---',
        'This invalid-external body should not be indexed.',
        '',
      ].join('\n')
    );

    rebuildWorkspaceDerivedIndexes({
      dataRoot,
      workspaceId: 'ws_demo',
    });

    const validation = JSON.parse(
      readFileSync(join(workspaceRoot, 'indexes', 'knowledge-validation.json'), 'utf8')
    ) as { records: Array<{ conceptId: string; indexed: boolean; errors: unknown[] }> };
    const indexedById = new Map(
      validation.records.map((record) => [record.conceptId, record.indexed] as const)
    );
    expect(Object.fromEntries(indexedById)).toMatchObject({
      'source-backed': true,
      'knowledge-backed': true,
      'external-url': true,
      'missing-source': false,
      'missing-knowledge': false,
      'invalid-external': false,
    });
    expect(validation).toMatchObject({
      records: expect.arrayContaining([
        expect.objectContaining({
          conceptId: 'invalid-external',
          indexed: false,
          errors: expect.arrayContaining([
            expect.objectContaining({
              code: 'reference.invalid_external',
              field: 'source_refs',
            }),
          ]),
        }),
      ]),
    });
  });

  it('rebuilds the knowledge source-reference index from file-backed pages', () => {
    const dataRoot = createDataRoot();
    const store = createDemoStore({ dataRoot });
    const workspaceRoot = join(dataRoot, 'workspaces', 'ws_demo');
    const timestamp = '2026-07-07T00:00:00.000Z';
    const knowledge = store.createKnowledgeEntry('ws_demo', {
      kind: 'project-context',
      title: 'Registered knowledge',
      content: 'Registered knowledge body.',
    });

    store.createKnowledgeSource({
      id: 'ks_123e4567-e89b-42d3-a456-426614174000',
      workspaceId: 'ws_demo',
      kind: 'document',
      title: 'Registered source',
      uri: null,
      contentDigest: `sha256:${'a'.repeat(64)}`,
      originatingThreadId: null,
      originatingTurnId: null,
      originatingFileId: null,
      capturedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    writeFileSync(
      join(workspaceRoot, 'knowledge', 'pages', 'source-reference-index.md'),
      [
        '---',
        'type: "KnowledgePage"',
        'title: "Source reference index"',
        'schema_version: "openkit-workspace-knowledge-schema-v2"',
        'openkit_status: "active"',
        'status: "stable"',
        'scope: "workspace"',
        `source_refs: ${JSON.stringify([
          'source:ks_123e4567-e89b-42d3-a456-426614174000',
          `source:ks_123e4567-e89b-42d3-a456-426614174000@sha256:${'a'.repeat(64)}`,
          `knowledge:${knowledge.id}`,
          `knowledge:${knowledge.id}@sha256:${'b'.repeat(64)}`,
          'source:ks_missing',
          'knowledge:kn_missing',
          'https://example.com/source',
          'not-a-valid-external-reference',
        ])}`,
        'review_state: "accepted"',
        'sensitivity: "normal"',
        'freshness: "current"',
        `created_at: "${timestamp}"`,
        `updated_at: "${timestamp}"`,
        '---',
        'Source reference body.',
        '',
      ].join('\n')
    );

    rebuildWorkspaceDerivedIndexes({
      dataRoot,
      workspaceId: 'ws_demo',
    });

    const sourceReferenceIndex = JSON.parse(
      readFileSync(join(workspaceRoot, 'indexes', 'knowledge-source-refs.json'), 'utf8')
    ) as {
      schemaVersion: number;
      workspaceId: string;
      references: Array<{
        conceptId: string;
        path: string;
        reference: string;
        kind: string;
        targetId: string | null;
        resolved: boolean;
      }>;
    };

    expect(sourceReferenceIndex).toMatchObject({
      schemaVersion: 1,
      workspaceId: 'ws_demo',
      references: expect.arrayContaining([
        {
          conceptId: 'source-reference-index',
          path: 'knowledge/pages/source-reference-index.md',
          reference: 'source:ks_123e4567-e89b-42d3-a456-426614174000',
          kind: 'registered-source',
          targetId: 'ks_123e4567-e89b-42d3-a456-426614174000',
          resolved: true,
        },
        {
          conceptId: 'source-reference-index',
          path: 'knowledge/pages/source-reference-index.md',
          reference: `source:ks_123e4567-e89b-42d3-a456-426614174000@sha256:${'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}`,
          kind: 'registered-source',
          targetId: 'ks_123e4567-e89b-42d3-a456-426614174000',
          resolved: true,
        },
        {
          conceptId: 'source-reference-index',
          path: 'knowledge/pages/source-reference-index.md',
          reference: `knowledge:${knowledge.id}`,
          kind: 'workspace-knowledge',
          targetId: knowledge.id,
          resolved: true,
        },
        {
          conceptId: 'source-reference-index',
          path: 'knowledge/pages/source-reference-index.md',
          reference: `knowledge:${knowledge.id}@sha256:${'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'}`,
          kind: 'workspace-knowledge',
          targetId: knowledge.id,
          resolved: true,
        },
        {
          conceptId: 'source-reference-index',
          path: 'knowledge/pages/source-reference-index.md',
          reference: 'source:ks_missing',
          kind: 'registered-source',
          targetId: null,
          resolved: false,
        },
        {
          conceptId: 'source-reference-index',
          path: 'knowledge/pages/source-reference-index.md',
          reference: 'knowledge:kn_missing',
          kind: 'workspace-knowledge',
          targetId: 'kn_missing',
          resolved: false,
        },
        {
          conceptId: 'source-reference-index',
          path: 'knowledge/pages/source-reference-index.md',
          reference: 'https://example.com/source',
          kind: 'external-reference',
          targetId: null,
          resolved: true,
        },
        {
          conceptId: 'source-reference-index',
          path: 'knowledge/pages/source-reference-index.md',
          reference: 'not-a-valid-external-reference',
          kind: 'external-reference',
          targetId: null,
          resolved: false,
        },
      ]),
    });
  });

  it('rebuilds the knowledge link graph from active file-backed pages', () => {
    const dataRoot = createDataRoot();
    const store = createDemoStore({ dataRoot });
    const workspaceRoot = join(dataRoot, 'workspaces', 'ws_demo');
    const timestamp = '2026-07-07T00:00:00.000Z';

    store.createKnowledgeEntry('ws_demo', {
      kind: 'project-context',
      title: 'Seed knowledge',
      content: 'Seed body.',
    });
    writeFileSync(
      join(workspaceRoot, 'knowledge', 'pages', 'alpha.md'),
      [
        '---',
        'type: "KnowledgePage"',
        'title: "Alpha knowledge"',
        'schema_version: "openkit-workspace-knowledge-schema-v2"',
        'openkit_status: "active"',
        'status: "stable"',
        'scope: "workspace"',
        'source_refs: []',
        'review_state: "user-authored"',
        'sensitivity: "normal"',
        'freshness: "current"',
        `created_at: "${timestamp}"`,
        `updated_at: "${timestamp}"`,
        '---',
        'See [Beta](/beta.md), [Missing](./missing.md), and [External](https://example.com).',
        '',
      ].join('\n')
    );
    writeFileSync(
      join(workspaceRoot, 'knowledge', 'pages', 'beta.md'),
      [
        '---',
        'type: "KnowledgePage"',
        'title: "Beta knowledge"',
        'schema_version: "openkit-workspace-knowledge-schema-v2"',
        'openkit_status: "active"',
        'status: "stable"',
        'scope: "workspace"',
        'source_refs: []',
        'review_state: "user-authored"',
        'sensitivity: "normal"',
        'freshness: "current"',
        `created_at: "${timestamp}"`,
        `updated_at: "${timestamp}"`,
        '---',
        'Beta body.',
        '',
      ].join('\n')
    );

    rebuildWorkspaceDerivedIndexes({
      dataRoot,
      workspaceId: 'ws_demo',
    });

    const graph = JSON.parse(
      readFileSync(join(workspaceRoot, 'indexes', 'knowledge-links.json'), 'utf8')
    ) as {
      schemaVersion: number;
      workspaceId: string;
      edges: Array<{ fromId: string; target: string; toId: string; resolved: boolean }>;
    };

    expect(graph).toMatchObject({
      schemaVersion: 1,
      workspaceId: 'ws_demo',
      edges: expect.arrayContaining([
        {
          fromId: 'alpha',
          target: '/beta.md',
          toId: 'beta',
          resolved: true,
        },
        {
          fromId: 'alpha',
          target: './missing.md',
          toId: 'missing',
          resolved: false,
        },
      ]),
    });
    expect(graph.edges).toHaveLength(2);
  });

  it('rebuilds existing workspace indexes during boot scan', () => {
    const dataRoot = createDataRoot();
    const store = createDemoStore({ dataRoot });
    store.createThread('ws_demo', 'Boot rebuild thread');
    const indexesRoot = join(dataRoot, 'workspaces', 'ws_demo', 'indexes');
    const retrievalSentinel = join(indexesRoot, 'retrieval', 'CURRENT');
    mkdirSync(indexesRoot, { recursive: true });
    mkdirSync(join(indexesRoot, 'retrieval'));
    writeFileSync(retrievalSentinel, 'kernel-generation\n');
    writeFileSync(join(indexesRoot, 'stale.json'), '{}');

    const results = rebuildExistingWorkspaceDerivedIndexes(dataRoot, {
      now: () => '2026-07-05T00:00:00.000Z',
    });

    expect(results).toEqual(
      expect.arrayContaining([
        {
          workspaceId: 'ws_demo',
          indexPath: 'workspaces/ws_demo/indexes/knowledge-validation.json',
          itemCount: expect.any(Number),
          removedEntries: ['stale.json'],
        },
      ])
    );
    expect(existsSync(join(indexesRoot, 'stale.json'))).toBe(false);
    expect(readFileSync(retrievalSentinel, 'utf8')).toBe('kernel-generation\n');
    const validation = JSON.parse(
      readFileSync(join(indexesRoot, 'knowledge-validation.json'), 'utf8')
    ) as { rebuiltAt: string; workspaceId: string; records: unknown[] };
    expect(validation).toMatchObject({
      rebuiltAt: '2026-07-05T00:00:00.000Z',
      workspaceId: 'ws_demo',
    });
    expect(results.find((result) => result.workspaceId === 'ws_demo')?.itemCount).toBe(
      validation.records.length
    );
    expect(readdirSync(indexesRoot).sort()).toEqual([
      'knowledge-links.json',
      'knowledge-source-refs.json',
      'knowledge-validation.json',
      'retrieval',
    ]);
  });

  it('skips workspace directories without a canonical projection during boot scan', () => {
    const dataRoot = createDataRoot();
    mkdirSync(join(dataRoot, 'workspaces', 'half-built', 'indexes'), {
      recursive: true,
    });

    expect(rebuildExistingWorkspaceDerivedIndexes(dataRoot)).toEqual([]);
  });

  it('leaves a current derived index set byte-identical during the conditional boot scan', () => {
    const dataRoot = createDataRoot();
    createDemoStore({ dataRoot });
    const keptAt = '2026-07-05T00:00:00.000Z';
    const demoIndexes = join(dataRoot, 'workspaces', 'ws_demo', 'indexes');
    const quickChatIndexes = join(
      dataRoot,
      'workspaces',
      quickChatWorkspaceIdForUser(LOCAL_USER_ID),
      'indexes'
    );
    writeCurrentDerivedIndexSet(demoIndexes, 'ws_demo', keptAt);
    writeCurrentDerivedIndexSet(
      quickChatIndexes,
      quickChatWorkspaceIdForUser(LOCAL_USER_ID),
      keptAt
    );
    const demoBytes = readIndexBytes(demoIndexes);
    const quickChatBytes = readIndexBytes(quickChatIndexes);

    const results = rebuildInvalidExistingWorkspaceDerivedIndexes(dataRoot, {
      now: () => '2026-07-06T00:00:00.000Z',
    });

    expect(results).toEqual([]);
    expect(readIndexBytes(demoIndexes)).toEqual(demoBytes);
    expect(readIndexBytes(quickChatIndexes)).toEqual(quickChatBytes);
  });

  it.each(
    invalidDerivedIndexCases
  )('rebuilds only an index set with $name and keeps a current sibling byte-identical', ({
    mutate,
    throws,
  }) => {
    const dataRoot = createDataRoot();
    createDemoStore({ dataRoot });
    const keptAt = '2026-07-05T00:00:00.000Z';
    const siblingId = 'ws_demo';
    const badId = quickChatWorkspaceIdForUser(LOCAL_USER_ID);
    const siblingIndexes = join(dataRoot, 'workspaces', siblingId, 'indexes');
    const badIndexes = join(dataRoot, 'workspaces', badId, 'indexes');
    writeCurrentDerivedIndexSet(siblingIndexes, siblingId, keptAt);
    writeCurrentDerivedIndexSet(badIndexes, badId, keptAt);
    const siblingBytes = readIndexBytes(siblingIndexes);
    const outside = mutate(badIndexes);

    if (throws) {
      expect(() =>
        rebuildInvalidExistingWorkspaceDerivedIndexes(dataRoot, {
          now: () => '2026-07-06T00:00:00.000Z',
        })
      ).toThrow(/symbolic link/);
      expect(outside ? readFileSync(outside, 'utf8') : null).toBe('outside sentinel\n');
    } else {
      expect(
        rebuildInvalidExistingWorkspaceDerivedIndexes(dataRoot, {
          now: () => '2026-07-06T00:00:00.000Z',
        }).map((result) => result.workspaceId)
      ).toEqual([badId]);
      expect(
        JSON.parse(readFileSync(join(badIndexes, 'knowledge-validation.json'), 'utf8'))
      ).toMatchObject({
        rebuiltAt: '2026-07-06T00:00:00.000Z',
        schemaVersion: 1,
        workspaceId: badId,
      });
    }

    expect(readIndexBytes(siblingIndexes)).toEqual(siblingBytes);
  });

  it('rebuilds stale nonlexical indexes before kernel retrieval reads canonical pages', async () => {
    const dataRoot = createDataRoot();
    const store = createDemoStore({ dataRoot });
    const indexesRoot = join(dataRoot, 'workspaces', 'ws_demo', 'indexes');
    writeCurrentDerivedIndexSet(indexesRoot, 'ws_demo', '1999-01-01T00:00:00.000Z');
    rebuildWorkspaceDerivedIndexes({
      dataRoot,
      workspaceId: 'ws_demo',
      now: () => '2026-07-05T00:00:00.000Z',
    });

    const retrieval = await retrieveWorkspaceKnowledge({
      access: localRetrievalAccess(dataRoot, store),
      caller: 'app-api',
      dataRoot,
      limit: 5,
      now: () => '2026-07-05T00:00:00.000Z',
      query: 'protocol',
      workspaceId: 'ws_demo',
    });

    expect(retrieval.selected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reference: { scopeId: 'page/workspace/ws_demo', objectId: 'mem_project' },
        }),
      ])
    );
    expect(
      JSON.parse(readFileSync(join(indexesRoot, 'knowledge-validation.json'), 'utf8'))
    ).toMatchObject({
      rebuiltAt: '2026-07-05T00:00:00.000Z',
      schemaVersion: 1,
    });
  });
});

/** One invalid boot-scan fixture and whether the existing rebuild guard must throw. */
interface InvalidDerivedIndexCase {
  /** Case name interpolated into the test title. */
  name: string;
  /** Mutates a current index directory. Returns an outside sentinel path when one exists. */
  mutate: (indexesRoot: string) => string | undefined;
  /** Whether the scan must throw instead of publishing the bad set. */
  throws?: boolean;
}

const invalidDerivedIndexCases: InvalidDerivedIndexCase[] = [
  {
    name: 'a missing directory',
    mutate: (indexesRoot) => {
      rmSync(indexesRoot, { recursive: true });
      return undefined;
    },
  },
  {
    name: 'a missing file',
    mutate: (indexesRoot) => {
      rmSync(join(indexesRoot, 'knowledge-links.json'));
      return undefined;
    },
  },
  {
    name: 'an extra file',
    mutate: (indexesRoot) => {
      writeFileSync(join(indexesRoot, 'extra.json'), '{}\n');
      return undefined;
    },
  },
  {
    name: 'a symlinked child',
    throws: true,
    mutate: (indexesRoot) => {
      const outsideRoot = mkdtempSync(join(tmpdir(), 'openkit-outside-index-file-'));
      const sentinelPath = join(outsideRoot, 'sentinel.txt');
      writeFileSync(sentinelPath, 'outside sentinel\n');
      rmSync(join(indexesRoot, 'knowledge-links.json'));
      symlinkSync(sentinelPath, join(indexesRoot, 'knowledge-links.json'));
      return sentinelPath;
    },
  },
  {
    name: 'unparseable JSON',
    mutate: (indexesRoot) => {
      writeFileSync(join(indexesRoot, 'knowledge-links.json'), '{\n');
      return undefined;
    },
  },
  {
    name: 'non-object JSON',
    mutate: (indexesRoot) => {
      writeFileSync(join(indexesRoot, 'knowledge-links.json'), '[]\n');
      return undefined;
    },
  },
  {
    name: 'a wrong schemaVersion',
    mutate: (indexesRoot) => {
      editDerivedIndex(indexesRoot, 'knowledge-validation.json', (record) => {
        record.schemaVersion = 2;
      });
      return undefined;
    },
  },
  {
    name: 'a wrong workspaceId',
    mutate: (indexesRoot) => {
      editDerivedIndex(indexesRoot, 'knowledge-links.json', (record) => {
        record.workspaceId = 'ws_other';
      });
      return undefined;
    },
  },
  {
    name: 'a missing collection array',
    mutate: (indexesRoot) => {
      editDerivedIndex(indexesRoot, 'knowledge-validation.json', (record) => {
        delete record.records;
      });
      return undefined;
    },
  },
];

/**
 * Writes the three current nonlexical derived index files with empty collections.
 *
 * @param indexesRoot Index directory to replace.
 * @param workspaceId Workspace id stored in each file.
 * @param rebuiltAt Deterministic rebuild timestamp.
 */
function writeCurrentDerivedIndexSet(
  indexesRoot: string,
  workspaceId: string,
  rebuiltAt: string
): void {
  mkdirSync(indexesRoot, { recursive: true });
  const header = { schemaVersion: 1, workspaceId, rebuiltAt };
  const files: Record<string, unknown> = {
    'knowledge-links.json': { ...header, edges: [] },
    'knowledge-validation.json': { ...header, records: [] },
    'knowledge-source-refs.json': { ...header, references: [] },
  };

  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(indexesRoot, name), `${JSON.stringify(value, null, 2)}\n`);
  }
}

/**
 * Reads direct index-file bytes in file-name order.
 *
 * @param indexesRoot Index directory.
 * @returns File name and exact bytes.
 */
function readIndexBytes(indexesRoot: string): Array<[string, Buffer]> {
  return readdirSync(indexesRoot)
    .sort()
    .map((name) => [name, readFileSync(join(indexesRoot, name))] as [string, Buffer]);
}

/**
 * Edits one derived index JSON object in place.
 *
 * @param indexesRoot Index directory.
 * @param name File name.
 * @param edit Mutation applied to the parsed object.
 */
function editDerivedIndex(
  indexesRoot: string,
  name: string,
  edit: (record: Record<string, unknown>) => void
): void {
  const path = join(indexesRoot, name);
  const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  edit(record);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}

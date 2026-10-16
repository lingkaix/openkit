import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KnowledgeRetrievalResponseSchema,
  WorkspaceExportResponseSchema,
  WorkspaceImportResponseSchema,
} from '@openkit/app-api-schemas';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createApp } from '../app.js';
import { ensureLocalUser } from '../auth/identity.js';
import { KnowledgeNotebook } from '../knowledge/notebook.js';
import { assertPortableWorkspaceNotebookDisclosure } from '../knowledge/notebook-workspace-portability.js';
import {
  DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
  parseOkfDocument,
  updateOkfFrontmatter,
} from '../knowledge/okf.js';
import { FsStore } from '../lib/store.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { knowledgeOperationRequest } from '../test-support/knowledge-operation.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { openCoreDb } from './db.js';
import { LOCAL_USER_ID, readDataRootLayoutMarker } from './fs-layout.js';
import { retrieveWorkspaceKnowledge } from './index-rebuild.js';
import { applyMigrations } from './migrate.js';
import { publishRetrievalTrace, retrievalTraceRelativePath } from './retrieval-traces.js';
import { verifyWorkspaceExportTree } from './workspace-export.js';
import {
  readWorkspaceKnowledgePage,
  serializeUserAuthoredKnowledgePage,
} from './workspace-file-records.js';
import { readWorkspaceImportSnapshot } from './workspace-import.js';
import { readWorkspacePortableFileState } from './workspace-portable-file-state.js';

/**
 * Reads one optional JSONL fixture so a single red test can report every missing file family.
 *
 * @param path Canonical workspace JSONL path.
 * @returns Parsed rows, or an empty list when the file is absent.
 */
function readOptionalJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) {
    return [];
  }

  const text = readFileSync(path, 'utf8').trim();
  return text ? text.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>) : [];
}

/** Initializes real Git authority for bare directory-inventory fixtures. */
function initializeNotebook(workspaceRoot: string): KnowledgeNotebook {
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(workspaceRoot, 'knowledge', 'notebook.git'),
  });
  notebook.initialize({
    metadata: {
      summary: 'Initialize portable file fixture',
      producer: { kind: 'user', id: LOCAL_USER_ID },
      authority: { kind: 'direct', instructionReference: 'test:portable-file-inventory' },
      changeRequest: {
        requestId: randomUUID(),
        inputDigest: commandInputHash('portable-file-inventory'),
      },
      sourceReferences: [],
    },
  });
  mkdirSync(join(workspaceRoot, 'knowledge', 'schema'), { recursive: true });
  writeFileSync(
    join(workspaceRoot, 'knowledge', 'schema', 'scope-schema.yaml'),
    DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT
  );
  return notebook;
}

/** Fresh current Workspace avoids unrelated Demo source disclosure in export-refusal tests. */
function workspaceFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-portable-files-'));
  const coreDb = openCoreDb(dataRoot);
  onTestFinished(() => {
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Demo Workspace', {
    requestId: randomUUID(),
    producer: { kind: 'user', id: LOCAL_USER_ID },
    instructionReference: 'test:portable-workspace',
  });
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: LOCAL_USER_ID, workspaceId: workspace.id });
  const workspaceRoot = join(dataRoot, 'workspaces', workspace.id);
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(workspaceRoot, 'knowledge', 'notebook.git'),
  });
  return { dataRoot, coreDb, store, workspaceId: workspace.id, workspaceRoot, notebook };
}

/** Publishes only test-owned content; native human Review uses its real operation below. */
function publishFixturePages(
  notebook: KnowledgeNotebook,
  changes: Record<string, string>,
  sourceReferences: readonly string[] = []
): string {
  const baseRevision = notebook.publishedRevision();
  const candidateRevision = notebook.prepare({
    baseRevision,
    changes,
    metadata: {
      summary: 'Publish portable test bytes',
      producer: { kind: 'user', id: LOCAL_USER_ID },
      authority: { kind: 'direct', instructionReference: 'test:portable-pages' },
      changeRequest: { requestId: randomUUID(), inputDigest: commandInputHash(changes) },
      sourceReferences: [...sourceReferences],
    },
  });
  notebook.publish({ baseRevision, candidateRevision });
  return candidateRevision;
}

describe('workspace portable file state', () => {
  it('rejects a publisher-temp-shaped directory in a retrieval trace directory', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-retrieval-trace-temp-entry-'));
    try {
      initializeNotebook(workspaceRoot);
      const threadId = 'th_00000000-0000-4000-8000-000000000881';
      const traceDirectory = join(workspaceRoot, 'threads', threadId, 'retrieval-traces');
      mkdirSync(traceDirectory, { recursive: true });
      const tempPath = join(
        traceDirectory,
        '.krt_00000000-0000-4000-8000-000000000882.00000000-0000-4000-8000-000000000883.tmp'
      );
      mkdirSync(tempPath);

      expect(() =>
        readWorkspacePortableFileState(workspaceRoot, {
          workspaceId: 'ws_demo',
          threads: [{ threadId }],
          turns: [],
        })
      ).toThrow(/invalid entry/i);
    } finally {
      rmSync(workspaceRoot, { force: true, recursive: true });
    }
  });

  it('ignores a regular publisher temporary file in a retrieval trace directory', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-retrieval-trace-temp-file-'));
    try {
      initializeNotebook(workspaceRoot);
      const threadId = 'th_00000000-0000-4000-8000-000000000881';
      const traceDirectory = join(workspaceRoot, 'threads', threadId, 'retrieval-traces');
      mkdirSync(traceDirectory, { recursive: true });
      writeFileSync(
        join(
          traceDirectory,
          '.krt_00000000-0000-4000-8000-000000000882.00000000-0000-4000-8000-000000000883.tmp'
        ),
        'incomplete'
      );

      expect(
        readWorkspacePortableFileState(workspaceRoot, {
          workspaceId: 'ws_demo',
          threads: [{ threadId }],
          turns: [],
        }).retrievalTraceFiles.size
      ).toBe(0);
    } finally {
      rmSync(workspaceRoot, { force: true, recursive: true });
    }
  });

  it('preserves authoritative workspace files, append history, and reminted references', async () => {
    const {
      dataRoot,
      coreDb,
      store,
      workspaceId: sourceWorkspaceId,
      workspaceRoot: sourceRoot,
      notebook,
    } = workspaceFixture();
    const firstTimestamp = '2026-07-06T00:00:00.000Z';
    const secondTimestamp = '2026-07-06T00:00:01.000Z';
    const knowledge = {
      id: 'portable-contract',
      kind: 'project-context' as const,
      title: 'Portable contract',
      content: 'Portable contract evidence survives workspace transfer.',
      sourceReferences: [],
      createdAt: firstTimestamp,
      updatedAt: firstTimestamp,
    };
    publishFixturePages(notebook, {
      [`${knowledge.id}.md`]: serializeUserAuthoredKnowledgePage(knowledge, {
        kind: 'workspace',
        workspaceId: sourceWorkspaceId,
      }),
    });

    store.recordKnowledgeObservation({
      id: 'ko_portable_first',
      workspaceId: sourceWorkspaceId,
      kind: 'maintenance',
      summary: 'First portable observation.',
      sourceReferences: ['claim:kc_portable_source'],
      scope: 'workspace',
      producer: 'portability-test',
      confidence: 0.9,
      freshness: 'current',
      status: 'retained',
      observedAt: firstTimestamp,
      createdAt: firstTimestamp,
    });
    store.recordKnowledgeObservation({
      id: 'ko_portable_second',
      workspaceId: sourceWorkspaceId,
      kind: 'maintenance',
      summary: 'Second portable observation.',
      sourceReferences: ['claim:kc_portable_source'],
      scope: 'workspace',
      producer: 'portability-test',
      confidence: 1,
      freshness: 'current',
      status: 'promoted',
      observedAt: secondTimestamp,
      createdAt: secondTimestamp,
    });
    store.recordKnowledgeClaim({
      id: 'kc_portable_first',
      workspaceId: sourceWorkspaceId,
      statement: 'First portable claim.',
      sourceReferences: [`knowledge:${knowledge.id}`],
      scope: 'workspace',
      producer: 'portability-test',
      confidence: 0.8,
      freshness: 'current',
      reviewState: 'accepted',
      conflictStatus: 'none',
      createdAt: firstTimestamp,
      updatedAt: firstTimestamp,
    });
    store.recordKnowledgeClaim({
      id: 'kc_portable_source',
      workspaceId: sourceWorkspaceId,
      statement: 'Source-backed portable claim.',
      sourceReferences: [`knowledge:${knowledge.id}`],
      scope: 'workspace',
      producer: 'portability-test',
      confidence: 1,
      freshness: 'current',
      reviewState: 'accepted',
      conflictStatus: 'none',
      createdAt: secondTimestamp,
      updatedAt: secondTimestamp,
    });
    store.recordKnowledgeConflict({
      id: 'kf_portable',
      workspaceId: sourceWorkspaceId,
      subjectReferences: [`knowledge:${knowledge.id}`, 'claim:kc_portable_source'],
      sourceReferences: [`knowledge:${knowledge.id}`],
      status: 'needs_review',
      summary: 'Portable conflict needs review.',
      suggestedActions: ['Resolve the portable conflict.'],
      producer: 'portability-test',
      createdAt: firstTimestamp,
      updatedAt: firstTimestamp,
    });
    store.resolveKnowledgeConflict({
      workspaceId: sourceWorkspaceId,
      conflictId: 'kf_portable',
      status: 'resolved',
      resolution: 'Portable conflict resolved.',
      resolvedBy: 'portability-test',
      resolvedAt: secondTimestamp,
    });
    const workspaceConfig = [
      '{',
      '  // This workspace-local policy comment must survive transfer.',
      '  "schemaVersion": 1,',
      '  "workspace": {',
      '    "name": "Demo Workspace",',
      '    "roots": [],',
      '    "assistant": { "repositoryInspection": { "enabled": false } }',
      '  }',
      '}',
      '',
    ].join('\n');
    const workspaceSchema = [
      'schema_version: "openkit-scope-knowledge-schema-v4"',
      'status: "active"',
      'allowed_types: ["KnowledgePage", "RepoConvention"]',
      'allowed_statuses: ["active"]',
      'allowed_review_states: ["accepted", "user-authored"]',
      'allowed_sensitivities: ["normal", "confidential"]',
      'allowed_freshness: ["current"]',
      '',
    ].join('\n');
    const portablePage = updateOkfFrontmatter({
      path: 'portable-file.md',
      content: serializeUserAuthoredKnowledgePage(
        {
          id: 'portable-file',
          kind: 'project-context',
          title: 'Portable file convention',
          content: 'Portable file convention body.',
          sourceReferences: [`knowledge:${knowledge.id}`],
          createdAt: firstTimestamp,
          updatedAt: secondTimestamp,
        },
        { kind: 'workspace', workspaceId: sourceWorkspaceId }
      ),
      updates: { type: 'RepoConvention' },
    });
    mkdirSync(join(sourceRoot, 'config'), { recursive: true });
    writeFileSync(join(sourceRoot, 'config', 'workspace.jsonc'), workspaceConfig);
    writeFileSync(join(sourceRoot, 'knowledge', 'schema', 'scope-schema.yaml'), workspaceSchema);
    publishFixturePages(notebook, { 'portable-file.md': portablePage }, [
      `knowledge:${knowledge.id}`,
    ]);

    const knowledgePageBytes = readWorkspaceKnowledgePage(sourceRoot, knowledge.id)!;
    const knowledgeReference = `knowledge:${knowledge.id}@sha256:${createHash('sha256').update(knowledgePageBytes).digest('hex')}`;
    const acceptedPageId = 'portable-accepted-proposal';
    const acceptedPageBytes = updateOkfFrontmatter({
      path: `${acceptedPageId}.md`,
      content: serializeUserAuthoredKnowledgePage(
        {
          id: acceptedPageId,
          kind: 'project-context',
          title: 'Portable accepted proposal',
          content: 'Exact accepted proposal bytes survive portable transfer.',
          sourceReferences: [knowledgeReference],
          createdAt: firstTimestamp,
          updatedAt: secondTimestamp,
        },
        { kind: 'workspace', workspaceId: sourceWorkspaceId }
      ),
      updates: { review_state: 'accepted' },
    });
    const acceptedPageDigest = `sha256:${createHash('sha256')
      .update(acceptedPageBytes)
      .digest('hex')}`;
    const acceptedProposal = store.createKnowledgeProposal({
      workspaceId: sourceWorkspaceId,
      requestId: '00000000-0000-4000-8000-00000000d911',
      baseRevision: notebook.publishedRevision(),
      knowledgePageId: acceptedPageId,
      canonicalPageBytes: acceptedPageBytes,
      contentDigest: acceptedPageDigest,
      sourceReferences: [knowledgeReference],
      rationale: 'Preserve the exact reviewed page as portable Knowledge.',
      confidence: 1,
      verifiedExternalReferences: [],
      producer: { kind: 'agent', id: 'agent_knowledge', responsibleUserId: LOCAL_USER_ID },
      createdAt: firstTimestamp,
    });
    const app = createApp({ coreDb, dataRoot, store });
    const review = await app.request(
      ...knowledgeOperationRequest(
        'knowledge.proposal.decide',
        { workspaceId: sourceWorkspaceId, proposalId: acceptedProposal.id },
        {
          body: JSON.stringify({
            requestId: randomUUID(),
            decision: 'accepted',
            baseRevision: acceptedProposal.baseRevision,
            candidateRevision: acceptedProposal.candidateRevision,
            proposalDigest: store.knowledgeProposalDigest(sourceWorkspaceId, acceptedProposal.id),
          }),
        }
      )
    );
    expect(review.status, await review.clone().text()).toBe(200);
    expect(readWorkspaceKnowledgePage(sourceRoot, acceptedPageId)).toBe(acceptedPageBytes);

    const retrievalRes = await app.request(
      ...knowledgeOperationRequest(
        'knowledge.retrieval',
        { workspaceId: sourceWorkspaceId },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: 'portable file convention', limit: 1 }),
        }
      )
    );
    expect(retrievalRes.status, await retrievalRes.clone().text()).toBe(200);
    const retrieval = KnowledgeRetrievalResponseSchema.parse(await retrievalRes.json());
    expect(retrieval.selected).toEqual([
      expect.objectContaining({
        reference: {
          scopeId: `page/workspace/${sourceWorkspaceId}`,
          objectId: 'portable-file',
        },
        sourceReferences: [`knowledge:${knowledge.id}`],
      }),
    ]);
    expect(retrieval.retrievalTraceRef).toBeUndefined();

    const exportRes = await app.request(
      ...operationRequest(
        'workspace.export',
        { workspaceId: sourceWorkspaceId },
        {
          method: 'POST',
        }
      )
    );
    expect(exportRes.status, await exportRes.clone().text()).toBe(200);
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());
    const verified = verifyWorkspaceExportTree({
      exportRoot: join(
        dataRoot,
        'server',
        'exports',
        'workspaces',
        sourceWorkspaceId,
        exported.exportId
      ),
    });
    const acceptedExportPath = `workspace-files/knowledge/pages/${acceptedPageId}.md`;
    expect(verified.fileContents.get(acceptedExportPath)).toBe(acceptedPageBytes);
    for (const [name, alter] of [
      ['missing', (files: Map<string, string>) => files.delete(acceptedExportPath)],
      [
        'contradictory',
        (files: Map<string, string>) =>
          files.set(
            acceptedExportPath,
            acceptedPageBytes.replace(
              'Exact accepted proposal bytes survive portable transfer.',
              'Contradictory page content must fail import.'
            )
          ),
      ],
      [
        'duplicate-record',
        (files: Map<string, string>) => {
          const records = files.get('records/knowledge.jsonl');
          if (!records) {
            throw new Error('Knowledge records are unavailable in the export fixture.');
          }
          files.set('records/knowledge.jsonl', `${records}${records.split('\n')[0]}\n`);
        },
      ],
    ] as const) {
      const fileContents = new Map(verified.fileContents);
      alter(fileContents);
      expect(
        () =>
          readWorkspaceImportSnapshot({
            verified: { ...verified, fileContents },
            targetWorkspaceId: `ws_${name}_page_import`,
          }),
        name
      ).toThrow(/Knowledge Page/i);
    }
    const importRes = await app.request(
      ...operationRequest(
        'workspace.import',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sourceWorkspaceId,
            exportId: exported.exportId,
            requestId: '00000000-0000-4000-8000-00000000d901',
          }),
        }
      )
    );
    expect(importRes.status, await importRes.clone().text()).toBe(200);
    const imported = WorkspaceImportResponseSchema.parse(await importRes.json());
    const importedWorkspaceId = imported.importedWorkspaceId;
    const importedRoot = join(dataRoot, 'workspaces', importedWorkspaceId);
    const importedKnowledge = store
      .listKnowledge(importedWorkspaceId)
      .find((entry) => entry.title === knowledge.title);
    const importedAcceptedKnowledge = store
      .listKnowledge(importedWorkspaceId)
      .find((entry) => entry.title === 'Portable accepted proposal');
    expect(importedKnowledge).toBeDefined();
    expect(importedAcceptedKnowledge).toBeDefined();
    if (!importedKnowledge || !importedAcceptedKnowledge) {
      coreDb.sqlite.close();
      return;
    }

    const observationRows = readOptionalJsonl(
      join(importedRoot, 'knowledge', 'observations', '202607.jsonl')
    );
    expect
      .soft(observationRows.map((row) => row.summary))
      .toEqual(['First portable observation.', 'Second portable observation.']);
    expect
      .soft(observationRows.map((row) => row.workspaceId))
      .toEqual([importedWorkspaceId, importedWorkspaceId]);

    const claimRows = readOptionalJsonl(join(importedRoot, 'knowledge', 'claims', '202607.jsonl'));
    expect
      .soft(claimRows.map((row) => row.statement))
      .toEqual(['First portable claim.', 'Source-backed portable claim.']);
    expect
      .soft(claimRows.map((row) => row.workspaceId))
      .toEqual([importedWorkspaceId, importedWorkspaceId]);
    expect
      .soft(claimRows.map((row) => row.sourceReferences))
      .toEqual([[`knowledge:${importedKnowledge.id}`], [`knowledge:${importedKnowledge.id}`]]);
    const importedSourceClaim = claimRows.find(
      (row) => row.statement === 'Source-backed portable claim.'
    );
    expect.soft(importedSourceClaim?.id).toEqual(expect.any(String));

    const conflictRows = readOptionalJsonl(
      join(importedRoot, 'knowledge', 'conflicts', '202607.jsonl')
    );
    expect.soft(conflictRows.map((row) => row.status)).toEqual(['needs_review', 'resolved']);
    expect
      .soft(conflictRows.map((row) => row.workspaceId))
      .toEqual([importedWorkspaceId, importedWorkspaceId]);
    expect.soft(conflictRows[1]).toMatchObject({
      resolution: 'Portable conflict resolved.',
      sourceReferences: [`knowledge:${importedKnowledge.id}`],
      subjectReferences: [
        `knowledge:${importedKnowledge.id}`,
        `claim:${String(importedSourceClaim?.id)}`,
      ],
    });

    expect(existsSync(join(importedRoot, 'knowledge', 'traces'))).toBe(false);

    const importedConfigPath = join(importedRoot, 'config', 'workspace.jsonc');
    expect
      .soft(existsSync(importedConfigPath) ? readFileSync(importedConfigPath, 'utf8') : null)
      .toBe(workspaceConfig);
    const importedSchemaPath = join(importedRoot, 'knowledge', 'schema', 'scope-schema.yaml');
    expect
      .soft(existsSync(importedSchemaPath) ? readFileSync(importedSchemaPath, 'utf8') : null)
      .toBe(workspaceSchema);
    expect(existsSync(join(importedRoot, 'knowledge', 'pages'))).toBe(false);
    const importedPage = readWorkspaceKnowledgePage(importedRoot, 'portable-file')!;
    expect(importedPage).toBe(
      updateOkfFrontmatter({
        path: 'portable-file.md',
        content: portablePage,
        updates: {
          scope: { kind: 'workspace', workspaceId: importedWorkspaceId },
          source_refs: [`knowledge:${importedKnowledge.id}`],
        },
      })
    );
    const importedNativePage = readWorkspaceKnowledgePage(importedRoot, importedKnowledge.id)!;
    expect(importedNativePage).toContain(`openkit_entry_id: "${importedKnowledge.id}"`);
    const expectedImportedAcceptedPageBytes = updateOkfFrontmatter({
      path: `${importedAcceptedKnowledge.id}.md`,
      content: acceptedPageBytes,
      updates: {
        scope: { kind: 'workspace', workspaceId: importedWorkspaceId },
        source_refs: [knowledgeReference.replaceAll(knowledge.id, importedKnowledge.id)],
      },
    });
    expect(readWorkspaceKnowledgePage(importedRoot, importedAcceptedKnowledge.id)).toBe(
      expectedImportedAcceptedPageBytes
    );
    expect(store.listKnowledgeProposals(importedWorkspaceId)).toEqual([]);
    expect(store.listKnowledgeProposalReviewDecisions(importedWorkspaceId)).toEqual([]);

    store.updateWorkspace(importedWorkspaceId, { name: 'Persist unrelated imported change' });
    expect(readWorkspaceKnowledgePage(importedRoot, importedAcceptedKnowledge.id)).toBe(
      expectedImportedAcceptedPageBytes
    );
    const restartedStore = new FsStore({ dataRoot });
    expect(
      restartedStore
        .listKnowledge(importedWorkspaceId)
        .some((entry) => entry.id === importedAcceptedKnowledge.id)
    ).toBe(true);
    expect(readWorkspaceKnowledgePage(importedRoot, importedAcceptedKnowledge.id)).toBe(
      expectedImportedAcceptedPageBytes
    );

    const importedRetrievalRes = await app.request(
      ...knowledgeOperationRequest(
        'knowledge.retrieval',
        { workspaceId: importedWorkspaceId },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: 'Exact accepted proposal bytes', limit: 1 }),
        }
      )
    );
    expect(importedRetrievalRes.status, await importedRetrievalRes.clone().text()).toBe(200);
    const importedRetrieval = KnowledgeRetrievalResponseSchema.parse(
      await importedRetrievalRes.json()
    );
    expect(importedRetrieval.selected).toEqual([
      expect.objectContaining({
        reference: {
          scopeId: `page/workspace/${importedWorkspaceId}`,
          objectId: importedAcceptedKnowledge.id,
        },
        sourceReferences: [knowledgeReference.replaceAll(knowledge.id, importedKnowledge.id)],
      }),
    ]);

    coreDb.sqlite.close();
  });

  it('fails export before publication when a retained trace source is no longer readable', async () => {
    const { dataRoot, coreDb, store, workspaceId, workspaceRoot, notebook } = workspaceFixture();
    const thread = store.createThread(workspaceId, 'Trace owner', undefined, 'conversation', {
      visibility: 'workspace',
    });
    const traceId = 'krt_00000000-0000-4000-8000-000000000882';
    const reference = {
      scopeId: `retrieval-trace/thread/${workspaceId}/${thread.id}`,
      objectId: traceId,
    } as const;
    publishRetrievalTrace(join(dataRoot, 'workspaces', workspaceId), reference, {
      traceId,
      queryContext: {
        serverId: readDataRootLayoutMarker(dataRoot).deploymentId,
        workspaceId,
        actor: { kind: 'user', id: LOCAL_USER_ID },
        threadId: thread.id,
      },
      sourceScope: `page/workspace/${workspaceId}`,
      notebookRevision: notebook.publishedRevision(),
      caller: 'app-api',
      requestDigest: `sha256:${'8'.repeat(64)}`,
      retrievalParameters: {
        limit: 1,
        pinnedReferences: [],
        states: ['active'],
        sourceScope: 'workspace',
      },
      selected: [],
      excluded: [
        {
          reference: {
            scopeId: `page/workspace/${workspaceId}`,
            objectId: 'restricted-same-path',
          },
          revision: null,
          contentDigest: null,
          sourceReferences: [],
          reason: 'source_unavailable',
        },
      ],
      createdAt: '2026-07-06T00:00:00.000Z',
    });
    const portableState = readWorkspacePortableFileState(workspaceRoot, {
      workspaceId,
      threads: [{ threadId: thread.id }],
      turns: [],
    });
    expect(() =>
      assertPortableWorkspaceNotebookDisclosure({
        dataRoot,
        workspaceId,
        notebookRevision: portableState.notebookRevision!,
        pages: portableState.nativeKnowledgePages,
        access: {
          store,
          coreDb,
          actor: { kind: 'user', id: LOCAL_USER_ID },
          requestActor: { kind: 'local', userId: LOCAL_USER_ID },
        },
      })
    ).not.toThrow();
    const app = createApp({ coreDb, dataRoot, store });
    const response = await app.request(
      ...operationRequest('workspace.export', { workspaceId }, { method: 'POST' })
    );
    const body = await response.text();

    expect(response.status, body).toBe(503);
    expect(JSON.parse(body)).toMatchObject({ code: 'knowledge_source_unavailable' });
    expect(body).not.toContain('restricted-same-path');
    const workspaceExports = join(dataRoot, 'server', 'exports', 'workspaces', workspaceId);
    expect(existsSync(workspaceExports) ? readdirSync(workspaceExports) : []).toEqual([]);
    coreDb.sqlite.close();
  });

  it('fails export without disclosure when a selected page becomes restricted', async () => {
    const { dataRoot, coreDb, store, workspaceId, workspaceRoot, notebook } = workspaceFixture();
    const thread = store.createThread(workspaceId, 'Trace owner', undefined, 'conversation', {
      visibility: 'workspace',
    });
    const page = {
      id: 'revoked-export-selection',
      kind: 'project-context' as const,
      title: 'Revoked export selection',
      content: 'This content must not leave after revocation.',
      sourceReferences: [],
      createdAt: '2026-07-06T00:00:00.000Z',
      updatedAt: '2026-07-06T00:00:00.000Z',
    };
    const pageBytes = serializeUserAuthoredKnowledgePage(page, { kind: 'workspace', workspaceId });
    publishFixturePages(notebook, { [`${page.id}.md`]: pageBytes });
    const result = await retrieveWorkspaceKnowledge({
      dataRoot,
      workspaceId,
      caller: 'app-api',
      query: 'Revoked export selection',
      limit: 1,
      pinnedReferences: [{ scopeId: `page/workspace/${workspaceId}`, objectId: page.id }],
      access: {
        store,
        coreDb,
        actor: { kind: 'user', id: LOCAL_USER_ID },
        requestActor: { kind: 'local', userId: LOCAL_USER_ID },
        outputThreadId: thread.id,
      },
      traceId: 'krt_00000000-0000-4000-8000-000000000883',
      now: () => '2026-07-06T00:00:00.000Z',
    });
    expect(result.retrievalTraceRef).toBeDefined();
    const tracePath = join(
      dataRoot,
      'workspaces',
      workspaceId,
      retrievalTraceRelativePath(result.retrievalTraceRef!)
    );
    const originalTrace = readFileSync(tracePath, 'utf8');
    const selectedRevision = notebook.publishedRevision();
    expect(result.selected).toEqual([
      expect.objectContaining({
        reference: { scopeId: `page/workspace/${workspaceId}`, objectId: page.id },
        contentDigest: `sha256:${createHash('sha256').update(pageBytes).digest('hex')}`,
        revision: selectedRevision,
      }),
    ]);
    expect(readWorkspaceKnowledgePage(workspaceRoot, page.id)).toBe(pageBytes);
    const restrictedRevision = publishFixturePages(notebook, {
      [`${page.id}.md`]: updateOkfFrontmatter({
        path: `${page.id}.md`,
        content: readWorkspaceKnowledgePage(workspaceRoot, page.id)!,
        updates: { sensitivity: 'restricted' },
      }),
    });
    const restrictedBytes = readWorkspaceKnowledgePage(workspaceRoot, page.id)!;
    const restrictedPage = parseOkfDocument({ path: `${page.id}.md`, content: restrictedBytes });
    expect(restrictedRevision).not.toBe(selectedRevision);
    expect(notebook.publishedRevision()).toBe(restrictedRevision);
    expect(restrictedBytes).not.toBe(pageBytes);
    expect(restrictedPage.ok).toBe(true);
    if (!restrictedPage.ok) throw new Error('Restricted fixture page must remain valid OKF.');
    expect(restrictedPage.document.frontmatter.sensitivity).toBe('restricted');
    const app = createApp({ coreDb, dataRoot, store });
    const response = await app.request(
      ...operationRequest('workspace.export', { workspaceId }, { method: 'POST' })
    );
    const body = await response.text();

    expect(response.status, body).toBe(403);
    expect(JSON.parse(body)).toMatchObject({ code: 'workspace_access_denied' });
    expect(body).not.toContain(page.id);
    expect(body).not.toContain('This content must not leave after revocation.');
    expect(readFileSync(tracePath, 'utf8')).toBe(originalTrace);
    const workspaceExports = join(dataRoot, 'server', 'exports', 'workspaces', workspaceId);
    expect(existsSync(workspaceExports) ? readdirSync(workspaceExports) : []).toEqual([]);
    coreDb.sqlite.close();
  });
});

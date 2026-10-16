import { createHash } from 'node:crypto';
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
import { describe, expect, it } from 'vitest';
import { FsStore } from '../lib/store.js';
import { createAppWithLocalIdentity as createApp } from '../test-support/app.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { knowledgeOperationRequest } from '../test-support/knowledge-operation.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { openCoreDb } from './db.js';
import { readDataRootLayoutMarker } from './fs-layout.js';
import { retrieveWorkspaceKnowledge } from './index-rebuild.js';
import { applyMigrations } from './migrate.js';
import { publishRetrievalTrace, retrievalTraceRelativePath } from './retrieval-traces.js';
import { verifyWorkspaceExportTree } from './workspace-export.js';
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

describe('workspace portable file state', () => {
  it('rejects a publisher-temp-shaped directory in a retrieval trace directory', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-retrieval-trace-temp-entry-'));
    try {
      const threadId = 'th_00000000-0000-7447-99d5-aafec0cacdd4';
      const traceDirectory = join(workspaceRoot, 'threads', threadId, 'retrieval-traces');
      mkdirSync(traceDirectory, { recursive: true });
      const tempPath = join(
        traceDirectory,
        '.krt_00000000-0000-7d0b-95d7-2834cc1f705c.00000000-0000-4000-8000-000000000883.tmp'
      );
      mkdirSync(tempPath);

      expect(() =>
        readWorkspacePortableFileState(workspaceRoot, {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
      const threadId = 'th_00000000-0000-7447-99d5-aafec0cacdd4';
      const traceDirectory = join(workspaceRoot, 'threads', threadId, 'retrieval-traces');
      mkdirSync(traceDirectory, { recursive: true });
      writeFileSync(
        join(
          traceDirectory,
          '.krt_00000000-0000-7d0b-95d7-2834cc1f705c.00000000-0000-4000-8000-000000000883.tmp'
        ),
        'incomplete'
      );

      expect(
        readWorkspacePortableFileState(workspaceRoot, {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threads: [{ threadId }],
          turns: [],
        }).retrievalTraceFiles.size
      ).toBe(0);
    } finally {
      rmSync(workspaceRoot, { force: true, recursive: true });
    }
  });

  it('preserves authoritative workspace files, append history, and reminted references', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-portable-files-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    const sourceWorkspaceId = 'ws_00000000-0000-7000-8000-000000000001';
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: sourceWorkspaceId,
    });
    const sourceRoot = join(dataRoot, 'workspaces', sourceWorkspaceId);
    const firstTimestamp = '2026-07-06T00:00:00.000Z';
    const secondTimestamp = '2026-07-06T00:00:01.000Z';
    const knowledge = store.createKnowledgeEntry(sourceWorkspaceId, {
      kind: 'project-context',
      title: 'Portable contract',
      content: 'Portable contract evidence survives workspace transfer.',
      sourceReferences: [],
    });

    store.recordKnowledgeObservation({
      id: 'ko_00000000-0000-72ae-82a2-428025c60c1b',
      workspaceId: sourceWorkspaceId,
      kind: 'maintenance',
      summary: 'First portable observation.',
      sourceReferences: ['claim:kc_00000000-0000-71a7-90bd-9df60db5bd84'],
      scope: 'workspace',
      producer: 'portability-test',
      confidence: 0.9,
      freshness: 'current',
      status: 'retained',
      observedAt: firstTimestamp,
      createdAt: firstTimestamp,
    });
    store.recordKnowledgeObservation({
      id: 'ko_00000000-0000-79e1-b411-0955d1d4fab5',
      workspaceId: sourceWorkspaceId,
      kind: 'maintenance',
      summary: 'Second portable observation.',
      sourceReferences: ['claim:kc_00000000-0000-71a7-90bd-9df60db5bd84'],
      scope: 'workspace',
      producer: 'portability-test',
      confidence: 1,
      freshness: 'current',
      status: 'promoted',
      observedAt: secondTimestamp,
      createdAt: secondTimestamp,
    });
    store.recordKnowledgeClaim({
      id: 'kc_00000000-0000-707a-a7d4-e48c361c5546',
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
      id: 'kc_00000000-0000-71a7-90bd-9df60db5bd84',
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
      id: 'kf_00000000-0000-72bb-b75d-46dfe72603e1',
      workspaceId: sourceWorkspaceId,
      subjectReferences: [
        `knowledge:${knowledge.id}`,
        'claim:kc_00000000-0000-71a7-90bd-9df60db5bd84',
      ],
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
      conflictId: 'kf_00000000-0000-72bb-b75d-46dfe72603e1',
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
      'schema_version: "openkit-workspace-knowledge-schema-v2"',
      'status: "active"',
      'allowed_types: ["KnowledgePage", "RepoConvention"]',
      'allowed_statuses: ["active"]',
      'allowed_review_states: ["accepted", "user-authored"]',
      'allowed_sensitivities: ["normal", "confidential"]',
      'allowed_freshness: ["current"]',
      '',
    ].join('\n');
    const portablePage = [
      '---',
      'type: "RepoConvention"',
      'title: "Portable file convention"',
      'schema_version: "openkit-workspace-knowledge-schema-v2"',
      'openkit_status: "active"',
      'status: "stable"',
      'scope: "workspace"',
      `source_refs: ["knowledge:${knowledge.id}"]`,
      'review_state: "user-authored"',
      'sensitivity: "normal"',
      'freshness: "current"',
      `created_at: "${firstTimestamp}"`,
      `updated_at: "${secondTimestamp}"`,
      '---',
      'Portable file convention body.',
      '',
    ].join('\n');

    mkdirSync(join(sourceRoot, 'config'), { recursive: true });
    writeFileSync(join(sourceRoot, 'config', 'workspace.jsonc'), workspaceConfig);
    writeFileSync(
      join(sourceRoot, 'knowledge', 'schema', 'workspace-schema.yaml'),
      workspaceSchema
    );
    writeFileSync(join(sourceRoot, 'knowledge', 'pages', 'portable-file.md'), portablePage);

    const knowledgePageBytes = readFileSync(
      join(sourceRoot, 'knowledge', 'pages', `${knowledge.id}.md`),
      'utf8'
    );
    const knowledgeReference = `knowledge:${knowledge.id}@sha256:${createHash('sha256')
      .update(knowledgePageBytes)
      .digest('hex')}`;
    const acceptedPageId = 'portable-accepted-proposal';
    const acceptedPageBytes = [
      '---',
      'type: "KnowledgePage"',
      'title: "Portable accepted proposal"',
      'schema_version: "openkit-workspace-knowledge-schema-v2"',
      'openkit_status: "active"',
      'status: "stable"',
      'scope: "workspace"',
      `openkit_entry_id: "${acceptedPageId}"`,
      'openkit_entry_kind: "project-context"',
      `source_refs: ${JSON.stringify([knowledgeReference])}`,
      'review_state: "accepted"',
      'sensitivity: "normal"',
      'freshness: "current"',
      `created_at: "${firstTimestamp}"`,
      `updated_at: "${secondTimestamp}"`,
      '---',
      'Exact accepted proposal bytes survive portable transfer.',
      '',
    ].join('\n');
    const acceptedPageDigest = `sha256:${createHash('sha256')
      .update(acceptedPageBytes)
      .digest('hex')}`;
    const acceptedProposal = store.createKnowledgeProposal({
      workspaceId: sourceWorkspaceId,
      requestId: '00000000-0000-4000-8000-00000000d911',
      knowledgePageId: acceptedPageId,
      canonicalPageBytes: acceptedPageBytes,
      contentDigest: acceptedPageDigest,
      sourceReferences: [knowledgeReference],
      rationale: 'Preserve the exact reviewed page as portable Knowledge.',
      confidence: 1,
      verifiedExternalReferences: [],
      producer: {
        kind: 'agent',
        id: 'agent_knowledge',
        responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
      },
      createdAt: firstTimestamp,
    });
    store.recordKnowledgeProposalReviewDecision({
      workspaceId: sourceWorkspaceId,
      proposalId: acceptedProposal.id,
      requestId: '00000000-0000-4000-8000-00000000d912',
      decision: 'accepted',
      verifiedExternalReferences: [],
      actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      decidedAt: secondTimestamp,
    });

    const app = createApp({ coreDb, dataRoot, store });
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
    const importedSchemaPath = join(importedRoot, 'knowledge', 'schema', 'workspace-schema.yaml');
    expect
      .soft(existsSync(importedSchemaPath) ? readFileSync(importedSchemaPath, 'utf8') : null)
      .toBe(workspaceSchema);
    const importedPagePath = join(importedRoot, 'knowledge', 'pages', 'portable-file.md');
    expect
      .soft(existsSync(importedPagePath) ? readFileSync(importedPagePath, 'utf8') : null)
      .toBe(portablePage.replace(`knowledge:${knowledge.id}`, `knowledge:${importedKnowledge.id}`));
    const importedNativePagePath = join(
      importedRoot,
      'knowledge',
      'pages',
      `${importedKnowledge.id}.md`
    );
    expect
      .soft(
        existsSync(importedNativePagePath) ? readFileSync(importedNativePagePath, 'utf8') : null
      )
      .toContain(`openkit_entry_id: "${importedKnowledge.id}"`);
    const importedAcceptedPagePath = join(
      importedRoot,
      'knowledge',
      'pages',
      `${importedAcceptedKnowledge.id}.md`
    );
    const expectedImportedAcceptedPageBytes = acceptedPageBytes
      .replaceAll(acceptedPageId, importedAcceptedKnowledge.id)
      .replaceAll(knowledge.id, importedKnowledge.id);
    expect
      .soft(
        existsSync(importedAcceptedPagePath) ? readFileSync(importedAcceptedPagePath, 'utf8') : null
      )
      .toBe(expectedImportedAcceptedPageBytes);
    expect(store.listKnowledgeProposals(importedWorkspaceId)).toEqual([]);
    expect(store.listKnowledgeProposalReviewDecisions(importedWorkspaceId)).toEqual([]);

    store.updateWorkspace(importedWorkspaceId, { name: 'Persist unrelated imported change' });
    expect(readFileSync(importedAcceptedPagePath, 'utf8')).toBe(expectedImportedAcceptedPageBytes);
    const restartedStore = new FsStore({ dataRoot });
    expect(
      restartedStore
        .listKnowledge(importedWorkspaceId)
        .some((entry) => entry.id === importedAcceptedKnowledge.id)
    ).toBe(true);
    expect(readFileSync(importedAcceptedPagePath, 'utf8')).toBe(expectedImportedAcceptedPageBytes);

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
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-trace-export-access-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId,
    });
    const thread = store.listThreads(workspaceId)[0]!;
    const traceId = 'krt_00000000-0000-7d0b-95d7-2834cc1f705c';
    const reference = {
      scopeId: `retrieval-trace/thread/${workspaceId}/${thread.id}`,
      objectId: traceId,
    } as const;
    publishRetrievalTrace(join(dataRoot, 'workspaces', workspaceId), reference, {
      traceId,
      queryContext: {
        serverId: readDataRootLayoutMarker(dataRoot).deploymentId,
        workspaceId,
        actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        threadId: thread.id,
      },
      sourceScope: `page/workspace/${workspaceId}`,
      notebookRevision: null,
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
    const app = createApp({ coreDb, dataRoot, store });
    const response = await app.request(
      ...operationRequest('workspace.export', { workspaceId }, { method: 'POST' })
    );
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(body)).toMatchObject({ code: 'knowledge_source_unavailable' });
    expect(body).not.toContain('restricted-same-path');
    const workspaceExports = join(dataRoot, 'server', 'exports', 'workspaces', workspaceId);
    expect(existsSync(workspaceExports) ? readdirSync(workspaceExports) : []).toEqual([]);
    coreDb.sqlite.close();
  });

  it('fails export without disclosure when a selected page becomes restricted', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-trace-export-revoked-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId,
    });
    const thread = store.listThreads(workspaceId)[0]!;
    const page = store.createKnowledgeEntry(workspaceId, {
      kind: 'project-context',
      title: 'Revoked export selection',
      content: 'This content must not leave after revocation.',
      sourceReferences: [],
    });
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
        actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        requestActor: { kind: 'local', userId: 'usr_00000000-0000-7000-8000-000000000001' },
        outputThreadId: thread.id,
      },
      traceId: 'krt_00000000-0000-7da4-9723-d3b248482ae2',
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
    const pagePath = join(
      dataRoot,
      'workspaces',
      workspaceId,
      'knowledge',
      'pages',
      `${page.id}.md`
    );
    writeFileSync(
      pagePath,
      readFileSync(pagePath, 'utf8').replace('sensitivity: "normal"', 'sensitivity: "restricted"')
    );
    const app = createApp({ coreDb, dataRoot, store });
    const response = await app.request(
      ...operationRequest('workspace.export', { workspaceId }, { method: 'POST' })
    );
    const body = await response.text();

    expect(response.status).toBe(403);
    expect(JSON.parse(body)).toMatchObject({ code: 'workspace_access_denied' });
    expect(body).not.toContain(page.id);
    expect(body).not.toContain('This content must not leave after revocation.');
    expect(readFileSync(tracePath, 'utf8')).toBe(originalTrace);
    const workspaceExports = join(dataRoot, 'server', 'exports', 'workspaces', workspaceId);
    expect(existsSync(workspaceExports) ? readdirSync(workspaceExports) : []).toEqual([]);
    coreDb.sqlite.close();
  });
});

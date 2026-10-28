import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KnowledgeRetrievalResponseSchema,
  WorkspaceExportResponseSchema,
  WorkspaceImportResponseSchema,
} from '@openkit/app-api-schemas';
import { formatReferenceUri } from '@openkit/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createApp } from '../app.js';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { KnowledgeNotebook } from '../knowledge/notebook.js';
import { assertPortableWorkspaceNotebookDisclosure } from '../knowledge/notebook-workspace-portability.js';
import {
  DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
  parseOkfDocument,
  stringFrontmatterField,
  updateOkfFrontmatter,
} from '../knowledge/okf.js';
import { FsStore } from '../lib/store.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { knowledgeOperationRequest } from '../test-support/knowledge-operation.js';
import {
  knowledgePageFixture,
  serializeKnowledgePageFixture,
} from '../test-support/knowledge-page.js';
import {
  ensureLocalUser,
  FIXTURE_LOCAL_USER_ID as LOCAL_USER_ID,
} from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb } from './db.js';
import { readDataRootLayoutMarker } from './fs-layout.js';
import { retrieveWorkspaceKnowledge } from './index-rebuild.js';
import { applyMigrations } from './migrate.js';
import { publishRetrievalTrace, retrievalTraceRelativePath } from './retrieval-traces.js';
import { verifyWorkspaceExportTree } from './workspace-export.js';
import { parseOwnedKnowledgePage, readWorkspaceKnowledgePage } from './workspace-file-records.js';
import { readWorkspaceImportSnapshot } from './workspace-import.js';
import {
  readWorkspacePortableFileState,
  writeWorkspacePortableFileState,
} from './workspace-portable-file-state.js';

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

/** Creates an isolated canonical Workspace for portable file and administrator export checks. */
async function workspaceFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-portable-files-'));
  const coreDb = openCoreDb(dataRoot);
  onTestFinished(async () => {
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Demo Workspace', {
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
  it('completes staged configuration only for the initialized Knowledge Base binding', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-import-staged-config-'));
    onTestFinished(async () => {
      await shutdownControlStoreWorkerClient();
      return rmSync(root, { recursive: true, force: true });
    });
    const knowledgeBaseId = testEntityId('kb', 'portable-config-target');
    const configPath = join(root, 'config', 'workspace.jsonc');
    mkdirSync(join(root, 'config'));
    writeFileSync(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        workspace: { name: 'Staging', defaultKnowledgeBaseId: knowledgeBaseId },
      })
    );
    const importedConfig = `${JSON.stringify(
      {
        schemaVersion: 1,
        workspace: {
          name: 'Imported workspace',
          defaultKnowledgeBaseId: knowledgeBaseId,
          defaultAgentId: null,
        },
      },
      null,
      2
    )}\n`;
    const state = {
      retrievalTraceFiles: new Map(),
      workspaceConfig: importedConfig,
      workspaceSchema: null,
      nativeKnowledgePages: new Map(),
      workerContextPackageFiles: new Map(),
    };
    writeWorkspacePortableFileState(root, state);
    expect(readFileSync(configPath, 'utf8')).toBe(importedConfig);

    const otherBinding = importedConfig.replace(
      knowledgeBaseId,
      testEntityId('kb', 'portable-config-other-target')
    );
    expect(() =>
      writeWorkspacePortableFileState(root, { ...state, workspaceConfig: otherBinding })
    ).toThrow('Portable configuration contradicts the initialized Knowledge Base binding.');
    expect(readFileSync(configPath, 'utf8')).toBe(importedConfig);
  });

  it('rejects a publisher-temp-shaped directory in a retrieval trace directory', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-retrieval-trace-temp-entry-'));
    try {
      initializeNotebook(workspaceRoot);
      const threadId = testEntityId('th', 'portable-trace-owner');
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
      await shutdownControlStoreWorkerClient();
      rmSync(workspaceRoot, { force: true, recursive: true });
    }
  });

  it('ignores a regular publisher temporary file in a retrieval trace directory', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-retrieval-trace-temp-file-'));
    try {
      initializeNotebook(workspaceRoot);
      const threadId = testEntityId('th', 'portable-trace-owner');
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
      await shutdownControlStoreWorkerClient();
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
    } = await workspaceFixture();
    const sourceKnowledgeBaseId = readDefaultKnowledgeBaseId({
      dataRoot,
      scope: { kind: 'workspace', workspaceId: sourceWorkspaceId },
    });
    const sourcePageScopeId = `page/workspace/${sourceWorkspaceId}/${sourceKnowledgeBaseId}`;
    const firstTimestamp = '2026-07-06T00:00:00.000Z';
    const secondTimestamp = '2026-07-06T00:00:01.000Z';
    const pageFixture = knowledgePageFixture(
      {
        id: 'portable-contract',
        title: 'Portable contract',
        content: 'Portable contract evidence survives workspace transfer.',
        sourceReferences: [],
        createdAt: firstTimestamp,
        updatedAt: firstTimestamp,
      },
      { kind: 'workspace', workspaceId: sourceWorkspaceId }
    );
    const knowledge = parseOwnedKnowledgePage(
      pageFixture.path,
      pageFixture.id,
      updateOkfFrontmatter({
        path: pageFixture.path,
        content: pageFixture.content,
        updates: { openkit_entry_id: pageFixture.id },
      })
    );
    const firstClaimId = 'claims/first';
    const secondClaimId = 'claims/source-backed';
    const fact = (
      id: string,
      type: 'Claim' | 'Observation',
      title: string,
      fields: Record<string, unknown>
    ) =>
      updateOkfFrontmatter({
        path: `${id}.md`,
        content: serializeKnowledgePageFixture(
          {
            title,
            content: `${title}.`,
            createdAt: firstTimestamp,
            updatedAt: firstTimestamp,
          },
          { kind: 'workspace', workspaceId: sourceWorkspaceId }
        ),
        updates: {
          type,
          source_refs: [formatReferenceUri({ scopeId: sourcePageScopeId, objectId: knowledge.id })],
          ...fields,
        },
      });
    const firstClaim = fact(firstClaimId, 'Claim', 'First portable claim', { confidence: 0.8 });
    const secondClaim = fact(secondClaimId, 'Claim', 'Source-backed portable claim', {
      confidence: 1,
    });
    const sourceSubjectPin = formatReferenceUri(
      { scopeId: sourcePageScopeId, objectId: secondClaimId },
      `sha256:${createHash('sha256').update(secondClaim).digest('hex')}`
    );
    const initialClaimPages = {
      [`${firstClaimId}.md`]: firstClaim,
      [`${secondClaimId}.md`]: secondClaim,
      'assessments/first.md': fact(
        'assessments/first',
        'Observation',
        'First portable observation',
        {
          openkit_status: 'draft',
          status: 'draft',
          subject_refs: [
            formatReferenceUri({ scopeId: sourcePageScopeId, objectId: firstClaimId }),
          ],
          conflict_status: 'unresolved',
        }
      ),
      'assessments/resolved.md': fact(
        'assessments/resolved',
        'Observation',
        'Portable conflict resolved',
        {
          openkit_status: 'draft',
          status: 'draft',
          subject_refs: [sourceSubjectPin],
          conflict_status: 'resolved',
        }
      ),
    };
    const workspaceConfig = [
      '{',
      '  // This workspace-local policy comment must survive transfer.',
      '  "schemaVersion": 1,',
      '  "workspace": {',
      '    "name": "Demo Workspace",',
      `    "defaultKnowledgeBaseId": "${sourceKnowledgeBaseId}",`,
      `    "knowledgeMounts": [{"name":"raw",/* Keep this authored mount note. */"knowledgeBaseId":"${sourceKnowledgeBaseId}","default":true,"backend":"local","root":"raw","description":"Original project evidence"}],`,
      '    "roots": [],',
      '    "assistant": { "repositoryInspection": { "enabled": false } }',
      '  }',
      '}',
      '',
    ].join('\n');
    const workspaceSchema = [
      'schema_version: "openkit-scope-knowledge-schema-v4"',
      'status: "active"',
      'allowed_types: ["KnowledgePage", "RepoConvention", "SourceSummary", "Claim", "Observation"]',
      'allowed_statuses: ["active", "draft"]',
      'allowed_review_states: ["accepted", "user-authored"]',
      'allowed_sensitivities: ["normal", "internal", "confidential"]',
      'allowed_freshness: ["current"]',
      '',
    ].join('\n');
    const portablePage = updateOkfFrontmatter({
      path: 'portable-file.md',
      content: serializeKnowledgePageFixture(
        {
          title: 'Portable file convention',
          content: 'Portable file convention body.',
          sourceReferences: [
            formatReferenceUri({ scopeId: sourcePageScopeId, objectId: knowledge.id }),
          ],
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
    publishFixturePages(
      notebook,
      {
        [knowledge.path]: knowledge.content,
        ...initialClaimPages,
        'portable-file.md': portablePage,
      },
      [formatReferenceUri({ scopeId: sourcePageScopeId, objectId: knowledge.id })]
    );

    const knowledgePageBytes = readWorkspaceKnowledgePage(sourceRoot, knowledge.id)!;
    const knowledgeReference = formatReferenceUri(
      { scopeId: sourcePageScopeId, objectId: knowledge.id },
      `sha256:${createHash('sha256').update(knowledgePageBytes).digest('hex')}`
    );
    const acceptedPageId = 'portable-accepted-proposal';
    const acceptedPageBytes = updateOkfFrontmatter({
      path: `${acceptedPageId}.md`,
      content: serializeKnowledgePageFixture(
        {
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
          scopeId: sourcePageScopeId,
          objectId: 'portable-file',
        },
        sourceReferences: [
          formatReferenceUri({ scopeId: sourcePageScopeId, objectId: knowledge.id }),
        ],
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
    expect(verified.fileContents.get('workspace-files/config/workspace.jsonc')).toBe(
      workspaceConfig
    );
    expect(() =>
      readWorkspaceImportSnapshot({
        verified,
        targetWorkspaceId: testEntityId('ws', 'portable-import-validation'),
        targetServerId: readDataRootLayoutMarker(dataRoot).deploymentId,
      })
    ).not.toThrow();
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
            targetWorkspaceId: testEntityId('ws', `ws_${name}_page_import`),
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
    const importedKnowledgeBaseId = readDefaultKnowledgeBaseId({
      dataRoot,
      scope: { kind: 'workspace', workspaceId: importedWorkspaceId },
    });
    expect(importedKnowledgeBaseId).not.toBe(sourceKnowledgeBaseId);
    const importedPageScopeId = `page/workspace/${importedWorkspaceId}/${importedKnowledgeBaseId}`;
    const importedKnowledge = store.listKnowledge(importedWorkspaceId).find((page) => {
      const parsed = parseOkfDocument({ path: page.path, content: page.content });
      return (
        parsed.document && stringFrontmatterField(parsed.document, 'title') === 'Portable contract'
      );
    });
    const importedAcceptedKnowledge = store.listKnowledge(importedWorkspaceId).find((page) => {
      const parsed = parseOkfDocument({ path: page.path, content: page.content });
      return (
        parsed.document &&
        stringFrontmatterField(parsed.document, 'title') === 'Portable accepted proposal'
      );
    });
    expect(importedKnowledge).toBeDefined();
    expect(importedAcceptedKnowledge).toBeDefined();
    if (!importedKnowledge || !importedAcceptedKnowledge) {
      coreDb.sqlite.close();
      return;
    }

    const importedFact = (id: string) => {
      const parsed = parseOkfDocument({
        path: `${id}.md`,
        content: readWorkspaceKnowledgePage(importedRoot, id)!,
      });
      if (!parsed.ok) throw new Error('Imported canonical fact must remain valid OKF.');
      return parsed.document.frontmatter;
    };
    expect(importedFact(firstClaimId)).toMatchObject({
      type: 'Claim',
      confidence: 0.8,
      scope: { kind: 'workspace', workspaceId: importedWorkspaceId },
    });
    expect(importedFact(secondClaimId)).toMatchObject({ type: 'Claim', confidence: 1 });
    expect(importedFact('assessments/first')).toMatchObject({
      type: 'Observation',
      conflict_status: 'unresolved',
      subject_refs: [formatReferenceUri({ scopeId: importedPageScopeId, objectId: firstClaimId })],
    });
    expect(importedFact(secondClaimId).source_refs).toEqual([
      formatReferenceUri({ scopeId: importedPageScopeId, objectId: importedKnowledge.id }),
    ]);
    const importedSubjectBytes = readWorkspaceKnowledgePage(importedRoot, secondClaimId)!;
    expect(importedFact('assessments/resolved')).toMatchObject({
      type: 'Observation',
      conflict_status: 'resolved',
      subject_refs: [
        formatReferenceUri(
          { scopeId: importedPageScopeId, objectId: secondClaimId },
          `sha256:${createHash('sha256').update(importedSubjectBytes).digest('hex')}`
        ),
      ],
    });
    for (const kind of ['observations', 'claims', 'conflicts']) {
      expect(existsSync(join(importedRoot, 'knowledge', kind))).toBe(false);
      expect(verified.fileContents.has(`records/knowledge-${kind}.jsonl`)).toBe(false);
    }

    expect(existsSync(join(importedRoot, 'knowledge', 'traces'))).toBe(false);

    const importedConfigPath = join(importedRoot, 'config', 'workspace.jsonc');
    expect
      .soft(existsSync(importedConfigPath) ? readFileSync(importedConfigPath, 'utf8') : null)
      .toBe(workspaceConfig.replaceAll(sourceKnowledgeBaseId, importedKnowledgeBaseId));
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
          source_refs: [
            formatReferenceUri({ scopeId: importedPageScopeId, objectId: importedKnowledge.id }),
          ],
        },
      })
    );
    const importedNativePage = readWorkspaceKnowledgePage(importedRoot, importedKnowledge.id)!;
    const importedKnowledgeReference = formatReferenceUri(
      { scopeId: importedPageScopeId, objectId: importedKnowledge.id },
      `sha256:${createHash('sha256').update(importedNativePage).digest('hex')}`
    );
    expect(
      parseOkfDocument({ path: importedKnowledge.path, content: importedNativePage })
    ).toMatchObject({
      ok: true,
      document: { frontmatter: { openkit_entry_id: importedKnowledge.id } },
    });
    const expectedImportedAcceptedPageBytes = updateOkfFrontmatter({
      path: `${importedAcceptedKnowledge.id}.md`,
      content: acceptedPageBytes,
      updates: {
        scope: { kind: 'workspace', workspaceId: importedWorkspaceId },
        source_refs: [importedKnowledgeReference],
      },
    });
    expect(readWorkspaceKnowledgePage(importedRoot, importedAcceptedKnowledge.id)).toBe(
      expectedImportedAcceptedPageBytes
    );
    expect(store.listKnowledgeProposals(importedWorkspaceId)).toEqual([]);
    expect(store.listKnowledgeProposalReviewDecisions(importedWorkspaceId)).toEqual([]);

    await store.updateWorkspace(importedWorkspaceId, { name: 'Persist unrelated imported change' });
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

    const reopenedApp = createApp({ dataRoot, coreDb, store: restartedStore });
    const disputed = await reopenedApp.request(
      ...knowledgeOperationRequest(
        'knowledge.retrieval',
        { workspaceId: importedWorkspaceId },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            query: 'zzqvxc01portable',
            pinnedReferences: [{ scopeId: importedPageScopeId, objectId: firstClaimId }],
          }),
        }
      )
    );
    expect(disputed.status, await disputed.clone().text()).toBe(200);
    expect(await disputed.json()).toMatchObject({
      selected: [],
      excluded: expect.arrayContaining([
        expect.objectContaining({
          reference: { scopeId: importedPageScopeId, objectId: firstClaimId },
          reason: 'lower_conformance',
        }),
      ]),
    });

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
          scopeId: importedPageScopeId,
          objectId: importedAcceptedKnowledge.id,
        },
        sourceReferences: [importedKnowledgeReference],
      }),
    ]);

    coreDb.sqlite.close();
  });

  it('preserves unavailable historical source references in administrator export', async () => {
    const { dataRoot, coreDb, store, workspaceId, workspaceRoot, notebook } =
      await workspaceFixture();
    const thread = await store.createThread(workspaceId, 'Trace owner', undefined, 'conversation', {
      visibility: 'workspace',
    });
    const traceId = testEntityId('krt', 'portable-trace-export');
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
      sourceScope: workspacePageScope(dataRoot, workspaceId),
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
            scopeId: workspacePageScope(dataRoot, workspaceId),
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
    const tracePath = join(workspaceRoot, retrievalTraceRelativePath(reference));
    const originalTrace = readFileSync(tracePath, 'utf8');
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

    // Workspace Backup, Export And Import, Personal Data And Audience Coverage requires full closure.
    expect(response.status, body).toBe(200);
    const exported = WorkspaceExportResponseSchema.parse(JSON.parse(body));
    const verified = verifyWorkspaceExportTree({
      exportRoot: join(dataRoot, 'server', 'exports', 'workspaces', workspaceId, exported.exportId),
    });
    expect(
      JSON.parse(
        verified.fileContents.get(`workspace-files/${retrievalTraceRelativePath(reference)}`)!
      )
    ).toEqual(JSON.parse(originalTrace));
    // Retrieval Kernel, Knowledge Adapter: the stored query trace stays immutable.
    expect(readFileSync(tracePath, 'utf8')).toBe(originalTrace);
    coreDb.sqlite.close();
  });

  it('exports the current restricted page and immutable historical selection for an administrator', async () => {
    const { dataRoot, coreDb, store, workspaceId, workspaceRoot, notebook } =
      await workspaceFixture();
    const thread = await store.createThread(workspaceId, 'Trace owner', undefined, 'conversation', {
      visibility: 'workspace',
    });
    const page = knowledgePageFixture(
      {
        id: 'revoked-export-selection',
        title: 'Revoked export selection',
        content: 'This content must not leave after revocation.',
        sourceReferences: [],
        createdAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-06T00:00:00.000Z',
      },
      { kind: 'workspace', workspaceId }
    );
    const pageBytes = page.content;
    publishFixturePages(notebook, { [page.path]: pageBytes });
    const result = await retrieveWorkspaceKnowledge({
      dataRoot,
      workspaceId,
      caller: 'app-api',
      query: 'Revoked export selection',
      limit: 1,
      pinnedReferences: [{ scopeId: workspacePageScope(dataRoot, workspaceId), objectId: page.id }],
      access: {
        store,
        coreDb,
        actor: { kind: 'user', id: LOCAL_USER_ID },
        requestActor: { kind: 'local', userId: LOCAL_USER_ID },
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
    const selectedRevision = notebook.publishedRevision();
    expect(result.selected).toEqual([
      expect.objectContaining({
        reference: { scopeId: workspacePageScope(dataRoot, workspaceId), objectId: page.id },
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

    // Administrator export preserves current page bytes and every historical trace field.
    expect(response.status, body).toBe(200);
    const exported = WorkspaceExportResponseSchema.parse(JSON.parse(body));
    const verified = verifyWorkspaceExportTree({
      exportRoot: join(dataRoot, 'server', 'exports', 'workspaces', workspaceId, exported.exportId),
    });
    expect(verified.manifest.knowledgeNotebookRevision).toBe(restrictedRevision);
    expect(verified.fileContents.get(`workspace-files/knowledge/pages/${page.id}.md`)).toBe(
      restrictedBytes
    );
    expect(
      JSON.parse(
        verified.fileContents.get(
          `workspace-files/${retrievalTraceRelativePath(result.retrievalTraceRef!)}`
        )!
      )
    ).toEqual(JSON.parse(originalTrace));
    // Retrieval Kernel, Knowledge Adapter: the stored query trace stays immutable.
    expect(readFileSync(tracePath, 'utf8')).toBe(originalTrace);
    coreDb.sqlite.close();
  });
});

/** Reads the retained base of a real Workspace fixture without creating missing authority. */
function workspacePageScope(dataRoot: string, workspaceId: string): string {
  return `page/workspace/${workspaceId}/${readDefaultKnowledgeBaseId({ dataRoot, scope: { kind: 'workspace', workspaceId } })}`;
}

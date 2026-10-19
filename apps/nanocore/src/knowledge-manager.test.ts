import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  CapabilityUsageResponseSchema,
  KnowledgeDerivedIndexesResponseSchema,
  KnowledgeManagerAnswerResponseSchema,
  KnowledgeManagerDraftProposalResponseSchema,
  KnowledgeManagerHealthCheckResponseSchema,
  KnowledgeManagerPrepareContextResponseSchema,
  KnowledgeManagerSuggestRepairResponseSchema,
  KnowledgeRetrievalResponseSchema,
  ListKnowledgeSourcesResponseSchema,
  ReadKnowledgeSourceResponseSchema,
  RegisterKnowledgeSourceResponseSchema,
} from '@openkit/app-api-schemas';
import { formatReferenceUri } from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';
import { readDefaultKnowledgeBaseId } from './config/knowledge-base.js';
import { createInMemoryRuntimeConfigSnapshot } from './config/runtime-config.js';
import { KnowledgeNotebook } from './knowledge/notebook.js';
import { readWorkspaceNotebookAdmission } from './knowledge/notebook-workspace-admission.js';
import { parseOkfDocument, updateOkfFrontmatter } from './knowledge/okf.js';
import { parseSourcePointer } from './knowledge/source-pointers.js';
import { publishCapturedSource } from './knowledge/source-publication.js';
import { readManagedSourceText } from './knowledge/source-reading.js';
import { FsStore } from './lib/store.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { rebuildWorkspaceDerivedIndexes } from './storage/index-rebuild.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createApp, createAppWithWorkspaceAuthority } from './test-support/app.js';
import {
  createDemoStore,
  createDemoWorkspaceForUser,
  DEMO_WORKSPACE_ID,
} from './test-support/demo-store.js';
import { createKnowledgeAnswerApp } from './test-support/knowledge-agent.js';
import { knowledgeOperationRequest } from './test-support/knowledge-operation.js';
import {
  knowledgePageFixture,
  serializeKnowledgePageFixture,
} from './test-support/knowledge-page.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { notebookImportFixture } from './test-support/notebook-import.js';
import { operationRequest } from './test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

const requestId = '00000000-0000-4000-8000-000000000111';
const SYNTACTIC_PROPOSAL_SOURCE_REFERENCE =
  'source:ks_00000000-0000-7e28-9211-1f67fd14ca84@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** Reads exact Git content and revisions independently of the public read projection. */
function notebook(dataRoot: string, workspaceId = DEMO_WORKSPACE_ID): KnowledgeNotebook {
  return new KnowledgeNotebook({
    repositoryPath: join(dataRoot, 'workspaces', workspaceId, 'knowledge', 'notebook.git'),
  });
}

/** Imports a healthy notebook, captures actual Sources, then publishes test-owned page or validation-fault bytes. */
async function importedStore(
  dataRoot: string,
  entries: Parameters<typeof notebookImportFixture>[0]['knowledge'],
  sources: readonly { source: Parameters<typeof publishCapturedSource>[1]; content: string }[],
  coreDb: ReturnType<typeof openCoreDb>
): Promise<FsStore> {
  const demo = createDemoWorkspaceForUser('usr_00000000-0000-7000-8000-000000000001');
  const store = new FsStore({ dataRoot });
  store.importWorkspaceSnapshot({
    workspace: demo.workspace,
    threads: [demo.thread],
    turns: [],
    knowledge: demo.knowledge,
    itemRevisions: [],
    artifacts: [],
    agentSessions: [],
    turnEvents: [],
    ...notebookImportFixture({ workspaceId: demo.workspace.id, knowledge: demo.knowledge }),
  });
  const workspaceDb = openWorkspaceDb(dataRoot, demo.workspace.id);
  applyScopedMigrations(workspaceDb);
  const owner = notebook(dataRoot);
  const actor = { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' };
  const requestActor = { kind: 'local' as const, userId: actor.id };
  const snapshot = createInMemoryRuntimeConfigSnapshot({ dataRoot });
  const workspaceMutationAdmission = new WorkspaceMutationAdmission();
  try {
    for (const { source, content } of sources) {
      const sourceRequestId = randomUUID();
      await publishCapturedSource(
        {
          owner: { dataRoot, ownerScope: { kind: 'workspace', workspaceId: demo.workspace.id } },
          database: { kind: 'workspace', workspaceDb },
          access: { store, coreDb, actor, requestActor },
          producer: actor,
          requestId: sourceRequestId,
          commandInput: source,
          captureChannel: 'knowledge.source.register',
          revalidatePublication: () => {
            readWorkspaceNotebookAdmission({
              store,
              coreDb,
              workspaceDb,
              notebook: owner,
              actor,
              requestActor,
              runtimeConfigManager: { current: () => snapshot },
              workspaceMutationAdmission,
              request: {
                workspaceId: demo.workspace.id,
                requestId: sourceRequestId,
                baseRevision: owner.publishedRevision(),
                changes: [],
                summary: 'Capture the actual fixture Source.',
              },
            });
          },
        },
        source,
        Buffer.from(content)
      );
    }
  } finally {
    workspaceDb.sqlite.close();
  }
  const files = notebookImportFixture({ workspaceId: demo.workspace.id, knowledge: entries })
    .initialNotebookFiles!;
  const baseRevision = owner.publishedRevision();
  const candidateRevision = owner.prepare({
    baseRevision,
    changes: files,
    metadata: {
      summary: 'Publish test-owned index fixture bytes',
      producer: actor,
      authority: { kind: 'direct', instructionReference: 'test:index-fixture' },
      changeRequest: {
        requestId: randomUUID(),
        inputDigest: `sha256:${createHash('sha256').update(JSON.stringify(files)).digest('hex')}`,
      },
      sourceReferences: [],
    },
  });
  owner.publish({ baseRevision, candidateRevision });
  return store;
}

/**
 * Grants the local test actor access to the demo Workspace.
 *
 * @param coreDb Migrated Core database used by one route fixture.
 */
function authorizeDemoWorkspace(coreDb: ReturnType<typeof openCoreDb>): void {
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  });
}

/**
 * Builds exact create-only Knowledge Page bytes for Proposal route tests.
 *
 * @param knowledgePageId Proposed Knowledge Page id.
 * @param title Proposed page title.
 * @param sourceReference Exact source owner reference.
 * @param content Proposed page body.
 * @returns Canonical OKF page bytes.
 */
function proposalPageBytes(
  knowledgePageId: string,
  title: string,
  sourceReference: string,
  content: string
): string {
  return [
    '---',
    'type: "KnowledgePage"',
    `title: ${JSON.stringify(title)}`,
    'schema_version: "openkit-scope-knowledge-schema-v4"',
    'openkit_status: "active"',
    'status: "stable"',
    `scope: {kind: workspace, workspaceId: ${DEMO_WORKSPACE_ID}}`,
    'requiredFeatures: [openkit.knowledge-owner-scope.v1, openkit.knowledge-git-notebook.v1]',
    `openkit_entry_id: ${JSON.stringify(knowledgePageId)}`,
    `source_refs: ${JSON.stringify([sourceReference])}`,
    'review_state: "accepted"',
    'sensitivity: "normal"',
    'freshness: "current"',
    'created_at: "2026-07-19T00:00:00.000Z"',
    'updated_at: "2026-07-19T00:00:00.000Z"',
    '---',
    content,
    '',
  ].join('\n');
}

/** Authors complete human page bytes for public Notebook create and update requests. */
function authoredPage(
  title: string,
  content: string,
  sourceReferences: readonly string[] = []
): string {
  return serializeKnowledgePageFixture(
    {
      title,
      content,
      sourceReferences,
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:00.000Z',
    },
    { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID }
  );
}

describe('Knowledge proposal decision lineage', () => {
  it('denies a proposal whose durable owner is not the authorized path Workspace', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-proposal-lineage-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    authorizeDemoWorkspace(coreDb);
    const store = createDemoStore({ dataRoot });
    const foreignWorkspace = store.createWorkspace('Foreign Knowledge Workspace');
    recordWorkspaceOwnerMembership({
      coreDb,
      workspaceId: foreignWorkspace.id,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    });
    const sourceInput = {
      id: 'ks_00000000-0000-7e28-9211-1f67fd14ca84',
      workspaceId: foreignWorkspace.id,
      kind: 'document',
      title: 'Foreign evidence',
      uri: null,
      contentDigest: `sha256:${createHash('sha256').update('Foreign evidence.').digest('hex')}`,
      originatingThreadId: null,
      originatingTurnId: null,
      originatingFileId: null,
      capturedAt: '2026-07-19T00:00:00.000Z',
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:00.000Z',
    };
    const workspaceDb = openWorkspaceDb(dataRoot, foreignWorkspace.id);
    applyScopedMigrations(workspaceDb);
    const owner = notebook(dataRoot, foreignWorkspace.id);
    const actor = { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' };
    const requestActor = { kind: 'local' as const, userId: actor.id };
    const snapshot = createInMemoryRuntimeConfigSnapshot({ dataRoot });
    const workspaceMutationAdmission = new WorkspaceMutationAdmission();
    let registered: Awaited<ReturnType<typeof publishCapturedSource>>['source'];
    try {
      registered = (
        await publishCapturedSource(
          {
            owner: {
              dataRoot,
              ownerScope: { kind: 'workspace', workspaceId: foreignWorkspace.id },
            },
            database: { kind: 'workspace', workspaceDb },
            access: { store, coreDb, actor, requestActor },
            producer: actor,
            requestId: randomUUID(),
            commandInput: sourceInput,
            captureChannel: 'knowledge.source.register',
            revalidatePublication: () => {
              readWorkspaceNotebookAdmission({
                store,
                coreDb,
                workspaceDb,
                notebook: owner,
                actor,
                requestActor,
                runtimeConfigManager: { current: () => snapshot },
                workspaceMutationAdmission,
                request: {
                  workspaceId: foreignWorkspace.id,
                  requestId: randomUUID(),
                  baseRevision: owner.publishedRevision(),
                  changes: [],
                  summary: 'Capture the foreign fixture Source under its own authority.',
                },
              });
            },
          },
          { ...sourceInput, kind: 'document' },
          Buffer.from('Foreign evidence.')
        )
      ).source;
    } finally {
      workspaceDb.sqlite.close();
    }
    const sourceReference = `source:${registered.id}@${registered.contentDigest}`;
    const canonicalPageBytes = proposalPageBytes(
      'foreign-proposal',
      'Foreign proposal',
      sourceReference,
      'Foreign Workspace knowledge.'
    ).replace(DEMO_WORKSPACE_ID, foreignWorkspace.id);
    const proposal = store.createKnowledgeProposal({
      createdAt: '2026-07-19T00:00:00.000Z',
      requestId: '00000000-0000-4000-8000-000000000115',
      workspaceId: foreignWorkspace.id,
      baseRevision: notebook(dataRoot, foreignWorkspace.id).publishedRevision(),
      knowledgePageId: 'foreign-proposal',
      canonicalPageBytes,
      contentDigest: `sha256:${createHash('sha256').update(canonicalPageBytes).digest('hex')}`,
      sourceReferences: [sourceReference],
      rationale: 'Preserve foreign Workspace isolation.',
      confidence: 1,
      verifiedExternalReferences: [],
      producer: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    });
    const app = createApp({ coreDb, dataRoot, store });

    try {
      const response = await app.request(
        ...knowledgeOperationRequest(
          'knowledge.proposal.decide',
          { workspaceId: 'ws_00000000-0000-7000-8000-000000000001', proposalId: proposal.id },
          {
            body: JSON.stringify({
              decision: 'rejected',
              baseRevision: proposal.baseRevision,
              candidateRevision: proposal.candidateRevision,
              proposalDigest: `sha256:${createHash('sha256')
                .update(
                  readFileSync(
                    join(
                      dataRoot,
                      'workspaces',
                      foreignWorkspace.id,
                      'knowledge',
                      'proposals',
                      `${proposal.id}.md`
                    )
                  )
                )
                .digest('hex')}`,
              requestId: '00000000-0000-4000-8000-000000000116',
            }),
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          }
        )
      );

      expect(response.status, await response.clone().text()).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
    } finally {
      coreDb.sqlite.close();
    }
  });
});

describe('Knowledge Store save-time validation', () => {
  it('rejects a Knowledge Page create with an unresolved source reference', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-create-validation-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    authorizeDemoWorkspace(coreDb);
    const store = createDemoStore({ dataRoot });
    const app = createApp({ coreDb, dataRoot, store });

    try {
      const response = await app.request(
        ...knowledgeOperationRequest(
          'knowledge.notebook.create',
          { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              requestId: '00000000-0000-4000-8000-000000000112',
              baseRevision: notebook(dataRoot).publishedRevision(),
              path: 'unresolved-source.md',
              content: authoredPage('Unresolved source page', 'This page must not become active.', [
                'source:ks_00000000-0000-7e28-9211-1f67fd14ca84',
              ]),
              summary: 'Create authored page',
            }),
          }
        )
      );

      expect(response.status, await response.clone().text()).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code: 'invalid_request' });
      expect(
        store
          .listKnowledge('ws_00000000-0000-7000-8000-000000000001')
          .some(
            (entry) =>
              parseOkfDocument({ path: entry.path, content: entry.content }).document?.frontmatter
                .title === 'Unresolved source page'
          )
      ).toBe(false);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects an invalid update without replacing the active Knowledge Page bytes', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-update-validation-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    authorizeDemoWorkspace(coreDb);
    const store = createDemoStore({ dataRoot });
    const app = createApp({ coreDb, dataRoot, store });

    try {
      const createResponse = await app.request(
        ...knowledgeOperationRequest(
          'knowledge.notebook.create',
          { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              requestId: '00000000-0000-4000-8000-000000000113',
              baseRevision: notebook(dataRoot).publishedRevision(),
              path: 'valid-active-page.md',
              content: authoredPage(
                'Valid active page',
                'These bytes must survive a rejected update.'
              ),
              summary: 'Create authored page',
            }),
          }
        )
      );
      expect(createResponse.status, await createResponse.clone().text()).toBe(200);
      const publication = (await createResponse.json()) as { notebookRevision: string };
      expect(publication.notebookRevision).toBe(notebook(dataRoot).publishedRevision());
      const pageId = 'valid-active-page';
      const owner = notebook(dataRoot);
      const baseRevision = owner.publishedRevision();
      const activePageBytes = owner.readRevision(baseRevision).files[`${pageId}.md`];

      const updateResponse = await app.request(
        ...knowledgeOperationRequest(
          'knowledge.notebook.update',
          {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          },
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              requestId: '00000000-0000-4000-8000-000000000114',
              baseRevision: notebook(dataRoot).publishedRevision(),
              changes: [
                {
                  path: `${pageId}.md`,
                  content: updateOkfFrontmatter({
                    path: `${pageId}.md`,
                    content: activePageBytes!,
                    updates: { title: 'API token rotation' },
                  }),
                },
              ],
              summary: 'Reject secret-shaped page title',
            }),
          }
        )
      );

      expect(updateResponse.status, await updateResponse.clone().text()).toBe(400);
      await expect(updateResponse.json()).resolves.toMatchObject({ code: 'invalid_request' });
      expect(owner.publishedRevision()).toBe(baseRevision);
      expect(owner.readRevision(baseRevision).files[`${pageId}.md`]).toBe(activePageBytes);
    } finally {
      coreDb.sqlite.close();
    }
  });
});

describe('Knowledge Manager answer operation', () => {
  it('registers and reads workspace knowledge sources without exposing content', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-source-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    authorizeDemoWorkspace(coreDb);
    const store = createDemoStore({ dataRoot });
    const app = createApp({ coreDb, dataRoot, store });
    const sourceContent = 'Release cadence is weekly.';
    const registerRes = await app.request(
      ...knowledgeOperationRequest(
        'knowledge.source.register',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: '00000000-0000-4000-8000-000000000101',
            kind: 'document',
            title: 'Release notes',
            uri: 'file://release.md',
            content: sourceContent,
            originatingThreadId: 'th_00000000-0000-7000-8000-000000000001',
          }),
        }
      )
    );
    expect(registerRes.status).toBe(200);

    const registered = RegisterKnowledgeSourceResponseSchema.parse(await registerRes.json());
    expect(registered.source).toMatchObject({
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      kind: 'document',
      title: 'Release notes',
      uri: 'file://release.md',
      originatingThreadId: 'th_00000000-0000-7000-8000-000000000001',
      originatingTurnId: null,
      originatingFileId: null,
    });
    expect(registered.source.id).toMatch(/^ks_/);
    expect(registered.source.contentDigest).toMatch(/^sha256:/);
    expect(registered.derivedRepresentations).toEqual([]);
    expect(JSON.stringify(registered)).not.toContain('Release cadence is weekly');
    const owner = {
      dataRoot,
      ownerScope: { kind: 'workspace' as const, workspaceId: DEMO_WORKSPACE_ID },
    };
    const book = notebook(dataRoot);
    const pointerBytes = book.readSourcePointers(book.publishedRevision())[registered.source.id]!;
    const pointer = parseSourcePointer(owner, registered.source.id, pointerBytes);
    expect({ ...pointer.source, workspaceId: DEMO_WORKSPACE_ID }).toEqual(registered.source);
    expect(pointer.fields).toMatchObject({
      byteLength: Buffer.byteLength(sourceContent),
      mediaType: 'application/octet-stream',
      captureChannel: 'knowledge.source.register',
      contentRef: {
        knowledgeBaseId: readDefaultKnowledgeBaseId({ dataRoot, scope: owner.ownerScope }),
        contentDigest: `sha256:${createHash('sha256').update(sourceContent).digest('hex')}`,
        locator: { ownerScope: owner.ownerScope, mount: 'managed' },
        range: null,
        availability: 'available',
      },
    });
    const rawRoot = resolve(dataRoot, 'workspaces', DEMO_WORKSPACE_ID, 'knowledge', 'raw');
    const rawPath = resolve(rawRoot, pointer.fields.contentRef.locator.path);
    const confined = relative(rawRoot, rawPath);
    expect(isAbsolute(confined) || confined === '..' || confined.startsWith('../')).toBe(false);
    expect(readFileSync(rawPath, 'utf8')).toBe(sourceContent);
    const original = await readManagedSourceText({
      owner,
      pointer,
      access: {
        store,
        coreDb,
        actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        requestActor: { kind: 'local', userId: 'usr_00000000-0000-7000-8000-000000000001' },
      },
    });
    expect(original).toEqual({ status: 'ok', value: sourceContent });
    expect(pointerBytes).not.toContain(sourceContent);

    const listRes = await app.request(
      ...knowledgeOperationRequest('knowledge.source.list', {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    );
    expect(listRes.status).toBe(200);
    expect(ListKnowledgeSourcesResponseSchema.parse(await listRes.json())).toMatchObject({
      items: [{ id: registered.source.id, title: 'Release notes' }],
    });

    const readRes = await app.request(
      ...knowledgeOperationRequest('knowledge.source.read', {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        sourceId: registered.source.id,
      })
    );
    expect(readRes.status).toBe(200);
    expect(ReadKnowledgeSourceResponseSchema.parse(await readRes.json())).toMatchObject({
      source: { id: registered.source.id, contentDigest: registered.source.contentDigest },
      derivedRepresentations: [],
    });

    const usageRes = await app.request(
      ...operationRequest(
        'usage.read',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        {}
      )
    );
    expect(usageRes.status, await usageRes.clone().text()).toBe(200);
    const usage = CapabilityUsageResponseSchema.parse(await usageRes.json());
    expect(
      usage.capabilityCalls.filter((call) =>
        ['knowledge.source.register', 'knowledge.source.read'].includes(call.capabilityId)
      )
    ).toEqual([
      expect.objectContaining({
        capabilityId: 'knowledge.source.register',
        operation: 'knowledge.source.register',
        serviceRef: 'knowledge-store',
        status: 'succeeded',
        owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
      }),
      expect.objectContaining({
        capabilityId: 'knowledge.source.read',
        operation: 'knowledge.source.read',
        serviceRef: 'knowledge-store',
        status: 'succeeded',
        owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
      }),
    ]);
    expect(
      usage.usageRecords.filter((record) =>
        ['knowledge-source-register', 'knowledge-source-read'].includes(record.source)
      )
    ).toEqual([
      expect.objectContaining({
        category: 'tool',
        source: 'knowledge-source-register',
        unit: 'capability_calls',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      }),
      expect.objectContaining({
        category: 'tool',
        source: 'knowledge-source-read',
        unit: 'capability_calls',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      }),
    ]);

    coreDb.sqlite.close();
  });

  it('reads fresh Knowledge Store derived indexes through the App API', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-index-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    authorizeDemoWorkspace(coreDb);
    const timestamp = '2026-07-07T00:00:00.000Z';
    const knowledge = knowledgePageFixture(
      {
        id: 'beta',
        title: 'Beta',
        content: 'Beta body.',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID }
    );
    const sourceId = 'ks_00000000-0000-7e28-9211-1f67fd14ca84';
    const missingId = 'ks_00000000-0000-7e65-a399-d53a84c98ecb';
    const sourceContent = 'Canonical registered index evidence.';
    const source = {
      id: sourceId,
      workspaceId: DEMO_WORKSPACE_ID,
      kind: 'document' as const,
      title: 'Registered source',
      uri: null,
      contentDigest: `sha256:${createHash('sha256').update(sourceContent).digest('hex')}`,
      originatingThreadId: null,
      originatingTurnId: null,
      originatingFileId: null,
      capturedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const store = await importedStore(
      dataRoot,
      [
        knowledge,
        knowledgePageFixture(
          {
            createdAt: timestamp,
            updatedAt: timestamp,
            id: 'alpha',
            title: 'Alpha',
            content: `See [Beta](/${knowledge.id}.md).`,
            sourceReferences: [`source:${sourceId}`],
          },
          { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID }
        ),
        knowledgePageFixture(
          {
            createdAt: timestamp,
            updatedAt: timestamp,
            id: 'missing-source',
            title: 'Missing source',
            content: 'Missing source body.',
            sourceReferences: [`source:${missingId}`],
          },
          { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID }
        ),
      ],
      [{ source, content: sourceContent }],
      coreDb
    );
    // The real import establishes its base before this test-owned Git page can name that base.
    const importedNotebook = notebook(dataRoot);
    const importedRevision = importedNotebook.publishedRevision();
    const alphaContent = importedNotebook
      .readRevision(importedRevision)
      .files['alpha.md']!.replace(
        /^source_refs: .+$/m,
        `source_refs: ${JSON.stringify([workspacePageUri(dataRoot, knowledge.id), `source:${sourceId}`])}`
      );
    const candidateRevision = importedNotebook.prepare({
      baseRevision: importedRevision,
      changes: { 'alpha.md': alphaContent },
      metadata: {
        summary: 'Bind authored index fixture to its retained Knowledge Base',
        producer: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        authority: { kind: 'direct', instructionReference: 'test:knowledge-derived-indexes' },
        changeRequest: {
          requestId,
          inputDigest: `sha256:${createHash('sha256').update(alphaContent).digest('hex')}`,
        },
        sourceReferences: [],
      },
    });
    importedNotebook.publish({ baseRevision: importedRevision, candidateRevision });
    const app = createApp({ coreDb, dataRoot, store });
    try {
      const workspaceRoot = join(dataRoot, 'workspaces', DEMO_WORKSPACE_ID);
      // The supplied missing-source page is an explicit validation fault, not a captured Source.
      expect(store.listKnowledgeSources(DEMO_WORKSPACE_ID).map(({ id }) => id)).toEqual([sourceId]);

      const res = await app.request(
        ...knowledgeOperationRequest('knowledge.indexes', {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        })
      );
      expect(res.status).toBe(200);

      const rawBody = await res.json();
      expect(rawBody).not.toHaveProperty('fullText');
      const body = KnowledgeDerivedIndexesResponseSchema.parse(rawBody);
      expect(body.validation.records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            conceptId: 'missing-source',
            indexed: false,
            errors: expect.arrayContaining([
              expect.objectContaining({ code: 'reference.unresolved_source' }),
            ]),
          }),
        ])
      );
      expect(body.linkGraph.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fromId: 'alpha',
            target: `/${knowledge.id}.md`,
            resolved: true,
          }),
        ])
      );
      expect(body.sourceReferences.references).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            conceptId: 'alpha',
            reference: workspacePageUri(dataRoot, knowledge.id),
            kind: 'workspace-knowledge',
            resolved: true,
          }),
          expect.objectContaining({
            conceptId: 'alpha',
            reference: 'source:ks_00000000-0000-7e28-9211-1f67fd14ca84',
            kind: 'registered-source',
            resolved: true,
          }),
          expect.objectContaining({
            conceptId: 'missing-source',
            reference: 'source:ks_00000000-0000-7e65-a399-d53a84c98ecb',
            kind: 'registered-source',
            resolved: false,
          }),
        ])
      );
      expect(existsSync(join(workspaceRoot, 'indexes', 'knowledge-fts.json'))).toBe(false);
      expect(existsSync(join(workspaceRoot, 'indexes', 'search.json'))).toBe(false);
      // Established pointer loss is storage corruption, distinct from a never-admitted reference.
      const revision = importedNotebook.publishedRevision();
      const repositoryPath = join(workspaceRoot, 'knowledge', 'notebook.git');
      const object = execFileSync(
        'git',
        ['--git-dir', repositoryPath, 'rev-parse', `${revision}:sources/${sourceId}.md`],
        { encoding: 'utf8' }
      ).trim();
      const objectPath = join(repositoryPath, 'objects', object.slice(0, 2), object.slice(2));
      rmSync(objectPath);
      expect(() =>
        rebuildWorkspaceDerivedIndexes({ dataRoot, workspaceId: DEMO_WORKSPACE_ID })
      ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
      expect(importedNotebook.publishedRevision()).toBe(revision);
      expect(existsSync(objectPath)).toBe(false);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('retrieves ranked Knowledge Store candidates without a threadless trace', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-retrieval-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    authorizeDemoWorkspace(coreDb);
    const timestamp = '2026-07-07T00:00:00.000Z';
    const workspaceRoot = join(dataRoot, 'workspaces', DEMO_WORKSPACE_ID);
    const sourceId = 'ks_00000000-0000-7e28-9211-1f67fd14ca84';
    const sourceMaterial = 'Canonical release planning source material.';
    const sourceDigest = `sha256:${createHash('sha256').update(sourceMaterial).digest('hex')}`;
    const entry = knowledgePageFixture(
      {
        id: 'release-plan',
        title: 'Release plan',
        content: 'Release cadence is weekly.',
        sourceReferences: [`source:${sourceId}`],
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID }
    );
    const source = {
      id: sourceId,
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      kind: 'document' as const,
      title: 'Release source',
      uri: null,
      contentDigest: sourceDigest,
      originatingThreadId: null,
      originatingTurnId: null,
      originatingFileId: null,
      capturedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const store = await importedStore(
      dataRoot,
      [
        entry,
        knowledgePageFixture(
          {
            id: 'old-plan',
            title: 'Old plan',
            content: 'Legacy deployment notes.',
            createdAt: timestamp,
            updatedAt: timestamp,
            sourceReferences: [`source:${sourceId}`],
          },
          { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID }
        ),
      ],
      [{ source, content: sourceMaterial }],
      coreDb
    );
    const app = createApp({ coreDb, dataRoot, store });
    const owner = notebook(dataRoot);
    const notebookRevision = owner.publishedRevision();
    const releasePage = owner.readRevision(notebookRevision).files['release-plan.md']!;

    const res = await app.request(
      ...knowledgeOperationRequest(
        'knowledge.retrieval',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: 'release cadence', limit: 1 }),
        }
      )
    );
    expect(res.status).toBe(200);

    const body = KnowledgeRetrievalResponseSchema.parse(await res.json());
    expect(body).toEqual({
      queryContext: {
        serverId: expect.any(String),
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      },
      sourceScope: workspacePageScope(dataRoot),
      notebookRevision,
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      caller: 'app-api',
      requestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      retrievalParameters: {
        limit: 1,
        pinnedReferences: [],
        states: ['active'],
        sourceScope: 'workspace',
      },
      selected: [
        {
          reference: {
            scopeId: workspacePageScope(dataRoot),
            objectId: 'release-plan',
          },
          revision: notebookRevision,
          contentDigest: `sha256:${createHash('sha256').update(releasePage).digest('hex')}`,
          score: expect.any(Number),
          sourceReferences: [`source:${sourceId}`],
        },
      ],
      excluded: [],
      createdAt: expect.any(String),
    });
    expect(body.selected[0]!.score).toBeGreaterThan(0);
    expect(body).not.toHaveProperty('retrievalTraceRef');
    expect(body).not.toHaveProperty('traceId');
    expect(body).not.toHaveProperty('retrievalTraceId');
    expect(
      existsSync(
        join(
          workspaceRoot,
          'threads',
          'th_00000000-0000-7000-8000-000000000001',
          'retrieval-traces'
        )
      )
    ).toBe(false);
    expect(existsSync(join(workspaceRoot, 'knowledge', 'traces'))).toBe(false);

    const usageRes = await app.request(
      ...operationRequest(
        'usage.read',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        {}
      )
    );
    expect(usageRes.status, await usageRes.clone().text()).toBe(200);
    const usage = CapabilityUsageResponseSchema.parse(await usageRes.json());
    expect(usage.capabilityCalls).toEqual([
      expect.objectContaining({
        capabilityId: 'knowledge.retrieval',
        family: 'knowledge',
        operation: 'knowledge.retrieval',
        providerRef: 'nanocore-knowledge',
        serviceRef: 'knowledge-store',
        status: 'succeeded',
        owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
      }),
    ]);
    expect(usage.usageRecords).toEqual([
      expect.objectContaining({
        category: 'tool',
        providerRef: 'nanocore-knowledge',
        quantity: 1,
        source: 'knowledge-retrieval',
        unit: 'capability_calls',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      }),
    ]);

    coreDb.sqlite.close();
  });

  it('answers workspace knowledge questions with citations', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-answer-usage-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    authorizeDemoWorkspace(coreDb);
    const store = createDemoStore({ dataRoot });
    const { app, createResponses } = createKnowledgeAnswerApp({ coreDb, dataRoot, store }, [
      {
        query: 'release cadence',
        pageId: workspacePageUri(dataRoot, 'release-plan'),
        answer: 'Release cadence is fortnightly with a Tuesday review.',
        uncertainty: null,
      },
    ]);
    const createRes = await app.request(
      ...knowledgeOperationRequest(
        'knowledge.notebook.create',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId,
            baseRevision: notebook(dataRoot).publishedRevision(),
            path: 'release-plan.md',
            content: authoredPage(
              'Release plan',
              'Release cadence is weekly with a Friday review.'
            ),
            summary: 'Create authored page',
          }),
        }
      )
    );
    expect(createRes.status).toBe(200);
    const publication = (await createRes.json()) as { notebookRevision: string };
    expect(publication.notebookRevision).toBe(notebook(dataRoot).publishedRevision());
    const pageId = 'release-plan';
    const updateRes = await app.request(
      ...knowledgeOperationRequest(
        'knowledge.notebook.update',
        { workspaceId: DEMO_WORKSPACE_ID },
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: '00000000-0000-4000-8000-000000000121',
            baseRevision: notebook(dataRoot).publishedRevision(),
            changes: [
              {
                path: `${pageId}.md`,
                content: authoredPage(
                  'Release plan',
                  'Release cadence is fortnightly with a Tuesday review.'
                ),
              },
            ],
            summary: 'Update release cadence',
          }),
        }
      )
    );
    expect(updateRes.status, await updateRes.clone().text()).toBe(200);
    rebuildWorkspaceDerivedIndexes({
      dataRoot,
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });

    const res = await app.request(
      ...knowledgeOperationRequest(
        'knowledge.answer',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: 'release cadence' }),
        }
      )
    );
    expect(res.status).toBe(200);

    const body = KnowledgeManagerAnswerResponseSchema.parse(await res.json());
    expect(body).toMatchObject({
      caller: 'app-api',
      operation: 'answer',
      outcome: 'answered',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    expect(body).not.toHaveProperty('retrievalTraceRef');
    expect(body).not.toHaveProperty('retrievalTraceId');
    expect(body.answer).toContain('Release cadence is fortnightly');
    expect(body.citations).toEqual([
      expect.objectContaining({
        reference: {
          scopeId: workspacePageScope(dataRoot),
          objectId: pageId,
        },
        excerpt: expect.stringContaining('Release cadence is fortnightly'),
        title: 'Release plan',
      }),
    ]);

    expect(
      existsSync(
        join(
          dataRoot,
          'workspaces',
          'ws_00000000-0000-7000-8000-000000000001',
          'threads',
          'th_00000000-0000-7000-8000-000000000001',
          'retrieval-traces'
        )
      )
    ).toBe(false);
    expect(
      existsSync(
        join(
          dataRoot,
          'workspaces',
          'ws_00000000-0000-7000-8000-000000000001',
          'knowledge',
          'traces'
        )
      )
    ).toBe(false);

    const usageRes = await app.request(
      ...operationRequest(
        'usage.read',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        {}
      )
    );
    expect(usageRes.status, await usageRes.clone().text()).toBe(200);
    const usage = CapabilityUsageResponseSchema.parse(await usageRes.json());
    const askingCalls = usage.capabilityCalls.filter(
      (call) => call.capabilityId === 'knowledge.ask'
    );
    expect(askingCalls).toEqual([
      expect.objectContaining({ operation: 'knowledge.ask', status: 'succeeded' }),
    ]);
    expect(createResponses).toHaveBeenCalledTimes(3);
    const roleTurns = store
      .listThreads(DEMO_WORKSPACE_ID)
      .filter((thread) => thread.entryPath === 'knowledge-manager')
      .flatMap((thread) => store.listThreadTurns(DEMO_WORKSPACE_ID, thread.id));
    expect(roleTurns).toHaveLength(1);
    expect(roleTurns[0]).toMatchObject({
      status: 'completed',
      internalExecution: { roleId: 'knowledge-manager' },
    });
    expect(
      roleTurns[0]!.items.filter((item) => item.type === 'tool-call').map((item) => item.tool)
    ).toEqual(['knowledge.retrieval', 'knowledge.page.read', 'knowledge.result']);
    expect(body).not.toHaveProperty('confidence');

    coreDb.sqlite.close();
  });

  it('returns insufficient evidence instead of speculating', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-insufficient-evidence-'));
    const store = createDemoStore({ dataRoot });
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    authorizeDemoWorkspace(coreDb);
    const { app } = createKnowledgeAnswerApp({ coreDb, dataRoot, store }, [
      {
        query: 'unwritten roadmap promise',
        answer: 'There is no evidence for that roadmap promise.',
        uncertainty: 'No matching workspace knowledge entries were found.',
      },
    ]);
    try {
      const res = await app.request(
        ...knowledgeOperationRequest(
          'knowledge.answer',
          { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: 'unwritten roadmap promise' }),
          }
        )
      );
      expect(res.status).toBe(200);

      const body = KnowledgeManagerAnswerResponseSchema.parse(await res.json());
      expect(body).toMatchObject({
        citations: [],
        outcome: 'insufficient-evidence',
        uncertainty: 'No matching workspace knowledge entries were found.',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('retains model uncertainty when the available page does not answer the question', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-weak-overlap-'));
    const store = createDemoStore({ dataRoot });
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    authorizeDemoWorkspace(coreDb);
    const { app } = createKnowledgeAnswerApp({ coreDb, dataRoot, store }, [
      {
        query: 'Reply exactly CATALOG_OK_GROK. Do not call tools.',
        answer: 'The notebook does not establish the selected model.',
        uncertainty: 'Retrieved workspace knowledge does not cover the question.',
      },
    ]);
    try {
      const createRes = await app.request(
        ...knowledgeOperationRequest(
          'knowledge.notebook.create',
          { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              requestId,
              baseRevision: notebook(dataRoot).publishedRevision(),
              path: 'maintenance-notes.md',
              content: authoredPage(
                'Workspace maintenance notes',
                'This page is not about the selected Assistant model.'
              ),
              summary: 'Create authored page',
            }),
          }
        )
      );
      expect(createRes.status).toBe(200);

      const res = await app.request(
        ...knowledgeOperationRequest(
          'knowledge.answer',
          { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              query: 'Reply exactly CATALOG_OK_GROK. Do not call tools.',
            }),
          }
        )
      );
      expect(res.status).toBe(200);
      expect(KnowledgeManagerAnswerResponseSchema.parse(await res.json())).toMatchObject({
        citations: [],
        outcome: 'insufficient-evidence',
        uncertainty: 'Retrieved workspace knowledge does not cover the question.',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  // Two complete queries include real Kernel work and both admitted notebook sources.
  it('answers a one-term query that appears on the selected page', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-one-term-answer-'));
    const store = createDemoStore({ dataRoot });
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    authorizeDemoWorkspace(coreDb);
    const { app } = createKnowledgeAnswerApp({ coreDb, dataRoot, store }, [
      {
        query: 'Cadence',
        pageId: workspacePageUri(dataRoot, 'cadence'),
        answer: 'Weekly ship after smoke.',
        uncertainty: null,
      },
      {
        query: 'Weekly',
        pageId: workspacePageUri(dataRoot, 'cadence'),
        answer: 'Weekly ship after smoke.',
        uncertainty: null,
      },
    ]);
    try {
      const createRes = await app.request(
        ...knowledgeOperationRequest(
          'knowledge.notebook.create',
          { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              requestId,
              baseRevision: notebook(dataRoot).publishedRevision(),
              path: 'cadence.md',
              content: authoredPage('Cadence', 'Weekly ship after smoke.'),
              summary: 'Create authored page',
            }),
          }
        )
      );
      expect(createRes.status).toBe(200);

      const res = await app.request(
        ...knowledgeOperationRequest(
          'knowledge.answer',
          { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: 'Cadence' }),
          }
        )
      );
      expect(res.status).toBe(200);
      const body = KnowledgeManagerAnswerResponseSchema.parse(await res.json());
      expect(body).toMatchObject({
        outcome: 'answered',
        caller: 'app-api',
      });
      expect(body.answer).toContain('Weekly ship after smoke.');
      expect(body.citations).toEqual([
        expect.objectContaining({
          title: 'Cadence',
        }),
      ]);
      const incidental = await app.request(
        ...knowledgeOperationRequest(
          'knowledge.answer',
          { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: 'Weekly' }),
          }
        )
      );
      expect(KnowledgeManagerAnswerResponseSchema.parse(await incidental.json()).outcome).toBe(
        'answered'
      );
    } finally {
      coreDb.sqlite.close();
    }
  }, 60_000);

  it('returns only the governed retrieval projection without a second context owner', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-context-retrieval-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    authorizeDemoWorkspace(coreDb);
    const app = createApp({ coreDb, dataRoot, store: createDemoStore({ dataRoot }) });

    const sourceRes = await app.request(
      ...knowledgeOperationRequest(
        'knowledge.source.register',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: '00000000-0000-4000-8000-000000000105',
            kind: 'document',
            title: 'Release source',
            uri: 'file://release-source.md',
            content: 'Authoritative release source says Friday review is required.',
          }),
        }
      )
    );
    expect(sourceRes.status).toBe(200);
    const source = RegisterKnowledgeSourceResponseSchema.parse(await sourceRes.json()).source;

    const createRes = await app.request(
      ...knowledgeOperationRequest(
        'knowledge.notebook.create',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId,
            baseRevision: notebook(dataRoot).publishedRevision(),
            path: 'release-plan.md',
            content: authoredPage(
              'Release plan',
              'Release cadence is weekly with a Friday review.',
              [`source:${source.id}`]
            ),
            summary: 'Create authored page',
          }),
        }
      )
    );
    expect(createRes.status).toBe(200);
    const publication = (await createRes.json()) as { notebookRevision: string };
    expect(publication.notebookRevision).toBe(notebook(dataRoot).publishedRevision());
    const pageId = 'release-plan';

    const prepare = () =>
      app.request(
        ...knowledgeOperationRequest(
          'knowledge.context.prepare',
          { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: 'release cadence', limit: 5 }),
          }
        )
      );
    const res = await prepare();
    expect(res.status, await res.clone().text()).toBe(200);
    const body = KnowledgeManagerPrepareContextResponseSchema.parse(await res.json());

    expect(Object.keys(body).sort()).toEqual([
      'caller',
      'excluded',
      'operation',
      'operationId',
      'outcome',
      'selected',
      'workspaceId',
    ]);
    expect(body).toMatchObject({
      caller: 'app-api',
      operation: 'prepare-context-material',
      outcome: 'prepared',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    expect(body.selected).toEqual([
      {
        reference: {
          scopeId: workspacePageScope(dataRoot),
          objectId: pageId,
        },
        revision: notebook(dataRoot).publishedRevision(),
        contentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        score: expect.any(Number),
        sourceReferences: [`source:${source.id}`],
      },
    ]);
    expect(body.excluded).toEqual([]);

    const repeatRes = await prepare();
    expect(repeatRes.status).toBe(200);
    const repeatBody = KnowledgeManagerPrepareContextResponseSchema.parse(await repeatRes.json());
    expect(repeatBody.operationId).not.toBe(body.operationId);
    expect(repeatBody.selected).toEqual(body.selected);
    expect(repeatBody.excluded).toEqual(body.excluded);

    expect(repeatBody).not.toHaveProperty('retrievalTraceRef');
    expect(
      existsSync(
        join(
          dataRoot,
          'workspaces',
          'ws_00000000-0000-7000-8000-000000000001',
          'threads',
          'th_00000000-0000-7000-8000-000000000001',
          'retrieval-traces'
        )
      )
    ).toBe(false);
    expect(
      existsSync(
        join(
          dataRoot,
          'workspaces',
          'ws_00000000-0000-7000-8000-000000000001',
          'knowledge',
          'traces'
        )
      )
    ).toBe(false);
    expect(
      existsSync(
        join(
          dataRoot,
          'workspaces',
          'ws_00000000-0000-7000-8000-000000000001',
          'knowledge',
          'context-packages'
        )
      )
    ).toBe(false);

    const legacyRequest = await app.request(
      ...knowledgeOperationRequest(
        'knowledge.context.prepare',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: 'release cadence', artifactIds: [] }),
        }
      )
    );
    expect(legacyRequest.status).toBe(400);
    await expect(legacyRequest.json()).resolves.toMatchObject({ code: 'invalid_request' });

    const usageRes = await app.request(
      ...operationRequest(
        'usage.read',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        {}
      )
    );
    expect(usageRes.status, await usageRes.clone().text()).toBe(200);
    const usage = CapabilityUsageResponseSchema.parse(await usageRes.json());
    expect(
      usage.capabilityCalls.filter((call) => call.capabilityId === 'knowledge.context.prepare')
    ).toHaveLength(2);
    expect(
      usage.usageRecords.filter((record) => record.source === 'knowledge-context-prepare')
    ).toHaveLength(2);

    coreDb.sqlite.close();
  });

  it('drafts one fixed proposal with owner replay and fail-closed missing-receipt handling', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-proposal-usage-'));
    let coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    authorizeDemoWorkspace(coreDb);
    let store = createDemoStore({ dataRoot });
    let app = createApp({ coreDb, dataRoot, store });
    const sourceRes = await app.request(
      ...knowledgeOperationRequest(
        'knowledge.source.register',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: '00000000-0000-4000-8000-000000000224',
            kind: 'document',
            title: 'Reviewed release source',
            uri: 'file://reviewed-release-source.md',
            content: 'Friday release reviews are required.',
          }),
        }
      )
    );
    expect(sourceRes.status, await sourceRes.clone().text()).toBe(200);
    const source = RegisterKnowledgeSourceResponseSchema.parse(await sourceRes.json()).source;
    const sourceReference = `source:${source.id}@${source.contentDigest}`;
    const canonicalPageBytes = proposalPageBytes(
      'release-cadence',
      'Release cadence',
      sourceReference,
      'Friday releases require review. Public fixture: ghp_publicFixture sk-Latn.'
    );
    const contentDigest = `sha256:${createHash('sha256').update(canonicalPageBytes).digest('hex')}`;
    const draftRequest = {
      requestId: '00000000-0000-4000-8000-000000000223',
      baseRevision: notebook(dataRoot).publishedRevision(),
      knowledgePageId: 'release-cadence',
      canonicalPageBytes,
      contentDigest,
      sourceReferences: [sourceReference],
      rationale: 'Preserve the reviewed release cadence and hf_publicFixture.',
      confidence: 0.7,
    };
    const draft = (input: typeof draftRequest) =>
      app.request(
        ...knowledgeOperationRequest(
          'knowledge.proposal.draft',
          { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(input),
          }
        )
      );

    const firstRes = await draft(draftRequest);
    expect(firstRes.status, await firstRes.clone().text()).toBe(200);
    const first = KnowledgeManagerDraftProposalResponseSchema.parse(await firstRes.json());
    const { status: _status, ...retainedProposal } = first.proposal;
    expect(first).toMatchObject({
      operation: 'draft-proposal',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      caller: 'app-api',
      proposal: {
        id: expect.stringMatching(/^kp_[a-f0-9]{64}$/),
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        operation: 'notebook-change',
        knowledgePageId: 'release-cadence',
        canonicalPageBytes,
        contentDigest,
        sourceReferences: [sourceReference],
        rationale: 'Preserve the reviewed release cadence and hf_publicFixture.',
        confidence: 0.7,
        producer: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        status: 'pending',
      },
      validation: {
        conformance: 'scope-schema-valid',
        generatedFromCompletedWorkHistory: false,
      },
    });
    expect(notebook(dataRoot).publishedRevision()).toBe(draftRequest.baseRevision);
    expect(notebook(dataRoot).readRevision(draftRequest.baseRevision).files).not.toHaveProperty(
      'release-cadence.md'
    );

    coreDb.sqlite.close();
    coreDb = openCoreDb(dataRoot);
    store = new FsStore({ dataRoot });
    app = createApp({ coreDb, dataRoot, store });

    const replayRes = await draft(draftRequest);
    expect(replayRes.status, await replayRes.clone().text()).toBe(200);
    const replay = KnowledgeManagerDraftProposalResponseSchema.parse(await replayRes.json());
    expect(replay.proposal).toEqual(first.proposal);
    expect(replay.validation).toEqual(first.validation);
    expect(store.listKnowledgeProposals('ws_00000000-0000-7000-8000-000000000001')).toEqual([
      retainedProposal,
    ]);
    expect(
      `sha256:${createHash('sha256').update(first.proposal.canonicalPageBytes).digest('hex')}`
    ).toBe(contentDigest);

    const conflictRes = await draft({
      ...draftRequest,
      rationale: 'Try to change the same request.',
    });
    expect(conflictRes.status).toBe(409);
    await expect(conflictRes.json()).resolves.toMatchObject({ code: 'idempotency_key_conflict' });

    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    applyScopedMigrations(workspaceDb);
    workspaceDb.sqlite
      .prepare(
        `DELETE FROM idempotency_requests
         WHERE command_name = 'knowledge.proposal.draft' AND request_id = ?`
      )
      .run(draftRequest.requestId);
    workspaceDb.sqlite.close();

    const missingReceiptRes = await draft(draftRequest);
    expect(missingReceiptRes.status).toBe(409);
    await expect(missingReceiptRes.json()).resolves.toMatchObject({ code: 'recovery_required' });
    expect(store.listKnowledgeProposals('ws_00000000-0000-7000-8000-000000000001')).toEqual([
      retainedProposal,
    ]);
    expect(
      `sha256:${createHash('sha256').update(first.proposal.canonicalPageBytes).digest('hex')}`
    ).toBe(contentDigest);

    const actionCenterRes = await app.request(
      ...operationRequest(
        'attention.list',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        undefined
      )
    );
    expect(actionCenterRes.status).toBe(200);
    const actionCenter = (await actionCenterRes.json()) as { items: Array<{ id: string }> };
    expect(actionCenter.items).toEqual([
      expect.objectContaining({ id: `knowledge:${first.proposal.id}` }),
    ]);

    const usageRes = await app.request(
      ...operationRequest(
        'usage.read',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        {}
      )
    );
    expect(usageRes.status, await usageRes.clone().text()).toBe(200);
    const usage = CapabilityUsageResponseSchema.parse(await usageRes.json());
    expect(
      usage.capabilityCalls.filter((call) => call.capabilityId === 'knowledge.proposal.draft')
    ).toHaveLength(1);

    coreDb.sqlite.close();
  });

  it('suggests review-required repairs without applying changes', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-repair-usage-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    authorizeDemoWorkspace(coreDb);
    const store = createDemoStore({ dataRoot });
    const app = createApp({ coreDb, dataRoot, store });
    const first = await app.request(
      ...knowledgeOperationRequest(
        'knowledge.notebook.create',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: '00000000-0000-4000-8000-000000000331',
            baseRevision: notebook(dataRoot).publishedRevision(),
            path: 'release-plan.md',
            content: authoredPage('Release plan', 'Release cadence is weekly.'),
            summary: 'Create authored page',
          }),
        }
      )
    );
    expect(first.status).toBe(200);
    const second = await app.request(
      ...knowledgeOperationRequest(
        'knowledge.notebook.create',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: '00000000-0000-4000-8000-000000000332',
            baseRevision: notebook(dataRoot).publishedRevision(),
            path: 'second-release-plan.md',
            content: authoredPage(' release   plan ', 'Friday review is required.'),
            summary: 'Create authored page',
          }),
        }
      )
    );
    expect(second.status).toBe(200);

    const res = await app.request(
      ...knowledgeOperationRequest(
        'knowledge.repair.suggest',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }
      )
    );
    expect(res.status).toBe(200);

    const body = KnowledgeManagerSuggestRepairResponseSchema.parse(await res.json());
    expect(body).toMatchObject({
      caller: 'app-api',
      operation: 'suggest-repair',
      outcome: 'suggested',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    expect(body.suggestions).toEqual([
      expect.objectContaining({
        kind: 'duplicate-title',
        title: 'Duplicate title: Release plan',
        autoApplicable: false,
        reviewRequired: true,
      }),
    ]);

    const actionCenterRes = await app.request(
      ...operationRequest(
        'attention.list',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        undefined
      )
    );
    const actionCenter = (await actionCenterRes.json()) as { items: unknown[] };
    expect(actionCenter.items).toEqual([]);

    const usageRes = await app.request(
      ...operationRequest(
        'usage.read',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        {}
      )
    );
    expect(usageRes.status, await usageRes.clone().text()).toBe(200);
    const usage = CapabilityUsageResponseSchema.parse(await usageRes.json());
    expect(
      usage.capabilityCalls.filter((call) => call.capabilityId === 'knowledge.repair.suggest')
    ).toEqual([
      expect.objectContaining({
        capabilityId: 'knowledge.repair.suggest',
        family: 'knowledge',
        operation: 'knowledge.repair.suggest',
        providerRef: 'nanocore-knowledge',
        serviceRef: 'knowledge-manager',
        status: 'succeeded',
        owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
      }),
    ]);
    expect(
      usage.usageRecords.filter((record) => record.source === 'knowledge-repair-suggest')
    ).toEqual([
      expect.objectContaining({
        category: 'tool',
        providerRef: 'nanocore-knowledge',
        quantity: 1,
        source: 'knowledge-repair-suggest',
        unit: 'capability_calls',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      }),
    ]);

    coreDb.sqlite.close();
  });

  it('reports Knowledge Manager health without applying repairs', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-health-usage-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    authorizeDemoWorkspace(coreDb);
    const store = createDemoStore({ dataRoot });
    const app = createApp({ coreDb, dataRoot, store });
    const first = await app.request(
      ...knowledgeOperationRequest(
        'knowledge.notebook.create',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: '00000000-0000-4000-8000-000000000341',
            baseRevision: notebook(dataRoot).publishedRevision(),
            path: 'release-plan.md',
            content: authoredPage('Release plan', 'Release cadence is weekly.'),
            summary: 'Create authored page',
          }),
        }
      )
    );
    expect(first.status).toBe(200);
    const second = await app.request(
      ...knowledgeOperationRequest(
        'knowledge.notebook.create',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: '00000000-0000-4000-8000-000000000342',
            baseRevision: notebook(dataRoot).publishedRevision(),
            path: 'second-release-plan.md',
            content: authoredPage(' release plan ', 'Friday review is required.'),
            summary: 'Create authored page',
          }),
        }
      )
    );
    expect(second.status).toBe(200);

    const res = await app.request(
      ...knowledgeOperationRequest(
        'knowledge.health.check',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }
      )
    );
    expect(res.status).toBe(200);

    const body = KnowledgeManagerHealthCheckResponseSchema.parse(await res.json());
    expect(body).toMatchObject({
      caller: 'app-api',
      operation: 'health-check',
      outcome: 'needs-attention',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      checks: [
        { code: 'knowledge-present', status: 'pass' },
        { code: 'repair-suggestions', status: 'warn' },
      ],
      repairSuggestions: [
        {
          kind: 'duplicate-title',
          autoApplicable: false,
          reviewRequired: true,
        },
      ],
    });

    const actionCenterRes = await app.request(
      ...operationRequest(
        'attention.list',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        undefined
      )
    );
    const actionCenter = (await actionCenterRes.json()) as { items: unknown[] };
    expect(actionCenter.items).toEqual([]);

    const usageRes = await app.request(
      ...operationRequest(
        'usage.read',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        {}
      )
    );
    expect(usageRes.status, await usageRes.clone().text()).toBe(200);
    const usage = CapabilityUsageResponseSchema.parse(await usageRes.json());
    expect(
      usage.capabilityCalls.filter((call) => call.capabilityId === 'knowledge.health.check')
    ).toEqual([
      expect.objectContaining({
        capabilityId: 'knowledge.health.check',
        family: 'knowledge',
        operation: 'knowledge.health.check',
        providerRef: 'nanocore-knowledge',
        serviceRef: 'knowledge-manager',
        status: 'succeeded',
        owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
      }),
    ]);
    expect(
      usage.usageRecords.filter((record) => record.source === 'knowledge-health-check')
    ).toEqual([
      expect.objectContaining({
        category: 'tool',
        providerRef: 'nanocore-knowledge',
        quantity: 1,
        source: 'knowledge-health-check',
        unit: 'capability_calls',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      }),
    ]);

    coreDb.sqlite.close();
  });

  it('rejects public semantic caller overrides', async () => {
    const app = createApp({ store: createDemoStore() });
    const proposalBytes = proposalPageBytes(
      'caller-override',
      'Caller override',
      SYNTACTIC_PROPOSAL_SOURCE_REFERENCE,
      'The route owns its semantic caller.'
    );
    const cases = [
      {
        id: 'knowledge.answer',
        body: { query: 'release cadence' },
      },
      {
        id: 'knowledge.context.prepare',
        body: { query: 'release cadence' },
      },
      {
        id: 'knowledge.proposal.draft',
        body: {
          requestId: '00000000-0000-4000-8000-000000000119',
          baseRevision: 'a'.repeat(40),
          knowledgePageId: 'caller-override',
          canonicalPageBytes: proposalBytes,
          contentDigest: `sha256:${createHash('sha256').update(proposalBytes).digest('hex')}`,
          sourceReferences: [SYNTACTIC_PROPOSAL_SOURCE_REFERENCE],
          rationale: 'Reject caller-supplied semantic ownership.',
          confidence: 1,
        },
      },
      {
        id: 'knowledge.repair.suggest',
        body: {},
      },
      {
        id: 'knowledge.health.check',
        body: {},
      },
      {
        id: 'knowledge.source.register',
        body: {
          requestId: '00000000-0000-4000-8000-000000000123',
          kind: 'document',
          title: 'Release notes',
          content: 'Releases are reviewed every Friday.',
        },
      },
    ] as const;

    for (const testCase of cases) {
      const response = await app.request(
        ...knowledgeOperationRequest(
          testCase.id,
          { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...testCase.body, caller: 'assistant' }),
          }
        )
      );
      expect(response.status, testCase.id).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code: 'invalid_request' });
    }
  });

  it('redacts unexpected Knowledge Manager provider failures', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-provider-failure-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    authorizeDemoWorkspace(coreDb);
    try {
      const { app, createResponses } = createKnowledgeAnswerApp(
        { coreDb, dataRoot, store: createDemoStore({ dataRoot }) },
        [],
        'ENOENT /Users/private/openkit-data/knowledge/pages/secret.md token=private-secret'
      );
      const response = await app.request(
        ...knowledgeOperationRequest(
          'knowledge.answer',
          { workspaceId: DEMO_WORKSPACE_ID },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: 'release cadence' }),
          }
        )
      );
      expect(response.status).toBe(422);
      const refusal = await response.json();
      expect(refusal).toMatchObject({
        code: 'knowledge_query_failed',
        message: 'Knowledge query failed. Inspect the retained Turn before a new request.',
        details: { threadId: expect.any(String), turnId: expect.any(String) },
      });
      expect(JSON.stringify(refusal)).not.toContain('private-secret');
      expect(JSON.stringify(refusal)).not.toContain('/Users/private/');
      expect(createResponses).toHaveBeenCalled();
    } finally {
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('redacts unexpected Knowledge Manager failures', async () => {
    const unsafeMessage =
      'ENOENT /Users/private/openkit-data/knowledge/pages/secret.md token=private-secret';
    const readStore = createDemoStore();
    vi.spyOn(readStore, 'listKnowledge').mockImplementation(() => {
      throw new Error(unsafeMessage);
    });
    const readApp = createAppWithWorkspaceAuthority({ store: readStore });
    const readCases = [
      {
        id: 'knowledge.context.prepare',
        body: { query: 'release cadence' },
        code: 'knowledge_manager_context_failed',
        message: 'Knowledge Manager context preparation failed.',
      },
      {
        id: 'knowledge.repair.suggest',
        body: {},
        code: 'knowledge_manager_repair_suggest_failed',
        message: 'Knowledge Manager repair suggestion failed.',
      },
      {
        id: 'knowledge.health.check',
        body: {},
        code: 'knowledge_manager_health_check_failed',
        message: 'Knowledge Manager health check failed.',
      },
    ] as const;

    for (const testCase of readCases) {
      const response = await readApp.request(
        ...knowledgeOperationRequest(
          testCase.id,
          { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(testCase.body),
          }
        )
      );
      expect(response.status, testCase.id).toBe(500);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ code: testCase.code, message: testCase.message });
      expect(text).not.toContain('/Users/private');
      expect(text).not.toContain('private-secret');
    }

    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-proposal-redaction-'));
    const proposalStore = createDemoStore({ dataRoot });
    const proposalFailure = vi
      .spyOn(proposalStore, 'createKnowledgeProposal')
      .mockImplementation(() => {
        throw new Error(unsafeMessage);
      });
    const proposalCoreDb = openCoreDb(dataRoot);
    applyMigrations(proposalCoreDb);
    authorizeDemoWorkspace(proposalCoreDb);
    const proposalApp = createApp({ coreDb: proposalCoreDb, dataRoot, store: proposalStore });
    try {
      const registered = await proposalApp.request(
        ...knowledgeOperationRequest(
          'knowledge.source.register',
          { workspaceId: DEMO_WORKSPACE_ID },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              requestId: '00000000-0000-4000-8000-000000000122',
              kind: 'document',
              title: 'Redaction source',
              content: 'Unexpected failures remain private.',
            }),
          }
        )
      );
      expect(registered.status).toBe(200);
      const source = RegisterKnowledgeSourceResponseSchema.parse(await registered.json()).source;
      const sourceReference = `source:${source.id}@${source.contentDigest}`;
      const proposalBytes = proposalPageBytes(
        'redacted-failure',
        'Redacted failure',
        sourceReference,
        'Unexpected failures remain private.'
      );
      const proposalResponse = await proposalApp.request(
        ...knowledgeOperationRequest(
          'knowledge.proposal.draft',
          { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              requestId: '00000000-0000-4000-8000-000000000120',
              baseRevision: notebook(dataRoot).publishedRevision(),
              knowledgePageId: 'redacted-failure',
              canonicalPageBytes: proposalBytes,
              contentDigest: `sha256:${createHash('sha256').update(proposalBytes).digest('hex')}`,
              sourceReferences: [sourceReference],
              rationale: 'Exercise unexpected failure redaction.',
              confidence: 1,
            }),
          }
        )
      );
      expect(proposalFailure).toHaveBeenCalledTimes(1);
      expect(proposalResponse.status, await proposalResponse.clone().text()).toBe(500);
      const proposalText = await proposalResponse.text();
      expect(JSON.parse(proposalText)).toMatchObject({
        code: 'knowledge_manager_proposal_draft_failed',
        message: 'Knowledge Manager proposal draft failed.',
      });
      expect(proposalText).not.toContain('/Users/private');
      expect(proposalText).not.toContain('private-secret');
    } finally {
      proposalCoreDb.sqlite.close();
    }
  });
});

/** Reads the exact base retained by the real Workspace creator or importer. */
function workspacePageScope(dataRoot: string): string {
  return `page/workspace/${DEMO_WORKSPACE_ID}/${readDefaultKnowledgeBaseId({ dataRoot, scope: { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID } })}`;
}

/** Serializes a Page in that admitted fixture owner without inventing revision or digest evidence. */
function workspacePageUri(dataRoot: string, objectId: string): string {
  return formatReferenceUri({ scopeId: workspacePageScope(dataRoot), objectId });
}

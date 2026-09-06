import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CapabilityUsageResponseSchema,
  KnowledgeDerivedIndexesResponseSchema,
  KnowledgeManagerAnswerResponseSchema,
  KnowledgeManagerDraftProposalResponseSchema,
  KnowledgeManagerHealthCheckResponseSchema,
  KnowledgeManagerPrepareContextResponseSchema,
  KnowledgeManagerSuggestRepairResponseSchema,
  KnowledgeRetrievalResponseSchema,
  ListKnowledgeClaimsResponseSchema,
  ListKnowledgeConflictsResponseSchema,
  ListKnowledgeObservationsResponseSchema,
  ListKnowledgeSourcesResponseSchema,
  ReadKnowledgeSourceResponseSchema,
  RecordKnowledgeClaimResponseSchema,
  RecordKnowledgeConflictResponseSchema,
  RecordKnowledgeObservationResponseSchema,
  RegisterKnowledgeSourceResponseSchema,
  ResolveKnowledgeConflictResponseSchema,
} from '@openkit/app-api-schemas';
import { describe, expect, it, vi } from 'vitest';
import { ensureLocalUser } from './auth/identity.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { rebuildWorkspaceDerivedIndexes } from './storage/index-rebuild.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const requestId = '00000000-0000-4000-8000-000000000111';
const SYNTACTIC_PROPOSAL_SOURCE_REFERENCE =
  'source:ks_123e4567-e89b-42d3-a456-426614174000@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/**
 * Grants the local test actor access to the demo Workspace.
 *
 * @param coreDb Migrated Core database used by one route fixture.
 */
function authorizeDemoWorkspace(coreDb: ReturnType<typeof openCoreDb>): void {
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'user_local',
    workspaceId: 'ws_demo',
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
    'schema_version: "openkit-workspace-knowledge-schema-v2"',
    'openkit_status: "active"',
    'status: "stable"',
    'scope: "workspace"',
    `openkit_entry_id: ${JSON.stringify(knowledgePageId)}`,
    'openkit_entry_kind: "project-context"',
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

describe('Knowledge proposal decision lineage', () => {
  it('denies a proposal whose durable owner is not the authorized path Workspace', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-proposal-lineage-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    authorizeDemoWorkspace(coreDb);
    const store = createDemoStore({ dataRoot });
    const foreignWorkspace = store.createWorkspace('Foreign Knowledge Workspace');
    const source = store.createKnowledgeEntry(foreignWorkspace.id, {
      kind: 'project-context',
      title: 'Foreign proposal evidence',
      content: 'This evidence belongs only to the foreign Workspace.',
      sourceReferences: [],
    });
    const sourceBytes = readFileSync(
      join(dataRoot, 'workspaces', foreignWorkspace.id, 'knowledge', 'pages', `${source.id}.md`),
      'utf8'
    );
    const sourceReference = `knowledge:${source.id}@sha256:${createHash('sha256')
      .update(sourceBytes)
      .digest('hex')}`;
    const canonicalPageBytes = proposalPageBytes(
      'foreign-proposal',
      'Foreign proposal',
      sourceReference,
      'Foreign Workspace knowledge.'
    );
    const proposal = store.createKnowledgeProposal({
      createdAt: '2026-07-19T00:00:00.000Z',
      requestId: '00000000-0000-4000-8000-000000000115',
      workspaceId: foreignWorkspace.id,
      knowledgePageId: 'foreign-proposal',
      canonicalPageBytes,
      contentDigest: `sha256:${createHash('sha256').update(canonicalPageBytes).digest('hex')}`,
      sourceReferences: [sourceReference],
      rationale: 'Preserve foreign Workspace isolation.',
      confidence: 1,
      verifiedExternalReferences: [],
      producer: { kind: 'user', id: 'user_local' },
    });
    const app = createApp({ coreDb, dataRoot, store });

    try {
      const response = await app.request(
        `/api/app/workspaces/ws_demo/knowledge/proposals/${proposal.id}/decision`,
        {
          body: JSON.stringify({
            decision: 'rejected',
            requestId: '00000000-0000-4000-8000-000000000116',
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
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
      const response = await app.request('/api/workspaces/ws_demo/knowledge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: '00000000-0000-4000-8000-000000000112',
          kind: 'project-context',
          title: 'Unresolved source page',
          content: 'This page must not become active.',
          sourceReferences: ['source:ks_123e4567-e89b-42d3-a456-426614174000'],
        }),
      });

      expect(response.status, await response.clone().text()).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code: 'invalid_request' });
      expect(
        store.listKnowledge('ws_demo').some((entry) => entry.title === 'Unresolved source page')
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
      const createResponse = await app.request('/api/workspaces/ws_demo/knowledge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: '00000000-0000-4000-8000-000000000113',
          kind: 'project-context',
          title: 'Valid active page',
          content: 'These bytes must survive a rejected update.',
        }),
      });
      expect(createResponse.status, await createResponse.clone().text()).toBe(201);
      const knowledge = (await createResponse.json()) as { id: string };
      const pagePath = join(
        dataRoot,
        'workspaces',
        'ws_demo',
        'knowledge',
        'pages',
        `${knowledge.id}.md`
      );
      const activePageBytes = readFileSync(pagePath);

      const updateResponse = await app.request(
        `/api/workspaces/ws_demo/knowledge/${knowledge.id}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: '00000000-0000-4000-8000-000000000114',
            title: 'API token rotation',
          }),
        }
      );

      expect(updateResponse.status, await updateResponse.clone().text()).toBe(400);
      await expect(updateResponse.json()).resolves.toMatchObject({ code: 'invalid_request' });
      expect(readFileSync(pagePath)).toEqual(activePageBytes);
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
    const registerRes = await app.request('/api/app/workspaces/ws_demo/knowledge/sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: '00000000-0000-4000-8000-000000000101',
        kind: 'document',
        title: 'Release notes',
        uri: 'file://release.md',
        content: sourceContent,
        originatingThreadId: 'th_demo',
      }),
    });
    expect(registerRes.status).toBe(201);

    const registered = RegisterKnowledgeSourceResponseSchema.parse(await registerRes.json());
    expect(registered.source).toMatchObject({
      workspaceId: 'ws_demo',
      kind: 'document',
      title: 'Release notes',
      uri: 'file://release.md',
      originatingThreadId: 'th_demo',
      originatingTurnId: null,
      originatingFileId: null,
    });
    expect(registered.source.id).toMatch(/^ks_/);
    expect(registered.source.contentDigest).toMatch(/^sha256:/);
    expect(registered.derivedRepresentations).toEqual([
      expect.objectContaining({
        sourceId: registered.source.id,
        workspaceId: 'ws_demo',
        kind: 'text',
        path: `sources/derived/${registered.source.id}/text.json`,
        materialPath: `sources/materials/${registered.source.id}/content.txt`,
        sourceContentDigest: registered.source.contentDigest,
        contentDigest: registered.source.contentDigest,
      }),
    ]);
    expect(JSON.stringify(registered)).not.toContain('Release cadence is weekly');
    expect(
      readFileSync(
        join(
          dataRoot,
          'workspaces',
          'ws_demo',
          'sources',
          'materials',
          registered.source.id,
          'content.txt'
        ),
        'utf8'
      )
    ).toBe(sourceContent);
    expect(
      JSON.parse(
        readFileSync(
          join(
            dataRoot,
            'workspaces',
            'ws_demo',
            'sources',
            'derived',
            registered.source.id,
            'text.json'
          ),
          'utf8'
        )
      )
    ).toMatchObject({
      sourceId: registered.source.id,
      kind: 'text',
      materialPath: `sources/materials/${registered.source.id}/content.txt`,
    });

    const listRes = await app.request('/api/app/workspaces/ws_demo/knowledge/sources');
    expect(listRes.status).toBe(200);
    expect(ListKnowledgeSourcesResponseSchema.parse(await listRes.json())).toMatchObject({
      items: [{ id: registered.source.id, title: 'Release notes' }],
    });

    const readRes = await app.request(
      `/api/app/workspaces/ws_demo/knowledge/sources/${registered.source.id}`
    );
    expect(readRes.status).toBe(200);
    expect(ReadKnowledgeSourceResponseSchema.parse(await readRes.json())).toMatchObject({
      source: { id: registered.source.id, contentDigest: registered.source.contentDigest },
      derivedRepresentations: [
        expect.objectContaining({
          sourceId: registered.source.id,
          kind: 'text',
          materialPath: `sources/materials/${registered.source.id}/content.txt`,
        }),
      ],
    });

    const usageRes = await app.request('/api/app/workspaces/ws_demo/capability-usage');
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
        workspaceId: 'ws_demo',
      }),
      expect.objectContaining({
        capabilityId: 'knowledge.source.read',
        operation: 'knowledge.source.read',
        serviceRef: 'knowledge-store',
        status: 'succeeded',
        workspaceId: 'ws_demo',
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
        workspaceId: 'ws_demo',
      }),
      expect.objectContaining({
        category: 'tool',
        source: 'knowledge-source-read',
        unit: 'capability_calls',
        workspaceId: 'ws_demo',
      }),
    ]);

    coreDb.sqlite.close();
  });

  it('records and lists workspace knowledge observations from the maintenance ledger', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-observation-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    authorizeDemoWorkspace(coreDb);
    const store = createDemoStore({ dataRoot });
    const app = createApp({ coreDb, dataRoot, store });

    const recordRes = await app.request('/api/app/workspaces/ws_demo/knowledge/observations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: '00000000-0000-4000-8000-000000000102',
        kind: 'retrieval',
        summary: 'Worker repeatedly needed release cadence context.',
        sourceReferences: ['knowledge:kn_demo', 'source:ks_demo'],
        producer: 'knowledge-manager',
        confidence: 0.75,
      }),
    });
    expect(recordRes.status).toBe(201);

    const recorded = RecordKnowledgeObservationResponseSchema.parse(await recordRes.json());
    expect(recorded.observation).toMatchObject({
      workspaceId: 'ws_demo',
      kind: 'retrieval',
      summary: 'Worker repeatedly needed release cadence context.',
      sourceReferences: ['knowledge:kn_demo', 'source:ks_demo'],
      scope: 'workspace',
      producer: 'knowledge-manager',
      confidence: 0.75,
      freshness: 'current',
      status: 'retained',
    });
    expect(recorded.observation.id).toMatch(/^ko_/);

    const month = recorded.observation.observedAt.slice(0, 7).replace('-', '');
    const ledgerPath = join(
      dataRoot,
      'workspaces',
      'ws_demo',
      'knowledge',
      'observations',
      `${month}.jsonl`
    );
    expect(
      readFileSync(ledgerPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    ).toEqual([recorded.observation]);

    const listRes = await app.request('/api/app/workspaces/ws_demo/knowledge/observations');
    expect(listRes.status).toBe(200);
    expect(ListKnowledgeObservationsResponseSchema.parse(await listRes.json())).toMatchObject({
      items: [{ id: recorded.observation.id, kind: 'retrieval' }],
    });

    const usageRes = await app.request('/api/app/workspaces/ws_demo/capability-usage');
    expect(usageRes.status, await usageRes.clone().text()).toBe(200);
    const usage = CapabilityUsageResponseSchema.parse(await usageRes.json());
    expect(usage.capabilityCalls).toEqual([
      expect.objectContaining({
        capabilityId: 'knowledge.observation.record',
        operation: 'knowledge.observation.record',
        serviceRef: 'knowledge-store',
        status: 'succeeded',
        workspaceId: 'ws_demo',
      }),
    ]);
    expect(usage.usageRecords).toEqual([
      expect.objectContaining({
        category: 'tool',
        source: 'knowledge-observation-record',
        unit: 'capability_calls',
        workspaceId: 'ws_demo',
      }),
    ]);

    coreDb.sqlite.close();
  });

  it('records and lists workspace knowledge claims from the maintenance ledger', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-claim-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    authorizeDemoWorkspace(coreDb);
    const store = createDemoStore({ dataRoot });
    const app = createApp({ coreDb, dataRoot, store });

    const recordRes = await app.request('/api/app/workspaces/ws_demo/knowledge/claims', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: '00000000-0000-4000-8000-000000000103',
        statement: 'Release cadence is weekly.',
        sourceReferences: ['knowledge:release-plan', 'source:ks_release'],
        producer: 'knowledge-manager',
        confidence: 0.8,
      }),
    });
    expect(recordRes.status).toBe(201);

    const recorded = RecordKnowledgeClaimResponseSchema.parse(await recordRes.json());
    expect(recorded.claim).toMatchObject({
      workspaceId: 'ws_demo',
      statement: 'Release cadence is weekly.',
      sourceReferences: ['knowledge:release-plan', 'source:ks_release'],
      scope: 'workspace',
      producer: 'knowledge-manager',
      confidence: 0.8,
      freshness: 'current',
      reviewState: 'needs-review',
      conflictStatus: 'none',
    });
    expect(recorded.claim.id).toMatch(/^kc_/);

    const month = recorded.claim.createdAt.slice(0, 7).replace('-', '');
    const ledgerPath = join(
      dataRoot,
      'workspaces',
      'ws_demo',
      'knowledge',
      'claims',
      `${month}.jsonl`
    );
    expect(
      readFileSync(ledgerPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    ).toEqual([recorded.claim]);

    const listRes = await app.request('/api/app/workspaces/ws_demo/knowledge/claims');
    expect(listRes.status).toBe(200);
    expect(ListKnowledgeClaimsResponseSchema.parse(await listRes.json())).toMatchObject({
      items: [{ id: recorded.claim.id, statement: 'Release cadence is weekly.' }],
    });

    const usageRes = await app.request('/api/app/workspaces/ws_demo/capability-usage');
    expect(usageRes.status, await usageRes.clone().text()).toBe(200);
    const usage = CapabilityUsageResponseSchema.parse(await usageRes.json());
    expect(usage.capabilityCalls).toEqual([
      expect.objectContaining({
        capabilityId: 'knowledge.claim.record',
        operation: 'knowledge.claim.record',
        serviceRef: 'knowledge-store',
        status: 'succeeded',
        workspaceId: 'ws_demo',
      }),
    ]);
    expect(usage.usageRecords).toEqual([
      expect.objectContaining({
        category: 'tool',
        source: 'knowledge-claim-record',
        unit: 'capability_calls',
        workspaceId: 'ws_demo',
      }),
    ]);

    coreDb.sqlite.close();
  });

  it('records and lists workspace knowledge conflicts from the maintenance ledger', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-conflict-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    authorizeDemoWorkspace(coreDb);
    const store = createDemoStore({ dataRoot });
    const app = createApp({ coreDb, dataRoot, store });

    const recordRes = await app.request('/api/app/workspaces/ws_demo/knowledge/conflicts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: '00000000-0000-4000-8000-000000000104',
        subjectReferences: ['knowledge:release-plan', 'claim:kc_release'],
        sourceReferences: ['source:ks_release', 'source:ks_correction'],
        summary: 'Release cadence has contradictory source evidence.',
        suggestedActions: ['Ask the user which source is authoritative.'],
        producer: 'knowledge-manager',
      }),
    });
    expect(recordRes.status).toBe(201);

    const recorded = RecordKnowledgeConflictResponseSchema.parse(await recordRes.json());
    expect(recorded.conflict).toMatchObject({
      workspaceId: 'ws_demo',
      subjectReferences: ['knowledge:release-plan', 'claim:kc_release'],
      sourceReferences: ['source:ks_release', 'source:ks_correction'],
      status: 'conflicting',
      summary: 'Release cadence has contradictory source evidence.',
      suggestedActions: ['Ask the user which source is authoritative.'],
      producer: 'knowledge-manager',
    });
    expect(recorded.conflict.id).toMatch(/^kf_/);

    const month = recorded.conflict.createdAt.slice(0, 7).replace('-', '');
    const ledgerPath = join(
      dataRoot,
      'workspaces',
      'ws_demo',
      'knowledge',
      'conflicts',
      `${month}.jsonl`
    );
    expect(
      readFileSync(ledgerPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    ).toEqual([recorded.conflict]);

    const listRes = await app.request('/api/app/workspaces/ws_demo/knowledge/conflicts');
    expect(listRes.status).toBe(200);
    expect(ListKnowledgeConflictsResponseSchema.parse(await listRes.json())).toMatchObject({
      items: [{ id: recorded.conflict.id, status: 'conflicting' }],
    });

    const resolveRes = await app.request(
      `/api/app/workspaces/ws_demo/knowledge/conflicts/${recorded.conflict.id}/resolution`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: '00000000-0000-4000-8000-000000000105',
          resolution: 'Friday release reviews are authoritative for this workspace.',
          resolvedBy: 'knowledge-manager',
        }),
      }
    );
    expect(resolveRes.status).toBe(200);

    const resolved = ResolveKnowledgeConflictResponseSchema.parse(await resolveRes.json());
    expect(resolved.conflict).toMatchObject({
      id: recorded.conflict.id,
      status: 'resolved',
      resolution: 'Friday release reviews are authoritative for this workspace.',
      resolvedBy: 'knowledge-manager',
    });
    expect(resolved.conflict.resolvedAt).toBeTruthy();

    expect(
      readFileSync(ledgerPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    ).toEqual([recorded.conflict, resolved.conflict]);

    const resolvedListRes = await app.request('/api/app/workspaces/ws_demo/knowledge/conflicts');
    expect(resolvedListRes.status).toBe(200);
    expect(ListKnowledgeConflictsResponseSchema.parse(await resolvedListRes.json())).toMatchObject({
      items: [{ id: recorded.conflict.id, status: 'resolved' }],
    });

    const usageRes = await app.request('/api/app/workspaces/ws_demo/capability-usage');
    expect(usageRes.status, await usageRes.clone().text()).toBe(200);
    const usage = CapabilityUsageResponseSchema.parse(await usageRes.json());
    expect(usage.capabilityCalls).toEqual([
      expect.objectContaining({
        capabilityId: 'knowledge.conflict.record',
        operation: 'knowledge.conflict.record',
        serviceRef: 'knowledge-store',
        status: 'succeeded',
      }),
      expect.objectContaining({
        capabilityId: 'knowledge.conflict.resolve',
        operation: 'knowledge.conflict.resolve',
        serviceRef: 'knowledge-store',
        status: 'succeeded',
      }),
    ]);
    expect(usage.usageRecords).toEqual([
      expect.objectContaining({ source: 'knowledge-conflict-record' }),
      expect.objectContaining({ source: 'knowledge-conflict-resolve' }),
    ]);

    coreDb.sqlite.close();
  });

  it('reads fresh Knowledge Store derived indexes through the App API', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-index-route-'));
    const store = createDemoStore({ dataRoot });
    const app = createApp({ dataRoot, store });
    const timestamp = '2026-07-07T00:00:00.000Z';
    const knowledge = store.createKnowledgeEntry('ws_demo', {
      kind: 'project-context',
      title: 'Beta',
      content: 'Beta body.',
    });
    store.createKnowledgeSource({
      id: 'ks_registered',
      workspaceId: 'ws_demo',
      kind: 'document',
      title: 'Registered source',
      uri: null,
      contentDigest: 'sha256:registered',
      originatingThreadId: null,
      originatingTurnId: null,
      originatingFileId: null,
      capturedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const workspaceRoot = join(dataRoot, 'workspaces', 'ws_demo');

    writeFileSync(
      join(workspaceRoot, 'knowledge', 'pages', 'alpha.md'),
      [
        '---',
        'type: "KnowledgePage"',
        'title: "Alpha"',
        'schema_version: "openkit-workspace-knowledge-schema-v2"',
        'openkit_status: "active"',
        'status: "stable"',
        'scope: "workspace"',
        `source_refs: ["knowledge:${knowledge.id}", "source:ks_registered"]`,
        'review_state: "user-authored"',
        'sensitivity: "normal"',
        'freshness: "current"',
        `created_at: "${timestamp}"`,
        `updated_at: "${timestamp}"`,
        '---',
        `See [Beta](/${knowledge.id}.md).`,
        '',
      ].join('\n')
    );
    writeFileSync(
      join(workspaceRoot, 'knowledge', 'pages', 'missing-source.md'),
      [
        '---',
        'type: "KnowledgePage"',
        'title: "Missing source"',
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
        'Missing source body.',
        '',
      ].join('\n')
    );

    const res = await app.request('/api/app/workspaces/ws_demo/knowledge/indexes');
    expect(res.status).toBe(200);

    const body = KnowledgeDerivedIndexesResponseSchema.parse(await res.json());
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
        expect.objectContaining({ fromId: 'alpha', target: `/${knowledge.id}.md`, resolved: true }),
      ])
    );
    expect(body.sourceReferences.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conceptId: 'alpha',
          reference: `knowledge:${knowledge.id}`,
          kind: 'workspace-knowledge',
          resolved: true,
        }),
        expect.objectContaining({
          conceptId: 'alpha',
          reference: 'source:ks_registered',
          kind: 'registered-source',
          resolved: true,
        }),
        expect.objectContaining({
          conceptId: 'missing-source',
          reference: 'source:ks_missing',
          kind: 'registered-source',
          resolved: false,
        }),
      ])
    );
    expect(body.fullText.terms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          term: 'alpha',
          postings: expect.arrayContaining([
            expect.objectContaining({ conceptId: 'alpha', fields: ['title'] }),
          ]),
        }),
        expect.objectContaining({
          term: 'beta',
          postings: expect.arrayContaining([
            expect.objectContaining({ conceptId: 'alpha', fields: ['body'] }),
          ]),
        }),
      ])
    );
  });

  it('retrieves ranked Knowledge Store candidates and persists the trace', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-retrieval-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    authorizeDemoWorkspace(coreDb);
    const store = createDemoStore({ dataRoot });
    const app = createApp({ coreDb, dataRoot, store });
    const timestamp = '2026-07-07T00:00:00.000Z';
    const workspaceRoot = join(dataRoot, 'workspaces', 'ws_demo');
    const sourceId = 'ks_123e4567-e89b-42d3-a456-426614174000';
    const releasePage = [
      '---',
      'type: "KnowledgePage"',
      'title: "Release plan"',
      'schema_version: "openkit-workspace-knowledge-schema-v2"',
      'openkit_status: "active"',
      'status: "stable"',
      'scope: "workspace"',
      `source_refs: ["source:${sourceId}"]`,
      'review_state: "user-authored"',
      'sensitivity: "normal"',
      'freshness: "current"',
      `created_at: "${timestamp}"`,
      `updated_at: "${timestamp}"`,
      '---',
      'Release cadence is weekly.',
      '',
    ].join('\n');
    const oldPage = [
      '---',
      'type: "KnowledgePage"',
      'title: "Old plan"',
      'schema_version: "openkit-workspace-knowledge-schema-v2"',
      'openkit_status: "active"',
      'status: "stable"',
      'scope: "workspace"',
      `source_refs: ["source:${sourceId}"]`,
      'review_state: "user-authored"',
      'sensitivity: "normal"',
      'freshness: "current"',
      `created_at: "${timestamp}"`,
      `updated_at: "${timestamp}"`,
      '---',
      'Legacy deployment notes.',
      '',
    ].join('\n');

    store.createKnowledgeSource({
      id: sourceId,
      workspaceId: 'ws_demo',
      kind: 'document',
      title: 'Release source',
      uri: null,
      contentDigest: 'sha256:release',
      originatingThreadId: null,
      originatingTurnId: null,
      originatingFileId: null,
      capturedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    writeFileSync(join(workspaceRoot, 'knowledge', 'pages', 'release-plan.md'), releasePage);
    writeFileSync(join(workspaceRoot, 'knowledge', 'pages', 'old-plan.md'), oldPage);

    const res = await app.request('/api/app/workspaces/ws_demo/knowledge/retrievals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'release cadence', limit: 1 }),
    });
    expect(res.status).toBe(200);

    const body = KnowledgeRetrievalResponseSchema.parse(await res.json());
    expect(body).toEqual({
      traceId: expect.stringMatching(
        /^krt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      ),
      workspaceId: 'ws_demo',
      caller: 'app-api',
      requestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      retrievalParameters: {
        limit: 1,
        pinnedConceptIds: [],
      },
      selected: [
        {
          knowledgePageId: 'release-plan',
          contentDigest: `sha256:${createHash('sha256').update(releasePage).digest('hex')}`,
          score: 5,
          sourceReferences: [`source:${sourceId}`],
        },
      ],
      excluded: [],
      createdAt: expect.any(String),
    });

    const month = body.createdAt.slice(0, 7).replace('-', '');
    const tracePath = join(workspaceRoot, 'knowledge', 'traces', `${month}.jsonl`);
    expect(
      readFileSync(tracePath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    ).toEqual([body]);

    const usageRes = await app.request('/api/app/workspaces/ws_demo/capability-usage');
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
        workspaceId: 'ws_demo',
      }),
    ]);
    expect(usage.usageRecords).toEqual([
      expect.objectContaining({
        category: 'tool',
        providerRef: 'nanocore-knowledge',
        quantity: 1,
        source: 'knowledge-retrieval',
        unit: 'capability_calls',
        workspaceId: 'ws_demo',
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
    const app = createApp({ coreDb, dataRoot, store });
    const createRes = await app.request('/api/workspaces/ws_demo/knowledge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId,
        kind: 'project-context',
        title: 'Release plan',
        content: 'Release cadence is weekly with a Friday review.',
      }),
    });
    expect(createRes.status).toBe(201);
    const knowledge = (await createRes.json()) as { id: string };
    const pagePath = join(
      dataRoot,
      'workspaces',
      'ws_demo',
      'knowledge',
      'pages',
      `${knowledge.id}.md`
    );
    writeFileSync(
      pagePath,
      readFileSync(pagePath, 'utf8').replace(
        'Release cadence is weekly with a Friday review.',
        'Release cadence is fortnightly with a Tuesday review.'
      )
    );
    rebuildWorkspaceDerivedIndexes({ dataRoot, workspaceId: 'ws_demo' });

    const res = await app.request('/api/app/workspaces/ws_demo/knowledge/manager/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'release cadence' }),
    });
    expect(res.status).toBe(200);

    const body = KnowledgeManagerAnswerResponseSchema.parse(await res.json());
    expect(body).toMatchObject({
      caller: 'app-api',
      operation: 'answer',
      outcome: 'answered',
      retrievalTraceId: expect.stringMatching(/^krt_/),
      workspaceId: 'ws_demo',
    });
    expect(body.answer).toContain('Release cadence is fortnightly');
    expect(body.citations).toEqual([
      expect.objectContaining({
        kind: 'project-context',
        title: 'Release plan',
      }),
    ]);

    const month = new Date().toISOString().slice(0, 7).replace('-', '');
    const retrievalRows = readFileSync(
      join(dataRoot, 'workspaces', 'ws_demo', 'knowledge', 'traces', `${month}.jsonl`),
      'utf8'
    )
      .trim()
      .split('\n')
      .map((line) => KnowledgeRetrievalResponseSchema.parse(JSON.parse(line)));
    expect(retrievalRows).toHaveLength(1);
    expect(retrievalRows[0]).toMatchObject({
      caller: 'app-api',
      traceId: body.retrievalTraceId,
      workspaceId: 'ws_demo',
    });

    const usageRes = await app.request('/api/app/workspaces/ws_demo/capability-usage');
    expect(usageRes.status, await usageRes.clone().text()).toBe(200);
    const usage = CapabilityUsageResponseSchema.parse(await usageRes.json());
    expect(
      usage.capabilityCalls.filter((call) => call.capabilityId === 'knowledge.answer')
    ).toEqual([
      expect.objectContaining({
        capabilityId: 'knowledge.answer',
        family: 'knowledge',
        operation: 'knowledge.answer',
        providerRef: 'nanocore-knowledge',
        serviceRef: 'knowledge-manager',
        status: 'succeeded',
        workspaceId: 'ws_demo',
      }),
    ]);
    expect(usage.usageRecords.filter((record) => record.source === 'knowledge-answer')).toEqual([
      expect.objectContaining({
        category: 'tool',
        providerRef: 'nanocore-knowledge',
        quantity: 1,
        source: 'knowledge-answer',
        unit: 'capability_calls',
        workspaceId: 'ws_demo',
      }),
    ]);

    coreDb.sqlite.close();
  });

  it('returns insufficient evidence instead of speculating', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-insufficient-evidence-'));
    const app = createApp({ dataRoot, store: createDemoStore({ dataRoot }) });
    const res = await app.request('/api/app/workspaces/ws_demo/knowledge/manager/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'unwritten roadmap promise' }),
    });
    expect(res.status).toBe(200);

    const body = KnowledgeManagerAnswerResponseSchema.parse(await res.json());
    expect(body).toMatchObject({
      citations: [],
      confidence: 0,
      outcome: 'insufficient-evidence',
      uncertainty: 'No matching workspace knowledge entries were found.',
    });
  });

  it('returns only the governed retrieval projection without a second context owner', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-context-retrieval-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    authorizeDemoWorkspace(coreDb);
    const app = createApp({ coreDb, dataRoot, store: createDemoStore({ dataRoot }) });

    const sourceRes = await app.request('/api/app/workspaces/ws_demo/knowledge/sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: '00000000-0000-4000-8000-000000000105',
        kind: 'document',
        title: 'Release source',
        uri: 'file://release-source.md',
        content: 'Authoritative release source says Friday review is required.',
      }),
    });
    expect(sourceRes.status).toBe(201);
    const source = RegisterKnowledgeSourceResponseSchema.parse(await sourceRes.json()).source;

    const createRes = await app.request('/api/workspaces/ws_demo/knowledge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId,
        kind: 'project-context',
        title: 'Release plan',
        content: 'Release cadence is weekly with a Friday review.',
        sourceReferences: [`source:${source.id}`],
      }),
    });
    expect(createRes.status).toBe(201);
    const knowledge = (await createRes.json()) as { id: string };

    const prepare = () =>
      app.request('/api/app/workspaces/ws_demo/knowledge/manager/context', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'release cadence', limit: 5 }),
      });
    const res = await prepare();
    expect(res.status, await res.clone().text()).toBe(200);
    const body = KnowledgeManagerPrepareContextResponseSchema.parse(await res.json());

    expect(Object.keys(body).sort()).toEqual([
      'caller',
      'excluded',
      'operation',
      'operationId',
      'outcome',
      'retrievalTraceId',
      'selected',
      'workspaceId',
    ]);
    expect(body).toMatchObject({
      caller: 'app-api',
      operation: 'prepare-context-material',
      outcome: 'prepared',
      retrievalTraceId: expect.stringMatching(/^krt_/),
      workspaceId: 'ws_demo',
    });
    expect(body.selected).toEqual([
      {
        knowledgePageId: knowledge.id,
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
    expect(repeatBody.retrievalTraceId).not.toBe(body.retrievalTraceId);
    expect(repeatBody.selected).toEqual(body.selected);
    expect(repeatBody.excluded).toEqual(body.excluded);

    const month = new Date().toISOString().slice(0, 7).replace('-', '');
    const retrievalRows = readFileSync(
      join(dataRoot, 'workspaces', 'ws_demo', 'knowledge', 'traces', `${month}.jsonl`),
      'utf8'
    )
      .trim()
      .split('\n')
      .map((line) => KnowledgeRetrievalResponseSchema.parse(JSON.parse(line)));
    expect(retrievalRows).toHaveLength(2);
    expect(retrievalRows.map((row) => row.traceId)).toEqual([
      body.retrievalTraceId,
      repeatBody.retrievalTraceId,
    ]);
    expect(retrievalRows.map((row) => row.selected)).toEqual([body.selected, repeatBody.selected]);
    expect(
      existsSync(join(dataRoot, 'workspaces', 'ws_demo', 'knowledge', 'context-packages'))
    ).toBe(false);

    const legacyRequest = await app.request(
      '/api/app/workspaces/ws_demo/knowledge/manager/context',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'release cadence', artifactIds: [] }),
      }
    );
    expect(legacyRequest.status).toBe(400);
    await expect(legacyRequest.json()).resolves.toMatchObject({ code: 'invalid_request' });

    const usageRes = await app.request('/api/app/workspaces/ws_demo/capability-usage');
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
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    authorizeDemoWorkspace(coreDb);
    const store = createDemoStore({ dataRoot });
    const app = createApp({ coreDb, dataRoot, store });
    const sourceRes = await app.request('/api/app/workspaces/ws_demo/knowledge/sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: '00000000-0000-4000-8000-000000000224',
        kind: 'document',
        title: 'Reviewed release source',
        uri: 'file://reviewed-release-source.md',
        content: 'Friday release reviews are required.',
      }),
    });
    expect(sourceRes.status, await sourceRes.clone().text()).toBe(201);
    const source = RegisterKnowledgeSourceResponseSchema.parse(await sourceRes.json()).source;
    const sourceReference = `source:${source.id}@${source.contentDigest}`;
    const canonicalPageBytes = proposalPageBytes(
      'release-cadence',
      'Release cadence',
      sourceReference,
      'Friday releases require review.'
    );
    const contentDigest = `sha256:${createHash('sha256').update(canonicalPageBytes).digest('hex')}`;
    const draftRequest = {
      requestId: '00000000-0000-4000-8000-000000000223',
      knowledgePageId: 'release-cadence',
      canonicalPageBytes,
      contentDigest,
      sourceReferences: [sourceReference],
      rationale: 'Preserve the reviewed release cadence.',
      confidence: 0.7,
    };
    const draft = (input: typeof draftRequest) =>
      app.request('/api/app/workspaces/ws_demo/knowledge/manager/proposals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });

    const firstRes = await draft(draftRequest);
    expect(firstRes.status, await firstRes.clone().text()).toBe(200);
    const first = KnowledgeManagerDraftProposalResponseSchema.parse(await firstRes.json());
    expect(first).toMatchObject({
      operation: 'draft-proposal',
      workspaceId: 'ws_demo',
      caller: 'app-api',
      proposal: {
        id: expect.stringMatching(/^kp_[a-f0-9]{64}$/),
        workspaceId: 'ws_demo',
        operation: 'create',
        knowledgePageId: 'release-cadence',
        canonicalPageBytes,
        contentDigest,
        sourceReferences: [sourceReference],
        rationale: 'Preserve the reviewed release cadence.',
        confidence: 0.7,
        producer: { kind: 'user', id: 'user_local' },
        status: 'pending',
      },
      validation: {
        conformance: 'Workspace-schema-valid',
        generatedFromCompletedWorkHistory: false,
      },
    });
    expect(
      existsSync(
        join(dataRoot, 'workspaces', 'ws_demo', 'knowledge', 'pages', 'release-cadence.md')
      )
    ).toBe(false);

    const replayRes = await draft(draftRequest);
    expect(replayRes.status, await replayRes.clone().text()).toBe(200);
    const replay = KnowledgeManagerDraftProposalResponseSchema.parse(await replayRes.json());
    expect(replay.proposal).toEqual(first.proposal);
    expect(replay.validation).toEqual(first.validation);
    expect(store.listKnowledgeProposals('ws_demo')).toHaveLength(1);

    const conflictRes = await draft({
      ...draftRequest,
      rationale: 'Try to change the same request.',
    });
    expect(conflictRes.status).toBe(409);
    await expect(conflictRes.json()).resolves.toMatchObject({ code: 'idempotency_key_conflict' });

    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
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
    expect(store.listKnowledgeProposals('ws_demo')).toHaveLength(1);

    const actionCenterRes = await app.request('/api/app/workspaces/ws_demo/action-center');
    expect(actionCenterRes.status).toBe(200);
    const actionCenter = (await actionCenterRes.json()) as { items: Array<{ id: string }> };
    expect(actionCenter.items).toEqual([
      expect.objectContaining({ id: `knowledge:${first.proposal.id}` }),
    ]);

    const usageRes = await app.request('/api/app/workspaces/ws_demo/capability-usage');
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
    const first = await app.request('/api/workspaces/ws_demo/knowledge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: '00000000-0000-4000-8000-000000000331',
        kind: 'project-context',
        title: 'Release plan',
        content: 'Release cadence is weekly.',
      }),
    });
    expect(first.status).toBe(201);
    const second = await app.request('/api/workspaces/ws_demo/knowledge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: '00000000-0000-4000-8000-000000000332',
        kind: 'project-context',
        title: ' release   plan ',
        content: 'Friday review is required.',
      }),
    });
    expect(second.status).toBe(201);

    const res = await app.request('/api/app/workspaces/ws_demo/knowledge/manager/repairs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);

    const body = KnowledgeManagerSuggestRepairResponseSchema.parse(await res.json());
    expect(body).toMatchObject({
      caller: 'app-api',
      operation: 'suggest-repair',
      outcome: 'suggested',
      workspaceId: 'ws_demo',
    });
    expect(body.suggestions).toEqual([
      expect.objectContaining({
        kind: 'duplicate-title',
        title: 'Duplicate title: Release plan',
        autoApplicable: false,
        reviewRequired: true,
      }),
    ]);

    const actionCenterRes = await app.request('/api/app/workspaces/ws_demo/action-center');
    const actionCenter = (await actionCenterRes.json()) as { items: unknown[] };
    expect(actionCenter.items).toEqual([]);

    const usageRes = await app.request('/api/app/workspaces/ws_demo/capability-usage');
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
        workspaceId: 'ws_demo',
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
        workspaceId: 'ws_demo',
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
    const first = await app.request('/api/workspaces/ws_demo/knowledge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: '00000000-0000-4000-8000-000000000341',
        kind: 'project-context',
        title: 'Release plan',
        content: 'Release cadence is weekly.',
      }),
    });
    expect(first.status).toBe(201);
    const second = await app.request('/api/workspaces/ws_demo/knowledge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: '00000000-0000-4000-8000-000000000342',
        kind: 'project-context',
        title: ' release plan ',
        content: 'Friday review is required.',
      }),
    });
    expect(second.status).toBe(201);

    const res = await app.request('/api/app/workspaces/ws_demo/knowledge/manager/health', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);

    const body = KnowledgeManagerHealthCheckResponseSchema.parse(await res.json());
    expect(body).toMatchObject({
      caller: 'app-api',
      operation: 'health-check',
      outcome: 'needs-attention',
      workspaceId: 'ws_demo',
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

    const actionCenterRes = await app.request('/api/app/workspaces/ws_demo/action-center');
    const actionCenter = (await actionCenterRes.json()) as { items: unknown[] };
    expect(actionCenter.items).toEqual([]);

    const usageRes = await app.request('/api/app/workspaces/ws_demo/capability-usage');
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
        workspaceId: 'ws_demo',
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
        workspaceId: 'ws_demo',
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
        path: '/api/app/workspaces/ws_demo/knowledge/manager/answer',
        body: { query: 'release cadence' },
      },
      {
        path: '/api/app/workspaces/ws_demo/knowledge/manager/context',
        body: { query: 'release cadence' },
      },
      {
        path: '/api/app/workspaces/ws_demo/knowledge/manager/proposals',
        body: {
          requestId: '00000000-0000-4000-8000-000000000119',
          knowledgePageId: 'caller-override',
          canonicalPageBytes: proposalBytes,
          contentDigest: `sha256:${createHash('sha256').update(proposalBytes).digest('hex')}`,
          sourceReferences: [SYNTACTIC_PROPOSAL_SOURCE_REFERENCE],
          rationale: 'Reject caller-supplied semantic ownership.',
          confidence: 1,
        },
      },
      {
        path: '/api/app/workspaces/ws_demo/knowledge/manager/repairs',
        body: {},
      },
      {
        path: '/api/app/workspaces/ws_demo/knowledge/manager/health',
        body: {},
      },
      {
        path: '/api/app/workspaces/ws_demo/knowledge/sources',
        body: {
          requestId: 'req_source_caller_override',
          kind: 'document',
          title: 'Release notes',
          content: 'Releases are reviewed every Friday.',
        },
      },
    ] as const;

    for (const testCase of cases) {
      const response = await app.request(testCase.path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...testCase.body, caller: 'assistant' }),
      });
      expect(response.status, testCase.path).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code: 'invalid_request' });
    }
  });

  it('redacts unexpected Knowledge Manager failures', async () => {
    const unsafeMessage =
      'ENOENT /Users/private/openkit-data/knowledge/pages/secret.md token=private-secret';
    const readStore = createDemoStore();
    vi.spyOn(readStore, 'listKnowledge').mockImplementation(() => {
      throw new Error(unsafeMessage);
    });
    const readApp = createApp({ store: readStore });
    const readCases = [
      {
        path: '/api/app/workspaces/ws_demo/knowledge/manager/answer',
        body: { query: 'release cadence' },
        code: 'knowledge_manager_answer_failed',
        message: 'Knowledge Manager answer failed.',
      },
      {
        path: '/api/app/workspaces/ws_demo/knowledge/manager/context',
        body: { query: 'release cadence' },
        code: 'knowledge_manager_context_failed',
        message: 'Knowledge Manager context preparation failed.',
      },
      {
        path: '/api/app/workspaces/ws_demo/knowledge/manager/repairs',
        body: {},
        code: 'knowledge_manager_repair_suggest_failed',
        message: 'Knowledge Manager repair suggestion failed.',
      },
      {
        path: '/api/app/workspaces/ws_demo/knowledge/manager/health',
        body: {},
        code: 'knowledge_manager_health_check_failed',
        message: 'Knowledge Manager health check failed.',
      },
    ] as const;

    for (const testCase of readCases) {
      const response = await readApp.request(testCase.path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(testCase.body),
      });
      expect(response.status, testCase.path).toBe(500);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ code: testCase.code, message: testCase.message });
      expect(text).not.toContain('/Users/private');
      expect(text).not.toContain('private-secret');
    }

    const proposalStore = createDemoStore();
    vi.spyOn(proposalStore, 'createKnowledgeProposal').mockImplementation(() => {
      throw new Error(unsafeMessage);
    });
    const proposalApp = createApp({ store: proposalStore });
    const proposalBytes = proposalPageBytes(
      'redacted-failure',
      'Redacted failure',
      SYNTACTIC_PROPOSAL_SOURCE_REFERENCE,
      'Unexpected failures remain private.'
    );
    const proposalResponse = await proposalApp.request(
      '/api/app/workspaces/ws_demo/knowledge/manager/proposals',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: '00000000-0000-4000-8000-000000000120',
          knowledgePageId: 'redacted-failure',
          canonicalPageBytes: proposalBytes,
          contentDigest: `sha256:${createHash('sha256').update(proposalBytes).digest('hex')}`,
          sourceReferences: [SYNTACTIC_PROPOSAL_SOURCE_REFERENCE],
          rationale: 'Exercise unexpected failure redaction.',
          confidence: 1,
        }),
      }
    );
    expect(proposalResponse.status).toBe(500);
    const proposalText = await proposalResponse.text();
    expect(JSON.parse(proposalText)).toMatchObject({
      code: 'knowledge_manager_proposal_draft_failed',
      message: 'Knowledge Manager proposal draft failed.',
    });
    expect(proposalText).not.toContain('/Users/private');
    expect(proposalText).not.toContain('private-secret');
  });
});

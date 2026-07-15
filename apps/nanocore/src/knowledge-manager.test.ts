import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  MaterializeKnowledgeContextPackageResponseSchema,
  PromoteKnowledgeClaimResponseSchema,
  ReadKnowledgeSourceResponseSchema,
  RecordKnowledgeClaimResponseSchema,
  RecordKnowledgeConflictResponseSchema,
  RecordKnowledgeObservationResponseSchema,
  RegisterKnowledgeSourceResponseSchema,
  ResolveKnowledgeConflictResponseSchema,
} from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';
import { ensureLocalUser } from './auth/identity.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from './config/runtime-config.js';
import { createKnowledgeContextPackageDigest } from './knowledge-manager.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';

const requestId = '00000000-0000-4000-8000-000000000111';

describe('Knowledge Manager answer operation', () => {
  it('registers and reads workspace knowledge sources without exposing content', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-source-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
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
          'users',
          'user_local',
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
            'users',
            'user_local',
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
      'users',
      'user_local',
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
      'users',
      'user_local',
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

  it('promotes an accepted workspace knowledge claim into a review proposal', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-claim-promotion-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const app = createApp({ coreDb, dataRoot, store });
    const knowledge = store.createKnowledgeEntry('ws_demo', {
      kind: 'project-context',
      title: 'Release plan',
      content: 'Release cadence is weekly.',
    });

    const recordRes = await app.request('/api/app/workspaces/ws_demo/knowledge/claims', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: '00000000-0000-4000-8000-000000000108',
        statement: 'Release cadence is weekly.',
        sourceReferences: [`knowledge:${knowledge.id}`],
        producer: 'knowledge-manager',
        confidence: 0.8,
        reviewState: 'accepted',
      }),
    });
    expect(recordRes.status).toBe(201);
    const claim = RecordKnowledgeClaimResponseSchema.parse(await recordRes.json()).claim;

    const promoteRes = await app.request(
      `/api/app/workspaces/ws_demo/knowledge/claims/${claim.id}/promotion`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: '00000000-0000-4000-8000-000000000109',
        }),
      }
    );
    expect(promoteRes.status).toBe(201);

    const promoted = PromoteKnowledgeClaimResponseSchema.parse(await promoteRes.json());
    expect(promoted).toMatchObject({
      claim: { id: claim.id, reviewState: 'accepted' },
      draft: {
        operation: 'draft-proposal',
        confidence: 0.8,
        proposal: {
          title: 'Claim: Release cadence is weekly.',
          summary: 'Release cadence is weekly.',
          status: 'pending',
        },
        sourceReferences: [`knowledge:${knowledge.id}`],
        validation: { status: 'ready-for-review' },
      },
    });
    expect(store.listKnowledgeProposals('ws_demo')).toEqual([
      expect.objectContaining({
        id: promoted.draft.proposal.id,
        sourceClaimId: claim.id,
        status: 'pending',
        summary: 'Release cadence is weekly.',
      }),
    ]);

    const acceptRes = await app.request(
      `/api/app/workspaces/ws_demo/knowledge/proposals/${promoted.draft.proposal.id}/decision`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: '00000000-0000-4000-8000-000000000110',
          decision: 'accepted',
          message: 'Looks right.',
        }),
      }
    );
    expect(acceptRes.status).toBe(200);

    const applied = store
      .listKnowledge('ws_demo')
      .find((entry) => entry.title === 'Release cadence is weekly.');
    expect(applied).toMatchObject({
      kind: 'project-context',
      content: 'Release cadence is weekly.',
      sourceReferences: [`knowledge:${knowledge.id}`],
    });
    expect(
      readFileSync(
        join(
          dataRoot,
          'users',
          'user_local',
          'workspaces',
          'ws_demo',
          'knowledge',
          'pages',
          `${applied?.id}.md`
        ),
        'utf8'
      )
    ).toContain(`source_refs: ["knowledge:${knowledge.id}"]`);

    const usageRes = await app.request('/api/app/workspaces/ws_demo/capability-usage');
    expect(usageRes.status, await usageRes.clone().text()).toBe(200);
    const usage = CapabilityUsageResponseSchema.parse(await usageRes.json());
    expect(usage.capabilityCalls).toEqual([
      expect.objectContaining({
        capabilityId: 'knowledge.claim.record',
        operation: 'knowledge.claim.record',
        serviceRef: 'knowledge-store',
        status: 'succeeded',
      }),
      expect.objectContaining({
        capabilityId: 'knowledge.claim.promote',
        operation: 'knowledge.claim.promote',
        serviceRef: 'knowledge-store',
        status: 'succeeded',
      }),
    ]);
    expect(usage.usageRecords).toEqual([
      expect.objectContaining({ source: 'knowledge-claim-record' }),
      expect.objectContaining({ source: 'knowledge-claim-promote' }),
    ]);

    coreDb.sqlite.close();
  });

  it('records and lists workspace knowledge conflicts from the maintenance ledger', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-conflict-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
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
      'users',
      'user_local',
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
    const workspaceRoot = join(dataRoot, 'users', 'user_local', 'workspaces', 'ws_demo');

    writeFileSync(
      join(workspaceRoot, 'knowledge', 'pages', 'alpha.md'),
      [
        '---',
        'type: "KnowledgePage"',
        'title: "Alpha"',
        'schema_version: "openkit-workspace-knowledge-schema-v1"',
        'status: "active"',
        'scope: "workspace"',
        `source_refs: ["knowledge:${knowledge.id}", "source:ks_registered"]`,
        'review_state: "accepted"',
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
        'schema_version: "openkit-workspace-knowledge-schema-v1"',
        'status: "active"',
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
    const store = createDemoStore({ dataRoot });
    const app = createApp({ coreDb, dataRoot, store });
    const timestamp = '2026-07-07T00:00:00.000Z';
    const workspaceRoot = join(dataRoot, 'users', 'user_local', 'workspaces', 'ws_demo');

    store.createKnowledgeSource({
      id: 'ks_release',
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
    writeFileSync(
      join(workspaceRoot, 'knowledge', 'pages', 'release-plan.md'),
      [
        '---',
        'type: "KnowledgePage"',
        'title: "Release plan"',
        'schema_version: "openkit-workspace-knowledge-schema-v1"',
        'status: "active"',
        'scope: "workspace"',
        'source_refs: ["source:ks_release"]',
        'review_state: "accepted"',
        'sensitivity: "normal"',
        'freshness: "current"',
        `created_at: "${timestamp}"`,
        `updated_at: "${timestamp}"`,
        '---',
        'Release cadence is weekly.',
        '',
      ].join('\n')
    );
    writeFileSync(
      join(workspaceRoot, 'knowledge', 'pages', 'old-plan.md'),
      [
        '---',
        'type: "KnowledgePage"',
        'title: "Old plan"',
        'schema_version: "openkit-workspace-knowledge-schema-v1"',
        'status: "active"',
        'scope: "workspace"',
        'source_refs: ["source:ks_release"]',
        'review_state: "accepted"',
        'sensitivity: "normal"',
        'freshness: "current"',
        `created_at: "${timestamp}"`,
        `updated_at: "${timestamp}"`,
        '---',
        'Legacy deployment notes.',
        '',
      ].join('\n')
    );

    const res = await app.request('/api/app/workspaces/ws_demo/knowledge/retrievals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'release cadence', limit: 1 }),
    });
    expect(res.status).toBe(200);

    const body = KnowledgeRetrievalResponseSchema.parse(await res.json());
    expect(body).toMatchObject({
      workspaceId: 'ws_demo',
      query: 'release cadence',
      selected: [
        {
          conceptId: 'release-plan',
          title: 'Release plan',
          path: 'knowledge/pages/release-plan.md',
          matchedTerms: ['cadence', 'release'],
          sourceReferences: ['source:ks_release'],
        },
      ],
    });
    expect(body.excluded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conceptId: 'old-plan',
          reason: 'relevance_too_low',
        }),
      ])
    );
    expect(body.traceId).toMatch(/^krt_/);

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

    const res = await app.request('/api/app/workspaces/ws_demo/knowledge/manager/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'release cadence' }),
    });
    expect(res.status).toBe(200);

    const body = KnowledgeManagerAnswerResponseSchema.parse(await res.json());
    expect(body).toMatchObject({
      caller: 'assistant',
      operation: 'answer',
      outcome: 'answered',
      workspaceId: 'ws_demo',
    });
    expect(body.answer).toContain('Release cadence is weekly');
    expect(body.citations).toEqual([
      expect.objectContaining({
        kind: 'project-context',
        title: 'Release plan',
      }),
    ]);

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
    const app = createApp({ store: createDemoStore() });
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

  it('prepares source-traceable context material without assembling a prompt', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-context-package-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const runtimeConfigManager = createRuntimeConfigManager({
      dataRoot,
      initialSnapshot: createInMemoryRuntimeConfigSnapshot({
        dataRoot,
        workspaceConfigs: [
          {
            userId: 'user_local',
            workspaceId: 'ws_demo',
            path: join(
              dataRoot,
              'users',
              'user_local',
              'workspaces',
              'ws_demo',
              'config',
              'workspace.jsonc'
            ),
            config: {
              schemaVersion: 1,
              workspace: {
                roots: [
                  {
                    id: 'repo_docs',
                    kind: 'host-dir',
                    path: 'files/repo',
                    access: 'read-only',
                  },
                ],
              },
            },
          },
        ],
      }),
    });
    const app = createApp({ coreDb, dataRoot, runtimeConfigManager, store });
    const timestamp = '2026-07-07T00:00:00.000Z';
    const workspaceFilesRoot = join(
      dataRoot,
      'users',
      'user_local',
      'workspaces',
      'ws_demo',
      'files',
      'docs'
    );
    mkdirSync(workspaceFilesRoot, { recursive: true });
    writeFileSync(
      join(workspaceFilesRoot, 'release.md'),
      'Workspace release checklist says Friday review evidence must be attached.\n'
    );
    const workspaceRootFilesRoot = join(
      dataRoot,
      'users',
      'user_local',
      'workspaces',
      'ws_demo',
      'files',
      'repo',
      'docs'
    );
    mkdirSync(workspaceRootFilesRoot, { recursive: true });
    writeFileSync(
      join(workspaceRootFilesRoot, 'runtime.md'),
      'Runtime root release note says the worker sees repository docs.\n'
    );
    const artifact = store.createArtifact({
      id: 'artifact_release_log',
      workspaceId: 'ws_demo',
      threadId: null,
      turnId: null,
      kind: 'summary',
      title: 'Release log',
      status: 'ready',
      summary: 'Release evidence.',
      version: 1,
      content: {
        format: 'json',
        body: '{"evidence":"Friday review complete"}',
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const sourceContent =
      'Authoritative release source says Friday review is required. Token ghp_context_secret must stay private.';
    const sourceRes = await app.request('/api/app/workspaces/ws_demo/knowledge/sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: '00000000-0000-4000-8000-000000000105',
        kind: 'document',
        title: 'Release source',
        uri: 'file://release-source.md',
        content: sourceContent,
      }),
    });
    expect(sourceRes.status).toBe(201);
    const registeredSource = RegisterKnowledgeSourceResponseSchema.parse(await sourceRes.json());
    const source = registeredSource.source;
    const sourceRepresentation = registeredSource.derivedRepresentations[0];

    const createRes = await app.request('/api/workspaces/ws_demo/knowledge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId,
        kind: 'project-context',
        title: 'Release plan',
        content: 'Release cadence is weekly with a Friday review.',
        sourceReferences: [`source:${source.id}`, 'source:ks_missing_context'],
      }),
    });
    expect(createRes.status).toBe(201);
    const knowledge = (await createRes.json()) as { id: string };

    const claimRes = await app.request('/api/app/workspaces/ws_demo/knowledge/claims', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: '00000000-0000-4000-8000-000000000106',
        statement: 'Release cadence is weekly.',
        sourceReferences: [`knowledge:${knowledge.id}`],
        producer: 'knowledge-manager',
        confidence: 0.82,
        reviewState: 'accepted',
      }),
    });
    expect(claimRes.status).toBe(201);
    const claim = RecordKnowledgeClaimResponseSchema.parse(await claimRes.json()).claim;

    const conflictRes = await app.request('/api/app/workspaces/ws_demo/knowledge/conflicts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: '00000000-0000-4000-8000-000000000107',
        subjectReferences: [`knowledge:${knowledge.id}`, `claim:${claim.id}`],
        sourceReferences: ['source:ks_release'],
        summary: 'Release cadence has contradictory source evidence.',
        suggestedActions: ['Ask the user which source is authoritative.'],
        producer: 'knowledge-manager',
      }),
    });
    expect(conflictRes.status).toBe(201);
    const conflict = RecordKnowledgeConflictResponseSchema.parse(await conflictRes.json()).conflict;

    const res = await app.request('/api/app/workspaces/ws_demo/knowledge/manager/context', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        artifactIds: [artifact.id],
        query: 'release cadence',
        workspaceFiles: [{ path: 'docs/release.md' }],
        workspaceRootFiles: [{ rootId: 'repo_docs', path: 'docs/runtime.md' }],
      }),
    });
    if (res.status !== 200) {
      throw new Error(await res.text());
    }

    const body = KnowledgeManagerPrepareContextResponseSchema.parse(await res.json());
    expect(body).toMatchObject({
      caller: 'workflow-coordinator',
      operation: 'prepare-context-material',
      outcome: 'prepared',
      workspaceId: 'ws_demo',
    });
    expect(body.materials).toEqual([
      expect.objectContaining({
        kind: 'project-context',
        title: 'Release plan',
        trace: { reason: 'matched-query', source: 'workspace-knowledge' },
      }),
    ]);
    expect(body.claims).toEqual([
      expect.objectContaining({
        id: claim.id,
        statement: 'Release cadence is weekly.',
        reviewState: 'accepted',
      }),
    ]);
    expect(body.artifacts).toEqual([
      expect.objectContaining({
        id: artifact.id,
        content: {
          format: 'json',
          body: '{"evidence":"Friday review complete"}',
        },
      }),
    ]);
    expect(body.workspaceFiles).toEqual([
      {
        path: 'docs/release.md',
        contentBytes: expect.any(Number),
        contentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
    ]);
    expect(body.workspaceRootFiles).toEqual([
      {
        rootId: 'repo_docs',
        path: 'docs/runtime.md',
        contentBytes: expect.any(Number),
        contentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
    ]);
    expect(body.conflicts).toEqual([
      expect.objectContaining({
        id: conflict.id,
        status: 'conflicting',
        summary: 'Release cadence has contradictory source evidence.',
      }),
    ]);
    expect(body.policy).toEqual({
      version: 'knowledge-context-v1',
      claimReviewState: 'accepted',
      conflictResolution: 'exclude-resolved',
    });
    expect(body.packageTrace).toMatchObject({
      contextPackageId: expect.stringMatching(/^ctxpkg_km_context_/),
      contextPackageDigest: expect.stringMatching(/^ctxpkg_sha256_[a-f0-9]{64}$/),
      policyVersion: 'knowledge-context-v1',
      selectedKnowledgeEntryIds: [expect.any(String)],
      selectedArtifactIds: [artifact.id],
      selectedWorkspaceFilePaths: ['docs/release.md'],
      selectedWorkspaceRootFiles: [{ rootId: 'repo_docs', path: 'docs/runtime.md' }],
      selectedClaimIds: [claim.id],
      selectedConflictIds: [conflict.id],
      excludedCandidateCount: 0,
      budget: {
        requestedLimit: 5,
        selectedCount: 1,
        excludedCount: 0,
      },
    });
    expect(createKnowledgeContextPackageDigest(body)).toBe(body.packageTrace.contextPackageDigest);

    const repeatRes = await app.request('/api/app/workspaces/ws_demo/knowledge/manager/context', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        artifactIds: [artifact.id],
        query: 'release cadence',
        workspaceFiles: [{ path: 'docs/release.md' }],
        workspaceRootFiles: [{ rootId: 'repo_docs', path: 'docs/runtime.md' }],
      }),
    });
    expect(repeatRes.status).toBe(200);

    const repeatBody = KnowledgeManagerPrepareContextResponseSchema.parse(await repeatRes.json());
    expect(repeatBody.operationId).not.toBe(body.operationId);
    expect(repeatBody.packageTrace.contextPackageDigest).toBe(
      body.packageTrace.contextPackageDigest
    );

    const month = new Date().toISOString().slice(0, 7).replace('-', '');
    const tracePath = join(
      dataRoot,
      'users',
      'user_local',
      'workspaces',
      'ws_demo',
      'knowledge',
      'context-packages',
      `${month}.jsonl`
    );
    const traces = readFileSync(tracePath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(traces).toEqual([
      expect.objectContaining({
        id: body.packageTrace.contextPackageId,
        operationId: body.operationId,
        workspaceId: 'ws_demo',
        response: expect.objectContaining({
          materials: body.materials,
          artifacts: body.artifacts,
          claims: body.claims,
          conflicts: body.conflicts,
          packageTrace: body.packageTrace,
        }),
      }),
      expect.objectContaining({
        id: repeatBody.packageTrace.contextPackageId,
        operationId: repeatBody.operationId,
        workspaceId: 'ws_demo',
        response: expect.objectContaining({
          packageTrace: repeatBody.packageTrace,
        }),
      }),
    ]);
    expect(traces[0].response.packageTrace.contextPackageDigest).toBe(
      traces[1].response.packageTrace.contextPackageDigest
    );
    expect(JSON.stringify(traces)).not.toContain('prompt');

    const usageRes = await app.request('/api/app/workspaces/ws_demo/capability-usage');
    expect(usageRes.status, await usageRes.clone().text()).toBe(200);
    const usage = CapabilityUsageResponseSchema.parse(await usageRes.json());
    const contextCalls = usage.capabilityCalls.filter(
      (call) => call.capabilityId === 'knowledge.context.prepare'
    );
    expect(contextCalls).toEqual([
      expect.objectContaining({
        capabilityId: 'knowledge.context.prepare',
        family: 'knowledge',
        operation: 'knowledge.context.prepare',
        providerRef: 'nanocore-knowledge',
        serviceRef: 'knowledge-manager',
        status: 'succeeded',
        workspaceId: 'ws_demo',
      }),
      expect.objectContaining({
        capabilityId: 'knowledge.context.prepare',
        family: 'knowledge',
        operation: 'knowledge.context.prepare',
        providerRef: 'nanocore-knowledge',
        serviceRef: 'knowledge-manager',
        status: 'succeeded',
        workspaceId: 'ws_demo',
      }),
    ]);
    const contextUsage = usage.usageRecords.filter(
      (record) => record.source === 'knowledge-context-prepare'
    );
    expect(contextUsage).toEqual([
      expect.objectContaining({
        category: 'tool',
        providerRef: 'nanocore-knowledge',
        quantity: 1,
        source: 'knowledge-context-prepare',
        unit: 'capability_calls',
        workspaceId: 'ws_demo',
      }),
      expect.objectContaining({
        category: 'tool',
        providerRef: 'nanocore-knowledge',
        quantity: 1,
        source: 'knowledge-context-prepare',
        unit: 'capability_calls',
        workspaceId: 'ws_demo',
      }),
    ]);

    const readTrace = await app.request(
      `/api/app/workspaces/ws_demo/knowledge/manager/context/${body.packageTrace.contextPackageId}`
    );
    expect(readTrace.status).toBe(200);
    await expect(readTrace.json()).resolves.toMatchObject({
      trace: {
        id: body.packageTrace.contextPackageId,
        operationId: body.operationId,
        response: {
          packageTrace: body.packageTrace,
        },
      },
    });

    const materialize = await app.request(
      `/api/app/workspaces/ws_demo/knowledge/manager/context/${body.packageTrace.contextPackageId}/materialization`,
      { method: 'POST' }
    );
    expect(materialize.status).toBe(200);
    const materialized = MaterializeKnowledgeContextPackageResponseSchema.parse(
      await materialize.json()
    );
    expect(materialized.manifest).toMatchObject({
      contextPackageId: body.packageTrace.contextPackageId,
      contextPackageDigest: body.packageTrace.contextPackageDigest,
      rootPath: '/openkit/context',
      workspaceId: 'ws_demo',
    });
    expect(materialized.manifest.budget).toMatchObject({
      entryCount: expect.any(Number),
      estimatedTokenCount: expect.any(Number),
      fileCount: expect.any(Number),
      materializedContentBytes: expect.any(Number),
    });
    expect(materialized.manifest.budget.entryCount).toBe(materialized.manifest.entries.length);
    expect(materialized.manifest.budget.fileCount).toBe(materialized.files.length);
    expect(materialized.manifest.budget.estimatedTokenCount).toBe(
      Math.ceil(materialized.manifest.budget.materializedContentBytes / 4)
    );
    expect(materialized.manifest.budget.materializedContentBytes).toBeGreaterThan(0);
    expect(materialized.manifest.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'knowledge',
          path: `/openkit/context/knowledge/${knowledge.id}.md`,
          sensitivityLabel: 'normal',
        }),
        expect.objectContaining({
          kind: 'artifact',
          path: `/openkit/context/artifacts/${artifact.id}.json`,
          sensitivityLabel: 'normal',
        }),
        expect.objectContaining({
          kind: 'workspace',
          path: '/openkit/context/workspace/docs/release.md',
          sensitivityLabel: 'normal',
          sourceReferences: ['workspace:docs/release.md'],
          title: 'docs/release.md',
        }),
        expect.objectContaining({
          kind: 'workspace-root',
          path: '/openkit/context/workspace-roots/repo_docs/docs/runtime.md',
          sensitivityLabel: 'normal',
          sourceReferences: ['workspace-root:repo_docs:docs/runtime.md'],
          title: 'repo_docs:docs/runtime.md',
        }),
        expect.objectContaining({
          citationLabel: `Source ${source.id}`,
          derivedRepresentationId: sourceRepresentation.id,
          kind: 'source',
          path: `/openkit/context/sources/${source.id}.txt`,
          sensitivityLabel: 'redacted',
          sourceContentDigest: source.contentDigest,
          sourceId: source.id,
          sourceKind: 'document',
          sourceUri: 'file://release-source.md',
        }),
      ])
    );
    expect(materialized.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'manifest',
          path: '/openkit/context/package.json',
        }),
        expect.objectContaining({
          kind: 'knowledge',
          path: `/openkit/context/knowledge/${knowledge.id}.md`,
        }),
        expect.objectContaining({
          kind: 'source',
          path: `/openkit/context/sources/${source.id}.txt`,
        }),
        expect.objectContaining({
          kind: 'artifact',
          path: `/openkit/context/artifacts/${artifact.id}.json`,
        }),
        expect.objectContaining({
          kind: 'workspace',
          path: '/openkit/context/workspace/docs/release.md',
        }),
        expect.objectContaining({
          kind: 'workspace-root',
          path: '/openkit/context/workspace-roots/repo_docs/docs/runtime.md',
        }),
        expect.objectContaining({
          kind: 'policy',
          path: '/openkit/context/policy.json',
        }),
      ])
    );

    const materializedRoot = join(
      dataRoot,
      'users',
      'user_local',
      'workspaces',
      'ws_demo',
      'knowledge',
      'context-materializations',
      body.packageTrace.contextPackageId,
      'openkit',
      'context'
    );
    expect(readFileSync(join(materializedRoot, 'package.json'), 'utf8')).toContain(
      '"rootPath": "/openkit/context"'
    );
    expect(readFileSync(join(materializedRoot, 'package.json'), 'utf8')).toContain(
      '"relativePath": "knowledge/'
    );
    expect(readFileSync(join(materializedRoot, 'package.json'), 'utf8')).toContain(
      '"materializedContentBytes"'
    );
    expect(
      readFileSync(join(materializedRoot, 'knowledge', `${knowledge.id}.md`), 'utf8')
    ).toContain('Release cadence is weekly with a Friday review.');
    expect(readFileSync(join(materializedRoot, 'artifacts', `${artifact.id}.json`), 'utf8')).toBe(
      '{"evidence":"Friday review complete"}\n'
    );
    expect(readFileSync(join(materializedRoot, 'workspace', 'docs', 'release.md'), 'utf8')).toBe(
      'Workspace release checklist says Friday review evidence must be attached.\n'
    );
    expect(
      readFileSync(
        join(materializedRoot, 'workspace-roots', 'repo_docs', 'docs', 'runtime.md'),
        'utf8'
      )
    ).toBe('Runtime root release note says the worker sees repository docs.\n');
    const sourceMaterial = readFileSync(
      join(materializedRoot, 'sources', `${source.id}.txt`),
      'utf8'
    );
    expect(sourceMaterial).toContain(
      'Authoritative release source says Friday review is required.'
    );
    expect(sourceMaterial).toContain('[redacted]');
    expect(sourceMaterial).not.toContain('ghp_context_secret');
    expect(readFileSync(join(materializedRoot, 'policy.json'), 'utf8')).toContain(
      '"reason": "sensitive_content"'
    );
    expect(readFileSync(join(materializedRoot, 'policy.json'), 'utf8')).toContain(
      '"reason": "source_unavailable"'
    );
    expect(JSON.stringify(materialized)).not.toContain(dataRoot);

    const readMaterialization = await app.request(
      `/api/app/workspaces/ws_demo/knowledge/manager/context/${body.packageTrace.contextPackageId}/materialization`
    );
    expect(readMaterialization.status).toBe(200);
    const readMaterialized = MaterializeKnowledgeContextPackageResponseSchema.parse(
      await readMaterialization.json()
    );
    expect(readMaterialized).toEqual(materialized);
    const manifestPath = join(materializedRoot, 'package.json');
    const tamperedManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    tamperedManifest.entries[0].relativePath = '../escaped.md';
    writeFileSync(manifestPath, `${JSON.stringify(tamperedManifest, null, 2)}\n`);
    const tamperedRead = await app.request(
      `/api/app/workspaces/ws_demo/knowledge/manager/context/${body.packageTrace.contextPackageId}/materialization`
    );
    expect(tamperedRead.status).toBe(500);
    await expect(tamperedRead.json()).resolves.toMatchObject({
      code: 'knowledge_context_package_materialization_read_failed',
    });

    const missingTrace = await app.request(
      '/api/app/workspaces/ws_demo/knowledge/manager/context/ctxpkg_missing'
    );
    expect(missingTrace.status).toBe(404);
    expect(JSON.stringify(body)).not.toContain('prompt');

    coreDb.sqlite.close();
  });

  it('drafts a pending proposal for explicit human review', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-proposal-usage-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const app = createApp({ coreDb, dataRoot, store });
    const workspace = { id: 'ws_demo' };
    const knowledgeRes = await app.request(`/api/workspaces/${workspace.id}/knowledge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: '00000000-0000-4000-8000-000000000224',
        kind: 'project-context',
        title: 'Reviewed release plan',
        content: 'Friday release reviews are already captured in workspace knowledge.',
      }),
    });
    expect(knowledgeRes.status).toBe(201);
    const knowledge = (await knowledgeRes.json()) as { id: string };

    const res = await app.request(
      `/api/app/workspaces/${workspace.id}/knowledge/manager/proposals`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: '00000000-0000-4000-8000-000000000223',
          title: 'Release cadence',
          summary: 'Record that releases are reviewed every Friday.',
          sourceReferences: [`knowledge:${knowledge.id}`, 'artifact:release-plan'],
          confidence: 0.7,
        }),
      }
    );
    expect(res.status).toBe(200);

    const body = KnowledgeManagerDraftProposalResponseSchema.parse(await res.json());
    expect(body).toMatchObject({
      operation: 'draft-proposal',
      proposal: {
        status: 'pending',
        summary: 'Record that releases are reviewed every Friday.',
        title: 'Release cadence',
        workspaceId: workspace.id,
      },
      sourceReferences: [`knowledge:${knowledge.id}`, 'artifact:release-plan'],
      sourceLineage: [
        {
          reference: `knowledge:${knowledge.id}`,
          classification: 'workspace-knowledge',
          knowledgeEntryId: knowledge.id,
          sourceId: null,
          title: 'Reviewed release plan',
          reviewRequired: false,
          detail: 'Reference resolves to an existing workspace knowledge entry.',
        },
        {
          reference: 'artifact:release-plan',
          classification: 'external-reference',
          knowledgeEntryId: null,
          sourceId: null,
          title: null,
          reviewRequired: true,
          detail: 'Reference is not registered as a workspace knowledge source or knowledge entry.',
        },
      ],
      validation: {
        status: 'needs-source-review',
        checks: [
          {
            code: 'source-reference-resolved',
            passed: true,
            detail: 'Reference resolves to an existing workspace knowledge entry.',
          },
          {
            code: 'source-reference-unregistered',
            passed: false,
            detail:
              'Reference is not registered as a workspace knowledge source or knowledge entry.',
          },
        ],
      },
      confidence: 0.7,
    });

    const actionCenterRes = await app.request(`/api/app/workspaces/${workspace.id}/action-center`);
    expect(actionCenterRes.status).toBe(200);
    const actionCenter = (await actionCenterRes.json()) as { items: Array<{ id: string }> };
    expect(actionCenter.items).toEqual([
      expect.objectContaining({ id: `knowledge:${body.proposal.id}` }),
    ]);

    const usageRes = await app.request(`/api/app/workspaces/${workspace.id}/capability-usage`);
    expect(usageRes.status, await usageRes.clone().text()).toBe(200);
    const usage = CapabilityUsageResponseSchema.parse(await usageRes.json());
    expect(
      usage.capabilityCalls.filter((call) => call.capabilityId === 'knowledge.proposal.draft')
    ).toEqual([
      expect.objectContaining({
        capabilityId: 'knowledge.proposal.draft',
        family: 'knowledge',
        operation: 'knowledge.proposal.draft',
        providerRef: 'nanocore-knowledge',
        serviceRef: 'knowledge-manager',
        status: 'succeeded',
        workspaceId: workspace.id,
      }),
    ]);
    expect(
      usage.usageRecords.filter((record) => record.source === 'knowledge-proposal-draft')
    ).toEqual([
      expect.objectContaining({
        category: 'tool',
        providerRef: 'nanocore-knowledge',
        quantity: 1,
        source: 'knowledge-proposal-draft',
        unit: 'capability_calls',
        workspaceId: workspace.id,
      }),
    ]);

    coreDb.sqlite.close();
  });

  it('suggests review-required repairs without applying changes', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-repair-usage-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
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
      caller: 'system',
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
      caller: 'system',
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
});

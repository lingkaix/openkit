import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as schemas from '@openkit/app-api-schemas';
import { describe, expect, it, vi } from 'vitest';
import { createCoreClient } from '../../../packages/core-client/src/index.js';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { KnowledgeNotebook } from './knowledge/notebook.js';
import { createTaskKnowledgePreparation } from './knowledge-operations.js';
import { createOperationInvocation } from './operation-composition.js';
import { closeRetrievalServices } from './retrieval-service.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import * as retrieval from './storage/index-rebuild.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { testEntityId } from './test-support/entity-ids.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

/** One real isolated Knowledge authority, with explicit membership rather than changed fixture defaults. */
function fixture(member = true) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-operations-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = createDemoStore({ dataRoot });
  if (!member)
    coreDb.sqlite
      .prepare(
        "INSERT INTO users (id, kind, display_name, email, email_verified, created_at, updated_at, last_seen_at) SELECT 'usr_00000000-0000-7ed5-9b62-226e0a66887f', 'human', display_name, 'foreign@local.openkit.invalid', email_verified, created_at, updated_at, last_seen_at FROM users WHERE id = 'usr_00000000-0000-7000-8000-000000000001'"
      )
      .run();
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: member
      ? 'usr_00000000-0000-7000-8000-000000000001'
      : 'usr_00000000-0000-7ed5-9b62-226e0a66887f',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  });
  const app = createApp({ coreDb, dataRoot, store });
  const dependencies = {
    coreDb,
    store,
    inflightCommands: new WeakMap(),
    workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    repositoryWorkspaceDb: (workspaceId: string) => {
      const db = openWorkspaceDb(dataRoot, workspaceId);
      applyScopedMigrations(db);
      return db;
    },
  };
  return {
    app,
    coreDb,
    store,
    dependencies,
    dataRoot,
    close: async () => {
      await closeRetrievalServices();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

/** Test-owned exact immutable base; all mutations still cross current native admission. */
function notebook(f: ReturnType<typeof fixture>) {
  return new KnowledgeNotebook({
    repositoryPath: join(
      f.dataRoot,
      'workspaces/ws_00000000-0000-7000-8000-000000000001/knowledge/notebook.git'
    ),
  });
}

/** Accepted public inventory; the same definitions must drive each concrete projection. */
const governedIds = [
  'knowledge.answer',
  'knowledge.source.list',
  'knowledge.source.register',
  'knowledge.source.read',
  'knowledge.observation.list',
  'knowledge.observation.record',
  'knowledge.claim.list',
  'knowledge.claim.record',
  'knowledge.conflict.list',
  'knowledge.conflict.record',
  'knowledge.conflict.resolve',
  'knowledge.indexes',
  'knowledge.retrieval',
  'knowledge.context.prepare',
  'knowledge.proposal.draft',
  'knowledge.repair.suggest',
  'knowledge.health.check',
  'knowledge.proposal.decide',
  'knowledge.proposal.reverse',
] as const;
const entryIds = [
  'knowledge.notebook.history',
  'knowledge.notebook.diff',
  'knowledge.notebook.restore',
  'knowledge.notebook.update',
  'knowledge.list',
  'knowledge.create',
  'knowledge.update',
  'knowledge.delete',
] as const;
const acceptedIds = [...governedIds, ...entryIds].sort();

/** Executes the three real public projections without an HTTP stand-in. */
async function projections(f: ReturnType<typeof fixture>, token?: string) {
  const headers = {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const app = token
    ? createApp({ mode: 'server', coreDb: f.coreDb, dataRoot: f.dataRoot, store: f.store })
    : f.app;
  const client = createCoreClient({
    baseUrl: 'http://127.0.0.1',
    headers,
    fetch: (input, init) => app.fetch(new Request(input, init)),
  });
  const { operationCatalog } = await import(
    new URL('../../../skills/openkit-operations.mjs', import.meta.url).href
  );
  return {
    http: async (id: string, args: Record<string, unknown>): Promise<unknown> => {
      const { requestId, ...body } = args;
      const response = await app.request(`/api/app/operations/${id}`, {
        method: 'POST',
        headers: {
          ...headers,
          ...(requestId ? { 'x-openkit-request-id': String(requestId) } : {}),
        },
        body: JSON.stringify(body),
      });
      expect(response.headers.get('content-type'), id).toContain('application/json');
      const result = await response.json();
      if (!response.ok) throw result;
      return result;
    },
    client: (id: string, args: Record<string, unknown>) =>
      (client.operations as unknown as Record<string, (input: unknown) => Promise<unknown>>)[id]!(
        args
      ),
    cli: (id: string, args: Record<string, unknown>) => {
      const entry = operationCatalog.find((operation: { id: string }) => operation.id === id);
      expect(entry, id).toBeDefined();
      return entry.handler({ client }, entry.inputSchema.parse(args));
    },
  };
}

/** Exact candidate bytes derive from the existing proposal owner's schema, with registered source lineage. */
function proposalInput(source: { id: string; contentDigest: string }, baseRevision: string) {
  const sourceReferences = [`source:${source.id}@${source.contentDigest}`];
  const canonicalPageBytes = [
    '---',
    'type: "KnowledgePage"',
    'title: "Cutover lesson"',
    'schema_version: "openkit-scope-knowledge-schema-v4"',
    'openkit_status: "active"',
    'status: "stable"',
    'scope: {kind: workspace, workspaceId: ws_00000000-0000-7000-8000-000000000001}',
    'requiredFeatures: [openkit.knowledge-owner-scope.v1, openkit.knowledge-git-notebook.v1]',
    'openkit_entry_id: "cutover-lesson"',
    'openkit_entry_kind: "project-context"',
    `source_refs: ${JSON.stringify(sourceReferences)}`,
    'review_state: "accepted"',
    'sensitivity: "normal"',
    'freshness: "current"',
    'created_at: "2026-10-03T00:00:00.000Z"',
    'updated_at: "2026-10-03T00:00:00.000Z"',
    '---',
    'Source traced cutover lesson.',
    '',
  ].join('\n');
  return {
    requestId: randomUUID(),
    baseRevision,
    knowledgePageId: 'cutover-lesson',
    canonicalPageBytes,
    contentDigest: `sha256:${createHash('sha256').update(canonicalPageBytes).digest('hex')}`,
    sourceReferences,
    rationale: 'Retain the source traced lesson.',
    confidence: 0.8,
  };
}

/** Removes only request-scoped observation identities and times; authoritative mutation rows stay exact. */
function observationView(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(observationView);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) => !['operationId', 'traceId', 'retrievalTraceId', 'rebuiltAt'].includes(key)
        )
        .map(([key, item]) => [
          key,
          key === 'createdAt' && ('traceId' in value || 'requestDigest' in value)
            ? '<trace-time>'
            : observationView(item),
        ])
    );
  return value;
}

const oldRoutes = [
  ['GET', '/api/workspaces/ws_00000000-0000-7000-8000-000000000001/knowledge'],
  ['POST', '/api/workspaces/ws_00000000-0000-7000-8000-000000000001/knowledge'],
  ['PATCH', '/api/workspaces/ws_00000000-0000-7000-8000-000000000001/knowledge/entry'],
  ['DELETE', '/api/workspaces/ws_00000000-0000-7000-8000-000000000001/knowledge/entry'],
  ['POST', '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/knowledge/manager/answer'],
  ['GET', '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/knowledge/sources'],
  ['POST', '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/knowledge/sources'],
  ['GET', '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/knowledge/sources/source'],
  ['GET', '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/knowledge/observations'],
  ['POST', '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/knowledge/observations'],
  ['GET', '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/knowledge/claims'],
  ['POST', '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/knowledge/claims'],
  ['GET', '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/knowledge/conflicts'],
  ['POST', '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/knowledge/conflicts'],
  [
    'POST',
    '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/knowledge/conflicts/conflict/resolution',
  ],
  ['GET', '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/knowledge/indexes'],
  ['POST', '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/knowledge/retrievals'],
  ['POST', '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/knowledge/manager/context'],
  [
    'POST',
    '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/knowledge/manager/proposals',
  ],
  ['POST', '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/knowledge/manager/repairs'],
  ['POST', '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/knowledge/manager/health'],
  [
    'POST',
    '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/knowledge/proposals/proposal/decision',
  ],
  [
    'POST',
    '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/knowledge/proposals/proposal/reversal',
  ],
] as const;

describe('Knowledge operation definition cutover', () => {
  it('declares the accepted governed and Notebook operation inventory without handwritten projection catalogs', () => {
    const tables = schemas as unknown as Record<string, Record<string, unknown>>;
    expect(Object.keys(tables.KNOWLEDGE_OPERATION_DEFINITIONS ?? {}).sort()).toEqual(
      [...governedIds].sort()
    );
    expect(Object.keys(tables.KNOWLEDGE_ENTRY_OPERATION_DEFINITIONS ?? {}).sort()).toEqual(
      [...entryIds].sort()
    );
    const ids = [
      ...Object.keys(tables.KNOWLEDGE_OPERATION_DEFINITIONS!),
      ...Object.keys(tables.KNOWLEDGE_ENTRY_OPERATION_DEFINITIONS!),
    ];
    const root = new URL('../../../', import.meta.url);
    for (const path of [
      'skills/openkit-operations.mjs',
      'apps/nanocore/src/openapi.ts',
      'apps/nanocore/src/auth/operation-access.ts',
    ]) {
      const source = readFileSync(new URL(path, root), 'utf8');
      for (const id of ids)
        expect(source, `${path}: ${id}`).not.toMatch(
          new RegExp(`['"\x60]${id.replaceAll('.', '\\.')}['"\x60]`)
        );
    }
  });

  it.each(oldRoutes)('removes %s %s with HTTP 404', async (method, path) => {
    const f = fixture();
    try {
      expect(
        (
          await f.app.request(path, {
            method,
            headers: { 'content-type': 'application/json' },
            ...(method === 'GET' ? {} : { body: '{}' }),
          })
        ).status
      ).toBe(404);
    } finally {
      await f.close();
    }
  });

  it.each([
    'Workspace member',
    'eligible administrator',
  ])('preserves authorized Knowledge parity across HTTP client and CLI for %s, with exact command replay and normalized observations for retrieval, preparation and answer', async (authority) => {
    const f = fixture(authority === 'Workspace member');
    try {
      const token =
        authority === 'eligible administrator'
          ? createOpenKitAccessTokenRecord(f.coreDb, {
              ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
              scope: 'server-admin',
              workspaceIds: [],
              expiresAt: '2099-01-01T00:00:00.000Z',
            }).secret
          : undefined;
      const projectors = await projections(f, token);
      const selector = { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' };
      const compared = new Set<string>();
      async function compare<K extends schemas.ProductOperationId>(
        id: K,
        input: Record<string, unknown>
      ): Promise<schemas.OperationOutput<K>> {
        let expected: unknown;
        let first: unknown;
        for (const project of Object.values(projectors)) {
          const result = await project(id, { ...selector, ...input });
          first ??= result;
          const view = observationView(result);
          if (expected === undefined) expected = view;
          expect(view, id).toEqual(expected);
        }
        compared.add(id);
        return first as schemas.OperationOutput<K>;
      }
      const source = await compare('knowledge.source.register', {
        requestId: randomUUID(),
        kind: 'document',
        title: 'Cutover source',
        content: 'Source traced cutover lesson.',
      });
      await compare('knowledge.source.list', {});
      await compare('knowledge.source.read', { sourceId: source.source.id });
      await compare('knowledge.observation.record', {
        requestId: randomUUID(),
        kind: 'maintenance',
        summary: 'Inspect knowledge',
        producer: 'usr_00000000-0000-7000-8000-000000000001',
      });
      await compare('knowledge.observation.list', {});
      await compare('knowledge.claim.record', {
        requestId: randomUUID(),
        statement: 'Source traced lesson',
        producer: 'usr_00000000-0000-7000-8000-000000000001',
      });
      await compare('knowledge.claim.list', {});
      const conflict = await compare('knowledge.conflict.record', {
        requestId: randomUUID(),
        subjectReferences: ['knowledge:cutover-lesson'],
        summary: 'Competing lesson',
        producer: 'usr_00000000-0000-7000-8000-000000000001',
      });
      await compare('knowledge.conflict.list', {});
      await compare('knowledge.conflict.resolve', {
        requestId: randomUUID(),
        conflictId: conflict.conflict.id,
        resolution: 'Resolved after inspection',
        resolvedBy: 'usr_00000000-0000-7000-8000-000000000001',
      });
      const draft = await compare(
        'knowledge.proposal.draft',
        proposalInput(source.source, notebook(f).publishedRevision())
      );
      const decision = await compare('knowledge.proposal.decide', {
        requestId: randomUUID(),
        proposalId: draft.proposal.id,
        decision: 'accepted',
        proposalDigest: f.store.knowledgeProposalDigest(
          'ws_00000000-0000-7000-8000-000000000001',
          draft.proposal.id
        ),
        baseRevision: draft.proposal.baseRevision,
        candidateRevision: draft.proposal.candidateRevision,
      });
      const reviewed = await compare('knowledge.list', {});
      expect(reviewed.items.find(({ id }) => id === 'cutover-lesson')?.content).toContain(
        'Source traced'
      );
      await compare('knowledge.indexes', {});
      await compare('knowledge.retrieval', { query: 'cutover lesson' });
      await compare('knowledge.context.prepare', { query: 'cutover lesson' });
      await compare('knowledge.answer', { query: 'cutover lesson' });
      await compare('knowledge.repair.suggest', {});
      await compare('knowledge.health.check', {});
      await compare('knowledge.proposal.reverse', {
        requestId: randomUUID(),
        proposalId: draft.proposal.id,
        reviewId: decision.review.reviewId,
        knowledgePageId: 'cutover-lesson',
        expectedContentDigest: draft.proposal.contentDigest,
        baseRevision: notebook(f).publishedRevision(),
        confirmRemoval: true,
      });
      const entry = await compare('knowledge.create', {
        requestId: randomUUID(),
        knowledgePageId: 'entry-cutover',
        baseRevision: notebook(f).publishedRevision(),
        kind: 'project-context',
        title: 'Entry cutover',
        content: 'Retained entry lesson',
        sourceReferences: [],
      });
      await compare('knowledge.update', {
        requestId: randomUUID(),
        baseRevision: notebook(f).publishedRevision(),
        knowledgeEntryId: entry.id,
        title: 'Updated entry cutover',
      });
      const fromRevision = notebook(f).publishedRevision();
      const path = `${entry.id}.md`;
      const bytes = notebook(f).readRevision(fromRevision, [path]).files[path]!;
      await compare('knowledge.notebook.update', {
        requestId: randomUUID(),
        baseRevision: fromRevision,
        changes: [
          { path, content: bytes.replace('Retained entry lesson', 'Notebook edit lesson') },
        ],
        summary: 'Notebook projection edit',
      });
      await compare('knowledge.notebook.history', { limit: 2 });
      const baseRevision = notebook(f).publishedRevision();
      await compare('knowledge.notebook.diff', { baseRevision, fromRevision, pageIds: [entry.id] });
      await compare('knowledge.notebook.restore', {
        requestId: randomUUID(),
        baseRevision,
        fromRevision,
        pageIds: [entry.id],
        summary: 'Restore entry projection',
      });
      const beforeRemoval = await compare('knowledge.list', {});
      await compare('knowledge.delete', {
        requestId: randomUUID(),
        knowledgeEntryId: entry.id,
        baseRevision: beforeRemoval.notebookRevision,
        expectedContentDigest: beforeRemoval.items.find(({ id }) => id === entry.id)!.contentDigest,
        confirmRemoval: true,
      });
      expect([...compared].sort()).toEqual(acceptedIds);
    } finally {
      await f.close();
    }
  }, 120_000);

  it('keeps unauthorized Workspace refusal on every definition, scoped source denial and readonly refusal on every mutation before effects', async () => {
    const f = fixture();
    try {
      const issued = createOpenKitAccessTokenRecord(f.coreDb, {
        ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        scope: 'workspace-readonly',
        workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      const projectors = await projections(f, issued.secret);
      const requestId = randomUUID();
      const baseRevision = notebook(f).publishedRevision();
      const draft = proposalInput(
        {
          id: testEntityId('ks', randomUUID()),
          contentDigest: `sha256:${'a'.repeat(64)}`,
        },
        baseRevision
      );
      const inputs: Record<string, Record<string, unknown>> = {
        'knowledge.source.register': {
          requestId,
          kind: 'document',
          title: 'Denied source',
          content: 'Denied content',
        },
        'knowledge.source.list': {},
        'knowledge.source.read': { sourceId: 'ks_00000000-0000-7e65-a399-d53a84c98ecb' },
        'knowledge.observation.record': {
          requestId,
          kind: 'maintenance',
          summary: 'Denied observation',
          producer: 'usr_00000000-0000-7000-8000-000000000001',
        },
        'knowledge.observation.list': {},
        'knowledge.claim.record': {
          requestId,
          statement: 'Denied claim',
          producer: 'usr_00000000-0000-7000-8000-000000000001',
        },
        'knowledge.claim.list': {},
        'knowledge.conflict.record': {
          requestId,
          subjectReferences: ['knowledge:missing'],
          summary: 'Denied conflict',
          producer: 'usr_00000000-0000-7000-8000-000000000001',
        },
        'knowledge.conflict.list': {},
        'knowledge.conflict.resolve': {
          requestId,
          conflictId: 'kf_00000000-0000-720e-9482-c126a411b6fe',
          resolution: 'Denied resolution',
          resolvedBy: 'usr_00000000-0000-7000-8000-000000000001',
        },
        'knowledge.indexes': {},
        'knowledge.retrieval': { query: 'lesson' },
        'knowledge.context.prepare': { query: 'lesson' },
        'knowledge.answer': { query: 'lesson' },
        'knowledge.proposal.draft': draft,
        'knowledge.repair.suggest': {},
        'knowledge.health.check': {},
        'knowledge.proposal.decide': {
          requestId,
          proposalId: 'kp_missing',
          decision: 'accepted',
          baseRevision,
          candidateRevision: baseRevision,
          proposalDigest: `sha256:${'a'.repeat(64)}`,
        },
        'knowledge.proposal.reverse': {
          requestId,
          proposalId: 'kp_missing',
          reviewId: 'kr_00000000-0000-7a1a-ae9e-91913ba8228d',
          baseRevision,
          confirmRemoval: true,
          knowledgePageId: 'missing',
          expectedContentDigest: `sha256:${'a'.repeat(64)}`,
        },
        'knowledge.list': {},
        'knowledge.create': {
          requestId,
          baseRevision,
          knowledgePageId: 'denied-entry',
          kind: 'project-context',
          title: 'Denied entry',
          content: 'Denied content',
        },
        'knowledge.update': {
          requestId,
          baseRevision,
          knowledgeEntryId: 'missing',
          title: 'Denied update',
        },
        'knowledge.delete': {
          requestId,
          baseRevision,
          knowledgeEntryId: 'missing',
          expectedContentDigest: `sha256:${'a'.repeat(64)}`,
          confirmRemoval: true,
        },
        'knowledge.notebook.update': {
          requestId,
          baseRevision,
          changes: [{ path: 'cutover-lesson.md', content: draft.canonicalPageBytes }],
          summary: 'Denied notebook edit',
        },
        'knowledge.notebook.history': { revision: baseRevision, limit: 1 },
        'knowledge.notebook.diff': {
          baseRevision,
          fromRevision: baseRevision,
          pageIds: ['mem_project'],
        },
        'knowledge.notebook.restore': {
          requestId,
          baseRevision,
          fromRevision: baseRevision,
          pageIds: ['mem_project'],
          summary: 'Denied restore',
        },
      };
      const definitions = schemas.PRODUCT_OPERATION_DEFINITIONS as unknown as Record<
        string,
        { mutating: boolean }
      >;
      expect(Object.keys(inputs).sort()).toEqual(acceptedIds);
      for (const project of Object.values(projectors)) {
        for (const [id, input] of Object.entries(inputs)) {
          await expect(
            project(id, { ...input, workspaceId: 'ws_00000000-0000-7744-93d6-d2f551c62efa' })
          ).rejects.toMatchObject({
            code: 'workspace_access_denied',
          });
          expect(definitions[id], id).toBeDefined();
          if (definitions[id]!.mutating)
            await expect(
              project(id, { ...input, workspaceId: 'ws_00000000-0000-7000-8000-000000000001' })
            ).rejects.toMatchObject({
              code: 'workspace_access_denied',
            });
        }
        await expect(
          project('knowledge.source.read', {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            sourceId: 'ks_00000000-0000-7e65-a399-d53a84c98ecb',
          })
        ).rejects.toMatchObject({ code: 'workspace_access_denied' });
      }
      expect(f.store.listKnowledgeSources('ws_00000000-0000-7000-8000-000000000001')).toEqual([]);
      const traceRoot = join(
        f.dataRoot,
        'workspaces/ws_00000000-0000-7000-8000-000000000001/threads/th_00000000-0000-7000-8000-000000000001/retrieval-traces'
      );
      expect(existsSync(traceRoot) ? readdirSync(traceRoot) : []).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('rejects a Workspace-qualified pin before opening the administrator-selected Server source', async () => {
    const f = fixture();
    const administrator = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    try {
      await expect(
        createOperationInvocation(f.dependencies)(
          'knowledge.retrieval',
          {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            query: 'release cadence',
            sourceScope: 'server',
            pinnedReferences: [
              {
                scopeId: 'page/workspace/ws_00000000-0000-7000-8000-000000000001',
                objectId: 'release-plan',
              },
            ],
          },
          {
            kind: 'public',
            actor: {
              kind: 'token',
              userId: 'usr_00000000-0000-7000-8000-000000000001',
              tokenId: administrator.record.tokenId,
              tokenScope: 'server-admin',
              tokenWorkspaceIds: [],
            },
          }
        )
      ).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
    } finally {
      await f.close();
    }
  });

  it('preserves foreign Source refusal, pinned restricted-content exclusion and bounded preparation and answer for a member and an eligible administrator', async () => {
    const f = fixture();
    try {
      const member = await projections(f);
      const foreign = f.store.createWorkspace('Foreign source authority', {
        requestId: randomUUID(),
        producer: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        instructionReference: 'test-owned-fresh-workspace',
      });
      recordWorkspaceOwnerMembership({
        coreDb: f.coreDb,
        ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        workspaceId: foreign.id,
      });
      const registered = (await member.http('knowledge.source.register', {
        workspaceId: foreign.id,
        requestId: randomUUID(),
        kind: 'document',
        title: 'Foreign secret title',
        content: 'Foreign secret bytes',
      })) as schemas.OperationOutput<'knowledge.source.register'>;
      const entry = (await member.http('knowledge.create', {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        requestId: randomUUID(),
        baseRevision: notebook(f).publishedRevision(),
        knowledgePageId: 'restricted-audience-lesson',
        kind: 'project-context',
        title: 'Restricted audience lesson',
        content: 'audience budget baseline is forty two',
        sourceReferences: [],
      })) as schemas.OperationOutput<'knowledge.create'>;
      const baseRevision = notebook(f).publishedRevision();
      const path = `${entry.id}.md`;
      const bytes = notebook(f).readRevision(baseRevision, [path]).files[path]!;
      await member.http('knowledge.notebook.update', {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        requestId: randomUUID(),
        baseRevision,
        changes: [
          { path, content: bytes.replace(/sensitivity: .*\n/, 'sensitivity: "confidential"\n') },
        ],
        summary: 'Restrict selected fixture page',
      });
      const administrator = createOpenKitAccessTokenRecord(f.coreDb, {
        ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        scope: 'server-admin',
        workspaceIds: [],
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      for (const projectors of [member, await projections(f, administrator.secret)]) {
        let sourceFailure: unknown;
        for (const project of Object.values(projectors)) {
          try {
            await project('knowledge.source.read', {
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
              sourceId: registered.source.id,
            });
            throw new Error('Foreign Source unexpectedly exposed.');
          } catch (error) {
            expect(error).toMatchObject({
              code: 'workspace_access_denied',
              message: 'Knowledge source is unavailable.',
            });
            const view = {
              code: (error as { code: string }).code,
              message: (error as { message: string }).message,
            };
            sourceFailure ??= view;
            expect(view).toEqual(sourceFailure);
          }
          for (const id of [
            'knowledge.retrieval',
            'knowledge.context.prepare',
            'knowledge.answer',
          ]) {
            const result = await project(id, {
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
              query: 'audience budget baseline',
              ...(id === 'knowledge.retrieval'
                ? {
                    pinnedReferences: [
                      {
                        scopeId: 'page/workspace/ws_00000000-0000-7000-8000-000000000001',
                        objectId: entry.id,
                      },
                    ],
                  }
                : {}),
            });
            expect(JSON.stringify(result)).not.toContain(entry.title);
            expect(JSON.stringify(result)).not.toContain(entry.content);
            if (id === 'knowledge.answer')
              expect(result).toMatchObject({ outcome: 'insufficient-evidence', citations: [] });
            else if (id === 'knowledge.retrieval')
              expect(result).toMatchObject({
                selected: [],
                excluded: [
                  {
                    reference: {
                      scopeId: 'page/workspace/ws_00000000-0000-7000-8000-000000000001',
                      objectId: entry.id,
                    },
                    contentDigest: null,
                    reason: 'sensitive_content',
                  },
                ],
              });
            else expect(result).toMatchObject({ selected: [] });
          }
        }
      }
    } finally {
      await f.close();
    }
  }, 120_000);

  it('returns distinct public and trusted Task preparation views from exactly one governed retrieval each', async () => {
    const f = fixture();
    const retrieve = vi.spyOn(retrieval, 'retrieveWorkspaceKnowledge');
    try {
      const invoke = createOperationInvocation(f.dependencies);
      const input = { workspaceId: 'ws_00000000-0000-7000-8000-000000000001', query: 'lesson' };
      const publicResult = await invoke('knowledge.context.prepare', input, {
        kind: 'public',
        actor: { kind: 'local', userId: 'usr_00000000-0000-7000-8000-000000000001' },
      });
      expect(publicResult).toMatchObject({
        caller: 'app-api',
        operation: 'prepare-context-material',
        selected: [],
        excluded: [],
      });
      expect(publicResult).not.toHaveProperty('retrievalTraceRef');
      expect(publicResult).not.toHaveProperty('retrievalTraceId');
      expect(retrieve).toHaveBeenCalledTimes(1);
      const traceId = testEntityId('krt', randomUUID());
      const taskResult = await createTaskKnowledgePreparation(f.dependencies)(input, {
        actor: { kind: 'local', userId: 'usr_00000000-0000-7000-8000-000000000001' },
        traceId,
        threadId: 'th_00000000-0000-7000-8000-000000000001',
      });
      expect(taskResult).toEqual({
        retrievalTraceRef: {
          scopeId:
            'retrieval-trace/thread/ws_00000000-0000-7000-8000-000000000001/th_00000000-0000-7000-8000-000000000001',
          objectId: traceId,
        },
      });
      expect(retrieve).toHaveBeenCalledTimes(2);
      expect(retrieve.mock.calls.map(([request]) => request.caller)).toEqual([
        'app-api',
        'task-mode',
      ]);
      const traceRoot = join(
        f.dataRoot,
        'workspaces/ws_00000000-0000-7000-8000-000000000001/threads/th_00000000-0000-7000-8000-000000000001/retrieval-traces'
      );
      expect(readdirSync(traceRoot)).toEqual([`${traceId}.json`]);
      expect(JSON.parse(readFileSync(join(traceRoot, `${traceId}.json`), 'utf8'))).toEqual(
        expect.objectContaining({ traceId })
      );
      expect(
        existsSync(
          join(f.dataRoot, 'workspaces/ws_00000000-0000-7000-8000-000000000001/knowledge/traces')
        )
      ).toBe(false);
      await expect(
        invoke(
          'knowledge.context.prepare',
          { ...input, caller: 'task-mode' },
          {
            kind: 'public',
            actor: { kind: 'local', userId: 'usr_00000000-0000-7000-8000-000000000001' },
          }
        )
      ).rejects.toMatchObject({ code: 'invalid_request' });
      expect(retrieve).toHaveBeenCalledTimes(2);
      const readonly = createOpenKitAccessTokenRecord(f.coreDb, {
        ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        scope: 'workspace-readonly',
        workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      await expect(
        createTaskKnowledgePreparation(f.dependencies)(input, {
          actor: {
            kind: 'token',
            userId: 'usr_00000000-0000-7000-8000-000000000001',
            tokenId: readonly.record.tokenId,
            tokenScope: 'workspace-readonly',
            tokenWorkspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
          },
          traceId: testEntityId('krt', randomUUID()),
          threadId: 'th_00000000-0000-7000-8000-000000000001',
        })
      ).rejects.toMatchObject({ code: 'workspace_access_denied' });
      expect(retrieve).toHaveBeenCalledTimes(2);
    } finally {
      retrieve.mockRestore();
      await f.close();
    }
  });

  it.each([
    'knowledge.indexes',
    'knowledge.retrieval',
  ] as const)('preserves the owner data_root_required refusal for %s', async (id) => {
    const f = fixture();
    const root = vi.spyOn(f.store, 'getDataRoot').mockReturnValue(undefined);
    try {
      await expect(
        createOperationInvocation(f.dependencies)(
          id,
          {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            ...(id === 'knowledge.retrieval' ? { query: 'lesson' } : {}),
          },
          {
            kind: 'public',
            actor: { kind: 'local', userId: 'usr_00000000-0000-7000-8000-000000000001' },
          }
        )
      ).rejects.toMatchObject({ code: 'data_root_required', status: 409 });
    } finally {
      root.mockRestore();
      await f.close();
    }
  });
});

it.each([
  'HTTP',
  'MCP',
] as const)('preserves invalid source lineage refusal through %s without changes', async (projection) => {
  const f = fixture();
  try {
    const issued = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      scope: 'workspace',
      workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const app = createApp({
      mode: 'server',
      coreDb: f.coreDb,
      dataRoot: f.dataRoot,
      store: f.store,
    });
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${issued.secret}`,
    };
    const input = {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      requestId: randomUUID(),
      kind: 'document',
      title: 'Invalid lineage',
      content: 'Example',
      originatingTurnId: 'tu_00000000-0000-7577-9378-7e96d0d15fd2',
    };
    const owner = vi.spyOn(f.store, 'createKnowledgeSource');
    const before = structuredClone({
      sources: f.store.listKnowledgeSources('ws_00000000-0000-7000-8000-000000000001'),
      receipts: f.store.listCommandRequests(),
    });
    const response = await app.request(
      projection === 'HTTP' ? '/api/app/operations/knowledge.source.register' : '/mcp',
      {
        method: 'POST',
        headers: {
          ...headers,
          ...(projection === 'HTTP'
            ? { 'x-openkit-request-id': input.requestId }
            : { accept: 'application/json, text/event-stream' }),
        },
        body: JSON.stringify(
          projection === 'HTTP'
            ? input
            : {
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                  name: 'openkit_call',
                  arguments: { operation: 'knowledge.source.register', input },
                },
              }
        ),
      }
    );
    expect({
      sources: f.store.listKnowledgeSources('ws_00000000-0000-7000-8000-000000000001'),
      receipts: f.store.listCommandRequests(),
    }).toEqual(before);
    expect(owner).toHaveBeenCalledTimes(1);
    expect(owner.mock.calls[0]![0]).toMatchObject({
      originatingTurnId: 'tu_00000000-0000-7577-9378-7e96d0d15fd2',
      originatingThreadId: null,
    });
    const code = 'knowledge_source_register_failed';
    const message = `Knowledge source turn requires a thread: ${owner.mock.calls[0]![0].id}`;
    if (projection === 'HTTP') {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ protocolVersion: '0.6.0', code, message });
    } else {
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.error).toBeUndefined();
      expect(body.result.isError).toBe(true);
      expect(JSON.parse(body.result.content[0].text)).toEqual({ code, message, status: 404 });
    }
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});

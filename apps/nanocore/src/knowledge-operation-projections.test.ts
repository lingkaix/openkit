import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as schemas from '@openkit/app-api-schemas';
import { describe, expect, it, vi } from 'vitest';
import { createCoreClient } from '../../../packages/core-client/src/index.js';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { ensureLocalUser } from './auth/identity.js';
import { createOperationInvocation } from './operation-invocation.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import * as retrieval from './storage/index-rebuild.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
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
        "INSERT INTO users (id, kind, display_name, email, email_verified, created_at, updated_at, last_seen_at) SELECT 'user_foreign', kind, display_name, 'foreign@local.openkit.invalid', email_verified, created_at, updated_at, last_seen_at FROM users WHERE id = 'user_local'"
      )
      .run();
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: member ? 'user_local' : 'user_foreign',
    workspaceId: 'ws_demo',
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
    close: () => {
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

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
function proposalInput(source: { id: string; contentDigest: string }) {
  const sourceReferences = [`source:${source.id}@${source.contentDigest}`];
  const canonicalPageBytes = [
    '---',
    'type: "KnowledgePage"',
    'title: "Cutover lesson"',
    'schema_version: "openkit-workspace-knowledge-schema-v2"',
    'openkit_status: "active"',
    'status: "stable"',
    'scope: "workspace"',
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
          key === 'createdAt' && 'traceId' in value ? '<trace-time>' : observationView(item),
        ])
    );
  return value;
}

const oldRoutes = [
  ['GET', '/api/workspaces/ws_demo/knowledge'],
  ['POST', '/api/workspaces/ws_demo/knowledge'],
  ['PATCH', '/api/workspaces/ws_demo/knowledge/entry'],
  ['DELETE', '/api/workspaces/ws_demo/knowledge/entry'],
  ['POST', '/api/app/workspaces/ws_demo/knowledge/manager/answer'],
  ['GET', '/api/app/workspaces/ws_demo/knowledge/sources'],
  ['POST', '/api/app/workspaces/ws_demo/knowledge/sources'],
  ['GET', '/api/app/workspaces/ws_demo/knowledge/sources/source'],
  ['GET', '/api/app/workspaces/ws_demo/knowledge/observations'],
  ['POST', '/api/app/workspaces/ws_demo/knowledge/observations'],
  ['GET', '/api/app/workspaces/ws_demo/knowledge/claims'],
  ['POST', '/api/app/workspaces/ws_demo/knowledge/claims'],
  ['GET', '/api/app/workspaces/ws_demo/knowledge/conflicts'],
  ['POST', '/api/app/workspaces/ws_demo/knowledge/conflicts'],
  ['POST', '/api/app/workspaces/ws_demo/knowledge/conflicts/conflict/resolution'],
  ['GET', '/api/app/workspaces/ws_demo/knowledge/indexes'],
  ['POST', '/api/app/workspaces/ws_demo/knowledge/retrievals'],
  ['POST', '/api/app/workspaces/ws_demo/knowledge/manager/context'],
  ['POST', '/api/app/workspaces/ws_demo/knowledge/manager/proposals'],
  ['POST', '/api/app/workspaces/ws_demo/knowledge/manager/repairs'],
  ['POST', '/api/app/workspaces/ws_demo/knowledge/manager/health'],
  ['POST', '/api/app/workspaces/ws_demo/knowledge/proposals/proposal/decision'],
  ['POST', '/api/app/workspaces/ws_demo/knowledge/proposals/proposal/reversal'],
] as const;

describe('Knowledge operation definition cutover', () => {
  it('declares nineteen governed operations and four retained entries with no handwritten projection catalogs', () => {
    const tables = schemas as unknown as Record<string, Record<string, unknown>>;
    expect(Object.keys(tables.KNOWLEDGE_OPERATION_DEFINITIONS ?? {})).toHaveLength(19);
    expect(Object.keys(tables.KNOWLEDGE_ENTRY_OPERATION_DEFINITIONS ?? {})).toHaveLength(4);
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
      f.close();
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
              ownerUserId: 'user_local',
              scope: 'server-admin',
              workspaceIds: [],
              expiresAt: '2099-01-01T00:00:00.000Z',
            }).secret
          : undefined;
      const projectors = await projections(f, token);
      const selector = { workspaceId: 'ws_demo' };
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
        producer: 'user_local',
      });
      await compare('knowledge.observation.list', {});
      await compare('knowledge.claim.record', {
        requestId: randomUUID(),
        statement: 'Source traced lesson',
        producer: 'user_local',
      });
      await compare('knowledge.claim.list', {});
      const conflict = await compare('knowledge.conflict.record', {
        requestId: randomUUID(),
        subjectReferences: ['knowledge:cutover-lesson'],
        summary: 'Competing lesson',
        producer: 'user_local',
      });
      await compare('knowledge.conflict.list', {});
      await compare('knowledge.conflict.resolve', {
        requestId: randomUUID(),
        conflictId: conflict.conflict.id,
        resolution: 'Resolved after inspection',
        resolvedBy: 'user_local',
      });
      const draft = await compare('knowledge.proposal.draft', proposalInput(source.source));
      const decision = await compare('knowledge.proposal.decide', {
        requestId: randomUUID(),
        proposalId: draft.proposal.id,
        decision: 'accepted',
      });
      expect(f.store.getKnowledgeEntry('ws_demo', 'cutover-lesson').content).toContain(
        'Source traced'
      );
      await compare('knowledge.list', {});
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
      });
      const entry = await compare('knowledge.create', {
        requestId: randomUUID(),
        kind: 'project-context',
        title: 'Entry cutover',
        content: 'Retained entry lesson',
        sourceReferences: [],
      });
      await compare('knowledge.update', {
        requestId: randomUUID(),
        knowledgeEntryId: entry.id,
        title: 'Updated entry cutover',
      });
      await compare('knowledge.delete', { requestId: randomUUID(), knowledgeEntryId: entry.id });
      expect(compared.size).toBe(23);
    } finally {
      f.close();
    }
  });

  it('keeps unauthorized Workspace refusal on every definition, scoped source denial and readonly refusal on every mutation before effects', async () => {
    const f = fixture();
    try {
      const issued = createOpenKitAccessTokenRecord(f.coreDb, {
        ownerUserId: 'user_local',
        scope: 'workspace-readonly',
        workspaceIds: ['ws_demo'],
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      const projectors = await projections(f, issued.secret);
      const requestId = randomUUID();
      const draft = proposalInput({
        id: `ks_${randomUUID()}`,
        contentDigest: `sha256:${'a'.repeat(64)}`,
      });
      const inputs: Record<string, Record<string, unknown>> = {
        'knowledge.source.register': {
          requestId,
          kind: 'document',
          title: 'Denied source',
          content: 'Denied content',
        },
        'knowledge.source.list': {},
        'knowledge.source.read': { sourceId: 'ks_missing' },
        'knowledge.observation.record': {
          requestId,
          kind: 'maintenance',
          summary: 'Denied observation',
          producer: 'user_local',
        },
        'knowledge.observation.list': {},
        'knowledge.claim.record': { requestId, statement: 'Denied claim', producer: 'user_local' },
        'knowledge.claim.list': {},
        'knowledge.conflict.record': {
          requestId,
          subjectReferences: ['knowledge:missing'],
          summary: 'Denied conflict',
          producer: 'user_local',
        },
        'knowledge.conflict.list': {},
        'knowledge.conflict.resolve': {
          requestId,
          conflictId: 'kf_missing',
          resolution: 'Denied resolution',
          resolvedBy: 'user_local',
        },
        'knowledge.indexes': {},
        'knowledge.retrieval': { query: 'lesson' },
        'knowledge.context.prepare': { query: 'lesson' },
        'knowledge.answer': { query: 'lesson' },
        'knowledge.proposal.draft': draft,
        'knowledge.repair.suggest': {},
        'knowledge.health.check': {},
        'knowledge.proposal.decide': { requestId, proposalId: 'kp_missing', decision: 'accepted' },
        'knowledge.proposal.reverse': {
          requestId,
          proposalId: 'kp_missing',
          reviewId: 'kr_missing',
          knowledgePageId: 'missing',
          expectedContentDigest: `sha256:${'a'.repeat(64)}`,
        },
        'knowledge.list': {},
        'knowledge.create': {
          requestId,
          kind: 'project-context',
          title: 'Denied entry',
          content: 'Denied content',
        },
        'knowledge.update': { requestId, knowledgeEntryId: 'missing', title: 'Denied update' },
        'knowledge.delete': { requestId, knowledgeEntryId: 'missing' },
      };
      const definitions = schemas.PRODUCT_OPERATION_DEFINITIONS as unknown as Record<
        string,
        { mutating: boolean }
      >;
      expect(Object.keys(inputs)).toHaveLength(23);
      for (const project of Object.values(projectors)) {
        for (const [id, input] of Object.entries(inputs)) {
          await expect(project(id, { ...input, workspaceId: 'ws_unknown' })).rejects.toMatchObject({
            code: 'workspace_access_denied',
          });
          expect(definitions[id], id).toBeDefined();
          if (definitions[id]!.mutating)
            await expect(project(id, { ...input, workspaceId: 'ws_demo' })).rejects.toMatchObject({
              code: 'workspace_access_denied',
            });
        }
        await expect(
          project('knowledge.source.read', { workspaceId: 'ws_demo', sourceId: 'ks_missing' })
        ).rejects.toMatchObject({ code: 'workspace_access_denied' });
      }
      expect(f.store.listKnowledgeSources('ws_demo')).toEqual([]);
      const traceRoot = join(f.dataRoot, 'workspaces/ws_demo/knowledge/traces');
      expect(existsSync(traceRoot) ? readdirSync(traceRoot) : []).toEqual([]);
    } finally {
      f.close();
    }
  });

  it('preserves foreign Source refusal, pinned restricted-content exclusion and bounded preparation and answer for a member and an eligible administrator', async () => {
    const f = fixture();
    try {
      const member = await projections(f);
      const foreign = f.store.createWorkspace('Foreign source authority');
      recordWorkspaceOwnerMembership({
        coreDb: f.coreDb,
        ownerUserId: 'user_local',
        workspaceId: foreign.id,
      });
      const registered = (await member.http('knowledge.source.register', {
        workspaceId: foreign.id,
        requestId: randomUUID(),
        kind: 'document',
        title: 'Foreign secret title',
        content: 'Foreign secret bytes',
      })) as schemas.OperationOutput<'knowledge.source.register'>;
      const entry = f.store.createKnowledgeEntry('ws_demo', {
        kind: 'project-context',
        title: 'Restricted audience lesson',
        content: 'audience budget baseline is forty two',
        sourceReferences: [],
      });
      const page = join(f.dataRoot, 'workspaces/ws_demo/knowledge/pages', `${entry.id}.md`);
      writeFileSync(
        page,
        readFileSync(page, 'utf8').replace(/sensitivity: .*\n/, 'sensitivity: "restricted"\n')
      );
      const administrator = createOpenKitAccessTokenRecord(f.coreDb, {
        ownerUserId: 'user_local',
        scope: 'server-admin',
        workspaceIds: [],
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      for (const projectors of [member, await projections(f, administrator.secret)]) {
        let sourceFailure: unknown;
        for (const project of Object.values(projectors)) {
          try {
            await project('knowledge.source.read', {
              workspaceId: 'ws_demo',
              sourceId: registered.source.id,
            });
            throw new Error('Foreign Source unexpectedly exposed.');
          } catch (error) {
            expect(error).toMatchObject({
              code: 'workspace_access_denied',
              message: 'Workspace access denied.',
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
              workspaceId: 'ws_demo',
              query: 'audience budget baseline',
              ...(id === 'knowledge.retrieval' ? { pinnedConceptIds: [entry.id] } : {}),
            });
            expect(JSON.stringify(result)).not.toContain(entry.title);
            expect(JSON.stringify(result)).not.toContain(entry.content);
            if (id === 'knowledge.answer')
              expect(result).toMatchObject({ outcome: 'insufficient-evidence', citations: [] });
            else if (id === 'knowledge.retrieval')
              expect(result).toMatchObject({
                selected: [],
                excluded: [
                  { knowledgePageId: entry.id, contentDigest: null, reason: 'sensitive_content' },
                ],
              });
            else expect(result).toMatchObject({ selected: [] });
          }
        }
      }
    } finally {
      f.close();
    }
  });

  it('returns distinct public and trusted Task preparation views from exactly one governed retrieval each', async () => {
    const f = fixture();
    const retrieve = vi.spyOn(retrieval, 'retrieveWorkspaceKnowledge');
    try {
      const invoke = createOperationInvocation(f.dependencies);
      const input = { workspaceId: 'ws_demo', query: 'lesson' };
      const publicResult = await invoke('knowledge.context.prepare', input, {
        kind: 'public',
        actor: { kind: 'local', userId: 'user_local' },
      });
      expect(publicResult).toMatchObject({
        caller: 'app-api',
        operation: 'prepare-context-material',
        selected: [],
        excluded: [],
        retrievalTraceId: expect.any(String),
      });
      expect(retrieve).toHaveBeenCalledTimes(1);
      const traceId = `krt_${randomUUID()}`;
      const taskResult = await invoke('knowledge.context.prepare', input, {
        kind: 'task',
        actor: { kind: 'local', userId: 'user_local' },
        traceId,
      });
      expect(taskResult).toEqual({ retrievalTraceId: traceId });
      expect(retrieve).toHaveBeenCalledTimes(2);
      expect(retrieve.mock.calls.map(([request]) => request.caller)).toEqual([
        'app-api',
        'task-mode',
      ]);
      const traceRows = readdirSync(
        join(f.dataRoot, 'workspaces/ws_demo/knowledge/traces')
      ).flatMap((name) =>
        readFileSync(join(f.dataRoot, 'workspaces/ws_demo/knowledge/traces', name), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      );
      expect(traceRows).toHaveLength(2);
      expect(traceRows.map((row) => row.traceId)).toEqual([
        (publicResult as { retrievalTraceId: string }).retrievalTraceId,
        traceId,
      ]);
      await expect(
        invoke(
          'knowledge.context.prepare',
          { ...input, caller: 'task-mode' },
          { kind: 'public', actor: { kind: 'local', userId: 'user_local' } }
        )
      ).rejects.toMatchObject({ code: 'invalid_request' });
      expect(retrieve).toHaveBeenCalledTimes(2);
      const readonly = createOpenKitAccessTokenRecord(f.coreDb, {
        ownerUserId: 'user_local',
        scope: 'workspace-readonly',
        workspaceIds: ['ws_demo'],
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      await expect(
        invoke('knowledge.context.prepare', input, {
          kind: 'task',
          actor: {
            kind: 'token',
            userId: 'user_local',
            tokenId: readonly.record.tokenId,
            tokenScope: 'workspace-readonly',
            tokenWorkspaceIds: ['ws_demo'],
          },
          traceId: `krt_${randomUUID()}`,
        })
      ).rejects.toMatchObject({ code: 'workspace_access_denied' });
      expect(retrieve).toHaveBeenCalledTimes(2);
    } finally {
      retrieve.mockRestore();
      f.close();
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
          { workspaceId: 'ws_demo', ...(id === 'knowledge.retrieval' ? { query: 'lesson' } : {}) },
          { kind: 'public', actor: { kind: 'local', userId: 'user_local' } }
        )
      ).rejects.toMatchObject({ code: 'data_root_required', status: 409 });
    } finally {
      root.mockRestore();
      f.close();
    }
  });
});

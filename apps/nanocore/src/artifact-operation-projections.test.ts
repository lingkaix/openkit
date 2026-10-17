import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as schemas from '@openkit/app-api-schemas';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createCoreClient } from '../../../packages/core-client/src/index.js';
import { registerArtifactFileRoutes } from './artifact-file-routes.js';
import { createArtifactReview, getArtifactReview } from './artifact-reviews.js';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import type { AuthVariables } from './auth/middleware.js';
import { createBootReadinessSnapshot } from './bootstrap/readiness.js';
import { registerOperationJsonRoutes } from './operation-json-routes.js';
import { FileStorageAdmission } from './storage/artifacts/file-admission.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { createWorkspaceMaterial, saveWorkspaceMaterialRevision } from './workspace-materials.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

/** Exact UTF-8 content digest, independent of transport encoding. */
function digest(content: string) {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

/** Isolated real authority; membership, audience and admission are explicit fixture inputs. */
function fixture(member = true, acceptingProductWork = true, privateOrigin = false) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-artifact-operations-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  coreDb.sqlite
    .prepare(
      "INSERT INTO users (id, kind, display_name, email, email_verified, created_at, updated_at, last_seen_at) SELECT 'usr_00000000-0000-7ed5-9b62-226e0a66887f', 'human', display_name, 'foreign@local.openkit.invalid', email_verified, created_at, updated_at, last_seen_at FROM users WHERE id = 'usr_00000000-0000-7000-8000-000000000001'"
    )
    .run();
  const store = createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: member
      ? 'usr_00000000-0000-7000-8000-000000000001'
      : 'usr_00000000-0000-7ed5-9b62-226e0a66887f',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  });
  const thread = store.createThread(
    'ws_00000000-0000-7000-8000-000000000001',
    'Review source',
    undefined,
    'conversation',
    privateOrigin
      ? { visibility: 'private', privateOwnerUserId: 'usr_00000000-0000-7ed5-9b62-226e0a66887f' }
      : { visibility: 'workspace' }
  );
  const turn = store.createTurn(
    'ws_00000000-0000-7000-8000-000000000001',
    thread.id,
    'Produce an output',
    { kind: 'user', id: 'usr_00000000-0000-7ed5-9b62-226e0a66887f' },
    null,
    { agentId: 'agent_codex_host' }
  );
  const content = 'Exact reviewed output.\n';
  store.createArtifact({
    id: 'ar_00000000-0000-7b5d-82ba-fa20d4518e2f',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    threadId: thread.id,
    turnId: turn.id,
    kind: 'summary',
    title: 'Reviewed output',
    status: 'ready',
    summary: null,
    version: 1,
    content: { format: 'text', body: content },
    contentDigest: digest(content),
    lastMutationRequestId: 'produce-review',
    origin: {
      kind: 'turn-output',
      threadId: thread.id,
      turnId: turn.id,
      requestId: 'produce-review',
    },
    createdAt: turn.startedAt!,
    updatedAt: turn.startedAt!,
  });
  const db = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
  applyScopedMigrations(db);
  createArtifactReview(db, {
    artifactId: 'ar_00000000-0000-7b5d-82ba-fa20d4518e2f',
    artifactVersion: 1,
    contentDigest: digest(content),
    sourceThreadId: thread.id,
    sourceTurnId: turn.id,
    sourceAgentId: turn.agentId ?? null,
    materialProposal: null,
    createdAt: turn.startedAt!,
  });
  db.sqlite.close();
  store.updateTurn(turn.id, { status: 'completed', completedAt: new Date().toISOString() });
  const options = {
    coreDb,
    dataRoot,
    store,
    ...(acceptingProductWork
      ? {}
      : {
          getBootReadiness: () => ({
            ...createBootReadinessSnapshot(),
            acceptingProductWork: false,
          }),
        }),
  };
  const app = createApp(options);
  return {
    app,
    coreDb,
    dataRoot,
    store,
    options,
    close: () => {
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

/** Executes actual HTTP, typed client and CLI catalog projections against the same owners. */
async function projections(f: ReturnType<typeof fixture>, token?: string, operationId?: string) {
  const headers = {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const app = token ? createApp({ ...f.options, mode: 'server' }) : f.app;
  const client = createCoreClient({
    baseUrl: 'http://127.0.0.1',
    headers,
    fetch: (input, init) => app.fetch(new Request(input, init)),
  });
  const { operationCatalog } = await import(
    new URL('../../../skills/openkit-operations.mjs', import.meta.url).href
  );
  const binary = operationId === 'artifact.import' || operationId === 'artifact.download';
  return {
    http: async (id: string, input: Record<string, unknown>) => {
      const { requestId, ...body } = input;
      const streaming = id === 'artifact.import' || id === 'artifact.download';
      const query = streaming
        ? `?${new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)]))}`
        : '';
      const response = await app.request(`/api/app/operations/${id}${query}`, {
        method: id === 'artifact.download' ? 'GET' : 'POST',
        headers: {
          ...headers,
          'content-type':
            id === 'artifact.import' ? 'application/octet-stream' : 'application/json',
          ...(requestId ? { 'x-openkit-request-id': String(requestId) } : {}),
        },
        ...(id === 'artifact.download'
          ? {}
          : { body: id === 'artifact.import' ? originalBytes : JSON.stringify(body) }),
      });
      if (id === 'artifact.download' && response.ok) {
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('content-disposition')).toMatch(/^attachment;/);
        return {
          bytes: Buffer.from(await response.arrayBuffer()),
          byteLength: Number(response.headers.get('content-length')),
          contentDigest: response.headers.get('x-openkit-content-digest'),
          mediaType: response.headers.get('content-type'),
        };
      }
      const text = await response.text();
      let result: unknown;
      try {
        result = JSON.parse(text);
      } catch {
        result = { message: text };
      }
      if (!response.ok) throw { ...(result as object), status: response.status };
      expect(response.status, id).toBe(
        id === 'artifact.import' || id === 'artifact.introduce' ? 201 : 200
      );
      return result;
    },
    client: async (id: string, input: Record<string, unknown>) => {
      if (id === 'artifact.import')
        return client.artifactFiles.import(
          input as Parameters<typeof client.artifactFiles.import>[0],
          originalBytes
        );
      if (id === 'artifact.download') {
        const { body, ...metadata } = await client.artifactFiles.download(
          input as Parameters<typeof client.artifactFiles.download>[0]
        );
        return { ...metadata, bytes: Buffer.from(await new Response(body).arrayBuffer()) };
      }
      return (client.operations as unknown as Record<string, (args: unknown) => Promise<unknown>>)[
        id
      ]!(input);
    },
    ...(binary
      ? {}
      : {
          cli: (id: string, input: Record<string, unknown>) => {
            const entry = operationCatalog.find((operation: { id: string }) => operation.id === id);
            expect(entry, id).toBeDefined();
            return entry.handler({ client }, entry.inputSchema.parse(input));
          },
        }),
  };
}

const originals = JSON.parse(
  readFileSync(new URL('../../../tests/fixtures/large-context/cases.json', import.meta.url), 'utf8')
).originals as Array<{
  id: string;
  patternHex: string;
  repeats: number;
  size: number;
  sha256: string;
}>;
const original = originals.find((entry) => entry.id === 'binary-invalid-utf8')!;
const originalBytes = Buffer.from(original.patternHex.repeat(original.repeats), 'hex');
const inputs = {
  'artifact.list': {},
  'artifact.read': { artifactId: 'ar_00000000-0000-7b5d-82ba-fa20d4518e2f' },
  'artifact.import': {
    title: 'Import',
    mediaType: 'application/octet-stream',
    byteLength: original.size,
    contentDigest: original.sha256,
    requestId: 'import-projection',
  },
  'artifact.download': {
    artifactId: 'ar_00000000-0000-7b5d-82ba-fa20d4518e2f',
    artifactVersion: 1,
  },
  'artifact.introduce': {
    artifactId: 'ar_00000000-0000-7b5d-82ba-fa20d4518e2f',
    threadId: 'th_00000000-0000-7000-8000-000000000001',
    expectedArtifactVersion: 1,
    requestId: 'introduce-projection',
  },
  'artifact.review-list': { artifactId: 'ar_00000000-0000-7b5d-82ba-fa20d4518e2f' },
  'artifact.review.select': {
    artifactId: 'ar_00000000-0000-7b5d-82ba-fa20d4518e2f',
    artifactVersion: 1,
    contentDigest: digest('Exact reviewed output.\n'),
    requestId: 'select-projection',
    reason: 'Prefer this candidate.',
  },
  'artifact.review.decide': {
    artifactId: 'ar_00000000-0000-7b5d-82ba-fa20d4518e2f',
    artifactVersion: 1,
    decision: 'rejected',
    requestId: 'decide-projection',
  },
};
const oldRoutes = [
  ['GET', '/api/workspaces/ws_00000000-0000-7000-8000-000000000001/artifacts'],
  [
    'GET',
    '/api/workspaces/ws_00000000-0000-7000-8000-000000000001/artifacts/ar_00000000-0000-7b5d-82ba-fa20d4518e2f',
  ],
  [
    'GET',
    '/api/workspaces/ws_00000000-0000-7000-8000-000000000001/artifacts/ar_00000000-0000-7b5d-82ba-fa20d4518e2f/content',
  ],
  ['POST', '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/artifacts/imports'],
  [
    'POST',
    '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/threads/th_00000000-0000-7000-8000-000000000001/artifacts/ar_00000000-0000-7b5d-82ba-fa20d4518e2f/introductions',
  ],
  [
    'GET',
    '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/artifacts/ar_00000000-0000-7b5d-82ba-fa20d4518e2f/reviews',
  ],
  [
    'POST',
    '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/artifacts/ar_00000000-0000-7b5d-82ba-fa20d4518e2f/versions/1/review/decision',
  ],
];

describe('Artifact definition projections', () => {
  it('records exact candidate choices without work or a final decision', async () => {
    const f = fixture();
    try {
      const input = {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        artifactId: 'ar_00000000-0000-7b5d-82ba-fa20d4518e2f',
        artifactVersion: 1,
        contentDigest: digest('Exact reviewed output.\n'),
        requestId: 'choose-exact',
        reason: 'Keep this candidate.',
      };
      const turns = f.store.listThreadTurns(
        input.workspaceId,
        f.store.getArtifact(input.workspaceId, input.artifactId).threadId!
      );
      const send = (body: Record<string, unknown>) =>
        f.app.request('/api/app/operations/artifact.review.select', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-openkit-request-id': String(body.requestId),
          },
          body: JSON.stringify(body),
        });
      const response = await send(input);
      expect(response.status).toBe(200);
      const selected = await response.json();
      expect(selected.review.decision).toBeNull();
      expect(selected.review.candidateSelections).toEqual([
        {
          actorId: 'usr_00000000-0000-7000-8000-000000000001',
          requestId: input.requestId,
          reason: input.reason,
          selectedAt: expect.any(String),
        },
      ]);
      expect(await (await send(input)).json()).toEqual(selected);
      const changed = await send({ ...input, reason: 'Changed reason.' });
      expect(changed.status).toBe(409);
      expect(await changed.json()).toMatchObject({ code: 'idempotency_key_conflict' });
      const stale = await send({
        ...input,
        requestId: 'wrong-digest',
        contentDigest: digest('different'),
      });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ code: 'stale' });
      expect(f.store.listThreadTurns(input.workspaceId, turns[0]!.threadId)).toEqual(turns);
      const second = await send({ ...input, requestId: 'choose-again', reason: 'Another reason.' });
      expect((await second.json()).review.candidateSelections).toHaveLength(2);
      const decision = await f.app.request('/api/app/operations/artifact.review.decide', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-openkit-request-id': 'decided-choice' },
        body: JSON.stringify({
          workspaceId: input.workspaceId,
          artifactId: input.artifactId,
          artifactVersion: 1,
          requestId: 'decided-choice',
          decision: 'rejected',
        }),
      });
      expect(decision.status).toBe(200);
      const afterDecision = await send({ ...input, requestId: 'choose-decided' });
      expect((await afterDecision.json()).review).toMatchObject({
        decision: 'rejected',
        candidateSelections: expect.any(Array),
      });
      expect(f.store.listThreadTurns(input.workspaceId, turns[0]!.threadId)).toEqual(turns);
    } finally {
      f.close();
    }
  });

  it.each([
    false,
    true,
  ])('persists exact original UTF-16 feedback or refuses changed base (%s)', async (changedBase) => {
    const f = fixture();
    const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
    const artifactId = 'ar_00000000-0000-7b5d-82ba-fa20d4518e2f';
    const db = openWorkspaceDb(f.dataRoot, workspaceId);
    applyScopedMigrations(db);
    try {
      const content = 'A\r\n😀e\u0301 tail';
      const material = createWorkspaceMaterial(db, {
        actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        acceptedAt: '2026-10-17T00:00:00.000Z',
        requestId: 'range-base',
        title: 'Base',
        kind: 'text',
        sensitivity: 'internal',
      });
      const revision = saveWorkspaceMaterialRevision(db, {
        actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        acceptedAt: '2026-10-17T00:00:00.000Z',
        requestId: 'range-root',
        materialId: material.materialId,
        expectedRevisionId: null,
        content,
        contentDigest: digest(content),
      });
      db.sqlite
        .prepare(
          'UPDATE artifact_reviews SET proposal_material_id = ?, proposal_base_revision_id = ?, proposal_base_content_digest = ?'
        )
        .run(material.materialId, revision.revisionId, digest(content));
      const rangeFeedback = {
        materialId: material.materialId,
        revisionId: revision.revisionId,
        contentDigest: digest(content),
        start: 3,
        end: 7,
        originalText: '😀e\u0301',
      };
      const send = (range: unknown, requestId = 'range-decision') =>
        f.app.request('/api/app/operations/artifact.review.decide', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-openkit-request-id': requestId },
          body: JSON.stringify({
            workspaceId,
            artifactId,
            artifactVersion: 1,
            decision: 'rejected',
            feedback: 'Change this range.',
            requestId,
            rangeFeedback: range,
          }),
        });
      for (const invalid of [
        { ...rangeFeedback, start: 4 },
        { ...rangeFeedback, originalText: '😀é' },
        { ...rangeFeedback, contentDigest: digest('other') },
      ]) {
        const refused = await send(invalid);
        expect(refused.status).toBe(400);
        expect(await refused.json()).toMatchObject({ code: 'invalid_request' });
        expect(getArtifactReview(db, artifactId, 1).decision).toBeNull();
      }
      if (changedBase) {
        saveWorkspaceMaterialRevision(db, {
          actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
          acceptedAt: '2026-10-17T00:01:00.000Z',
          requestId: 'range-base-changed',
          materialId: material.materialId,
          expectedRevisionId: revision.revisionId,
          content: 'New base.',
          contentDigest: digest('New base.'),
        });
        const before = db.sqlite.prepare('SELECT * FROM artifact_reviews').all();
        const receipts = db.sqlite.prepare('SELECT * FROM idempotency_requests').all();
        const conflict = await send(rangeFeedback);
        expect(conflict.status).toBe(409);
        expect(await conflict.json()).toMatchObject({ code: 'conflict' });
        expect(db.sqlite.prepare('SELECT * FROM artifact_reviews').all()).toEqual(before);
        expect(db.sqlite.prepare('SELECT * FROM idempotency_requests').all()).toEqual(receipts);
        return;
      }
      const response = await send(rangeFeedback);
      expect(response.status).toBe(200);
      expect(getArtifactReview(db, artifactId, 1)).toMatchObject({
        rangeFeedback,
        decision: 'rejected',
      });
      expect((await send(rangeFeedback)).status).toBe(200);
      const changed = await send({ ...rangeFeedback, end: 5, originalText: '😀' });
      expect(changed.status).toBe(409);
      expect(await changed.json()).toMatchObject({ code: 'idempotency_key_conflict' });
    } finally {
      db.sqlite.close();
      f.close();
    }
  });

  it('declares the ten Artifact operations without handwritten JSON projection catalogs', () => {
    const table = (schemas as unknown as Record<string, Record<string, unknown>>)
      .ARTIFACT_OPERATION_DEFINITIONS;
    expect(Object.keys(table ?? {}).sort()).toEqual(
      [...Object.keys(inputs), 'artifact.folder-read', 'artifact.folder-extract'].sort()
    );
    for (const path of [
      'skills/openkit-operations.mjs',
      'apps/nanocore/src/openapi.ts',
      'apps/nanocore/src/auth/operation-access.ts',
    ]) {
      const source = readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
      for (const id of [
        ...Object.keys(inputs).filter(
          (id) => !['artifact.import', 'artifact.download'].includes(id)
        ),
        'artifact.review-decide',
      ])
        expect(source, `${path}: ${id}`).not.toMatch(
          new RegExp(`['"\x60]${id.replaceAll('.', '\\.')}['"\x60]`)
        );
    }
  });

  it('keeps binary bindings outside the JSON client and maps CLI transfers to artifactFiles', async () => {
    const client = createCoreClient({ baseUrl: 'http://127.0.0.1' });
    const { operationCatalog } = await import(
      new URL('../../../skills/openkit-operations.mjs', import.meta.url).href
    );
    for (const id of ['artifact.import', 'artifact.download'] as const) {
      expect(schemas.OPERATION_DEFINITIONS[id].binding).toBe('streaming');
      expect(Object.hasOwn(client.operations, id)).toBe(false);
      expect(
        operationCatalog.find((operation: { id: string }) => operation.id === id)?.clientMethod
      ).toBe(id === 'artifact.import' ? 'artifactFiles.import' : 'artifactFiles.download');
    }
    for (const id of [
      'artifact.list',
      'artifact.read',
      'artifact.introduce',
      'artifact.review-list',
      'artifact.review.decide',
    ]) {
      expect(Object.hasOwn(client.operations, id)).toBe(true);
      expect(operationCatalog.map((operation: { id: string }) => operation.id)).toContain(id);
    }
  });

  it.each(oldRoutes)('deletes %s %s with HTTP 404', async (method, path) => {
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
  ])('preserves exact authorized results and command replay across HTTP client and CLI for %s', async (authority) => {
    const f = fixture(
      authority === 'Workspace member',
      true,
      authority === 'eligible administrator'
    );
    try {
      const token = createOpenKitAccessTokenRecord(f.coreDb, {
        ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        scope: authority === 'eligible administrator' ? 'server-admin' : 'workspace',
        workspaceIds:
          authority === 'eligible administrator' ? [] : ['ws_00000000-0000-7000-8000-000000000001'],
        expiresAt: '2099-01-01T00:00:00.000Z',
      }).secret;
      async function compare(id: string, input: Record<string, unknown>) {
        let expected: unknown;
        for (const project of Object.values(await projections(f, token, id))) {
          const result = await project(id, {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            ...input,
          });
          if (expected === undefined) expected = result;
          expect(result, id).toEqual(expected);
        }
        return expected as {
          artifactId: string;
          artifactVersion: number;
          turnId: string;
          itemId: string;
        };
      }
      await compare('artifact.review.select', inputs['artifact.review.select']);
      const imported = await compare('artifact.import', inputs['artifact.import']);
      const read = await compare('artifact.read', { artifactId: imported.artifactId });
      expect(read).toEqual(
        f.store.getArtifact('ws_00000000-0000-7000-8000-000000000001', imported.artifactId)
      );
      expect((read as unknown as { content: unknown }).content).toEqual({
        format: 'file',
        mediaType: 'application/octet-stream',
        byteLength: original.size,
      });
      expect(
        await compare('artifact.download', { artifactId: imported.artifactId, artifactVersion: 1 })
      ).toEqual({
        bytes: originalBytes,
        byteLength: original.size,
        mediaType: 'application/octet-stream',
        contentDigest: original.sha256,
      });
      const list = await compare('artifact.list', {});
      expect(list).toEqual({
        items: f.store.listArtifacts('ws_00000000-0000-7000-8000-000000000001'),
      });
      const introduced = await compare('artifact.introduce', {
        ...inputs['artifact.introduce'],
        artifactId: imported.artifactId,
      });
      expect(
        f.store.getTurn(
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001',
          introduced.turnId
        ).items[0]?.id
      ).toBe(introduced.itemId);
      expect(
        f.store.getArtifact('ws_00000000-0000-7000-8000-000000000001', imported.artifactId).origin
          .kind
      ).toBe('imported');
      await compare('artifact.review.decide', inputs['artifact.review.decide']);
      const reviews = await compare('artifact.review-list', inputs['artifact.review-list']);
      const db = openWorkspaceDb(f.dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      try {
        expect(reviews).toEqual({
          reviews: [getArtifactReview(db, 'ar_00000000-0000-7b5d-82ba-fa20d4518e2f', 1)],
        });
      } finally {
        db.sqlite.close();
      }
      for (const project of Object.values(await projections(f, token, 'artifact.import')))
        await expect(
          project('artifact.import', {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            ...inputs['artifact.import'],
            title: 'Changed input',
          })
        ).rejects.toMatchObject({ code: 'idempotency_key_conflict', status: 409 });
    } finally {
      f.close();
    }
  });

  it('rechecks the current source audience and exact version for binary downloads', async () => {
    const f = fixture(true, true, true);
    try {
      const token = createOpenKitAccessTokenRecord(f.coreDb, {
        ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        scope: 'workspace-readonly',
        workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
        expiresAt: '2099-01-01T00:00:00.000Z',
      }).secret;
      for (const project of Object.values(await projections(f, token, 'artifact.download'))) {
        await expect(
          project('artifact.download', {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            artifactId: 'ar_00000000-0000-7b5d-82ba-fa20d4518e2f',
            artifactVersion: 1,
          })
        ).rejects.toMatchObject({ status: 404 });
      }
      const admin = createOpenKitAccessTokenRecord(f.coreDb, {
        ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        scope: 'server-admin',
        workspaceIds: [],
        expiresAt: '2099-01-01T00:00:00.000Z',
      }).secret;
      for (const project of Object.values(await projections(f, admin, 'artifact.download'))) {
        expect(
          await project('artifact.download', {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            artifactId: 'ar_00000000-0000-7b5d-82ba-fa20d4518e2f',
            artifactVersion: 1,
          })
        ).toEqual({
          bytes: Buffer.from('Exact reviewed output.\n'),
          byteLength: 23,
          mediaType: 'text/plain',
          contentDigest: digest('Exact reviewed output.\n'),
        });
        await expect(
          project('artifact.download', {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            artifactId: 'ar_00000000-0000-7b5d-82ba-fa20d4518e2f',
            artifactVersion: 2,
          })
        ).rejects.toMatchObject({ status: 404 });
      }
    } finally {
      f.close();
    }
  });

  it('replays an accepted import without reading a changed or unreadable retry body', async () => {
    const f = fixture();
    try {
      const projectors = await projections(f, undefined, 'artifact.import');
      const metadata = {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        ...inputs['artifact.import'],
      };
      const accepted = await projectors.http('artifact.import', metadata);
      let reads = 0;
      const retry = new ReadableStream<Uint8Array>(
        {
          pull() {
            reads += 1;
            throw new Error('Retry source is no longer readable.');
          },
        },
        { highWaterMark: 0 }
      );
      const client = createCoreClient({
        baseUrl: 'http://127.0.0.1',
        fetch: (input, init) => f.app.fetch(new Request(input, init)),
      });
      await expect(client.artifactFiles.import(metadata, retry)).resolves.toEqual(accepted);
      expect(reads).toBe(0);
      expect(
        f.store
          .listArtifacts('ws_00000000-0000-7000-8000-000000000001')
          .filter((artifact) => artifact.lastMutationRequestId === metadata.requestId)
      ).toHaveLength(1);
    } finally {
      f.close();
    }
  });

  it('does not invent an import receipt after the original was published without acknowledgement', async () => {
    const f = fixture();
    try {
      const record = vi.spyOn(f.store, 'recordCommandRequest').mockImplementationOnce(() => {
        throw new Error('Fixture receipt write unavailable.');
      });
      const projectors = await projections(f, undefined, 'artifact.import');
      await expect(
        projectors.client('artifact.import', {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          ...inputs['artifact.import'],
        })
      ).rejects.toMatchObject({ status: 500 });
      record.mockRestore();
      const artifacts = f.store.listArtifacts('ws_00000000-0000-7000-8000-000000000001');
      const imported = artifacts.find(
        (artifact) => artifact.lastMutationRequestId === inputs['artifact.import'].requestId
      )!;
      expect(imported).toBeDefined();
      for (const project of Object.values(projectors)) {
        await expect(
          project('artifact.import', {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            ...inputs['artifact.import'],
          })
        ).rejects.toMatchObject({ code: 'recovery_required', status: 409 });
      }
      expect(f.store.listArtifacts('ws_00000000-0000-7000-8000-000000000001')).toEqual(artifacts);
      for (const project of Object.values(await projections(f, undefined, 'artifact.download'))) {
        expect(
          await project('artifact.download', {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            artifactId: imported.id,
            artifactVersion: 1,
          })
        ).toMatchObject({ bytes: originalBytes, contentDigest: original.sha256 });
      }
    } finally {
      vi.restoreAllMocks();
      f.close();
    }
  });

  it('preserves the missing receiving Thread JSON refusal before introduction replay across projections', async () => {
    const f = fixture();
    try {
      for (const project of Object.values(await projections(f)))
        await expect(
          project('artifact.introduce', {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            ...inputs['artifact.introduce'],
            threadId: 'th_00000000-0000-70ca-938d-c2a0530f9882',
          })
        ).rejects.toMatchObject({ code: 'not_found', message: 'Thread not found.', status: 404 });
    } finally {
      f.close();
    }
  });

  it.each([
    'artifact.import',
    'artifact.introduce',
    'artifact.review.decide',
  ] as const)('retains HTTP 500 when %s cannot open its receipt database', async (id) => {
    const f = fixture();
    try {
      const app = new Hono<{ Variables: AuthVariables }>();
      app.use('*', async (c, next) => {
        c.set('actor', { kind: 'local', userId: 'usr_00000000-0000-7000-8000-000000000001' });
        await next();
      });
      const dependencies = {
        app,
        coreDb: f.coreDb,
        store: f.store,
        workspaceMutationAdmission: new WorkspaceMutationAdmission(),
        requestStore: () => f.store,
        inflightCommands: new WeakMap(),
        repositoryWorkspaceDb: () => {
          throw new Error('Fixture database unavailable.');
        },
      };
      registerOperationJsonRoutes(dependencies);
      registerArtifactFileRoutes({
        ...dependencies,
        dataRoot: f.dataRoot,
        fileAdmission: new FileStorageAdmission(f.dataRoot, () => 0n),
      });
      const { requestId, ...body } = inputs[id];
      const metadata = { workspaceId: 'ws_00000000-0000-7000-8000-000000000001', ...body };
      const query =
        id === 'artifact.import'
          ? `?${new URLSearchParams(Object.entries(metadata).map(([key, value]) => [key, String(value)]))}`
          : '';
      const response = await app.request(`/api/app/operations/${id}${query}`, {
        method: 'POST',
        headers: {
          'content-type':
            id === 'artifact.import' ? 'application/octet-stream' : 'application/json',
          'x-openkit-request-id': requestId,
        },
        body: id === 'artifact.import' ? originalBytes : JSON.stringify(metadata),
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        protocolVersion: '0.6.0',
        code: 'internal_error',
        message: 'Internal Server Error',
      });
    } finally {
      f.close();
    }
  });

  it.each(
    Object.entries(inputs)
  )('preserves unauthorized Workspace refusal for %s across HTTP client and CLI', async (id, input) => {
    const f = fixture();
    try {
      for (const project of Object.values(await projections(f, undefined, id)))
        await expect(
          project(id, { ...input, workspaceId: 'ws_00000000-0000-7744-93d6-d2f551c62efa' })
        ).rejects.toMatchObject({
          code: 'workspace_access_denied',
          status: 403,
        });
    } finally {
      f.close();
    }
  });

  it('preserves Artifact owner not-found for another member reading private-origin content and an unknown Artifact id in another authorized Workspace', async () => {
    const f = fixture(true, true, true);
    try {
      const other = f.store.createWorkspace('Other Workspace');
      recordWorkspaceOwnerMembership({
        coreDb: f.coreDb,
        ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        workspaceId: other.id,
      });
      const token = createOpenKitAccessTokenRecord(f.coreDb, {
        ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        scope: 'workspace',
        workspaceIds: ['ws_00000000-0000-7000-8000-000000000001', other.id],
        expiresAt: '2099-01-01T00:00:00.000Z',
      }).secret;
      for (const project of Object.values(await projections(f, token))) {
        await expect(
          project('artifact.review.select', {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            ...inputs['artifact.review.select'],
          })
        ).rejects.toMatchObject({ message: 'Artifact not found.', status: 404 });
        await expect(
          project('artifact.read', {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            artifactId: 'ar_00000000-0000-7b5d-82ba-fa20d4518e2f',
          })
        ).rejects.toMatchObject({ message: 'Artifact not found.', status: 404 });
        await expect(
          project('artifact.read', {
            workspaceId: other.id,
            artifactId: 'ar_00000000-0000-7b5d-82ba-fa20d4518e2f',
          })
        ).rejects.toMatchObject({ message: 'Artifact not found.', status: 404 });
      }
    } finally {
      f.close();
    }
  });

  it.each(
    Object.entries(inputs).filter(([id]) =>
      [
        'artifact.import',
        'artifact.introduce',
        'artifact.review.decide',
        'artifact.review.select',
      ].includes(id)
    )
  )('refuses read-only Token mutation for %s across HTTP client and CLI before effects', async (id, input) => {
    const f = fixture();
    let reviewDb: ReturnType<typeof openWorkspaceDb> | undefined;
    try {
      const token = createOpenKitAccessTokenRecord(f.coreDb, {
        ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        scope: 'workspace-readonly',
        workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
        expiresAt: '2099-01-01T00:00:00.000Z',
      }).secret;
      const artifacts = f.store.listArtifacts('ws_00000000-0000-7000-8000-000000000001');
      const turns = f.store.listThreadTurns(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001'
      );
      if (id === 'artifact.review.decide' || id === 'artifact.review.select')
        reviewDb = openWorkspaceDb(f.dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      const review = reviewDb
        ? getArtifactReview(reviewDb, 'ar_00000000-0000-7b5d-82ba-fa20d4518e2f', 1)
        : undefined;
      for (const project of Object.values(await projections(f, token, id)))
        await expect(
          project(id, { workspaceId: 'ws_00000000-0000-7000-8000-000000000001', ...input })
        ).rejects.toMatchObject({
          code: 'workspace_access_denied',
          status: 403,
        });
      expect(f.store.listArtifacts('ws_00000000-0000-7000-8000-000000000001')).toEqual(artifacts);
      expect(
        f.store.listThreadTurns(
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001'
        )
      ).toEqual(turns);
      if (reviewDb)
        expect(getArtifactReview(reviewDb, 'ar_00000000-0000-7b5d-82ba-fa20d4518e2f', 1)).toEqual(
          review
        );
    } finally {
      reviewDb?.sqlite.close();
      f.close();
    }
  });

  it.each(
    Object.entries(inputs).filter(([id]) =>
      [
        'artifact.import',
        'artifact.introduce',
        'artifact.review.decide',
        'artifact.review.select',
      ].includes(id)
    )
  )('returns product_work_unavailable for %s while product admission is closed', async (id, input) => {
    const f = fixture(true, false);
    try {
      const artifacts = f.store.listArtifacts('ws_00000000-0000-7000-8000-000000000001');
      for (const project of Object.values(await projections(f, undefined, id)))
        await expect(
          project(id, { workspaceId: 'ws_00000000-0000-7000-8000-000000000001', ...input })
        ).rejects.toMatchObject({
          code: 'product_work_unavailable',
          status: 503,
        });
      expect(f.store.listArtifacts('ws_00000000-0000-7000-8000-000000000001')).toEqual(artifacts);
    } finally {
      f.close();
    }
  });
});

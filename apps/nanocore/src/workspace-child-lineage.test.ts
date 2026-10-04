import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiErrorSchema } from '@openkit/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { knowledgeOperationRequest } from './test-support/knowledge-operation.js';
import { operationRequest } from './test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/** One direct Core request expected to fail closed on child lineage. */
interface LineageRequest {
  /** Optional JSON request body. */
  readonly body?: unknown;
  /** HTTP method; GET is used when omitted. */
  readonly method?: 'DELETE' | 'GET' | 'PATCH' | 'POST';
  /** Concrete request path. */
  readonly path: string;
}

/** Creates two authorized Workspaces with child records owned only by the second Workspace. */
function createLineageFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-child-lineage-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const store = createDemoStore({ dataRoot });
  const app = createApp({ coreDb, dataRoot, store });
  const allowedWorkspace = store.createWorkspace('Allowed lineage Workspace');
  const foreignWorkspace = store.createWorkspace('Foreign lineage Workspace');

  for (const workspace of [allowedWorkspace, foreignWorkspace]) {
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: workspace.id,
    });
  }

  const allowedThread = store.createThread(allowedWorkspace.id, 'Allowed lineage Thread');
  const foreignThread = store.createThread(foreignWorkspace.id, 'Foreign lineage Thread');
  const foreignTurn = store.createTurn(
    foreignWorkspace.id,
    foreignThread.id,
    'Foreign lineage Turn',
    { kind: 'user', id: 'user_local' }
  );
  const foreignKnowledge = store.createKnowledgeEntry(foreignWorkspace.id, {
    kind: 'project-context',
    title: 'Foreign knowledge',
    content: 'This entry belongs to the foreign Workspace.',
  });
  const timestamp = new Date().toISOString();
  const foreignKnowledgeSource = store.createKnowledgeSource({
    id: 'ks_foreign_lineage',
    workspaceId: foreignWorkspace.id,
    kind: 'document',
    title: 'Foreign knowledge source',
    uri: null,
    contentDigest: 'sha256:foreign-lineage-source',
    originatingThreadId: null,
    originatingTurnId: null,
    originatingFileId: null,
    capturedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const artifactBody = 'Foreign Artifact content.';
  const artifactRequestId = 'foreign-artifact-lineage';
  const foreignArtifact = store.createArtifact({
    id: 'ar_foreign_lineage',
    workspaceId: foreignWorkspace.id,
    threadId: foreignThread.id,
    turnId: foreignTurn.id,
    kind: 'summary',
    title: 'Foreign Artifact',
    status: 'ready',
    summary: null,
    version: 1,
    content: { format: 'text', body: artifactBody },
    contentDigest: `sha256:${createHash('sha256').update(artifactBody).digest('hex')}`,
    lastMutationRequestId: artifactRequestId,
    origin: {
      kind: 'turn-output',
      threadId: foreignThread.id,
      turnId: foreignTurn.id,
      requestId: artifactRequestId,
    },
    createdAt: foreignTurn.startedAt ?? new Date().toISOString(),
    updatedAt: foreignTurn.startedAt ?? new Date().toISOString(),
  });

  return {
    allowedThread,
    allowedWorkspace,
    app,
    coreDb,
    foreignArtifact,
    foreignKnowledge,
    foreignKnowledgeSource,
    foreignThread,
    foreignTurn,
    store,
  };
}

/** Sends one request and requires the uniform Workspace access denial response. */
async function expectWorkspaceAccessDenied(
  app: ReturnType<typeof createApp>,
  request: LineageRequest
): Promise<void> {
  const response = await sendLineageRequest(app, request);
  expect(response.status, await response.clone().text()).toBe(403);
  expect(ApiErrorSchema.parse(await response.json()).code).toBe('workspace_access_denied');
}

/** Sends one request and requires the uniform missing-or-inaccessible Thread failure. */
async function expectThreadNotFound(
  app: ReturnType<typeof createApp>,
  request: LineageRequest
): Promise<void> {
  const response = await sendLineageRequest(app, request);
  expect(response.status, await response.clone().text()).toBe(404);
  expect(ApiErrorSchema.parse(await response.json())).toMatchObject({
    code: 'not_found',
    message: 'Thread not found.',
  });
}

/** Issues one lineage request with optional JSON body. */
async function sendLineageRequest(
  app: ReturnType<typeof createApp>,
  request: LineageRequest
): Promise<Response> {
  if (
    request.path === '/api/app/operations/thread.update' ||
    request.path === '/api/app/operations/thread.archive' ||
    request.path === '/api/app/operations/turn.interrupt'
  )
    return app.request(
      ...operationRequest(
        request.path.split('/').at(-1)!,
        {},
        { body: JSON.stringify(request.body) }
      )
    );
  return app.request(request.path, {
    method: request.method ?? 'GET',
    ...(request.body === undefined
      ? {}
      : {
          body: JSON.stringify(request.body),
          headers: { 'content-type': 'application/json' },
        }),
  });
}

let fixture: ReturnType<typeof createLineageFixture>;

beforeEach(() => {
  fixture = createLineageFixture();
});

afterEach(() => {
  fixture.coreDb.sqlite.close();
});

describe('Workspace child lineage', () => {
  it('denies foreign Thread reads and mutations through an authorized Workspace path', async () => {
    for (const request of [
      {
        path: '/api/app/operations/thread.read',
        method: 'POST',
        body: { workspaceId: fixture.allowedWorkspace.id, threadId: fixture.foreignThread.id },
      },
      {
        path: '/api/app/operations/thread.items',
        method: 'POST',
        body: { workspaceId: fixture.allowedWorkspace.id, threadId: fixture.foreignThread.id },
      },
      {
        method: 'PATCH',
        path: '/api/app/operations/thread.update',
        body: {
          workspaceId: fixture.allowedWorkspace.id,
          threadId: fixture.foreignThread.id,
          name: 'Do not rename this Thread',
          requestId: '00000000-0000-4000-8000-000000000401',
        },
      },
      {
        method: 'POST',
        path: '/api/app/operations/thread.archive',
        body: {
          workspaceId: fixture.allowedWorkspace.id,
          threadId: fixture.foreignThread.id,
          requestId: '00000000-0000-4000-8000-000000000402',
        },
      },
    ] satisfies LineageRequest[]) {
      await expectThreadNotFound(fixture.app, request);
    }
  });

  it('denies foreign Knowledge reads and mutations through an authorized Workspace path', async () => {
    for (const [id, child] of [
      [
        'knowledge.update',
        {
          knowledgeEntryId: fixture.foreignKnowledge.id,
          requestId: '00000000-0000-4000-8000-000000000403',
          title: 'Do not update this entry',
        },
      ],
      [
        'knowledge.delete',
        {
          knowledgeEntryId: fixture.foreignKnowledge.id,
          requestId: '00000000-0000-4000-8000-000000000404',
        },
      ],
      ['knowledge.source.read', { sourceId: fixture.foreignKnowledgeSource.id }],
    ] as const) {
      const response = await fixture.app.request(
        ...knowledgeOperationRequest(
          id,
          { workspaceId: fixture.allowedWorkspace.id },
          { body: JSON.stringify(child) }
        )
      );
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
    }
  });

  it('denies foreign Artifact reads, reviews, decisions, and introduction', async () => {
    for (const [id, child] of [
      ['artifact.read', {}],
      ['artifact.review-list', {}],
      [
        'artifact.review.decide',
        {
          artifactVersion: 1,
          decision: 'accepted',
          requestId: '00000000-0000-4000-8000-000000000406',
        },
      ],
      [
        'artifact.introduce',
        {
          threadId: fixture.allowedThread.id,
          expectedArtifactVersion: 1,
          requestId: '00000000-0000-4000-8000-000000000407',
        },
      ],
    ] as const) {
      const response = await fixture.app.request(
        ...operationRequest(
          id,
          { workspaceId: fixture.allowedWorkspace.id, artifactId: fixture.foreignArtifact.id },
          { body: JSON.stringify(child) }
        )
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        protocolVersion: '0.5.0',
        code: 'not_found',
        message: 'Artifact not found.',
      });
    }
  });

  it('denies a foreign event-stream Turn through an authorized Workspace and Thread path', async () => {
    await expectWorkspaceAccessDenied(fixture.app, {
      path: `/api/workspaces/${fixture.allowedWorkspace.id}/threads/${fixture.allowedThread.id}/events?turnId=${fixture.foreignTurn.id}&since=0`,
    });
  });

  it('denies foreign Turn reads and interrupts through an authorized Workspace path', async () => {
    for (const request of [
      {
        path: '/api/app/operations/turn.read',
        method: 'POST',
        body: {
          workspaceId: fixture.allowedWorkspace.id,
          threadId: fixture.allowedThread.id,
          turnId: fixture.foreignTurn.id,
        },
      },
      {
        method: 'POST',
        path: '/api/app/operations/turn.interrupt',
        body: {
          workspaceId: fixture.allowedWorkspace.id,
          threadId: fixture.allowedThread.id,
          turnId: fixture.foreignTurn.id,
          requestId: '00000000-0000-4000-8000-000000000405',
        },
      },
    ] satisfies LineageRequest[]) {
      await expectWorkspaceAccessDenied(fixture.app, request);
    }
  });
});

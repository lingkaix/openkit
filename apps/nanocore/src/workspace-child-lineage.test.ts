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
  const response = await app.request(request.path, {
    method: request.method ?? 'GET',
    ...(request.body === undefined
      ? {}
      : {
          body: JSON.stringify(request.body),
          headers: { 'content-type': 'application/json' },
        }),
  });

  expect(response.status, await response.clone().text()).toBe(403);
  expect(ApiErrorSchema.parse(await response.json()).code).toBe('workspace_access_denied');
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
    const basePath = `/api/workspaces/${fixture.allowedWorkspace.id}/threads/${fixture.foreignThread.id}`;

    for (const request of [
      { path: basePath },
      {
        path: `/api/app/workspaces/${fixture.allowedWorkspace.id}/threads/${fixture.foreignThread.id}/items`,
      },
      {
        method: 'PATCH',
        path: basePath,
        body: {
          name: 'Do not rename this Thread',
          requestId: '00000000-0000-4000-8000-000000000401',
        },
      },
      {
        method: 'POST',
        path: `${basePath}/archive`,
        body: { requestId: '00000000-0000-4000-8000-000000000402' },
      },
    ] satisfies LineageRequest[]) {
      await expectWorkspaceAccessDenied(fixture.app, request);
    }
  });

  it('denies foreign Knowledge reads and mutations through an authorized Workspace path', async () => {
    const path = `/api/workspaces/${fixture.allowedWorkspace.id}/knowledge/${fixture.foreignKnowledge.id}`;

    for (const request of [
      {
        method: 'PATCH',
        path,
        body: {
          requestId: '00000000-0000-4000-8000-000000000403',
          title: 'Do not update this entry',
        },
      },
      {
        method: 'DELETE',
        path,
        body: { requestId: '00000000-0000-4000-8000-000000000404' },
      },
      {
        path: `/api/app/workspaces/${fixture.allowedWorkspace.id}/knowledge/sources/${fixture.foreignKnowledgeSource.id}`,
      },
    ] satisfies LineageRequest[]) {
      await expectWorkspaceAccessDenied(fixture.app, request);
    }
  });

  it('denies foreign Artifact reads, reviews, decisions, and introduction', async () => {
    const corePath = `/api/workspaces/${fixture.allowedWorkspace.id}/artifacts/${fixture.foreignArtifact.id}`;
    const appPath = `/api/app/workspaces/${fixture.allowedWorkspace.id}/artifacts/${fixture.foreignArtifact.id}`;

    for (const request of [
      { path: corePath },
      { path: `${corePath}/content` },
      { path: `${appPath}/reviews` },
      {
        method: 'POST',
        path: `${appPath}/versions/1/review/decision`,
        body: {
          decision: 'accepted',
          requestId: '00000000-0000-4000-8000-000000000406',
        },
      },
      {
        method: 'POST',
        path: `/api/app/workspaces/${fixture.allowedWorkspace.id}/threads/${fixture.allowedThread.id}/artifacts/${fixture.foreignArtifact.id}/introductions`,
        body: {
          expectedArtifactVersion: 1,
          requestId: '00000000-0000-4000-8000-000000000407',
        },
      },
    ] satisfies LineageRequest[]) {
      await expectWorkspaceAccessDenied(fixture.app, request);
    }
  });

  it('denies a foreign event-stream Turn through an authorized Workspace and Thread path', async () => {
    await expectWorkspaceAccessDenied(fixture.app, {
      path: `/api/workspaces/${fixture.allowedWorkspace.id}/threads/${fixture.allowedThread.id}/events?turnId=${fixture.foreignTurn.id}&since=0`,
    });
  });

  it('denies foreign Turn reads and interrupts through an authorized Workspace path', async () => {
    const path = `/api/workspaces/${fixture.allowedWorkspace.id}/threads/${fixture.allowedThread.id}/turns/${fixture.foreignTurn.id}`;

    for (const request of [
      { path },
      {
        method: 'POST',
        path: `${path}/interrupt`,
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

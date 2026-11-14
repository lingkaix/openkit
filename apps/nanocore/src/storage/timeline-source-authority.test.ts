import { createHash, randomUUID } from 'node:crypto';
import { ThreadTimelineResponseSchema } from '@openkit/app-api-schemas';
import { allocateEntityId, UserIdSchema } from '@openkit/protocol';
import { expect, it, vi } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  resolveSessionDeploymentAdminTokenId,
} from '../auth/access-token-store.js';
import { createBetterAuth } from '../auth/better-auth.js';
import { createApp } from '../test-support/app.js';
import { navigationFixture } from '../test-support/nav-oracle.fixture.js';
import { operationRequest } from '../test-support/operation-request.js';
import { publishWorkspaceOwnerMembership } from '../workspace-membership.js';
import type { ThreadTimelineSnapshot } from './workspace-file-records.js';

/** Separately joined private sources retain their current authority after awaited timeline projection. */
it('refuses a formerly privileged Artifact projection after acknowledged session administrator demotion', async () => {
  const f = await navigationFixture();
  // Real SDK registration and native session publication, not an injected actor or auth DTO.
  const auth = createBetterAuth(f.coreDb, { env: {}, mode: 'local' });
  const origin = new URL(auth.options.baseURL).origin;
  const registration = await auth.handler(
    new Request(new URL('/api/auth/sign-up/email', origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Source authority viewer',
        email: [randomUUID(), 'example.test'].join('@'),
        password: randomUUID() + randomUUID(),
      }),
    })
  );
  expect(registration.status).toBe(200);
  const registered = await registration.json();
  const browserUserId = UserIdSchema.parse(registered.user.id);
  const cookie = registration.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  expect(cookie.length).toBeGreaterThan(0);
  const admin = createOpenKitAccessTokenRecord(f.coreDb, {
    ownerUserId: browserUserId,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  expect(resolveSessionDeploymentAdminTokenId(f.coreDb, browserUserId)).toBe(admin.tokenId);
  const workspace = await f.store.createWorkspace('Source authority boundary');
  await publishWorkspaceOwnerMembership({
    coreDb: f.coreDb,
    workspaceId: workspace.id,
    ownerUserId: browserUserId,
  });
  const shared = await f.store.createThread(workspace.id, 'Visible addressed Thread');
  const sharedTurn = await f.store.createTurn(workspace.id, shared.id, 'Read a cited source', {
    kind: 'user',
    id: browserUserId,
  });
  const privateThread = await f.store.createThread(
    workspace.id,
    'Private source Thread',
    undefined,
    'conversation',
    {
      visibility: 'private',
      privateOwnerUserId: f.actor.id,
    }
  );
  const privateTurn = await f.store.createTurn(
    workspace.id,
    privateThread.id,
    'Private source',
    f.actor
  );
  const makeArtifact = async (threadId: string, turnId: string, title: string) => {
    const body = title + ' body';
    const requestId = randomUUID();
    return f.store.createArtifact({
      id: allocateEntityId('ar'),
      workspaceId: workspace.id,
      threadId,
      turnId,
      kind: 'summary',
      title,
      status: 'ready',
      summary: body,
      version: 1,
      content: { format: 'markdown', body },
      contentDigest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
      lastMutationRequestId: requestId,
      origin: { kind: 'turn-output', threadId, turnId, requestId },
      createdAt: '2026-11-08T17:00:00.000Z',
      updatedAt: '2026-11-08T17:00:00.000Z',
    });
  };
  const privateArtifact = await makeArtifact(
    privateThread.id,
    privateTurn.id,
    'Private authority source marker'
  );
  const sharedArtifact = await makeArtifact(
    shared.id,
    sharedTurn.id,
    'Allowed shared source marker'
  );
  const citation = await f.store.createItem({
    id: allocateEntityId('it'),
    owner: sharedTurn.owner,
    threadId: shared.id,
    turnId: sharedTurn.id,
    type: 'artifact-reference',
    artifactId: privateArtifact.id,
    artifactVersion: 1,
    lastMutationRequestId: privateArtifact.lastMutationRequestId!,
    title: privateArtifact.title,
    summary: privateArtifact.summary,
    status: 'completed',
    createdAt: '2026-11-08T17:00:00.000Z',
    completedAt: '2026-11-08T17:00:00.000Z',
  });
  const app = createApp({
    mode: 'server',
    dataRoot: f.dataRoot,
    coreDb: f.coreDb,
    store: f.store,
    auth,
  });
  const headers = { cookie };
  const timelineInput = {
    workspaceId: workspace.id,
    threadId: shared.id,
    view: 'items' as const,
    turnId: sharedTurn.id,
    limit: 50,
  };
  const timeline = () =>
    app.request(...operationRequest('thread.timeline', timelineInput, { headers }));
  const artifactRead = (artifactId: string) =>
    app.request(
      ...operationRequest('artifact.read', { workspaceId: workspace.id, artifactId }, { headers })
    );
  expect((await artifactRead(privateArtifact.id)).status).toBe(200);
  const beforeResponse = await timeline();
  expect(beforeResponse.status).toBe(200);
  const before = ThreadTimelineResponseSchema.parse(await beforeResponse.json());
  expect(before.items.some((item) => item.id === citation.id)).toBe(true);
  expect(JSON.stringify(before)).toContain(privateArtifact.id);
  expect(JSON.stringify(before)).toContain(privateArtifact.title);

  const original = f.store.readThreadTimelineSnapshotCooperative.bind(f.store);
  let crossed = 0;
  let acknowledged = false;
  const projection = vi
    .spyOn(f.store, 'readThreadTimelineSnapshotCooperative')
    .mockImplementation(
      async <T>(
        workspaceId: string,
        threadId: string,
        read: (snapshot: ThreadTimelineSnapshot) => Generator<void, T, void>,
        signal?: AbortSignal
      ): Promise<T> => {
        const result = await original(workspaceId, threadId, read, signal);
        if (workspaceId === workspace.id && threadId === shared.id && crossed === 0) {
          crossed++;
          // The exact original projection must already contain the separately joined privileged source.
          expect(JSON.stringify(result)).toContain(privateArtifact.id);
          const revoked = await app.request(
            ...operationRequest('token.revoke', { tokenId: admin.tokenId }, { headers })
          );
          expect(revoked.status).toBe(200);
          const body = await revoked.json();
          expect(body.record.tokenId).toBe(admin.tokenId);
          expect(body.record.revokedAt).not.toBeNull();
          expect(resolveSessionDeploymentAdminTokenId(f.coreDb, browserUserId)).toBeNull();
          acknowledged = true;
        }
        return result;
      }
    );
  let response: Response;
  try {
    response = await timeline();
  } finally {
    projection.mockRestore();
  }
  expect(crossed).toBe(1);
  expect(acknowledged).toBe(true);
  expect(response.status).toBe(503);
  const refusal = await response.json();
  expect(refusal).toMatchObject({ code: 'operation_storage_unavailable' });
  expect(refusal).not.toHaveProperty('items');
  expect(refusal).not.toHaveProperty('runs');
  expect(JSON.stringify(refusal)).not.toContain(privateArtifact.id);
  expect(JSON.stringify(refusal)).not.toContain(privateArtifact.title);

  // The session, addressed Thread and general source operation remain live after demotion.
  const addressed = await app.request(
    ...operationRequest(
      'thread.read',
      { workspaceId: workspace.id, threadId: shared.id },
      { headers }
    )
  );
  expect(addressed.status).toBe(200);
  expect((await artifactRead(sharedArtifact.id)).status).toBe(200);
  expect((await artifactRead(privateArtifact.id)).status).toBe(404);
  const freshResponse = await timeline();
  expect(freshResponse.status).toBe(200);
  const fresh = ThreadTimelineResponseSchema.parse(await freshResponse.json());
  expect(JSON.stringify(fresh)).not.toContain(privateArtifact.id);
  expect(JSON.stringify(fresh)).not.toContain(privateArtifact.title);
}, 30000);

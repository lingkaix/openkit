import { ConversationNavigationResponseSchema } from '@openkit/app-api-schemas';
import { expect, it, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { navigationFixture } from '../test-support/nav-oracle.fixture.js';
import { operationRequest } from '../test-support/operation-request.js';

/** Unread source proof belongs only to the returned page, after lightweight row ranking. */
it('proves unread only for the exact returned Thread when navigation limit is one', async () => {
  const f = await navigationFixture();
  const other = await f.store.createThread(f.workspaceId, 'Off-page conversation');
  const active = f.store.listThreads(f.workspaceId).filter((thread) => thread.status === 'active');
  expect(new Set(active.map((thread) => thread.id))).toEqual(new Set([f.thread.id, other.id]));
  const token = createOpenKitAccessTokenRecord(f.coreDb, {
    ownerUserId: f.actor.id,
    scope: 'workspace',
    workspaceIds: [f.workspaceId],
    expiresAt: '2099-01-01T00:00:00.000Z',
  }).secret;
  const original = f.store.readThreadNavigationMessages.bind(f.store);
  const proof = vi
    .spyOn(f.store, 'readThreadNavigationMessages')
    .mockImplementation((...args) => original(...args));
  try {
    const response = await f.app.request(
      ...operationRequest(
        'conversation.navigation',
        {
          workspaceId: f.workspaceId,
          limit: 1,
        },
        { headers: { authorization: `Bearer ${token}` } }
      )
    );
    expect(response.status).toBe(200);
    const body = ConversationNavigationResponseSchema.parse(await response.json());
    expect(body.items).toHaveLength(1);
    expect(typeof body.nextCursor).toBe('string');
    expect(proof.mock.calls.map(([workspaceId, threadId]) => ({ workspaceId, threadId }))).toEqual([
      { workspaceId: f.workspaceId, threadId: body.items[0]!.thread.id },
    ]);
  } finally {
    proof.mockRestore();
  }
});

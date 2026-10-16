import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { FsStore } from './lib/store.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { operationRequest } from './test-support/operation-request.js';
import { readThreadReadState } from './thread-read-state.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const FIRST = 'it_00000000-0000-5000-8000-000000000001';
const SECOND = 'it_00000000-0000-5000-8000-000000000002';
const OWN = 'it_00000000-0000-5000-8000-000000000003';
const STREAMING = 'it_00000000-0000-5000-8000-000000000004';
const OTHER_USER = 'usr_019e0000-0000-7000-8000-000000000002';

describe('User-owned Thread read receipts', () => {
  it('keeps prefetch unread, unions displayed messages, isolates Users and rejects inaccessible or ineligible targets', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'thread-read-state-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const localUserId = ensureLocalUser(coreDb);
    onTestFinished(() => {
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    });
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Shared conversations');
    recordWorkspaceOwnerMembership({
      coreDb,
      workspaceId: workspace.id,
      ownerUserId: localUserId,
    });
    const thread = store.createThread(workspace.id, 'Read receipts');
    const turn = store.createTurn(workspace.id, thread.id, 'Prompt', {
      kind: 'user',
      id: localUserId,
    });
    const base = {
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      status: 'completed' as const,
      createdAt: '2026-10-16T00:00:00.000Z',
      completedAt: '2026-10-16T00:00:00.000Z',
    };
    for (const id of [FIRST, SECOND])
      store.createItem({ ...base, id, type: 'assistant-message', text: 'Reply' });
    store.createItem({
      ...base,
      id: OWN,
      type: 'user-message',
      actor: { kind: 'user', id: localUserId },
      text: 'Prompt',
    });
    store.createItem({
      ...base,
      id: STREAMING,
      type: 'assistant-message',
      status: 'in_progress',
      completedAt: null,
      text: 'Still writing',
    });
    const secret = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: localUserId,
      scope: 'workspace',
      workspaceIds: [workspace.id],
      expiresAt: '2099-01-01T00:00:00.000Z',
    }).secret;
    const app = createApp({ mode: 'server', coreDb, store });
    const owner = { workspaceId: workspace.id, threadId: thread.id };
    const request = (
      id: Parameters<typeof operationRequest>[0],
      input: Record<string, unknown> = owner
    ) =>
      app.request(
        ...operationRequest(id, input, { headers: { authorization: `Bearer ${secret}` } })
      );
    const state = async () => {
      const response = await request('thread.read-state');
      expect(response.status).toBe(200);
      return response.json();
    };

    expect(await state()).toEqual({ readItemIds: [], unreadItemIds: [FIRST, SECOND] });
    expect((await request('thread.items')).status).toBe(200);
    const prefetchedNavigation = await request('conversation.navigation', {
      workspaceId: workspace.id,
    });
    expect(prefetchedNavigation.status).toBe(200);
    expect(
      (await prefetchedNavigation.json()).items.find(
        (row: { thread: { id: string } }) => row.thread.id === thread.id
      ).unreadCount
    ).toBe(2);
    expect(await state()).toEqual({ readItemIds: [], unreadItemIds: [FIRST, SECOND] });
    expect((await request('thread.mark-read', { ...owner, itemIds: [SECOND] })).status).toBe(200);
    expect(await state()).toEqual({ readItemIds: [SECOND], unreadItemIds: [FIRST] });
    expect((await request('thread.mark-read', { ...owner, itemIds: [FIRST, OWN] })).status).toBe(
      400
    );
    expect((await request('thread.mark-read', { ...owner, itemIds: [STREAMING] })).status).toBe(
      400
    );
    expect(await state()).toEqual({ readItemIds: [SECOND], unreadItemIds: [FIRST] });
    expect(readThreadReadState({ ...owner, store, coreDb, userId: OTHER_USER })).toEqual({
      readItemIds: [],
      unreadItemIds: [FIRST, SECOND, OWN],
    });
    expect(
      (await request('thread.mark-read', { ...owner, userId: OTHER_USER, itemIds: [FIRST] })).status
    ).toBe(403);
    expect(await state()).toEqual({ readItemIds: [SECOND], unreadItemIds: [FIRST] });

    const privateThread = store.createThread(
      workspace.id,
      'Other person',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: OTHER_USER }
    );
    expect(
      (await request('thread.read-state', { ...owner, threadId: privateThread.id })).status
    ).toBe(404);
    expect(
      (await request('thread.mark-read', { ...owner, threadId: privateThread.id })).status
    ).toBe(404);
    expect((await request('thread.mark-read')).status).toBe(200);
    expect(await state()).toEqual({ readItemIds: [FIRST, SECOND], unreadItemIds: [] });
    const navigation = await (
      await request('conversation.navigation', { workspaceId: workspace.id })
    ).json();
    expect(
      navigation.items.find((row: { thread: { id: string } }) => row.thread.id === thread.id)
        .unreadCount
    ).toBe(0);
  });
});

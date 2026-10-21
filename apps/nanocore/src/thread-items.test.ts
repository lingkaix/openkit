import { afterEach, describe, expect, it } from 'vitest';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';

import { createAppWithWorkspaceAuthority as createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';

describe('thread item replay app API', () => {
  it('returns ordered durable thread items for reload and right-sidebar replay', async () => {
    const store = await createDemoStore();
    const thread = await store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Replay thread'
    );
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Persisted prompt',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const first = await store.createItem({
      id: 'it_00000000-0000-763b-b3b8-3669a5928aa2',
      owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
      threadId: thread.id,
      turnId: turn.id,
      type: 'user-message',
      status: 'completed',
      actor: turn.triggerActor,
      text: 'Persisted prompt',
      createdAt: '2026-05-06T00:00:00.000Z',
      completedAt: '2026-05-06T00:00:00.000Z',
    });
    const second = await store.createItem({
      id: 'it_00000000-0000-7beb-8b84-62c886f469f0',
      owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
      threadId: thread.id,
      turnId: turn.id,
      type: 'assistant-message',
      status: 'completed',
      text: 'Persisted answer',
      createdAt: '2026-05-06T00:00:01.000Z',
      completedAt: '2026-05-06T00:00:01.000Z',
    });
    const app = createApp({ store });

    const res = await app.request('/api/app/operations/thread.items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: thread.id,
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      items: [first, second],
      nextCursor: null,
    });
  });
});

// Drain and stop the native fixture owner before the next test can remove or reuse its roots.
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
});

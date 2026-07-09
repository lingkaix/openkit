import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { createDemoStore } from './test-support/demo-store.js';

describe('thread item replay app API', () => {
  it('returns ordered durable thread items for reload and right-sidebar replay', async () => {
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Replay thread');
    const turn = store.createTurn('ws_demo', thread.id, 'Persisted prompt');
    const first = store.createItem({
      id: 'it_replay_user',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
      type: 'user-message',
      status: 'completed',
      text: 'Persisted prompt',
      createdAt: '2026-05-06T00:00:00.000Z',
      completedAt: '2026-05-06T00:00:00.000Z',
    });
    const second = store.createItem({
      id: 'it_replay_assistant',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
      type: 'assistant-message',
      status: 'completed',
      text: 'Persisted answer',
      createdAt: '2026-05-06T00:00:01.000Z',
      completedAt: '2026-05-06T00:00:01.000Z',
    });
    const app = createApp({ store });

    const res = await app.request(`/api/app/workspaces/ws_demo/threads/${thread.id}/items`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      items: [first, second],
      nextCursor: null,
    });
  });
});

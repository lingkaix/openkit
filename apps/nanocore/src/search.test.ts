import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { createDemoStore } from './test-support/demo-store.js';

describe('search app API', () => {
  it('searches workspaces, threads, knowledge, artifacts, and items', async () => {
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Needle thread');
    const turn = store.createTurn('ws_demo', thread.id, 'Find needle');
    store.createItem({
      id: 'it_search_needle',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
      type: 'assistant-message',
      status: 'completed',
      text: 'Needle answer',
      createdAt: turn.startedAt ?? new Date().toISOString(),
      completedAt: turn.startedAt ?? new Date().toISOString(),
    });
    const app = createApp({ store });

    const res = await app.request('/api/app/search?q=needle');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ kind: 'thread', id: thread.id, title: 'Needle thread' }),
        expect.objectContaining({ kind: 'item', id: 'it_search_needle', title: 'Needle answer' }),
      ]),
    });
  });
});

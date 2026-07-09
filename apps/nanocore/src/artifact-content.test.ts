import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { createDemoStore } from './test-support/demo-store.js';

describe('artifact content endpoint', () => {
  it('opens markdown artifact content as a concrete response body', async () => {
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Artifact content thread');
    const turn = store.createTurn('ws_demo', thread.id, 'Create artifact');
    store.createArtifact({
      id: 'ar_markdown',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
      kind: 'summary',
      title: 'Markdown output',
      status: 'ready',
      summary: 'Open me',
      version: 1,
      content: { format: 'markdown', body: '# Output' },
      createdAt: turn.startedAt ?? new Date().toISOString(),
      updatedAt: turn.startedAt ?? new Date().toISOString(),
    });
    const app = createApp({ store });

    const res = await app.request('/api/workspaces/ws_demo/artifacts/ar_markdown/content');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    await expect(res.text()).resolves.toBe('# Output');
  });
});

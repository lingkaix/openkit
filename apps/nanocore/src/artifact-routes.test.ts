import { GetArtifactResponseSchema, ListArtifactsResponseSchema } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';

import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';

describe('Core artifact routes', () => {
  it('lists, reads, and opens markdown artifact content', async () => {
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

    const listRes = await app.request('/api/workspaces/ws_demo/artifacts');
    const getRes = await app.request('/api/workspaces/ws_demo/artifacts/ar_markdown');
    const res = await app.request('/api/workspaces/ws_demo/artifacts/ar_markdown/content');

    expect(listRes.status).toBe(200);
    expect(ListArtifactsResponseSchema.parse(await listRes.json())).toMatchObject({
      items: [{ id: 'ar_markdown', workspaceId: 'ws_demo' }],
    });
    expect(getRes.status).toBe(200);
    expect(GetArtifactResponseSchema.parse(await getRes.json())).toMatchObject({
      id: 'ar_markdown',
      workspaceId: 'ws_demo',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    await expect(res.text()).resolves.toBe('# Output');
  });

  it('serves text and JSON artifact content through their existing representations', async () => {
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Artifact format thread');
    const turn = store.createTurn('ws_demo', thread.id, 'Create formatted artifacts');
    const timestamp = turn.startedAt ?? new Date().toISOString();
    store.createArtifact({
      id: 'ar_text',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
      kind: 'summary',
      title: 'Text output',
      status: 'ready',
      summary: null,
      version: 1,
      content: { format: 'text', body: 'Plain output' },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    store.createArtifact({
      id: 'ar_json',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
      kind: 'summary',
      title: 'JSON output',
      status: 'ready',
      summary: null,
      version: 1,
      content: { format: 'json', body: '{"ok":true}' },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const app = createApp({ store });

    const textRes = await app.request('/api/workspaces/ws_demo/artifacts/ar_text/content');
    const jsonRes = await app.request('/api/workspaces/ws_demo/artifacts/ar_json/content');

    expect(textRes.status).toBe(200);
    expect(textRes.headers.get('content-type')).toContain('text/plain');
    await expect(textRes.text()).resolves.toBe('Plain output');
    expect(jsonRes.status).toBe(200);
    await expect(jsonRes.json()).resolves.toEqual({ format: 'json', body: '{"ok":true}' });
  });
});

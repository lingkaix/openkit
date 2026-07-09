import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { createDemoStore } from './test-support/demo-store.js';

describe('automation app API', () => {
  it('lists and creates local automation definitions', async () => {
    const app = createApp({ store: createDemoStore() });

    const emptyRes = await app.request('/api/app/automations');
    expect(emptyRes.status).toBe(200);
    await expect(emptyRes.json()).resolves.toEqual({ items: [] });

    const createRes = await app.request('/api/app/automations', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Morning status',
        workspaceId: 'ws_demo',
        cron: '0 9 * * *',
        prompt: 'Summarize active threads',
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(createRes.status).toBe(201);
    await expect(createRes.json()).resolves.toMatchObject({
      id: expect.any(String),
      name: 'Morning status',
      status: 'paused',
    });

    const listRes = await app.request('/api/app/automations');
    await expect(listRes.json()).resolves.toMatchObject({
      items: [{ name: 'Morning status', cron: '0 9 * * *' }],
    });
  });

  it('updates and deletes local automation definitions', async () => {
    const app = createApp({ store: createDemoStore() });
    const createRes = await app.request('/api/app/automations', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Morning status',
        workspaceId: 'ws_demo',
        cron: '0 9 * * *',
        prompt: 'Summarize active threads',
      }),
      headers: { 'content-type': 'application/json' },
    });
    const automation = (await createRes.json()) as { id: string };

    const enableRes = await app.request(`/api/app/automations/${automation.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'enabled' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(enableRes.status).toBe(200);
    await expect(enableRes.json()).resolves.toMatchObject({
      id: automation.id,
      status: 'enabled',
    });

    const deleteRes = await app.request(`/api/app/automations/${automation.id}`, {
      method: 'DELETE',
    });

    expect(deleteRes.status).toBe(204);

    const listRes = await app.request('/api/app/automations');
    await expect(listRes.json()).resolves.toEqual({ items: [] });
  });
});

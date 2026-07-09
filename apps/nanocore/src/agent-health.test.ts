import {
  GetAgentCatalogEntryResponseSchema,
  ListAgentCatalogResponseSchema,
} from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import { createDemoStore } from './test-support/demo-store.js';

describe('agent health diagnostics app API', () => {
  it('lists and reads product-visible Agent Catalog entries', async () => {
    const app = createApp({ store: createDemoStore(), turnExecutor: new SimulatedTurnExecutor() });
    const listRes = await app.request('/api/app/agents');

    expect(listRes.status).toBe(200);
    const listPayload = ListAgentCatalogResponseSchema.parse(await listRes.json());
    expect(listPayload.items.map((agent) => agent.id)).toContain('agent_codex_host');
    expect(JSON.stringify(listPayload)).not.toContain('"config"');

    const getRes = await app.request('/api/app/agents/agent_codex_host');

    expect(getRes.status).toBe(200);
    const getPayload = GetAgentCatalogEntryResponseSchema.parse(await getRes.json());
    expect(getPayload).toMatchObject({
      id: 'agent_codex_host',
      status: 'enabled',
    });
    expect(JSON.stringify(getPayload)).not.toContain('"config"');
  });

  it('refreshes workspace agent health for Settings Diagnostics', async () => {
    const app = createApp({ store: createDemoStore(), turnExecutor: new SimulatedTurnExecutor() });
    const res = await app.request('/api/app/workspaces/ws_demo/agents/health/refresh', {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      items: [
        {
          agentId: 'agent_codex_host',
          status: 'unknown',
          checkedAt: expect.any(String),
        },
        {
          agentId: 'agent_opencode_host',
          status: 'unknown',
          checkedAt: expect.any(String),
        },
        {
          agentId: 'agent_opencode_server',
          status: 'unknown',
          checkedAt: expect.any(String),
        },
      ],
      sessions: [
        {
          id: 'session_sim_th_demo',
          status: 'ready',
          message: null,
        },
      ],
    });
  });
});

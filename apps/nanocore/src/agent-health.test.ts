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
    const store = createDemoStore();
    store.upsertAgent('ws_demo', {
      id: 'agent_codex_host',
      name: 'Codex Host Agent',
      kind: 'coder',
      status: 'enabled',
      modelId: null,
      skillIds: [],
      profiles: [],
      defaultProfileId: null,
      capabilities: [],
      sandboxSummary: null,
      health: { status: 'unknown', message: null, checkedAt: null },
    });
    const app = createApp({ store, turnExecutor: new SimulatedTurnExecutor() });
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
    const store = createDemoStore();
    store.upsertAgent('ws_demo', {
      id: 'agent_codex_host',
      name: 'Codex Host Agent',
      kind: 'coder',
      status: 'enabled',
      modelId: null,
      skillIds: [],
      profiles: [],
      defaultProfileId: null,
      capabilities: [],
      sandboxSummary: null,
      health: { status: 'unknown', message: null, checkedAt: null },
    });
    const app = createApp({ store, turnExecutor: new SimulatedTurnExecutor() });
    const res = await app.request('/api/app/workspaces/ws_demo/agents/health/refresh', {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload).toMatchObject({
      items: [
        {
          agentId: 'agent_codex_host',
          status: 'unknown',
          checkedAt: expect.any(String),
        },
      ],
    });
    expect(payload).not.toHaveProperty('sessions');
    expect(JSON.stringify(payload)).not.toContain('"sessions"');
  });
});

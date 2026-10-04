import {
  GetAgentCatalogEntryResponseSchema,
  ListAgentCatalogResponseSchema,
} from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import { createTestAgentSetup } from './test-support/agent-environment.js';
import { createAppWithWorkspaceAuthority as createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { operationRequest } from './test-support/operation-request.js';

describe('Agent inventory and health operations', () => {
  it('lists and reads product-visible Agent Catalog entries', async () => {
    const store = createDemoStore();
    const app = createApp({
      agentManifests: [createTestAgentSetup().manifest],
      store,
      turnExecutor: new SimulatedTurnExecutor(),
    });
    const listRes = await app.request(
      ...operationRequest(
        'agent.list',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }
      )
    );

    expect(listRes.status).toBe(200);
    const listPayload = ListAgentCatalogResponseSchema.parse(await listRes.json());
    expect(listPayload.items.map((agent) => agent.id)).toContain('agent_codex_host');
    expect(JSON.stringify(listPayload)).not.toContain('"config"');

    const getRes = await app.request(
      ...operationRequest(
        'agent.read',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agentId: 'agent_codex_host' }),
        }
      )
    );

    expect(getRes.status).toBe(200);
    const getPayload = GetAgentCatalogEntryResponseSchema.parse(await getRes.json());
    expect(getPayload).toMatchObject({
      id: 'agent_codex_host',
      kind: null,
      status: 'enabled',
    });
    expect(JSON.stringify(getPayload)).not.toContain('"config"');
  });

  it('refreshes workspace agent health for Settings Diagnostics', async () => {
    const store = createDemoStore();
    const app = createApp({
      agentManifests: [createTestAgentSetup().manifest],
      store,
      turnExecutor: new SimulatedTurnExecutor(),
    });
    const res = await app.request(
      ...operationRequest(
        'agent.health-refresh',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId: 'ws_demo' }),
        }
      )
    );

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

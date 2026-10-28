import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GetAgentCatalogEntryResponseSchema,
  ListAgentCatalogResponseSchema,
} from '@openkit/app-api-schemas';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { createTestAgentSetup } from './test-support/agent-environment.js';
import { createAppWithWorkspaceAuthority as createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { operationRequest } from './test-support/operation-request.js';

describe('Agent inventory and health operations', () => {
  it('lists and reads product-visible Agent Catalog entries', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-agent-health-'));
    onTestFinished(async () => {
      await shutdownControlStoreWorkerClient();
      rmSync(dataRoot, { recursive: true, force: true });
    });
    const store = await createDemoStore({ dataRoot });
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
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-agent-health-'));
    onTestFinished(async () => {
      await shutdownControlStoreWorkerClient();
      rmSync(dataRoot, { recursive: true, force: true });
    });
    const store = await createDemoStore({ dataRoot });
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
          body: JSON.stringify({ workspaceId: 'ws_00000000-0000-7000-8000-000000000001' }),
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

// Drain and stop the native fixture owner before the next test can remove or reuse its roots.
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
});

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GetAgentCatalogEntryResponseSchema,
  ListAgentCatalogResponseSchema,
} from '@openkit/app-api-schemas';
import { describe, expect, it, onTestFinished } from 'vitest';

import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createAppWithWorkspaceAuthority as createApp } from '../test-support/app.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { operationRequest } from '../test-support/operation-request.js';
import { createTestStore, disposeTestStore } from '../test-support/store.js';
import { projectAgentCatalogEntries, projectAgentCatalogEntry } from './catalog-projection.js';
import { computeReadiness } from './readiness.js';

describe('projectAgentCatalogEntry', () => {
  it('keeps absent readiness unknown without turning the launch default into health', () => {
    const manifest = createTestAgentSetup({
      agentId: 'agent_configured',
      displayName: 'Configured Worker',
    }).manifest;

    expect(manifest.readiness).toBeUndefined();
    expect(computeReadiness(manifest)).toEqual({ reasons: [], status: 'ready' });
    expect(projectAgentCatalogEntry(manifest)).toMatchObject({
      health: { checkedAt: null, message: null, status: 'unknown' },
      id: 'agent_configured',
      kind: null,
      name: 'Configured Worker',
      status: 'enabled',
    });
  });

  it('keeps unavailable supply visible without copying raw readiness messages or private fields', () => {
    const secretMessage = 'export TOKEN=sk-leak; /usr/local/bin/opencode --cwd /secret/path';
    const unavailable = {
      ...createTestAgentSetup({
        adapter: 'opencode',
        agentId: 'agent_unavailable',
        displayName: 'Unavailable Worker',
      }).manifest,
      readiness: { message: secretMessage, status: 'blocked' as const },
      workspace: { env: { OPENAI_API_KEY: 'sk-test-catalog-must-not-leak' } },
    };
    const disabled = {
      ...createTestAgentSetup({
        agentId: 'agent_disabled',
        displayName: 'Disabled Worker',
      }).manifest,
      readiness: { message: secretMessage, status: 'disabled' as const },
    };

    const entries = projectAgentCatalogEntries([unavailable, disabled]);
    const publicJson = JSON.stringify(entries);

    expect(entries.map((entry) => entry.id)).toEqual(['agent_unavailable', 'agent_disabled']);
    expect(entries[0]).toMatchObject({
      health: { checkedAt: null, message: null, status: 'unknown' },
      kind: null,
      status: 'enabled',
    });
    expect(entries[1]).toMatchObject({
      health: { checkedAt: null, message: null, status: 'unknown' },
      status: 'disabled',
    });
    expect(publicJson).not.toContain(secretMessage);
    expect(publicJson).not.toContain('sk-test-catalog-must-not-leak');
    expect(publicJson).not.toContain('/usr/local/bin');
    expect(publicJson).not.toContain('opencode');
  });

  it('rereads the current snapshot through the Workspace resources seam without persisting agents', async () => {
    const configured = createTestAgentSetup({
      agentId: 'agent_configured',
      displayName: 'Configured Worker',
    }).manifest;
    const later = createTestAgentSetup({
      agentId: 'agent_later',
      displayName: 'Later Worker',
    }).manifest;
    const dataRoot = mkdtempSync(join(tmpdir(), 'catalog-projection-'));
    onTestFinished(() => disposeTestStore(dataRoot));
    const store = createTestStore({ dataRoot });
    const workspace = await store.createWorkspace('Catalog projection');
    let manifests = [configured];
    store.setWorkspaceAgentCatalogProjection(() => projectAgentCatalogEntries(manifests));

    expect(store.getWorkspaceResources(workspace.id).agents.map((agent) => agent.id)).toEqual([
      'agent_configured',
    ]);

    manifests = [configured, later];

    expect(store.getWorkspaceResources(workspace.id).agents.map((agent) => agent.id)).toEqual([
      'agent_configured',
      'agent_later',
    ]);
    expect(store.refreshAgentHealth(workspace.id).map((item) => item.agentId)).toEqual([
      'agent_configured',
      'agent_later',
    ]);

    manifests = [];
    expect(store.getWorkspaceResources(workspace.id).agents).toEqual([]);
  });
});

describe('Agent inventory and health operations', () => {
  it('lists and reads product-visible Agent Catalog entries', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-agent-health-'));
    onTestFinished(() => disposeTestStore(dataRoot));
    const store = await createDemoStore({ dataRoot });
    const app = createApp({
      agentManifests: [createTestAgentSetup().manifest],
      store,
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
    onTestFinished(() => disposeTestStore(dataRoot));
    const store = await createDemoStore({ dataRoot });
    const app = createApp({
      agentManifests: [createTestAgentSetup().manifest],
      store,
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

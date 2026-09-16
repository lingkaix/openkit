import { describe, expect, it } from 'vitest';

import { FsStore } from '../lib/store.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
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
    expect(projectAgentCatalogEntry(manifest).kind).not.toBe(manifest.runtime.kind);
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

  it('rereads the current snapshot through the Workspace resources seam without persisting agents', () => {
    const configured = createTestAgentSetup({
      agentId: 'agent_configured',
      displayName: 'Configured Worker',
    }).manifest;
    const later = createTestAgentSetup({
      agentId: 'agent_later',
      displayName: 'Later Worker',
    }).manifest;
    const store = new FsStore();
    const workspace = store.createWorkspace('Catalog projection');
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

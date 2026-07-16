import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from './providers/registry.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';

describe('workspace dashboard app API', () => {
  it('returns aggregate workspace status and default execution context', async () => {
    const app = createApp({ store: createDemoStore() });
    const res = await app.request('/api/app/workspaces/ws_demo/dashboard');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      workspace: {
        id: 'ws_demo',
        name: 'Demo Workspace',
      },
      counts: {
        threadCount: 1,
        artifactCount: 0,
        knowledgeEntryCount: 1,
        providerCount: 0,
      },
      defaultContext: {
        modelId: 'model_codex',
        agentId: 'agent_codex_host',
      },
      agentHealth: [
        {
          agentId: 'agent_codex_host',
          status: 'unknown',
        },
        {
          agentId: 'agent_opencode_host',
          status: 'unknown',
        },
        {
          agentId: 'agent_opencode_server',
          status: 'unknown',
        },
      ],
      recentThreads: [
        {
          id: 'th_demo',
        },
      ],
    });
  });

  it('counts providers from the runtime registry', async () => {
    const app = createApp({
      providerRegistry: new ProviderRegistry([
        {
          baseUrl: 'https://api.example.com/v1',
          displayName: 'Example',
          id: 'example',
          kind: 'direct',
          models: ['example-model'],
          secretRef: 'env:EXAMPLE_API_KEY',
        },
      ]),
      store: createDemoStore(),
    });
    const res = await app.request('/api/app/workspaces/ws_demo/dashboard');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.counts.providerCount).toBe(1);
  });

  it('summarizes active work, completions, and attention-needed items', async () => {
    const store = createDemoStore();
    const activeThread = store.createThread('ws_demo', 'Active worker turn');
    const activeTurn = store.createTurn('ws_demo', activeThread.id, 'Run active worker turn');
    const attentionThread = store.createThread('ws_demo', 'Approval handoff');
    const attentionTurn = store.createTurn('ws_demo', attentionThread.id, 'Ask before writing');
    const completedThread = store.createThread('ws_demo', 'Completed review');
    const completedTurn = store.createTurn('ws_demo', completedThread.id, 'Finish review');
    const completedAt = new Date().toISOString();

    store.updateTurn(activeTurn.id, { agentId: 'agent_codex_host' });

    const attentionItem = store.createItem({
      id: 'it_workspace_attention',
      workspaceId: 'ws_demo',
      threadId: attentionThread.id,
      turnId: attentionTurn.id,
      type: 'approval-request',
      status: 'in_progress',
      approvalRequestId: 'ap_workspace_attention',
      title: 'Approve file edit',
      description: 'Worker needs permission before editing files.',
      kind: 'permission',
      createdAt: attentionTurn.startedAt ?? completedAt,
      completedAt: null,
    });
    store.updateTurn(attentionTurn.id, {
      status: 'awaiting_human',
      humanGate: {
        kind: 'approval',
        approvalRequestId: 'ap_workspace_attention',
        itemId: attentionItem.id,
      },
    });
    store.updateTurn(completedTurn.id, { status: 'completed', completedAt });
    store.createArtifact({
      id: 'ar_workspace_completion',
      workspaceId: 'ws_demo',
      threadId: completedThread.id,
      turnId: completedTurn.id,
      kind: 'summary',
      title: 'Review summary',
      status: 'ready',
      summary: 'Review is complete.',
      version: 1,
      content: { format: 'markdown', body: 'Review is complete.' },
      createdAt: completedAt,
      updatedAt: completedAt,
    });
    store.createAgentSession({
      id: `session_${activeThread.id}`,
      agentId: 'agent_codex_host',
      workspaceId: 'ws_demo',
      threadId: activeThread.id,
      status: 'busy',
      message: null,
      createdAt: activeTurn.startedAt ?? completedAt,
      updatedAt: activeTurn.startedAt ?? completedAt,
    });
    const app = createApp({ store });
    const res = await app.request('/api/app/workspaces/ws_demo/dashboard');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      activeWork: [
        {
          threadId: activeThread.id,
          title: 'Active worker turn',
          status: 'running',
          mode: 'automation',
          agentId: 'agent_codex_host',
        },
      ],
      recentCompletions: [
        {
          threadId: completedThread.id,
          turnId: completedTurn.id,
          artifactCount: 1,
        },
      ],
      attentionNeeded: [
        {
          threadId: attentionThread.id,
          turnId: attentionTurn.id,
          kind: 'approval',
          itemId: 'it_workspace_attention',
          summary: 'Approve file edit',
        },
      ],
    });
  });
});

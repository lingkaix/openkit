import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import { createDemoStore } from './test-support/demo-store.js';

describe('thread dashboard app API', () => {
  it('returns thread info, turn history, artifacts, and composer context', async () => {
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Dashboard thread');
    const turn = store.createTurn('ws_demo', thread.id, 'Run dashboard turn');
    const agentSessionId = `session_sim_turn_${turn.id}`;
    store.createAgentSession({
      id: agentSessionId,
      agentId: 'agent_codex_host',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      status: 'busy',
      message: null,
      createdAt: turn.startedAt ?? new Date().toISOString(),
      updatedAt: turn.startedAt ?? new Date().toISOString(),
    });
    store.updateTurn(turn.id, {
      agentId: 'agent_codex_host',
      agentProfileId: 'default',
      agentSessionId,
    });
    const artifact = store.createArtifact({
      id: 'ar_thread_dashboard',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
      kind: 'summary',
      title: 'Thread summary',
      status: 'ready',
      summary: 'A thread artifact',
      version: 1,
      content: { format: 'markdown', body: 'A thread artifact' },
      createdAt: turn.startedAt ?? new Date().toISOString(),
      updatedAt: turn.startedAt ?? new Date().toISOString(),
    });
    const app = createApp({ store, turnExecutor: new SimulatedTurnExecutor() });

    const res = await app.request(`/api/app/workspaces/ws_demo/threads/${thread.id}/dashboard`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      thread: {
        id: thread.id,
        name: 'Dashboard thread',
      },
      activeSession: {
        id: agentSessionId,
        status: 'busy',
        message: null,
      },
      turns: [{ id: turn.id, status: 'running' }],
      artifacts: [{ id: artifact.id, title: 'Thread summary' }],
      composer: {
        disabled: false,
        defaultModelId: 'model_codex',
        defaultAgentId: 'agent_codex_host',
      },
      itemLog: {
        href: `/api/app/workspaces/ws_demo/threads/${thread.id}/items`,
      },
    });
  });

  it('does not borrow lineage from a different persisted agent session', async () => {
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Fresh simulator session');
    store.createTurn('ws_demo', thread.id, 'Run fresh simulator turn');
    store.createAgentSession({
      id: 'session_old',
      agentId: 'agent_codex_host',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      status: 'busy',
      message: null,
      configVersion: 7,
      workspaceRoots: [
        {
          access: 'read-write',
          id: 'old-root',
          sourceKind: 'host-dir',
          sourcePath: '/old/root',
          workerPath: '/workspace/old-root',
        },
      ],
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    });
    const app = createApp({ store, turnExecutor: new SimulatedTurnExecutor() });

    const res = await app.request(`/api/app/workspaces/ws_demo/threads/${thread.id}/dashboard`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      activeSession: {
        id: `session_sim_${thread.id}`,
        configVersion: null,
        workspaceRoots: [],
      },
    });
  });

  it('returns product work status for the thread workbench', async () => {
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Routed worker thread');
    const turn = store.createTurn('ws_demo', thread.id, 'Run delegated work');
    const timestamp = turn.startedAt ?? new Date().toISOString();

    const approvalItem = store.createItem({
      id: 'it_thread_approval',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
      type: 'approval-request',
      status: 'in_progress',
      approvalRequestId: 'ap_thread_dashboard',
      title: 'Approve shell command',
      description: 'The worker needs permission to continue.',
      kind: 'permission',
      createdAt: timestamp,
      completedAt: null,
    });
    store.updateTurn(turn.id, {
      agentId: 'agent_codex_host',
      status: 'awaiting_human',
      humanGate: {
        kind: 'approval',
        approvalRequestId: 'ap_thread_dashboard',
        itemId: approvalItem.id,
      },
    });
    store.createItem({
      id: 'it_thread_question',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
      type: 'user-input-request',
      status: 'in_progress',
      userInputRequestId: 'ui_thread_dashboard',
      prompt: 'Choose the implementation path.',
      questions: [
        {
          id: 'path',
          header: 'Path',
          question: 'Which path should the worker use?',
          options: null,
          isOther: true,
          isSecret: false,
        },
      ],
      createdAt: timestamp,
      completedAt: null,
    });
    store.createArtifact({
      id: 'ar_thread_status',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
      kind: 'summary',
      title: 'Latest artifact',
      status: 'draft',
      summary: 'Current delegated output.',
      version: 1,
      content: { format: 'markdown', body: 'Current delegated output.' },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const app = createApp({ store, turnExecutor: new SimulatedTurnExecutor() });
    const res = await app.request(`/api/app/workspaces/ws_demo/threads/${thread.id}/dashboard`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      workStatus: {
        currentMode: 'automation',
        selectedAgentId: 'agent_codex_host',
        activeTurnStatus: 'awaiting_human',
        pendingApprovalCount: 1,
        pendingQuestionCount: 1,
        latestArtifact: {
          id: 'ar_thread_status',
          title: 'Latest artifact',
        },
        routing: {
          decision: 'worker_turn',
          selectedAgentId: 'agent_codex_host',
          requiredUserAction: 'Respond to the pending approval and question.',
        },
      },
    });
  });
});

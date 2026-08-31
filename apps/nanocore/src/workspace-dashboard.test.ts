import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { ensureLocalUser } from './auth/identity.js';
import { ProviderRegistry } from './providers/registry.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

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
        providerCount: 1,
      },
      defaultContext: {
        agentId: null,
      },
      agentHealth: [],
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
    const activeTurn = store.createTurn('ws_demo', activeThread.id, 'Run active worker turn', {
      kind: 'user',
      id: 'user_local',
    });
    const attentionThread = store.createThread('ws_demo', 'Approval handoff');
    const attentionTurn = store.createTurn('ws_demo', attentionThread.id, 'Ask before writing', {
      kind: 'user',
      id: 'user_local',
    });
    const completedThread = store.createThread('ws_demo', 'Completed review');
    const completedTurn = store.createTurn('ws_demo', completedThread.id, 'Finish review', {
      kind: 'user',
      id: 'user_local',
    });
    const completedAt = new Date().toISOString();
    const artifactRequestId = 'artifact-create-workspace-completion';
    const artifactBody = 'Review is complete.';

    store.updateTurn(activeTurn.id, { agentId: 'agent_codex_host' });

    const approval = store.createApproval({
      id: 'ap_workspace_attention',
      workspaceId: 'ws_demo',
      threadId: attentionThread.id,
      turnId: attentionTurn.id,
      kind: 'permission',
      status: 'pending',
      title: 'Approve file edit',
      description: 'Worker needs permission before editing files.',
      createdAt: attentionTurn.startedAt ?? completedAt,
      resolvedAt: null,
    });
    const attentionItem = store.createItem({
      id: 'it_workspace_attention',
      workspaceId: 'ws_demo',
      threadId: attentionThread.id,
      turnId: attentionTurn.id,
      type: 'approval-request',
      status: 'completed',
      approvalRequestId: approval.id,
      title: approval.title,
      description: approval.description,
      kind: approval.kind,
      createdAt: attentionTurn.startedAt ?? completedAt,
      completedAt: attentionTurn.startedAt ?? completedAt,
    });
    store.updateTurn(attentionTurn.id, {
      status: 'awaiting_human',
      humanGate: {
        kind: 'approval',
        approvalRequestId: approval.id,
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
      content: { format: 'markdown', body: artifactBody },
      contentDigest: `sha256:${createHash('sha256').update(artifactBody, 'utf8').digest('hex')}`,
      lastMutationRequestId: artifactRequestId,
      origin: {
        kind: 'turn-output',
        threadId: completedThread.id,
        turnId: completedTurn.id,
        requestId: artifactRequestId,
      },
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

  it('does not surface secret pending decision items as actionable', async () => {
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Invalid dashboard attention');
    const timestamp = '2026-07-19T00:00:00.000Z';
    const secretTurn = store.createTurn('ws_demo', thread.id, 'Secret question', {
      kind: 'user',
      id: 'user_local',
    });
    const secretItem = store.createItem({
      id: 'it_workspace_secret',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: secretTurn.id,
      type: 'user-input-request',
      status: 'completed',
      responsibleUserId: 'user_local',
      userInputRequestId: 'ui_workspace_secret',
      prompt: 'Enter a secret.',
      questions: [
        {
          id: 'secret',
          header: 'Secret',
          question: 'What is the secret?',
          options: null,
          isOther: true,
          isSecret: true,
        },
      ],
      createdAt: timestamp,
      completedAt: timestamp,
    });
    store.updateTurn(secretTurn.id, {
      status: 'awaiting_human',
      humanGate: {
        kind: 'user-input',
        userInputRequestId: secretItem.userInputRequestId,
        itemId: secretItem.id,
      },
    });
    const app = createApp({ store });

    const response = await app.request('/api/app/workspaces/ws_demo/dashboard');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ attentionNeeded: [] });
  });

  it('hides exact decision rows from readonly actors while preserving shared failures', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-dashboard-readonly-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: 'ws_demo',
    });
    const store = createDemoStore({ dataRoot });
    const thread = store.createThread('ws_demo', 'Readonly attention');
    const approvalTurn = store.createTurn('ws_demo', thread.id, 'Request approval', {
      kind: 'user',
      id: 'user_local',
    });
    const timestamp = '2026-07-19T00:00:00.000Z';
    const approval = store.createApproval({
      id: 'ap_workspace_readonly',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: approvalTurn.id,
      kind: 'permission',
      status: 'pending',
      title: 'Readonly approval',
      description: 'Readonly actors cannot respond.',
      createdAt: timestamp,
      resolvedAt: null,
    });
    const approvalItem = store.createItem({
      id: 'it_workspace_readonly',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: approvalTurn.id,
      type: 'approval-request',
      status: 'completed',
      approvalRequestId: approval.id,
      title: approval.title,
      description: approval.description,
      kind: approval.kind,
      createdAt: timestamp,
      completedAt: timestamp,
    });
    store.updateTurn(approvalTurn.id, {
      status: 'awaiting_human',
      humanGate: {
        kind: 'approval',
        approvalRequestId: approval.id,
        itemId: approvalItem.id,
      },
    });
    const failedTurn = store.createTurn('ws_demo', thread.id, 'Shared failure', {
      kind: 'user',
      id: 'user_local',
    });
    store.updateTurn(failedTurn.id, {
      completedAt: timestamp,
      error: { code: 'worker_failed', message: 'Shared worker failure.' },
      status: 'failed',
    });
    const readonlyToken = createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2999-01-01T00:00:00.000Z',
      ownerUserId: 'user_local',
      scope: 'workspace-readonly',
      workspaceIds: ['ws_demo'],
    });
    const app = createApp({
      auth: {
        api: { getSession: async () => null },
        handler: async () => new Response(null, { status: 404 }),
      },
      coreDb,
      dataRoot,
      mode: 'server',
      store,
    });

    try {
      const response = await app.request('/api/app/workspaces/ws_demo/dashboard', {
        headers: { authorization: `Bearer ${readonlyToken.secret}` },
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        attentionNeeded: [
          {
            threadId: thread.id,
            turnId: failedTurn.id,
            kind: 'failed',
            itemId: null,
            summary: 'Shared worker failure.',
          },
        ],
      });
    } finally {
      coreDb.sqlite.close();
    }
  });
});

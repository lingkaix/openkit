import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { ensureLocalUser } from './auth/identity.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createDemoStore } from './test-support/demo-store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

describe('thread dashboard app API', () => {
  it('denies a Thread whose durable owner is not the authorized path Workspace', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-thread-dashboard-lineage-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    const foreignWorkspace = store.createWorkspace('Foreign Workspace');
    const foreignThread = store.createThread(foreignWorkspace.id, 'Foreign Thread');
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: 'ws_demo',
    });
    const app = createApp({ coreDb, dataRoot, store });

    try {
      const response = await app.request(
        `/api/app/workspaces/ws_demo/threads/${foreignThread.id}/dashboard`
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('returns thread info, turn history, artifacts, and composer context', async () => {
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Dashboard thread');
    const turn = store.createTurn('ws_demo', thread.id, 'Run dashboard turn', {
      kind: 'user',
      id: 'user_local',
    });
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
      contentDigest: `sha256:${createHash('sha256')
        .update('A thread artifact', 'utf8')
        .digest('hex')}`,
      lastMutationRequestId: 'thread-dashboard-artifact-1',
      origin: {
        kind: 'turn-output',
        threadId: thread.id,
        turnId: turn.id,
        requestId: 'thread-dashboard-artifact-1',
      },
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
        defaultModelId: null,
        defaultAgentId: null,
      },
      itemLog: {
        href: `/api/app/workspaces/ws_demo/threads/${thread.id}/items`,
      },
    });
  });

  it('does not borrow lineage from a different persisted agent session', async () => {
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Fresh simulator session');
    store.createTurn('ws_demo', thread.id, 'Run fresh simulator turn', {
      kind: 'user',
      id: 'user_local',
    });
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

  it('hides pending decision affordances from a readonly actor while preserving shared status', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-thread-dashboard-attention-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    const thread = store.createThread('ws_demo', 'Actor-scoped dashboard');
    const approvalTurn = store.createTurn('ws_demo', thread.id, 'Request approval', {
      kind: 'user',
      id: 'user_local',
    });
    const approval = store.createApproval({
      id: 'ap_dashboard_actor_scoped',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: approvalTurn.id,
      kind: 'permission',
      status: 'pending',
      title: 'Approve dashboard work',
      description: 'A readonly actor cannot respond.',
      createdAt: '2026-07-19T00:00:00.000Z',
      resolvedAt: null,
    });
    const approvalItem = store.createItem({
      id: 'it_dashboard_actor_approval',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: approvalTurn.id,
      type: 'approval-request',
      status: 'completed',
      approvalRequestId: approval.id,
      title: approval.title,
      description: approval.description,
      kind: approval.kind,
      createdAt: '2026-07-19T00:00:00.000Z',
      completedAt: '2026-07-19T00:00:00.000Z',
    });
    store.updateTurn(approvalTurn.id, {
      agentId: 'agent_codex_host',
      status: 'awaiting_human',
      humanGate: {
        kind: 'approval',
        approvalRequestId: approval.id,
        itemId: approvalItem.id,
      },
    });
    const questionTurn = store.createTurn('ws_demo', thread.id, 'Request responsible input', {
      kind: 'user',
      id: 'user_responsible',
    });
    const questionItem = store.createItem({
      id: 'it_dashboard_actor_question',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: questionTurn.id,
      type: 'user-input-request',
      status: 'completed',
      responsibleUserId: 'user_responsible',
      userInputRequestId: 'ui_dashboard_actor_scoped',
      prompt: 'Provide the responsible input.',
      questions: [
        {
          id: 'choice',
          header: 'Choice',
          question: 'Which path should the worker use?',
          options: null,
          isOther: true,
          isSecret: false,
        },
      ],
      createdAt: '2026-07-19T00:01:00.000Z',
      completedAt: '2026-07-19T00:01:00.000Z',
    });
    store.updateTurn(questionTurn.id, {
      agentId: 'agent_codex_host',
      status: 'awaiting_human',
      humanGate: {
        kind: 'user-input',
        userInputRequestId: questionItem.userInputRequestId,
        itemId: questionItem.id,
      },
    });
    const failedTurn = store.createTurn('ws_demo', thread.id, 'Preserve shared failure', {
      kind: 'user',
      id: 'user_local',
    });
    store.updateTurn(failedTurn.id, {
      agentId: 'agent_codex_host',
      completedAt: '2026-07-19T00:02:00.000Z',
      error: { code: 'worker_failed', message: 'Shared worker failure.' },
      status: 'failed',
    });

    const now = Date.now();
    coreDb.sqlite
      .prepare(
        `INSERT INTO users (
          id, display_name, email, email_verified, created_at, updated_at, kind, status, disabled_at
        ) VALUES ('user_responsible', 'Responsible', 'responsible@example.com', false, ?, ?, 'human', 'active', NULL)`
      )
      .run(now, now);
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: 'ws_demo',
    });
    const timestamp = '2026-07-19T00:00:00.000Z';
    coreDb.sqlite
      .prepare(
        `INSERT INTO workspace_members (
          workspace_id, user_id, status, access_level, invitation_id,
          joined_at, removed_at, revision, created_at, updated_at
        ) VALUES ('ws_demo', 'user_responsible', 'active', 'editor', NULL, ?, NULL, 1, ?, ?)`
      )
      .run(timestamp, timestamp, timestamp);
    const readonlyToken = createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2999-01-01T00:00:00.000Z',
      ownerUserId: 'user_responsible',
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
      turnExecutor: new SimulatedTurnExecutor(),
    });

    try {
      const response = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/dashboard`,
        { headers: { authorization: `Bearer ${readonlyToken.secret}` } }
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        turns: expect.arrayContaining([
          expect.objectContaining({ id: approvalTurn.id, status: 'awaiting_human' }),
          expect.objectContaining({ id: questionTurn.id, status: 'awaiting_human' }),
          expect.objectContaining({ id: failedTurn.id, status: 'failed' }),
        ]),
        workStatus: {
          pendingApprovalCount: 0,
          pendingQuestionCount: 0,
          routing: { requiredUserAction: null },
        },
        composer: { disabled: true },
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('returns product work status for the thread workbench', async () => {
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Routed worker thread');
    const approvalTurn = store.createTurn('ws_demo', thread.id, 'Run delegated work', {
      kind: 'user',
      id: 'user_local',
    });
    const timestamp = approvalTurn.startedAt ?? new Date().toISOString();
    const approval = store.createApproval({
      id: 'ap_thread_dashboard',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: approvalTurn.id,
      kind: 'permission',
      status: 'pending',
      title: 'Approve shell command',
      description: 'The worker needs permission to continue.',
      createdAt: timestamp,
      resolvedAt: null,
    });

    const approvalItem = store.createItem({
      id: 'it_thread_approval',
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
      agentId: 'agent_codex_host',
      status: 'awaiting_human',
      humanGate: {
        kind: 'approval',
        approvalRequestId: approval.id,
        itemId: approvalItem.id,
      },
    });
    const questionTurn = store.createTurn('ws_demo', thread.id, 'Ask for input', {
      kind: 'user',
      id: 'user_local',
    });
    const questionItem = store.createItem({
      id: 'it_thread_question',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: questionTurn.id,
      type: 'user-input-request',
      status: 'completed',
      responsibleUserId: 'user_local',
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
      completedAt: timestamp,
    });
    store.updateTurn(questionTurn.id, {
      agentId: 'agent_codex_host',
      status: 'awaiting_human',
      humanGate: {
        kind: 'user-input',
        userInputRequestId: questionItem.userInputRequestId,
        itemId: questionItem.id,
      },
    });
    store.createArtifact({
      id: 'ar_thread_status',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: questionTurn.id,
      kind: 'summary',
      title: 'Latest artifact',
      status: 'draft',
      summary: 'Current delegated output.',
      version: 1,
      content: { format: 'markdown', body: 'Current delegated output.' },
      contentDigest: `sha256:${createHash('sha256')
        .update('Current delegated output.', 'utf8')
        .digest('hex')}`,
      lastMutationRequestId: 'thread-dashboard-status-artifact-1',
      origin: {
        kind: 'turn-output',
        threadId: thread.id,
        turnId: questionTurn.id,
        requestId: 'thread-dashboard-status-artifact-1',
      },
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

  it('does not count ungated or duplicate-question decision items', async () => {
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Invalid decision items');
    const timestamp = '2026-07-19T00:00:00.000Z';
    const approvalTurn = store.createTurn('ws_demo', thread.id, 'Ungated approval', {
      kind: 'user',
      id: 'user_local',
    });
    const approval = store.createApproval({
      id: 'ap_thread_dashboard_ungated',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: approvalTurn.id,
      kind: 'permission',
      status: 'pending',
      title: 'Ungated approval',
      description: 'This request has no active Gate.',
      createdAt: timestamp,
      resolvedAt: null,
    });
    store.createItem({
      id: 'it_thread_dashboard_ungated',
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
    const duplicateTurn = store.createTurn('ws_demo', thread.id, 'Malformed question', {
      kind: 'user',
      id: 'user_local',
    });
    const duplicateItem = store.createItem({
      id: 'it_thread_dashboard_duplicate',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: duplicateTurn.id,
      type: 'user-input-request',
      status: 'completed',
      responsibleUserId: 'user_local',
      userInputRequestId: 'ui_thread_dashboard_duplicate',
      prompt: 'Choose twice.',
      questions: [
        {
          id: 'duplicate',
          header: 'First',
          question: 'What is the first choice?',
          options: null,
          isOther: true,
          isSecret: false,
        },
        {
          id: 'duplicate',
          header: 'Second',
          question: 'What is the second choice?',
          options: null,
          isOther: true,
          isSecret: false,
        },
      ],
      createdAt: timestamp,
      completedAt: timestamp,
    });
    store.updateTurn(duplicateTurn.id, {
      agentId: 'agent_codex_host',
      status: 'awaiting_human',
      humanGate: {
        kind: 'user-input',
        userInputRequestId: duplicateItem.userInputRequestId,
        itemId: duplicateItem.id,
      },
    });
    const app = createApp({ store, turnExecutor: new SimulatedTurnExecutor() });

    const response = await app.request(
      `/api/app/workspaces/ws_demo/threads/${thread.id}/dashboard`
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      workStatus: {
        pendingApprovalCount: 0,
        pendingQuestionCount: 0,
        routing: { requiredUserAction: null },
      },
    });
  });
});

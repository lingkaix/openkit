import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { ProviderRegistry } from './providers/registry.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createAppWithWorkspaceAuthority as createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { testEntityId } from './test-support/entity-ids.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { operationRequest } from './test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

describe('workspace dashboard app API', () => {
  it('returns aggregate workspace status and default execution context', async () => {
    const app = createApp({ store: createDemoStore() });
    const res = await app.request(
      ...operationRequest('workspace.dashboard', {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      workspace: {
        id: 'ws_00000000-0000-7000-8000-000000000001',
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
          id: 'th_00000000-0000-7000-8000-000000000001',
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
    const res = await app.request(
      ...operationRequest('workspace.dashboard', {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.counts.providerCount).toBe(1);
  });

  it('summarizes active work, completions, and attention-needed items', async () => {
    const store = createDemoStore();
    const activeThread = store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Active worker turn'
    );
    const activeTurn = store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      activeThread.id,
      'Run active worker turn',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const attentionThread = store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Approval handoff'
    );
    const attentionTurn = store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      attentionThread.id,
      'Ask before writing',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const completedThread = store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Completed review'
    );
    const completedTurn = store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      completedThread.id,
      'Finish review',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const completedAt = new Date().toISOString();
    const artifactRequestId = 'artifact-create-workspace-completion';
    const artifactBody = 'Review is complete.';

    store.updateTurn(activeTurn.id, { agentId: 'agent_codex_host' });

    const approval = store.createApproval({
      id: 'ap_workspace_attention',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: attentionThread.id,
      turnId: attentionTurn.id,
      kind: 'permission',
      status: 'pending',
      title: 'Approve file edit',
      description: 'Worker needs permission before editing files.',
      createdAt: attentionTurn.startedAt ?? completedAt,
      resolvedAt: null,
    });
    store.createItem({
      id: 'it_00000000-0000-7820-915a-25ba0ed16670',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
    store.createArtifact({
      id: 'ar_00000000-0000-7857-9177-e94eebaad31f',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
    store.updateTurn(completedTurn.id, { status: 'completed', completedAt });
    store.createAgentSession({
      id: testEntityId('as', `session_${activeThread.id}`),
      agentId: 'agent_codex_host',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: activeThread.id,
      status: 'busy',
      message: null,
      createdAt: activeTurn.startedAt ?? completedAt,
      updatedAt: activeTurn.startedAt ?? completedAt,
    });
    const app = createApp({ store });
    const res = await app.request(
      ...operationRequest('workspace.dashboard', {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    );

    expect(res.status).toBe(200);
    const dashboard = await res.json();
    expect(dashboard.activeWork).toHaveLength(2);
    expect(dashboard.activeWork).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          threadId: activeThread.id,
          title: 'Active worker turn',
          status: 'running',
          agentId: 'agent_codex_host',
        }),
        expect.objectContaining({
          threadId: attentionThread.id,
          title: 'Approval handoff',
          status: 'running',
          agentId: null,
        }),
      ])
    );
    for (const row of dashboard.activeWork) expect(row).not.toHaveProperty('mode');
    expect(dashboard).toMatchObject({
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
          itemId: 'it_00000000-0000-7820-915a-25ba0ed16670',
          summary: 'Approve file edit',
        },
      ],
    });
  });

  it.each([
    {
      name: 'first newest exact-Turn output ahead of a newer Thread output',
      artifacts: [
        ['ar_00000000-0000-7b23-9848-63d3724f90d8', 'exact', 0, 'Old exact summary'],
        ['ar_00000000-0000-72bf-b345-fe18766828bb', 'exact', 2, 'First newest exact summary'],
        ['ar_00000000-0000-7712-9c75-5be99f3b4575', 'exact', 2, 'Second newest exact summary'],
        ['ar_00000000-0000-76d7-aef5-ff5634adaa8b', 'other', 3, 'Newer Thread summary'],
      ],
      summary: 'First newest exact summary',
      count: 3,
    },
    {
      name: 'first newest Thread output when the completed Turn has none',
      artifacts: [
        ['ar_00000000-0000-79d3-a354-4465791ffe5f', 'other', 0, 'Old Thread summary'],
        ['ar_00000000-0000-7a7a-bc25-bdab6591bcb1', 'other', 2, 'First newest Thread summary'],
        ['ar_00000000-0000-7c6d-bb47-5eae545b3a52', 'other', 2, 'Second newest Thread summary'],
      ],
      summary: 'First newest Thread summary',
      count: 0,
    },
    {
      name: 'Thread preview for an empty inventory',
      artifacts: [],
      summary: 'Thread preview',
      count: 0,
    },
    {
      name: 'Thread preview for a null exact summary rather than another Artifact',
      artifacts: [
        ['ar_00000000-0000-738f-a8f0-275edcf7e48b', 'exact', 0, null],
        ['ar_00000000-0000-7232-95be-4bb6040144c3', 'other', 3, 'Do not use this summary'],
      ],
      summary: 'Thread preview',
      count: 1,
    },
    {
      name: 'empty exact summary without falling back to Thread output or preview',
      artifacts: [
        ['ar_00000000-0000-78d5-8978-dba0fe6d4350', 'exact', 0, ''],
        ['ar_00000000-0000-7232-95be-4bb6040144c3', 'other', 3, 'Do not use this summary'],
      ],
      summary: '',
      count: 1,
    },
    {
      name: 'Thread preview for the newest null Thread summary rather than older output',
      artifacts: [
        ['ar_00000000-0000-79d3-a354-4465791ffe5f', 'other', 0, 'Do not use this summary'],
        ['ar_00000000-0000-704f-bdd3-e1428984a4ac', 'other', 3, null],
      ],
      summary: 'Thread preview',
      count: 0,
    },
  ] as const)('preserves completion selection: $name', async ({ artifacts, summary, count }) => {
    const store = createDemoStore();
    const thread = store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Completion selection'
    );
    const completedTurn = store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Thread preview',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const otherTurn = store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Thread preview',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    for (const [id, scope, minute, artifactSummary] of artifacts) {
      const turnId = scope === 'exact' ? completedTurn.id : otherTurn.id;
      store.createArtifact({
        id,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: thread.id,
        turnId,
        kind: 'summary',
        title: id,
        status: 'ready',
        summary: artifactSummary,
        version: 1,
        content: { format: 'markdown', body: id },
        contentDigest: `sha256:${createHash('sha256').update(id, 'utf8').digest('hex')}`,
        lastMutationRequestId: id,
        origin: { kind: 'turn-output', threadId: thread.id, turnId, requestId: id },
        createdAt: '2026-07-19T00:00:00.000Z',
        updatedAt: `2026-07-19T00:0${minute}:00.000Z`,
      });
    }
    const completedAt = '2026-07-19T00:04:00.000Z';
    store.updateTurn(completedTurn.id, { status: 'completed', completedAt });
    const app = createApp({ store });
    const res = await app.request(
      ...operationRequest('workspace.dashboard', {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recentCompletions).toEqual([
      {
        threadId: thread.id,
        title: 'Completion selection',
        turnId: completedTurn.id,
        completedAt,
        artifactCount: count,
        summary,
      },
    ]);
  });

  it('does not surface secret pending decision items as actionable', async () => {
    const store = createDemoStore();
    const thread = store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Invalid dashboard attention'
    );
    const timestamp = '2026-07-19T00:00:00.000Z';
    const secretTurn = store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Secret question',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    store.createItem({
      id: 'it_00000000-0000-7aa3-b54b-e32a25a56598',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: thread.id,
      turnId: secretTurn.id,
      type: 'user-input-request',
      status: 'completed',
      responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
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
    const app = createApp({ store });

    const response = await app.request(
      ...operationRequest('workspace.dashboard', {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    );

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
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const store = createDemoStore({ dataRoot });
    const thread = store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Readonly attention'
    );
    const approvalTurn = store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Request approval',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const timestamp = '2026-07-19T00:00:00.000Z';
    const approval = store.createApproval({
      id: 'ap_workspace_readonly',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: thread.id,
      turnId: approvalTurn.id,
      kind: 'permission',
      status: 'pending',
      title: 'Readonly approval',
      description: 'Readonly actors cannot respond.',
      createdAt: timestamp,
      resolvedAt: null,
    });
    store.createItem({
      id: 'it_00000000-0000-73b2-97a8-ad8ddcd0adb2',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
    const failedTurn = store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Shared failure',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    store.updateTurn(failedTurn.id, {
      completedAt: timestamp,
      error: { code: 'worker_failed', message: 'Shared worker failure.' },
      status: 'failed',
    });
    const readonlyToken = createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2999-01-01T00:00:00.000Z',
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      scope: 'workspace-readonly',
      workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
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
      const response = await app.request(
        ...operationRequest(
          'workspace.dashboard',
          { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
          {
            headers: { authorization: `Bearer ${readonlyToken.secret}` },
          }
        )
      );

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

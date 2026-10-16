import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProductTurnSchema } from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import * as database from './storage/db.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import * as workObservations from './storage/work-observations.js';
import { createTestAgentSetup } from './test-support/agent-environment.js';
import { createAppWithWorkspaceAuthority as createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { testEntityId } from './test-support/entity-ids.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { operationRequest } from './test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

describe('thread dashboard app API', () => {
  it('projects only this Thread participants and the authenticated viewer without private profile fields', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-thread-authors-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });

    for (const [id, name] of [
      ['usr_00000000-0000-73d4-904a-d4c4b905df7c', 'Alex'],
      ['usr_00000000-0000-76a2-91eb-629d90835e80', 'Private Person'],
    ]) {
      coreDb.sqlite
        .prepare(
          `INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind, status) VALUES (?, ?, ?, 0, ?, ?, 'human', 'active')`
        )
        .run(id, name, `${id}@example.com`, Date.now(), Date.now());
    }
    const thread = store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Group conversation'
    );
    store.createTurn('ws_00000000-0000-7000-8000-000000000001', thread.id, 'My input', {
      kind: 'user',
      id: 'usr_00000000-0000-7000-8000-000000000001',
    });
    const turn = store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Other input',
      {
        kind: 'user',
        id: 'usr_00000000-0000-73d4-904a-d4c4b905df7c',
      }
    );
    store.updateTurn(turn.id, { agentId: 'agent_codex_host' });
    store.createTurn('ws_00000000-0000-7000-8000-000000000001', thread.id, 'Missing profile', {
      kind: 'user',
      id: 'usr_00000000-0000-7241-80d8-0d46cb74b40d',
    });
    const foreign = store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Unrelated conversation'
    );
    store.createTurn('ws_00000000-0000-7000-8000-000000000001', foreign.id, 'Unrelated input', {
      kind: 'user',
      id: 'usr_00000000-0000-76a2-91eb-629d90835e80',
    });
    for (const candidate of [
      ...store.listThreadTurns('ws_00000000-0000-7000-8000-000000000001', thread.id),
      ...store.listThreadTurns('ws_00000000-0000-7000-8000-000000000001', foreign.id),
    ]) {
      store.createItem({
        id: testEntityId('it', `message_${candidate.id}`),
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: candidate.threadId,
        turnId: candidate.id,
        type: 'user-message',
        status: 'completed',
        actor: candidate.triggerActor,
        text: 'Message',
        createdAt: candidate.startedAt!,
        completedAt: candidate.startedAt,
      });
    }
    const app = createApp({
      coreDb,
      dataRoot,
      store,
      agentManifests: [createTestAgentSetup().manifest],
    });
    coreDb.sqlite
      .prepare('UPDATE users SET display_name = ? WHERE id = ?')
      .run('Simon', 'usr_00000000-0000-7000-8000-000000000001');
    const openedWorkspaceDb = vi.spyOn(database, 'openWorkspaceDb');
    try {
      const response = await app.request('/api/app/operations/thread.dashboard', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: thread.id,
        }),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.viewerUserId).toBe('usr_00000000-0000-7000-8000-000000000001');
      expect(body.taskInputs).toEqual([]);
      expect(body.runtimeActivity).toEqual(
        store.listThreadTurns('ws_00000000-0000-7000-8000-000000000001', thread.id).map((turn) => ({
          turnId: turn.id,
          contentCapture: 'off',
          coverage: 'unavailable',
          entries: [],
          omittedEntryCount: 0,
        }))
      );
      expect(openedWorkspaceDb).toHaveBeenCalled();
      expect(openedWorkspaceDb.mock.results.at(-1)?.value.sqlite.open).toBe(false);
      expect(body.participants).toEqual(
        expect.arrayContaining([
          { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001', displayName: 'Simon' },
          { kind: 'user', id: 'usr_00000000-0000-73d4-904a-d4c4b905df7c', displayName: 'Alex' },
          {
            kind: 'user',
            id: 'usr_00000000-0000-7241-80d8-0d46cb74b40d',
            displayName: 'usr_00000000-0000-7241-80d8-0d46cb74b40d',
          },
          { kind: 'agent', id: 'agent_codex_host', displayName: 'Codex Agent' },
        ])
      );
      expect(body.participants).toHaveLength(4);
      expect(JSON.stringify(body.participants)).not.toContain('@example.com');
    } finally {
      openedWorkspaceDb.mockRestore();
      coreDb.sqlite.close();
    }
  });

  it('reads durable child activity with capture off and isolates corruption from real approval controls', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-thread-activity-readback-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const thread = store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Retained activity'
    );
    const turn = store.createTurn('ws_00000000-0000-7000-8000-000000000001', thread.id, 'Work', {
      kind: 'user',
      id: 'usr_00000000-0000-7000-8000-000000000001',
    });
    const workspaceDb = database.openWorkspaceDb(
      dataRoot,
      'ws_00000000-0000-7000-8000-000000000001'
    );
    try {
      const observedAt = '2026-09-22T00:00:00.000Z';
      workObservations.appendWorkObservation(workspaceDb, {
        threadId: thread.id,
        turnId: turn.id,
        bodies: [],
        observation: {
          id: 'obs_child',
          type: 'runtime.observed',
          ts: observedAt,
          obs: 'sidecar',
          payload: {
            observationId: 'obs_child',
            sourceRef: 'source_child',
            sourceSequence: 1,
            observedAt,
            fact: {
              kind: 'origin',
              runtimeOriginRef: 'origin_child',
              parentRuntimeOriginRef: 'origin_parent',
              phase: 'started',
            },
            content: { state: 'not-applicable' },
          },
        },
      });
    } finally {
      workspaceDb.sqlite.close();
    }
    const app = createApp({ coreDb, dataRoot, store });
    try {
      const response = await app.request('/api/app/operations/thread.dashboard', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: thread.id,
        }),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.runtimeActivity).toEqual([
        expect.objectContaining({
          turnId: turn.id,
          contentCapture: 'off',
          omittedEntryCount: 0,
          entries: [
            expect.objectContaining({ sequence: 1, kind: 'child-started', textTruncated: false }),
          ],
        }),
      ]);
      expect(body.runtimeActivity[0].entries[0]).not.toHaveProperty('text');
      expect(JSON.stringify(body.runtimeActivity)).not.toMatch(
        /origin_child|origin_parent|source_child/
      );
      expect(body.turns[0].status).toBe('running');
      const timestamp = '2026-09-22T00:00:01.000Z';
      const approval = store.createApproval({
        id: 'ap_activity',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: thread.id,
        turnId: turn.id,
        kind: 'permission',
        status: 'pending',
        title: 'Approve the real operation',
        description: 'Formal approval, independent of activity.',
        createdAt: timestamp,
        resolvedAt: null,
      });
      store.createItem({
        id: 'it_00000000-0000-74cd-8ec9-23e9d64367b4',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: thread.id,
        turnId: turn.id,
        type: 'approval-request',
        status: 'completed',
        approvalRequestId: approval.id,
        title: approval.title,
        description: approval.description,
        kind: approval.kind,
        createdAt: timestamp,
        completedAt: timestamp,
      });
      appendFileSync(
        join(
          dataRoot,
          'workspaces',
          'ws_00000000-0000-7000-8000-000000000001',
          'threads',
          thread.id,
          'turns',
          turn.id,
          'observations.jsonl'
        ),
        'corrupt restricted diagnostic\n'
      );
      const unavailable = await app.request('/api/app/operations/thread.dashboard', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: thread.id,
        }),
      });
      expect(unavailable.status).toBe(200);
      const unavailableBody = await unavailable.json();
      expect(unavailableBody.runtimeActivity).toEqual([
        expect.objectContaining({
          turnId: turn.id,
          coverage: 'unavailable',
          entries: [],
          omittedEntryCount: 0,
        }),
      ]);
      expect(unavailableBody.workStatus.pendingApprovalCount).toBe(1);
      expect(unavailableBody.composer.disabled).toBe(false);
      expect(unavailableBody.turns[0]).toMatchObject({ status: 'running' });
      expect(JSON.stringify(unavailableBody)).not.toContain('corrupt restricted diagnostic');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('projects only safe activity fields after Thread audience checks and bounds the storage read', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-thread-activity-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const thread = store.createThread('ws_00000000-0000-7000-8000-000000000001', 'Activity');
    const turn = store.createTurn('ws_00000000-0000-7000-8000-000000000001', thread.id, 'Work', {
      kind: 'user',
      id: 'usr_00000000-0000-7000-8000-000000000001',
    });
    const privateThread = store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Other private activity',
      undefined,
      'conversation',
      {
        visibility: 'private',
        privateOwnerUserId: 'usr_00000000-0000-73d4-904a-d4c4b905df7c',
      }
    );
    const entry = {
      sequence: 7,
      observedAt: '2026-09-22T00:00:00.000Z',
      kind: 'result' as const,
      label: 'Reported child result',
      text: 'Verified the selected change.',
      textTruncated: false,
      body: 'restricted body must not be forwarded',
      runtimeOriginRef: 'native identifier must not be forwarded',
    };
    const activity = {
      turnId: turn.id,
      contentCapture: 'on' as const,
      coverage: 'partial' as const,
      entries: [entry],
      omittedEntryCount: 4,
      bodyRef: 'restricted body reference must not be forwarded',
    };
    const read = vi
      .spyOn(workObservations, 'readThreadRuntimeActivity')
      .mockReturnValue([activity]);
    const opened = vi.spyOn(database, 'openWorkspaceDb');
    const app = createApp({
      coreDb,
      dataRoot,
      store,
      mode: 'server',
      auth: {
        api: {
          getSession: async () => ({ user: { id: 'usr_00000000-0000-7000-8000-000000000001' } }),
        },
        handler: async () => new Response(null, { status: 404 }),
      },
    });
    try {
      const denied = await app.request('/api/app/operations/thread.dashboard', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: privateThread.id,
        }),
      });
      expect(denied.status).toBe(404);
      expect(read).not.toHaveBeenCalled();
      const response = await app.request('/api/app/operations/thread.dashboard', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: thread.id,
        }),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(read).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
        threadId: thread.id,
        turnIds: [turn.id],
      });
      expect(body.runtimeActivity).toEqual([
        {
          turnId: turn.id,
          contentCapture: 'on',
          coverage: 'partial',
          omittedEntryCount: 4,
          entries: [
            {
              sequence: 7,
              observedAt: entry.observedAt,
              kind: 'result',
              label: entry.label,
              text: entry.text,
              textTruncated: false,
            },
          ],
        },
      ]);
      expect(body.turns[0].status).toBe('running');
      expect(JSON.stringify(body)).not.toContain('must not be forwarded');
      expect(opened.mock.results.at(-1)?.value.sqlite.open).toBe(false);
    } finally {
      read.mockRestore();
      opened.mockRestore();
      coreDb.sqlite.close();
    }
  });

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
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const app = createApp({ coreDb, dataRoot, store });

    try {
      const response = await app.request('/api/app/operations/thread.dashboard', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: foreignThread.id,
        }),
      });

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        code: 'not_found',
        message: 'Thread not found.',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('returns thread info, turn history, artifacts, and composer context', async () => {
    const store = createDemoStore();
    const thread = store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Dashboard thread'
    );
    const turn = store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Run dashboard turn',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const agentSessionId = testEntityId('as', `session_sim_turn_${turn.id}`);
    store.createAgentSession({
      id: agentSessionId,
      agentId: 'agent_codex_host',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
      id: 'ar_00000000-0000-7ac7-b330-01ee34662a73',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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

    const res = await app.request('/api/app/operations/thread.dashboard', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: thread.id,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('activeSession');
    expect(JSON.stringify(body)).not.toContain('agentSessionId');
    expect(body).toMatchObject({
      thread: {
        id: thread.id,
        name: 'Dashboard thread',
      },
      turns: [{ id: turn.id, status: 'running' }],
      artifacts: [{ id: artifact.id, title: 'Thread summary' }],
      composer: {
        disabled: false,
        defaultAgentId: null,
      },
      itemLog: {
        href: '/api/app/operations/thread.items',
      },
    });
  });

  it('does not expose lineage from a different persisted AgentSession', async () => {
    const store = createDemoStore();
    const thread = store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Fresh simulator session'
    );
    store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Run fresh simulator turn',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    store.createAgentSession({
      id: testEntityId('as', 'session_old'),
      agentId: 'agent_codex_host',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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

    const res = await app.request('/api/app/operations/thread.dashboard', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: thread.id,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).not.toHaveProperty('activeSession');
    expect(body.artifacts).toEqual([]);
    expect(body.workStatus.latestArtifact).toBeNull();
  });

  it('selects the first equally newest Thread Artifact without reordering the inventory', async () => {
    const store = createDemoStore();
    const thread = store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Artifact selection'
    );
    const turn = store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Select newest output',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const foreignThread = store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Other Thread'
    );
    const foreignTurn = store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      foreignThread.id,
      'Unrelated output',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const artifacts = [
      ['ar_00000000-0000-74b4-88c5-b03cd6864072', '2026-07-19T00:00:00.000Z', turn],
      ['ar_00000000-0000-7678-ac84-0dbbbf7e327e', '2026-07-19T00:02:00.000Z', turn],
      ['ar_00000000-0000-7ac0-aab4-51ff726a70b8', '2026-07-19T00:02:00.000Z', turn],
      ['ar_00000000-0000-73d7-8e3d-4d56af3ad75f', '2026-07-19T00:03:00.000Z', foreignTurn],
    ] as const;
    for (const [id, updatedAt, owner] of artifacts) {
      store.createArtifact({
        id,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: owner.threadId,
        turnId: owner.id,
        kind: 'summary',
        title: id,
        status: 'ready',
        summary: `Summary for ${id}`,
        version: 1,
        content: { format: 'markdown', body: id },
        contentDigest: `sha256:${createHash('sha256').update(id, 'utf8').digest('hex')}`,
        lastMutationRequestId: id,
        origin: { kind: 'turn-output', threadId: owner.threadId, turnId: owner.id, requestId: id },
        createdAt: '2026-07-19T00:00:00.000Z',
        updatedAt,
      });
    }
    const inventory = store.listArtifacts('ws_00000000-0000-7000-8000-000000000001');
    const app = createApp({ store, turnExecutor: new SimulatedTurnExecutor() });
    const res = await app.request('/api/app/operations/thread.dashboard', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: thread.id,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workStatus.latestArtifact).toEqual({
      id: 'ar_00000000-0000-7678-ac84-0dbbbf7e327e',
      title: 'ar_00000000-0000-7678-ac84-0dbbbf7e327e',
      status: 'ready',
      summary: 'Summary for ar_00000000-0000-7678-ac84-0dbbbf7e327e',
      updatedAt: '2026-07-19T00:02:00.000Z',
    });
    expect(body.artifacts.map((artifact: { id: string }) => artifact.id)).toEqual([
      'ar_00000000-0000-74b4-88c5-b03cd6864072',
      'ar_00000000-0000-7678-ac84-0dbbbf7e327e',
      'ar_00000000-0000-7ac0-aab4-51ff726a70b8',
    ]);
    const after = store.listArtifacts('ws_00000000-0000-7000-8000-000000000001');
    expect(after).toEqual(inventory);
    after.forEach((artifact, index) => {
      expect(artifact).toBe(inventory[index]);
    });
  });

  it('hides pending decision affordances from a readonly actor while preserving shared status', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-thread-dashboard-attention-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    const thread = store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Actor-scoped dashboard',
      undefined,
      'conversation',
      { visibility: 'workspace' }
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
    const approval = store.createApproval({
      id: 'ap_dashboard_actor_scoped',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: thread.id,
      turnId: approvalTurn.id,
      kind: 'permission',
      status: 'pending',
      title: 'Approve dashboard work',
      description: 'A readonly actor cannot respond.',
      createdAt: '2026-07-19T00:00:00.000Z',
      resolvedAt: null,
    });
    store.createItem({
      id: 'it_00000000-0000-7f72-83a7-ba302bd2b905',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
      status: 'completed',
      completedAt: '2026-07-19T00:00:00.000Z',
    });
    const questionTurn = store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Request responsible input',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7eb0-931a-b5d2be1d760f',
      }
    );
    store.createItem({
      id: 'it_00000000-0000-7f92-b6e6-35cd138b85b4',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: thread.id,
      turnId: questionTurn.id,
      type: 'user-input-request',
      status: 'completed',
      responsibleUserId: 'usr_00000000-0000-7eb0-931a-b5d2be1d760f',
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
      status: 'completed',
      completedAt: '2026-07-19T00:01:00.000Z',
    });
    const failedTurn = store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Preserve shared failure',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
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
        ) VALUES ('usr_00000000-0000-7eb0-931a-b5d2be1d760f', 'Responsible', 'responsible@example.com', false, ?, ?, 'human', 'active', NULL)`
      )
      .run(now, now);
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const timestamp = '2026-07-19T00:00:00.000Z';
    coreDb.sqlite
      .prepare(
        `INSERT INTO workspace_members (
          workspace_id, user_id, status, access_level, invitation_id,
          joined_at, removed_at, revision, created_at, updated_at
        ) VALUES ('ws_00000000-0000-7000-8000-000000000001', 'usr_00000000-0000-7eb0-931a-b5d2be1d760f', 'active', 'editor', NULL, ?, NULL, 1, ?, ?)`
      )
      .run(timestamp, timestamp, timestamp);
    const readonlyToken = createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2999-01-01T00:00:00.000Z',
      ownerUserId: 'usr_00000000-0000-7eb0-931a-b5d2be1d760f',
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
      turnExecutor: new SimulatedTurnExecutor(),
    });

    try {
      const response = await app.request('/api/app/operations/thread.dashboard', {
        ...{ headers: { authorization: `Bearer ${readonlyToken.secret}` } },
        method: 'POST',
        headers: {
          ...{ authorization: `Bearer ${readonlyToken.secret}` },
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: thread.id,
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        turns: expect.arrayContaining([
          expect.objectContaining({ id: approvalTurn.id, status: 'completed' }),
          expect.objectContaining({ id: questionTurn.id, status: 'completed' }),
          expect.objectContaining({ id: failedTurn.id, status: 'failed' }),
        ]),
        workStatus: {
          pendingApprovalCount: 0,
          pendingQuestionCount: 0,
        },
        composer: { disabled: true },
      });
      const navigation = await app.request(
        ...operationRequest(
          'conversation.navigation',
          { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
          {
            headers: { authorization: `Bearer ${readonlyToken.secret}` },
          }
        )
      );
      expect(navigation.status).toBe(200);
      const rows = (await navigation.json()).items;
      expect(
        rows.find((row: { thread: { id: string } }) => row.thread.id === thread.id)
      ).toMatchObject({ state: 'idle' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('returns product work status for the thread workbench', async () => {
    const store = createDemoStore();
    const thread = store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Routed worker thread'
    );
    const approvalTurn = store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Run delegated work',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const timestamp = approvalTurn.startedAt ?? new Date().toISOString();
    const approval = store.createApproval({
      id: 'ap_thread_dashboard',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: thread.id,
      turnId: approvalTurn.id,
      kind: 'permission',
      status: 'pending',
      title: 'Approve shell command',
      description: 'The worker needs permission to continue.',
      createdAt: timestamp,
      resolvedAt: null,
    });

    store.createItem({
      id: 'it_00000000-0000-7bf5-b660-d0ccc86e0d44',
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
    store.updateTurn(approvalTurn.id, { agentId: 'agent_codex_host' });
    const questionTurn = store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Ask for input',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    store.createItem({
      id: 'it_00000000-0000-75a6-828f-8513af34689a',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: thread.id,
      turnId: questionTurn.id,
      type: 'user-input-request',
      status: 'completed',
      responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
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
    store.updateTurn(questionTurn.id, { agentId: 'agent_codex_host' });
    store.createArtifact({
      id: 'ar_00000000-0000-735b-b1c6-b15d19a639c2',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
    const res = await app.request('/api/app/operations/thread.dashboard', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: thread.id,
      }),
    });

    expect(res.status).toBe(200);
    const dashboard = await res.json();
    const latestArtifact = {
      id: 'ar_00000000-0000-735b-b1c6-b15d19a639c2',
      title: 'Latest artifact',
      status: 'draft',
      summary: 'Current delegated output.',
      updatedAt: timestamp,
    };
    expect(dashboard).toEqual({
      viewerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      participants: [{ kind: 'agent', id: 'agent_codex_host', displayName: 'agent_codex_host' }],
      thread: store.getThread('ws_00000000-0000-7000-8000-000000000001', thread.id),
      turns: store
        .listThreadTurns('ws_00000000-0000-7000-8000-000000000001', thread.id)
        .map((turn) => ProductTurnSchema.parse(turn)),
      artifacts: [latestArtifact],
      workStatus: {
        selectedAgentId: 'agent_codex_host',
        activeTurnStatus: 'running',
        pendingApprovalCount: 1,
        pendingQuestionCount: 1,
        latestArtifact,
      },
      composer: { disabled: false, defaultAgentId: null },
      itemLog: { href: '/api/app/operations/thread.items' },
      taskInputs: [],
      pendingRequests: [],
      runtimeActivity: [approvalTurn, questionTurn].map((turn) => ({
        turnId: turn.id,
        contentCapture: 'unknown',
        coverage: 'unavailable',
        entries: [],
        omittedEntryCount: 0,
      })),
    });
  });

  it('does not count ungated or duplicate-question decision items', async () => {
    const store = createDemoStore();
    const thread = store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Invalid decision items'
    );
    const timestamp = '2026-07-19T00:00:00.000Z';
    const approvalTurn = store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Ungated approval',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const approval = store.createApproval({
      id: 'ap_thread_dashboard_ungated',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
      id: 'it_00000000-0000-7c2d-912e-4ee20b9b582b',
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
    const duplicateTurn = store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Malformed question',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    store.createItem({
      id: 'it_00000000-0000-72bf-96f3-cd99b62271df',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: thread.id,
      turnId: duplicateTurn.id,
      type: 'user-input-request',
      status: 'completed',
      responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
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
    store.updateTurn(duplicateTurn.id, { agentId: 'agent_codex_host' });
    const app = createApp({ store, turnExecutor: new SimulatedTurnExecutor() });

    const response = await app.request('/api/app/operations/thread.dashboard', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: thread.id,
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      workStatus: {
        pendingApprovalCount: 1,
        pendingQuestionCount: 0,
      },
    });
  });
});

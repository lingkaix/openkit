import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProductTurnSchema } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import * as evidenceBundles from './evidence-bundles.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import { raiseRecordedPendingRequest } from './runtime/pending-request-flow.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
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

/** Creates the real in-process Thread operation with current ordinary-user Workspace authority. */
async function ordinaryActivityFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-f1-thread-activity-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot });
  const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
  const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: actor.id, workspaceId });
  const app = createApp({
    coreDb,
    dataRoot,
    store,
    mode: 'server',
    auth: {
      api: { getSession: async () => ({ user: { id: actor.id } }) },
      handler: async () => new Response(null, { status: 404 }),
    },
  });
  return { dataRoot, coreDb, store, workspaceId, actor, app };
}

/** Publishes actual restricted assistant bytes with a deliberately independent native message reference. */
async function publishActivityBody(
  db: database.WorkspaceDb,
  threadId: string,
  turnId: string,
  messageRef: string
): Promise<void> {
  const bytes = Buffer.from('Restricted raw canary.');
  await workObservations.appendWorkObservation(db, {
    threadId,
    turnId,
    observation: {
      id: 'native-response',
      type: 'runtime.observed',
      ts: '2026-09-22T00:00:00.000Z',
      obs: 'worker-shim',
      payload: {
        observationId: 'native-response',
        sourceRef: 'native-source',
        sourceSequence: 41,
        observedAt: '2026-09-22T00:00:00.000Z',
        fact: {
          kind: 'assistant',
          runtimeOriginRef: 'native-origin',
          phase: 'completed',
          messageRef,
          representation: 'snapshot',
        },
        content: {
          state: 'expected',
          bytes: bytes.byteLength,
          sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          chunkCount: 1,
          mediaType: 'text/plain',
          boundary: 'outward-assistant-v1',
        },
      },
    },
    bodies: [{ id: 'content', bytes, mediaType: 'text/plain', boundary: 'outward-assistant-v1' }],
  });
}

describe('thread dashboard app API', () => {
  it('projects each interleaved Turn latest admitted reply without a native message association or raw read', async () => {
    const f = await ordinaryActivityFixture();
    const thread = await f.store.createThread(f.workspaceId, 'Ordinary source boundary');
    const turns: Awaited<ReturnType<typeof f.store.createTurn>>[] = [];
    turns[0] = await f.store.createTurn(f.workspaceId, thread.id, 'First', f.actor, null, {
      captureCoverage: { scope: 'server', value: 'on' },
    });
    const addReply = async (turnIndex: number, name: string, second: number) => {
      const item = {
        id: testEntityId('it', name),
        owner: { kind: 'workspace', workspaceId: f.workspaceId },
        threadId: thread.id,
        turnId: turns[turnIndex]!.id,
        type: 'assistant-message',
        status: 'completed',
        text: name,
        createdAt: `2026-09-22T00:00:${second}.000Z`,
        completedAt: `2026-09-22T00:00:${second}.000Z`,
      } as const;
      await f.store.createItem(item);
      return item;
    };
    const old = await addReply(0, 'Earlier first reply.', 10);
    const latest = await addReply(0, 'Latest first Turn ordinary canary.', 30);
    await f.store.createItem({
      id: testEntityId('it', 'later-user-input'),
      owner: { kind: 'workspace', workspaceId: f.workspaceId },
      threadId: thread.id,
      turnId: turns[0]!.id,
      type: 'user-message',
      status: 'completed',
      actor: f.actor,
      text: 'Later user message is not an assistant reply.',
      createdAt: '2026-09-22T00:00:50.000Z',
      completedAt: '2026-09-22T00:00:50.000Z',
    });
    let second: typeof old;
    let off: typeof old;
    const db = database.openWorkspaceDb(f.dataRoot, f.workspaceId);
    try {
      // Authored reply times interleave; live Core-local Turns do not.
      await publishActivityBody(db, thread.id, turns[0]!.id, old.id);
      await f.store.completeTurn(turns[0]!.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
      turns[1] = await f.store.createTurn(f.workspaceId, thread.id, 'Second', f.actor, null, {
        captureCoverage: { scope: 'server', value: 'on' },
      });
      second = await addReply(1, 'Second Turn ordinary canary.', 20);
      await publishActivityBody(db, thread.id, turns[1]!.id, latest.id);
      await f.store.completeTurn(turns[1]!.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
      turns[3] = await f.store.createTurn(f.workspaceId, thread.id, 'Capture off', f.actor, null, {
        captureCoverage: { scope: 'server', value: 'off' },
      });
      off = await addReply(3, 'Capture-off ordinary canary.', 40);
      await f.store.completeTurn(turns[3]!.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
      turns[2] = await f.store.createTurn(f.workspaceId, thread.id, 'No Item', f.actor, null, {
        captureCoverage: { scope: 'server', value: 'on' },
      });
      // Wrong native message references cannot supply ordinary excerpts or terminal proof.
      await publishActivityBody(db, thread.id, turns[2]!.id, latest.id);
    } finally {
      db.sqlite.close();
    }
    const rawRead = vi.spyOn(evidenceBundles, 'readWorkObservationBody');
    try {
      const response = await f.app.request('/api/app/operations/thread.dashboard', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: f.workspaceId, threadId: thread.id }),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect.soft(rawRead).not.toHaveBeenCalled();
      expect.soft(body.runtimeActivity).toHaveLength(4);
      for (const [index, reply] of [latest, second, undefined, off].entries()) {
        const activity = body.runtimeActivity.find(
          (entry: { turnId: string }) => entry.turnId === turns[index]!.id
        );
        expect.soft(activity).toMatchObject({
          contentCapture: index === 3 ? 'off' : 'on',
          coverage: index === 3 ? 'unavailable' : 'collecting',
          omittedEntryCount: 0,
        });
        const structural =
          index === 3
            ? []
            : [
                {
                  sequence: 1,
                  observedAt: '2026-09-22T00:00:00.000Z',
                  kind: 'result',
                  label: 'Worker: response completed',
                  textTruncated: false,
                },
              ];
        expect.soft(activity.entries).toEqual([
          ...structural,
          ...(reply
            ? [
                expect.objectContaining({
                  label: expect.stringMatching(/turn reply/i),
                  observedAt: reply.createdAt,
                  text: reply.text,
                  textTruncated: false,
                }),
              ]
            : []),
        ]);
        if (reply) {
          const excerpt = activity.entries.find(
            (entry: { text?: string }) => entry.text === reply.text
          );
          expect.soft(excerpt?.sequence).toEqual(expect.any(Number));
          if (excerpt)
            expect.soft(Number.isSafeInteger(excerpt.sequence) && excerpt.sequence > 0).toBe(true);
        }
      }
      expect
        .soft(JSON.stringify(body.runtimeActivity))
        .not.toMatch(
          /Restricted raw canary|Earlier first reply|native-source|native-origin|Later user message/
        );
      expect
        .soft(
          turns.map(
            (turn) =>
              body.turns.find((projected: { id: string }) => projected.id === turn.id)?.status
          )
        )
        .toEqual(['completed', 'completed', 'running', 'completed']);
      expect.soft(body.workStatus.pendingApprovalCount).toBe(0);
      expect.soft(body.pendingRequests).toEqual([]);
    } finally {
      rawRead.mockRestore();
      await shutdownControlStoreWorkerClient();
      f.coreDb.sqlite.close();
      rmSync(f.dataRoot, { recursive: true, force: true });
    }
  });

  it('refuses real private and foreign Thread activity before ordinary Item or raw-body projection', async () => {
    const f = await ordinaryActivityFixture();
    const privateThread = await f.store.createThread(
      f.workspaceId,
      'Other private work',
      undefined,
      'conversation',
      {
        visibility: 'private',
        privateOwnerUserId: 'usr_00000000-0000-73d4-904a-d4c4b905df7c',
      }
    );
    const foreignWorkspace = await f.store.createWorkspace('Foreign');
    const foreignThread = await f.store.createThread(foreignWorkspace.id, 'Foreign work');
    for (const [workspaceId, thread] of [
      [f.workspaceId, privateThread],
      [foreignWorkspace.id, foreignThread],
    ] as const) {
      const turn = await f.store.createTurn(
        workspaceId,
        thread.id,
        'Protected work',
        f.actor,
        null,
        {
          captureCoverage: { scope: 'server', value: 'on' },
        }
      );
      const itemId = testEntityId('it', `private-${turn.id}`);
      await f.store.createItem({
        id: itemId,
        owner: { kind: 'workspace', workspaceId },
        threadId: thread.id,
        turnId: turn.id,
        type: 'assistant-message',
        status: 'completed',
        text: 'Protected ordinary Item canary.',
        createdAt: '2026-09-22T00:00:10.000Z',
        completedAt: '2026-09-22T00:00:10.000Z',
      });
      const db = database.openWorkspaceDb(f.dataRoot, workspaceId);
      try {
        await publishActivityBody(db, thread.id, turn.id, itemId);
      } finally {
        db.sqlite.close();
      }
    }
    const activityRead = vi.spyOn(workObservations, 'readThreadRuntimeActivity');
    const rawRead = vi.spyOn(evidenceBundles, 'readWorkObservationBody');
    const itemRead = vi.spyOn(f.store, 'listThreadItems');
    try {
      for (const thread of [privateThread, foreignThread]) {
        const response = await f.app.request('/api/app/operations/thread.dashboard', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId: f.workspaceId, threadId: thread.id }),
        });
        expect(response.status).toBe(404);
        const body = await response.json();
        expect(body).toMatchObject({ code: 'not_found', message: 'Thread not found.' });
        expect(JSON.stringify(body)).not.toMatch(/Protected ordinary|Restricted raw/);
      }
      expect(activityRead).not.toHaveBeenCalled();
      expect(rawRead).not.toHaveBeenCalled();
      expect(
        itemRead.mock.calls.some(([, id]) => id === privateThread.id || id === foreignThread.id)
      ).toBe(false);
    } finally {
      activityRead.mockRestore();
      rawRead.mockRestore();
      itemRead.mockRestore();
      f.coreDb.sqlite.close();
      rmSync(f.dataRoot, { recursive: true, force: true });
    }
  });
  it('projects only this Thread participants and the authenticated viewer without private profile fields', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-thread-authors-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
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
    const thread = await store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Group conversation'
    );
    const foreign = await store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Unrelated conversation'
    );
    for (const [threadId, input, actorId, agentId] of [
      [thread.id, 'My input', 'usr_00000000-0000-7000-8000-000000000001', null],
      [thread.id, 'Missing profile', 'usr_00000000-0000-7241-80d8-0d46cb74b40d', null],
      [thread.id, 'Other input', 'usr_00000000-0000-73d4-904a-d4c4b905df7c', 'agent_codex_host'],
      [foreign.id, 'Unrelated input', 'usr_00000000-0000-76a2-91eb-629d90835e80', null],
    ] as const) {
      const candidate = await store.createTurn(
        'ws_00000000-0000-7000-8000-000000000001',
        threadId,
        input,
        { kind: 'user', id: actorId }
      );
      if (agentId) await store.updateTurn(candidate.id, { agentId });
      await store.createItem({
        id: testEntityId('it', `message_${candidate.id}`),
        owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        threadId: candidate.threadId,
        turnId: candidate.id,
        type: 'user-message',
        status: 'completed',
        actor: candidate.triggerActor,
        text: 'Message',
        createdAt: candidate.startedAt!,
        completedAt: candidate.startedAt,
      });
      if (!agentId)
        await store.completeTurn(candidate.id, {
          status: 'completed',
          completedAt: new Date().toISOString(),
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
    const store = await createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const thread = await store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Retained activity'
    );
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Work',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const workspaceDb = database.openWorkspaceDb(
      dataRoot,
      'ws_00000000-0000-7000-8000-000000000001'
    );
    try {
      const observedAt = '2026-09-22T00:00:00.000Z';
      await workObservations.appendWorkObservation(workspaceDb, {
        threadId: thread.id,
        turnId: turn.id,
        bodies: [],
        observation: {
          id: 'obs_child',
          type: 'runtime.observed',
          ts: observedAt,
          obs: 'worker-shim',
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
      const faultDb = database.openWorkspaceDb(dataRoot, approval.workspaceId);
      try {
        await raiseRecordedPendingRequest(store, faultDb.sqlite, {
          requestId: approval.id,
          workspaceId: approval.workspaceId,
          threadId: thread.id,
          raisingTurnId: turn.id,
          requestItemId: 'it_00000000-0000-74cd-8ec9-23e9d64367b4',
          kind: 'approval',
          requesterKind: 'person',
          responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
          approval: {
            kind: approval.kind,
            title: approval.title,
            description: approval.description,
          },
          now: timestamp,
        });
        await shutdownControlStoreWorkerClient();
        // Fault only the already acknowledged canonical observation, never valid native state.
        expect(
          faultDb.sqlite
            .prepare('UPDATE control_work_observations SET record_json=? WHERE turn_id=? AND id=?')
            .run(JSON.stringify({ bad: 'corrupt restricted diagnostic' }), turn.id, 'obs_child')
            .changes
        ).toBe(1);
      } finally {
        faultDb.sqlite.close();
      }
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
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
    }
  });

  it('projects only safe activity fields after Thread audience checks and bounds the storage read', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-thread-activity-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const thread = await store.createThread('ws_00000000-0000-7000-8000-000000000001', 'Activity');
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Work',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const privateThread = await store.createThread(
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
    const store = await createDemoStore({ dataRoot });
    const foreignWorkspace = await store.createWorkspace('Foreign Workspace');
    const foreignThread = await store.createThread(foreignWorkspace.id, 'Foreign Thread');
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
    const store = await createDemoStore();
    const thread = await store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Dashboard thread'
    );
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Run dashboard turn',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const agentSessionId = testEntityId('as', `session_sim_turn_${turn.id}`);
    await store.createAgentSession({
      id: agentSessionId,
      agentId: 'agent_codex_host',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: thread.id,
      status: 'busy',
      message: null,
      createdAt: turn.startedAt ?? new Date().toISOString(),
      updatedAt: turn.startedAt ?? new Date().toISOString(),
    });
    await store.updateTurn(turn.id, {
      agentId: 'agent_codex_host',
      agentProfileId: 'default',
      agentSessionId,
    });
    const artifact = await store.createArtifact({
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
    const store = await createDemoStore();
    const thread = await store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Fresh simulator session'
    );
    await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Run fresh simulator turn',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    await store.createAgentSession({
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
    const store = await createDemoStore();
    const thread = await store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Artifact selection'
    );
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Select newest output',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const foreignThread = await store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Other Thread'
    );
    const foreignTurn = await store.createTurn(
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
      await store.createArtifact({
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
    const store = await createDemoStore({ dataRoot });
    const thread = await store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Actor-scoped dashboard',
      undefined,
      'conversation',
      { visibility: 'workspace' }
    );
    const approvalTurn = await store.createTurn(
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
    await store.createItem({
      id: 'it_00000000-0000-7f72-83a7-ba302bd2b905',
      owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
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
    await store.updateTurn(approvalTurn.id, {
      agentId: 'agent_codex_host',
      status: 'completed',
      completedAt: '2026-07-19T00:00:00.000Z',
    });
    const questionTurn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Request responsible input',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7eb0-931a-b5d2be1d760f',
      }
    );
    await store.createItem({
      id: 'it_00000000-0000-7f92-b6e6-35cd138b85b4',
      owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
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
    await store.updateTurn(questionTurn.id, {
      agentId: 'agent_codex_host',
      status: 'completed',
      completedAt: '2026-07-19T00:01:00.000Z',
    });
    const failedTurn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Preserve shared failure',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    await store.updateTurn(failedTurn.id, {
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
          workspace_id, user_id, status, invitation_id,
          joined_at, removed_at, revision, created_at, updated_at
        ) VALUES ('ws_00000000-0000-7000-8000-000000000001', 'usr_00000000-0000-7eb0-931a-b5d2be1d760f', 'active', NULL, ?, NULL, 1, ?, ?)`
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
    const store = await createDemoStore();
    const thread = await store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Routed worker thread'
    );
    const approvalTurn = await store.createTurn(
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

    await store.createItem({
      id: 'it_00000000-0000-7bf5-b660-d0ccc86e0d44',
      owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
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
    await store.updateTurn(approvalTurn.id, { agentId: 'agent_codex_host' });
    const questionTurn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Ask for input',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    await store.createItem({
      id: 'it_00000000-0000-75a6-828f-8513af34689a',
      owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
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
    await store.updateTurn(questionTurn.id, { agentId: 'agent_codex_host' });
    await store.createArtifact({
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
    const store = await createDemoStore();
    const thread = await store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Invalid decision items'
    );
    const timestamp = '2026-07-19T00:00:00.000Z';
    const approvalTurn = await store.createTurn(
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
    await store.createItem({
      id: 'it_00000000-0000-7c2d-912e-4ee20b9b582b',
      owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
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
    const duplicateTurn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Malformed question',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    await store.createItem({
      id: 'it_00000000-0000-72bf-96f3-cd99b62271df',
      owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
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
    await store.updateTurn(duplicateTurn.id, { agentId: 'agent_codex_host' });
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

// Drain and stop the native fixture owner before the next test can remove or reuse its roots.
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
});

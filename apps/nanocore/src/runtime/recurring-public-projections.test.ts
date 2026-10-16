// openkit-test-platform: posix
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ListHumanAttentionResponseSchema } from '@openkit/app-api-schemas';
import { expect, it, vi } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { readPublishedTurnFileRecords } from '../storage/workspace-file-records.js';
import { createApp } from '../test-support/app.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { raiseRecordedPendingRequest } from './pending-request-flow.js';
import { readPendingRequest } from './pending-requests.js';

it('refuses uncertain initial Turns before public work projections without changing source history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recurring-public-projections-'));
  const coreDb = openCoreDb(root);
  let workspaceDb: ReturnType<typeof openWorkspaceDb> | undefined;
  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot: root });
    const workspace = store.createWorkspace('Publication inspection');
    recordWorkspaceOwnerMembership({
      coreDb,
      workspaceId: workspace.id,
      ownerUserId: 'user_local',
    });
    const thread = store.createThread(workspace.id, 'Inspect publication');
    const unrelated = store.createThread(workspace.id, 'Independent history');
    const timestamp = '2026-10-16T00:00:00.000Z';
    const actor = { kind: 'user' as const, id: 'user_local' };
    const earlier = store.createTurn(
      workspace.id,
      thread.id,
      'Ask before continuing',
      actor,
      null,
      {
        startedAt: timestamp,
      }
    );
    const question = store.createItem({
      id: 'it_public_projection_question',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: earlier.id,
      type: 'user-input-request',
      status: 'completed',
      responsibleUserId: 'user_local',
      userInputRequestId: 'ui_public_projection_question',
      prompt: 'Choose the next action.',
      questions: [
        {
          id: 'next_action',
          header: 'Action',
          question: 'Which action should run next?',
          options: null,
          isOther: true,
          isSecret: false,
        },
      ],
      createdAt: timestamp,
      completedAt: timestamp,
    });
    workspaceDb = openWorkspaceDb(root, workspace.id);
    applyScopedMigrations(workspaceDb);
    const pending = raiseRecordedPendingRequest(store, workspaceDb.sqlite, {
      requestId: question.userInputRequestId,
      workspaceId: workspace.id,
      threadId: thread.id,
      raisingTurnId: earlier.id,
      requestItemId: question.id,
      kind: 'user-input',
      requesterKind: 'assistant',
      responsibleUserId: 'user_local',
      questions: question.questions,
      questionDigest: 'public-projection-question',
      now: timestamp,
    });
    store.updateTurn(earlier.id, { status: 'completed', completedAt: timestamp });
    const unaffected = store.createTurn(workspace.id, unrelated.id, 'Retained work', actor, null, {
      startedAt: timestamp,
    });
    store.updateTurn(unaffected.id, { status: 'completed', completedAt: timestamp });
    const app = createApp({ coreDb, dataRoot: root, store });
    const invoke = (operation: string, input: unknown) =>
      app.request(`/api/app/operations/${operation}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
    const before = await invoke('attention.list', { workspaceId: workspace.id });
    expect(before.status).toBe(200);
    expect(
      ListHumanAttentionResponseSchema.parse(await before.json()).items.find(
        (row) => row.id === `question:${pending.requestId}`
      )
    ).toMatchObject({ blocking: true, turnsSince: 0 });
    for (const operation of ['workspace.dashboard', 'conversation.navigation', 'caller.read']) {
      expect((await invoke(operation, { workspaceId: workspace.id })).status).toBe(200);
    }

    const turnId = 'tu_uncertain_public_projection';
    const turnRoot = join(root, 'workspaces', workspace.id, 'threads', thread.id, 'turns', turnId);
    const turnPath = join(turnRoot, 'turn.json');
    const native = store as unknown as { persist(workspaceId: string): void };
    const persist = native.persist.bind(store);
    const failed = vi.spyOn(native, 'persist').mockImplementationOnce((workspaceId) => {
      persist(workspaceId);
      const record = JSON.parse(readFileSync(turnPath, 'utf8'));
      writeFileSync(turnPath, JSON.stringify({ ...record, agentId: 'contradictory-worker' }));
      throw new Error('Initial publication interrupted');
    });
    expect(() =>
      store.createTurn(workspace.id, thread.id, 'Inspect only', actor, null, {
        turnId,
        startedAt: '2026-10-17T00:00:00.000Z',
        status: 'pending',
        agentId: 'worker',
        executorKind: 'worker',
      })
    ).toThrow('Initial publication interrupted');
    failed.mockRestore();
    expect(store.getTurnById(turnId).agentId).toBe('worker');
    expect(readPublishedTurnFileRecords(root, workspace.id, thread.id, turnId)?.turn.agentId).toBe(
      'contradictory-worker'
    );
    const paths = [
      turnPath,
      join(turnRoot, 'items.jsonl'),
      join(
        root,
        'workspaces',
        workspace.id,
        'threads',
        thread.id,
        'turns',
        earlier.id,
        'items.jsonl'
      ),
    ];
    const bytes = paths.map((path) => readFileSync(path));

    expect((await invoke('workspace.dashboard', { workspaceId: workspace.id })).status).toBe(500);
    expect((await invoke('conversation.navigation', { workspaceId: workspace.id })).status).toBe(
      404
    );
    const caller = await invoke('caller.read', { workspaceId: workspace.id });
    expect(caller.status).toBe(503);
    expect(await caller.json()).toMatchObject({ code: 'caller_observation_unavailable' });
    expect((await invoke('attention.list', { workspaceId: workspace.id })).status).toBe(404);
    expect((await invoke('caller.read', {})).status).toBe(200);
    expect(
      (
        await invoke('turn.read', {
          workspaceId: workspace.id,
          threadId: thread.id,
          turnId: earlier.id,
        })
      ).status
    ).toBe(200);
    expect(
      (
        await invoke('thread.dashboard', {
          workspaceId: workspace.id,
          threadId: unrelated.id,
        })
      ).status
    ).toBe(200);
    expect(paths.map((path) => readFileSync(path))).toEqual(bytes);
    expect(readPendingRequest(workspaceDb.sqlite, pending.requestId)).toEqual(pending);
    expect(store.listThreadTurns(workspace.id, thread.id).map((turn) => turn.id)).toContain(turnId);
  } finally {
    vi.restoreAllMocks();
    workspaceDb?.sqlite.close();
    coreDb.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
});

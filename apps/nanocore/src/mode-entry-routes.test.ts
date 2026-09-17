import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubmitConversationResponseSchema } from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';

import { ensureLocalUser } from './auth/identity.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import type { FsStore } from './lib/store.js';
import type { TurnStartRuntimeContext } from './runtime/types.js';
import { listSchedulerAdmissionEntriesForWorkspace } from './scheduler-records.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createTestAgentSetup } from './test-support/agent-environment.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const STORAGE_REF = `wst_${'1'.repeat(32)}`;
const SELECTED_CHOICE = {
  expectedRevision: 7,
  kind: 'selected' as const,
  purpose: 'work' as const,
  reuseWorkSlotRef: `wsl_${'2'.repeat(32)}`,
  storageRef: STORAGE_REF,
};

/**
 * Completes one conversation Worker Turn without OpenShell Context Package materialization.
 *
 * `SimulatedTurnExecutor.startTurn` cannot drive this route-level fixture. `conversation.submit` upserts a worker checkpoint before `startTurn`, so a Core-backed simulator then requires `sandboxBindingRef` and prepares a real Context Package plus OpenShell backend session; without that binding it fails `recovery_required`. After launch it emits a user-input gate rather than the unique `completed` stopReason that conversation `awaitWorker` requires. This override records the scheduler start context and emits that completed outcome only.
 */
class CompletingTurnExecutor extends SimulatedTurnExecutor {
  /** Captured scheduler start contexts, including the forwarded Worker storage choice. */
  public readonly startContexts: TurnStartRuntimeContext[] = [];

  /**
   * Records the launch context and emits one unique completed Worker outcome.
   *
   * @param store Store that owns the Worker Turn.
   * @param turnId Turn to complete.
   * @param input Worker prompt retained on the assistant Item.
   * @param context Scheduler start context.
   */
  public override async startTurn(
    store: FsStore,
    turnId: string,
    input: string,
    context: TurnStartRuntimeContext = { requestId: null, workspaceRoots: [] }
  ): Promise<void> {
    this.startContexts.push(context);
    const turn = store.getTurnById(turnId);
    if (!turn.agentId) {
      throw new Error('Conversation worker turn requires a selected agent id.');
    }
    const completedAt = turn.startedAt ?? new Date().toISOString();
    const agentSessionId = context.agentSessionId ?? `session_${turnId}`;
    const agentSession = store.createAgentSession({
      id: agentSessionId,
      agentId: turn.agentId,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      status: 'idle',
      message: null,
      createdAt: completedAt,
      updatedAt: completedAt,
    });
    store.createItem({
      id: `it_assistant_${turnId}`,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId,
      type: 'assistant-message',
      status: 'completed',
      text: input,
      createdAt: completedAt,
      completedAt,
    });
    const completedTurn = store.updateTurn(turnId, {
      agentSessionId: agentSession.id,
      completedAt,
      status: 'completed',
    });
    store.emitTurnEvent(turnId, {
      event: 'turn.completed',
      requestId: context.requestId ?? null,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId,
      data: { type: 'turn-completed', stopReason: 'completed', turn: completedTurn },
    });
  }
}

/**
 * Serializes one conversation.submit body for the focused Worker storage-choice tests.
 *
 * @param input Conversation target, request identity, and optional storage choice.
 * @returns JSON request body.
 */
function conversationBody(input: {
  readonly input: string;
  readonly requestId: string;
  readonly targetRef: string;
  readonly workerStorageChoice?: typeof SELECTED_CHOICE | { readonly kind: 'fresh' };
}) {
  return JSON.stringify({
    artifactRefs: [],
    input: input.input,
    requestId: input.requestId,
    targetRef: input.targetRef,
    ...(input.workerStorageChoice ? { workerStorageChoice: input.workerStorageChoice } : {}),
  });
}

describe('conversation.submit worker storage choice', () => {
  it('rejects a supplied choice on an inapplicable target before effects', async () => {
    const store = createDemoStore();
    const workerSetup = createTestAgentSetup();
    const thread = store.createThread('ws_demo', 'Running worker');
    store.createAgentSession({
      id: 'as_ready',
      agentId: workerSetup.manifest.id,
      workspaceId: 'ws_demo',
      threadId: thread.id,
      status: 'ready',
      message: null,
      createdAt: '2026-09-16T00:00:00.000Z',
      updatedAt: '2026-09-16T00:00:00.000Z',
    });
    const app = createApp({
      agentManifests: [workerSetup.manifest],
      openKitConfig: { defaults: { defaultAgentId: workerSetup.manifest.id } },
      store,
      turnExecutor: new CompletingTurnExecutor(),
    });

    const assistantRes = await app.request(
      '/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns',
      {
        body: conversationBody({
          input: 'Answer from Assistant.',
          requestId: 'req_choice_assistant',
          targetRef: 'internal-role:assistant',
          workerStorageChoice: SELECTED_CHOICE,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }
    );
    expect(assistantRes.status).toBe(409);
    await expect(assistantRes.json()).resolves.toMatchObject({
      code: 'worker_storage_choice_not_applicable',
    });
    expect(store.listThreadTurns('ws_demo', 'th_demo')).toEqual([]);
    expect(store.listCommandRequests()).toEqual([]);

    const runningRes = await app.request(
      `/api/app/workspaces/ws_demo/threads/${thread.id}/conversation-turns`,
      {
        body: conversationBody({
          input: 'Continue this Worker.',
          requestId: 'req_choice_running',
          targetRef: `running-worker:${encodeURIComponent(thread.id)}:${encodeURIComponent(workerSetup.manifest.id)}`,
          workerStorageChoice: { kind: 'fresh' },
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }
    );
    expect(runningRes.status).toBe(409);
    await expect(runningRes.json()).resolves.toMatchObject({
      code: 'worker_storage_choice_not_applicable',
    });
    expect(store.listThreadTurns('ws_demo', thread.id)).toEqual([]);
  });

  it('forwards the exact choice on new-task-worker and conflicts when the choice changes', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-conversation-storage-choice-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    const executor = new CompletingTurnExecutor();
    const workerSetup = createTestAgentSetup();
    const app = createApp({
      agentManifests: [workerSetup.manifest],
      coreDb,
      openKitConfig: { defaults: { defaultAgentId: workerSetup.manifest.id } },
      store,
      turnExecutor: executor,
    });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: 'ws_demo',
    });
    const requestId = '0190f4c8-0000-7000-8000-000000000401';
    const input = 'Implement the focused Task Mode fix.';
    const body = conversationBody({
      input,
      requestId,
      targetRef: 'new-task-worker',
      workerStorageChoice: SELECTED_CHOICE,
    });

    try {
      const response = await app.request(
        '/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns',
        {
          body,
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      );
      expect(response.status, await response.clone().text()).toBe(202);
      const accepted = SubmitConversationResponseSchema.parse(await response.json());
      const admittedChoice = { ...SELECTED_CHOICE, goalId: null, taskId: null };
      expect(executor.startContexts[0]?.workerStorageChoice).toEqual(admittedChoice);
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          statuses: ['admitted'],
          workspaceId: 'ws_demo',
        })
      ).toEqual([expect.objectContaining({ workerStorageChoice: admittedChoice })]);

      const replay = await app.request(
        '/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns',
        {
          body,
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      );
      expect(replay.status, await replay.clone().text()).toBe(202);
      expect(SubmitConversationResponseSchema.parse(await replay.json())).toEqual(accepted);
      expect(executor.startContexts).toHaveLength(1);

      const conflict = await app.request(
        '/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns',
        {
          body: conversationBody({
            input,
            requestId,
            targetRef: 'new-task-worker',
            workerStorageChoice: { kind: 'fresh' },
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      );
      expect(conflict.status).toBe(409);
      await expect(conflict.json()).resolves.toMatchObject({ code: 'idempotency_key_conflict' });
      expect(executor.startContexts).toHaveLength(1);
    } finally {
      try {
        coreDb.sqlite.close();
      } finally {
        rmSync(dataRoot, { force: true, recursive: true });
      }
    }
  });
});

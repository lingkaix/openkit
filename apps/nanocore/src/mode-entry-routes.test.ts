import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { SubmitConversationResponseSchema } from '@openkit/app-api-schemas';
import { describe, expect, it, vi } from 'vitest';

import { ensureLocalUser } from './auth/identity.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import type { FsStore } from './lib/store.js';
import type { TurnStartRuntimeContext } from './runtime/types.js';
import { getWorkerCheckpoint } from './runtime/worker-checkpoints.js';
import { isTerminalWorkerTurnStage } from './runtime/worker-stage.js';
import {
  isTerminalLeaseStatus,
  listSchedulerAdmissionEntriesForWorkspace,
  listSchedulerSessionLeasesForTurn,
} from './scheduler-records.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { artifactReferenceItemId } from './storage/workspace-file-records.js';
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
 * Holds `startTurn` unresolved until the test releases completion.
 *
 * The conversation.submit route already reaches this executor. Holding completion lets the test observe whether that route accepts the durable Worker tuple before Worker closeout.
 */
class HoldingTurnExecutor extends CompletingTurnExecutor {
  /** Resolves once the route has invoked `startTurn`. */
  public readonly launched = Promise.withResolvers<void>();
  /** Resolves when the test allows Worker closeout. */
  public readonly completion = Promise.withResolvers<void>();
  /** Resolves after closeout finishes or fails. */
  public readonly finished = Promise.withResolvers<void>();

  /**
   * Signals launch, waits for the test release, then emits the completed Worker outcome.
   *
   * @param store Store that owns the Worker Turn.
   * @param turnId Turn to complete after release.
   * @param input Worker prompt retained on the assistant Item.
   * @param context Scheduler start context.
   */
  public override async startTurn(
    store: FsStore,
    turnId: string,
    input: string,
    context: TurnStartRuntimeContext = { requestId: null, workspaceRoots: [] }
  ): Promise<void> {
    this.launched.resolve();
    try {
      await this.completion.promise;
      await super.startTurn(store, turnId, input, context);
    } finally {
      this.finished.resolve();
    }
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
  readonly artifactRefs?: readonly {
    readonly artifactId: string;
    readonly artifactVersion: number;
  }[];
  readonly workerStorageChoice?: typeof SELECTED_CHOICE | { readonly kind: 'fresh' };
}) {
  return JSON.stringify({
    artifactRefs: input.artifactRefs ?? [],
    input: input.input,
    requestId: input.requestId,
    targetRef: input.targetRef,
    ...(input.workerStorageChoice ? { workerStorageChoice: input.workerStorageChoice } : {}),
  });
}

/**
 * Computes the canonical SHA-256 digest for exact UTF-8 Artifact content.
 *
 * @param content Exact Artifact body.
 * @returns Lowercase digest with the required prefix.
 */
function artifactDigest(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

/**
 * Creates one imported Markdown Artifact visible to conversation attachment.
 *
 * @param store Store that owns Demo Workspace artifacts.
 * @param input Artifact identity and body.
 * @returns Created Artifact.
 */
function createImportedMarkdownArtifact(
  store: FsStore,
  input: {
    readonly id: string;
    readonly title: string;
    readonly body: string;
    readonly requestId: string;
  }
): ReturnType<FsStore['createArtifact']> {
  const timestamp = new Date().toISOString();
  const contentDigest = artifactDigest(input.body);
  return store.createArtifact({
    id: input.id,
    workspaceId: 'ws_demo',
    threadId: null,
    turnId: null,
    kind: 'file',
    title: input.title,
    status: 'ready',
    summary: null,
    version: 1,
    content: { format: 'markdown', body: input.body },
    contentDigest,
    lastMutationRequestId: input.requestId,
    origin: {
      kind: 'imported',
      sourceKind: 'direct-import',
      sourceId: input.requestId,
      sourceDigest: contentDigest,
      actor: { kind: 'user', id: 'user_local' },
      requestId: input.requestId,
      recordedAt: timestamp,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

/**
 * Expected durable Artifact-reference Item fields for one accepted conversation Turn.
 *
 * @param input Artifact snapshot, conversation request id, and owning Turn.
 * @returns Matcher fields preserved through acceptance and replay.
 */
function expectedArtifactReferenceItem(input: {
  readonly artifact: ReturnType<FsStore['createArtifact']>;
  readonly requestId: string;
  readonly turnId: string;
}) {
  return {
    artifactId: input.artifact.id,
    artifactVersion: input.artifact.version,
    id: artifactReferenceItemId(input.artifact.id, input.turnId),
    lastMutationRequestId: input.requestId,
    status: 'completed',
    summary: input.artifact.summary,
    title: input.artifact.title,
    type: 'artifact-reference',
  };
}

/**
 * Waits until scheduler lease and worker checkpoint owners have finished selected-Worker closeout.
 *
 * `HoldingTurnExecutor.finished` resolves before checkpoint, lease, and Workspace DB cleanup.
 *
 * @param input Durable lineage for the accepted Worker Turn.
 */
async function waitForSelectedWorkerLoopCloseout(input: {
  readonly coreDb: ReturnType<typeof openCoreDb>;
  readonly dataRoot: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly workspaceId: string;
}): Promise<void> {
  await vi.waitFor(() => {
    const leases = listSchedulerSessionLeasesForTurn(input.coreDb, {
      threadId: input.threadId,
      turnId: input.turnId,
      workspaceId: input.workspaceId,
    });
    expect(leases.length).toBeGreaterThan(0);
    expect(leases.every((lease) => isTerminalLeaseStatus(lease.status))).toBe(true);
    const workspaceDb = openWorkspaceDb(input.dataRoot, input.workspaceId);
    try {
      const checkpoint = getWorkerCheckpoint(
        workspaceDb,
        input.workspaceId,
        input.threadId,
        input.turnId
      );
      expect(checkpoint).not.toBeNull();
      expect(isTerminalWorkerTurnStage(checkpoint!.stage)).toBe(true);
    } finally {
      workspaceDb.sqlite.close();
    }
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

describe('conversation.submit worker acceptance wait', () => {
  it('accepts the durable running Worker tuple before Worker completion is released', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-conversation-accept-before-complete-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    const executor = new HoldingTurnExecutor();
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
    const requestId = '0190f4c8-0000-7000-8000-000000000501';
    const artifact = createImportedMarkdownArtifact(store, {
      id: 'ar_submit_context',
      title: 'Task context',
      body: 'Read this material.',
      requestId,
    });
    const artifactRefs = [{ artifactId: artifact.id, artifactVersion: artifact.version }];

    const pending = app.request('/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns', {
      body: conversationBody({
        artifactRefs,
        input: 'Keep this Task Worker running.',
        requestId,
        targetRef: 'new-task-worker',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    let receivingId: string | undefined;
    let workerTurnId: string | undefined;

    try {
      await executor.launched.promise;
      const receivingThreads = store
        .listThreads('ws_demo')
        .filter((thread) => thread.id.startsWith('th_task_'));
      expect(receivingThreads).toHaveLength(1);
      const receiving = receivingThreads[0]!;
      receivingId = receiving.id;
      const workerTurn = store.listThreadTurns('ws_demo', receiving.id).at(-1);
      workerTurnId = workerTurn?.id;
      expect(workerTurn?.status).toBe('running');

      let acceptedBeforeRelease = false;
      let closedBeforeRelease = false;
      void pending.then(() => {
        acceptedBeforeRelease = true;
      });
      void executor.finished.promise.then(() => {
        closedBeforeRelease = true;
      });
      await setImmediate();
      expect(acceptedBeforeRelease).toBe(true);
      expect(closedBeforeRelease).toBe(false);

      const response = await pending;
      expect(response.status, await response.clone().text()).toBe(202);
      const accepted = SubmitConversationResponseSchema.parse(await response.json());
      expect(accepted.turn.items).toContainEqual(
        expect.objectContaining(
          expectedArtifactReferenceItem({ artifact, requestId, turnId: accepted.turn.id })
        )
      );
      expect(accepted).toMatchObject({
        outcome: 'accepted',
        receivingThreadId: receiving.id,
        turn: expect.objectContaining({ id: workerTurn!.id, status: 'running' }),
      });
      expect(
        store.getCommandRequest('conversation.submit', requestId, {
          actorId: 'user_local',
          threadId: 'th_demo',
          workspaceId: 'ws_demo',
        })
      ).toMatchObject({
        command: 'conversation.submit',
        requestId,
        response: expect.objectContaining({
          kind: 'turn',
          id: workerTurn!.id,
          conversationMetadata: expect.objectContaining({
            resultKind: 'worker-turn',
            status: 202,
          }),
        }),
      });
      const replay = await app.request(
        '/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns',
        {
          body: conversationBody({
            artifactRefs,
            input: 'Keep this Task Worker running.',
            requestId,
            targetRef: 'new-task-worker',
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      );
      expect(replay.status, await replay.clone().text()).toBe(202);
      expect(SubmitConversationResponseSchema.parse(await replay.json())).toEqual(accepted);
      expect(
        store.listWorkspaceItemRevisions('ws_demo').filter((item) => item.id === accepted.item.id)
      ).toHaveLength(1);
      store.updateItem(accepted.item.id, { title: 'Worker Turn failed' });
      const contradictedReplay = await app.request(
        '/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns',
        {
          body: conversationBody({
            artifactRefs,
            input: 'Keep this Task Worker running.',
            requestId,
            targetRef: 'new-task-worker',
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      );
      expect(contradictedReplay.status).toBe(409);
      await expect(contradictedReplay.json()).resolves.toMatchObject({
        code: 'recovery_required',
      });
      store.updateItem(accepted.item.id, { title: accepted.item.title });
      const replayAcceptedRequest = () =>
        app.request('/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns', {
          body: conversationBody({
            artifactRefs,
            input: 'Keep this Task Worker running.',
            requestId,
            targetRef: 'new-task-worker',
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        });
      const lease = listSchedulerSessionLeasesForTurn(coreDb, {
        workspaceId: 'ws_demo',
        threadId: receiving.id,
        turnId: accepted.turn.id,
      })[0]!;
      // Corrupt one persisted owner at a time while the executor stays held.
      for (const [status, recoveryState] of [
        ['planned', null],
        ['stale', null],
        ['releasing', 'needs-evidence'],
        ['active', 'awaiting-reconnect'],
      ]) {
        try {
          coreDb.sqlite
            .prepare(
              'UPDATE scheduler_session_leases SET status = ?, recovery_state = ? WHERE lease_id = ?'
            )
            .run(status, recoveryState, lease.leaseId);
          const replay = await replayAcceptedRequest();
          expect(replay.status, `${status}/${recoveryState}`).toBe(409);
          await expect(replay.json()).resolves.toMatchObject({ code: 'recovery_required' });
        } finally {
          coreDb.sqlite
            .prepare(
              'UPDATE scheduler_session_leases SET status = ?, recovery_state = ? WHERE lease_id = ?'
            )
            .run(lease.status, lease.recoveryState, lease.leaseId);
        }
      }
      const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
      const checkpoint = getWorkerCheckpoint(
        workspaceDb,
        'ws_demo',
        receiving.id,
        accepted.turn.id
      )!;
      try {
        workspaceDb.sqlite
          .prepare(
            'UPDATE worker_turn_checkpoints SET request_input_hash = ? WHERE checkpoint_id = ?'
          )
          .run('0'.repeat(64), checkpoint.checkpointId);
        const replay = await replayAcceptedRequest();
        expect(replay.status).toBe(409);
        await expect(replay.json()).resolves.toMatchObject({ code: 'recovery_required' });
      } finally {
        workspaceDb.sqlite
          .prepare(
            'UPDATE worker_turn_checkpoints SET request_input_hash = ? WHERE checkpoint_id = ?'
          )
          .run(checkpoint.requestInputHash, checkpoint.checkpointId);
        workspaceDb.sqlite.close();
      }
      expect((await replayAcceptedRequest()).status).toBe(202);
    } finally {
      executor.completion.resolve();
      await pending.catch(() => undefined);
      if (receivingId && workerTurnId) {
        await waitForSelectedWorkerLoopCloseout({
          coreDb,
          dataRoot,
          threadId: receivingId,
          turnId: workerTurnId,
          workspaceId: 'ws_demo',
        });
      }
      try {
        coreDb.sqlite.close();
      } finally {
        rmSync(dataRoot, { force: true, recursive: true });
      }
    }
  });

  it.each([
    false,
    true,
  ])('preserves failure owners after acceptance (projection failure: %s)', async (projectionFailure) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-conversation-accept-failure-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    const executor = new HoldingTurnExecutor();
    const workerSetup = createTestAgentSetup();
    const app = createApp({
      agentManifests: [workerSetup.manifest],
      coreDb,
      store,
      turnExecutor: executor,
      openKitConfig: { defaults: { defaultAgentId: workerSetup.manifest.id } },
    });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
    const requestId = '0190f4c8-0000-7000-8000-000000000502';
    const artifact = createImportedMarkdownArtifact(store, {
      id: 'ar_submit_failure_context',
      title: 'Task context',
      body: 'Keep this context.',
      requestId,
    });
    const body = conversationBody({
      input: 'Keep this Task Worker running.',
      requestId,
      targetRef: 'new-task-worker',
      artifactRefs: [{ artifactId: artifact.id, artifactVersion: artifact.version }],
    });
    const submit = () =>
      app.request('/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns', {
        body,
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
    const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pending = submit();
    let accepted: ReturnType<typeof SubmitConversationResponseSchema.parse> | undefined;
    try {
      await executor.launched.promise;
      const response = await pending;
      expect(response.status, await response.clone().text()).toBe(202);
      accepted = SubmitConversationResponseSchema.parse(await response.json());
      const turnId = accepted.turn.id;
      expect(accepted.turn.status).toBe('running');
      const reference = expectedArtifactReferenceItem({ artifact, requestId, turnId });
      expect(accepted.turn.items).toContainEqual(expect.objectContaining(reference));
      if (projectionFailure) {
        // The executor owns terminal state; only the later result projection fails.
        store.updateTurn(turnId, {
          status: 'failed',
          completedAt: new Date().toISOString(),
          error: { code: 'worker_failed', message: 'private failure detail' },
        });
        const updateItem = store.updateItem.bind(store);
        vi.spyOn(store, 'updateItem').mockImplementation((itemId, input) => {
          if (itemId === accepted!.item.id) throw new Error('private projection detail');
          return updateItem(itemId, input);
        });
      }
      executor.completion.reject(new Error('private executor detail'));
      await waitForSelectedWorkerLoopCloseout({
        coreDb,
        dataRoot,
        workspaceId: 'ws_demo',
        threadId: accepted.turn.threadId,
        turnId,
      });
      await setImmediate();
      expect(diagnostics.mock.calls).toEqual([
        ['selected_worker_closeout_failed_after_acceptance'],
      ]);
      const current = store.getTurnById(turnId);
      expect(current.status).toBe(projectionFailure ? 'failed' : 'running');
      expect(current.items).toContainEqual(expect.objectContaining(reference));
      const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
      try {
        expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', current.threadId, turnId)).toMatchObject(
          {
            stage: 'failed',
            stopReason: 'error',
            requestId,
          }
        );
      } finally {
        workspaceDb.sqlite.close();
      }
      expect(
        listSchedulerSessionLeasesForTurn(coreDb, {
          workspaceId: 'ws_demo',
          threadId: current.threadId,
          turnId,
        })
      ).toEqual([expect.objectContaining({ status: 'failed' })]);
      const replay = await submit();
      expect(replay.status).toBe(409);
      await expect(replay.json()).resolves.toMatchObject({ code: 'recovery_required' });
      expect(store.listThreadTurns('ws_demo', current.threadId)).toHaveLength(1);
    } finally {
      executor.completion.resolve();
      await pending.catch(() => undefined);
      if (accepted)
        await waitForSelectedWorkerLoopCloseout({
          coreDb,
          dataRoot,
          workspaceId: 'ws_demo',
          threadId: accepted.turn.threadId,
          turnId: accepted.turn.id,
        });
      vi.restoreAllMocks();
      coreDb.sqlite.close();
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });
});

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import {
  StartTaskModeResponseSchema,
  SubmitConversationResponseSchema,
} from '@openkit/app-api-schemas';
import { describe, expect, it, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { ensureLocalUser } from './auth/identity.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from './config/runtime-config.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import type { FsStore } from './lib/store.js';
import { ProviderRegistry } from './providers/registry.js';
import type { TurnStartRuntimeContext } from './runtime/types.js';
import * as checkpointOwners from './runtime/worker-checkpoints.js';
import { getWorkerCheckpoint } from './runtime/worker-checkpoints.js';
import * as recoveryOwners from './runtime/worker-recovery.js';
import * as loopOwners from './runtime/worker-turn-loop.js';
import * as schedulerOwners from './scheduler-records.js';
import {
  isTerminalLeaseStatus,
  listSchedulerAdmissionEntriesForWorkspace,
  listSchedulerSessionLeasesForTurn,
} from './scheduler-records.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { artifactReferenceItemId } from './storage/workspace-file-records.js';
import { createTestAgentSetup, createTestGatewayConfig } from './test-support/agent-environment.js';
import { createApp, createAppWithWorkspaceAuthority } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { operationRequest } from './test-support/operation-request.js';
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
  /** Uses the fixture-owned data root to inspect committed admission bytes. */
  public constructor(private readonly checkpointDataRoot: string) {
    super();
  }
  /** Number of actual executor entries, including unresolved launches. */
  public launches = 0;
  /** Checkpoint observed at executor entry, before completion or response delivery. */
  public checkpointAtLaunch: ReturnType<typeof getWorkerCheckpoint> = null;
  /** Exact request bytes received by the held executor before completion. */
  public readonly inputs: string[] = [];
  /** Controlled closeout failure after canonical completion. */
  public failCloseout = false;
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
    const launchedTurn = store.getTurnById(turnId);
    const checkpointDb = openWorkspaceDb(this.checkpointDataRoot, launchedTurn.workspaceId);
    try {
      this.checkpointAtLaunch = getWorkerCheckpoint(
        checkpointDb,
        launchedTurn.workspaceId,
        launchedTurn.threadId,
        turnId
      );
    } finally {
      checkpointDb.sqlite.close();
    }
    this.launches += 1;
    this.inputs.push(input);
    this.launched.resolve();
    try {
      await this.completion.promise;
      const turn = store.getTurnById(turnId);
      const at = turn.startedAt ?? new Date().toISOString();
      store.createItem({
        id: `it_user_${turnId}`,
        workspaceId: turn.workspaceId,
        threadId: turn.threadId,
        turnId,
        type: 'user-message',
        status: 'completed',
        text: input,
        actor: turn.triggerActor,
        createdAt: at,
        completedAt: at,
      });
      await super.startTurn(store, turnId, input, context);
      if (this.failCloseout) throw new Error('Controlled worker closeout failure.');
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
 * @param input Durable lineage and checkpoint outcome; successful closeout is the default, while execution exceptions preserve the admitted state.
 */
async function waitForSelectedWorkerLoopCloseout(input: {
  readonly coreDb: ReturnType<typeof openCoreDb>;
  readonly dataRoot: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly workspaceId: string;
  readonly checkpointOutcome?: 'completed' | 'preserved';
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
      expect(checkpoint!.workerSessionId).toBe(leases[0]!.agentSessionId);
      expect(checkpoint).toMatchObject(
        input.checkpointOutcome === 'preserved'
          ? { stage: 'running_worker', stopReason: null }
          : { stage: 'completed', stopReason: 'completed' }
      );
    } finally {
      workspaceDb.sqlite.close();
    }
  });
}

describe('Assistant pending input', () => {
  it('hands a clarified task to a new shared Task Thread without command receipts', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-assistant-outcome-task-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    const executor = new HoldingTurnExecutor(coreDb.dataRoot);
    const setup = createTestAgentSetup();
    const app = createApp({
      coreDb,
      dataRoot,
      store,
      agentManifests: [setup.manifest],
      turnExecutor: executor,
    });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
    try {
      const initial = await app.request(
        ...operationRequest(
          'conversation.submit',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: conversationBody({
              input: 'Help',
              requestId: '00000000-0000-4000-8000-000000000881',
              targetRef: 'internal-role:assistant',
            }),
          }
        )
      );
      expect(initial.status, await initial.clone().text()).toBe(202);
      const first = SubmitConversationResponseSchema.parse(await initial.json());
      expect(first.outcome).toBe('clarification-needed');
      const requestId = `ui_chat_clarify_${first.turn.id}`;
      const response = await app.request(
        ...operationRequest(
          'question.answer',
          { userInputRequestId: requestId },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              userInputRequestId: requestId,
              workspaceId: 'ws_demo',
              threadId: 'th_demo',
              requestId: '00000000-0000-4000-8000-000000000882',
              answers: {
                chat_clarification: [
                  'Implement a bounded README correction and run its focused tests.',
                ],
              },
            }),
          }
        )
      );
      expect(response.status, await response.clone().text()).toBe(200);
      await executor.launched.promise;
      const lease = listSchedulerAdmissionEntriesForWorkspace(coreDb, {
        workspaceId: 'ws_demo',
        statuses: ['admitted'],
      })[0]!;
      expect(executor.checkpointAtLaunch).toMatchObject({
        stage: 'running_worker',
        workerSessionId: listSchedulerSessionLeasesForTurn(coreDb, lease)[0]!.agentSessionId,
        stopReason: null,
      });
      executor.completion.resolve();
      for (
        let i = 0;
        i < 1000 &&
        !store
          .listThreadItems('ws_demo', 'th_demo')
          .some((item) => item.type === 'status' && item.title === 'Task Mode handoff');
        i++
      )
        await setImmediate();
      const handoff = store
        .listThreadItems('ws_demo', 'th_demo')
        .find((item) => item.type === 'status' && item.title === 'Task Mode handoff');
      expect(handoff).toBeDefined();
      expect(handoff!.turnId).not.toBe(first.turn.id);
      const tasks = store.listThreads('ws_demo').filter((thread) => thread.id !== 'th_demo');
      const task = tasks.find((thread) =>
        store
          .listThreadTurns('ws_demo', thread.id)
          .some((turn) => turn.agentId === setup.manifest.id)
      );
      expect(task).toMatchObject({ visibility: 'workspace' });
      expect(executor.startContexts).toHaveLength(1);
      expect(
        store.listCommandRequests().filter((receipt) => receipt.command === 'conversation.submit')
      ).toHaveLength(1);
      expect(
        store.listCommandRequests().filter((receipt) => receipt.command === 'task.start')
      ).toHaveLength(0);
    } finally {
      executor.completion.resolve();
      await executor.finished.promise;
      coreDb.sqlite.close();
    }
  });
});

describe('conversation.submit worker storage choice', () => {
  it('rejects oversized objectives before worker effects and starts the exact 2000-character boundary', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-conversation-objective-limit-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    const executor = new CompletingTurnExecutor();
    const workerSetup = createTestAgentSetup();
    const app = createAppWithWorkspaceAuthority({
      agentManifests: [workerSetup.manifest],
      coreDb,
      openKitConfig: { defaults: { defaultAgentId: workerSetup.manifest.id } },
      store,
      turnExecutor: executor,
    });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
    const threadsBefore = store.listThreads('ws_demo');
    const createThread = vi.spyOn(store, 'createThread');
    const createTurn = vi.spyOn(store, 'createTurn');
    let accepted: ReturnType<typeof SubmitConversationResponseSchema.parse> | undefined;
    const submit = (input: string, requestId: string) =>
      app.request(
        ...operationRequest(
          'conversation.submit',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            body: conversationBody({ input, requestId, targetRef: 'new-task-worker' }),
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          }
        )
      );

    try {
      const rejected = await submit('x'.repeat(2073), '0190f4c8-0000-7000-8000-000000000601');
      expect(rejected.status).toBe(400);
      await expect(rejected.json()).resolves.toMatchObject({
        code: 'invalid_request',
        message: 'Too big: expected string to have <=2000 characters',
      });
      expect(createThread).not.toHaveBeenCalled();
      expect(createTurn).not.toHaveBeenCalled();
      expect(store.listThreads('ws_demo')).toEqual(threadsBefore);
      for (const thread of threadsBefore) {
        expect(store.listThreadTurns('ws_demo', thread.id)).toEqual([]);
      }
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          statuses: ['queued', 'admitted', 'denied', 'cancelled', 'expired'],
          workspaceId: 'ws_demo',
        })
      ).toEqual([]);
      expect(executor.startContexts).toEqual([]);

      const input = 'x'.repeat(2000);
      const response = await submit(input, '0190f4c8-0000-7000-8000-000000000602');
      expect(response.status, await response.clone().text()).toBe(202);
      accepted = SubmitConversationResponseSchema.parse(await response.json());
      await waitForSelectedWorkerLoopCloseout({
        coreDb,
        dataRoot,
        workspaceId: 'ws_demo',
        threadId: accepted.turn.threadId,
        turnId: accepted.turn.id,
      });
      expect(createThread).toHaveBeenCalledTimes(1);
      expect(createTurn).toHaveBeenCalledTimes(1);
      expect(executor.startContexts).toHaveLength(1);
      const delivered = store
        .getTurnById(accepted.turn.id)
        .items.find((item) => item.type === 'assistant-message');
      expect(JSON.parse(delivered?.text ?? '{}')).toMatchObject({ objective: input });
    } finally {
      if (accepted) {
        await waitForSelectedWorkerLoopCloseout({
          coreDb,
          dataRoot,
          workspaceId: 'ws_demo',
          threadId: accepted.turn.threadId,
          turnId: accepted.turn.id,
        });
      }
      vi.restoreAllMocks();
      coreDb.sqlite.close();
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });

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
    const app = createAppWithWorkspaceAuthority({
      agentManifests: [workerSetup.manifest],
      openKitConfig: { defaults: { defaultAgentId: workerSetup.manifest.id } },
      store,
      turnExecutor: new CompletingTurnExecutor(),
    });

    const assistantRes = await app.request(
      ...operationRequest(
        'conversation.submit',
        { workspaceId: 'ws_demo', threadId: 'th_demo' },
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
      )
    );
    expect(assistantRes.status).toBe(409);
    await expect(assistantRes.json()).resolves.toMatchObject({
      code: 'worker_storage_choice_not_applicable',
    });
    expect(store.listThreadTurns('ws_demo', 'th_demo')).toEqual([]);
    expect(store.listCommandRequests()).toEqual([]);

    const runningRes = await app.request(
      ...operationRequest(
        'conversation.submit',
        { workspaceId: 'ws_demo', threadId: thread.id },
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
      )
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
    const app = createAppWithWorkspaceAuthority({
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
        ...operationRequest(
          'conversation.submit',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            body,
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          }
        )
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
        ...operationRequest(
          'conversation.submit',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            body,
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          }
        )
      );
      expect(replay.status, await replay.clone().text()).toBe(202);
      expect(SubmitConversationResponseSchema.parse(await replay.json())).toEqual(accepted);
      expect(executor.startContexts).toHaveLength(1);

      const conflict = await app.request(
        ...operationRequest(
          'conversation.submit',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
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
        )
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
    const executor = new HoldingTurnExecutor(coreDb.dataRoot);
    const workerSetup = createTestAgentSetup();
    const app = createAppWithWorkspaceAuthority({
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

    const pending = app.request(
      ...operationRequest(
        'conversation.submit',
        { workspaceId: 'ws_demo', threadId: 'th_demo' },
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
      )
    );
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

      expect(executor.checkpointAtLaunch).toMatchObject({
        stage: 'running_worker',
        workerSessionId: listSchedulerSessionLeasesForTurn(coreDb, {
          workspaceId: 'ws_demo',
          threadId: workerTurn!.threadId,
          turnId: workerTurn!.id,
        })[0]!.agentSessionId,
        stopReason: null,
      });
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
        ...operationRequest(
          'conversation.submit',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
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
        )
      );
      expect(replay.status, await replay.clone().text()).toBe(202);
      expect(SubmitConversationResponseSchema.parse(await replay.json())).toEqual(accepted);
      expect(
        store.listWorkspaceItemRevisions('ws_demo').filter((item) => item.id === accepted.item.id)
      ).toHaveLength(1);
      store.updateItem(accepted.item.id, { title: 'Worker Turn failed' });
      const contradictedReplay = await app.request(
        ...operationRequest(
          'conversation.submit',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
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
        )
      );
      expect(contradictedReplay.status).toBe(409);
      await expect(contradictedReplay.json()).resolves.toMatchObject({
        code: 'recovery_required',
      });
      store.updateItem(accepted.item.id, { title: accepted.item.title });
      const replayAcceptedRequest = () =>
        app.request(
          ...operationRequest(
            'conversation.submit',
            { workspaceId: 'ws_demo', threadId: 'th_demo' },
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
          )
        );
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
    const executor = new HoldingTurnExecutor(coreDb.dataRoot);
    const workerSetup = createTestAgentSetup();
    const app = createAppWithWorkspaceAuthority({
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
      app.request(
        ...operationRequest(
          'conversation.submit',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            body,
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          }
        )
      );
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
        checkpointOutcome: 'preserved',
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
            stage: 'running_worker',
            stopReason: null,
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
          checkpointOutcome: 'preserved',
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

// Simulated continuity still resolves against explicit fixture-owned confirmed image evidence.
vi.mock('./runtime/agent-environment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runtime/agent-environment.js')>();
  const { withTestPreparedNativeEnvironment } = await import(
    './test-support/native-environment.js'
  );
  return withTestPreparedNativeEnvironment(actual);
});

describe('mode command failure diagnostics', () => {
  it.each([
    'conversation',
    'task',
  ] as const)('returns missing image admission through the real %s route before Worker launch', async (mode) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-mode-image-admission-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    const setup = createTestAgentSetup({ imageRef: `sha256:${'d'.repeat(64)}` });
    const executor = new CompletingTurnExecutor({ coreDb });
    const app = createApp({
      coreDb,
      dataRoot,
      store,
      turnExecutor: executor,
      runtimeConfigManager: createRuntimeConfigManager({
        dataRoot,
        initialSnapshot: createInMemoryRuntimeConfigSnapshot({
          dataRoot,
          agentManifests: [setup.manifest],
          gatewayConfig: createTestGatewayConfig(),
          providerRegistry: new ProviderRegistry([
            {
              id: 'agent-openrouter',
              displayName: 'Test provider',
              kind: 'local',
              defaultModel: 'openai/gpt-5.2',
              models: ['openai/gpt-5.2'],
            },
          ]),
          openKitConfig: { defaults: { defaultAgentId: setup.manifest.id } },
          workspaceConfigs: [
            {
              workspaceId: 'ws_demo',
              path: join(dataRoot, 'workspaces/ws_demo/config/workspace.jsonc'),
              config: {
                schemaVersion: 1,
                workspace: { name: 'Demo Workspace', defaultAgentId: setup.manifest.id },
              },
            },
          ],
        }),
      }),
    });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
    const thread =
      mode === 'conversation'
        ? store.getThread('ws_demo', 'th_demo')
        : store.createThread('ws_demo', 'Task admission');
    // The generic App fixture admits synthetic defaults; retain acquisition but remove admission.
    coreDb.sqlite
      .prepare('UPDATE worker_image_settlements SET native_environment_json = NULL')
      .run();
    // Bypass this module's automatic admission wrapper at the actual scheduler preview seam.
    const actual = await vi.importActual<typeof import('./runtime/agent-environment.js')>(
      './runtime/agent-environment.js'
    );
    vi.spyOn(executor, 'prepareAgentSessionForTurn').mockImplementation(async (_store, input) => {
      actual.resolveAgentSessionCompatibilityKey({
        ...input,
        agentSessionId: input.freshAgentSessionId,
        triggerActor: input.turn.triggerActor,
        coreDb,
        backend: { kind: 'openshell' },
      });
      throw new Error('Missing image admission unexpectedly succeeded.');
    });
    const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const requestId = '0190f4c8-0000-7000-8000-000000000951';
      const response = await app.request(
        ...operationRequest(
          mode === 'conversation' ? 'conversation.submit' : 'task.start',
          { workspaceId: 'ws_demo', threadId: thread.id },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body:
              mode === 'conversation'
                ? conversationBody({
                    input: 'Implement a bounded README correction.',
                    requestId,
                    targetRef: `warm-worker:${setup.manifest.id}:default`,
                  })
                : JSON.stringify({ input: 'Implement a bounded README correction.', requestId }),
          }
        )
      );
      expect(response.status, await response.clone().text()).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'worker_environment_preparation_required',
        message: `Agent "${setup.manifest.id}" requires Worker environment preparation and activation before starting work; verified image defaults are unavailable.`,
      });
      expect(executor.startContexts).toEqual([]);
      expect(diagnostics).not.toHaveBeenCalled();
    } finally {
      diagnostics.mockRestore();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it.each([
    'conversation',
    'task',
  ] as const)('logs a redacted unexpected %s command error at the existing console sink', async (mode) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-mode-unexpected-error-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    const app = createApp({ coreDb, dataRoot, store });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
    const thread =
      mode === 'conversation'
        ? store.getThread('ws_demo', 'th_demo')
        : store.createThread('ws_demo', 'Task diagnostics');
    const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Fail inside command execution, after request authorization has read the Workspace.
    vi.spyOn(store, 'getCommandRequest').mockImplementation(() => {
      throw new Error('Unexpected command defect; token=synthetic-canary');
    });
    try {
      const requestId = '0190f4c8-0000-7000-8000-000000000952';
      const response = await app.request(
        ...operationRequest(
          mode === 'conversation' ? 'conversation.submit' : 'task.start',
          { workspaceId: 'ws_demo', threadId: thread.id },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body:
              mode === 'conversation'
                ? conversationBody({
                    input: 'Hello',
                    requestId,
                    targetRef: 'internal-role:assistant',
                  })
                : JSON.stringify({ input: 'Implement a bounded README correction.', requestId }),
          }
        )
      );
      expect(await response.json()).toMatchObject({
        code: mode === 'conversation' ? 'chat_mode_failed' : 'task_mode_start_failed',
      });
      expect(diagnostics.mock.calls).toEqual([
        [
          mode === 'conversation' ? 'chat_mode_failed' : 'task_mode_start_failed',
          'Unexpected command defect; token=[redacted]',
        ],
      ]);
    } finally {
      vi.restoreAllMocks();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});

describe('reasoning effort admission and replay', () => {
  it.each([
    { entry: 'turn.start', supplied: 'none', defaultEffort: 'high', expected: 'none' },
    { entry: 'turn.start', supplied: undefined, defaultEffort: 'high', expected: 'high' },
    { entry: 'turn.start', supplied: undefined, defaultEffort: undefined, expected: undefined },
    { entry: 'conversation.submit', supplied: 'none', defaultEffort: 'high', expected: 'none' },
    { entry: 'conversation.submit', supplied: undefined, defaultEffort: 'high', expected: 'high' },
    {
      entry: 'conversation.submit',
      supplied: undefined,
      defaultEffort: undefined,
      expected: undefined,
    },
  ] as const)('records submission then Agent default for $entry: %j', async ({
    entry,
    supplied,
    defaultEffort,
    expected,
  }) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-effort-admission-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    const executor = new CompletingTurnExecutor();
    const setup = createTestAgentSetup();
    const manifest = {
      ...setup.manifest,
      models: {
        ...setup.manifest.models,
        ...(defaultEffort !== undefined ? { reasoningEffort: defaultEffort } : {}),
      },
    };
    const makeApp = (activeStore: FsStore) =>
      createApp({
        coreDb,
        dataRoot,
        store: activeStore,
        agentManifests: [manifest],
        openKitConfig: { defaults: { defaultAgentId: manifest.id } },
        turnExecutor: executor,
      });
    const app = makeApp(store);
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
    const payload =
      entry === 'turn.start'
        ? {
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            requestId: '00000000-0000-4000-8000-000000000777',
            input: 'Implement the focused correction.',
            agentId: manifest.id,
          }
        : {
            requestId: '00000000-0000-4000-8000-000000000777',
            input: 'Implement the focused correction.',
            targetRef: 'new-task-worker',
            artifactRefs: [],
          };
    const body = { ...payload, ...(supplied !== undefined ? { reasoningEffort: supplied } : {}) };
    const post = (targetApp: typeof app, input: unknown) =>
      targetApp.request(
        ...operationRequest(
          entry,
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(input),
          }
        )
      );
    try {
      const response = await post(app, body);
      expect(response.status, await response.clone().text()).toBe(202);
      const accepted = await response.json();
      const turn = entry === 'turn.start' ? accepted : accepted.turn;
      if (expected === undefined) expect(turn).not.toHaveProperty('reasoningEffort');
      else expect(turn).toHaveProperty('reasoningEffort', expected);
      await vi.waitFor(() => expect(store.getTurnById(turn.id).status).toBe('completed'));
      if (entry === 'conversation.submit')
        await waitForSelectedWorkerLoopCloseout({
          coreDb,
          dataRoot,
          threadId: turn.threadId,
          turnId: turn.id,
          workspaceId: 'ws_demo',
        });
      const launches = executor.startContexts.length;
      manifest.models = { ...manifest.models, reasoningEffort: 'max' };
      const reloaded = createDemoStore({ dataRoot });
      if (expected === undefined)
        expect(reloaded.getTurnById(turn.id)).not.toHaveProperty('reasoningEffort');
      else expect(reloaded.getTurnById(turn.id)).toHaveProperty('reasoningEffort', expected);
      const replay = await post(makeApp(reloaded), body);
      expect(replay.status, await replay.clone().text()).toBe(202);
      const replayed = await replay.json();
      expect((entry === 'turn.start' ? replayed : replayed.turn).id).toBe(turn.id);
      if (expected === undefined)
        expect(entry === 'turn.start' ? replayed : replayed.turn).not.toHaveProperty(
          'reasoningEffort'
        );
      else
        expect(entry === 'turn.start' ? replayed : replayed.turn).toHaveProperty(
          'reasoningEffort',
          expected
        );
      expect(executor.startContexts).toHaveLength(launches);
      const conflict = await post(makeApp(reloaded), { ...body, reasoningEffort: 'low' });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ code: 'idempotency_key_conflict' });
      expect(executor.startContexts).toHaveLength(launches);
      expect(() => reloaded.updateTurn(turn.id, { reasoningEffort: 'low' } as never)).toThrow(
        'Turn update cannot change field: reasoningEffort'
      );
      const later = await post(makeApp(reloaded), {
        ...payload,
        requestId: '00000000-0000-4000-8000-000000000779',
      });
      expect(later.status, await later.clone().text()).toBe(202);
      const laterResponse = await later.json();
      const laterTurn = entry === 'turn.start' ? laterResponse : laterResponse.turn;
      expect(laterTurn).toHaveProperty('reasoningEffort', 'max');
      expect(executor.startContexts).toHaveLength(launches + 1);
      if (entry === 'conversation.submit')
        await waitForSelectedWorkerLoopCloseout({
          coreDb,
          dataRoot,
          threadId: laterTurn.threadId,
          turnId: laterTurn.id,
          workspaceId: 'ws_demo',
        });
    } finally {
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it.each([
    'turn.start',
    'conversation.submit',
  ])('rejects unknown effort before %s effects', async (entry) => {
    const store = createDemoStore();
    const app = createApp({ store });
    const before = store.listThreads('ws_demo').length;
    const input =
      entry === 'turn.start'
        ? {
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            requestId: '00000000-0000-4000-8000-000000000778',
            input: 'Run',
            reasoningEffort: 'default',
          }
        : {
            requestId: 'request',
            targetRef: 'new-task-worker',
            input: 'Run',
            reasoningEffort: 'default',
          };
    const response = await app.request(
      ...operationRequest(
        entry,
        { workspaceId: 'ws_demo', threadId: 'th_demo' },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }
      )
    );
    expect(response.status).toBe(400);
    expect(store.listThreads('ws_demo')).toHaveLength(before);
    expect(store.listThreadTurns('ws_demo', 'th_demo')).toEqual([]);
    expect(store.listCommandRequests()).toEqual([]);
  });
});

it('publishes resolver effort levels, empty controls, and absent controls in the conversation catalog', async () => {
  const models = ['controlled', 'empty', 'plain'];
  const setup = createTestAgentSetup({ logicalModelId: 'controlled' });
  setup.manifest.models.allowedLogicalModelIds = models;
  const providerRegistry = new ProviderRegistry([
    {
      id: 'agent-openrouter',
      kind: 'local',
      displayName: 'Catalog fixture',
      models,
      modelMetadata: {
        controlled: {
          reasoning: true,
          limit: { context: 1000000 },
          reasoning_options: [{ type: 'effort', values: ['high', 'none'] }],
        },
        empty: { reasoning: true, reasoning_options: [], limit: { context: 1000000 } },
        plain: { reasoning: false, limit: { context: 1000000 } },
      },
    },
  ]);
  const base = createTestGatewayConfig();
  const app = createAppWithWorkspaceAuthority({
    store: createDemoStore(),
    providerRegistry,
    gatewayConfig: {
      ...base,
      defaultLogicalModelId: 'controlled',
      logicalModels: models.map((id) => ({
        ...base.logicalModels[0]!,
        id,
        displayName: id,
        routes: [{ id, providerProfileId: 'agent-openrouter', providerModel: id }],
      })),
    },
    agentManifests: [setup.manifest],
    openKitConfig: { defaults: { defaultAgentId: setup.manifest.id } },
  });
  const response = await app.request(
    ...operationRequest('conversation.targets', { workspaceId: 'ws_demo' }, undefined)
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const catalog = await response.json();
  const choices = catalog.targets.find(
    (target: { targetRef: string }) => target.targetRef === 'new-task-worker'
  ).logicalModels;
  expect(choices.find((model: { id: string }) => model.id === 'controlled')).toHaveProperty(
    'reasoningEffortLevels',
    ['none', 'high']
  );
  expect(choices.find((model: { id: string }) => model.id === 'empty')).toHaveProperty(
    'reasoningEffortLevels',
    []
  );
  expect(choices.find((model: { id: string }) => model.id === 'plain')).not.toHaveProperty(
    'reasoningEffortLevels'
  );
});

describe('Task durable admission response', () => {
  it('refuses a denied Task capability before worker or scheduler effects', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-task-denied-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    const executor = new CompletingTurnExecutor();
    const setup = createTestAgentSetup();
    const app = createApp({
      mode: 'server',
      coreDb,
      dataRoot,
      store,
      turnExecutor: executor,
      agentManifests: [setup.manifest],
    });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
    const token = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: 'user_local',
      scope: 'workspace-readonly',
      workspaceIds: ['ws_demo'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    try {
      const response = await app.request(
        ...operationRequest(
          'task.start',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${token.secret}`,
            },
            body: JSON.stringify({
              requestId: '0190f4c8-0000-7000-8000-000000000605',
              input:
                'Read issue 110 of lingkaix/openkit with the github MCP tools and reply with its title.',
            }),
          }
        )
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'workspace_access_denied' });
      expect(executor.startContexts).toHaveLength(0);
      expect(store.listThreadTurns('ws_demo', 'th_demo')).toHaveLength(0);
      expect(store.listCommandRequests()).toHaveLength(0);
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          workspaceId: 'ws_demo',
          statuses: ['queued', 'admitted', 'denied', 'cancelled', 'expired'],
        })
      ).toHaveLength(0);
    } finally {
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ...(['direct', 'assistant', 'remote-mcp', 'closeout-failure'] as const).map((entry) => ({
      entry,
      input: 'Implement a focused change and run its tests.',
    })),
    {
      entry: 'direct',
      input:
        'Read issue 110 of lingkaix/openkit with the github MCP tools and reply with its title.',
    },
    {
      entry: 'direct',
      input:
        'Please read issue 110 of lingkaix/openkit with the github MCP tools and reply with its title.',
    },
    {
      entry: 'direct',
      input:
        'Could you read issue 110 of lingkaix/openkit with the github MCP tools and reply with its title?',
    },
    { entry: 'direct', input: 'Fetch issue 110 of lingkaix/openkit and return its title.' },
    { entry: 'direct', input: 'Retrieve issue 110 of lingkaix/openkit and return its title.' },
    { entry: 'direct', input: 'Get issue 110 of lingkaix/openkit and reply with its title.' },
    { entry: 'direct', input: 'Look up issue 110 of lingkaix/openkit and reply with its title.' },
    {
      entry: 'direct',
      input: 'Using the github MCP tools, report the title of issue 110 of lingkaix/openkit.',
    },
    {
      entry: 'direct',
      input: 'Issue 110 of lingkaix/openkit: reply with its title using the github MCP tools.',
    },
    {
      entry: 'direct',
      input: 'Find the title of issue 110 of lingkaix/openkit using the github MCP tools.',
    },
    { entry: 'direct', input: 'Help.' },
    { entry: 'direct', input: 'What is OpenKit?' },
    { entry: 'direct', input: 'Plan a multi-step release goal for NanoCore.' },
    {
      entry: 'direct',
      input:
        '  Read issue 110 of lingkaix/openkit. Do not deploy to production.\nReply with its title.  ',
    },
  ])('returns $entry admission for "$input" before the held worker finishes', async ({
    entry,
    input,
  }) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-task-admission-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    const executor = new HoldingTurnExecutor(coreDb.dataRoot);
    executor.failCloseout = entry === 'closeout-failure';
    const setup = createTestAgentSetup();
    const app = createAppWithWorkspaceAuthority({
      coreDb,
      dataRoot,
      store,
      turnExecutor: executor,
      agentManifests: [setup.manifest],
      openKitConfig: { defaults: { defaultAgentId: setup.manifest.id } },
    });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
    const requestId = '0190f4c8-0000-7000-8000-000000000601';
    const command = entry === 'assistant' ? 'conversation.submit' : 'task.start';
    const scope = { actorId: 'user_local', workspaceId: 'ws_demo', threadId: 'th_demo' };
    const token =
      entry === 'remote-mcp'
        ? createOpenKitAccessTokenRecord(coreDb, {
            ownerUserId: 'user_local',
            scope: 'workspace',
            workspaceIds: ['ws_demo'],
            expiresAt: '2099-01-01T00:00:00.000Z',
          })
        : null;
    /** Calls the real JSON or remote MCP binding with the same immutable request identity. */
    const submit = (text = input) => {
      const body =
        command === 'conversation.submit'
          ? { input: text, requestId, targetRef: 'internal-role:assistant', artifactRefs: [] }
          : { input: text, requestId };
      if (token)
        return app.request('http://127.0.0.1/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${token.secret}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'call',
              arguments: {
                operation: 'task.start',
                input: { ...body, workspaceId: 'ws_demo', threadId: 'th_demo' },
              },
            },
          }),
        });
      return app.request(
        ...operationRequest(
          command,
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }
        )
      );
    };
    const checkpointDeletion = vi.spyOn(checkpointOwners, 'clearWorkerCheckpoint');
    const leaseCloseout = vi.spyOn(schedulerOwners, 'completeSchedulerLeaseForTerminalTurn');
    const publicationEvents: string[] = [];
    const recordReceipt = store.recordCommandRequest.bind(store);
    const receiptPublication = vi
      .spyOn(store, 'recordCommandRequest')
      .mockImplementation((...args) => {
        const receipt = recordReceipt(...args);
        if (receipt.command === command && receipt.requestId === requestId)
          publicationEvents.push('publication');
        return receipt;
      });
    let receiptAtResponse: ReturnType<FsStore['getCommandRequest']>;
    let responseObserved = false;
    // Attach the first observation immediately; no await may precede this receipt read.
    const pending = submit().then((response) => {
      receiptAtResponse = store.getCommandRequest(command, requestId, scope);
      publicationEvents.push('response');
      responseObserved = true;
      return response;
    });
    let turnId: string | undefined;
    try {
      await Promise.race([
        executor.launched.promise,
        pending.then(async (response) => {
          throw new Error(
            `Worker was not entered: ${response.status} ${await response.clone().text()}`
          );
        }),
      ]);
      turnId = listSchedulerAdmissionEntriesForWorkspace(coreDb, {
        workspaceId: 'ws_demo',
        statuses: ['queued', 'admitted', 'denied', 'cancelled', 'expired'],
      })[0]!.turnId;
      expect(executor.checkpointAtLaunch).toMatchObject({
        stage: 'running_worker',
        workerSessionId: listSchedulerSessionLeasesForTurn(coreDb, {
          workspaceId: 'ws_demo',
          threadId: store.getTurnById(turnId).threadId,
          turnId,
        })[0]!.agentSessionId,
        stopReason: null,
      });
      let completionObserved = false;
      void executor.finished.promise.then(() => {
        completionObserved = true;
      });
      await setImmediate();
      // Ordered events are the oracle: the executor is still waiting on test-owned release.
      expect(responseObserved).toBe(true);
      expect(receiptAtResponse).toMatchObject({ command, requestId });
      expect(publicationEvents).toEqual(['publication', 'response']);
      expect(completionObserved).toBe(false);
      const response = await pending;
      expect(response.status, await response.clone().text()).toBe(token ? 200 : 202);
      const wire = await response.json();
      const result = token ? JSON.parse(wire.result.content[0].text) : wire;
      if (entry === 'assistant') {
        const accepted = SubmitConversationResponseSchema.parse(result);
        expect(accepted.outcome).toBe('task-handoff');
        expect(accepted.turn.status).toBe('completed');
        expect(accepted.handoff?.statusItemId).toBe(accepted.item.id);
      } else {
        const accepted = StartTaskModeResponseSchema.parse(result);
        expect(accepted.state).toBe('running');
        expect(accepted.turn).toMatchObject({ id: turnId, status: 'running' });
        expect(accepted.completion ?? null).toBeNull();
        expect(accepted.evidence).toEqual({ itemIds: [], artifactIds: [], reviewIds: [] });
      }
      const receipt = receiptAtResponse!;
      expect(store.getCommandRequest(command, requestId, scope)).toEqual(receipt);
      expect(receipt).toMatchObject({ command, requestId, response: { kind: 'turn' } });
      if (entry === 'assistant') {
        expect(receipt.response.conversationMetadata).toMatchObject({
          resultKind: 'task-handoff',
          downstream: { kind: 'task', turnId },
        });
        expect(store.listCommandRequests().filter((r) => r.command === 'task.start')).toHaveLength(
          0
        );
      } else expect(receipt.response.id).toBe(turnId);
      const replay = await submit();
      expect(replay.status, await replay.clone().text()).toBe(token ? 200 : 202);
      expect(await replay.json()).toEqual(wire);
      const conflict = await submit('Implement a different change.');
      if (!token) {
        expect(conflict.status).toBe(409);
        await expect(conflict.json()).resolves.toMatchObject({ code: 'idempotency_key_conflict' });
      } else {
        expect(conflict.status).toBe(200);
        const refused = (await conflict.json()).result;
        expect(refused.isError).toBe(true);
        expect(JSON.parse(refused.content[0].text)).toMatchObject({
          code: 'idempotency_key_conflict',
        });
      }
      expect(executor.launches).toBe(1);
      expect(JSON.parse(executor.inputs[0]!).objective).toBe(input);
      expect(JSON.parse(executor.inputs[0]!).constraints.maxWorkerIterations).toBe(1);
      expect(store.listCommandRequests().some((record) => record.command === 'goal.create')).toBe(
        false
      );
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          workspaceId: 'ws_demo',
          statuses: ['queued', 'admitted', 'denied', 'cancelled', 'expired'],
        })
      ).toHaveLength(1);
      expect(store.getTurnById(turnId).items.some((i) => i.id === `it_user_${turnId}`)).toBe(false);
      if (entry === 'direct') {
        const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
        const checkpoint = getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', turnId)!;
        try {
          for (const [column, original] of [
            ['request_input_hash', checkpoint.requestInputHash],
            ['context_digest', checkpoint.contextDigest],
          ] as const) {
            workspaceDb.sqlite
              .prepare(`UPDATE worker_turn_checkpoints SET ${column} = ? WHERE checkpoint_id = ?`)
              .run('sha256:contradiction', checkpoint.checkpointId);
            const refused = await submit();
            expect(refused.status).toBe(409);
            await expect(refused.json()).resolves.toMatchObject({ code: 'recovery_required' });
            workspaceDb.sqlite
              .prepare(`UPDATE worker_turn_checkpoints SET ${column} = ? WHERE checkpoint_id = ?`)
              .run(original, checkpoint.checkpointId);
          }
        } finally {
          workspaceDb.sqlite.close();
        }
        const lease = listSchedulerSessionLeasesForTurn(coreDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId,
        })[0]!;
        for (const status of ['planned', 'stale', 'releasing'] as const) {
          try {
            coreDb.sqlite
              .prepare('UPDATE scheduler_session_leases SET status = ? WHERE lease_id = ?')
              .run(status, lease.leaseId);
            const refused = await submit();
            expect(refused.status).toBe(409);
            await expect(refused.json()).resolves.toMatchObject({ code: 'recovery_required' });
          } finally {
            coreDb.sqlite
              .prepare('UPDATE scheduler_session_leases SET status = ? WHERE lease_id = ?')
              .run(lease.status, lease.leaseId);
          }
        }
        try {
          coreDb.sqlite
            .prepare(
              'UPDATE scheduler_placement_plans SET selected_target_id = ? WHERE plan_id = ?'
            )
            .run('contradictory-target', lease.planId);
          const refused = await submit();
          expect(refused.status).toBe(409);
          await expect(refused.json()).resolves.toMatchObject({ code: 'recovery_required' });
        } finally {
          coreDb.sqlite
            .prepare(
              'UPDATE scheduler_placement_plans SET selected_target_id = ? WHERE plan_id = ?'
            )
            .run(lease.targetId, lease.planId);
        }
        expect((await submit()).status).toBe(202);
        expect(executor.launches).toBe(1);
      }
      executor.completion.resolve();
      await executor.finished.promise;
      await vi.waitFor(() =>
        expect(
          listSchedulerSessionLeasesForTurn(coreDb, {
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            turnId: turnId!,
          })[0]?.status
        ).toBe(entry === 'closeout-failure' ? 'failed' : 'released')
      );
      await setImmediate();
      const turnRead = await app.request(
        ...operationRequest(
          'turn.read',
          { workspaceId: 'ws_demo', threadId: 'th_demo', turnId },
          { method: 'GET' }
        )
      );
      expect(turnRead.status).toBe(200);
      expect(await turnRead.json()).toMatchObject({ id: turnId, status: 'completed' });
      const itemsRead = await app.request(
        ...operationRequest(
          'thread.items',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          { method: 'GET' }
        )
      );
      expect(itemsRead.status).toBe(200);
      expect((await itemsRead.json()).items).toContainEqual(
        expect.objectContaining({
          id: `it_assistant_${turnId}`,
          type: 'assistant-message',
          status: 'completed',
        })
      );
      const terminalReplay = await submit();
      if (entry === 'closeout-failure') {
        expect(terminalReplay.status).toBe(409);
        await expect(terminalReplay.json()).resolves.toMatchObject({ code: 'recovery_required' });
      } else {
        expect(terminalReplay.status).toBe(token ? 200 : 202);
        const terminalWire = await terminalReplay.json();
        if (entry === 'assistant') expect(terminalWire).toEqual(wire);
        else {
          const terminal = StartTaskModeResponseSchema.parse(
            token ? JSON.parse(terminalWire.result.content[0].text) : terminalWire
          );
          expect(terminal).toMatchObject({
            state: 'completed',
            turn: { id: turnId },
            completion: { itemId: `it_assistant_${turnId}` },
          });
        }
      }
      const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
      try {
        const checkpoint = getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', turnId);
        if (entry === 'closeout-failure' || entry === 'assistant')
          expect(checkpoint?.stage).toBe(
            entry === 'closeout-failure' ? 'running_worker' : 'completed'
          );
        else expect(checkpoint).toBeNull();
      } finally {
        workspaceDb.sqlite.close();
      }
      expect(
        checkpointDeletion.mock.calls.filter(([, , , clearedTurnId]) => clearedTurnId === turnId)
      ).toHaveLength(entry === 'direct' || entry === 'remote-mcp' ? 1 : 0);
      const closedLease = listSchedulerSessionLeasesForTurn(coreDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId,
      })[0]!;
      const repeatedReplay = await submit();
      expect(repeatedReplay.status).toBe(entry === 'closeout-failure' ? 409 : token ? 200 : 202);
      expect(
        listSchedulerSessionLeasesForTurn(coreDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId,
        })[0]
      ).toEqual(closedLease);
      expect(
        store.getTurnEvents(turnId).filter((event) => event.event === 'turn.completed')
      ).toHaveLength(1);
      expect(leaseCloseout.mock.calls.filter(([, turn]) => turn.id === turnId)).toHaveLength(
        entry === 'closeout-failure' ? 0 : 1
      );
      expect(store.getCommandRequest(command, requestId, scope)).toEqual(receipt);
      expect(executor.launches).toBe(1);
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          workspaceId: 'ws_demo',
          statuses: ['queued', 'admitted', 'denied', 'cancelled', 'expired'],
        })
      ).toHaveLength(1);
    } finally {
      executor.completion.resolve();
      await pending.catch(() => undefined);
      if (executor.launches > 0) await executor.finished.promise;
      await setImmediate();
      receiptPublication.mockRestore();
      checkpointDeletion.mockRestore();
      leaseCloseout.mockRestore();
      coreDb.sqlite.close();
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });
});

describe('Task terminal replay closeout ownership', () => {
  it.each([
    { entry: 'direct', failCollection: false },
    { entry: 'direct', failCollection: true },
    { entry: 'assistant', failCollection: false },
    { entry: 'assistant', failCollection: true },
  ] as const)('joins the original $entry closeout during terminal replay (failure=$failCollection)', async ({
    entry,
    failCollection,
  }) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-task-closeout-owner-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    const executor = new HoldingTurnExecutor(coreDb.dataRoot);
    const setup = createTestAgentSetup();
    const app = createAppWithWorkspaceAuthority({
      coreDb,
      dataRoot,
      store,
      turnExecutor: executor,
      agentManifests: [setup.manifest],
      openKitConfig: { defaults: { defaultAgentId: setup.manifest.id } },
    });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
    const requestId = '0190f4c8-0000-7000-8000-000000000602';
    const scope = { actorId: 'user_local', workspaceId: 'ws_demo', threadId: 'th_demo' };
    const command = entry === 'assistant' ? 'conversation.submit' : 'task.start';
    const submit = () =>
      app.request(
        ...operationRequest(
          command,
          {
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
          },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              requestId,
              input: 'Implement a focused change and run its tests.',
              ...(entry === 'assistant'
                ? { targetRef: 'internal-role:assistant', artifactRefs: [] }
                : {}),
            }),
          }
        )
      );
    const collecting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const collected = Promise.withResolvers<void>();
    const originalCollect = recoveryOwners.clearWorkerCheckpointAfterTerminalState;
    const collector = vi
      .spyOn(recoveryOwners, 'clearWorkerCheckpointAfterTerminalState')
      .mockImplementation(async (...args) => {
        const collectionIndex = collector.mock.calls.length;
        collecting.resolve();
        await release.promise;
        try {
          if (failCollection && collectionIndex === 1)
            throw new Error('Controlled checkpoint collection failure.');
          return await originalCollect(...args);
        } finally {
          collected.resolve();
        }
      });
    const originalLoop = loopOwners.runWorkerTurnLoop;
    const loopCloseout =
      entry === 'assistant'
        ? vi.spyOn(loopOwners, 'runWorkerTurnLoop').mockImplementation(async (...args) => {
            const result = await originalLoop(...args);
            collecting.resolve();
            await release.promise;
            try {
              if (failCollection) throw new Error('Controlled Assistant Task closeout failure.');
              return result;
            } finally {
              collected.resolve();
            }
          })
        : undefined;
    const closeoutOwner = loopCloseout ?? collector;
    const pending = submit();
    let replay: Promise<Response> | undefined;
    try {
      const admitted = await pending;
      expect(admitted.status, await admitted.clone().text()).toBe(202);
      const admittedBody = await admitted.json();
      const receipt = store.getCommandRequest(command, requestId, scope)!;
      const downstream = receipt.response.conversationMetadata?.downstream;
      const turnId: string =
        entry === 'assistant' && downstream?.kind === 'task'
          ? downstream.turnId
          : admittedBody.turn.id;
      executor.completion.resolve();
      await collecting.promise;
      // The real collector's terminal proof is available before the injected asynchronous hold.
      expect(store.getTurnById(turnId).status).toBe('completed');
      expect(
        listSchedulerSessionLeasesForTurn(coreDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId,
        })[0]?.status
      ).toBe('released');
      let replayObserved = false;
      replay = submit().then((response) => {
        replayObserved = true;
        return response;
      });
      await setImmediate();
      const collectorEntriesDuringHold = closeoutOwner.mock.calls.length;
      const replayObservedDuringHold = replayObserved;
      release.resolve();
      const result = await replay;
      expect({
        collectorEntriesDuringHold,
        replayObservedDuringHold,
        status: result.status,
      }).toEqual({
        collectorEntriesDuringHold: 1,
        replayObservedDuringHold: false,
        status: failCollection ? 409 : 202,
      });
      if (failCollection) {
        await expect(result.json()).resolves.toMatchObject({ code: 'recovery_required' });
      } else if (entry === 'assistant') {
        expect(await result.json()).toEqual(admittedBody);
      } else {
        expect(StartTaskModeResponseSchema.parse(await result.json())).toMatchObject({
          state: 'completed',
          turn: { id: turnId },
          completion: { itemId: `it_assistant_${turnId}` },
        });
      }
      expect(closeoutOwner).toHaveBeenCalledTimes(1);
      expect(store.getCommandRequest(command, requestId, scope)).toEqual(receipt);
      // Once the owner settles it is removed: ordinary receipt-based recovery remains available.
      const subsequent = await submit();
      expect(subsequent.status).toBe(202);
      expect(closeoutOwner).toHaveBeenCalledTimes(
        entry === 'assistant' ? 1 : failCollection ? 2 : 1
      );
      expect(store.getCommandRequest(command, requestId, scope)).toEqual(receipt);
      expect(executor.launches).toBe(1);
    } finally {
      executor.completion.resolve();
      release.resolve();
      await pending.catch(() => undefined);
      if (executor.launches > 0) {
        await executor.finished.promise;
        await collected.promise;
      }
      await replay?.catch(() => undefined);
      await setImmediate();
      loopCloseout?.mockRestore();
      collector.mockRestore();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});

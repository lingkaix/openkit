import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import {
  StartTaskModeResponseSchema,
  SubmitConversationResponseSchema,
} from '@openkit/app-api-schemas';
import { deriveEntityId, workspaceIdForOwner } from '@openkit/protocol';
import { expect, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import type { FsStore } from '../lib/store.js';
import { ProviderRegistry } from '../providers/registry.js';
import { listThreadPendingRequests } from '../runtime/pending-requests.js';
import { runSchedulerDispatchLoop } from '../runtime/scheduler-dispatch-loop.js';
import { getWorkerBackendSession } from '../runtime/worker-backend-sessions.js';
import { getWorkerCheckpoint } from '../runtime/worker-checkpoints.js';
import * as recoveryOwners from '../runtime/worker-recovery.js';
import { workerTurnTerminalPublication } from '../runtime/worker-turn-failure.js';
import * as loopOwners from '../runtime/worker-turn-loop.js';
import { listSchedulerAdmissionEntriesForWorkspace } from '../scheduler-records.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createAppWithWorkspaceAuthority } from '../test-support/app.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import {
  confirmTaskRequest,
  observeExecutionAttempts,
  taskProposalProvider,
} from '../test-support/mode-entry-fixture.js';
import { createNativeTaskAdmissionFixture } from '../test-support/native-task-admission.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';

/** Installs one deliberate checkpoint fault only after native writes drain, then resumes before replay. */
export async function mutateQuiescentCheckpoint(mutate: () => { changes: number }): Promise<void> {
  const resume = await getControlStoreWorkerClient().pauseForDataRootBackup();
  try {
    if (mutate().changes !== 1) throw new Error('Checkpoint fault must mutate exactly one row.');
  } finally {
    resume();
  }
}

/** Checks actual native completion authority after the selected-Worker owner has closed out. */
async function assertNativeTaskAdmission(
  coreDb: ReturnType<typeof openCoreDb>,
  store: FsStore,
  turnId: string,
  releaseLost: boolean
) {
  const turn = store.getTurnById(turnId);
  const db = openWorkspaceDb(coreDb.dataRoot, workspaceIdForOwner(turn.owner));
  try {
    const roots = db.sqlite
      .prepare('SELECT id,phase FROM control_executions WHERE work_id=?')
      .all(turnId);
    expect(roots).toEqual([expect.objectContaining({ phase: releaseLost ? 'closing' : 'closed' })]);
    const publication = await workerTurnTerminalPublication(db, turnId);
    expect(publication.execution?.executionId).toBe((roots[0] as { id: string }).id);
    expect(publication.evidence!.length).toBeGreaterThan(0);
    const steps = db.sqlite
      .prepare(
        "SELECT state,json_extract(control_json,'$.kind') AS kind FROM control_execution_steps WHERE execution_id=?"
      )
      .all((roots[0] as { id: string }).id) as { kind: string; state: string }[];
    for (const kind of ['materialize', 'collect', 'inspect-cleanup', 'terminal-publication'])
      expect(steps.find((step) => step.kind === kind)).toMatchObject({ state: 'completed' });
    expect(steps.find((step) => step.kind === 'release')).toMatchObject({
      state: releaseLost ? 'intent' : 'completed',
    });
    expect(
      listThreadPendingRequests(db.sqlite, workspaceIdForOwner(turn.owner), turn.threadId)
    ).toEqual([]);
    expect(
      store.getTurnEvents(turnId).filter((event) => event.event === 'turn.completed')
    ).toHaveLength(1);
    const finalStatuses = coreDb.sqlite
      .prepare(
        "SELECT record_json FROM worker_control_records WHERE turn_id=? AND operation='final_status'"
      )
      .all(turnId) as { record_json: string }[];
    expect(finalStatuses.map((row) => JSON.parse(row.record_json))).toEqual([
      expect.objectContaining({ status: 'completed', stopReason: 'completed' }),
    ]);
    const attempts = observeExecutionAttempts(coreDb).filter(
      (attempt) => attempt.turn_id === turnId
    );
    expect(attempts).toEqual([
      expect.objectContaining({
        phase: releaseLost ? 'closing' : 'closed',
        fence_ref: releaseLost ? null : expect.any(String),
      }),
    ]);
    expect(getWorkerBackendSession(coreDb, String(attempts[0]!.attempt_id))).toMatchObject({
      state: 'cleaned',
      workspaceHandoffState: 'complete',
      physicalCleanedAt: expect.any(String),
    });
  } finally {
    db.sqlite.close();
  }
}
/** Original immutable admission cases shared by two disjoint test registrations. */
export const TASK_DURABLE_ADMISSION_CASES: readonly {
  entry: 'direct' | 'assistant' | 'remote-mcp' | 'closeout-failure';
  input: string;
}[] = [
  ...(['direct', 'assistant', 'remote-mcp', 'closeout-failure'] as const).map((entry) => ({
    entry,
    input: 'Implement a focused change and run its tests.',
  })),
  {
    entry: 'direct',
    input: 'Read issue 110 of lingkaix/openkit with the github MCP tools and reply with its title.',
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
];

/** Runs the original admission, replay, execution and closeout oracles without a second fixture model. */
export async function assertTaskDurableAdmissionResponse({
  entry,
  input,
}: {
  entry: 'direct' | 'assistant' | 'remote-mcp' | 'closeout-failure';
  input: string;
}) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-task-admission-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot });
  const native = await createNativeTaskAdmissionFixture(coreDb, store);
  const executor = native.executor;
  executor.failCloseout = entry === 'closeout-failure';
  const setup = createTestAgentSetup({
    requiredCapabilities: ['trusted-worker-inference-relay'],
  });
  const provider = taskProposalProvider(input, setup.manifest.id);
  const app = createAppWithWorkspaceAuthority({
    fileAdmission: native.fileAdmission,
    workerControlGateway: native.workerControlGateway,
    coreDb,
    dataRoot,
    store,
    turnExecutor: executor,
    agentManifests: [setup.manifest],
    openKitConfig: { defaults: { defaultAgentId: setup.manifest.id } },
    ...(entry === 'assistant' ? { llmPiAiClient: provider.client } : {}),
  });
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  });
  const requestId = '0190f4c8-0000-7000-8000-000000000601';
  const command = entry === 'assistant' ? 'conversation.submit' : 'task.start';
  const scope = {
    actorId: 'usr_00000000-0000-7000-8000-000000000001',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    threadId: 'th_00000000-0000-7000-8000-000000000001',
  };
  const token =
    entry === 'remote-mcp'
      ? createOpenKitAccessTokenRecord(coreDb, {
          ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
          scope: 'workspace',
          workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
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
            name: 'openkit_call',
            arguments: {
              operation: 'task.start',
              input: {
                ...body,
                workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
                threadId: 'th_00000000-0000-7000-8000-000000000001',
              },
            },
          },
        }),
      });
    return app.request(
      ...operationRequest(
        command,
        {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
        },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      )
    );
  };
  const deletedCheckpointTurns: string[] = [];
  const loopSettled = Promise.withResolvers<void>();
  const originalLoop = loopOwners.runWorkerTurnLoop;
  const loopObservation = vi
    .spyOn(loopOwners, 'runWorkerTurnLoop')
    .mockImplementation((args) => originalLoop(args).finally(loopSettled.resolve));
  const collected = Promise.withResolvers<void>();
  void collected.promise.catch(() => undefined);
  const originalCollection = recoveryOwners.clearWorkerCheckpointAfterTerminalState;
  const collectionObservation = vi
    .spyOn(recoveryOwners, 'clearWorkerCheckpointAfterTerminalState')
    .mockImplementation((...args) =>
      originalCollection(...args).then(
        (result) => {
          if (result) deletedCheckpointTurns.push(args[1].turnId);
          collected.resolve();
          return result;
        },
        (error) => {
          collected.reject(error);
          throw error;
        }
      )
    );
  const publicationEvents: string[] = [];
  const writer = getControlStoreWorkerClient();
  const transition = writer.transition.bind(writer);
  const terminal = writer.terminal.bind(writer);
  // The real native method resolves only after its outer FULL COMMIT acknowledgement.
  const receiptPublication = vi.spyOn(writer, 'transition').mockImplementation(async (...args) => {
    const result = await transition(...args);
    const receipt = args[1].receipt;
    if (receipt.command === command && receipt.requestId === requestId)
      publicationEvents.push('publication');
    return result;
  });
  const terminalPublication = vi.spyOn(writer, 'terminal').mockImplementation(async (...args) => {
    const result = await terminal(...args);
    const receipt = args[1].command?.receipt;
    if (receipt?.command === command && receipt.requestId === requestId)
      publicationEvents.push('publication');
    return result;
  });
  let receiptAtResponse: undefined | ReturnType<FsStore['getCommandRequest']>;
  let responseObserved = false;
  // Attach the first observation immediately; no await may precede this receipt read.
  const pending = Promise.resolve(submit()).then((response) => {
    receiptAtResponse = store.getCommandRequest(command, requestId, scope);
    publicationEvents.push('response');
    responseObserved = true;
    return response;
  });
  let turnId: string | undefined;
  let dispatch = Promise.resolve<unknown>(undefined);
  let proposingTurn: ReturnType<FsStore['getTurnById']> | undefined;
  let requestItemId: string | undefined;
  let answerRequest: ReturnType<typeof confirmTaskRequest> | undefined;
  let answerResult: unknown;
  let answerReceipt: ReturnType<FsStore['getCommandRequest']> | undefined;
  try {
    // Await the response under the test timeout; the held executor proves publication ordering.
    const response = await pending;
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
    expect(response.status, await response.clone().text()).toBe(token ? 200 : 202);
    const wire = await response.json();
    const result = token ? JSON.parse(wire.result.content[0].text) : wire;
    if (entry === 'assistant') {
      const accepted = SubmitConversationResponseSchema.parse(result);
      expect(accepted.outcome).toBe('clarification-needed');
      expect(accepted.turn.status).toBe('completed');
      expect(accepted.item).toMatchObject({
        type: 'user-input-request',
        assistantHandoff: {
          kind: 'task',
          targetWorkspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          input,
          agentId: setup.manifest.id,
        },
      });
      expect(executor.launches).toBe(0);
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          statuses: ['queued', 'admitted', 'denied', 'cancelled', 'expired'],
        })
      ).toEqual([]);
      if (accepted.item.type !== 'user-input-request') throw new Error('Expected confirmation.');
      // Chat Handoff rules: the later outcome leaves its terminal proposing Turn unchanged.
      proposingTurn = structuredClone(store.getTurnById(accepted.turn.id));
      expect(proposingTurn.status).toBe('completed');
      requestItemId = accepted.item.id;
      answerRequest = confirmTaskRequest(accepted.item, '0190f4c8-0000-7000-8000-000000000611');
      const answer = await app.request(...answerRequest);
      expect(answer.status, await answer.clone().text()).toBe(200);
      answerResult = await answer.json();
      answerReceipt = structuredClone(
        store.listCommandRequests().find((record) => record.command === 'user_input.answer')
      );
      expect(answerReceipt).toBeDefined();
      await vi.waitFor(() =>
        expect(
          listSchedulerAdmissionEntriesForWorkspace(coreDb, {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            statuses: ['queued', 'admitted'],
          })
        ).toHaveLength(1)
      );
      turnId = listSchedulerAdmissionEntriesForWorkspace(coreDb, {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        statuses: ['queued', 'admitted'],
      })[0]!.turnId;
      expect(provider.createResponses).toHaveBeenCalledTimes(2);
    } else {
      turnId = listSchedulerAdmissionEntriesForWorkspace(coreDb, {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        statuses: ['queued', 'admitted', 'denied', 'cancelled', 'expired'],
      })[0]!.turnId;
      const accepted = StartTaskModeResponseSchema.parse(result);
      expect(['queued', 'running']).toContain(accepted.state);
      expect(accepted.turn.id).toBe(turnId);
      expect(['pending', 'running']).toContain(accepted.turn.status);
      expect(accepted.completion ?? null).toBeNull();
      expect(accepted.evidence).toEqual({ itemIds: [], artifactIds: [], reviewIds: [] });
    }
    if (entry === 'assistant')
      await vi.waitFor(() =>
        expect(store.listThreadItems(scope.workspaceId, scope.threadId)).toContainEqual(
          expect.objectContaining({ causationId: turnId, status: 'completed' })
        )
      );
    const workerThreadId = store.getTurnById(turnId).threadId;
    const receipt = receiptAtResponse!;
    expect(store.getCommandRequest(command, requestId, scope)).toEqual(receipt);
    expect(receipt).toMatchObject({ command, requestId, response: { kind: 'turn' } });
    if (entry === 'assistant') {
      expect(receipt.response.conversationMetadata).toMatchObject({
        resultKind: 'clarification',
        downstream: null,
      });
      expect(store.listCommandRequests().filter((r) => r.command === 'task.start')).toHaveLength(0);
    } else expect(receipt.response.id).toBe(turnId);
    const replay = await submit();
    expect(replay.status, await replay.clone().text()).toBe(token ? 200 : 202);
    const replayWire = await replay.json();
    const replayResult = token ? JSON.parse(replayWire.result.content[0].text) : replayWire;
    if (entry === 'assistant') {
      expect(SubmitConversationResponseSchema.parse(replayResult)).toEqual(result);
      expect(store.getCommandRequest(command, requestId, scope)).toEqual(receipt);
    } else expect(StartTaskModeResponseSchema.parse(replayResult).turn.id).toBe(turnId);
    // Check launch only after the durable receipt and exact current-owner replay.
    if (entry === 'assistant') {
      dispatch = runSchedulerDispatchLoop({
        coreDb,
        store,
        turnExecutor: executor,
        executionBackend: executor.executionBackend!,
        agentManifests: [setup.manifest],
        providerRegistry: new ProviderRegistry([
          {
            id: 'agent-openrouter',
            displayName: 'Fixture',
            kind: 'local',
            models: ['openai/gpt-5.2'],
          },
        ]),
        gatewayConfig: createTestGatewayConfig(),
        maxDispatches: 1,
      });
      void dispatch.catch(() => undefined);
    }
    await executor.launched.promise;
    await vi.waitFor(() => expect(executor.launches).toBe(1));
    const currentAttempt = observeExecutionAttempts(coreDb).find(
      (attempt) =>
        attempt.turn_id ===
        {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: store.getTurnById(turnId!).threadId,
          turnId,
        }.turnId
    );
    expect(currentAttempt, 'The launched Turn must have its exact durable attempt.').toBeDefined();
    expect(executor.checkpointAtLaunch).toMatchObject({
      stage: 'running_worker',
      workerSessionId: currentAttempt!.agent_session_id,
      stopReason: null,
    });
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
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        statuses: ['queued', 'admitted', 'denied', 'cancelled', 'expired'],
      })
    ).toHaveLength(1);
    // Native launch requires the exact immutable initiating Item before Session/checkpoint binding.
    const initiatingItemId = deriveEntityId('it', ['task-user', turnId]);
    const initiatingItems = store
      .getTurnById(turnId)
      .items.filter((i) => i.type === 'user-message');
    expect(initiatingItems).toEqual([
      expect.objectContaining({
        id: initiatingItemId,
        actor: store.getTurnById(turnId).triggerActor,
        text: executor.inputs[0],
        status: 'completed',
      }),
    ]);
    if (entry === 'direct') {
      const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      const checkpoint = getWorkerCheckpoint(
        workspaceDb,
        'ws_00000000-0000-7000-8000-000000000001',
        store.getTurnById(turnId).threadId,
        turnId
      )!;
      try {
        for (const [column, original] of [
          ['request_input_hash', checkpoint.requestInputHash],
          ['context_digest', checkpoint.contextDigest],
        ] as const) {
          await mutateQuiescentCheckpoint(() =>
            workspaceDb.sqlite
              .prepare(`UPDATE worker_turn_checkpoints SET ${column} = ? WHERE checkpoint_id = ?`)
              .run('sha256:contradiction', checkpoint.checkpointId)
          );
          try {
            const refused = await submit();
            expect(refused.status).toBe(409);
            await expect(refused.json()).resolves.toMatchObject({ code: 'recovery_required' });
          } finally {
            await mutateQuiescentCheckpoint(() =>
              workspaceDb.sqlite
                .prepare(`UPDATE worker_turn_checkpoints SET ${column} = ? WHERE checkpoint_id = ?`)
                .run(original, checkpoint.checkpointId)
            );
          }
        }
      } finally {
        workspaceDb.sqlite.close();
      }
      expect((await submit()).status).toBe(202);
      expect(executor.launches).toBe(1);
    }
    executor.completion.resolve();
    await executor.finished.promise;
    if (entry === 'closeout-failure')
      await expect(executor.execution).rejects.toThrow('Controlled release response loss.');
    else await executor.execution;
    await dispatch;
    await vi.waitFor(() =>
      expect(
        observeExecutionAttempts(coreDb).find((attempt) => attempt.turn_id === turnId)?.phase
      ).toBe(entry === 'closeout-failure' ? 'closing' : 'closed')
    );
    await setImmediate();
    const turnRead = await app.request(
      ...operationRequest(
        'turn.read',
        {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: workerThreadId,
          turnId,
        },
        { method: 'GET' }
      )
    );
    expect(turnRead.status).toBe(200);
    expect(await turnRead.json()).toMatchObject({ id: turnId, status: 'completed' });
    const itemsRead = await app.request(
      ...operationRequest(
        'thread.items',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001', threadId: workerThreadId },
        { method: 'GET' }
      )
    );
    expect(itemsRead.status).toBe(200);
    expect((await itemsRead.json()).items).toContainEqual(
      expect.objectContaining({
        id: deriveEntityId('it', ['worker', turnId, 1]),
        type: 'assistant-message',
        status: 'completed',
        text: executor.inputs[0],
      })
    );
    const terminalItems = store.getTurnById(turnId).items;
    expect(terminalItems.filter((item) => item.type === 'assistant-message')).toHaveLength(1);
    expect(terminalItems.filter((item) => item.type === 'user-message')).toEqual(initiatingItems);
    await assertNativeTaskAdmission(coreDb, store, turnId, entry === 'closeout-failure');
    expect(executor.releaseResults).toEqual([
      expect.objectContaining({
        state: 'released',
        fenceRef: expect.any(String),
        attemptId: currentAttempt!.attempt_id,
      }),
    ]);
    await loopSettled.promise;
    if (entry !== 'closeout-failure') await collected.promise;
    const terminalReplay = await submit();
    if (entry === 'closeout-failure') {
      expect(terminalReplay.status).toBe(409);
      await expect(terminalReplay.json()).resolves.toMatchObject({ code: 'recovery_required' });
    } else {
      expect(terminalReplay.status).toBe(token ? 200 : 202);
      const terminalWire = await terminalReplay.json();
      if (entry === 'assistant') {
        expect(SubmitConversationResponseSchema.parse(terminalWire)).toEqual(result);
      } else {
        const terminal = StartTaskModeResponseSchema.parse(
          token ? JSON.parse(terminalWire.result.content[0].text) : terminalWire
        );
        expect(terminal).toMatchObject({
          state: 'completed',
          turn: { id: turnId },
          completion: { itemId: deriveEntityId('it', ['worker', turnId, 1]) },
        });
      }
    }
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    try {
      const checkpoint = getWorkerCheckpoint(
        workspaceDb,
        'ws_00000000-0000-7000-8000-000000000001',
        workerThreadId,
        turnId
      );
      if (entry === 'closeout-failure') expect(checkpoint?.stage).toBe('completed');
      else expect(checkpoint).toBeNull();
    } finally {
      workspaceDb.sqlite.close();
    }
    expect(deletedCheckpointTurns.filter((clearedTurnId) => clearedTurnId === turnId)).toHaveLength(
      entry === 'closeout-failure' ? 0 : 1
    );
    const closedAttempt = observeExecutionAttempts(coreDb).filter(
      (attempt) =>
        attempt.turn_id ===
        {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: store.getTurnById(turnId!).threadId,
          turnId,
        }.turnId
    )[0]!;
    const repeatedReplay = await submit();
    expect(repeatedReplay.status).toBe(entry === 'closeout-failure' ? 409 : token ? 200 : 202);
    expect(
      observeExecutionAttempts(coreDb).filter(
        (attempt) =>
          attempt.turn_id ===
          {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
            turnId,
          }.turnId
      )[0]
    ).toEqual(closedAttempt);
    expect(
      store.getTurnEvents(turnId).filter((event) => event.event === 'turn.completed')
    ).toHaveLength(1);

    expect(store.getCommandRequest(command, requestId, scope)).toEqual(receipt);
    expect(store.getTurnById(turnId).items).toEqual(terminalItems);
    expect(executor.launches).toBe(1);
    if (entry === 'assistant') {
      // Pending Resolve: exact replay preserves the recorded answer without another effect.
      const answerReplay = await app.request(...answerRequest!);
      expect(answerReplay.status, await answerReplay.clone().text()).toBe(200);
      expect(await answerReplay.json()).toEqual(answerResult);
      expect(
        store.listCommandRequests().filter((record) => record.command === 'user_input.answer')
      ).toEqual([answerReceipt]);
      expect(store.getCommandRequest(command, requestId, scope)).toEqual(receipt);
      expect(store.getTurnById(proposingTurn!.id)).toEqual(proposingTurn);
      const receivingTurn = store.getTurnById(turnId);
      expect(receivingTurn).toMatchObject({
        agentId: setup.manifest.id,
        triggerSource: { kind: 'handoff' },
      });
      expect(workerThreadId).not.toBe(scope.threadId);
      expect(store.getThread(scope.workspaceId, workerThreadId)).toMatchObject({
        visibility: 'workspace',
        parentThreadId: scope.threadId,
      });
      const handoff = store
        .listThreadItems(scope.workspaceId, scope.threadId)
        .find((item) => item.type === 'status' && item.causationId === turnId);
      expect(handoff).toMatchObject({ status: 'completed', threadId: scope.threadId });
      expect(handoff!.turnId).not.toBe(proposingTurn!.id);
      const outcomeTurn = store.getTurnById(handoff!.turnId);
      expect(outcomeTurn).toMatchObject({
        threadId: scope.threadId,
        status: 'completed',
        triggerSource: { kind: 'user-input' },
      });
      const sourceDb = openWorkspaceDb(dataRoot, scope.workspaceId);
      try {
        expect(
          listThreadPendingRequests(sourceDb.sqlite, scope.workspaceId, scope.threadId)
        ).toContainEqual(
          expect.objectContaining({
            raisingTurnId: proposingTurn!.id,
            requestItemId,
            requesterKind: 'assistant',
            resolution: 'answered',
            delivery: 'delivered',
            deliveryCause: 'outcome',
            deliveryTurnId: outcomeTurn.id,
            assistantHandoff: {
              kind: 'task',
              targetWorkspaceId: scope.workspaceId,
              input,
              agentId: setup.manifest.id,
            },
          })
        );
      } finally {
        sourceDb.sqlite.close();
      }
      expect(executor.launches).toBe(1);
      expect(provider.createResponses).toHaveBeenCalledTimes(2);
      expect(store.listCommandRequests().filter((r) => r.command === 'task.start')).toHaveLength(0);
      expect(
        store.listCommandRequests().filter((r) => r.command === 'conversation.submit')
      ).toHaveLength(1);
    }
    expect(
      listSchedulerAdmissionEntriesForWorkspace(coreDb, {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        statuses: ['queued', 'admitted', 'denied', 'cancelled', 'expired'],
      })
    ).toHaveLength(1);
  } finally {
    executor.completion.resolve();
    await pending.catch(() => undefined);
    await dispatch.catch(() => undefined);
    if (executor.launches > 0) {
      await executor.finished.promise;
      const succeeded = await executor.execution.then(
        () => true,
        () => false
      );
      await loopSettled.promise;
      if (succeeded) await collected.promise.catch(() => undefined);
    }
    await setImmediate();
    receiptPublication.mockRestore();
    terminalPublication.mockRestore();
    if (loopOwners.runWorkerTurnLoop === loopObservation) loopObservation.mockRestore();
    if (recoveryOwners.clearWorkerCheckpointAfterTerminalState === collectionObservation)
      collectionObservation.mockRestore();
    await native.restore();
    await shutdownControlStoreWorkerClient();
    coreDb.sqlite.close();
    rmSync(dataRoot, { force: true, recursive: true });
  }
}

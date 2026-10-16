import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { SubmitConversationResponseSchema } from '@openkit/app-api-schemas';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { ensureLocalUser } from './auth/identity.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import { FsStore } from './lib/store.js';
import type {
  OpenAICompatibleResponsesRequest,
  OpenAICompatibleResponsesResponse,
} from './llm/openai-compatible-client.js';
import type { PiAiGatewayClient } from './llm/pi-ai-client.js';
import { classifyDirectTaskCheckpointAfterSchedulerRecovery } from './mode-entry-routes.js';
import { ProviderRegistry } from './providers/registry.js';
import { listThreadPendingRequests, readPendingRequest } from './runtime/pending-requests.js';
import { getSchedulerPreparationClaims } from './runtime/scheduler-dispatch-loop.js';
import { getWorkerCheckpoint } from './runtime/worker-checkpoints.js';
import { WorkerGovernanceCapacityUnavailableError } from './runtime/worker-governance-backend.js';
import { listSchedulerAdmissionEntriesForWorkspace } from './scheduler-records.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { LOCAL_USER_ID } from './storage/fs-layout.js';
import { applyMigrations } from './storage/migrate.js';
import { createTestAgentSetup, createTestGatewayConfig } from './test-support/agent-environment.js';
import { createApp } from './test-support/app.js';
import { recordTestNativeRuntimeTarget } from './test-support/native-environment.js';
import { operationRequest } from './test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const privateMarker = 'AMBIENT_PRIVATE_TIMELINE_DETAIL_NOT_SELECTED_FOR_SHARED_WORK';
const brief = '  What is OpenKit?\nDo not deploy anything.\nReply with its title.  ';
const conversationInput = 'Explain the next step for this sample.';

/** Returns an ordinary completed model answer after its proposed exact Task call. */
function answer(): OpenAICompatibleResponsesResponse {
  return {
    id: randomUUID(),
    object: 'response',
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          { type: 'output_text', text: 'The exact work brief is ready for your selection.' },
        ],
      },
    ],
  };
}

/** Composes actual Assistant, Pending Request, Task, scheduler, identity and setup owners. */
function fixture(targetWorkspaceId?: string) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'assistant-semantic-handoff-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Semantic Task handoff');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: LOCAL_USER_ID });
  const thread = store.createThread(workspace.id, 'Private Assistant', undefined, 'conversation', {
    visibility: 'private',
    privateOwnerUserId: LOCAL_USER_ID,
  });
  const old = store.createTurn(workspace.id, thread.id, 'Private prior context.', {
    kind: 'user',
    id: LOCAL_USER_ID,
  });
  const timestamp = old.startedAt!;
  store.createItem({
    id: randomUUID(),
    workspaceId: workspace.id,
    threadId: thread.id,
    turnId: old.id,
    type: 'user-message',
    actor: { kind: 'user', id: LOCAL_USER_ID },
    text: privateMarker,
    status: 'completed',
    createdAt: timestamp,
    completedAt: timestamp,
  });
  store.updateTurn(old.id, { status: 'completed', completedAt: timestamp });
  const preferred = createTestAgentSetup({ agentId: 'agent_semantic_preferred' });
  const selected = createTestAgentSetup({ agentId: 'agent_semantic_selected' });
  const modelId = selected.logicalModels.preferredLogicalModelId;
  const proposed = {
    input: brief,
    agentId: selected.manifest.id,
    modelId,
    ...(targetWorkspaceId ? { targetWorkspaceId } : {}),
  };
  const requests: OpenAICompatibleResponsesRequest[] = [];
  const executor = new SimulatedTurnExecutor({ coreDb });
  recordTestNativeRuntimeTarget(coreDb);
  // Capacity is the external held boundary. Readiness and queued admission use their real owners.
  const preparation = vi
    .spyOn(executor, 'prepareAgentSessionForTurn')
    .mockRejectedValue(new WorkerGovernanceCapacityUnavailableError());
  const launches = vi.spyOn(executor, 'startTurn');
  const provider = {
    createResponses: async (
      _provider: unknown,
      request: OpenAICompatibleResponsesRequest
    ): Promise<OpenAICompatibleResponsesResponse> => {
      requests.push(structuredClone(request));
      return requests.length === 1
        ? {
            id: randomUUID(),
            object: 'response',
            status: 'completed',
            output: [
              {
                type: 'function_call',
                name: 'task_start',
                call_id: 'semantic-task-proposal',
                arguments: JSON.stringify(proposed),
              },
            ],
          }
        : answer();
    },
  } as unknown as PiAiGatewayClient;
  const makeApp = (ownerStore: FsStore) =>
    createApp({
      coreDb,
      dataRoot,
      store: ownerStore,
      turnExecutor: executor,
      agentManifests: [preferred.manifest, selected.manifest],
      gatewayConfig: createTestGatewayConfig(),
      internalRoleProfiles: { schemaVersion: 1, defaultLogicalModelId: modelId, profiles: [] },
      providerRegistry: new ProviderRegistry([
        {
          id: 'agent-openrouter',
          displayName: 'Semantic fixture',
          kind: 'local',
          models: ['openai/gpt-5.2'],
        },
      ]),
      openKitConfig: { defaults: { defaultAgentId: preferred.manifest.id } },
      llmPiAiClient: provider,
    });
  const app = makeApp(store);
  const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  onTestFinished(async () => {
    await setImmediate();
    await Promise.allSettled([...getSchedulerPreparationClaims(coreDb).values()]);
    preparation.mockRestore();
    launches.mockRestore();
    if (workspaceDb.sqlite.open) workspaceDb.sqlite.close();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const requestId = randomUUID();
  const scope = { actorId: LOCAL_USER_ID, workspaceId: workspace.id, threadId: thread.id };
  const submit = (target = app) =>
    target.request(
      ...operationRequest(
        'conversation.submit',
        { workspaceId: workspace.id, threadId: thread.id },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            input: conversationInput,
            requestId,
            targetRef: 'internal-role:assistant',
            artifactRefs: [],
          }),
        }
      )
    );
  const admissions = () =>
    listSchedulerAdmissionEntriesForWorkspace(coreDb, {
      workspaceId: workspace.id,
      statuses: ['queued', 'admitted', 'denied', 'cancelled', 'expired'],
    });
  return {
    dataRoot,
    coreDb,
    store,
    workspace,
    thread,
    selected,
    modelId,
    proposed,
    requests,
    executor,
    preparation,
    launches,
    app,
    makeApp,
    workspaceDb,
    requestId,
    scope,
    submit,
    admissions,
  };
}

describe('Assistant semantic Task handoff', () => {
  it.each([
    false,
    true,
  ])('proposes exact work, waits for selection, and admits a shared Task without rerouting or nested receipts (restart=%s)', async (restart) => {
    const f = fixture();
    const response = await f.submit();
    expect(f.requests.length).toBeGreaterThan(0);
    const tools = f.requests[0]!.tools as Array<{
      name: string;
      parameters: { properties?: Record<string, unknown> };
    }>;
    expect(tools.map((tool) => tool.name)).toContain('task_start');
    const task = tools.find((tool) => tool.name === 'task_start')!;
    expect(task.parameters.properties).toHaveProperty('input');
    expect(task.parameters.properties).toHaveProperty('agentId');
    expect(task.parameters.properties).toHaveProperty('modelId');
    for (const field of ['workspaceId', 'threadId', 'turnId', 'requestId', 'actorId'])
      expect(task.parameters.properties).not.toHaveProperty(field);
    expect([200, 202]).toContain(response.status);
    const accepted = SubmitConversationResponseSchema.parse(await response.json());
    expect(accepted.turn.status).toBe('completed');
    expect(f.requests).toHaveLength(2);
    expect(JSON.stringify(f.requests[0]!.input)).toContain(privateMarker);
    const request = f.store
      .listThreadItems(f.workspace.id, f.thread.id)
      .find((item) => item.turnId === accepted.turn.id && item.type === 'user-input-request');
    expect(request).toBeDefined();
    if (request?.type !== 'user-input-request')
      throw new Error('Missing canonical handoff confirmation.');
    expect(request.assistantHandoff).toEqual({
      kind: 'task',
      targetWorkspaceId: f.workspace.id,
      ...f.proposed,
    });
    expect(request.responsibleUserId).toBe(LOCAL_USER_ID);
    expect(request.questions).toHaveLength(1);
    expect(request.questions[0]!.isSecret).toBe(false);
    expect(request.questions[0]!.options?.map((option) => option.label)).toContain(
      'Confirm exact handoff'
    );
    expect(request.questions[0]!.options?.map((option) => option.label)).toContain('Do not start');
    expect(
      listThreadPendingRequests(f.workspaceDb.sqlite, f.workspace.id, f.thread.id)
    ).toHaveLength(1);
    expect(readPendingRequest(f.workspaceDb.sqlite, request.userInputRequestId)).toMatchObject({
      state: 'pending',
      kind: 'user-input',
      requesterKind: 'assistant',
      assistantHandoff: request.assistantHandoff,
    });
    expect(f.admissions()).toEqual([]);
    expect(f.preparation).not.toHaveBeenCalled();
    expect(f.launches).not.toHaveBeenCalled();
    expect(f.store.listThreads(f.workspace.id)).toHaveLength(1);
    const originalReceipt = structuredClone(
      f.store.getCommandRequest('conversation.submit', f.requestId, f.scope)
    );
    expect(originalReceipt).not.toBeNull();
    if (restart) {
      f.store = new FsStore({ dataRoot: f.dataRoot });
      f.app = f.makeApp(f.store);
      expect(
        f.store.listThreadItems(f.workspace.id, f.thread.id).find((item) => item.id === request.id)
      ).toEqual(request);
    }
    const beforeSelectionReplay = await f.submit(f.app);
    expect(beforeSelectionReplay.status, await beforeSelectionReplay.clone().text()).toBe(
      response.status
    );
    expect(SubmitConversationResponseSchema.parse(await beforeSelectionReplay.json())).toEqual(
      accepted
    );
    expect(f.requests).toHaveLength(2);
    expect(f.admissions()).toEqual([]);

    const answerRequestId = randomUUID();
    const answer = () =>
      f.app.request(
        ...operationRequest(
          'question.answer',
          { userInputRequestId: request.userInputRequestId },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              workspaceId: f.workspace.id,
              threadId: f.thread.id,
              requestId: answerRequestId,
              answers: { [request.questions[0]!.id]: ['Confirm exact handoff'] },
            }),
          }
        )
      );
    const answered = await answer();
    expect(answered.status, await answered.clone().text()).toBe(200);
    const answerBody = await answered.json();
    await vi.waitFor(() => expect(f.admissions()).toHaveLength(1));
    expect(f.requests).toHaveLength(2);
    const [admission] = f.admissions();
    expect(admission).toMatchObject({
      workspaceId: f.workspace.id,
      requestedAgentId: f.selected.manifest.id,
      modelId: f.modelId,
      status: 'queued',
    });
    const receiving = f.store.getThread(f.workspace.id, admission!.threadId);
    expect(receiving).toMatchObject({
      parentThreadId: f.thread.id,
      threadSource: 'worker',
      visibility: 'workspace',
    });
    expect(receiving.id).not.toBe(f.thread.id);
    const worker = f.store.getTurnById(admission!.turnId);
    expect(worker).toMatchObject({ agentId: f.selected.manifest.id, status: 'pending' });
    expect(worker.agentSessionId ?? null).toBeNull();
    const workerInput = JSON.parse(admission!.turnInput);
    expect(workerInput.objective).toBe(brief);
    expect(workerInput.constraints.maxWorkerIterations).toBe(1);
    expect(admission!.turnInput).not.toContain(privateMarker);
    expect(admission!.turnInput).not.toContain('Confirm exact handoff');
    expect(JSON.stringify(f.store.listThreadTurns(f.workspace.id, receiving.id))).not.toContain(
      privateMarker
    );
    expect(
      getWorkerCheckpoint(f.workspaceDb, f.workspace.id, receiving.id, worker.id)
    ).not.toBeNull();
    await expect(
      classifyDirectTaskCheckpointAfterSchedulerRecovery({
        coreDb: f.coreDb,
        store: f.store,
        workspaceDb: f.workspaceDb,
        checkpoint: getWorkerCheckpoint(f.workspaceDb, f.workspace.id, receiving.id, worker.id)!,
      })
    ).resolves.toBe('live');
    const delivered = readPendingRequest(f.workspaceDb.sqlite, request.userInputRequestId)!;
    expect(delivered).toMatchObject({ state: 'resolved', delivery: 'delivered' });
    expect(delivered.deliveryTurnId).not.toBe(accepted.turn.id);
    expect(f.store.getTurnById(delivered.deliveryTurnId!)).toMatchObject({ status: 'completed' });
    const handoff = f.store
      .listThreadItems(f.workspace.id, f.thread.id)
      .find(
        (item) =>
          item.turnId === delivered.deliveryTurnId &&
          item.type === 'status' &&
          item.title === 'Task Mode handoff'
      );
    expect(handoff).toBeDefined();
    expect(
      f.store.listCommandRequests().filter((receipt) => receipt.command === 'task.start')
    ).toEqual([]);
    expect(
      f.store.listCommandRequests().filter((receipt) => receipt.command === 'conversation.submit')
    ).toHaveLength(1);
    expect(f.store.getCommandRequest('conversation.submit', f.requestId, f.scope)).toEqual(
      originalReceipt
    );
    expect(f.launches).not.toHaveBeenCalled();
    const admitted = f.admissions();
    const receipts = f.store.listCommandRequests();
    const answerReplay = await answer();
    expect(answerReplay.status, await answerReplay.clone().text()).toBe(200);
    expect(await answerReplay.json()).toEqual(answerBody);
    const conversationReplay = await f.submit(f.app);
    expect(conversationReplay.status, await conversationReplay.clone().text()).toBe(
      response.status
    );
    expect(SubmitConversationResponseSchema.parse(await conversationReplay.json())).toEqual(
      accepted
    );
    expect(f.admissions()).toEqual(admitted);
    expect(f.store.listCommandRequests()).toEqual(receipts);
    expect(f.requests).toHaveLength(2);
    expect(f.launches).not.toHaveBeenCalled();
  });
  it.each([
    'Do not start',
    'Yes, but change the work',
  ])('keeps a non-exact selection inert: %s', async (answer) => {
    const f = fixture();
    expect((await f.submit()).status).toBe(202);
    const request = f.store
      .listThreadItems(f.workspace.id, f.thread.id)
      .find((item) => item.type === 'user-input-request');
    if (request?.type !== 'user-input-request') throw new Error('Missing request.');
    const response = await f.app.request(
      ...operationRequest(
        'question.answer',
        { userInputRequestId: request.userInputRequestId },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            workspaceId: f.workspace.id,
            threadId: f.thread.id,
            requestId: randomUUID(),
            answers: { handoff: [answer] },
          }),
        }
      )
    );
    expect(response.status, await response.clone().text()).toBe(200);
    await vi.waitFor(() =>
      expect(readPendingRequest(f.workspaceDb.sqlite, request.userInputRequestId)?.delivery).toBe(
        'delivered'
      )
    );
    const record = readPendingRequest(f.workspaceDb.sqlite, request.userInputRequestId)!;
    await vi.waitFor(() =>
      expect(f.store.getTurnById(record.deliveryTurnId!).status).toBe('completed')
    );
    expect(f.store.listThreadItems(f.workspace.id, f.thread.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: 'Handoff not started' })])
    );
    expect(f.admissions()).toEqual([]);
    expect(f.store.listThreads(f.workspace.id)).toHaveLength(1);
    expect(f.requests).toHaveLength(2);
    expect(f.launches).not.toHaveBeenCalled();
  });

  it('refuses a confirmed unavailable destination without creating execution owners or another model call', async () => {
    const f = fixture('unavailable-receiving-workspace');
    expect((await f.submit()).status).toBe(202);
    const request = f.store
      .listThreadItems(f.workspace.id, f.thread.id)
      .find((item) => item.type === 'user-input-request');
    if (request?.type !== 'user-input-request') throw new Error('Missing request.');
    const response = await f.app.request(
      ...operationRequest(
        'question.answer',
        { userInputRequestId: request.userInputRequestId },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            workspaceId: f.workspace.id,
            threadId: f.thread.id,
            requestId: randomUUID(),
            answers: { handoff: ['Confirm exact handoff'] },
          }),
        }
      )
    );
    expect(response.status, await response.clone().text()).toBe(200);
    await vi.waitFor(() =>
      expect(f.store.listThreadItems(f.workspace.id, f.thread.id)).toEqual(
        expect.arrayContaining([expect.objectContaining({ title: 'Handoff refused' })])
      )
    );
    expect(f.admissions()).toEqual([]);
    expect(f.store.listThreads(f.workspace.id)).toHaveLength(1);
    expect(f.requests).toHaveLength(2);
    expect(f.launches).not.toHaveBeenCalled();
  });

  it('rejects a changed pending payload against its canonical request before selection or execution', async () => {
    const f = fixture();
    expect((await f.submit()).status).toBe(202);
    const request = f.store
      .listThreadItems(f.workspace.id, f.thread.id)
      .find((item) => item.type === 'user-input-request');
    if (request?.type !== 'user-input-request') throw new Error('Missing request.');
    f.workspaceDb.sqlite
      .prepare('UPDATE pending_requests SET assistant_handoff_json = ? WHERE request_id = ?')
      .run(
        JSON.stringify({ ...request.assistantHandoff, input: 'Changed unconfirmed work' }),
        request.userInputRequestId
      );
    const response = await f.app.request(
      ...operationRequest(
        'question.answer',
        { userInputRequestId: request.userInputRequestId },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            workspaceId: f.workspace.id,
            threadId: f.thread.id,
            requestId: randomUUID(),
            answers: { handoff: ['Confirm exact handoff'] },
          }),
        }
      )
    );
    expect(response.status, await response.clone().text()).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'recovery_required' });
    expect(f.admissions()).toEqual([]);
    expect(f.requests).toHaveLength(2);
    expect(f.launches).not.toHaveBeenCalled();
  });
});

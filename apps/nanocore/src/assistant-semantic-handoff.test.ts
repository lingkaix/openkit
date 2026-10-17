import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { SubmitConversationResponseSchema } from '@openkit/app-api-schemas';
import {
  allocateEntityId,
  deriveEntityId,
  isThreadId,
  isTurnId,
  parseReferenceScope,
  RetrievalTraceReferenceSchema,
} from '@openkit/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createWorkerContextPackageAuthorityReader } from './context/worker-context-authorities.js';
import * as packageFilesOwner from './context/worker-context-package.js';
import { readAssistantTaskHandoffSource } from './internal-agents/assistant-handoff-source.js';
import { StructuredWorkerDelegationRequestSchema } from './internal-agents/delegation.js';
import * as workerCoordinator from './internal-agents/worker-coordinator.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import { FsStore } from './lib/store.js';
import type {
  OpenAICompatibleResponsesRequest,
  OpenAICompatibleResponsesResponse,
} from './llm/openai-compatible-client.js';
import type { PiAiGatewayClient } from './llm/pi-ai-client.js';
import { classifyDirectTaskCheckpointAfterSchedulerRecovery } from './mode-entry-routes.js';
import { ProviderRegistry } from './providers/registry.js';
import { commandInputHash } from './runtime/idempotent-command.js';
import {
  answerPendingRequest,
  assistantPendingOutcomeSource,
  assistantPendingOutcomeSourceHash,
  freezeReadyOutcomes,
  listThreadPendingRequests,
  pendingRequestItemId,
  proveFrozenDelivery,
  raisePendingRequest,
  readPendingRequest,
} from './runtime/pending-requests.js';
import {
  getSchedulerPreparationClaims,
  runSchedulerDispatchLoop,
} from './runtime/scheduler-dispatch-loop.js';
import {
  createWorkerCheckpointContextDiagnostics,
  getWorkerCheckpoint,
  upsertWorkerCheckpoint,
} from './runtime/worker-checkpoints.js';
import { WorkerGovernanceCapacityUnavailableError } from './runtime/worker-governance-backend.js';
import { prepareWorkerTurnContextPackage } from './runtime/worker-governance-turn-executor.js';
import {
  createSchedulerAdmissionEntry,
  listSchedulerAdmissionEntriesForWorkspace,
} from './scheduler-records.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { allocateRetrievalTraceId, readTurnRetrievalTraces } from './storage/retrieval-traces.js';
import { createTestAgentSetup, createTestGatewayConfig } from './test-support/agent-environment.js';
import { createApp } from './test-support/app.js';
import {
  ensureLocalUser,
  FIXTURE_LOCAL_USER_ID as LOCAL_USER_ID,
} from './test-support/local-user.js';
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
    id: allocateEntityId('it'),
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
  it('keeps a retained predecessor receipt-free Task inspect-only after reopen without resuming it', async () => {
    const f = fixture();
    // Reconstruct the P14-canonical queued boundary before P19 selection proofs and Worker closeout.
    // The old receiving Thread has no parent/source, and an ordinary answer has no exact selection.
    f.store.setTurnAdmissionHooks(null);
    const now = '2026-10-14T00:00:00.000Z';
    const actor = { kind: 'user' as const, id: LOCAL_USER_ID };
    const input = 'Implement the bounded sample change.';
    const raising = f.store.createTurn(
      f.workspace.id,
      f.thread.id,
      'Clarify the work.',
      actor,
      null,
      {
        turnId: 'tu_00000000-0000-761d-86dc-d622daff63ac',
        agentId: 'quick-chat',
        startedAt: now,
      }
    );
    const requestId = `ui_chat_clarify_${raising.id}`;
    const requestItemId = pendingRequestItemId(requestId, 'request');
    const questions = [
      {
        id: 'chat_clarification',
        header: 'Clarify',
        question: 'What should the Assistant answer or help route?',
        options: null,
        isOther: true,
        isSecret: false,
      },
    ];
    f.store.createItem({
      id: requestItemId,
      workspaceId: f.workspace.id,
      threadId: f.thread.id,
      turnId: raising.id,
      type: 'user-input-request',
      userInputRequestId: requestId,
      responsibleUserId: LOCAL_USER_ID,
      prompt: 'Chat Mode needs a more specific request.',
      questions,
      status: 'completed',
      createdAt: now,
      completedAt: now,
    });
    raisePendingRequest(f.workspaceDb.sqlite, {
      requestId,
      requestItemId,
      workspaceId: f.workspace.id,
      threadId: f.thread.id,
      raisingTurnId: raising.id,
      kind: 'user-input',
      requesterKind: 'assistant',
      responsibleUserId: LOCAL_USER_ID,
      questions,
      now,
    });
    f.store.updateTurn(raising.id, { status: 'completed', completedAt: now });
    const answers = { chat_clarification: [input] as [string] };
    expect(
      answerPendingRequest(f.workspaceDb.sqlite, requestId, actor, answers, now)
    ).not.toBeNull();
    const source = f.store.createTurn(
      f.workspace.id,
      f.thread.id,
      'User-input outcomes',
      actor,
      null,
      {
        turnId: 'tu_00000000-0000-70e1-87b7-8529640d6c74',
        agentId: 'quick-chat',
        executorKind: 'assistant',
        startedAt: now,
        triggerSource: { kind: 'user-input', summary: 'User-input outcomes are ready.' },
      }
    );
    expect(
      freezeReadyOutcomes(f.workspaceDb.sqlite, {
        workspaceId: f.workspace.id,
        threadId: f.thread.id,
        turnId: source.id,
        executor: 'assistant',
        cause: 'outcome',
        now,
      })
    ).toHaveLength(1);
    f.store.createItem({
      id: pendingRequestItemId(requestId, 'answer'),
      workspaceId: f.workspace.id,
      threadId: f.thread.id,
      turnId: source.id,
      type: 'user-input-response',
      actor,
      causationId: requestItemId,
      userInputRequestId: requestId,
      answers,
      answeredAt: now,
      status: 'completed',
      createdAt: now,
      completedAt: now,
    });
    expect(proveFrozenDelivery(f.workspaceDb.sqlite, source.id, now)).toHaveLength(1);
    const record = readPendingRequest(f.workspaceDb.sqlite, requestId)!;
    expect(record.assistantHandoff).toBeNull();
    expect(record).toMatchObject({
      state: 'resolved',
      resolution: 'answered',
      delivery: 'delivered',
    });
    // This is the prior declared hash input, without a new nullable descriptor field.
    const priorHash = commandInputHash({
      workspaceId: f.workspace.id,
      threadId: f.thread.id,
      turnId: source.id,
      responsibleUserId: LOCAL_USER_ID,
      input: [
        {
          requestId,
          requestItemId,
          publicationTurnId: source.id,
          resolution: 'answered',
          ending: null,
          disposition: null,
          answerMap: answers,
          decidedAt: now,
          endedAt: null,
        },
      ],
    });
    expect(assistantPendingOutcomeSourceHash(source, [record], LOCAL_USER_ID)).toBe(priorHash);
    const receiving = f.store.createThread(
      f.workspace.id,
      input,
      deriveEntityId('th', assistantPendingOutcomeSource(source, [record], LOCAL_USER_ID)),
      'conversation',
      { visibility: 'workspace', threadSource: undefined }
    );
    const turnId = deriveEntityId(
      'tu',
      assistantPendingOutcomeSource(source, [record], LOCAL_USER_ID)
    );
    const workerRequestId = `pending_${priorHash}`;
    const workerRequest = StructuredWorkerDelegationRequestSchema.parse({
      schemaVersion: 1,
      objective: input,
      acceptanceCriteria: ['The bounded worker task satisfies the requested objective.'],
      contextRefs: [
        { kind: 'workspace', id: f.workspace.id },
        { kind: 'thread', id: f.thread.id },
        { kind: 'item', id: requestItemId },
      ],
      resources: [],
      expectedArtifacts: [],
      constraints: { maxContextTokens: 240_000, maxWorkerIterations: 1 },
      verification: [{ kind: 'manual', description: 'Check the result against the objective.' }],
      reviewPolicy: { required: false, reviewers: ['human'], instructions: 'Review the result.' },
      escalationConditions: [],
      reviewContext: null,
    });
    const turnInput = JSON.stringify(workerRequest);
    const contextDigest = commandInputHash(workerRequest);
    const worker = f.store.createTurn(f.workspace.id, receiving.id, turnInput, actor, null, {
      turnId,
      status: 'pending',
      agentId: f.selected.manifest.id,
      startedAt: now,
    });
    upsertWorkerCheckpoint(f.workspaceDb, {
      workspaceId: f.workspace.id,
      threadId: receiving.id,
      turnId,
      requestId: workerRequestId,
      requestInputHash: priorHash,
      stage: 'preparing',
      iteration: 0,
      contextDigest,
      diagnosticsSummary: createWorkerCheckpointContextDiagnostics({
        contextDigest,
        contextRefs: workerRequest.contextRefs,
        knowledgeSelectionInput: null,
      }),
      now: () => now,
    });
    const admission = createSchedulerAdmissionEntry(f.coreDb, {
      backendId: f.executor.id,
      queueEntryId: 'queue_predecessor_assistant',
      requestId: workerRequestId,
      triggerActor: actor,
      workspaceId: f.workspace.id,
      threadId: receiving.id,
      turnId,
      turnInput,
      requestedAgentId: f.selected.manifest.id,
      modelId: f.modelId,
      now: () => now,
    });
    expect(receiving.parentThreadId).toBeUndefined();
    expect(receiving.threadSource).toBeUndefined();
    // At this prior queued boundary the source is running: its old it_chat_task_ result is not yet written.
    expect(f.store.getTurnById(source.id).status).toBe('running');
    expect(f.store.listCommandRequests()).toEqual([]);

    /** Captures canonical history bytes and raw SQL values, including exact retained JSON strings. */
    const retained = (coreDb: typeof f.coreDb, workspaceDb: typeof f.workspaceDb) => {
      const history: Record<string, string> = {};
      const visit = (directory: string) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) visit(path);
          else history[path] = readFileSync(path).toString('hex');
        }
      };
      visit(join(f.dataRoot, 'workspaces', f.workspace.id, 'threads'));
      return {
        history,
        requests: workspaceDb.sqlite
          .prepare('SELECT * FROM pending_requests ORDER BY request_id')
          .all(),
        checkpoints: workspaceDb.sqlite
          .prepare('SELECT * FROM worker_turn_checkpoints ORDER BY checkpoint_id')
          .all(),
        receipts: workspaceDb.sqlite
          .prepare('SELECT * FROM idempotency_requests ORDER BY request_id')
          .all(),
        admissions: coreDb.sqlite
          .prepare('SELECT * FROM scheduler_admission_entries ORDER BY queue_entry_id')
          .all(),
        attempts: coreDb.sqlite
          .prepare('SELECT * FROM scheduler_execution_attempts ORDER BY attempt_id')
          .all(),
      };
    };
    const before = retained(f.coreDb, f.workspaceDb);
    f.workspaceDb.sqlite.close();
    f.coreDb.sqlite.close();
    const coreDb = openCoreDb(f.dataRoot);
    const workspaceDb = openWorkspaceDb(f.dataRoot, f.workspace.id);
    const store = new FsStore({ dataRoot: f.dataRoot });
    const coordinator = vi.spyOn(workerCoordinator, 'createWorkerCoordinatorDecision');
    const submit = vi.spyOn(f.executor, 'submit');
    const inspect = vi.spyOn(f.executor, 'inspect');
    const cancel = vi.spyOn(f.executor, 'cancel');
    const release = vi.spyOn(f.executor, 'release');
    try {
      expect(retained(coreDb, workspaceDb)).toEqual(before);
      expect(store.getTurnById(worker.id)).toEqual(worker);
      expect(readPendingRequest(workspaceDb.sqlite, requestId)).toEqual(record);
      const checkpoint = getWorkerCheckpoint(workspaceDb, f.workspace.id, receiving.id, turnId)!;
      expect(
        readAssistantTaskHandoffSource(store, workspaceDb, {
          ...checkpoint,
          turnInput,
          modelId: admission.modelId,
          triggerActor: actor,
        })
      ).toBeNull();
      for (let pass = 0; pass < 2; pass++) {
        await expect(
          classifyDirectTaskCheckpointAfterSchedulerRecovery({
            coreDb,
            store,
            workspaceDb,
            checkpoint,
          })
        ).rejects.toMatchObject({
          code: 'recovery_required',
          message: 'The sessionless Task has no exact initiating command receipt.',
        });
        expect(
          await runSchedulerDispatchLoop({
            coreDb,
            store,
            turnExecutor: f.executor,
            executionBackend: f.executor.executionBackend,
            agentManifests: [f.selected.manifest],
            gatewayConfig: createTestGatewayConfig(),
            providerRegistry: new ProviderRegistry([]),
            maxDispatches: 1,
          })
        ).toEqual({
          startedTurns: [],
          terminalResult: { status: 'queued', reason: 'entry-publication-pending' },
        });
        expect(retained(coreDb, workspaceDb)).toEqual(before);
        expect(store.listCommandRequests()).toEqual([]);
        expect(f.requests).toEqual([]);
        expect(coordinator).not.toHaveBeenCalled();
        expect(f.preparation).not.toHaveBeenCalled();
        expect(f.launches).not.toHaveBeenCalled();
        expect(submit).not.toHaveBeenCalled();
        expect(inspect).not.toHaveBeenCalled();
        expect(cancel).not.toHaveBeenCalled();
        expect(release).not.toHaveBeenCalled();
        expect(getSchedulerPreparationClaims(coreDb).size).toBe(0);
      }
    } finally {
      coordinator.mockRestore();
      submit.mockRestore();
      inspect.mockRestore();
      cancel.mockRestore();
      release.mockRestore();
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

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
    expect(request.prompt).toContain(
      'Private files are not included. Attach files explicitly when you select a Worker.'
    );
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
    // Receiving work must be usable by the existing query-scoped evidence owner after reopen.
    expect.soft(isThreadId(receiving.id)).toBe(true);
    expect.soft(isTurnId(worker.id)).toBe(true);
    const traceScope = `retrieval-trace/turn/${f.workspace.id}/${receiving.id}/${worker.id}`;
    expect.soft(parseReferenceScope(traceScope)).toEqual({
      family: 'retrieval-trace',
      kind: 'turn',
      workspaceId: f.workspace.id,
      threadId: receiving.id,
      turnId: worker.id,
    });
    expect
      .soft(
        RetrievalTraceReferenceSchema.safeParse({
          scopeId: traceScope,
          objectId: allocateRetrievalTraceId(),
        }).success
      )
      .toBe(true);
    const reopened = new FsStore({ dataRoot: f.dataRoot });
    expect(reopened.getThread(f.workspace.id, receiving.id)).toEqual(receiving);
    expect(reopened.getTurn(f.workspace.id, receiving.id, worker.id)).toEqual(worker);
    expect(
      readTurnRetrievalTraces(
        join(f.dataRoot, 'workspaces', f.workspace.id),
        f.workspace.id,
        receiving.id,
        worker.id
      )
    ).toEqual([]);

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
    const prepared = prepareWorkerTurnContextPackage(
      f.coreDb,
      f.workspaceDb,
      reopened,
      getWorkerCheckpoint(f.workspaceDb, f.workspace.id, receiving.id, worker.id)!,
      {
        agentSessionId: allocateEntityId('as'),
        workerRequest: admission!.turnInput,
        requestId: admission!.requestId,
        workspaceId: f.workspace.id,
        threadId: receiving.id,
        turnId: worker.id,
      }
    );
    expect(prepared.knowledgeSelectionInput).toBeNull();
    expect(prepared.packageFiles.knowledgeSelections).toEqual([]);
    expect(prepared.packageFiles.fileInventory.map((entry) => entry.path)).toEqual([
      'instructions.md',
      'package.json',
    ]);
    expect(JSON.stringify(prepared.packageFiles.files)).not.toContain(privateMarker);
    const delivered = readPendingRequest(f.workspaceDb.sqlite, request.userInputRequestId)!;
    expect(delivered).toMatchObject({ state: 'resolved', delivery: 'delivered' });
    const authority = createWorkerContextPackageAuthorityReader({
      coreDb: f.coreDb,
      workspaceDb: f.workspaceDb,
      store: reopened,
    });
    const sourceBinding = {
      workspaceId: f.workspace.id,
      threadId: receiving.id,
      turnId: worker.id,
      requestId: admission!.requestId!,
      workerRequest: admission!.turnInput,
    };
    expect(authority.readAssistantTaskHandoffSource?.(sourceBinding)).toMatchObject({
      sourceTurnId: delivered.deliveryTurnId,
    });
    const retainedAnswer = f.workspaceDb.sqlite
      .prepare('SELECT answer_map_json FROM pending_requests WHERE request_id = ?')
      .get(request.userInputRequestId) as { answer_map_json: string };
    const writes = vi.spyOn(packageFilesOwner, 'writeWorkerContextPackageFiles');
    try {
      // Alter only a retained source fact; live admission and source verification remain real.
      f.workspaceDb.sqlite
        .prepare('UPDATE pending_requests SET answer_map_json = ? WHERE request_id = ?')
        .run(JSON.stringify({ handoff: ['Do not start'] }), request.userInputRequestId);
      expect(authority.readAssistantTaskHandoffSource?.(sourceBinding)).toBeNull();
      expect(() =>
        prepareWorkerTurnContextPackage(
          f.coreDb,
          f.workspaceDb,
          reopened,
          getWorkerCheckpoint(f.workspaceDb, f.workspace.id, receiving.id, worker.id)!,
          { ...sourceBinding, agentSessionId: allocateEntityId('as') }
        )
      ).toThrow('Task Knowledge selection authority is contradictory');
      expect(writes).not.toHaveBeenCalled();
    } finally {
      f.workspaceDb.sqlite
        .prepare('UPDATE pending_requests SET answer_map_json = ? WHERE request_id = ?')
        .run(retainedAnswer.answer_map_json, request.userInputRequestId);
      writes.mockRestore();
    }
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
    'missing',
    'other-thread',
  ] as const)('keeps an Assistant command with a %s receipt pointer in recovery without rerouting or redispatch', async (damage) => {
    const f = fixture();
    const submitted = await f.submit();
    expect(submitted.status).toBe(202);
    const accepted = SubmitConversationResponseSchema.parse(await submitted.json());
    const original = f.store.getCommandRequest('conversation.submit', f.requestId, f.scope)!;
    if (damage === 'missing') {
      f.workspaceDb.sqlite
        .prepare('DELETE FROM idempotency_requests WHERE request_key = ?')
        .run(original.key);
    } else {
      const other = f.store.createThread(
        f.workspace.id,
        'Other retained conversation',
        undefined,
        'conversation',
        {
          visibility: 'private',
          privateOwnerUserId: LOCAL_USER_ID,
        }
      );
      const unrelated = f.store.createTurn(f.workspace.id, other.id, 'Other input', {
        kind: 'user',
        id: LOCAL_USER_ID,
      });
      f.workspaceDb.sqlite
        .prepare('UPDATE idempotency_requests SET response_id = ? WHERE request_key = ?')
        .run(unrelated.id, original.key);
    }
    const before = f.store.listThreadTurns(f.workspace.id, f.thread.id);
    const receipts = f.store.listCommandRequests();
    const reopened = new FsStore({ dataRoot: f.dataRoot });
    const app = f.makeApp(reopened);
    for (const input of [
      conversationInput,
      'What should I do?',
      'Search the web for release notes.',
    ]) {
      const replay = await app.request(
        ...operationRequest(
          'conversation.submit',
          {
            workspaceId: f.workspace.id,
            threadId: f.thread.id,
          },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              input,
              requestId: f.requestId,
              targetRef: 'internal-role:assistant',
              artifactRefs: [],
            }),
          }
        )
      );
      expect(replay.status, await replay.clone().text()).toBe(409);
      const body = await replay.json();
      expect(['recovery_required', 'idempotency_key_conflict']).toContain(body.code);
    }
    expect(reopened.getTurnById(accepted.turn.id)).toEqual(f.store.getTurnById(accepted.turn.id));
    expect(reopened.listThreadTurns(f.workspace.id, f.thread.id)).toEqual(before);
    expect(reopened.listCommandRequests()).toEqual(receipts);
    expect(f.admissions()).toEqual([]);
    expect(f.requests).toHaveLength(2);
    expect(f.preparation).not.toHaveBeenCalled();
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
    const f = fixture(allocateEntityId('ws'));
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

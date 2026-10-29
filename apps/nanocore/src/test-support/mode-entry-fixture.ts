import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  StartTaskModeResponseSchema,
  SubmitConversationResponseSchema,
} from '@openkit/app-api-schemas';
import { UserConfigSchema, WorkspaceConfigSchema } from '@openkit/config-schema';
import { allocateEntityId, workspaceIdForOwner } from '@openkit/protocol';
import { expect, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { importWorkspaceSkill, loadWorkspaceResourceCatalog } from '../catalog/resource-catalog.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
  loadRuntimeConfig,
} from '../config/runtime-config.js';
import type { PiAiGatewayClient } from '../llm/pi-ai-client.js';
import type { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import { classifyDirectTaskCheckpointAfterSchedulerRecovery } from '../mode-entry-routes.js';
import { ProviderRegistry } from '../providers/registry.js';
import { listSchedulerExecutionAttemptsForTurn } from '../runtime/execution-attempt-records.js';
import * as productOwners from '../runtime/product-turn-start.js';
import {
  getSchedulerPreparationClaims,
  runSchedulerDispatchLoop,
} from '../runtime/scheduler-dispatch-loop.js';
import { getWorkerCheckpoint } from '../runtime/worker-checkpoints.js';
import * as recoveryOwners from '../runtime/worker-recovery.js';
import { workerTurnTerminalPublication } from '../runtime/worker-turn-failure.js';
import * as loopOwners from '../runtime/worker-turn-loop.js';
import {
  listQueuedSchedulerAdmissionEntries,
  listSchedulerAdmissionEntriesForWorkspace,
} from '../scheduler-records.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { readWorkObservations } from '../storage/work-observations.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { createTestAgentSetup, createTestGatewayConfig } from './agent-environment.js';
import { createApp, createAppWithWorkspaceAuthority } from './app.js';
import { createDemoStore } from './demo-store.js';
import { ensureLocalUser } from './local-user.js';
import { createNativeTaskAdmissionFixture } from './native-task-admission.js';
import { operationRequest } from './operation-request.js';

export const STORAGE_REF = 'wst_00000000-0000-7ac8-9f6c-13552db6aa87';
export const SELECTED_CHOICE = {
  expectedRevision: 7,
  kind: 'selected' as const,
  purpose: 'work' as const,
  reuseWorkSlotRef: `wsl_${'2'.repeat(32)}`,
  storageRef: STORAGE_REF,
};

/**
 * Serializes one conversation.submit body for the focused Worker storage-choice tests.
 *
 * @param input Conversation target, request identity, and optional storage choice.
 * @returns JSON request body.
 */
export function conversationBody(input: {
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

/** Reads exact attempt evidence without reconstructing a deleted grant. */
export function observeExecutionAttempts(
  coreDb: ReturnType<typeof openCoreDb>
): Record<string, unknown>[] {
  const present = coreDb.sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduler_execution_attempts'"
    )
    .get();
  return present
    ? (coreDb.sqlite
        .prepare('SELECT * FROM scheduler_execution_attempts ORDER BY rowid')
        .all() as Record<string, unknown>[])
    : [];
}

/** Composes the real command, operation, loop, capture and ledger owners; only Provider transport is modeled. */
export async function assistantWiringFixture(
  selected = false,
  skillBytes: Buffer = Buffer.from('# Original retained entry guidance.\n'),
  memberCredential = false,
  supportBytes?: Buffer,
  memoryEnabled = false
) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'assistant-entry-wiring-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  });
  const actorUserId = memberCredential
    ? allocateEntityId('usr')
    : 'usr_00000000-0000-7000-8000-000000000001';
  if (memberCredential) {
    const timestamp = new Date().toISOString();
    coreDb.sqlite
      .prepare(
        "INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind, status) VALUES (?, 'Assistant member', 'assistant-member', 0, ?, ?, 'human', 'active')"
      )
      .run(actorUserId, Date.now(), Date.now());
    coreDb.sqlite
      .prepare(
        "INSERT INTO workspace_members (workspace_id, user_id, status, invitation_id, joined_at, removed_at, revision, created_at, updated_at) VALUES ('ws_00000000-0000-7000-8000-000000000001', ?, 'active', NULL, ?, NULL, 1, ?, ?)"
      )
      .run(actorUserId, timestamp, timestamp, timestamp);
  }
  const thread = await store.createThread(
    'ws_00000000-0000-7000-8000-000000000001',
    'Selected Skill command',
    undefined,
    'conversation',
    { visibility: 'private', privateOwnerUserId: actorUserId }
  );
  const imported = selected
    ? importWorkspaceSkill({
        dataRoot,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        id: 'alpha',
        displayName: 'Original selected metadata',
        expectedRevision: 0,
        activate: true,
        createdAt: '2026-10-15T00:00:00.000Z',
        producer: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        tree: [
          {
            kind: 'file',
            path: 'SKILL.md',
            contentBase64: Buffer.concat([
              Buffer.from('---\nname: alpha\ndescription: Fixture selected Skill.\n---\n'),
              skillBytes,
            ]).toString('base64'),
          },
          // Keep the entrypoint valid while testing arbitrary retained supporting files.
          ...(supportBytes
            ? [
                {
                  kind: 'file' as const,
                  path: 'read-target.bin',
                  contentBase64: supportBytes.toString('base64'),
                },
              ]
            : []),
        ],
      })
    : undefined;
  const catalogRevision = selected
    ? loadWorkspaceResourceCatalog(dataRoot, 'ws_00000000-0000-7000-8000-000000000001').revision
    : null;
  const createResponses = vi
    .fn<LLMGatewayProviderDispatcher['createResponses']>()
    .mockResolvedValue({
      id: 'entry-final-response',
      object: 'response',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'The direct answer.' }],
        },
      ],
      usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 },
    });
  const createChatCompletion = vi
    .fn<LLMGatewayProviderDispatcher['createChatCompletion']>()
    .mockResolvedValue({
      id: 'legacy-entry-response',
      object: 'chat.completion',
      created: 1,
      model: 'openai/gpt-5.2',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'The direct answer.' },
        },
      ],
    });
  const runtimeConfigManager = createRuntimeConfigManager({
    dataRoot,
    initialSnapshot: createInMemoryRuntimeConfigSnapshot({
      dataRoot,
      userConfigs: [
        {
          userId: actorUserId,
          path: join(dataRoot, 'users', actorUserId, 'config', 'user.jsonc'),
          config: UserConfigSchema.parse({
            schemaVersion: 1,
            knowledgeMaintenance: { enabled: memoryEnabled, reviewRequiredPageIds: [] },
          }),
        },
      ],
      gatewayConfig: createTestGatewayConfig(),
      providerRegistry: new ProviderRegistry([
        {
          id: 'agent-openrouter',
          displayName: 'Entry Provider',
          kind: 'local',
          defaultModel: 'openai/gpt-5.2',
          models: ['openai/gpt-5.2'],
          modelMetadata: {
            'openai/gpt-5.2': { tool_call: true, limit: { context: 64000, output: 8000 } },
          },
        },
      ]),
      workspaceConfigs: [
        {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          path: join(
            dataRoot,
            'workspaces/ws_00000000-0000-7000-8000-000000000001/config/workspace.jsonc'
          ),
          config: WorkspaceConfigSchema.parse({
            schemaVersion: 1,
            workspace: {
              name: 'Demo Workspace',
              ...(selected ? { assistant: { resources: { skillIds: ['alpha'] } } } : {}),
            },
          }),
        },
      ],
    }),
  });
  const token = memberCredential
    ? createOpenKitAccessTokenRecord(coreDb, {
        ownerUserId: actorUserId,
        scope: 'workspace',
        workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
        expiresAt: '2099-01-01T00:00:00.000Z',
      })
    : undefined;
  const app = createApp({
    mode: memberCredential ? 'server' : 'local',
    coreDb,
    dataRoot,
    store,
    runtimeConfigManager,
    llmGatewayDispatcher: {
      createResponses,
      createChatCompletion,
    } as unknown as LLMGatewayProviderDispatcher,
  });
  const requestId = '00000000-0000-4000-8000-000000001440';
  const submit = (id = requestId) =>
    app.request(
      ...operationRequest(
        'conversation.submit',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001', threadId: thread.id },
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token.secret}` } : {}),
          },
          body: conversationBody({
            input: 'Explain why the sky appears blue.',
            requestId: id,
            targetRef: 'internal-role:assistant',
          }),
        }
      )
    );
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
  return {
    app,
    actorUserId,
    dataRoot,
    coreDb,
    store,
    thread,
    workspaceDb,
    imported,
    catalogRevision,
    createResponses,
    createChatCompletion,
    requestId,
    submit,
    environments: () =>
      store
        .listThreadTurns('ws_00000000-0000-7000-8000-000000000001', thread.id)
        .flatMap((turn) =>
          readWorkObservations(workspaceDb, { threadId: thread.id, turnId: turn.id })
        )
        .filter((row) => row.type === 'env.bound'),
    dispatchCount: () => createResponses.mock.calls.length + createChatCompletion.mock.calls.length,
    close: async () => {
      await shutdownControlStoreWorkerClient();
      syncBuiltinESMExports();
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

/** Reads the complete model-visible result rather than matching text in earlier model arguments. */
export function skillModelObservations(
  input: Parameters<LLMGatewayProviderDispatcher['createResponses']>[1]
) {
  const request = input as unknown as { input: Array<{ type?: string; output?: unknown }> };
  return request.input
    .filter((item) => item.type === 'function_call_output')
    .map((item) => {
      expect(typeof item.output).toBe('string');
      return item.output as string;
    });
}

/** Proposes the exact ordinary Task payload, then completes the Assistant before human selection. */
export function taskProposalProvider(input: string, agentId: string) {
  let calls = 0;
  const createResponses = vi.fn(async () =>
    ++calls === 1
      ? {
          id: 'task-proposal',
          object: 'response',
          status: 'completed',
          output: [
            {
              type: 'function_call',
              name: 'task_start',
              call_id: 'propose-exact-task',
              arguments: JSON.stringify({ input, agentId }),
            },
          ],
        }
      : {
          id: 'task-confirmation',
          object: 'response',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'Select whether to start this exact work.' }],
            },
          ],
        }
  );
  return { createResponses, client: { createResponses } as unknown as PiAiGatewayClient };
}

/** Builds the public human answer from the canonical request's exact question identity. */
export function confirmTaskRequest(
  item: Extract<
    ReturnType<typeof SubmitConversationResponseSchema.parse>['item'],
    { type: 'user-input-request' }
  >,
  requestId: string
) {
  return operationRequest(
    'question.answer',
    { userInputRequestId: item.userInputRequestId },
    {
      body: JSON.stringify({
        requestId,
        workspaceId: workspaceIdForOwner(item.owner),
        threadId: item.threadId,
        answers: { [item.questions[0]!.id]: ['Confirm exact handoff'] },
      }),
    }
  );
}
/** Preserves each original closeout row in its own test-file context without changing its timed body. */
export const taskTerminalReplayCloseoutOwnership: (input: {
  readonly entry: 'direct' | 'assistant';
  readonly failCollection: true;
}) => Promise<void> = async ({ entry, failCollection }) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-task-closeout-owner-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot });
  const native = createNativeTaskAdmissionFixture(coreDb, store);
  const executor = native.executor;
  executor.failCloseout = entry === 'assistant' && failCollection;
  const setup = createTestAgentSetup({
    requiredCapabilities: ['trusted-worker-inference-relay'],
  });
  const brief = 'Implement a focused change and run its tests.';
  const provider = taskProposalProvider(brief, setup.manifest.id);
  const app = createAppWithWorkspaceAuthority({
    coreDb,
    dataRoot,
    store,
    turnExecutor: executor,
    fileAdmission: native.fileAdmission,
    workerControlGateway: native.workerControlGateway,
    agentManifests: [setup.manifest],
    openKitConfig: { defaults: { defaultAgentId: setup.manifest.id } },
    ...(entry === 'assistant' ? { llmPiAiClient: provider.client } : {}),
  });
  const requestId = '0190f4c8-0000-7000-8000-000000000602';
  const scope = {
    actorId: 'usr_00000000-0000-7000-8000-000000000001',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    threadId: 'th_00000000-0000-7000-8000-000000000001',
  };
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: scope.actorId,
    workspaceId: scope.workspaceId,
  });
  const command = entry === 'assistant' ? 'conversation.submit' : 'task.start';
  const submit = () =>
    Promise.resolve(
      app.request(
        ...operationRequest(
          command,
          { workspaceId: scope.workspaceId, threadId: scope.threadId },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              requestId,
              input: brief,
              ...(entry === 'assistant'
                ? { targetRef: 'internal-role:assistant', artifactRefs: [] }
                : {}),
            }),
          }
        )
      )
    );
  const workspaceDb = openWorkspaceDb(dataRoot, scope.workspaceId);
  const collecting = Promise.withResolvers<void>();
  void collecting.promise.catch(() => undefined);
  const release = Promise.withResolvers<void>();
  let workerTurnId: string | undefined;
  let collectionFault = entry === 'direct' && failCollection;
  const originalCollect = recoveryOwners.clearWorkerCheckpointAfterTerminalState;
  const collector = vi
    .spyOn(recoveryOwners, 'clearWorkerCheckpointAfterTerminalState')
    .mockImplementation(async (...args) => {
      if (collectionFault && args[1].turnId === workerTurnId) {
        expect(store.getCommandRequest(command, requestId, scope)).toMatchObject({
          command,
          requestId,
          response: { kind: 'turn', id: workerTurnId },
        });
        collecting.resolve();
        await release.promise;
        throw new Error('Controlled checkpoint collection failure.');
      }
      return originalCollect(...args);
    });
  const originalLoop = loopOwners.runWorkerTurnLoop;
  const loopCloseout =
    entry === 'assistant'
      ? vi.spyOn(loopOwners, 'runWorkerTurnLoop').mockImplementation(async (args) => {
          try {
            return await originalLoop(args);
          } catch (error) {
            if (
              executor.checkpointAtLaunch?.turnId !== args.reservedTurnId ||
              store.getTurnById(args.reservedTurnId).status !== 'completed'
            ) {
              collecting.reject(error);
              throw error;
            }
            collecting.resolve();
            await release.promise;
            throw error;
          }
        })
      : undefined;
  const admissions = vi.spyOn(productOwners, 'observeTurnAdmission');
  const publications = vi.spyOn(store, 'completeTurn');
  const pending = submit();
  let replay: Promise<Response> | undefined;
  let dispatch: ReturnType<typeof runSchedulerDispatchLoop> | undefined;
  try {
    const admitted = await pending;
    expect(admitted.status, await admitted.clone().text()).toBe(202);
    const admittedBody = await admitted.json();
    const receipt = structuredClone(store.getCommandRequest(command, requestId, scope)!);
    let answerRequest: ReturnType<typeof confirmTaskRequest> | undefined;
    let answerBody: unknown;
    if (entry === 'assistant') {
      const confirmation = SubmitConversationResponseSchema.parse(admittedBody);
      expect(confirmation.outcome).toBe('clarification-needed');
      expect(confirmation.item).toMatchObject({
        type: 'user-input-request',
        assistantHandoff: {
          kind: 'task',
          targetWorkspaceId: scope.workspaceId,
          input: brief,
          agentId: setup.manifest.id,
        },
      });
      expect(executor.launches).toBe(0);
      if (confirmation.item.type !== 'user-input-request')
        throw new Error('Expected exact Task confirmation.');
      answerRequest = confirmTaskRequest(confirmation.item, '0190f4c8-0000-7000-8000-000000000612');
      const answer = await app.request(...answerRequest);
      expect(answer.status, await answer.clone().text()).toBe(200);
      answerBody = await answer.json();
    }
    if (entry === 'direct') await executor.launched.promise;
    else
      await Promise.race([
        vi.waitFor(() =>
          expect(
            listSchedulerAdmissionEntriesForWorkspace(coreDb, {
              workspaceId: scope.workspaceId,
              statuses: ['queued', 'admitted'],
            })
          ).toHaveLength(1)
        ),
        collecting.promise,
      ]);
    const queued = listSchedulerAdmissionEntriesForWorkspace(coreDb, {
      workspaceId: scope.workspaceId,
      statuses: ['queued', 'admitted'],
    });
    expect(queued).toHaveLength(1);
    workerTurnId = queued[0]!.turnId;
    if (entry === 'assistant')
      await Promise.race([
        vi.waitFor(() =>
          expect(store.listThreadItems(scope.workspaceId, scope.threadId)).toContainEqual(
            expect.objectContaining({ causationId: workerTurnId, status: 'completed' })
          )
        ),
        collecting.promise,
      ]);
    await Promise.all(
      publications.mock.results
        .filter((result) => result.type === 'return')
        .map((result) => result.value)
    );
    if (entry === 'assistant') {
      // A handoff's initial dispatch can precede its required source publication.
      if (
        listQueuedSchedulerAdmissionEntries(coreDb).some(
          (entry) => entry.queueEntryId === queued[0]!.queueEntryId
        ) &&
        !getSchedulerPreparationClaims(coreDb).has(queued[0]!.queueEntryId)
      ) {
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
      await Promise.race([executor.launched.promise, collecting.promise]);
    }
    const workerScope = {
      ...scope,
      threadId: store.getTurnById(workerTurnId).threadId,
      turnId: workerTurnId,
    };
    const receipts = structuredClone(store.listCommandRequests());
    const threads = structuredClone(store.listThreads(scope.workspaceId));
    if (entry === 'assistant')
      expect(receipts).toContainEqual(expect.objectContaining({ command: 'user_input.answer' }));
    expect(JSON.parse(executor.inputs[0]!).objective).toBe(brief);
    if (entry === 'direct') expect(admittedBody.turn.id).toBe(workerTurnId);
    const owners = admissions.mock.results
      .filter((result) => result.type === 'return')
      .map((result) => result.value);
    if (!owners.length) throw new Error('Task admission has no observed closeout.');
    const closeout = Promise.all(owners.map((owner) => owner.closeout));
    void closeout.catch(() => undefined);
    const checkpoint = () =>
      getWorkerCheckpoint(workspaceDb, scope.workspaceId, workerScope.threadId, workerTurnId!);
    executor.completion.resolve();
    if (entry === 'direct') await executor.execution;
    else await expect(executor.execution).rejects.toThrow('Controlled release response loss.');
    await Promise.race([
      collecting.promise,
      closeout.then(() => {
        throw new Error('Task closeout completed before the held collection crossing.');
      }),
    ]);
    expect(store.getTurnById(workerTurnId).status).toBe('completed');
    const attempts = listSchedulerExecutionAttemptsForTurn(coreDb, workerScope);
    expect(attempts).toEqual([
      expect.objectContaining({
        phase: entry === 'assistant' ? 'closing' : 'closed',
        fenceRef: entry === 'assistant' ? null : expect.any(String),
      }),
    ]);
    const publication = await workerTurnTerminalPublication(workspaceDb, workerTurnId);
    expect(publication.evidence!.length).toBeGreaterThan(0);
    expect(executor.releaseResults).toContainEqual(
      expect.objectContaining({
        state: 'released',
        fenceRef: expect.any(String),
        attemptId: attempts[0]!.attemptId,
      })
    );
    const retained = checkpoint();
    expect(retained).toMatchObject({ stage: 'completed', stopReason: 'completed' });
    const terminalTurn = structuredClone(store.getTurnById(workerTurnId));
    expect(terminalTurn).toMatchObject({
      triggerActor: { kind: 'user', id: scope.actorId },
      agentId: setup.manifest.id,
    });
    if (entry === 'assistant')
      expect(store.getThread(scope.workspaceId, workerScope.threadId)).toMatchObject({
        parentThreadId: scope.threadId,
      });
    const terminalEvents = structuredClone(store.getTurnEvents(workerTurnId));
    expect(terminalEvents.filter((event) => event.event === 'turn.completed')).toHaveLength(1);
    replay = submit();
    if (entry === 'direct') release.resolve();
    const result = await replay;
    expect(result.status).toBe(entry === 'direct' ? 409 : 202);
    if (entry === 'direct') {
      await expect(result.json()).resolves.toMatchObject({ code: 'recovery_required' });
      await expect(closeout).rejects.toThrow('Controlled checkpoint collection failure.');
      collectionFault = false;
    } else {
      expect(await result.json()).toEqual(admittedBody);
      const answerDuringHold = await app.request(...answerRequest!);
      expect(answerDuringHold.status).toBe(200);
      expect(await answerDuringHold.json()).toEqual(answerBody);
      await expect(
        classifyDirectTaskCheckpointAfterSchedulerRecovery({
          coreDb,
          store,
          workspaceDb,
          checkpoint: retained!,
        })
      ).rejects.toMatchObject({ code: 'recovery_required' });
      release.resolve();
      await expect(closeout).rejects.toThrow('Controlled release response loss.');
    }
    expect(checkpoint()).toEqual(retained);
    const subsequent = await submit();
    expect(subsequent.status).toBe(202);
    if (entry === 'direct') {
      expect(StartTaskModeResponseSchema.parse(await subsequent.json())).toMatchObject({
        state: 'completed',
        turn: { id: workerTurnId },
        completion: {
          itemId: terminalTurn.items.find((item) => item.type === 'assistant-message')!.id,
        },
      });
      expect(checkpoint()).toBeNull();
    } else {
      expect(await subsequent.json()).toEqual(admittedBody);
      const answerReplay = await app.request(...answerRequest!);
      expect(answerReplay.status, await answerReplay.clone().text()).toBe(200);
      expect(await answerReplay.json()).toEqual(answerBody);
      expect(provider.createResponses).toHaveBeenCalledTimes(2);
      expect(store.listCommandRequests().filter((r) => r.command === 'task.start')).toHaveLength(0);
      expect(
        store.listCommandRequests().filter((r) => r.command === 'conversation.submit')
      ).toHaveLength(1);
      expect(checkpoint()).toEqual(retained);
    }
    expect(store.getCommandRequest(command, requestId, scope)).toEqual(receipt);
    expect(store.listCommandRequests()).toEqual(expect.arrayContaining(receipts));
    expect(store.listCommandRequests()).toHaveLength(receipts.length);
    expect(store.listThreads(scope.workspaceId)).toEqual(expect.arrayContaining(threads));
    expect(store.listThreads(scope.workspaceId)).toHaveLength(threads.length);
    expect(store.getTurnById(workerTurnId)).toEqual(terminalTurn);
    expect(store.getTurnEvents(workerTurnId)).toEqual(terminalEvents);
    expect(store.listThreadTurns(scope.workspaceId, workerScope.threadId)).toHaveLength(1);
    expect(listSchedulerExecutionAttemptsForTurn(coreDb, workerScope)).toEqual(attempts);
    expect(executor.launches).toBe(1);
  } finally {
    executor.completion.resolve();
    release.resolve();
    await pending.catch(() => undefined);
    if (executor.launches > 0) await executor.execution.catch(() => undefined);
    await dispatch?.catch(() => undefined);
    await Promise.allSettled(
      admissions.mock.results
        .filter((result) => result.type === 'return')
        .map((result) => result.value.closeout)
    );
    await replay?.catch(() => undefined);
    await Promise.allSettled(
      publications.mock.results
        .filter((result) => result.type === 'return')
        .map((result) => result.value)
    );
    publications.mockRestore();
    if (productOwners.observeTurnAdmission === admissions) admissions.mockRestore();
    if (loopCloseout && loopOwners.runWorkerTurnLoop === loopCloseout) loopCloseout.mockRestore();
    if (recoveryOwners.clearWorkerCheckpointAfterTerminalState === collector)
      collector.mockRestore();
    await native.restore();
    await shutdownControlStoreWorkerClient();
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
};

/** Runs the original independent Tasks admission and native closeout case. */
export const independentTasksAdmissionOwnership: () => Promise<void> = async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'route-b-two-tasks-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot, knowledge: [] });
  const setup = createTestAgentSetup({
    requiredCapabilities: ['trusted-worker-inference-relay'],
  });
  const config = createRuntimeConfigManager({
    dataRoot,
    initialSnapshot: createInMemoryRuntimeConfigSnapshot({
      ...loadRuntimeConfig(dataRoot),
      agentManifests: [setup.manifest],
      gatewayConfig: createTestGatewayConfig(),
      providerRegistry: new ProviderRegistry([
        {
          id: 'agent-openrouter',
          displayName: 'Fixture',
          kind: 'local',
          models: ['openai/gpt-5.2'],
        },
      ]),
      openKitConfig: {
        defaults: { defaultAgentId: setup.manifest.id },
        nanohost: { maxActiveTurnsPerSandbox: 1 },
      },
    } as unknown as Parameters<typeof createInMemoryRuntimeConfigSnapshot>[0]),
  });
  const native = createNativeTaskAdmissionFixture(coreDb, store, {
    readRuntimeConfig: () => config.current(),
  });
  const executor = native.executor;
  const backend = executor.executionBackend!;
  const submit = backend.submit.bind(backend);
  const ackEntered = Promise.withResolvers<void>();
  const ackRelease = Promise.withResolvers<void>();
  let firstSubmit: Parameters<typeof submit>[0] | undefined;
  // Hold only delivery of the real native ACK; Main still owns an unknown submit.
  const submitObservation = vi.spyOn(backend, 'submit').mockImplementation(async (input) => {
    if (firstSubmit) return submit(input);
    firstSubmit = input;
    const result = await submit(input);
    ackEntered.resolve();
    await ackRelease.promise;
    return result;
  });
  const admissions = vi.spyOn(productOwners, 'observeTurnAdmission');
  let secondExecution: ReturnType<typeof native.executionFor> | undefined;
  let dispatch: ReturnType<typeof runSchedulerDispatchLoop> | undefined;
  const attempts = (turn: { id: string; threadId: string }) =>
    listSchedulerExecutionAttemptsForTurn(coreDb, {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: turn.threadId,
      turnId: turn.id,
    });
  const app = createAppWithWorkspaceAuthority({
    coreDb,
    dataRoot,
    store,
    turnExecutor: executor,
    runtimeConfigManager: config,
    fileAdmission: native.fileAdmission,
    workerControlGateway: native.workerControlGateway,
  });
  recordWorkspaceOwnerMembership({
    coreDb,
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
  });
  await store.createThread(
    'ws_00000000-0000-7000-8000-000000000001',
    'Independent Task',
    'th_00000000-0000-7097-b0d8-3022e574cd4d'
  );
  const post = (requestId: string, threadId = 'th_00000000-0000-7000-8000-000000000001') =>
    app.request(
      ...operationRequest(
        'task.start',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001', threadId },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId,
            input: 'Implement a focused change and run its tests.',
          }),
        }
      )
    );
  try {
    const firstResponse = await post('0190f4c8-0000-7000-8000-000000000991');
    expect(firstResponse.status, await firstResponse.clone().text()).toBe(202);
    const first = await firstResponse.json();
    const firstCloseout = admissions.mock.results.find((r) => r.type === 'return')?.value.closeout;
    expect(firstCloseout).toBeDefined();
    await Promise.race([executor.launched.promise, firstCloseout!]);
    await Promise.race([ackEntered.promise, firstCloseout!]);
    expect(firstSubmit).toBeDefined();
    const secondResponse = await post(
      '0190f4c8-0000-7000-8000-000000000992',
      'th_00000000-0000-7097-b0d8-3022e574cd4d'
    );
    expect(secondResponse.status, await secondResponse.clone().text()).toBe(202);
    const second = await secondResponse.json();
    expect(second.turn.threadId).not.toBe(first.turn.threadId);
    expect(second.turn.id).not.toBe(first.turn.id);
    expect(second.turn).toMatchObject({ status: 'pending' });
    expect(listQueuedSchedulerAdmissionEntries(coreDb)).toEqual([
      expect.objectContaining({ turnId: second.turn.id, status: 'queued' }),
    ]);
    expect(attempts(second.turn)).toEqual([]);
    expect(attempts(first.turn)).toEqual([
      expect.objectContaining({
        phase: 'open',
        disposition: 'unknown',
        operationId: firstSubmit!.operationId,
        fenceRef: null,
      }),
    ]);
    const queuedDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    try {
      const checkpoint = getWorkerCheckpoint(
        queuedDb,
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7097-b0d8-3022e574cd4d',
        second.turn.id
      )!;
      await expect(
        classifyDirectTaskCheckpointAfterSchedulerRecovery({
          coreDb,
          store,
          workspaceDb: queuedDb,
          checkpoint: { ...checkpoint, requestInputHash: 'contradictory-hash' },
        })
      ).rejects.toMatchObject({ code: 'recovery_required' });
      for (let pass = 0; pass < 2; pass++) {
        await expect(
          classifyDirectTaskCheckpointAfterSchedulerRecovery({
            coreDb,
            store: await createDemoStore({ dataRoot }),
            workspaceDb: queuedDb,
            checkpoint,
          })
        ).resolves.toBe('live');
        expect(
          getWorkerCheckpoint(
            queuedDb,
            'ws_00000000-0000-7000-8000-000000000001',
            'th_00000000-0000-7097-b0d8-3022e574cd4d',
            second.turn.id
          )
        ).toEqual(checkpoint);
      }
    } finally {
      queuedDb.sqlite.close();
    }
    expect(second.state).toBe('queued');
    expect(second.turn.agentSessionId ?? null).toBeNull();
    expect(executor.launches).toBe(1);
    expect(listQueuedSchedulerAdmissionEntries(coreDb)).toEqual([
      expect.objectContaining({ turnId: second.turn.id, status: 'queued' }),
    ]);
    ackRelease.resolve();
    executor.completion.resolve();
    await native.executionFor(first.turn.id).execution;
    await firstCloseout;
    expect(attempts(first.turn)[0]).toMatchObject({
      phase: 'closed',
      disposition: 'accepted',
      fenceRef: expect.any(String),
    });
    expect(store.getTurnById(first.turn.id).status).toBe('completed');
    secondExecution = native.executionFor(second.turn.id);
    void secondExecution.execution.catch(() => undefined);
    dispatch = runSchedulerDispatchLoop({
      coreDb,
      store,
      turnExecutor: executor,
      agentManifests: [setup.manifest],
      providerRegistry: config.current().providerRegistry,
      gatewayConfig: config.current().gatewayConfig,
      executionBackend: backend,
      maxDispatches: 1,
    });
    void dispatch.catch(() => undefined);
    await Promise.race([secondExecution.launched.promise, dispatch]);
    expect(executor.launches).toBe(2);
    secondExecution.completion.resolve();
    await secondExecution.execution;
    await dispatch;
    await Promise.all([...getSchedulerPreparationClaims(coreDb).values()]);
    expect(
      attempts(second.turn).find((a) => a.inputRef === executor.nativeLineage?.packageSnapshotId)
    ).toMatchObject({
      phase: 'closed',
      disposition: 'accepted',
      fenceRef: expect.any(String),
    });
    expect(store.getTurnById(second.turn.id).status).toBe('completed');
    const replay = await post(
      '0190f4c8-0000-7000-8000-000000000992',
      'th_00000000-0000-7097-b0d8-3022e574cd4d'
    );
    expect(replay.status).toBe(202);
    expect((await replay.json()).turn.id).toBe(second.turn.id);
    expect(executor.launches).toBe(2);
    expect(attempts(second.turn).filter((a) => a.disposition === 'accepted')).toHaveLength(1);
  } finally {
    ackRelease.resolve();
    executor.completion.resolve();
    secondExecution?.completion.resolve();
    if (dispatch) await Promise.allSettled([dispatch]);
    await Promise.allSettled([...getSchedulerPreparationClaims(coreDb).values()]);
    await Promise.allSettled(
      admissions.mock.results.filter((r) => r.type === 'return').map((r) => r.value.closeout)
    );
    await Promise.allSettled(
      vi
        .mocked(executor.startTurn)
        .mock.results.filter((r) => r.type === 'return')
        .map((r) => r.value)
    );
    submitObservation.mockRestore();
    if (productOwners.observeTurnAdmission === admissions) admissions.mockRestore();
    await native.restore();
    await shutdownControlStoreWorkerClient();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
};

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import {
  createStructuredWorkerDelegationRequest,
  serializeStructuredWorkerDelegationRequest,
} from '../internal-agents/delegation.js';
import { PiAiGatewayClient } from '../llm/pi-ai-client.js';
import { createGoalDomainPolicyService } from '../policy/goal-domains.js';
import { createGoalTaskPolicyService } from '../policy/goal-task-policy.js';
import { EMPTY_POLICY_DOCUMENT, policyDigest } from '../policy/statements.js';
import { executeGoalOperation } from '../runtime/goal-owner.js';
import { createCoordinatorTaskTool } from '../runtime/task-admission.js';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import type { WorkspaceDb } from '../storage/db.js';
import {
  abortTitleOracleThreadUpdates,
  closeTitleOracleWorkspace,
  deleteTitleOracleThread,
  openTitleOracleWorkspace,
} from '../storage/p2-title-oracle-db.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { testGoalDomainProposal } from '../test-support/goal-domain.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import {
  awaitTerminalTitles,
  closeInstallations,
  type HeldTitle,
  isTitleRequest,
  openTitleInstallation,
  type TitleInstallation,
  titleCalls,
} from '../test-support/p2-oracle-fixture.js';
import { asPiAiGatewayClientDouble } from '../test-support/pi-ai-gateway-client-double.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';

const open: TitleInstallation[] = [];
const GENERATED = 'Generated title that must not stick';

afterEach(() => closeInstallations(open));

describe('local title lifecycle', () => {
  it('starts one title call for a fresh goal and none for its replay', async () => {
    const installation = await openAnswer('Fresh goal title');
    const requestId = randomUUID();
    const intent = 'Produce a reviewed design';
    const first = await createGoal(installation, intent, requestId);
    expect(first.status, await first.clone().text()).toBe(200);
    const view = (await first.json()) as { goal: { threadId: string } };
    await awaitTerminalTitles(installation);
    expect(await threadName(installation, view.goal.threadId)).toBe('Fresh goal title');
    const replay = await createGoal(installation, intent, requestId);
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(((await replay.json()) as { goal: { threadId: string } }).goal.threadId).toBe(
      view.goal.threadId
    );
    await flush();
    expect(titleCalls(installation)).toHaveLength(1);
    expect(titleHits(installation)).toHaveLength(1);
  });

  it('keeps a user rename ahead of the generated title', async () => {
    const installation = await openHeld();
    const intent = 'Rename before the title write';
    const { threadId, held } = await heldGoal(installation, intent);
    const renamed = await installation.app.request(
      ...operationRequest(
        'thread.update',
        { workspaceId: installation.workspaceId },
        {
          body: JSON.stringify({
            workspaceId: installation.workspaceId,
            threadId,
            requestId: randomUUID(),
            name: 'Kept by the user',
          }),
        }
      )
    );
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    held.release({ content: GENERATED });
    await awaitTerminalTitles(installation);
    expect(await threadName(installation, threadId)).toBe('Kept by the user');
  });

  it('keeps an archive ahead of the generated title', async () => {
    const installation = await openHeld();
    const intent = 'Archive before the title write';
    const { threadId, held } = await heldGoal(installation, intent);
    const archived = await installation.app.request(
      ...operationRequest(
        'thread.archive',
        { workspaceId: installation.workspaceId },
        {
          body: JSON.stringify({
            workspaceId: installation.workspaceId,
            threadId,
            requestId: randomUUID(),
          }),
        }
      )
    );
    expect(archived.status, await archived.clone().text()).toBe(200);
    held.release({ content: GENERATED });
    await awaitTerminalTitles(installation);
    const thread = await readThread(installation, threadId);
    expect(thread).toMatchObject({ name: intent, status: 'archived' });
  });

  it('does not write a generated title onto a thread deleted before the write', async () => {
    const installation = await openHeld();
    const { threadId, held } = await heldGoal(installation, 'Delete before the title write');
    deleteTitleOracleThread(installation.dataRoot, installation.workspaceId, threadId);
    held.release({ content: GENERATED });
    await awaitTerminalTitles(installation);
    const read = await installation.app.request(
      ...operationRequest('thread.read', {
        workspaceId: installation.workspaceId,
        threadId,
      })
    );
    expect(read.status).toBe(404);
    const names = installation.store
      .listThreads(installation.workspaceId)
      .map((thread) => thread.name);
    expect(names).not.toContain(GENERATED);
  });

  it('keeps the current title when the native thread update aborts', async () => {
    const installation = await openHeld();
    const intent = 'Conflict before the title write';
    const { threadId, held } = await heldGoal(installation, intent);
    const release = abortTitleOracleThreadUpdates(installation.dataRoot, installation.workspaceId);
    try {
      held.release({ content: GENERATED });
      await awaitTerminalTitles(installation);
      expect(await threadName(installation, threadId)).toBe(intent);
    } finally {
      release();
    }
  });

  it('re-reads once and applies the exact generated title after a real native revision refusal', async () => {
    const installation = await openHeld();
    const intent = 'Initial automatic title';
    const generated = 'Recovered schema title';
    const { threadId, held } = await heldGoal(installation, intent);
    const publications = holdTitlePublications(threadId, generated, 1);
    held.release({ content: generated });
    await publications.entered[0]!.promise;
    // An acknowledged competing metadata write advances the actual native revision, preserving the name.
    await installation.store.updateThread(installation.workspaceId, threadId, { name: intent });
    publications.release[0]!.resolve();
    await awaitTerminalTitles(installation);
    expect(publications.errors).toHaveLength(1);
    expect(publications.errors[0]).toBeInstanceOf(ControlStoreWorkerError);
    expect(publications.errors[0]).toMatchObject({ code: 'precondition', commit: 'not-committed' });
    expect(publications.attempts()).toBe(2);
    expect(await threadName(installation, threadId)).toBe(generated);
    expect(titleCalls(installation)).toHaveLength(1);
    expect(titleHits(installation)).toHaveLength(1);
  });

  it('keeps a user rename found by the re-read after a real native revision refusal', async () => {
    const installation = await openHeld();
    const { threadId, held } = await heldGoal(installation, 'Initial title before a rename');
    const publications = holdTitlePublications(threadId, GENERATED, 1);
    held.release({ content: GENERATED });
    await publications.entered[0]!.promise;
    await installation.store.updateThread(installation.workspaceId, threadId, {
      name: 'Kept by the user',
    });
    publications.release[0]!.resolve();
    await awaitTerminalTitles(installation);
    expect(publications.errors).toHaveLength(1);
    expect(publications.errors[0]).toMatchObject({ code: 'precondition', commit: 'not-committed' });
    expect(publications.attempts()).toBe(1);
    expect(await threadName(installation, threadId)).toBe('Kept by the user');
  });

  it('stops after a second native revision refusal and emits a bounded diagnostic', async () => {
    const installation = await openHeld();
    const intent = 'Initial title after two conflicts';
    const { threadId, held } = await heldGoal(installation, intent);
    const publications = holdTitlePublications(threadId, GENERATED, 2);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    onTestFinished(() => warn.mockRestore());
    held.release({ content: GENERATED });
    for (let attempt = 0; attempt < 2; attempt++) {
      await publications.entered[attempt]!.promise;
      await installation.store.updateThread(installation.workspaceId, threadId, { name: intent });
      publications.release[attempt]!.resolve();
    }
    await awaitTerminalTitles(installation);
    expect(publications.errors).toHaveLength(2);
    for (const error of publications.errors)
      expect(error).toMatchObject({ code: 'precondition', commit: 'not-committed' });
    expect(publications.attempts()).toBe(2);
    expect(await threadName(installation, threadId)).toBe(intent);
    const diagnostics = warn.mock.calls.filter(([line]) =>
      String(line).includes('thread.title.update-refused')
    );
    expect(diagnostics).toHaveLength(1);
    expect(String(diagnostics[0]![0]).length).toBeLessThan(256);
    expect(String(diagnostics[0]![0])).not.toContain(GENERATED);
    expect(titleCalls(installation)).toHaveLength(1);
  });

  it.each([
    ['busy', 'not-committed'],
    ['precondition', 'unknown'],
  ] as const)('does not retry a title write on %s/%s', async (code, commit) => {
    const installation = await openHeld();
    const intent = 'Initial title after non-revision failure';
    const { threadId, held } = await heldGoal(installation, intent);
    const write = vi
      .spyOn(installation.store, 'updateThread')
      .mockRejectedValueOnce(new ControlStoreWorkerError(code, commit));
    onTestFinished(() => write.mockRestore());
    held.release({ content: GENERATED });
    await awaitTerminalTitles(installation);
    expect(write).toHaveBeenCalledTimes(1);
    expect(await threadName(installation, threadId)).toBe(intent);
  });

  it('does not call when no title model is configured', async () => {
    const installation = await openTitleInstallation({
      titleLogicalModelId: null,
      decide: () => ({ kind: 'hold' }),
    });
    open.push(installation);
    const response = await createGoal(installation, 'No title model is configured');
    expect(response.status, await response.clone().text()).toBe(200);
    await flush();
    expect(titleCalls(installation)).toEqual([]);
    expect(titleHits(installation)).toEqual([]);
  });

  it('starts one title call for a new task worker and none for its replay', async () => {
    const installation = await openTitleInstallation({
      withDefaultAgent: true,
      decide: () => ({ kind: 'sse', answer: { content: 'Planned release notes' } }),
    });
    open.push(installation);
    const requestId = randomUUID();
    const before = threadIds(installation);
    const response = await submitTask(installation, requestId);
    expect([200, 202, 409], await response.clone().text()).toContain(response.status);
    await awaitTerminalTitles(installation);
    const created = installation.store
      .listThreads(installation.workspaceId)
      .filter((thread) => !before.has(thread.id));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      parentThreadId: installation.threadId,
      name: 'Planned release notes',
    });
    const replay = await submitTask(installation, requestId);
    expect(replay.status).toBe(response.status);
    await flush();
    expect(titleCalls(installation)).toHaveLength(1);
    expect(titleHits(installation)).toHaveLength(1);
    expect(
      installation.store
        .listThreads(installation.workspaceId)
        .filter((thread) => !before.has(thread.id))
    ).toHaveLength(1);
  }, 45_000);

  it('starts one title call when an assistant task handoff is confirmed', async () => {
    const installation = await openTitleInstallation({
      withDefaultAgent: true,
      wideAssistant: true,
      llmPiAiClient: taskProposalClient(),
      decide: () => ({ kind: 'hold' }),
    });
    open.push(installation);
    const titleWrite = vi.spyOn(installation.store, 'updateThread');
    onTestFinished(() => titleWrite.mockRestore());
    const timeline = await installation.store.createThread(
      installation.workspaceId,
      'Task proposal',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: FIXTURE_LOCAL_USER_ID }
    );
    const before = threadIds(installation);
    const submitted = await installation.app.request(
      ...operationRequest(
        'conversation.submit',
        { workspaceId: installation.workspaceId, threadId: timeline.id },
        {
          body: JSON.stringify({
            input: 'Help me decide the next step.',
            requestId: randomUUID(),
            targetRef: 'internal-role:assistant',
            artifactRefs: [],
          }),
        }
      )
    );
    expect(submitted.status, await submitted.clone().text()).toBe(202);
    const pending = installation.store
      .listThreadItems(installation.workspaceId, timeline.id)
      .find((item) => item.type === 'user-input-request');
    if (pending?.type !== 'user-input-request' || pending.assistantHandoff?.kind !== 'task') {
      throw new Error(`Expected a task handoff, received ${JSON.stringify(pending)}`);
    }
    const answer = installation.app.request(
      ...operationRequest(
        'question.answer',
        { userInputRequestId: pending.userInputRequestId },
        {
          body: JSON.stringify({
            workspaceId: installation.workspaceId,
            threadId: timeline.id,
            requestId: randomUUID(),
            answers: { [pending.questions[0]!.id]: ['Confirm exact handoff'] },
          }),
        }
      )
    );
    const held = await installation.peer.held;
    const confirmed = await answer;
    expect(confirmed.status, await confirmed.clone().text()).toBe(200);
    // Release the fast model only after the handoff's receiving-Thread publication has ACKed.
    held.release({ content: 'Schema repair' });
    await awaitTerminalTitles(installation);
    const created = installation.store
      .listThreads(installation.workspaceId)
      .filter((thread) => !before.has(thread.id));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ parentThreadId: timeline.id });
    expect(created[0]!.name).toBe('Schema repair');
    expect(titleCalls(installation)).toHaveLength(1);
    expect(titleHits(installation)).toHaveLength(1);
    const writes = titleWrite.mock.calls.flatMap((args, index) =>
      args[2].name === 'Schema repair' ? [{ args, result: titleWrite.mock.results[index]! }] : []
    );
    expect([1, 2]).toContain(writes.length);
    for (const write of writes) {
      expect(write.args).toEqual([
        installation.workspaceId,
        created[0]!.id,
        { name: 'Schema repair' },
        undefined,
        { status: 'active', name: 'Confirm the schema repair' },
      ]);
      expect(write.result.type).toBe('return');
      expect(write.result.value).toBeInstanceOf(Promise);
    }
    // The spy calls through and retains the owner's exact original Promises.
    // One guarded retry is admitted only after the actual first native CAS refusal.
    const outcomes = await Promise.allSettled(writes.map((write) => write.result.value));
    expect(outcomes.at(-1)).toMatchObject({
      status: 'fulfilled',
      value: { id: created[0]!.id, name: 'Schema repair' },
    });
    if (writes.length === 2) {
      expect(outcomes[0]!.status).toBe('rejected');
      if (outcomes[0]!.status !== 'rejected') throw new Error('Title retry has no native refusal.');
      const cause: unknown = outcomes[0]!.reason;
      expect(cause).toBeInstanceOf(ControlStoreWorkerError);
      expect(cause).toMatchObject({ code: 'precondition', commit: 'not-committed' });
      console.info('Handoff title retained exact native retry cause', {
        attempts: writes.length,
        code: (cause as ControlStoreWorkerError).code,
        commit: (cause as ControlStoreWorkerError).commit,
        finalWrite: outcomes.at(-1)!.status,
      });
    }
  }, 45_000);

  it('starts one title call for an admitted goal task', async () => {
    const installation = await openAnswer('Schema review');
    const admitted = await admitTask(installation);
    try {
      await admitted.taskTool.execute(admitted.input, {
        callId: 'task',
        toolOccurrence: 1,
        signal: new AbortController().signal,
      });
      await awaitTerminalTitles(installation, admitted.baseline + 1);
      expect(titleCalls(installation)).toHaveLength(admitted.baseline + 1);
      const taskThread = installation.store
        .listThreads(installation.workspaceId)
        .find((candidate) => candidate.parentThreadId === admitted.goalThreadId);
      expect(taskThread).toMatchObject({ name: 'Schema review' });
      expect(titleHits(installation)).toHaveLength(admitted.baselineHits + 1);
    } finally {
      for (const turn of installation.store.listThreadTurns(
        installation.workspaceId,
        admitted.goalThreadId
      )) {
        if (
          turn.agentId === 'goal-coordinator' &&
          (turn.status === 'running' || turn.status === 'pending')
        ) {
          await installation.store.updateTurn(turn.id, {
            status: 'completed',
            completedAt: new Date().toISOString(),
          });
        }
      }
      for (const connection of admitted.connections) closeTitleOracleWorkspace(connection);
    }
  }, 60_000);
});

async function openAnswer(content: string): Promise<TitleInstallation> {
  const installation = await openTitleInstallation({
    decide: () => ({ kind: 'sse', answer: { content } }),
  });
  open.push(installation);
  return installation;
}

async function openHeld(): Promise<TitleInstallation> {
  const installation = await openTitleInstallation({ decide: () => ({ kind: 'hold' }) });
  open.push(installation);
  return installation;
}

function createGoal(
  installation: TitleInstallation,
  intent: string,
  requestId = randomUUID()
): Promise<Response> {
  return installation.app.request(
    ...operationRequest(
      'goal.create',
      { workspaceId: installation.workspaceId },
      {
        body: JSON.stringify({
          workspaceId: installation.workspaceId,
          requestId,
          intent,
        }),
      }
    )
  );
}

async function heldGoal(
  installation: TitleInstallation,
  intent: string
): Promise<{ threadId: string; held: HeldTitle }> {
  const responsePromise = createGoal(installation, intent);
  const heldRequest = await installation.peer.held;
  const winner = await Promise.race([
    responsePromise.then((response) => ({ kind: 'create' as const, response })),
    heldRequest.aborted.then(() => ({ kind: 'aborted' as const })),
  ]);
  expect(winner.kind).toBe('create');
  if (winner.kind !== 'create') throw new Error('goal create waited for the title model');
  expect(winner.response.status, await winner.response.clone().text()).toBe(200);
  const view = (await winner.response.json()) as { goal: { threadId: string } | null };
  if (!view.goal) throw new Error('goal create returned no goal');
  return { threadId: view.goal.threadId, held: heldRequest };
}

async function readThread(
  installation: TitleInstallation,
  threadId: string
): Promise<{ name: string; status: string }> {
  const response = await installation.app.request(
    ...operationRequest('thread.read', { workspaceId: installation.workspaceId, threadId })
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as { name: string; status: string };
}

async function threadName(installation: TitleInstallation, threadId: string): Promise<string> {
  return (await readThread(installation, threadId)).name;
}

function submitTask(installation: TitleInstallation, requestId: string): Promise<Response> {
  return installation.app.request(
    ...operationRequest(
      'conversation.submit',
      { workspaceId: installation.workspaceId, threadId: installation.threadId },
      {
        body: JSON.stringify({
          input: 'Plan the release notes',
          requestId,
          targetRef: 'new-task-worker',
          artifactRefs: [],
          fileHandoffConfirmed: true,
        }),
      }
    )
  );
}

function threadIds(installation: TitleInstallation): Set<string> {
  return new Set(
    installation.store.listThreads(installation.workspaceId).map((thread) => thread.id)
  );
}

function titleHits(installation: TitleInstallation): unknown[] {
  return installation.peer.hits.filter((hit) => isTitleRequest(hit.body));
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Assistant proposal only. Title completions stay on the real dispatcher client. */
function taskProposalClient(): PiAiGatewayClient {
  const real = new PiAiGatewayClient();
  let proposed = false;
  return asPiAiGatewayClientDouble({
    createResponses: async (_provider: unknown, request: { tools?: Array<{ name?: string }> }) => {
      const wantsTask = request.tools?.some((tool) => tool.name === 'task_start');
      if (wantsTask && !proposed) {
        proposed = true;
        return {
          id: 'task-proposal',
          object: 'response',
          status: 'completed',
          output: [
            {
              type: 'function_call',
              name: 'task_start',
              call_id: 'propose-exact-work',
              arguments: JSON.stringify({
                input: 'Confirm the schema repair',
                agentId: 'agent_codex_host',
              }),
            },
          ],
        };
      }
      return {
        id: 'bounded-answer',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'A bounded answer.' }],
          },
        ],
      };
    },
    createChatCompletion: (...args: Parameters<PiAiGatewayClient['createChatCompletion']>) =>
      real.createChatCompletion(...args),
  });
}

async function admitTask(installation: TitleInstallation) {
  const actor = { kind: 'local' as const, userId: FIXTURE_LOCAL_USER_ID };
  const human = { actor };
  const db = openTitleOracleWorkspace(installation.dataRoot, installation.workspaceId, {
    migrate: true,
  });
  const connections: WorkspaceDb[] = [db];
  const domains = createGoalDomainPolicyService({
    coreDb: installation.coreDb,
    store: installation.store,
    repositoryWorkspaceDb: () => db,
    files: new RuntimeConfigFileService({
      dataRoot: installation.dataRoot,
      userId: actor.userId,
      workspaceIds: [installation.workspaceId],
      runtimeConfigManager: installation.manager,
      readRuntimeConfigStatus: () => installation.manager.status(),
    }),
    currentPolicy: () => installation.manager.current().openKitConfig.policy?.mediation,
    reload: () => installation.manager.reload({ mode: 'safe', dryRun: false }),
  });
  const services = {
    coreDb: installation.coreDb,
    goalDomain: {
      forActor: () => domains,
      currentRevision: () =>
        policyDigest(
          installation.manager.current().openKitConfig.policy?.mediation ?? EMPTY_POLICY_DOCUMENT
        ),
    },
  };
  const manifest = createTestAgentSetup().manifest;
  const selectedAgentId = manifest.id;
  const created = await executeGoalOperation(
    'goal.create',
    { workspaceId: installation.workspaceId, requestId: randomUUID(), intent: 'Review the schema' },
    human,
    installation.store,
    db,
    services
  );
  const goal = created.goal!;
  const scope = {
    workspaceId: installation.workspaceId,
    threadId: goal.threadId,
    goalId: goal.goalId,
  };
  const cards = await executeGoalOperation(
    'goal.card.create',
    { ...scope, requestId: randomUUID(), description: 'Review the schema', priority: 0 },
    human,
    installation.store,
    db,
    services
  );
  const card = cards.cards[0]!;
  const coordinator = await installation.store.createTurn(
    installation.workspaceId,
    goal.threadId,
    'Coordinate',
    { kind: 'user', id: actor.userId },
    undefined,
    { executorKind: 'coordinator', agentId: 'goal-coordinator' }
  );
  const proposal = await executeGoalOperation(
    'goal.plan.propose',
    {
      ...scope,
      requestId: randomUUID(),
      expectedRevision: cards.goal!.changeRevision,
      goalDomain: {
        ...testGoalDomainProposal(scope.workspaceId, scope.goalId),
        scope: {
          ...testGoalDomainProposal(scope.workspaceId, scope.goalId).scope,
          subjects: [{ kind: 'agent', id: selectedAgentId }],
        },
      },
      commitment: {
        intentBasis: { revision: 0, intent: goal.intent },
        cards: [
          {
            cardId: card.cardId,
            revision: card.revision,
            description: card.description,
            priority: card.priority,
          },
        ],
        permittedAdjustments: 'Refine review only',
        completionEvidence: ['A review'],
        boundaries: 'No deployment',
      },
    },
    { actor, coordinatorTurnId: coordinator.id },
    installation.store,
    db,
    services
  );
  const plan = proposal.versions[0]!;
  await executeGoalOperation(
    'goal.plan.approve',
    {
      ...scope,
      requestId: randomUUID(),
      pendingRequestId: plan.pendingRequestId,
      decision: 'granted',
    },
    human,
    installation.store,
    db,
    services
  );
  await executeGoalOperation(
    'goal.plan.approve',
    {
      ...scope,
      requestId: randomUUID(),
      pendingRequestId: plan.pendingRequestId,
      decision: 'granted',
    },
    { actor, coordinatorTurnId: coordinator.id },
    installation.store,
    db,
    services
  );
  const inflightCommands = new WeakMap();
  const { reporting: _coreReporting, ...request } = createStructuredWorkerDelegationRequest({
    objective: 'Review the schema',
    acceptanceCriteria: ['A review exists'],
    contextRefs: [{ kind: 'workspace', id: installation.workspaceId }],
    resources: [],
    expectedArtifacts: [],
    constraints: { maxContextTokens: 1000, maxWorkerIterations: 1 },
    verification: [{ kind: 'manual', description: 'Inspect the review' }],
    reviewPolicy: { required: false, reviewers: ['human'], instructions: 'Inspect the review' },
    escalationConditions: [],
    reviewContext: null,
  });
  await awaitTerminalTitles(installation, 1);
  const taskTool = createCoordinatorTaskTool({
    store: installation.store,
    coreDb: installation.coreDb,
    openWorkspace: (id) => {
      const connection = openTitleOracleWorkspace(installation.dataRoot, id);
      connections.push(connection);
      return connection;
    },
    inflightCommands,
    workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    goalId: goal.goalId,
    coordinatorTurnId: coordinator.id,
    startWorker: async (input) => {
      const turn = await input.store.createTurn(
        input.workspaceId,
        input.threadId,
        input.prompt,
        input.triggerActor,
        null,
        {
          turnId: input.reservedTurnId,
          executorKind: 'worker',
          agentId: input.requestedAgentId,
          ...(input.commandReceipt ? { commandReceipt: input.commandReceipt } : {}),
        }
      );
      await input.onTurnCreated(turn, null);
      return turn;
    },
    goalTaskPolicy: () =>
      createGoalTaskPolicyService({
        coreDb: installation.coreDb,
        store: installation.store,
        domains,
      }),
  });
  return {
    baseline: titleCalls(installation).length,
    baselineHits: titleHits(installation).length,
    connections,
    goalThreadId: goal.threadId,
    inflightCommands,
    prompt: serializeStructuredWorkerDelegationRequest(request),
    taskTool,
    input: {
      cardId: card.cardId,
      cardRevision: card.revision,
      intentRevision: 0,
      planVersionId: plan.planVersionId,
      withinCurrentIntent: true,
      withinPermittedAdjustments: true,
      rationale: 'Review stays inside the approved boundary',
      agentId: selectedAgentId,
      request,
    },
  };
}

/** Holds only the chosen title tuple after its revision was read, then passes it to the real native owner. */
function holdTitlePublications(threadId: string, title: string, count: number) {
  const client = getControlStoreWorkerClient();
  const products = client.products;
  const entered = Array.from({ length: count }, () => Promise.withResolvers<void>());
  const release = Array.from({ length: count }, () => Promise.withResolvers<void>());
  const errors: unknown[] = [];
  let attempts = 0;
  const spy = vi.spyOn(client, 'products').mockImplementation(async (database, transition) => {
    if (
      !transition.products.some(
        (product) =>
          product.kind === 'thread' &&
          product.record.id === threadId &&
          product.record.name === title
      )
    )
      return products.call(client, database, transition);
    const index = attempts++;
    entered[index]?.resolve();
    if (release[index]) await release[index].promise;
    try {
      return await products.call(client, database, transition);
    } catch (error) {
      errors.push(error);
      throw error;
    }
  });
  onTestFinished(() => {
    for (const gate of release) gate.resolve();
    spy.mockRestore();
  });
  return { entered, release, errors, attempts: () => attempts };
}

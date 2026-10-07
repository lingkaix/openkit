import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import { runInternalAgentLoop } from '../internal-agents/internal-agent-loop.js';
import { FsStore } from '../lib/store.js';
import { createOperationInvocation } from '../operation-composition.js';
import {
  cancelSchedulerAdmissionEntry,
  createSchedulerAdmissionEntry,
  requireSchedulerAdmissionEntry,
} from '../scheduler-records.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { createGoalTools } from './goal-coordinator.js';
import { executeGoalOperation, readGoalView } from './goal-owner.js';
import { reserveGoalTask } from './goal-task-admission.js';
import { updateWorkerCheckpoint, upsertWorkerCheckpoint } from './worker-checkpoints.js';

/** Composes the real Goal, Task evidence, operation admission and transient Coordinator loop. */
it.each([
  {
    authority: 'member',
    actorKind: 'session' as const,
    privateOwnerUserId: 'user_foreign',
    privateBody: 'FOREIGN_PRIVATE_ARTIFACT_CANARY',
  },
  {
    authority: 'private owner',
    actorKind: 'session' as const,
    privateOwnerUserId: 'user_local',
    privateBody: 'OWN_PRIVATE_ARTIFACT_CANARY',
  },
  {
    authority: 'administrator',
    actorKind: 'local' as const,
    privateOwnerUserId: 'user_foreign',
    privateBody: 'ADMIN_FOREIGN_PRIVATE_ARTIFACT_CANARY',
  },
])('inspects linked Task evidence before completion without disclosing a private Artifact as $authority', async ({
  actorKind,
  privateOwnerUserId,
  privateBody,
}) => {
  const root = mkdtempSync(join(tmpdir(), 'goal-inspection-'));
  const coreDb = openCoreDb(root);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot: root });
  const workspace = store.createWorkspace('Evidence inspection');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: 'user_local' });
  const db = openWorkspaceDb(root, workspace.id);
  applyScopedMigrations(db);
  const actor = { kind: actorKind, userId: 'user_local' };
  const human = { actor };
  const services = { coreDb };
  const invoke = createOperationInvocation({
    coreDb,
    store,
    goalServices: services,
    inflightCommands: new WeakMap(),
    workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    repositoryWorkspaceDb: (id) => openWorkspaceDb(root, id),
  });
  try {
    const created = await executeGoalOperation(
      'goal.create',
      {
        workspaceId: workspace.id,
        requestId: randomUUID(),
        intent: 'Produce a note',
      },
      human,
      store,
      db,
      services
    );
    const goal = created.goal!;
    const scope = { workspaceId: workspace.id, threadId: goal.threadId, goalId: goal.goalId };
    const coordinator = store.createTurn(
      workspace.id,
      goal.threadId,
      'Inspect evidence',
      { kind: 'user', id: actor.userId },
      undefined,
      { executorKind: 'coordinator', agentId: 'goal-coordinator' }
    );
    const context = { actor, coordinatorTurnId: coordinator.id };
    const cards = await executeGoalOperation(
      'goal.card.create',
      {
        ...scope,
        requestId: randomUUID(),
        description: 'Write the note',
        priority: 1,
      },
      human,
      store,
      db,
      services
    );
    const card = cards.cards[0]!;
    const proposal = await executeGoalOperation(
      'goal.plan.propose',
      {
        ...scope,
        requestId: randomUUID(),
        expectedRevision: cards.goal!.changeRevision,
        commitment: {
          intentBasis: { revision: goal.intentRevision, intent: goal.intent },
          cards: [
            {
              cardId: card.cardId,
              revision: card.revision,
              description: card.description,
              priority: card.priority,
            },
          ],
          permittedAdjustments: 'Retry a bounded note Task',
          completionEvidence: ['Read the note and reply'],
          boundaries: 'Internal note only',
        },
      },
      context,
      store,
      db,
      services
    );
    const plan = proposal.versions[0]!;
    const approval = {
      ...scope,
      requestId: randomUUID(),
      pendingRequestId: plan.pendingRequestId,
      decision: 'granted' as const,
    };
    await executeGoalOperation('goal.plan.approve', approval, human, store, db, services);
    await executeGoalOperation(
      'goal.plan.approve',
      { ...approval, requestId: randomUUID() },
      context,
      store,
      db,
      services
    );

    const completed = store.createThread(workspace.id, 'Completed note', `th_task_${randomUUID()}`);
    const refused = store.createThread(
      workspace.id,
      'Cancelled attempt',
      `th_task_${randomUUID()}`
    );
    for (const thread of [completed, refused]) {
      db.sqlite.transaction(() =>
        reserveGoalTask(
          store,
          db,
          {
            goalId: goal.goalId,
            cardId: card.cardId,
            planVersionId: plan.planVersionId,
            cardRevision: card.revision,
            intentRevision: goal.intentRevision,
            withinCurrentIntent: true,
            withinPermittedAdjustments: true,
            rationale: 'Bounded note',
          },
          thread.id
        )
      )();
    }
    const taskTurn = store.createTurn(workspace.id, completed.id, 'Write note', {
      kind: 'user',
      id: actor.userId,
    });
    const body = 'Verified note: the issue is closed.';
    const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
    const artifact = store.createArtifact({
      id: `ar_${randomUUID()}`,
      workspaceId: workspace.id,
      threadId: completed.id,
      turnId: taskTurn.id,
      kind: 'file',
      title: 'Note',
      status: 'ready',
      summary: null,
      version: 1,
      content: { format: 'markdown', body },
      contentDigest: digest,
      lastMutationRequestId: 'note-publication',
      origin: {
        kind: 'turn-output',
        threadId: completed.id,
        turnId: taskTurn.id,
        requestId: 'note-publication',
      },
      createdAt: taskTurn.startedAt!,
      updatedAt: taskTurn.startedAt!,
    });
    const reply = store.createItem({
      id: 'it_note_reply',
      workspaceId: workspace.id,
      threadId: completed.id,
      turnId: taskTurn.id,
      type: 'assistant-message',
      text: 'Published the verified note.',
      status: 'completed',
      createdAt: taskTurn.startedAt!,
      completedAt: taskTurn.startedAt!,
    });

    const refusal = 'Admission cancelled before a Task Turn; no queue remains.';
    const reservedTurnId = 'tu_cancelled_note';
    createSchedulerAdmissionEntry(coreDb, {
      backendId: 'nanohost',
      queueEntryId: 'queue_cancelled_note',
      workspaceId: workspace.id,
      threadId: refused.id,
      turnId: reservedTurnId,
      requestId: randomUUID(),
      triggerActor: { kind: 'user', id: actor.userId },
      turnInput: 'Write note',
      requestedAgentId: 'codex',
    });
    cancelSchedulerAdmissionEntry(coreDb, {
      queueEntryId: 'queue_cancelled_note',
      workspaceId: workspace.id,
    });
    upsertWorkerCheckpoint(db, {
      workspaceId: workspace.id,
      threadId: refused.id,
      turnId: reservedTurnId,
      goalId: goal.goalId,
      requestId: randomUUID(),
      requestInputHash: 'note-input',
      stage: 'preparing',
      iteration: 0,
    });
    updateWorkerCheckpoint(db, {
      authorityActor: { kind: 'user', id: actor.userId },
      workspaceId: workspace.id,
      threadId: refused.id,
      turnId: reservedTurnId,
      stage: 'failed',
      stopReason: 'failed',
      diagnosticsSummary: refusal,
    });
    const unrelated = store.createThread(
      workspace.id,
      'Unrelated visible Task',
      `th_task_${randomUUID()}`
    );
    const unrelatedTurn = store.createTurn(workspace.id, unrelated.id, 'Unlinked note', {
      kind: 'user',
      id: actor.userId,
    });
    const unrelatedArtifact = store.createArtifact({
      ...artifact,
      id: `ar_${randomUUID()}`,
      threadId: unrelated.id,
      turnId: unrelatedTurn.id,
      origin: {
        kind: 'turn-output',
        threadId: unrelated.id,
        turnId: unrelatedTurn.id,
        requestId: 'unlinked-note',
      },
      lastMutationRequestId: 'unlinked-note',
    });
    expect(
      (
        await invoke(
          'artifact.read',
          { workspaceId: workspace.id, artifactId: unrelatedArtifact.id },
          { kind: 'public', actor, delivery: 'model' }
        )
      ).id
    ).toBe(unrelatedArtifact.id);
    const privateThread = store.createThread(
      workspace.id,
      'Private origin',
      `th_private_${randomUUID()}`,
      'conversation',
      { visibility: 'private', privateOwnerUserId }
    );
    const privateTurn = store.createTurn(workspace.id, privateThread.id, 'Private', {
      kind: 'user',
      id: privateOwnerUserId,
    });
    const privateArtifact = store.createArtifact({
      ...artifact,
      id: `ar_${randomUUID()}`,
      content: { format: 'markdown', body: privateBody },
      contentDigest: `sha256:${createHash('sha256').update(privateBody).digest('hex')}`,
      threadId: privateThread.id,
      turnId: privateTurn.id,
      origin: {
        kind: 'turn-output',
        threadId: privateThread.id,
        turnId: privateTurn.id,
        requestId: 'private-note',
      },
      lastMutationRequestId: 'private-note',
    });
    if (privateOwnerUserId === actor.userId || actorKind === 'local') {
      // Personal read authority, including administrator eligibility, does not authorize shared disclosure.
      expect(
        (
          await invoke(
            'artifact.read',
            { workspaceId: workspace.id, artifactId: privateArtifact.id },
            { kind: 'public', actor, delivery: 'model' }
          )
        ).content.body
      ).toBe(privateBody);
    }
    expect(readGoalView(store, db, goal.goalId).tasks.map((task) => task.threadId)).not.toContain(
      privateThread.id
    );
    // A reference in a linked shared Thread cannot launder a private Artifact's origin audience.
    store.createItem({
      id: 'it_private_reference',
      workspaceId: workspace.id,
      threadId: completed.id,
      turnId: taskTurn.id,
      type: 'artifact-reference',
      artifactId: privateArtifact.id,
      artifactVersion: 1,
      status: 'completed',
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      lastMutationRequestId: 'private-reference',
      title: 'Private note reference',
      summary: 'Origin still private',
    });
    store.updateTurn(taskTurn.id, { status: 'completed', completedAt: new Date().toISOString() });
    upsertWorkerCheckpoint(db, {
      workspaceId: workspace.id,
      threadId: privateThread.id,
      turnId: privateTurn.id,
      requestId: randomUUID(),
      requestInputHash: 'private-input',
      stage: 'preparing',
      iteration: 0,
    });
    updateWorkerCheckpoint(db, {
      authorityActor: { kind: 'user', id: privateOwnerUserId },
      workspaceId: workspace.id,
      threadId: privateThread.id,
      turnId: privateTurn.id,
      stage: 'failed',
      diagnosticsSummary: 'PRIVATE_CANARY',
    });
    const tools = createGoalTools({
      store,
      db,
      actor,
      goalId: goal.goalId,
      turnId: coordinator.id,
      services,
      invoke,
    });
    const call = (callId: string, name: string, args: Record<string, unknown>) => ({
      type: 'toolCall' as const,
      callId,
      name,
      arguments: args,
    });
    let round = 0;
    const provider = vi.fn(
      async (request: Parameters<Parameters<typeof runInternalAgentLoop>[1]>[0]) => {
        const result = (id: string) => {
          const message = request.messages.find(
            (message) => message.role === 'tool' && message.callId === id
          );
          expect(message, `Coordinator must receive ${id}`).toBeDefined();
          return message as Extract<typeof message, { role: 'tool' }>;
        };
        const output = (id: string) => {
          const message = result(id);
          expect(message.isError, JSON.stringify(message.content)).toBe(false);
          return JSON.parse((message.content[0] as { text: string }).text);
        };
        if (round++ === 0)
          return {
            message: {
              role: 'assistant' as const,
              truncated: false,
              content: [
                call('items', 'thread_items', { threadId: completed.id }),
                call('terminal', 'turn_read', { threadId: completed.id, turnId: taskTurn.id }),
                call('refusal', 'evidence_runtime_list', {}),
                call('unrelated', 'thread_items', { threadId: unrelated.id }),
                call('unlinked-artifact', 'artifact_read', { artifactId: unrelatedArtifact.id }),
                call('private', 'artifact_read', { artifactId: privateArtifact.id }),
              ],
            },
          };
        if (round === 2) {
          expect(output('items').items).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ id: reply.id, text: reply.text }),
              expect.objectContaining({ type: 'artifact-reference', artifactId: artifact.id }),
            ])
          );
          expect(output('terminal')).toMatchObject({ status: 'completed', error: null });
          expect(output('refusal').runtimeEvidence).toEqual([
            expect.objectContaining({
              threadId: refused.id,
              turnId: reservedTurnId,
              outcome: 'failed',
              redactedStderrSummary: refusal,
            }),
          ]);
          for (const id of ['unrelated', 'unlinked-artifact', 'private'])
            expect(result(id).isError).toBe(true);
          expect(JSON.stringify(result('private'))).not.toContain(privateBody);
          expect(JSON.stringify(request.messages)).not.toContain(privateBody);
          expect(JSON.stringify(request.messages)).not.toContain('PRIVATE_CANARY');
          return {
            message: {
              role: 'assistant' as const,
              truncated: false,
              content: [call('note', 'artifact_read', { artifactId: artifact.id })],
            },
          };
        }
        if (round === 3) {
          expect(output('note')).toMatchObject({
            id: artifact.id,
            content: { body },
            contentDigest: digest,
          });
          expect(
            readGoalView(store, db, goal.goalId).requests.filter(
              (request) => request.operation === 'goal.completion.accept'
            )
          ).toEqual([]);
          return {
            message: {
              role: 'assistant' as const,
              truncated: false,
              content: [
                call('completion', 'goal_completion_accept', {
                  candidate: {
                    intentRevision: goal.intentRevision,
                    intent: goal.intent,
                    planVersionId: plan.planVersionId,
                    evidence: [{ kind: 'artifact', id: artifact.id, digest }],
                    unresolvedWork: [],
                    summary: 'Read the note and reply; cancelled attempt admitted no work.',
                  },
                }),
              ],
            },
          };
        }
        output('completion');
        return {
          message: {
            role: 'assistant' as const,
            truncated: false,
            content: [{ type: 'text' as const, text: 'Awaiting human completion acceptance.' }],
          },
        };
      }
    );
    const exit = await runInternalAgentLoop(
      {
        systemPrompt: 'Inspect linked evidence before requesting completion.',
        messages: [{ role: 'user', content: [{ type: 'text', text: goal.intent }] }],
        tools,
        model: {
          logicalModelId: 'coordinator',
          capabilities: ['responses', 'tool-calling'],
          modelFamilyId: 'gpt-5',
        },
        contextManagement: { type: 'compaction', compactThreshold: 64000, authority: 'openkit' },
        limits: { maxModelTurns: 4, maxToolCalls: 10, deadlineMs: 10000 },
        signal: new AbortController().signal,
      },
      provider
    );
    expect(exit.kind, JSON.stringify(exit)).toBe('quiescent');
    expect(provider).toHaveBeenCalledTimes(4);
    const current = readGoalView(store, db, goal.goalId);
    expect(current.goal!.disposition).toBeNull();
    expect(
      current.requests.find((request) => request.operation === 'goal.completion.accept')
    ).toMatchObject({ state: 'pending' });
    expect(store.listThreadTurns(workspace.id, refused.id)).toEqual([]);
    expect(requireSchedulerAdmissionEntry(coreDb, 'queue_cancelled_note').status).toBe('cancelled');
    const tool = (name: string) => tools.find((tool) => tool.name === name)!;
    const read = async (name: string, args: Record<string, unknown>) => {
      const result = await tool(name).execute(args);
      return { ...result, output: JSON.parse((result.content[0] as { text: string }).text) };
    };
    const failedTurn = store.createTurn(workspace.id, completed.id, 'Later failed attempt', {
      kind: 'user',
      id: actor.userId,
    });
    store.updateTurn(failedTurn.id, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: {
        code: 'worker_governance_turn_failed',
        message: 'The worker could not complete the Git fetch transport.',
      },
    });
    expect(
      (await read('turn_read', { threadId: completed.id, turnId: failedTurn.id })).output
    ).toMatchObject({
      status: 'failed',
      error: {
        code: 'worker_governance_turn_failed',
        message: 'The worker could not complete the Git fetch transport.',
      },
    });
    expect(
      (await read('turn_read', { threadId: completed.id, turnId: privateTurn.id })).isError
    ).toBe(true);
    expect((await read('thread_items', { threadId: privateThread.id })).isError).toBe(true);
    for (const [name, args] of [
      ['thread_items', { threadId: completed.id, workspaceId: 'ws_foreign' }],
      [
        'artifact_read',
        { artifactId: artifact.id, actor: { kind: 'local', userId: 'user_foreign' } },
      ],
    ] as const)
      expect((await read(name, args)).output).toMatchObject({ code: 'invalid_request' });
    // Presence of the fixed Tools cannot cache authority after the responsible user is disabled.
    coreDb.sqlite.transaction(() => disableCanonicalUser(coreDb, actor.userId))();
    for (const [name, args] of [
      ['thread_items', { threadId: completed.id }],
      ['artifact_read', { artifactId: artifact.id }],
      ['turn_read', { threadId: completed.id, turnId: taskTurn.id }],
      ['evidence_runtime_list', {}],
    ] as const)
      expect((await read(name, args)).output).toMatchObject({ code: 'workspace_access_denied' });
  } finally {
    db.sqlite.close();
    coreDb.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
});

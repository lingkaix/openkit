import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';
import type { InternalAgentProviderCall } from '../internal-agents/internal-agent-loop.js';
import { recordWorkerTurnLaunchDecision } from '../policy/permission-decisions.js';
import { openCoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { LOCAL_USER_ID } from '../storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createApp } from '../test-support/app.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { reviseGoalIntent } from './goal-intent.js';
import { createDeterministicGoalPlanFallback, type GoalPlanOutput } from './goal-plan.js';
import { approveGoalPlan, reviseGoalPlan } from './goal-plan-approval.js';
import { runGoalPlanProposal } from './goal-plan-propose-tool.js';
import { createGoalPlan, type GoalPlannerInput, readGoalPlanCreation } from './goal-planning.js';
import { captureGoalTaskEvidenceSnapshot } from './goal-source-evidence.js';
import {
  createGoalRecord,
  getGoalPlanRecord,
  getGoalRecord,
  listDispatchableGoalTasks,
  listGoalTasks,
  updateGoalStatus,
  updateGoalTask,
} from './goal-store.js';
import { commandInputHash } from './idempotent-command.js';
import {
  createWorkerCheckpointEvidenceDiagnostics,
  getWorkerCheckpoint,
  upsertWorkerCheckpoint,
} from './worker-checkpoints.js';
import { clearWorkerCheckpointAfterTerminalState } from './worker-recovery.js';

const USER_ACTOR = { kind: 'user', id: LOCAL_USER_ID } as const;
const WORKSPACE_ID = 'ws_demo';
const GOAL_ID = 'goal_continuous_plan';
const REVISION = 'Add an independent release verification task.';

function createPlanningFixture(threadTitle: string): {
  store: ReturnType<typeof createDemoStore>;
  workspaceDb: WorkspaceDb;
  threadId: string;
  dataRoot: string;
} {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-goal-continuous-'));
  const store = createDemoStore({ dataRoot });
  const workspaceDb = openWorkspaceDb(dataRoot, WORKSPACE_ID);
  applyScopedMigrations(workspaceDb);
  const thread = store.createThread(WORKSPACE_ID, threadTitle);
  const objective = 'Prepare the release for publication.';
  const objectiveTurn = store.createTurn(WORKSPACE_ID, thread.id, objective, USER_ACTOR);
  const timestamp = objectiveTurn.startedAt ?? new Date().toISOString();
  const objectiveItem = store.createItem({
    id: `it_objective_${thread.id}`,
    workspaceId: WORKSPACE_ID,
    threadId: thread.id,
    turnId: objectiveTurn.id,
    type: 'user-message',
    status: 'completed',
    actor: USER_ACTOR,
    causationId: `req_objective_${thread.id}`,
    text: objective,
    createdAt: timestamp,
    completedAt: timestamp,
  });
  store.updateTurn(objectiveTurn.id, {
    status: 'completed',
    completedAt: timestamp,
    durationMs: 0,
  });
  createGoalRecord(workspaceDb, {
    workspaceExists: (workspaceId) => workspaceId === WORKSPACE_ID,
    workspaceId: WORKSPACE_ID,
    threadId: thread.id,
    goalId: GOAL_ID,
    title: 'Prepare release',
    objective,
    createdByItemId: objectiveItem.id,
  });
  return { store, workspaceDb, threadId: thread.id, dataRoot };
}

async function createApprovedGoalForSourceChange(threadTitle: string) {
  const fixture = createPlanningFixture(threadTitle);
  const { store, workspaceDb, threadId } = fixture;
  const initial = await createGoalPlan({
    triggerActor: USER_ACTOR,
    workspaceDb,
    store,
    workspaceId: WORKSPACE_ID,
    threadId,
    goalId: GOAL_ID,
    requestId: `req_initial_${threadTitle}`,
    planner: () =>
      createDeterministicGoalPlanFallback({
        goalTitle: 'Prepare release',
        objective: 'Prepare the release for publication.',
      }),
  });
  if (initial.status !== 'awaiting_plan_approval') {
    throw new Error('Expected an approvable initial Goal Plan.');
  }
  approveGoalPlan({
    workspaceDb,
    store,
    workspaceId: WORKSPACE_ID,
    threadId,
    goalId: GOAL_ID,
    planItemId: initial.planItem.id,
  });
  reviseGoalIntent({
    triggerActor: USER_ACTOR,
    workspaceDb,
    store,
    workspaceId: WORKSPACE_ID,
    threadId,
    goalId: GOAL_ID,
    requestId: `req_intent_${threadTitle}`,
    objective: 'Prepare release with separate verification.',
    revision: 'Add a separate verification pass.',
    affectedTaskIds: [],
  });
  return { ...fixture, activePlanItemId: initial.planItem.id, activePlan: initial.plan };
}

describe('continuous Goal planning', () => {
  it('sends frozen Task evidence and answered clarification in the Orchestrator user message', async () => {
    const { store, workspaceDb, threadId, activePlanItemId, activePlan } =
      await createApprovedGoalForSourceChange('Model context');

    try {
      const sourceTaskEvidence = captureGoalTaskEvidenceSnapshot(store, workspaceDb, {
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        planItemId: activePlanItemId,
      });
      const clarification = {
        requestItemId: 'it_question_recorded',
        responseItemId: 'it_answer_recorded',
        questions: [{ id: 'window', question: 'Which window?' }],
        answers: { window: ['Friday'] },
      };
      const callProvider = vi.fn<InternalAgentProviderCall>().mockResolvedValue({
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'No Plan proposed.' }],
          truncated: false,
        },
      });
      await expect(
        runGoalPlanProposal({
          goal: getGoalRecord(workspaceDb, WORKSPACE_ID, threadId, GOAL_ID)!,
          sourceTaskEvidence,
          clarification,
          previousPlan: activePlan,
          previousPlanItemId: activePlanItemId,
          revisionText: 'Add a separate verification pass.',
          model: {
            logicalModelId: 'openai/gpt-5.2',
            capabilities: ['responses', 'tool-calling'],
            modelFamilyId: 'gpt',
          },
          contextManagement: {
            type: 'compaction',
            compactThreshold: 8_000,
            authority: 'openkit',
          },
          limits: { maxModelTurns: 1, maxToolCalls: 1, deadlineMs: 5_000 },
          callProvider,
          signal: new AbortController().signal,
        })
      ).rejects.toMatchObject({ code: 'goal_plan_revision_invalid' });
      expect(callProvider).toHaveBeenCalledTimes(1);
      const userMessage = callProvider.mock.calls[0]?.[0].messages[0];
      expect(userMessage?.role).toBe('user');
      const userText =
        userMessage?.role === 'user' && userMessage.content[0]?.type === 'text'
          ? userMessage.content[0].text
          : '';
      expect(JSON.parse(userText)).toMatchObject({
        previousPlanItemId: activePlanItemId,
        sourceTaskEvidence: {
          facts: [{ taskId: 'task_1', status: 'ready', reviews: [] }],
          digest: sourceTaskEvidence.digest,
        },
        clarification,
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rejects a successor approved against Task facts changed during the model call', async () => {
    const { store, workspaceDb, threadId, activePlanItemId, activePlan } =
      await createApprovedGoalForSourceChange('Deferred successor');
    const entered = Promise.withResolvers<void>();
    const modelResult = Promise.withResolvers<GoalPlanOutput>();

    try {
      const pending = createGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        requestId: 'req_deferred_successor',
        planner: () => {
          entered.resolve();
          return modelResult.promise;
        },
      });
      await entered.promise;
      updateGoalTask(workspaceDb, {
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        taskId: 'task_1',
        status: 'running',
      });
      modelResult.resolve({
        ...activePlan,
        goalSummary: 'Prepare release with separate verification.',
        tasks: [
          {
            ...activePlan.tasks[0]!,
            taskId: 'task_2',
            title: 'Verify changed source',
          },
        ],
        taskDispositions: [
          {
            taskId: 'task_1',
            successorTaskId: 'task_2',
            reason: 'Carry the remaining verification into the successor.',
          },
        ],
      });
      const candidate = await pending;
      expect(candidate.status).toBe('awaiting_plan_approval');
      if (candidate.status !== 'awaiting_plan_approval') return;
      expect(() =>
        approveGoalPlan({
          workspaceDb,
          store,
          workspaceId: WORKSPACE_ID,
          threadId,
          goalId: GOAL_ID,
          planItemId: candidate.planItem.id,
        })
      ).toThrowError(expect.objectContaining({ code: 'stale' }));
      expect(getGoalRecord(workspaceDb, WORKSPACE_ID, threadId, GOAL_ID)).toMatchObject({
        status: 'running',
        planItemId: activePlanItemId,
        pendingPlanItemId: candidate.planItem.id,
      });
      expect(
        listGoalTasks(workspaceDb, { workspaceId: WORKSPACE_ID, threadId, goalId: GOAL_ID })
      ).toEqual([
        expect.objectContaining({
          taskId: 'task_1',
          status: 'running',
          planItemId: activePlanItemId,
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('does not publish a planning question from Task facts changed during the model call', async () => {
    const { store, workspaceDb, threadId, activePlanItemId, activePlan } =
      await createApprovedGoalForSourceChange('Deferred question');
    const entered = Promise.withResolvers<void>();
    const modelResult = Promise.withResolvers<GoalPlanOutput>();

    try {
      const pending = createGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        requestId: 'req_deferred_question',
        planner: () => {
          entered.resolve();
          return modelResult.promise;
        },
      });
      await entered.promise;
      updateGoalTask(workspaceDb, {
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        taskId: 'task_1',
        status: 'running',
      });
      modelResult.resolve({
        ...activePlan,
        questions: ['Which changed Task result should the revised Plan use?'],
        taskDispositions: [
          {
            taskId: 'task_1',
            successorTaskId: 'task_1',
            reason: 'Keep the current release work pending clarification.',
          },
        ],
      });
      await expect(pending).rejects.toMatchObject({ code: 'stale' });
      expect(
        store
          .listThreadItems(WORKSPACE_ID, threadId)
          .filter((item) => item.causationId === 'req_deferred_question')
      ).toEqual([]);
      expect(
        store.listThreadTurns(WORKSPACE_ID, threadId).filter((turn) => turn.status === 'failed')
      ).toHaveLength(1);
      expect(getGoalRecord(workspaceDb, WORKSPACE_ID, threadId, GOAL_ID)).toMatchObject({
        status: 'running',
        planItemId: activePlanItemId,
        pendingPlanItemId: null,
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('activates only the exact approved successor and leaves old Task history non-dispatchable', async () => {
    const { store, workspaceDb, threadId } = createPlanningFixture('Approve Goal successor');

    try {
      const first = await createGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        requestId: 'req_successor_initial',
        planner: () =>
          createDeterministicGoalPlanFallback({
            goalTitle: 'Prepare release',
            objective: 'Prepare the release for publication.',
          }),
      });
      expect(first.status).toBe('awaiting_plan_approval');
      if (first.status !== 'awaiting_plan_approval') return;
      approveGoalPlan({
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        planItemId: first.planItem.id,
      });
      const changedIntent = reviseGoalIntent({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        requestId: 'req_successor_intent',
        objective: 'Prepare release and verify its publication package.',
        revision: 'Add independent package verification.',
        affectedTaskIds: [],
      });
      const successor = await createGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        requestId: 'req_successor_plan',
        planner: () => ({
          ...first.plan,
          goalSummary: 'Prepare and independently verify the publication package.',
          tasks: [
            {
              ...first.plan.tasks[0]!,
              taskId: 'task_2',
              title: 'Verify publication package',
              objective: 'Verify the publication package independently.',
            },
          ],
          taskDispositions: [
            {
              taskId: 'task_1',
              successorTaskId: 'task_2',
              reason: 'Continue the unfinished release work in the verification Task.',
            },
          ],
        }),
      });
      expect(successor.status).toBe('awaiting_plan_approval');
      if (successor.status !== 'awaiting_plan_approval') return;
      expect(getGoalRecord(workspaceDb, WORKSPACE_ID, threadId, GOAL_ID)).toMatchObject({
        status: 'running',
        planItemId: first.planItem.id,
        pendingPlanItemId: successor.planItem.id,
      });
      expect(
        getGoalPlanRecord(workspaceDb, WORKSPACE_ID, threadId, successor.planItem.id)
      ).toMatchObject({
        predecessorPlanItemId: first.planItem.id,
        sourceIntentItemId: changedIntent.intentItem.id,
        sourceTaskEvidenceDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      });
      expect(
        listGoalTasks(workspaceDb, { workspaceId: WORKSPACE_ID, threadId, goalId: GOAL_ID }).map(
          (task) => task.taskId
        )
      ).toEqual(['task_1']);
      expect(() =>
        approveGoalPlan({
          workspaceDb,
          store,
          workspaceId: WORKSPACE_ID,
          threadId,
          goalId: GOAL_ID,
          planItemId: first.planItem.id,
        })
      ).toThrowError(expect.objectContaining({ code: 'stale' }));
      updateGoalStatus(workspaceDb, {
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        status: 'blocked',
        terminalStopReason: 'budget_exhausted',
      });
      expect(() =>
        approveGoalPlan({
          workspaceDb,
          store,
          workspaceId: WORKSPACE_ID,
          threadId,
          goalId: GOAL_ID,
          planItemId: successor.planItem.id,
        })
      ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
      expect(getGoalRecord(workspaceDb, WORKSPACE_ID, threadId, GOAL_ID)).toMatchObject({
        status: 'blocked',
        planItemId: first.planItem.id,
        pendingPlanItemId: successor.planItem.id,
      });
      expect(
        listGoalTasks(workspaceDb, { workspaceId: WORKSPACE_ID, threadId, goalId: GOAL_ID })
      ).toHaveLength(1);
      updateGoalStatus(workspaceDb, {
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        status: 'running',
        terminalStopReason: null,
      });
      approveGoalPlan({
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        planItemId: successor.planItem.id,
      });
      expect(getGoalRecord(workspaceDb, WORKSPACE_ID, threadId, GOAL_ID)).toMatchObject({
        status: 'running',
        planItemId: successor.planItem.id,
        pendingPlanItemId: null,
      });
      expect(
        listGoalTasks(workspaceDb, { workspaceId: WORKSPACE_ID, threadId, goalId: GOAL_ID }).map(
          (task) => ({ taskId: task.taskId, planItemId: task.planItemId })
        )
      ).toEqual([
        { taskId: 'task_1', planItemId: first.planItem.id },
        { taskId: 'task_2', planItemId: successor.planItem.id },
      ]);
      expect(
        listDispatchableGoalTasks(workspaceDb, {
          workspaceId: WORKSPACE_ID,
          threadId,
          goalId: GOAL_ID,
        }).map((task) => task.taskId)
      ).toEqual(['task_2']);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('requires an exact disposition for each unfinished predecessor Task before a successor is approvable', async () => {
    const { store, workspaceDb, threadId } = createPlanningFixture('Disposition of remaining work');

    try {
      const base = createDeterministicGoalPlanFallback({
        goalTitle: 'Prepare release',
        objective: 'Prepare the release for publication.',
      });
      const initial = await createGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        requestId: 'req_dispositions_initial',
        planner: () => ({
          ...base,
          tasks: [
            base.tasks[0]!,
            {
              ...base.tasks[0]!,
              taskId: 'task_2',
              title: 'Completed check',
              reviewPolicy: { ...base.tasks[0]!.reviewPolicy, required: false },
            },
            { ...base.tasks[0]!, taskId: 'task_3', title: 'Remaining check' },
          ],
          taskDispositions: [],
        }),
      });
      expect(initial.status).toBe('awaiting_plan_approval');
      if (initial.status !== 'awaiting_plan_approval') return;
      expect(initial.plan.taskDispositions).toEqual([]);
      approveGoalPlan({
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        planItemId: initial.planItem.id,
      });
      const completedTurn = store.createTurn(
        WORKSPACE_ID,
        threadId,
        'Complete the no-Review check.',
        USER_ACTOR
      );
      recordWorkerTurnLaunchDecision({
        workspaceDb,
        workspaceId: WORKSPACE_ID,
        threadId,
        turnId: completedTurn.id,
        goalId: GOAL_ID,
        taskId: 'task_2',
      });
      const completedAt = completedTurn.startedAt ?? new Date().toISOString();
      store.updateTurn(completedTurn.id, {
        status: 'completed',
        completedAt,
        durationMs: 0,
      });
      updateGoalTask(workspaceDb, {
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        taskId: 'task_2',
        status: 'completed',
      });
      reviseGoalIntent({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        requestId: 'req_dispositions_intent',
        objective: 'Finish the remaining release work and verification.',
        revision: 'Account for every unfinished Task.',
        affectedTaskIds: ['task_1', 'task_3'],
      });
      const successorOutput: GoalPlanOutput = {
        ...initial.plan,
        goalSummary: 'Finish the remaining release work and verification.',
        assumptions: [
          ...initial.plan.assumptions,
          'The completed task_2 check is excluded because the new verification Task replaces it.',
        ],
        tasks: [
          { ...base.tasks[0]!, taskId: 'task_4', title: 'Finish release' },
          { ...base.tasks[0]!, taskId: 'task_5', title: 'Verify release' },
        ],
        taskDispositions: [
          {
            taskId: 'task_1',
            successorTaskId: 'task_4',
            reason: 'Carry unfinished release work forward.',
          },
          {
            taskId: 'task_3',
            successorTaskId: null,
            reason: 'This check is superseded by the new verification Task.',
          },
        ],
      };
      const propose = (requestId: string, output: GoalPlanOutput) =>
        createGoalPlan({
          triggerActor: USER_ACTOR,
          workspaceDb,
          store,
          workspaceId: WORKSPACE_ID,
          threadId,
          goalId: GOAL_ID,
          requestId,
          planner: () => output,
        });
      await expect(
        propose('req_dispositions_missing', {
          ...successorOutput,
          taskDispositions: successorOutput.taskDispositions.slice(0, 1),
        })
      ).rejects.toMatchObject({ code: 'goal_plan_revision_invalid' });
      await expect(
        propose('req_dispositions_invalid_target', {
          ...successorOutput,
          taskDispositions: [
            { ...successorOutput.taskDispositions[0]!, successorTaskId: 'task_missing' },
            successorOutput.taskDispositions[1]!,
          ],
        })
      ).rejects.toMatchObject({ code: 'goal_plan_revision_invalid' });
      expect(getGoalRecord(workspaceDb, WORKSPACE_ID, threadId, GOAL_ID)).toMatchObject({
        planItemId: initial.planItem.id,
        pendingPlanItemId: null,
      });
      expect(
        listGoalTasks(workspaceDb, { workspaceId: WORKSPACE_ID, threadId, goalId: GOAL_ID }).map(
          (task) => task.taskId
        )
      ).toEqual(['task_1', 'task_2', 'task_3']);

      const successor = await propose('req_dispositions_valid', successorOutput);
      expect(successor.status).toBe('awaiting_plan_approval');
      if (successor.status !== 'awaiting_plan_approval') return;
      expect(
        getGoalPlanRecord(workspaceDb, WORKSPACE_ID, threadId, successor.planItem.id)
          ?.taskDispositions
      ).toEqual(successorOutput.taskDispositions);
      expect(successor.planItem.summary).toContain('task_3 → ended');
      approveGoalPlan({
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        planItemId: successor.planItem.id,
      });
      expect(
        listDispatchableGoalTasks(workspaceDb, {
          workspaceId: WORKSPACE_ID,
          threadId,
          goalId: GOAL_ID,
        }).map((task) => task.taskId)
      ).toEqual(['task_4', 'task_5']);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('approves a revised pending successor through its exact active Plan ancestry', async () => {
    const { store, workspaceDb, threadId, activePlanItemId, activePlan } =
      await createApprovedGoalForSourceChange('Revise pending successor');

    try {
      const firstCandidate = await createGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        requestId: 'req_pending_successor_p1',
        planner: () => ({
          ...activePlan,
          goalSummary: 'Prepare release with separate verification.',
          tasks: [{ ...activePlan.tasks[0]!, taskId: 'task_2', title: 'Verify release' }],
          taskDispositions: [
            {
              taskId: 'task_1',
              successorTaskId: 'task_2',
              reason: 'Carry unfinished release work to the first candidate.',
            },
          ],
        }),
      });
      expect(firstCandidate.status).toBe('awaiting_plan_approval');
      if (firstCandidate.status !== 'awaiting_plan_approval') return;
      reviseGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        planItemId: firstCandidate.planItem.id,
        requestId: 'req_pending_successor_revision',
        revision: 'Use an independent package audit instead.',
      });
      const secondCandidate = await createGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        requestId: 'req_pending_successor_p2',
        planner: (input) => ({
          ...input.previousPlan!,
          goalSummary: 'Prepare release with an independent package audit.',
          tasks: [
            {
              ...input.previousPlan!.tasks[0]!,
              taskId: 'task_3',
              title: 'Audit release package',
            },
          ],
          taskDispositions: [
            {
              taskId: 'task_1',
              successorTaskId: 'task_3',
              reason: 'Carry unfinished release work to the package audit.',
            },
          ],
        }),
      });
      expect(secondCandidate.status).toBe('awaiting_plan_approval');
      if (secondCandidate.status !== 'awaiting_plan_approval') return;
      expect(
        getGoalPlanRecord(workspaceDb, WORKSPACE_ID, threadId, secondCandidate.planItem.id)
      ).toMatchObject({
        predecessorPlanItemId: firstCandidate.planItem.id,
        sourceTaskEvidenceDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      });
      expect(getGoalRecord(workspaceDb, WORKSPACE_ID, threadId, GOAL_ID)).toMatchObject({
        planItemId: activePlanItemId,
        pendingPlanItemId: secondCandidate.planItem.id,
      });
      expect(() =>
        approveGoalPlan({
          workspaceDb,
          store,
          workspaceId: WORKSPACE_ID,
          threadId,
          goalId: GOAL_ID,
          planItemId: firstCandidate.planItem.id,
        })
      ).toThrowError(expect.objectContaining({ code: 'stale' }));
      expect(
        approveGoalPlan({
          workspaceDb,
          store,
          workspaceId: WORKSPACE_ID,
          threadId,
          goalId: GOAL_ID,
          planItemId: secondCandidate.planItem.id,
        }).status
      ).toBe('approved');
      expect(getGoalRecord(workspaceDb, WORKSPACE_ID, threadId, GOAL_ID)).toMatchObject({
        planItemId: secondCandidate.planItem.id,
        pendingPlanItemId: null,
      });
      expect(
        listGoalTasks(workspaceDb, { workspaceId: WORKSPACE_ID, threadId, goalId: GOAL_ID }).map(
          (task) => task.taskId
        )
      ).toEqual(['task_1', 'task_3']);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('carries a completed no-Review Task Artifact and permits independent new resources', async () => {
    const { store, workspaceDb, threadId } = createPlanningFixture('Carry accepted Artifact');

    try {
      const base = createDeterministicGoalPlanFallback({
        goalTitle: 'Prepare release',
        objective: 'Prepare the release for publication.',
      });
      const initial = await createGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        requestId: 'req_artifact_source_initial',
        planner: () => ({
          ...base,
          tasks: [
            {
              ...base.tasks[0]!,
              reviewPolicy: { ...base.tasks[0]!.reviewPolicy, required: false },
            },
            { ...base.tasks[0]!, taskId: 'task_2', title: 'Remaining release check' },
          ],
        }),
      });
      expect(initial.status).toBe('awaiting_plan_approval');
      if (initial.status !== 'awaiting_plan_approval') return;
      approveGoalPlan({
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        planItemId: initial.planItem.id,
      });
      const completedTurn = store.createTurn(
        WORKSPACE_ID,
        threadId,
        'Complete the first release check.',
        USER_ACTOR
      );
      recordWorkerTurnLaunchDecision({
        workspaceDb,
        workspaceId: WORKSPACE_ID,
        threadId,
        turnId: completedTurn.id,
        goalId: GOAL_ID,
        taskId: 'task_1',
      });
      const completedAt = completedTurn.startedAt ?? new Date().toISOString();
      const outputBody = 'Verified first release package.';
      const outputArtifact = store.createArtifact({
        id: 'ar_completed_task_output',
        workspaceId: WORKSPACE_ID,
        threadId,
        turnId: completedTurn.id,
        kind: 'summary',
        title: 'Completed Task output',
        status: 'ready',
        summary: null,
        version: 1,
        content: { format: 'text', body: outputBody },
        contentDigest: `sha256:${createHash('sha256').update(outputBody).digest('hex')}`,
        lastMutationRequestId: 'req_completed_task_output',
        origin: {
          kind: 'turn-output',
          threadId,
          turnId: completedTurn.id,
          requestId: 'req_completed_task_output',
        },
        createdAt: completedAt,
        updatedAt: completedAt,
      });
      const extraBody = 'Unaccepted draft from the same worker Turn.';
      const extraArtifact = store.createArtifact({
        id: 'ar_unaccepted_same_turn_output',
        workspaceId: WORKSPACE_ID,
        threadId,
        turnId: completedTurn.id,
        kind: 'summary',
        title: 'Unaccepted Turn draft',
        status: 'ready',
        summary: null,
        version: 1,
        content: { format: 'text', body: extraBody },
        contentDigest: `sha256:${createHash('sha256').update(extraBody).digest('hex')}`,
        lastMutationRequestId: 'req_unaccepted_same_turn_output',
        origin: {
          kind: 'turn-output',
          threadId,
          turnId: completedTurn.id,
          requestId: 'req_unaccepted_same_turn_output',
        },
        createdAt: completedAt,
        updatedAt: completedAt,
      });
      const acceptedReference = store
        .listThreadItems(WORKSPACE_ID, threadId)
        .find(
          (item) => item.type === 'artifact-reference' && item.artifactId === outputArtifact.id
        );
      expect(acceptedReference?.type).toBe('artifact-reference');
      store.updateTurn(completedTurn.id, {
        status: 'completed',
        completedAt,
        durationMs: 0,
      });
      const terminalCheckpoint = {
        workspaceId: WORKSPACE_ID,
        threadId,
        turnId: completedTurn.id,
        goalId: GOAL_ID,
        taskId: 'task_1',
        requestId: 'req_completed_task_output',
        requestInputHash: commandInputHash({}),
        stage: 'completed',
        iteration: 1,
        stopReason: 'completed',
        diagnosticsSummary: createWorkerCheckpointEvidenceDiagnostics({
          itemIds: [acceptedReference!.id],
          artifactIds: [outputArtifact.id],
        }),
      } as const;
      upsertWorkerCheckpoint(workspaceDb, terminalCheckpoint);
      updateGoalTask(workspaceDb, {
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        taskId: 'task_1',
        status: 'completed',
      });
      const independentBody = 'Independent release notes.';
      const independentArtifact = store.createArtifact({
        id: 'ar_independent_release_notes',
        workspaceId: WORKSPACE_ID,
        threadId: null,
        turnId: null,
        kind: 'file',
        title: 'Release notes',
        status: 'ready',
        summary: null,
        version: 1,
        content: { format: 'text', body: independentBody },
        contentDigest: `sha256:${createHash('sha256').update(independentBody).digest('hex')}`,
        lastMutationRequestId: 'req_independent_release_notes',
        origin: {
          kind: 'imported',
          sourceKind: 'direct-import',
          sourceId: 'req_independent_release_notes',
          sourceDigest: `sha256:${createHash('sha256').update(independentBody).digest('hex')}`,
          actor: USER_ACTOR,
          requestId: 'req_independent_release_notes',
          recordedAt: completedAt,
        },
        createdAt: completedAt,
        updatedAt: completedAt,
      });
      expect(
        await clearWorkerCheckpointAfterTerminalState(workspaceDb, {
          workspaceId: WORKSPACE_ID,
          threadId,
          turnId: completedTurn.id,
        })
      ).toBe(true);
      expect(getWorkerCheckpoint(workspaceDb, WORKSPACE_ID, threadId, completedTurn.id)).toBeNull();
      const postCleanup = captureGoalTaskEvidenceSnapshot(store, workspaceDb, {
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        planItemId: initial.planItem.id,
      });
      expect(postCleanup.facts[0]?.acceptedOutcome?.artifacts ?? []).not.toContainEqual(
        expect.objectContaining({ id: extraArtifact.id })
      );
      upsertWorkerCheckpoint(workspaceDb, terminalCheckpoint);
      const snapshot = captureGoalTaskEvidenceSnapshot(store, workspaceDb, {
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        planItemId: initial.planItem.id,
      });
      expect(snapshot.facts[0]).toMatchObject({
        taskId: 'task_1',
        status: 'completed',
        reviews: [],
        acceptedOutcome: {
          turnId: completedTurn.id,
          artifacts: [{ id: outputArtifact.id, version: 1, digest: outputArtifact.contentDigest }],
        },
      });
      expect(snapshot.facts[0]?.acceptedOutcome?.artifacts).toEqual([
        { id: outputArtifact.id, version: 1, digest: outputArtifact.contentDigest },
      ]);
      expect(snapshot.facts[0]?.acceptedOutcome?.items.map((item) => item.id)).toEqual([
        acceptedReference!.id,
      ]);
      reviseGoalIntent({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        requestId: 'req_artifact_source_intent',
        objective: 'Finish release using the accepted result and independent notes.',
        revision: 'Carry accepted Task evidence into the remaining check.',
        affectedTaskIds: ['task_2'],
      });
      const acceptedPlan: GoalPlanOutput = {
        ...initial.plan,
        goalSummary: 'Finish release using the accepted result and independent notes.',
        tasks: [
          {
            ...initial.plan.tasks[1]!,
            taskId: 'task_3',
            title: 'Verify combined release evidence',
            resources: [
              ...initial.plan.tasks[1]!.resources,
              {
                kind: 'artifact',
                reference: outputArtifact.id,
                reason: 'Use the accepted result of completed task_1.',
              },
              {
                kind: 'artifact',
                reference: independentArtifact.id,
                reason: 'Include separately authorized release notes.',
              },
            ],
          },
        ],
        taskDispositions: [
          {
            taskId: 'task_2',
            successorTaskId: 'task_3',
            reason: 'Continue unfinished release verification with both resources.',
          },
        ],
      };
      await expect(
        createGoalPlan({
          triggerActor: USER_ACTOR,
          workspaceDb,
          store,
          workspaceId: WORKSPACE_ID,
          threadId,
          goalId: GOAL_ID,
          requestId: 'req_unaccepted_same_turn_resource',
          planner: () => ({
            ...acceptedPlan,
            tasks: [
              {
                ...acceptedPlan.tasks[0]!,
                resources: [
                  ...acceptedPlan.tasks[0]!.resources,
                  {
                    kind: 'artifact',
                    reference: extraArtifact.id,
                    reason: 'Attempt to carry an output absent from terminal acceptance.',
                  },
                ],
              },
            ],
          }),
        })
      ).rejects.toMatchObject({ code: 'goal_plan_revision_invalid' });
      expect(getGoalRecord(workspaceDb, WORKSPACE_ID, threadId, GOAL_ID)).toMatchObject({
        pendingPlanItemId: null,
      });
      const candidate = await createGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        requestId: 'req_artifact_source_candidate',
        planner: () => acceptedPlan,
      });
      expect(candidate.status).toBe('awaiting_plan_approval');
      if (candidate.status !== 'awaiting_plan_approval') return;
      expect(
        getGoalPlanRecord(workspaceDb, WORKSPACE_ID, threadId, candidate.planItem.id)
      ).toMatchObject({
        sourceTaskEvidenceDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      });
      const laterUnrelatedBody = 'Unrelated new research note.';
      store.createArtifact({
        id: 'ar_later_unrelated_note',
        workspaceId: WORKSPACE_ID,
        threadId: null,
        turnId: null,
        kind: 'file',
        title: 'Later unrelated note',
        status: 'ready',
        summary: null,
        version: 1,
        content: { format: 'text', body: laterUnrelatedBody },
        contentDigest: `sha256:${createHash('sha256').update(laterUnrelatedBody).digest('hex')}`,
        lastMutationRequestId: 'req_later_unrelated_note',
        origin: {
          kind: 'imported',
          sourceKind: 'direct-import',
          sourceId: 'req_later_unrelated_note',
          sourceDigest: `sha256:${createHash('sha256').update(laterUnrelatedBody).digest('hex')}`,
          actor: USER_ACTOR,
          requestId: 'req_later_unrelated_note',
          recordedAt: completedAt,
        },
        createdAt: completedAt,
        updatedAt: completedAt,
      });
      expect(
        approveGoalPlan({
          workspaceDb,
          store,
          workspaceId: WORKSPACE_ID,
          threadId,
          goalId: GOAL_ID,
          planItemId: candidate.planItem.id,
        }).status
      ).toBe('approved');
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rejects the retired planning-answer command without changing retained Goal state', async () => {
    const { dataRoot, store, workspaceDb, threadId, activePlan } =
      await createApprovedGoalForSourceChange('Stale planning answer');
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: LOCAL_USER_ID,
      workspaceId: WORKSPACE_ID,
    });

    try {
      const question = await createGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        requestId: 'req_stale_answer_question',
        planner: () => ({
          ...activePlan,
          tasks: [{ ...activePlan.tasks[0]!, taskId: 'task_2' }],
          taskDispositions: [
            {
              taskId: 'task_1',
              successorTaskId: 'task_2',
              reason: 'Carry remaining release work into the proposed Task.',
            },
          ],
          questions: ['Which release window?'],
        }),
      });
      expect(question.status).toBe('awaiting_user');
      if (question.status !== 'awaiting_user') return;
      const newerIntent = reviseGoalIntent({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        requestId: 'req_stale_answer_newer_intent',
        objective: 'Prepare a later release with security verification.',
        revision: 'The previous release-window question no longer applies.',
        affectedTaskIds: [],
      });
      const itemsBeforeAnswer = store
        .listThreadItems(WORKSPACE_ID, threadId)
        .map((item) => item.id);
      const app = createApp({ coreDb, dataRoot, store });
      const answer = await app.request('/api/turns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: WORKSPACE_ID,
          threadId,
          turnId: question.questionItem.turnId,
          requestId: '00000000-0000-4000-8000-000000000806',
          answers: { plan_question_1: ['Friday'] },
        }),
      });
      // The removed request shape cannot establish Workspace authority at the command boundary.
      expect(answer.status).toBe(403);
      expect(await answer.json()).toMatchObject({ code: 'workspace_access_denied' });
      expect(store.listThreadItems(WORKSPACE_ID, threadId).map((item) => item.id)).toEqual(
        itemsBeforeAnswer
      );
      expect(store.getTurn(WORKSPACE_ID, threadId, question.questionItem.turnId)).toMatchObject({
        status: 'running',
      });
      expect(getGoalRecord(workspaceDb, WORKSPACE_ID, threadId, GOAL_ID)).toMatchObject({
        currentIntentItemId: newerIntent.intentItem.id,
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('keeps unaffected approved work dispatchable and holds named or unspecified scope', async () => {
    const { store, workspaceDb, threadId } = createPlanningFixture('Revise running Goal intent');

    try {
      const initialIntentItemId = getGoalRecord(
        workspaceDb,
        WORKSPACE_ID,
        threadId,
        GOAL_ID
      )!.currentIntentItemId;
      const initial = await createGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        requestId: 'req_scope_initial',
        planner: () => {
          const base = createDeterministicGoalPlanFallback({
            goalTitle: 'Prepare release',
            objective: 'Prepare the release for publication.',
          });
          const first = base.tasks[0]!;
          return {
            ...base,
            tasks: [
              first,
              {
                ...first,
                taskId: 'task_2',
                title: 'Dependent verification',
                dependsOnTaskIds: [first.taskId],
              },
              { ...first, taskId: 'task_3', title: 'Independent notes', dependsOnTaskIds: [] },
            ],
          };
        },
      });
      expect(initial.status).toBe('awaiting_plan_approval');
      if (initial.status !== 'awaiting_plan_approval') return;
      approveGoalPlan({
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        planItemId: initial.planItem.id,
      });
      const dispatchableTaskIds = () =>
        listDispatchableGoalTasks(workspaceDb, {
          workspaceId: WORKSPACE_ID,
          threadId,
          goalId: GOAL_ID,
        }).map((task) => task.taskId);
      expect(dispatchableTaskIds()).toEqual(['task_1', 'task_2', 'task_3']);

      const named = reviseGoalIntent({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        requestId: 'req_intent_named',
        objective: 'Prepare release with independent notes.',
        revision: 'Reconsider the verification chain.',
        affectedTaskIds: ['task_1'],
      });
      expect(named.intentItem).toMatchObject({
        parentItemId: initialIntentItemId,
        causationId: 'req_intent_named',
      });
      expect(dispatchableTaskIds()).toEqual(['task_3']);
      expect(getGoalRecord(workspaceDb, WORKSPACE_ID, threadId, GOAL_ID)).toMatchObject({
        status: 'running',
        objective: 'Prepare release with independent notes.',
        planItemId: initial.planItem.id,
        pendingPlanItemId: null,
        currentAffectedTaskIds: ['task_1'],
      });

      const unspecified = reviseGoalIntent({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        requestId: 'req_intent_unspecified',
        objective: 'Prepare release for a changed audience.',
        revision: 'The audience changed and work needs review.',
      });
      expect(unspecified.intentItem.parentItemId).toBe(named.intentItem.id);
      expect(dispatchableTaskIds()).toEqual([]);

      const unaffected = reviseGoalIntent({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        requestId: 'req_intent_unaffected',
        objective: 'Prepare the same work for a clearer audience.',
        revision: 'All approved tasks remain valid.',
        affectedTaskIds: [],
      });
      expect(unaffected.intentItem.parentItemId).toBe(unspecified.intentItem.id);
      expect(dispatchableTaskIds()).toEqual(['task_1', 'task_2', 'task_3']);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('keeps an initial model failure recoverable without rerunning its request', async () => {
    const { store, workspaceDb, threadId } = createPlanningFixture('Recover initial planning');

    try {
      const attempt = {
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        requestId: 'req_initial_failed',
      } as const;
      const planner = vi.fn(() => {
        throw new Error('model unavailable');
      });
      await createGoalPlan({ ...attempt, planner }).catch(() => undefined);
      expect(planner).toHaveBeenCalledTimes(1);
      expect(getGoalRecord(workspaceDb, WORKSPACE_ID, threadId, GOAL_ID)).toMatchObject({
        status: 'planning',
        planItemId: null,
        pendingPlanItemId: null,
        terminalStopReason: null,
      });
      expect(
        store.listThreadTurns(WORKSPACE_ID, threadId).filter((turn) => turn.status === 'failed')
      ).toHaveLength(1);

      const replayPlanner = vi.fn(() =>
        createDeterministicGoalPlanFallback({
          goalTitle: 'Prepare release',
          objective: 'Prepare the release for publication.',
        })
      );
      await expect(createGoalPlan({ ...attempt, planner: replayPlanner })).rejects.toMatchObject({
        code: 'recovery_required',
      });
      expect(replayPlanner).not.toHaveBeenCalled();

      const retry = await createGoalPlan({
        ...attempt,
        requestId: 'req_initial_retry',
        planner: replayPlanner,
      });
      expect(replayPlanner).toHaveBeenCalledTimes(1);
      expect(retry.status).toBe('awaiting_plan_approval');
      expect(getGoalRecord(workspaceDb, WORKSPACE_ID, threadId, GOAL_ID)).toMatchObject({
        status: 'awaiting_plan_approval',
        planItemId: null,
        pendingPlanItemId: expect.any(String),
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('retains a failed revision attempt and retries only under a new planning request', async () => {
    const { store, workspaceDb, threadId } = createPlanningFixture('Continuous planning');

    try {
      const initial = await createGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        requestId: 'req_initial_plan',
        planner: () =>
          createDeterministicGoalPlanFallback({
            goalTitle: 'Prepare release',
            objective: 'Prepare the release for publication.',
          }),
      });
      expect(initial.status).toBe('awaiting_plan_approval');
      if (initial.status !== 'awaiting_plan_approval') return;
      expect(getGoalRecord(workspaceDb, WORKSPACE_ID, threadId, GOAL_ID)).toMatchObject({
        planItemId: null,
        pendingPlanItemId: initial.planItem.id,
      });

      reviseGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        planItemId: initial.planItem.id,
        requestId: 'req_revision_instruction',
        revision: REVISION,
      });
      const attempt = {
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        requestId: 'req_revision_attempt',
      } as const;
      const planner = vi.fn(() => {
        throw new Error('model unavailable');
      });
      await expect(createGoalPlan({ ...attempt, planner })).rejects.toMatchObject({
        code: 'goal_plan_revision_unavailable',
      });
      expect(planner).toHaveBeenCalledTimes(1);

      const failedTurns = store
        .listThreadTurns(WORKSPACE_ID, threadId)
        .filter((turn) => turn.status === 'failed');
      expect(failedTurns).toHaveLength(1);
      const failedTurn = failedTurns[0]!;
      expect(failedTurn.completedAt).not.toBeNull();
      expect(failedTurn.error?.code).toBe('goal_plan_revision_failed');
      expect(
        store
          .listThreadItems(WORKSPACE_ID, threadId)
          .filter(
            (item) =>
              item.turnId === failedTurn.id &&
              (item.type === 'plan' || item.type === 'user-input-request')
          )
      ).toEqual([]);
      expect(
        store.listThreadItems(WORKSPACE_ID, threadId).filter((item) => item.type === 'user-message')
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'user-message',
            status: 'completed',
            parentItemId: initial.planItem.id,
            causationId: 'req_revision_instruction',
            text: REVISION,
          }),
        ])
      );
      expect(readGoalPlanCreation(attempt)).toBeNull();
      expect(getGoalRecord(workspaceDb, WORKSPACE_ID, threadId, GOAL_ID)).toMatchObject({
        status: 'awaiting_plan_approval',
        planItemId: null,
        pendingPlanItemId: initial.planItem.id,
        terminalStopReason: null,
      });

      const replayPlanner = vi.fn(() => initial.plan);
      await expect(createGoalPlan({ ...attempt, planner: replayPlanner })).rejects.toMatchObject({
        code: 'recovery_required',
      });
      expect(replayPlanner).not.toHaveBeenCalled();

      const retry = await createGoalPlan({
        ...attempt,
        requestId: 'req_revision_retry',
        planner: (input) => ({
          ...input.previousPlan!,
          goalSummary: 'Prepare release and independently verify it.',
          tasks: [
            {
              ...input.previousPlan!.tasks[0]!,
              taskId: 'task_2',
              title: 'Verify release',
              objective: REVISION,
              dependsOnTaskIds: [],
            },
          ],
        }),
      });
      expect(retry.status).toBe('awaiting_plan_approval');
      if (retry.status !== 'awaiting_plan_approval') return;
      expect(retry.planItem.id).not.toBe(initial.planItem.id);
      expect(
        getGoalPlanRecord(workspaceDb, WORKSPACE_ID, threadId, retry.planItem.id)
      ).toMatchObject({
        predecessorPlanItemId: initial.planItem.id,
        sourceTaskEvidenceDigest: null,
      });
      expect(
        approveGoalPlan({
          workspaceDb,
          store,
          workspaceId: WORKSPACE_ID,
          threadId,
          goalId: GOAL_ID,
          planItemId: retry.planItem.id,
        }).status
      ).toBe('approved');
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('accepts a new revision instruction against the same Plan after a terminal failed attempt', async () => {
    const { store, workspaceDb, threadId } = createPlanningFixture('Revise after terminal failure');

    try {
      const initial = await createGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        requestId: 'req_new_instruction_initial',
        planner: () =>
          createDeterministicGoalPlanFallback({
            goalTitle: 'Prepare release',
            objective: 'Prepare the release for publication.',
          }),
      });
      expect(initial.status).toBe('awaiting_plan_approval');
      if (initial.status !== 'awaiting_plan_approval') return;
      const firstInstruction = reviseGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        planItemId: initial.planItem.id,
        requestId: 'req_first_revision_instruction',
        revision: 'Add release verification.',
      });
      await expect(
        createGoalPlan({
          triggerActor: USER_ACTOR,
          workspaceDb,
          store,
          workspaceId: WORKSPACE_ID,
          threadId,
          goalId: GOAL_ID,
          requestId: 'req_first_revision_failure',
          planner: () => {
            throw new Error('Model unavailable.');
          },
        })
      ).rejects.toMatchObject({ code: 'goal_plan_revision_unavailable' });
      const secondInstruction = reviseGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        planItemId: initial.planItem.id,
        requestId: 'req_second_revision_instruction',
        revision: 'Add a different security verification step.',
      });
      expect(secondInstruction.revisionItem.id).not.toBe(firstInstruction.revisionItem.id);
      expect(secondInstruction.revisionItem).toMatchObject({
        parentItemId: initial.planItem.id,
        causationId: 'req_second_revision_instruction',
      });
      const planner = vi.fn((input: GoalPlannerInput) => ({
        ...input.previousPlan!,
        goalSummary: 'Prepare release with security verification.',
        tasks: [
          {
            ...input.previousPlan!.tasks[0]!,
            taskId: 'task_2',
            title: 'Verify release security',
          },
        ],
      }));
      const successor = await createGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        requestId: 'req_second_revision_plan',
        planner,
      });
      expect(successor.status).toBe('awaiting_plan_approval');
      expect(planner).toHaveBeenCalledTimes(1);
      expect(planner.mock.calls[0]?.[0]).toMatchObject({
        previousPlanItemId: initial.planItem.id,
        revisionText: 'Add a different security verification step.',
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});

// This fixture supplies confirmed image evidence; the production resolver and subject checks still run.
vi.mock('../runtime/agent-environment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime/agent-environment.js')>();
  const { withTestPreparedNativeEnvironment } = await import(
    '../test-support/native-environment.js'
  );
  return withTestPreparedNativeEnvironment(actual);
});

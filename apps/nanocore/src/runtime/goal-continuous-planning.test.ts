import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';
import type { InternalAgentProviderCall } from '../internal-agents/internal-agent-loop.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { recordWorkerTurnLaunchDecision } from '../policy/permission-decisions.js';
import { openCoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { LOCAL_USER_ID } from '../storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createApp } from '../test-support/app.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { seedWritableGitRepository } from '../test-support/git-repository.js';
import { upsertWorkspaceRepositoryResource } from '../workspace/repository-store.js';
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

  it('records a bounded execution refinement before launch and replays its exact Item', async () => {
    const { dataRoot, store, workspaceDb, threadId } =
      createPlanningFixture('Refine approved step');
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: LOCAL_USER_ID,
      workspaceId: WORKSPACE_ID,
    });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-goal-refinement-repo-'));
    seedWritableGitRepository(repositoryPath);
    upsertWorkspaceRepositoryResource(workspaceDb, {
      workspaceExists: (workspaceId) => workspaceId === WORKSPACE_ID,
      workspaceId: WORKSPACE_ID,
      displayName: 'Refinement repository',
      localPath: repositoryPath,
    });

    try {
      const initial = await createGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        requestId: 'req_refinement_plan',
        planner: () => {
          const fallback = createDeterministicGoalPlanFallback({
            goalTitle: 'Prepare release',
            objective: 'Prepare the release for publication.',
          });
          return {
            ...fallback,
            tasks: [
              {
                ...fallback.tasks[0]!,
                reviewPolicy: { ...fallback.tasks[0]!.reviewPolicy, required: false },
              },
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
      const executor = new SimulatedTurnExecutor();
      const refinementItemsAtLaunch: ReturnType<typeof store.listThreadItems> = [];
      vi.spyOn(executor, 'startTurn').mockImplementation(
        async (workerStore, turnId, _input, context) => {
          const turn = workerStore.getTurnById(turnId);
          refinementItemsAtLaunch.push(
            ...workerStore
              .listThreadItems(WORKSPACE_ID, threadId)
              .filter(
                (item) => item.turnId === turnId && item.title === 'Goal execution refinement'
              )
          );
          const timestamp = turn.startedAt ?? new Date().toISOString();
          const sessionId = context?.agentSessionId ?? `session_${turnId}`;
          let session: ReturnType<typeof workerStore.getAgentSession>;
          try {
            session = workerStore.getAgentSession(sessionId);
          } catch {
            session = workerStore.createAgentSession({
              agentId: turn.agentId!,
              createdAt: timestamp,
              id: sessionId,
              message: null,
              status: 'busy',
              threadId: turn.threadId,
              updatedAt: timestamp,
              workspaceId: turn.workspaceId,
            });
          }
          workerStore.updateTurn(turnId, { agentSessionId: session.id });
          const completed = workerStore.updateTurn(turnId, {
            status: 'completed',
            completedAt: timestamp,
            durationMs: 0,
          });
          workerStore.updateAgentSession(session.id, { status: 'idle', updatedAt: timestamp });
          workerStore.emitTurnEvent(turnId, {
            event: 'turn.completed',
            requestId: context?.requestId ?? null,
            workspaceId: WORKSPACE_ID,
            threadId,
            turnId,
            data: { type: 'turn-completed', stopReason: 'completed', turn: completed },
          });
        }
      );
      const app = createApp({
        agentManifests: [createTestAgentSetup().manifest],
        coreDb,
        dataRoot,
        store,
        turnExecutor: executor,
      });
      const refinement = {
        activePlanItemId: initial.planItem.id,
        taskId: 'task_1',
        reason: 'Run the existing release check against the final packaging.',
        evidenceItemIds: [],
        evidenceArtifactIds: [],
        changedAction: 'Check the final package before reporting the same accepted release result.',
      };
      const requestId = 'req_refined_step';
      const post = (body: Record<string, unknown>) =>
        app.request(`/api/app/workspaces/${WORKSPACE_ID}/threads/${threadId}/goal/step`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      const turnsBefore = store.listThreadTurns(WORKSPACE_ID, threadId).length;
      const stalePlan = await post({
        requestId: 'req_refinement_stale_plan',
        refinement: { ...refinement, activePlanItemId: 'it_not_the_active_plan' },
      });
      expect(stalePlan.status).toBe(409);
      await expect(stalePlan.json()).resolves.toMatchObject({ code: 'stale' });
      const missingEvidence = await post({
        requestId: 'req_refinement_missing_evidence',
        refinement: { ...refinement, evidenceItemIds: ['it_missing_evidence'] },
      });
      expect(missingEvidence.status).toBe(409);
      await expect(missingEvidence.json()).resolves.toMatchObject({ code: 'stale' });
      expect(store.listThreadTurns(WORKSPACE_ID, threadId)).toHaveLength(turnsBefore);
      expect(refinementItemsAtLaunch).toEqual([]);

      const first = await post({ requestId, refinement });
      expect(first.status, await first.clone().text()).toBe(200);
      expect(refinementItemsAtLaunch).toEqual([
        expect.objectContaining({
          type: 'status',
          status: 'completed',
          causationId: requestId,
          summary: expect.stringContaining(refinement.changedAction),
        }),
      ]);
      const refinementItem = refinementItemsAtLaunch[0]!;
      expect(refinementItem.summary).toContain(initial.planItem.id);
      expect(refinementItem.summary).toContain(refinement.taskId);
      expect(refinementItem.summary).toContain(refinement.reason);
      expect(refinementItem.summary).toContain('Evidence Items: none');
      expect(refinementItem.summary).toContain('Evidence Artifacts: none');
      expect(
        store.getCommandRequest(
          'goal.step',
          requestId,
          { actorId: LOCAL_USER_ID, workspaceId: WORKSPACE_ID, threadId },
          workspaceDb
        )?.inputHash
      ).toBe(commandInputHash({ refinement }));
      const itemIdsAfterFirst = store
        .listThreadItems(WORKSPACE_ID, threadId)
        .map((item) => item.id);
      const turnIdsAfterFirst = store
        .listThreadTurns(WORKSPACE_ID, threadId)
        .map((turn) => turn.id);
      const replay = await post({ requestId, refinement });
      expect(replay.status, await replay.clone().text()).toBe(200);
      expect(store.listThreadItems(WORKSPACE_ID, threadId).map((item) => item.id)).toEqual(
        itemIdsAfterFirst
      );
      expect(store.listThreadTurns(WORKSPACE_ID, threadId).map((turn) => turn.id)).toEqual(
        turnIdsAfterFirst
      );
      expect(refinementItemsAtLaunch).toHaveLength(1);
      const changed = await post({
        requestId,
        refinement: { ...refinement, changedAction: 'Perform a different package check.' },
      });
      expect(changed.status).toBe(409);
      await expect(changed.json()).resolves.toMatchObject({ code: 'idempotency_key_conflict' });
      expect(store.listThreadItems(WORKSPACE_ID, threadId).map((item) => item.id)).toEqual(
        itemIdsAfterFirst
      );
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('continues initial planning through a question response and a fresh Plan request', async () => {
    const { dataRoot, store, workspaceDb, threadId } = createPlanningFixture('Clarify Goal Plan');
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
        requestId: 'req_plan_question',
        planner: () => ({
          ...createDeterministicGoalPlanFallback({
            goalTitle: 'Prepare release',
            objective: 'Prepare the release for publication.',
          }),
          questions: ['Which verification command is required?'],
        }),
      });
      expect(question.status).toBe('awaiting_user');
      if (question.status !== 'awaiting_user') return;
      expect(question.questionItem.responsibleUserId).toBe(LOCAL_USER_ID);
      expect(
        getWorkerCheckpoint(workspaceDb, WORKSPACE_ID, threadId, question.questionItem.turnId)
      ).toBeNull();
      expect(getGoalRecord(workspaceDb, WORKSPACE_ID, threadId, GOAL_ID)).toMatchObject({
        status: 'awaiting_user',
        planItemId: null,
        pendingPlanItemId: null,
      });
      const app = createApp({ coreDb, dataRoot, store });
      const answerBody = {
        workspaceId: WORKSPACE_ID,
        threadId,
        turnId: question.questionItem.turnId,
        requestId: '00000000-0000-4000-8000-000000000801',
        answers: { plan_question_1: ['Run the release smoke check.'] },
      };
      const response = await app.request('/api/turns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(answerBody),
      });
      expect(response.ok, await response.clone().text()).toBe(true);
      expect(getGoalRecord(workspaceDb, WORKSPACE_ID, threadId, GOAL_ID)).toMatchObject({
        status: 'planning',
        planItemId: null,
        pendingPlanItemId: null,
      });
      expect(store.getTurn(WORKSPACE_ID, threadId, question.questionItem.turnId)).toMatchObject({
        status: 'completed',
      });
      const answeredItems = () =>
        store
          .listThreadItems(WORKSPACE_ID, threadId)
          .filter(
            (item) =>
              item.turnId === question.questionItem.turnId && item.type === 'user-input-response'
          );
      expect(answeredItems()).toEqual([
        expect.objectContaining({
          causationId: answerBody.requestId,
          userInputRequestId: question.questionItem.userInputRequestId,
          answers: answerBody.answers,
        }),
      ]);
      const replay = await app.request('/api/turns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(answerBody),
      });
      expect(replay.ok, await replay.clone().text()).toBe(true);
      expect(answeredItems()).toHaveLength(1);

      const stale = await app.request('/api/turns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...answerBody,
          requestId: '00000000-0000-4000-8000-000000000802',
        }),
      });
      expect(stale.status).toBe(409);
      expect(answeredItems()).toHaveLength(1);

      const initialPlannerInputs: GoalPlannerInput[] = [];
      const next = await createGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        requestId: 'req_plan_after_answer',
        planner: (input) => {
          initialPlannerInputs.push(input);
          return createDeterministicGoalPlanFallback({
            goalTitle: 'Prepare release',
            objective: 'Prepare the release for publication.',
          });
        },
      });
      expect(next.status).toBe('awaiting_plan_approval');
      if (next.status !== 'awaiting_plan_approval') return;
      expect(initialPlannerInputs[0]?.clarification).toEqual({
        requestItemId: question.questionItem.id,
        responseItemId: answeredItems()[0]!.id,
        questions: [{ id: 'plan_question_1', question: 'Which verification command is required?' }],
        answers: answerBody.answers,
      });
      expect(getGoalRecord(workspaceDb, WORKSPACE_ID, threadId, GOAL_ID)).toMatchObject({
        planItemId: null,
        pendingPlanItemId: next.planItem.id,
      });
      approveGoalPlan({
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        planItemId: next.planItem.id,
      });
      reviseGoalIntent({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        requestId: 'req_revision_needs_answer',
        objective: 'Prepare release with a verified launch window.',
        revision: 'Clarify the launch window before changing the Plan.',
        affectedTaskIds: ['task_1'],
      });
      const revisionQuestion = await createGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        requestId: 'req_revision_question',
        planner: () => ({
          ...next.plan,
          tasks: [{ ...next.plan.tasks[0]!, taskId: 'task_2' }],
          questions: ['Which launch window should the new Plan verify?'],
          taskDispositions: [
            {
              taskId: 'task_1',
              successorTaskId: 'task_2',
              reason: 'Carry release work into the proposed launch-window Task.',
            },
          ],
        }),
      });
      expect(revisionQuestion.status).toBe('awaiting_user');
      if (revisionQuestion.status !== 'awaiting_user') return;
      expect(getGoalRecord(workspaceDb, WORKSPACE_ID, threadId, GOAL_ID)).toMatchObject({
        status: 'running',
        planItemId: next.planItem.id,
        pendingPlanItemId: null,
        currentAffectedTaskIds: ['task_1'],
      });
      const revisionAnswer = await app.request('/api/turns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: WORKSPACE_ID,
          threadId,
          turnId: revisionQuestion.questionItem.turnId,
          requestId: '00000000-0000-4000-8000-000000000803',
          answers: { plan_question_1: ['The Friday maintenance window.'] },
        }),
      });
      expect(revisionAnswer.ok, await revisionAnswer.clone().text()).toBe(true);
      expect(getGoalRecord(workspaceDb, WORKSPACE_ID, threadId, GOAL_ID)).toMatchObject({
        status: 'running',
        planItemId: next.planItem.id,
        pendingPlanItemId: null,
        currentAffectedTaskIds: ['task_1'],
      });
      const revisionPlannerInputs: GoalPlannerInput[] = [];
      const revised = await createGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        requestId: 'req_revision_after_answer',
        planner: (input) => {
          revisionPlannerInputs.push(input);
          return {
            ...next.plan,
            goalSummary: 'Prepare release for the confirmed launch window.',
            tasks: [
              {
                ...next.plan.tasks[0]!,
                taskId: 'task_2',
                title: 'Verify launch window',
                objective: 'Verify the Friday maintenance window.',
              },
            ],
            taskDispositions: [
              {
                taskId: 'task_1',
                successorTaskId: 'task_2',
                reason: 'Carry the remaining release check into the launch-window Task.',
              },
            ],
          };
        },
      });
      expect(revised.status).toBe('awaiting_plan_approval');
      if (revised.status !== 'awaiting_plan_approval') return;
      const revisionResponse = store
        .listThreadItems(WORKSPACE_ID, threadId)
        .find(
          (item) =>
            item.turnId === revisionQuestion.questionItem.turnId &&
            item.type === 'user-input-response'
        );
      expect(revisionPlannerInputs[0]).toMatchObject({
        previousPlanItemId: next.planItem.id,
        clarification: {
          requestItemId: revisionQuestion.questionItem.id,
          responseItemId: revisionResponse?.id,
          questions: [
            {
              id: 'plan_question_1',
              question: 'Which launch window should the new Plan verify?',
            },
          ],
          answers: { plan_question_1: ['The Friday maintenance window.'] },
        },
        sourceTaskEvidence: {
          facts: [{ taskId: 'task_1', status: 'ready', reviews: [] }],
          digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        },
      });
      expect(getGoalRecord(workspaceDb, WORKSPACE_ID, threadId, GOAL_ID)).toMatchObject({
        status: 'running',
        planItemId: next.planItem.id,
        pendingPlanItemId: revised.planItem.id,
        currentAffectedTaskIds: ['task_1'],
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('recovers a complete open planning question after its public receipt was interrupted', async () => {
    const { dataRoot, store, workspaceDb, threadId } = createPlanningFixture(
      'Recover question receipt'
    );
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: LOCAL_USER_ID,
      workspaceId: WORKSPACE_ID,
    });

    try {
      const requestId = 'req_question_receipt_recovery';
      const question = await createGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        requestId,
        planner: () => ({
          ...createDeterministicGoalPlanFallback({
            goalTitle: 'Prepare release',
            objective: 'Prepare the release for publication.',
          }),
          questions: ['Which release window?'],
        }),
      });
      expect(question.status).toBe('awaiting_user');
      if (question.status !== 'awaiting_user') return;
      const turnIdsBefore = store.listThreadTurns(WORKSPACE_ID, threadId).map((turn) => turn.id);
      const itemIdsBefore = store.listThreadItems(WORKSPACE_ID, threadId).map((item) => item.id);
      const app = createApp({ coreDb, dataRoot, store });
      const post = () =>
        app.request(`/api/app/workspaces/${WORKSPACE_ID}/threads/${threadId}/goal/plan`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId }),
        });
      const recovered = await post();
      expect(recovered.status, await recovered.clone().text()).toBe(200);
      await expect(recovered.json()).resolves.toMatchObject({
        status: 'awaiting_user',
        questionItemId: question.questionItem.id,
        goal: { status: 'awaiting_user' },
      });
      expect(getGoalRecord(workspaceDb, WORKSPACE_ID, threadId, GOAL_ID)).toMatchObject({
        planItemId: null,
        pendingPlanItemId: null,
      });
      const planRead = await app.request(
        `/api/app/workspaces/${WORKSPACE_ID}/threads/${threadId}/goal/plan`
      );
      expect(planRead.status).toBe(200);
      await expect(planRead.json()).resolves.toMatchObject({
        activePlanItemId: null,
        pendingPlanItemId: null,
        canApprovePendingPlan: false,
        planningAction: 'answer_question',
      });
      const replay = await post();
      expect(replay.status, await replay.clone().text()).toBe(200);
      await expect(replay.json()).resolves.toMatchObject({
        status: 'awaiting_user',
        questionItemId: question.questionItem.id,
      });
      expect(store.listThreadTurns(WORKSPACE_ID, threadId).map((turn) => turn.id)).toEqual(
        turnIdsBefore
      );
      expect(store.listThreadItems(WORKSPACE_ID, threadId).map((item) => item.id)).toEqual(
        itemIdsBefore
      );
      const competingPlan = await app.request(
        `/api/app/workspaces/${WORKSPACE_ID}/threads/${threadId}/goal/plan`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: 'req_question_gate_bypass' }),
        }
      );
      expect(competingPlan.status).toBe(409);
      expect(store.listThreadTurns(WORKSPACE_ID, threadId).map((turn) => turn.id)).toEqual(
        turnIdsBefore
      );
      expect(store.listThreadItems(WORKSPACE_ID, threadId).map((item) => item.id)).toEqual(
        itemIdsBefore
      );
      const answer = await app.request('/api/turns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: WORKSPACE_ID,
          threadId,
          turnId: question.questionItem.turnId,
          requestId: '00000000-0000-4000-8000-000000000805',
          answers: { plan_question_1: ['Friday'] },
        }),
      });
      expect(answer.ok, await answer.clone().text()).toBe(true);
      const itemIdsAfterAnswer = store
        .listThreadItems(WORKSPACE_ID, threadId)
        .map((item) => item.id);
      const replayAfterAnswer = await post();
      expect(replayAfterAnswer.status, await replayAfterAnswer.clone().text()).toBe(200);
      await expect(replayAfterAnswer.json()).resolves.toMatchObject({
        status: 'awaiting_user',
        questionItemId: question.questionItem.id,
      });
      expect(store.listThreadTurns(WORKSPACE_ID, threadId).map((turn) => turn.id)).toEqual(
        turnIdsBefore
      );
      expect(store.listThreadItems(WORKSPACE_ID, threadId).map((item) => item.id)).toEqual(
        itemIdsAfterAnswer
      );
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('does not carry an answered planning question across a newer intent revision', async () => {
    const { dataRoot, store, workspaceDb, threadId, activePlan } =
      await createApprovedGoalForSourceChange('Older planning answer');
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
        requestId: 'req_old_intent_question',
        planner: () => ({
          ...activePlan,
          tasks: [{ ...activePlan.tasks[0]!, taskId: 'task_2' }],
          taskDispositions: [
            {
              taskId: 'task_1',
              successorTaskId: 'task_2',
              reason: 'Carry release work into the proposed Task.',
            },
          ],
          questions: ['Which release window?'],
        }),
      });
      expect(question.status).toBe('awaiting_user');
      if (question.status !== 'awaiting_user') return;
      const app = createApp({ coreDb, dataRoot, store });
      const answer = await app.request('/api/turns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: WORKSPACE_ID,
          threadId,
          turnId: question.questionItem.turnId,
          requestId: '00000000-0000-4000-8000-000000000804',
          answers: { plan_question_1: ['Friday'] },
        }),
      });
      expect(answer.ok, await answer.clone().text()).toBe(true);
      const responseItem = store
        .listThreadItems(WORKSPACE_ID, threadId)
        .find(
          (item) =>
            item.turnId === question.questionItem.turnId && item.type === 'user-input-response'
        );
      expect(responseItem?.type).toBe('user-input-response');
      const beforeNewIntent = await app.request(
        `/api/app/workspaces/${WORKSPACE_ID}/threads/${threadId}/goal/plan`
      );
      expect(beforeNewIntent.status).toBe(200);
      await expect(beforeNewIntent.json()).resolves.toMatchObject({
        planningAction: 'continue_planning',
        continuePlanning: {
          questionItemId: question.questionItem.id,
          responseItemId: responseItem?.id,
        },
      });

      const newerIntent = reviseGoalIntent({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        requestId: 'req_newer_intent_after_answer',
        objective: 'Prepare a later release with security verification.',
        revision: 'The earlier release-window answer no longer applies.',
        affectedTaskIds: [],
      });
      const afterNewIntent = await app.request(
        `/api/app/workspaces/${WORKSPACE_ID}/threads/${threadId}/goal/plan`
      );
      expect(afterNewIntent.status).toBe(200);
      await expect(afterNewIntent.json()).resolves.toMatchObject({
        planningAction: 'draft_revision',
        continuePlanning: null,
      });
      const planner = vi
        .fn<NonNullable<Parameters<typeof createGoalPlan>[0]['planner']>>()
        .mockImplementation(() => ({
          ...activePlan,
          goalSummary: 'Prepare the later release with security verification.',
          tasks: [{ ...activePlan.tasks[0]!, taskId: 'task_2', title: 'Verify security' }],
          taskDispositions: [
            {
              taskId: 'task_1',
              successorTaskId: 'task_2',
              reason: 'Continue remaining work with security verification.',
            },
          ],
        }));
      const next = await createGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: WORKSPACE_ID,
        threadId,
        goalId: GOAL_ID,
        requestId: 'req_plan_after_newer_intent',
        planner,
      });
      expect(next.status).toBe('awaiting_plan_approval');
      expect(planner).toHaveBeenCalledTimes(1);
      expect(planner.mock.calls[0]?.[0]).toMatchObject({
        goal: { currentIntentItemId: newerIntent.intentItem.id },
        clarification: null,
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('rejects an answer to a planning question from an older intent', async () => {
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
      expect(answer.status).toBe(409);
      expect(store.listThreadItems(WORKSPACE_ID, threadId).map((item) => item.id)).toEqual(
        itemsBeforeAnswer
      );
      expect(store.getTurn(WORKSPACE_ID, threadId, question.questionItem.turnId)).toMatchObject({
        status: 'awaiting_human',
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

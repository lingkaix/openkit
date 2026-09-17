import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import {
  createDeterministicGoalPlanFallback,
  type GoalPlanOutput,
  selectGoalPlanPayload,
} from './goal-plan.js';
import { reviseGoalPlan } from './goal-plan-approval.js';
import {
  createGoalPlan,
  readGoalPlanCreation,
  runExclusiveGoalPlanCommand,
} from './goal-planning.js';
import { createGoalRecord, getGoalPlanRecord, getGoalRecord } from './goal-store.js';

const USER_ACTOR = { kind: 'user', id: 'user_demo' } as const;
const REVISION_INSTRUCTION = 'Split this into two bounded worker tasks.';

/**
 * Builds one reviewable two-task Plan that consumes a prior draft and revision text.
 *
 * @param previous Authoritative previous Plan payload.
 * @param revisionText Recorded human revision instruction.
 * @returns Schema-shaped Plan with a second dependent task.
 */
function revisedTwoTaskPlan(previous: GoalPlanOutput, revisionText: string): GoalPlanOutput {
  const first = previous.tasks[0];
  if (!first) {
    throw new Error('previous Plan has no tasks');
  }
  return {
    ...previous,
    goalSummary: `${previous.goalSummary} Revision: ${revisionText}`,
    assumptions: [
      ...previous.assumptions,
      `Consumes the prior Plan task ${first.taskId} and the recorded revision.`,
    ],
    tasks: [
      first,
      {
        ...first,
        taskId: 'task_2',
        title: 'Apply the requested revision',
        objective: revisionText,
        dependsOnTaskIds: [first.taskId],
      },
    ],
  };
}

/**
 * Opens a migrated workspace database for goal planning tests.
 *
 * @returns Migrated workspace database handles.
 */
function createWorkspaceDb(): WorkspaceDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-goal-planning-'));
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

describe('goal planning path', () => {
  it('stores a successful plan against the goal through one planning path', async () => {
    const workspaceDb = createWorkspaceDb();
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Plan goal thread');

    try {
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_demo',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        title: 'Ship v0.0.6',
        objective: 'Make v0.0.6 ready to publish.',
      });

      const result = await createGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_demo',
        requestId: 'req_goal_plan_create',
      });

      expect(result.status).toBe('awaiting_plan_approval');
      expect(result.plan.tasks).toHaveLength(1);
      expect(store.listThreadItems('ws_demo', thread.id)).toEqual([
        expect.objectContaining({
          id: result.planItem.id,
          causationId: 'req_goal_plan_create',
          type: 'plan',
          status: 'completed',
          title: 'Ship v0.0.6',
          steps: [
            expect.objectContaining({
              id: 'task_1',
              status: 'pending',
            }),
          ],
        }),
      ]);
      expect(getGoalRecord(workspaceDb, 'ws_demo', thread.id, 'goal_demo')).toMatchObject({
        status: 'awaiting_plan_approval',
        planItemId: result.planItem.id,
      });
      expect(
        getGoalPlanRecord(workspaceDb, 'ws_demo', thread.id, result.planItem.id)
      ).toMatchObject({
        goalId: 'goal_demo',
        planItemId: result.planItem.id,
        planDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        createdByRequestId: 'req_goal_plan_create',
        tasks: result.plan.tasks,
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('fails closed when the Goal loses its planning transition fence', async () => {
    const workspaceDb = createWorkspaceDb();
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Plan transition fence thread');

    try {
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_fence',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        title: 'Fence plan creation',
        objective: 'Do not overwrite a newer Goal transition.',
        status: 'failed',
      });

      await expect(
        createGoalPlan({
          triggerActor: USER_ACTOR,
          workspaceDb,
          store,
          workspaceId: 'ws_demo',
          threadId: thread.id,
          goalId: 'goal_fence',
          requestId: 'req_goal_plan_fence',
        })
      ).rejects.toMatchObject({ code: 'recovery_required' });
      expect(
        workspaceDb.sqlite.prepare('SELECT COUNT(*) AS count FROM goal_plan_records').get()
      ).toEqual({ count: 0 });
      expect(() =>
        readGoalPlanCreation({
          triggerActor: USER_ACTOR,
          workspaceDb,
          store,
          workspaceId: 'ws_demo',
          threadId: thread.id,
          requestId: 'req_goal_plan_fence',
        })
      ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('emits bounded elicitation questions when the planner requires user input', async () => {
    const workspaceDb = createWorkspaceDb();
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Question goal thread');

    try {
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_questions',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        title: 'Clarify release',
        objective: 'Make the release ready.',
      });

      const plan = createDeterministicGoalPlanFallback({
        goalTitle: 'Clarify release',
        objective: 'Make the release ready.',
      });
      const result = await createGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_questions',
        requestId: 'req_goal_plan_questions',
        planner: () => ({
          ...plan,
          questions: [
            'Which verification command should be the release gate?',
            'Who should approve the final plan?',
          ],
        }),
      });

      expect(result.status).toBe('awaiting_user');
      expect(result.questionItem).toMatchObject({
        completedAt: expect.any(String),
        responsibleUserId: USER_ACTOR.id,
        status: 'completed',
      });
      expect(result.questionItem.questions).toHaveLength(2);
      expect(result.questionItem.questions[0]).toMatchObject({
        id: 'plan_question_1',
        question: 'Which verification command should be the release gate?',
      });
      expect(getGoalRecord(workspaceDb, 'ws_demo', thread.id, 'goal_questions')).toMatchObject({
        status: 'awaiting_user',
        planItemId: null,
      });
      expect(
        workspaceDb.sqlite.prepare('SELECT COUNT(*) AS count FROM goal_plan_records').get()
      ).toEqual({ count: 0 });
      expect(() =>
        readGoalPlanCreation({
          triggerActor: USER_ACTOR,
          workspaceDb,
          store,
          workspaceId: 'ws_demo',
          threadId: thread.id,
          requestId: 'req_goal_plan_questions',
        })
      ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('fails closed without a responsible user before writing a question or Gate', async () => {
    const workspaceDb = createWorkspaceDb();
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Unassigned question thread');

    try {
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_unassigned_question',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        title: 'Unassigned question',
        objective: 'Require a human without assigning one.',
      });
      const plan = createDeterministicGoalPlanFallback({
        goalTitle: 'Unassigned question',
        objective: 'Require a human without assigning one.',
      });

      await expect(
        createGoalPlan({
          triggerActor: {
            kind: 'system',
            id: 'scheduler',
            responsibleUserId: null,
          },
          workspaceDb,
          store,
          workspaceId: 'ws_demo',
          threadId: thread.id,
          goalId: 'goal_unassigned_question',
          requestId: 'req_goal_plan_unassigned',
          planner: () => ({ ...plan, questions: ['Who should answer?'] }),
        })
      ).rejects.toMatchObject({ code: 'recovery_required' });
      expect(
        store
          .listThreadItems('ws_demo', thread.id)
          .filter((item) => item.type === 'user-input-request')
      ).toEqual([]);
      expect(
        store.listThreadTurns('ws_demo', thread.id).some((turn) => turn.status === 'awaiting_human')
      ).toBe(false);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('turns planner failures into a failed goal state', async () => {
    const workspaceDb = createWorkspaceDb();
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Failing goal thread');

    try {
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_failure',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        title: 'Failing plan',
        objective: 'Trigger planner failure.',
      });

      const result = await createGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_failure',
        requestId: 'req_goal_plan_failure',
        planner: () => {
          throw new Error('planner unavailable');
        },
      });

      expect(result.status).toBe('failed');
      expect(result.errorItem).toMatchObject({
        type: 'status',
        level: 'error',
        title: 'Goal planning failed',
      });
      expect(getGoalRecord(workspaceDb, 'ws_demo', thread.id, 'goal_failure')).toMatchObject({
        status: 'failed',
        terminalStopReason: 'error',
      });
      expect(() =>
        readGoalPlanCreation({
          triggerActor: USER_ACTOR,
          workspaceDb,
          store,
          workspaceId: 'ws_demo',
          threadId: thread.id,
          requestId: 'req_goal_plan_failure',
        })
      ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('does not regenerate the unchanged initial draft after a recorded revision', async () => {
    const workspaceDb = createWorkspaceDb();
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Revise ignored thread');
    const unchangedDraft = createDeterministicGoalPlanFallback({
      goalTitle: 'Ship v0.0.6',
      objective: 'Make v0.0.6 ready to publish.',
    });
    let plannerInput:
      | {
          readonly previousPlan: GoalPlanOutput | undefined;
          readonly previousPlanItemId: string | undefined;
          readonly revisionText: string | undefined;
        }
      | undefined;

    try {
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_revise_ignored',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        title: 'Ship v0.0.6',
        objective: 'Make v0.0.6 ready to publish.',
      });
      const initial = await createGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_revise_ignored',
        requestId: 'req_goal_plan_initial',
      });
      if (initial.status !== 'awaiting_plan_approval') {
        throw new Error(`expected initial plan approval, received ${initial.status}`);
      }
      reviseGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_revise_ignored',
        planItemId: initial.planItem.id,
        requestId: 'req_goal_plan_revise',
        revision: REVISION_INSTRUCTION,
      });

      const after = await createGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_revise_ignored',
        requestId: 'req_goal_plan_after_revise',
        planner: (input) => {
          plannerInput = {
            previousPlan: input.previousPlan,
            previousPlanItemId: input.previousPlanItemId,
            revisionText: input.revisionText,
          };
          if (!input.previousPlan || input.revisionText !== REVISION_INSTRUCTION) {
            return createDeterministicGoalPlanFallback({
              goalTitle: input.goal.title,
              objective: input.goal.objective,
            });
          }
          return revisedTwoTaskPlan(input.previousPlan, input.revisionText);
        },
      });

      expect(after.status).toBe('awaiting_plan_approval');
      expect(selectGoalPlanPayload(initial.plan)).toEqual(unchangedDraft);
      expect(plannerInput).toEqual({
        previousPlan: unchangedDraft,
        previousPlanItemId: initial.planItem.id,
        revisionText: REVISION_INSTRUCTION,
      });
      expect(selectGoalPlanPayload(after.plan)).not.toEqual(unchangedDraft);
      expect(after.plan.tasks.map((task) => task.taskId)).toEqual(['task_1', 'task_2']);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('does not substitute a deterministic draft when a revision planner is omitted', async () => {
    const workspaceDb = createWorkspaceDb();
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Revise omitted planner thread');

    try {
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_revise_omitted',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        title: 'Ship v0.0.6',
        objective: 'Make v0.0.6 ready to publish.',
      });
      const initial = await createGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_revise_omitted',
        requestId: 'req_goal_plan_omitted_initial',
      });
      if (initial.status !== 'awaiting_plan_approval') {
        throw new Error(`expected initial plan approval, received ${initial.status}`);
      }
      const initialPlanItemId = initial.planItem.id;
      reviseGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_revise_omitted',
        planItemId: initialPlanItemId,
        requestId: 'req_goal_plan_omitted_revise',
        revision: REVISION_INSTRUCTION,
      });

      await expect(
        createGoalPlan({
          triggerActor: USER_ACTOR,
          workspaceDb,
          store,
          workspaceId: 'ws_demo',
          threadId: thread.id,
          goalId: 'goal_revise_omitted',
          requestId: 'req_goal_plan_omitted_create',
        })
      ).rejects.toMatchObject({
        name: 'GoalPlanRevisionError',
        code: 'goal_plan_revision_unavailable',
      });
      expect(getGoalRecord(workspaceDb, 'ws_demo', thread.id, 'goal_revise_omitted')).toMatchObject(
        {
          status: 'planning',
          planItemId: null,
          terminalStopReason: null,
        }
      );
      expect(getGoalPlanRecord(workspaceDb, 'ws_demo', thread.id, initialPlanItemId)).toMatchObject(
        {
          createdByRequestId: 'req_goal_plan_omitted_initial',
          tasks: [{ taskId: 'task_1' }],
        }
      );
      expect(
        store
          .listThreadItems('ws_demo', thread.id)
          .some(
            (item) =>
              item.type === 'user-message' &&
              item.parentItemId === initialPlanItemId &&
              item.text === REVISION_INSTRUCTION
          )
      ).toBe(true);
      expect(
        store
          .listThreadItems('ws_demo', thread.id)
          .filter((item) => item.type === 'plan' && item.id !== initialPlanItemId)
      ).toEqual([]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('creates a revised Plan from the exact prior Plan and recorded instruction', async () => {
    const workspaceDb = createWorkspaceDb();
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Revise consume thread');
    const seen: Array<{
      readonly previousPlan: GoalPlanOutput | undefined;
      readonly previousPlanItemId: string | undefined;
      readonly revisionText: string | undefined;
    }> = [];

    try {
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_revise_consume',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        title: 'Ship v0.0.6',
        objective: 'Make v0.0.6 ready to publish.',
      });
      const initial = await createGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_revise_consume',
        requestId: 'req_goal_plan_consume_initial',
      });
      if (initial.status !== 'awaiting_plan_approval') {
        throw new Error(`expected initial plan approval, received ${initial.status}`);
      }
      reviseGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_revise_consume',
        planItemId: initial.planItem.id,
        requestId: 'req_goal_plan_consume_revise',
        revision: REVISION_INSTRUCTION,
      });

      const revised = await createGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_revise_consume',
        requestId: 'req_goal_plan_consume_create',
        planner: (input) => {
          seen.push({
            previousPlan: input.previousPlan,
            previousPlanItemId: input.previousPlanItemId,
            revisionText: input.revisionText,
          });
          if (!input.previousPlan) {
            throw new Error('missing previous Plan');
          }
          return revisedTwoTaskPlan(input.previousPlan, input.revisionText ?? '');
        },
      });

      expect(seen).toEqual([
        {
          previousPlan: selectGoalPlanPayload(initial.plan),
          previousPlanItemId: initial.planItem.id,
          revisionText: REVISION_INSTRUCTION,
        },
      ]);
      expect(revised.status).toBe('awaiting_plan_approval');
      expect(revised.plan.tasks.map((task) => task.taskId)).toEqual(['task_1', 'task_2']);
      expect(revised.plan.tasks[1]).toMatchObject({
        objective: REVISION_INSTRUCTION,
        dependsOnTaskIds: ['task_1'],
      });
      expect(revised.planItem.id).not.toBe(initial.planItem.id);
      expect(getGoalRecord(workspaceDb, 'ws_demo', thread.id, 'goal_revise_consume')).toMatchObject(
        {
          status: 'awaiting_plan_approval',
          planItemId: revised.planItem.id,
        }
      );
      expect(
        getGoalPlanRecord(workspaceDb, 'ws_demo', thread.id, initial.planItem.id)
      ).toMatchObject({
        createdByRequestId: 'req_goal_plan_consume_initial',
        tasks: [{ taskId: 'task_1' }],
      });
      expect(
        getGoalPlanRecord(workspaceDb, 'ws_demo', thread.id, revised.planItem.id)
      ).toMatchObject({
        createdByRequestId: 'req_goal_plan_consume_create',
        tasks: [{ taskId: 'task_1' }, { taskId: 'task_2' }],
      });
      expect(
        readGoalPlanCreation({
          triggerActor: USER_ACTOR,
          workspaceDb,
          store,
          workspaceId: 'ws_demo',
          threadId: thread.id,
          requestId: 'req_goal_plan_consume_create',
        })
      ).toMatchObject({
        goalId: 'goal_revise_consume',
        planItem: { id: revised.planItem.id },
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('preserves recoverable revision owners when the semantic planner fails', async () => {
    const workspaceDb = createWorkspaceDb();
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Revise fail thread');

    try {
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_revise_fail',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        title: 'Ship v0.0.6',
        objective: 'Make v0.0.6 ready to publish.',
      });
      const initial = await createGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_revise_fail',
        requestId: 'req_goal_plan_fail_initial',
      });
      if (initial.status !== 'awaiting_plan_approval') {
        throw new Error(`expected initial plan approval, received ${initial.status}`);
      }
      reviseGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_revise_fail',
        planItemId: initial.planItem.id,
        requestId: 'req_goal_plan_fail_revise',
        revision: REVISION_INSTRUCTION,
      });

      await expect(
        createGoalPlan({
          triggerActor: USER_ACTOR,
          workspaceDb,
          store,
          workspaceId: 'ws_demo',
          threadId: thread.id,
          goalId: 'goal_revise_fail',
          requestId: 'req_goal_plan_fail_create',
          planner: () => {
            throw new Error('model unavailable');
          },
        })
      ).rejects.toMatchObject({
        name: 'GoalPlanRevisionError',
        code: 'goal_plan_revision_unavailable',
      });
      expect(getGoalRecord(workspaceDb, 'ws_demo', thread.id, 'goal_revise_fail')).toMatchObject({
        status: 'planning',
        planItemId: null,
        terminalStopReason: null,
      });
      expect(getGoalPlanRecord(workspaceDb, 'ws_demo', thread.id, initial.planItem.id)).not.toBe(
        null
      );
      expect(
        store.listThreadItems('ws_demo', thread.id).filter((item) => item.type === 'status')
      ).toEqual([]);
      expect(() =>
        readGoalPlanCreation({
          triggerActor: USER_ACTOR,
          workspaceDb,
          store,
          workspaceId: 'ws_demo',
          threadId: thread.id,
          requestId: 'req_goal_plan_fail_create',
        })
      ).not.toThrow();
      expect(
        readGoalPlanCreation({
          triggerActor: USER_ACTOR,
          workspaceDb,
          store,
          workspaceId: 'ws_demo',
          threadId: thread.id,
          requestId: 'req_goal_plan_fail_create',
        })
      ).toBeNull();
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('keeps the planning fence after a successful revision create', async () => {
    const workspaceDb = createWorkspaceDb();
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Revise fence thread');

    try {
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_revise_fence',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        title: 'Ship v0.0.6',
        objective: 'Make v0.0.6 ready to publish.',
      });
      const initial = await createGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_revise_fence',
        requestId: 'req_goal_plan_fence_initial',
      });
      if (initial.status !== 'awaiting_plan_approval') {
        throw new Error(`expected initial plan approval, received ${initial.status}`);
      }
      reviseGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_revise_fence',
        planItemId: initial.planItem.id,
        requestId: 'req_goal_plan_fence_revise',
        revision: REVISION_INSTRUCTION,
      });
      const revised = await createGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_revise_fence',
        requestId: 'req_goal_plan_fence_create',
        planner: (input) => revisedTwoTaskPlan(input.previousPlan!, input.revisionText ?? ''),
      });
      if (revised.status !== 'awaiting_plan_approval') {
        throw new Error(`expected revised plan approval, received ${revised.status}`);
      }

      await expect(
        createGoalPlan({
          triggerActor: USER_ACTOR,
          workspaceDb,
          store,
          workspaceId: 'ws_demo',
          threadId: thread.id,
          goalId: 'goal_revise_fence',
          requestId: 'req_goal_plan_fence_second',
          planner: () =>
            createDeterministicGoalPlanFallback({
              goalTitle: 'Ship v0.0.6',
              objective: 'Make v0.0.6 ready to publish.',
            }),
        })
      ).rejects.toMatchObject({ code: 'recovery_required' });
      expect(getGoalRecord(workspaceDb, 'ws_demo', thread.id, 'goal_revise_fence')).toMatchObject({
        planItemId: revised.planItem.id,
        status: 'awaiting_plan_approval',
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rejects a revision proposal that is not an approvable draft', async () => {
    const workspaceDb = createWorkspaceDb();
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Revise questions thread');

    try {
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_revise_questions',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        title: 'Ship v0.0.6',
        objective: 'Make v0.0.6 ready to publish.',
      });
      const initial = await createGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_revise_questions',
        requestId: 'req_goal_plan_questions_initial',
      });
      if (initial.status !== 'awaiting_plan_approval') {
        throw new Error(`expected initial plan approval, received ${initial.status}`);
      }
      reviseGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_revise_questions',
        planItemId: initial.planItem.id,
        requestId: 'req_goal_plan_questions_revise',
        revision: REVISION_INSTRUCTION,
      });

      await expect(
        createGoalPlan({
          triggerActor: USER_ACTOR,
          workspaceDb,
          store,
          workspaceId: 'ws_demo',
          threadId: thread.id,
          goalId: 'goal_revise_questions',
          requestId: 'req_goal_plan_questions_create',
          planner: (input) => ({
            ...revisedTwoTaskPlan(input.previousPlan!, input.revisionText ?? ''),
            questions: ['Who should own the second task?'],
          }),
        })
      ).rejects.toMatchObject({
        name: 'GoalPlanRevisionError',
        code: 'goal_plan_revision_invalid',
      });
      expect(
        getGoalRecord(workspaceDb, 'ws_demo', thread.id, 'goal_revise_questions')
      ).toMatchObject({
        status: 'planning',
        planItemId: null,
        terminalStopReason: null,
      });
      expect(
        store
          .listThreadItems('ws_demo', thread.id)
          .filter((item) => item.type === 'user-input-request')
      ).toEqual([]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rejects a byte-identical previous draft as a revision success', async () => {
    const workspaceDb = createWorkspaceDb();
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Revise identical thread');

    try {
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_revise_identical',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        title: 'Ship v0.0.6',
        objective: 'Make v0.0.6 ready to publish.',
      });
      const initial = await createGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_revise_identical',
        requestId: 'req_goal_plan_identical_initial',
      });
      if (initial.status !== 'awaiting_plan_approval') {
        throw new Error(`expected initial plan approval, received ${initial.status}`);
      }
      reviseGoalPlan({
        triggerActor: USER_ACTOR,
        workspaceDb,
        store,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_revise_identical',
        planItemId: initial.planItem.id,
        requestId: 'req_goal_plan_identical_revise',
        revision: REVISION_INSTRUCTION,
      });

      await expect(
        createGoalPlan({
          triggerActor: USER_ACTOR,
          workspaceDb,
          store,
          workspaceId: 'ws_demo',
          threadId: thread.id,
          goalId: 'goal_revise_identical',
          requestId: 'req_goal_plan_identical_create',
          planner: (input) => input.previousPlan!,
        })
      ).rejects.toMatchObject({
        name: 'GoalPlanRevisionError',
        code: 'goal_plan_revision_invalid',
      });
      expect(
        getGoalRecord(workspaceDb, 'ws_demo', thread.id, 'goal_revise_identical')
      ).toMatchObject({
        status: 'planning',
        planItemId: null,
      });
      expect(
        store.listThreadItems('ws_demo', thread.id).filter((item) => item.type === 'plan')
      ).toHaveLength(1);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it.each([
    { actorId: USER_ACTOR.id, requestId: 'req_lock_b' },
    { actorId: 'another_user', requestId: 'req_lock_a' },
  ])('rejects another in-flight Plan command for the same Goal: %j', async (other) => {
    const store = createDemoStore();
    const inflightCommands = new WeakMap<
      typeof store,
      Map<string, { inputHash: string; promise: Promise<unknown> }>
    >();
    let release!: () => void;
    const first = runExclusiveGoalPlanCommand({
      inflightCommands,
      store,
      workspaceId: 'ws_demo',
      threadId: 'th_lock',
      actorId: USER_ACTOR.id,
      goalId: 'goal_lock',
      requestId: 'req_lock_a',
      run: () =>
        new Promise<string>((resolve) => {
          release = () => {
            resolve('first');
          };
        }),
    });
    await Promise.resolve();
    await expect(
      runExclusiveGoalPlanCommand({
        inflightCommands,
        store,
        workspaceId: 'ws_demo',
        threadId: 'th_lock',
        actorId: other.actorId,
        goalId: 'goal_lock',
        requestId: other.requestId,
        run: async () => 'second',
      })
    ).rejects.toMatchObject({ code: 'stale' });
    release();
    await expect(first).resolves.toBe('first');
  });

  it('coalesces the same in-flight Plan requestId for one Goal', async () => {
    const store = createDemoStore();
    const inflightCommands = new WeakMap<
      typeof store,
      Map<string, { inputHash: string; promise: Promise<unknown> }>
    >();
    let runs = 0;
    let release!: () => void;
    const run = () =>
      new Promise<string>((resolve) => {
        runs += 1;
        release = () => {
          resolve('shared');
        };
      });
    const first = runExclusiveGoalPlanCommand({
      inflightCommands,
      store,
      workspaceId: 'ws_demo',
      threadId: 'th_lock',
      actorId: USER_ACTOR.id,
      goalId: 'goal_lock',
      requestId: 'req_lock_same',
      run,
    });
    await Promise.resolve();
    const second = runExclusiveGoalPlanCommand({
      inflightCommands,
      store,
      workspaceId: 'ws_demo',
      threadId: 'th_lock',
      actorId: USER_ACTOR.id,
      goalId: 'goal_lock',
      requestId: 'req_lock_same',
      run,
    });
    release();
    await expect(Promise.all([first, second])).resolves.toEqual(['shared', 'shared']);
    expect(runs).toBe(1);
  });
});

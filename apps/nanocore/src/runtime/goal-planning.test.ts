import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { createDeterministicGoalPlanFallback } from './goal-plan.js';
import { createGoalPlan, readGoalPlanCreation } from './goal-planning.js';
import { createGoalRecord, getGoalPlanRecord, getGoalRecord } from './goal-store.js';

const USER_ACTOR = { kind: 'user', id: 'user_demo' } as const;

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
});

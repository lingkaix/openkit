import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { createDeterministicGoalPlanFallback } from './goal-plan.js';
import { createGoalRecord, listGoalTasks } from './goal-store.js';
import { persistApprovedGoalTasks } from './goal-task-persistence.js';

/**
 * Opens a migrated workspace database for goal task persistence tests.
 *
 * @returns Migrated workspace database handles.
 */
function createWorkspaceDb(): WorkspaceDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-goal-task-persistence-'));
  const workspaceDb = openWorkspaceDb(dataRoot, 'user_demo', 'ws_demo');
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

describe('approved goal task persistence', () => {
  it('persists approved plan tasks with order and dependency-derived statuses', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_tasks',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        title: 'Persist tasks',
        objective: 'Persist the approved task list.',
      });
      const firstTaskPlan = createDeterministicGoalPlanFallback({
        goalTitle: 'Persist tasks',
        objective: 'Persist the approved task list.',
      });
      const plan = {
        ...firstTaskPlan,
        tasks: [
          firstTaskPlan.tasks[0],
          {
            ...firstTaskPlan.tasks[0],
            taskId: 'task_2',
            title: 'Verify persisted tasks',
            dependsOnTaskIds: ['task_1'],
          },
        ],
      };

      const result = persistApprovedGoalTasks({
        workspaceDb,
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_tasks',
        plan,
      });

      expect(result.tasks.map((task) => ({ taskId: task.taskId, status: task.status }))).toEqual([
        { taskId: 'task_1', status: 'ready' },
        { taskId: 'task_2', status: 'pending' },
      ]);
      expect(
        listGoalTasks(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_tasks',
        }).map((task) => ({
          taskId: task.taskId,
          orderIndex: task.orderIndex,
          dependsOnTaskIds: task.dependsOnTaskIds,
          status: task.status,
          verificationChecks: task.verificationChecks,
        }))
      ).toEqual([
        {
          taskId: 'task_1',
          orderIndex: 0,
          dependsOnTaskIds: [],
          status: 'ready',
          verificationChecks: firstTaskPlan.tasks[0].verificationChecks,
        },
        {
          taskId: 'task_2',
          orderIndex: 1,
          dependsOnTaskIds: ['task_1'],
          status: 'pending',
          verificationChecks: firstTaskPlan.tasks[0].verificationChecks,
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('persists local goal and task ids independently for separate threads', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      for (const threadId of ['th_alpha', 'th_beta']) {
        createGoalRecord(workspaceDb, {
          workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
          goalId: 'goal_1',
          workspaceId: 'ws_demo',
          threadId,
          title: `Persist tasks for ${threadId}`,
          objective: `Persist the approved task list for ${threadId}.`,
        });

        const plan = createDeterministicGoalPlanFallback({
          goalTitle: `Persist tasks for ${threadId}`,
          objective: `Persist the approved task list for ${threadId}.`,
        });

        persistApprovedGoalTasks({
          workspaceDb,
          workspaceId: 'ws_demo',
          threadId,
          goalId: 'goal_1',
          plan,
        });
      }

      expect(
        listGoalTasks(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_alpha',
          goalId: 'goal_1',
        }).map((task) => ({ taskId: task.taskId, status: task.status }))
      ).toEqual([{ taskId: 'task_1', status: 'ready' }]);
      expect(
        listGoalTasks(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_beta',
          goalId: 'goal_1',
        }).map((task) => ({ taskId: task.taskId, status: task.status }))
      ).toEqual([{ taskId: 'task_1', status: 'ready' }]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rejects invalid dependency references before writing goal tasks', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_bad_dep',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        title: 'Reject dependencies',
        objective: 'Reject invalid dependencies.',
      });
      const plan = createDeterministicGoalPlanFallback({
        goalTitle: 'Reject dependencies',
        objective: 'Reject invalid dependencies.',
      });

      expect(() =>
        persistApprovedGoalTasks({
          workspaceDb,
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_bad_dep',
          plan: {
            ...plan,
            tasks: [
              {
                ...plan.tasks[0],
                dependsOnTaskIds: ['task_missing'],
              },
            ],
          },
        })
      ).toThrow('Plan task task_1 depends on missing task task_missing.');
      expect(
        listGoalTasks(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_bad_dep',
        })
      ).toEqual([]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import {
  createGoalRecord,
  createGoalTask,
  getGoalRecord,
  listGoalRecordsForThread,
  listGoalTasks,
  reserveGoalTaskForWorkerTurn,
  updateGoalStatus,
  updateGoalTask,
} from './goal-store.js';

/**
 * Opens a migrated workspace database for goal store tests.
 *
 * @returns Migrated workspace database handle.
 */
function createWorkspaceDb(): WorkspaceDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-goal-store-'));
  const workspaceDb = openWorkspaceDb(dataRoot, 'user_demo', 'ws_demo');
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

/**
 * Creates complete immutable execution facts for one direct Goal Task store fixture.
 *
 * @returns Production-shaped Goal Task execution fields.
 */
function goalTaskExecutionFields() {
  return {
    planItemId: 'it_goal_plan_demo',
    resources: [
      {
        kind: 'repository' as const,
        reference: 'repo_default',
        reason: 'Use the linked workspace repository.',
      },
    ],
    expectedArtifacts: [
      {
        kind: 'test-result' as const,
        description: 'Focused verification result.',
      },
    ],
    verificationChecks: [
      {
        kind: 'test' as const,
        description: 'Run focused tests.',
        command: 'pnpm test',
      },
    ],
    reviewPolicy: {
      required: true,
      reviewers: ['human'] as const,
      instructions: 'Review the focused task evidence.',
    },
    escalationConditions: ['Escalate when the repository is unavailable.'],
  };
}

describe('goal store', () => {
  it('creates, reads, lists, and updates goals', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      const goal = createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_demo',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        title: 'Ship release',
        objective: 'Make v0.0.6 ready for release.',
        createdByItemId: 'item_objective',
        now: () => '2026-05-31T00:00:00.000Z',
      });

      expect(goal).toMatchObject({
        goalId: 'goal_demo',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        status: 'planning',
        title: 'Ship release',
        objective: 'Make v0.0.6 ready for release.',
        createdByItemId: 'item_objective',
        planItemId: null,
        currentTaskId: null,
        terminalStopReason: null,
        createdAt: '2026-05-31T00:00:00.000Z',
        updatedAt: '2026-05-31T00:00:00.000Z',
      });
      expect(getGoalRecord(workspaceDb, 'ws_demo', 'th_demo', 'goal_demo')).toEqual(goal);
      expect(
        listGoalRecordsForThread(workspaceDb, { workspaceId: 'ws_demo', threadId: 'th_demo' })
      ).toEqual([goal]);

      const updated = updateGoalStatus(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        status: 'running',
        currentTaskId: 'task_demo',
        planItemId: 'item_plan',
        now: () => '2026-05-31T00:05:00.000Z',
      });

      expect(updated).toMatchObject({
        status: 'running',
        currentTaskId: 'task_demo',
        planItemId: 'item_plan',
        updatedAt: '2026-05-31T00:05:00.000Z',
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('records an audit event when a goal is created', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_audit',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        title: 'Ship release',
        objective: 'Make v0.0.6 ready for release.',
        createdByItemId: 'item_objective',
        now: () => '2026-05-31T00:00:00.000Z',
      });

      expect(
        workspaceDb.sqlite
          .prepare(
            `SELECT action, category, outcome, severity, resource, thread_id, item_id, summary
            FROM audit_events`
          )
          .all()
      ).toEqual([
        {
          action: 'goal.create',
          category: 'system',
          item_id: 'item_objective',
          outcome: 'succeeded',
          resource: 'goal:goal_audit',
          severity: 'info',
          summary: 'Goal created.',
          thread_id: 'th_demo',
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('records an audit event when a goal status changes', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_status_audit',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        title: 'Ship release',
        objective: 'Make v0.0.6 ready for release.',
        now: () => '2026-05-31T00:00:00.000Z',
      });
      updateGoalStatus(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_status_audit',
        status: 'planning',
        planItemId: 'item_plan',
        now: () => '2026-05-31T00:01:00.000Z',
      });
      expect(
        workspaceDb.sqlite
          .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'goal.status.update'")
          .get()
      ).toEqual({ count: 0 });

      updateGoalStatus(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_status_audit',
        status: 'running',
        currentTaskId: 'task_demo',
        now: () => '2026-05-31T00:02:00.000Z',
      });

      expect(
        workspaceDb.sqlite
          .prepare(
            `SELECT action, category, outcome, severity, resource, thread_id, summary
            FROM audit_events
            WHERE action = 'goal.status.update'`
          )
          .all()
      ).toEqual([
        {
          action: 'goal.status.update',
          category: 'system',
          outcome: 'succeeded',
          resource: 'goal:goal_status_audit',
          severity: 'info',
          summary: 'Goal status changed: planning -> running',
          thread_id: 'th_demo',
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('reserves one ready task only while its exact goal remains runnable', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_reservation',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        title: 'Reserve task',
        objective: 'Fence one Goal task reservation.',
        status: 'paused',
      });
      createGoalTask(workspaceDb, {
        ...goalTaskExecutionFields(),
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_reservation',
        taskId: 'task_ready',
        title: 'Ready task',
        objective: 'Run only after a fenced reservation.',
        orderIndex: 0,
        dependsOnTaskIds: [],
        acceptanceCriteria: ['The reservation is atomic.'],
        contextBudgetTokens: 8000,
        status: 'ready',
      });
      createGoalTask(workspaceDb, {
        ...goalTaskExecutionFields(),
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_reservation',
        taskId: 'task_later',
        title: 'Later ready task',
        objective: 'Wait until the first ready task finishes.',
        orderIndex: 1,
        dependsOnTaskIds: [],
        acceptanceCriteria: ['Stable ready order is preserved.'],
        contextBudgetTokens: 8000,
        status: 'ready',
      });
      const input = {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_reservation',
        taskId: 'task_ready',
      };

      expect(reserveGoalTaskForWorkerTurn(workspaceDb, input)).toBe(false);
      expect(listGoalTasks(workspaceDb, input)[0]?.status).toBe('ready');

      updateGoalStatus(workspaceDb, { ...input, status: 'running' });
      expect(reserveGoalTaskForWorkerTurn(workspaceDb, { ...input, taskId: 'task_later' })).toBe(
        false
      );
      expect(reserveGoalTaskForWorkerTurn(workspaceDb, input)).toBe(true);
      expect(getGoalRecord(workspaceDb, 'ws_demo', 'th_demo', 'goal_reservation')).toMatchObject({
        currentTaskId: 'task_ready',
        status: 'running',
      });
      expect(listGoalTasks(workspaceDb, input)[0]?.status).toBe('running');
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('creates, lists, and updates goal tasks in deterministic order', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_demo',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        title: 'Ship release',
        objective: 'Make v0.0.6 ready for release.',
        now: () => '2026-05-31T00:00:00.000Z',
      });

      createGoalTask(workspaceDb, {
        ...goalTaskExecutionFields(),
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_later',
        title: 'Later',
        objective: 'Run final verification.',
        orderIndex: 2,
        dependsOnTaskIds: ['task_first'],
        acceptanceCriteria: ['Verification passes.'],
        contextBudgetTokens: 8000,
        now: () => '2026-05-31T00:02:00.000Z',
      });
      const first = createGoalTask(workspaceDb, {
        ...goalTaskExecutionFields(),
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_first',
        title: 'First',
        objective: 'Implement the helper.',
        orderIndex: 1,
        dependsOnTaskIds: [],
        acceptanceCriteria: ['Helper tests pass.'],
        contextBudgetTokens: 6000,
        now: () => '2026-05-31T00:01:00.000Z',
      });

      expect(first).toMatchObject({
        taskId: 'task_first',
        goalId: 'goal_demo',
        status: 'pending',
        orderIndex: 1,
        dependsOnTaskIds: [],
        acceptanceCriteria: ['Helper tests pass.'],
        contextBudgetTokens: 6000,
        planItemId: 'it_goal_plan_demo',
        resources: goalTaskExecutionFields().resources,
        expectedArtifacts: goalTaskExecutionFields().expectedArtifacts,
        reviewPolicy: goalTaskExecutionFields().reviewPolicy,
        escalationConditions: goalTaskExecutionFields().escalationConditions,
      });
      expect(
        listGoalTasks(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_demo',
        }).map((task) => task.taskId)
      ).toEqual(['task_first', 'task_later']);

      const updated = updateGoalTask(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_later',
        status: 'ready',
        now: () => '2026-05-31T00:10:00.000Z',
      });

      expect(updated).toMatchObject({
        status: 'ready',
        orderIndex: 2,
        updatedAt: '2026-05-31T00:10:00.000Z',
      });
      expect(
        listGoalTasks(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_demo',
        }).map((task) => task.taskId)
      ).toEqual(['task_first', 'task_later']);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('records an audit event when a goal task is created', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_demo',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        title: 'Ship release',
        objective: 'Make v0.0.6 ready for release.',
        now: () => '2026-05-31T00:00:00.000Z',
      });
      createGoalTask(workspaceDb, {
        ...goalTaskExecutionFields(),
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_audit',
        title: 'Verify task',
        objective: 'Run focused verification.',
        orderIndex: 1,
        dependsOnTaskIds: [],
        acceptanceCriteria: ['Verification passes.'],
        contextBudgetTokens: 8000,
        now: () => '2026-05-31T00:01:00.000Z',
      });

      expect(
        workspaceDb.sqlite
          .prepare(
            `SELECT action, category, outcome, severity, resource, thread_id, summary
            FROM audit_events
            WHERE action = 'goal.task.create'`
          )
          .all()
      ).toEqual([
        {
          action: 'goal.task.create',
          category: 'system',
          outcome: 'succeeded',
          resource: 'goal-task:task_audit',
          severity: 'info',
          summary: 'Goal task created.',
          thread_id: 'th_demo',
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('records an audit event when a goal task status changes', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_demo',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        title: 'Ship release',
        objective: 'Make v0.0.6 ready for release.',
        now: () => '2026-05-31T00:00:00.000Z',
      });
      createGoalTask(workspaceDb, {
        ...goalTaskExecutionFields(),
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_status_audit',
        title: 'Verify task',
        objective: 'Run focused verification.',
        orderIndex: 1,
        dependsOnTaskIds: [],
        acceptanceCriteria: ['Verification passes.'],
        contextBudgetTokens: 8000,
        now: () => '2026-05-31T00:01:00.000Z',
      });
      updateGoalTask(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_status_audit',
        status: 'pending',
        now: () => '2026-05-31T00:02:00.000Z',
      });
      expect(
        workspaceDb.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'goal.task.status.update'"
          )
          .get()
      ).toEqual({ count: 0 });

      updateGoalTask(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_status_audit',
        status: 'running',
        now: () => '2026-05-31T00:03:00.000Z',
      });

      expect(
        workspaceDb.sqlite
          .prepare(
            `SELECT action, category, outcome, severity, resource, thread_id, summary
            FROM audit_events
            WHERE action = 'goal.task.status.update'`
          )
          .all()
      ).toEqual([
        {
          action: 'goal.task.status.update',
          category: 'system',
          outcome: 'succeeded',
          resource: 'goal-task:task_status_audit',
          severity: 'info',
          summary: 'Goal task status changed: pending -> running',
          thread_id: 'th_demo',
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rejects invalid goal and task ownership', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      expect(() =>
        createGoalRecord(workspaceDb, {
          workspaceExists: () => false,
          goalId: 'goal_missing',
          workspaceId: 'ws_missing',
          threadId: 'th_demo',
          title: 'Missing workspace',
          objective: 'This should fail.',
        })
      ).toThrow('Workspace not found: ws_missing');

      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_demo',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        title: 'Ship release',
        objective: 'Make v0.0.6 ready for release.',
      });

      expect(() =>
        createGoalTask(workspaceDb, {
          ...goalTaskExecutionFields(),
          workspaceId: 'ws_other',
          threadId: 'th_demo',
          goalId: 'goal_demo',
          taskId: 'task_wrong_workspace',
          title: 'Wrong workspace',
          objective: 'This should fail.',
          orderIndex: 1,
          dependsOnTaskIds: [],
          acceptanceCriteria: ['Should not persist.'],
          contextBudgetTokens: 1000,
        })
      ).toThrow('Goal not found: ws_other/th_demo/goal_demo');
      expect(() =>
        updateGoalTask(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_other',
          goalId: 'goal_demo',
          taskId: 'task_missing',
          status: 'ready',
        })
      ).toThrow('Goal not found: ws_demo/th_other/goal_demo');
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});

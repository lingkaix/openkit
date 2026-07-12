import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { getGoalSteeringReadModel, recordActiveGoalSteering } from './goal-steering.js';
import { createGoalRecord, updateGoalStatus } from './goal-store.js';
import { listPendingUserTurns } from './pending-user-turns.js';

/**
 * Opens a migrated workspace database for goal steering tests.
 *
 * @returns Migrated workspace database handles.
 */
function createWorkspaceDb(): WorkspaceDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-goal-steering-'));
  const workspaceDb = openWorkspaceDb(dataRoot, 'user_demo', 'ws_demo');
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

/**
 * Creates one goal in the requested status.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param status Goal status to store.
 */
function seedGoal(
  workspaceDb: WorkspaceDb,
  status: Parameters<typeof createGoalRecord>[1]['status']
): void {
  createGoalRecord(workspaceDb, {
    workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
    goalId: 'goal_demo',
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    title: 'Steer goal',
    objective: 'Apply user steering safely.',
    status,
  });
}

describe('goal steering', () => {
  it('stores active user input as safe-point steering while a goal is running', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      seedGoal(workspaceDb, 'running');

      const result = recordActiveGoalSteering(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        requestId: 'req_steer',
        contentItemId: 'item_steer',
        now: () => '2026-05-31T00:00:00.000Z',
      });

      expect(result).toMatchObject({
        state: 'pending_steering',
        pendingTurn: {
          requestId: 'req_steer',
          contentItemId: 'item_steer',
          queueMode: 'safe_point_steering',
        },
      });
      expect(
        listPendingUserTurns(workspaceDb, { workspaceId: 'ws_demo', threadId: 'th_demo' })
      ).toHaveLength(1);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('stores user input as pending follow-up while a goal is awaiting human input', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      seedGoal(workspaceDb, 'awaiting_user');

      const result = recordActiveGoalSteering(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        requestId: 'req_follow',
        contentItemId: 'item_follow',
      });

      expect(result).toMatchObject({
        state: 'pending_follow_up',
        pendingTurn: {
          requestId: 'req_follow',
          contentItemId: 'item_follow',
          queueMode: 'follow_up',
        },
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('summarizes pending and applied steering for a thread read model', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      seedGoal(workspaceDb, 'running');
      recordActiveGoalSteering(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        requestId: 'req_steer',
        contentItemId: 'item_steer',
      });
      updateGoalStatus(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        status: 'awaiting_user',
      });
      recordActiveGoalSteering(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        requestId: 'req_follow',
        contentItemId: 'item_follow',
      });

      expect(
        getGoalSteeringReadModel(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          appliedSteeringCount: 2,
        })
      ).toEqual({
        appliedSteeringCount: 2,
        pendingFollowUpCount: 1,
        pendingSteeringCount: 1,
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ItemSchema } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { upsertWorkspaceRepositoryResource } from '../workspace/repository-store.js';
import { createGoalRecord, createGoalTask } from './goal-store.js';
import { prepareGoalTaskDelegation } from './goal-task-delegation.js';
import { enqueueFollowUpInput, enqueueSteeringForSafePoint } from './user-turn-queues.js';

type Item = z.infer<typeof ItemSchema>;

/**
 * Opens a migrated Core database for goal task delegation tests.
 *
 * @returns Migrated Core database handles.
 */
function createCoreDb(): CoreDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-goal-task-delegation-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  return coreDb;
}

/**
 * Adds a ready repository to one workspace.
 *
 * @param coreDb Open Core database handles.
 * @param workspaceId Workspace id that owns the repository.
 * @param userId User id that owns the workspace database.
 */
function addReadyRepository(coreDb: CoreDb, workspaceId: string, userId = 'user_local'): void {
  const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-goal-task-delegation-repo-'));
  mkdirSync(join(repositoryPath, '.git'));
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, userId, workspaceId);
  try {
    applyScopedMigrations(workspaceDb);
    upsertWorkspaceRepositoryResource(workspaceDb, {
      workspaceExists: (candidateWorkspaceId) => candidateWorkspaceId === workspaceId,
      workspaceId,
      displayName: 'OpenKit',
      localPath: repositoryPath,
      now: () => '2026-05-31T00:00:00.000Z',
    });
  } finally {
    workspaceDb.sqlite.close();
  }
}

/**
 * Creates one ready goal task fixture.
 *
 * @param workspaceDb Open workspace-scope database handle.
 */
function addReadyGoalTask(workspaceDb: WorkspaceDb): void {
  createGoalRecord(workspaceDb, {
    workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
    goalId: 'goal_demo',
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    title: 'Ship release',
    objective: 'Make v0.0.6 ready.',
  });
  createGoalTask(workspaceDb, {
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    goalId: 'goal_demo',
    taskId: 'task_demo',
    title: 'Run verification',
    objective: 'Run the release verification checks.',
    orderIndex: 0,
    dependsOnTaskIds: [],
    acceptanceCriteria: ['Verification checks pass.'],
    contextBudgetTokens: 12_000,
    status: 'ready',
  });
}

/**
 * Builds durable item history for delegation tests.
 *
 * @returns Thread item fixtures.
 */
function threadItems(): Item[] {
  return [
    {
      id: 'it_context',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_context',
      type: 'user-message',
      status: 'completed',
      text: 'Relevant task context.',
      createdAt: '2026-05-31T00:00:00.000Z',
      completedAt: '2026-05-31T00:00:00.000Z',
    },
    {
      id: 'it_status',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_context',
      type: 'status',
      status: 'completed',
      level: 'info',
      title: 'UI-only diagnostic',
      summary: 'This status should not be provider-visible.',
      createdAt: '2026-05-31T00:00:01.000Z',
      completedAt: '2026-05-31T00:00:01.000Z',
    },
  ];
}

describe('goal task delegation preparation', () => {
  it('prepares a structured worker delegation request for a selected goal task', () => {
    const coreDb = createCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'user_local', 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      addReadyRepository(coreDb, 'ws_demo');
      addReadyGoalTask(workspaceDb);
      const steering = enqueueSteeringForSafePoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId: 'req_steering',
        contentDigest: 'digest_steering',
        contentItemId: 'it_steering',
      });
      const followUp = enqueueFollowUpInput(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId: 'req_follow',
        contentDigest: 'digest_follow',
        contentItemId: 'it_follow',
      });

      const prepared = prepareGoalTaskDelegation(coreDb, workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        threadItems: threadItems(),
        steeringMessages: [
          {
            kind: 'safe_point_steering_message',
            owner: 'system',
            startsWorkerTurn: false,
            pendingTurn: steering,
          },
        ],
        followUpInputs: [
          {
            kind: 'queued_follow_up_input',
            owner: 'user',
            startsWorkerTurn: false,
            pendingTurn: followUp,
          },
        ],
        expectedArtifacts: [{ kind: 'test-result', description: 'Release verification output.' }],
        verification: [
          {
            kind: 'test',
            description: 'Run release verification.',
            command: 'pnpm -w verify:release',
          },
        ],
        stopConditions: ['Stop if release verification fails.'],
      });

      expect(prepared.repository.resourceId).toBe('repo_default');
      expect(prepared.contextPackageDigest).toMatch(/^ctxpkg_sha256_[a-f0-9]{64}$/);
      expect(prepared.steeringMessages.map((message) => message.pendingTurn.requestId)).toEqual([
        'req_steering',
      ]);
      expect(prepared.followUpInputs.map((message) => message.pendingTurn.requestId)).toEqual([
        'req_follow',
      ]);
      expect(prepared.delegationRequest).toMatchObject({
        objective: 'Run the release verification checks.',
        acceptanceCriteria: ['Verification checks pass.'],
        contextRefs: [
          { kind: 'workspace', id: 'ws_demo' },
          { kind: 'thread', id: 'th_demo' },
          { kind: 'item', id: 'it_context' },
          { kind: 'item', id: 'it_steering' },
          { kind: 'item', id: 'it_follow' },
        ],
        expectedArtifacts: [{ kind: 'test-result', description: 'Release verification output.' }],
        verification: [
          {
            kind: 'test',
            command: 'pnpm -w verify:release',
          },
        ],
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('uses the request user workspace database when preparing repository context', () => {
    const coreDb = createCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'user_owner', 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      addReadyRepository(coreDb, 'ws_demo', 'user_owner');
      addReadyGoalTask(workspaceDb);

      const prepared = prepareGoalTaskDelegation(coreDb, workspaceDb, {
        workspaceId: 'ws_demo',
        userId: 'user_owner',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        threadItems: threadItems(),
        steeringMessages: [],
        followUpInputs: [],
        expectedArtifacts: [],
        verification: [{ kind: 'manual', description: 'Manual verification.' }],
        stopConditions: ['Stop after manual verification.'],
      });

      expect(prepared.repository.workspaceId).toBe('ws_demo');
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('fails preparation when the workspace repository is missing', () => {
    const coreDb = createCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'user_local', 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      addReadyGoalTask(workspaceDb);

      expect(() =>
        prepareGoalTaskDelegation(coreDb, workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_demo',
          taskId: 'task_demo',
          threadItems: threadItems(),
          steeringMessages: [],
          followUpInputs: [],
          expectedArtifacts: [],
          verification: [{ kind: 'manual', description: 'Manual verification.' }],
          stopConditions: ['Stop after manual verification.'],
        })
      ).toThrow('Workspace repository not ready: ws_demo');
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });
});

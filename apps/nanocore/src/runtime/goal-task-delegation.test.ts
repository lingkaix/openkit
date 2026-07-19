import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ItemSchema } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { upsertWorkspaceRepositoryResource } from '../workspace/repository-store.js';
import {
  createGoalRecord,
  createGoalTask,
  updateGoalStatus,
  updateGoalTask,
} from './goal-store.js';
import { prepareGoalTaskDelegation } from './goal-task-delegation.js';

type Item = z.infer<typeof ItemSchema>;

const TASK_EXECUTION_CONTRACT = {
  resources: [
    {
      kind: 'repository' as const,
      reference: 'linked workspace repository',
      reason: 'The task verifies the release repository.',
    },
  ],
  expectedArtifacts: [
    { kind: 'test-result' as const, description: 'Release verification output.' },
  ],
  verificationChecks: [
    {
      kind: 'test' as const,
      description: 'Run release verification.',
      command: 'pnpm -w verify:release',
    },
  ],
  reviewPolicy: {
    required: true,
    reviewers: ['human'] as const,
    instructions: 'Review the release verification evidence.',
  },
  escalationConditions: ['Escalate if release verification cannot run.'],
};

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
 */
function addReadyRepository(coreDb: CoreDb, workspaceId: string): void {
  const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-goal-task-delegation-repo-'));
  mkdirSync(join(repositoryPath, '.git'));
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, workspaceId);
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
 * @param taskPlanItemId Immutable Plan id recorded on the Task.
 */
function addReadyGoalTask(workspaceDb: WorkspaceDb, taskPlanItemId = 'it_plan'): void {
  createGoalRecord(workspaceDb, {
    workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
    goalId: 'goal_demo',
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    title: 'Ship release',
    objective: 'Make v0.0.6 ready.',
  });
  updateGoalStatus(workspaceDb, {
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    goalId: 'goal_demo',
    status: 'running',
    planItemId: 'it_plan',
  });
  createGoalTask(workspaceDb, {
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    goalId: 'goal_demo',
    taskId: 'task_demo',
    title: 'Run verification',
    objective: 'Run the release verification checks.',
    planItemId: taskPlanItemId,
    orderIndex: 0,
    dependsOnTaskIds: [],
    acceptanceCriteria: ['Verification checks pass.'],
    contextBudgetTokens: 12_000,
    ...TASK_EXECUTION_CONTRACT,
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
      actor: { kind: 'user', id: 'user_local' },
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
  it('prepares authorized delegation facts for a selected goal task', () => {
    const coreDb = createCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      addReadyRepository(coreDb, 'ws_demo');
      addReadyGoalTask(workspaceDb);

      const prepared = prepareGoalTaskDelegation(coreDb, workspaceDb, {
        store: createDemoStore(),
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        threadItems: threadItems(),
      });

      expect(prepared.repository.resourceId).toBe('repo_default');
      expect(prepared.contextPackageDigest).toMatch(/^ctxpkg_sha256_[a-f0-9]{64}$/);
      expect(prepared).toMatchObject({
        objective: 'Run the release verification checks.',
        contextRefs: [{ kind: 'item', id: 'it_context' }],
      });
      expect(prepared.workerRequestDetails).toEqual({
        acceptanceCriteria: ['Verification checks pass.'],
        resources: TASK_EXECUTION_CONTRACT.resources,
        expectedArtifacts: [{ kind: 'test-result', description: 'Release verification output.' }],
        constraints: {
          maxContextTokens: 12_000,
          maxWorkerIterations: 1,
        },
        verification: [
          {
            kind: 'test',
            description: 'Run release verification.',
            command: 'pnpm -w verify:release',
          },
        ],
        reviewPolicy: TASK_EXECUTION_CONTRACT.reviewPolicy,
        escalationConditions: TASK_EXECUTION_CONTRACT.escalationConditions,
        reviewContext: null,
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('uses the request user workspace database when preparing repository context', () => {
    const coreDb = createCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      addReadyRepository(coreDb, 'ws_demo');
      addReadyGoalTask(workspaceDb);

      const prepared = prepareGoalTaskDelegation(coreDb, workspaceDb, {
        store: createDemoStore(),
        workspaceId: 'ws_demo',
        userId: 'user_owner',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        threadItems: threadItems(),
      });

      expect(prepared.repository.workspaceId).toBe('ws_demo');
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('fails preparation when the workspace repository is missing', () => {
    const coreDb = createCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      addReadyGoalTask(workspaceDb);

      expect(() =>
        prepareGoalTaskDelegation(coreDb, workspaceDb, {
          store: createDemoStore(),
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_demo',
          taskId: 'task_demo',
          threadItems: threadItems(),
        })
      ).toThrow('Workspace repository not ready: ws_demo');
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('rejects a Task whose immutable Plan lineage differs from its Goal', () => {
    const coreDb = createCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      addReadyGoalTask(workspaceDb, 'it_other_plan');

      expect(() =>
        prepareGoalTaskDelegation(coreDb, workspaceDb, {
          store: createDemoStore(),
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_demo',
          taskId: 'task_demo',
          threadItems: threadItems(),
        })
      ).toThrow('Goal task Plan lineage does not match the Goal.');
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('rejects ambiguous matching Human Gate request Items', () => {
    const coreDb = createCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      addReadyRepository(coreDb, 'ws_demo');
      addReadyGoalTask(workspaceDb);
      updateGoalTask(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        latestGateContextItemId: 'it_gate_response',
      });
      const gateRequest = {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'tu_gate',
        type: 'user-input-request' as const,
        status: 'completed' as const,
        responsibleUserId: 'user_local',
        userInputRequestId: 'ui_gate',
        prompt: 'Choose a path.',
        questions: [
          {
            id: 'path',
            header: 'Path',
            question: 'Which path should the worker use?',
            options: null,
            isOther: true,
            isSecret: false,
          },
        ],
        createdAt: '2026-05-31T00:00:02.000Z',
        completedAt: '2026-05-31T00:00:02.000Z',
      };
      const items: Item[] = [
        ...threadItems(),
        { id: 'it_gate_request_one', ...gateRequest },
        { id: 'it_gate_request_two', ...gateRequest },
        {
          id: 'it_gate_response',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'tu_gate',
          type: 'user-input-response',
          status: 'completed',
          actor: { kind: 'user', id: 'user_local' },
          causationId: 'it_gate_request_one',
          userInputRequestId: 'ui_gate',
          answers: { path: ['Use path A'] },
          createdAt: '2026-05-31T00:00:03.000Z',
          completedAt: '2026-05-31T00:00:03.000Z',
        },
      ];

      expect(() =>
        prepareGoalTaskDelegation(coreDb, workspaceDb, {
          store: createDemoStore(),
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_demo',
          taskId: 'task_demo',
          threadItems: items,
        })
      ).toThrow('Latest Goal Task Human Gate context is incomplete or contradictory.');
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });
});

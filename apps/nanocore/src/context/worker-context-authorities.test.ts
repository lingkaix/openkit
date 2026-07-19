import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createGoalRecord,
  createGoalTask,
  updateGoalStatus,
  updateGoalTask,
} from '../runtime/goal-store.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { createWorkerContextPackageAuthorityReader } from './worker-context-authorities.js';

describe('worker Context Package authority reader', () => {
  it('rejects a Workspace database outside the product store lineage', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-context-authority-lineage-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_other');

    try {
      expect(() =>
        createWorkerContextPackageAuthorityReader({ coreDb, store, workspaceDb })
      ).toThrow('Worker Context Package authority owners have different scopes.');
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('returns immutable Goal Task, exact Gate pair, and Turn session lineage', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-context-authorities-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
    applyScopedMigrations(workspaceDb);
    const gateTurn = store.createTurn(
      'ws_demo',
      'th_demo',
      'Answer a worker question',
      { kind: 'user', id: 'user_local' },
      null,
      {
        turnId: 'tu_gate',
      }
    );
    const request = store.createItem({
      id: 'it_gate_request',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: gateTurn.id,
      type: 'user-input-request',
      status: 'completed',
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
      createdAt: '2026-07-18T00:00:00.000Z',
      completedAt: '2026-07-18T00:00:00.000Z',
    });
    const response = store.createItem({
      id: 'it_gate_response',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: gateTurn.id,
      type: 'user-input-response',
      status: 'completed',
      actor: { kind: 'user', id: 'user_local' },
      causationId: request.id,
      userInputRequestId: 'ui_gate',
      answers: { path: ['Use path A'] },
      createdAt: '2026-07-18T00:00:01.000Z',
      completedAt: '2026-07-18T00:00:01.000Z',
    });
    createGoalRecord(workspaceDb, {
      workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      goalId: 'goal_demo',
      title: 'Ship release',
      objective: 'Ship the release.',
    });
    updateGoalStatus(workspaceDb, {
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      goalId: 'goal_demo',
      status: 'running',
      planItemId: 'it_plan',
      currentTaskId: 'task_demo',
    });
    createGoalTask(workspaceDb, {
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      goalId: 'goal_demo',
      taskId: 'task_demo',
      planItemId: 'it_plan',
      title: 'Run verification',
      objective: 'Run verification.',
      orderIndex: 0,
      dependsOnTaskIds: [],
      acceptanceCriteria: ['Checks pass.'],
      contextBudgetTokens: 1_000,
      resources: [],
      expectedArtifacts: [],
      verificationChecks: [
        { kind: 'test', description: 'Run verification.', command: 'pnpm test' },
      ],
      reviewPolicy: {
        required: true,
        reviewers: ['human'],
        instructions: 'Review the verification evidence.',
      },
      escalationConditions: [],
      status: 'running',
    });
    updateGoalTask(workspaceDb, {
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      goalId: 'goal_demo',
      taskId: 'task_demo',
      latestGateContextItemId: response.id,
    });
    const workerTurn = store.createTurn(
      'ws_demo',
      'th_demo',
      'Run worker',
      { kind: 'user', id: 'user_local' },
      null,
      {
        turnId: 'tu_worker',
      }
    );
    const session = store.createAgentSession({
      id: 'ags_worker',
      agentId: 'agent_codex_host',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      status: 'busy',
      message: null,
      createdAt: workerTurn.startedAt!,
      updatedAt: workerTurn.startedAt!,
    });
    store.updateTurn(workerTurn.id, { agentSessionId: session.id });
    const reader = createWorkerContextPackageAuthorityReader({ coreDb, store, workspaceDb });

    try {
      expect(reader.readGoalTask('ws_demo', 'th_demo', 'goal_demo', 'task_demo')).toMatchObject({
        gateContextItemIds: [request.id, response.id],
        goal: { goalId: 'goal_demo' },
        task: { taskId: 'task_demo' },
      });
      expect(reader.readTurn('ws_demo', 'th_demo', workerTurn.id)).toMatchObject({
        agentSessionId: session.id,
      });

      updateGoalStatus(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        status: 'running',
        currentTaskId: null,
      });
      expect(reader.readGoalTask('ws_demo', 'th_demo', 'goal_demo', 'task_demo')).toMatchObject({
        gateContextItemIds: [request.id, response.id],
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });
});

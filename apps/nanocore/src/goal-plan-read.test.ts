import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { ensureLocalUser } from './auth/identity.js';
import { createDeterministicGoalPlanFallback } from './runtime/goal-plan.js';
import { createGoalPlanRecord, createGoalRecord, updateGoalStatus } from './runtime/goal-store.js';
import { type CoreDb, openCoreDb, openWorkspaceDb } from './storage/db.js';
import { LOCAL_USER_ID } from './storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { createInitialGoalIntentItem } from './test-support/goal-intent.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

function createCoreDb(): CoreDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-goal-plan-read-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: LOCAL_USER_ID,
    workspaceId: 'ws_demo',
  });
  return coreDb;
}

describe('GET current Goal plan', () => {
  it('reads a retained Plan without writes and fails closed on contradictory Plan bytes', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const thread = store.createThread('ws_demo', 'Retained Goal plan', undefined, 'conversation', {
      visibility: 'workspace',
    });
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    applyScopedMigrations(workspaceDb);
    const app = createApp({ coreDb, store });

    try {
      const intentItemId = createInitialGoalIntentItem({
        store,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        objective: 'Read a retained Plan.',
        userId: 'user_local',
      });
      const goal = createGoalRecord(workspaceDb, {
        goalId: 'goal_retained_plan',
        createdByItemId: intentItemId,
        objective: 'Read a retained Plan.',
        status: 'planning',
        threadId: thread.id,
        title: 'Retained Plan',
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        workspaceId: 'ws_demo',
      });
      const plan = createDeterministicGoalPlanFallback({
        goalTitle: goal.title,
        objective: goal.objective,
      });
      const planTurn = store.createTurn('ws_demo', thread.id, 'Record retained Plan', {
        kind: 'user',
        id: 'user_local',
      });
      const planAt = planTurn.startedAt ?? new Date().toISOString();
      store.createItem({
        id: 'it_retained_plan',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        turnId: planTurn.id,
        type: 'plan',
        status: 'completed',
        title: goal.title,
        summary: plan.goalSummary,
        steps: plan.tasks.map((task) => ({
          id: task.taskId,
          title: task.title,
          status: 'pending',
        })),
        createdAt: planAt,
        completedAt: planAt,
      });
      store.updateTurn(planTurn.id, { status: 'completed', completedAt: planAt });
      createGoalPlanRecord(workspaceDb, {
        createdByRequestId: 'goal-retained-plan',
        goalId: goal.goalId,
        predecessorPlanItemId: null,
        sourceIntentItemId: intentItemId,
        sourceTaskEvidenceDigest: null,
        plan,
        planItemId: 'it_retained_plan',
        threadId: thread.id,
        workspaceId: 'ws_demo',
      });
      updateGoalStatus(workspaceDb, {
        goalId: goal.goalId,
        pendingPlanItemId: 'it_retained_plan',
        status: 'awaiting_plan_approval',
        threadId: thread.id,
        workspaceId: 'ws_demo',
      });
      const itemCount = store.listThreadItems('ws_demo', thread.id).length;
      const turnCount = store.listThreadTurns('ws_demo', thread.id).length;
      const recordCommand = vi.spyOn(store, 'recordCommandRequest');
      const route = `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan`;
      const response = await app.request(route);
      expect(response.status, await response.clone().text()).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        goal: { goalId: goal.goalId, status: 'awaiting_plan_approval' },
        pendingPlanItemId: 'it_retained_plan',
        pendingPlan: plan,
        canRunStep: false,
        planningAction: 'await_approval',
      });
      expect(store.listThreadItems('ws_demo', thread.id)).toHaveLength(itemCount);
      expect(store.listThreadTurns('ws_demo', thread.id)).toHaveLength(turnCount);
      expect(recordCommand).not.toHaveBeenCalled();

      workspaceDb.sqlite
        .prepare('UPDATE goal_plan_records SET plan_json = ? WHERE plan_item_id = ?')
        .run('{not-json', 'it_retained_plan');
      const malformed = await app.request(route);
      expect(malformed.status).toBe(409);
      const error = await malformed.json();
      expect(error).toMatchObject({ code: 'recovery_required' });
      expect(JSON.stringify(error)).not.toMatch(/sqlite|plan_json|Unexpected token/i);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('matches Goal summary authorization for missing and foreign Threads', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const foreignWorkspace = store.createWorkspace('Foreign Goal Workspace');
    const foreignThread = store.createThread(foreignWorkspace.id, 'Foreign Goal Thread');
    const app = createApp({ coreDb, store });

    try {
      const missingSummary = await app.request(
        '/api/app/workspaces/ws_demo/threads/th_missing/goal'
      );
      const missingPlan = await app.request(
        '/api/app/workspaces/ws_demo/threads/th_missing/goal/plan'
      );
      expect(missingPlan.status).toBe(missingSummary.status);
      expect(await missingPlan.json()).toMatchObject(await missingSummary.json());

      const foreignSummary = await app.request(
        `/api/app/workspaces/ws_demo/threads/${foreignThread.id}/goal`
      );
      const foreignPlan = await app.request(
        `/api/app/workspaces/ws_demo/threads/${foreignThread.id}/goal/plan`
      );
      expect(foreignPlan.status).toBe(foreignSummary.status);
      expect(await foreignPlan.json()).toMatchObject(await foreignSummary.json());

      const emptyThread = store.createThread(
        'ws_demo',
        'No goal thread',
        undefined,
        'conversation',
        {
          visibility: 'workspace',
        }
      );
      const emptyRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${emptyThread.id}/goal/plan`
      );
      expect(emptyRes.status).toBe(200);
      await expect(emptyRes.json()).resolves.toEqual({
        goal: null,
        activePlanItemId: null,
        activePlan: null,
        pendingPlanItemId: null,
        pendingPlan: null,
        pendingPlanItemSummary: null,
        selectableAffectedTasks: [],
        canRunStep: false,
        canApprovePendingPlan: false,
        planningAction: 'none',
        draftRevision: null,
        continuePlanning: null,
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('selects the active Goal when an older terminal is updated later', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const thread = store.createThread(
      'ws_demo',
      'Active over terminal',
      undefined,
      'conversation',
      {
        visibility: 'workspace',
      }
    );
    const app = createApp({ coreDb, store });
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    applyScopedMigrations(workspaceDb);

    try {
      const activeIntentItemId = createInitialGoalIntentItem({
        store,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        objective: 'Remain the current active Goal.',
        userId: 'user_local',
      });
      const active = createGoalRecord(workspaceDb, {
        goalId: 'goal_active_current',
        createdByItemId: activeIntentItemId,
        objective: 'Remain the current active Goal.',
        status: 'planning',
        threadId: thread.id,
        title: 'Active goal',
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        workspaceId: 'ws_demo',
        now: () => '2026-01-01T00:00:00.000Z',
      });
      const terminalIntentItemId = createInitialGoalIntentItem({
        store,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        objective: 'Completed Goal updated later must not win.',
        userId: 'user_local',
      });
      const terminal = createGoalRecord(workspaceDb, {
        goalId: 'goal_old_terminal',
        createdByItemId: terminalIntentItemId,
        objective: 'Completed Goal updated later must not win.',
        status: 'completed',
        threadId: thread.id,
        title: 'Terminal goal',
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        workspaceId: 'ws_demo',
        now: () => '2026-01-02T00:00:00.000Z',
      });
      createGoalPlanRecord(workspaceDb, {
        createdByRequestId: 'goal-plan-terminal',
        goalId: terminal.goalId,
        predecessorPlanItemId: null,
        sourceIntentItemId: terminalIntentItemId,
        sourceTaskEvidenceDigest: null,
        plan: createDeterministicGoalPlanFallback({
          goalTitle: terminal.title,
          objective: terminal.objective,
        }),
        planItemId: 'it_plan_terminal',
        threadId: thread.id,
        workspaceId: 'ws_demo',
      });
      updateGoalStatus(workspaceDb, {
        goalId: terminal.goalId,
        planItemId: 'it_plan_terminal',
        status: 'completed',
        threadId: thread.id,
        workspaceId: 'ws_demo',
        now: () => '2026-01-03T00:00:00.000Z',
      });

      const summaryRes = await app.request(`/api/app/workspaces/ws_demo/threads/${thread.id}/goal`);
      const planRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan`
      );
      expect(summaryRes.status).toBe(200);
      expect(planRes.status, await planRes.clone().text()).toBe(200);
      await expect(summaryRes.json()).resolves.toMatchObject({
        goal: { goalId: active.goalId, status: 'planning' },
      });
      await expect(planRes.json()).resolves.toMatchObject({
        goal: { goalId: active.goalId, status: 'planning' },
        activePlanItemId: null,
        activePlan: null,
        pendingPlanItemId: null,
        pendingPlan: null,
        canRunStep: false,
        planningAction: 'create',
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('returns 503 when Goal storage is unavailable', async () => {
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'No storage thread', undefined, 'conversation', {
      visibility: 'workspace',
    });
    const app = createApp({ store });

    const response = await app.request(
      `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan`
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: 'goal_storage_unavailable',
    });
  });

  it('hides a private Thread owned by another actor', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const privateThread = store.createThread(
      'ws_demo',
      'Other actor private thread',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: 'user_other' }
    );
    const app = createApp({ coreDb, store });

    try {
      const summaryRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${privateThread.id}/goal`
      );
      const planRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${privateThread.id}/goal/plan`
      );
      expect(planRes.status).toBe(summaryRes.status);
      expect(planRes.status).toBe(404);
      const planBody = (await planRes.json()) as { code: string; message: string };
      expect(planBody.code).toBe('not_found');
      expect(JSON.stringify(planBody)).not.toMatch(/sqlite|user_other|privateOwner/i);
      await expect(summaryRes.json()).resolves.toMatchObject({ code: 'not_found' });
    } finally {
      coreDb.sqlite.close();
    }
  });
});

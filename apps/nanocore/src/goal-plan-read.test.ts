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
  it('reads the current Goal Plan without writes and keeps latest Goal scope', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const thread = store.createThread('ws_demo', 'Current plan thread', undefined, 'conversation', {
      visibility: 'workspace',
    });
    const otherThread = store.createThread(
      'ws_demo',
      'Older-plan thread',
      undefined,
      'conversation',
      { visibility: 'workspace' }
    );
    const app = createApp({ coreDb, store });
    const recordCommand = vi.spyOn(store, 'recordCommandRequest');

    try {
      const startRes = await app.request(`/api/app/workspaces/ws_demo/threads/${thread.id}/goal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: 'goal-plan-read-start',
          objective: 'Restore the current Goal Plan read.',
          title: 'Current plan read',
        }),
      });
      expect(startRes.status).toBe(200);

      const planningRead = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan`
      );
      expect(planningRead.status).toBe(200);
      await expect(planningRead.json()).resolves.toMatchObject({
        goal: { status: 'planning' },
        planItemId: null,
        plan: null,
      });

      const planRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: 'goal-plan-read-create' }),
        }
      );
      expect(planRes.status).toBe(200);
      const created = (await planRes.json()) as {
        goal: { goalId: string; status: string };
        planItemId: string;
        plan: { tasks: readonly [{ taskId: string }] };
      };
      expect(created.goal.status).toBe('awaiting_plan_approval');

      const writeCount = recordCommand.mock.calls.length;
      const itemCount = store.listThreadItems('ws_demo', thread.id).length;
      const turnCount = store.listThreadTurns('ws_demo', thread.id).length;

      const currentRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan`
      );
      expect(currentRes.status).toBe(200);
      const current = (await currentRes.json()) as {
        goal: { goalId: string; status: string };
        planItemId: string;
        plan: { tasks: readonly [{ taskId: string }]; schemaVersion: number };
        planner?: unknown;
        status?: unknown;
      };
      expect(current).not.toHaveProperty('planner');
      expect(current).not.toHaveProperty('status');
      expect(current).toMatchObject({
        goal: { goalId: created.goal.goalId, status: 'awaiting_plan_approval' },
        planItemId: created.planItemId,
        plan: created.plan,
      });
      expect(recordCommand.mock.calls).toHaveLength(writeCount);
      expect(store.listThreadItems('ws_demo', thread.id)).toHaveLength(itemCount);
      expect(store.listThreadTurns('ws_demo', thread.id)).toHaveLength(turnCount);

      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
      applyScopedMigrations(workspaceDb);
      try {
        const older = createGoalRecord(workspaceDb, {
          goalId: 'goal_older_plan',
          objective: 'Keep this historical Plan off the current read.',
          status: 'awaiting_plan_approval',
          threadId: otherThread.id,
          title: 'Older plan',
          workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
          workspaceId: 'ws_demo',
          now: () => '2026-01-01T00:00:00.000Z',
        });
        createGoalPlanRecord(workspaceDb, {
          createdByRequestId: 'goal-plan-older',
          goalId: older.goalId,
          plan: createDeterministicGoalPlanFallback({
            goalTitle: older.title,
            objective: older.objective,
          }),
          planItemId: 'it_plan_older',
          threadId: otherThread.id,
          workspaceId: 'ws_demo',
        });
        updateGoalStatus(workspaceDb, {
          goalId: older.goalId,
          planItemId: 'it_plan_older',
          status: 'awaiting_plan_approval',
          threadId: otherThread.id,
          workspaceId: 'ws_demo',
          now: () => '2026-01-01T00:00:00.000Z',
        });
        createGoalRecord(workspaceDb, {
          goalId: 'goal_newer_planning',
          objective: 'Current Goal has no Plan pointer.',
          status: 'planning',
          threadId: otherThread.id,
          title: 'Newer goal',
          workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
          workspaceId: 'ws_demo',
          now: () => '2026-01-02T00:00:00.000Z',
        });

        const latestRes = await app.request(
          `/api/app/workspaces/ws_demo/threads/${otherThread.id}/goal/plan`
        );
        expect(latestRes.status).toBe(200);
        await expect(latestRes.json()).resolves.toMatchObject({
          goal: { goalId: 'goal_newer_planning', status: 'planning' },
          planItemId: null,
          plan: null,
        });

        workspaceDb.sqlite
          .prepare('DELETE FROM goal_plan_records WHERE plan_item_id = ?')
          .run(created.planItemId);
        const missingRecordRes = await app.request(
          `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan`
        );
        expect(missingRecordRes.status).toBe(409);
        await expect(missingRecordRes.json()).resolves.toMatchObject({
          code: 'recovery_required',
        });
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      recordCommand.mockRestore();
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
        planItemId: null,
        plan: null,
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
      const active = createGoalRecord(workspaceDb, {
        goalId: 'goal_active_current',
        objective: 'Remain the current active Goal.',
        status: 'planning',
        threadId: thread.id,
        title: 'Active goal',
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        workspaceId: 'ws_demo',
        now: () => '2026-01-01T00:00:00.000Z',
      });
      const terminal = createGoalRecord(workspaceDb, {
        goalId: 'goal_old_terminal',
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
      expect(planRes.status).toBe(200);
      await expect(summaryRes.json()).resolves.toMatchObject({
        goal: { goalId: active.goalId, status: 'planning' },
      });
      await expect(planRes.json()).resolves.toMatchObject({
        goal: { goalId: active.goalId, status: 'planning' },
        planItemId: null,
        plan: null,
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

  it('returns 409 for a malformed Plan record without leaking storage detail', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const thread = store.createThread(
      'ws_demo',
      'Malformed plan thread',
      undefined,
      'conversation',
      {
        visibility: 'workspace',
      }
    );
    const app = createApp({ coreDb, store });

    try {
      const startRes = await app.request(`/api/app/workspaces/ws_demo/threads/${thread.id}/goal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: 'goal-plan-malformed-start',
          objective: 'Keep malformed Plan reads closed.',
          title: 'Malformed plan',
        }),
      });
      expect(startRes.status).toBe(200);
      const planRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: 'goal-plan-malformed-create' }),
        }
      );
      expect(planRes.status).toBe(200);
      const created = (await planRes.json()) as { planItemId: string };

      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
      applyScopedMigrations(workspaceDb);
      try {
        workspaceDb.sqlite
          .prepare('UPDATE goal_plan_records SET plan_json = ? WHERE plan_item_id = ?')
          .run('{not-json', created.planItemId);
      } finally {
        workspaceDb.sqlite.close();
      }

      const readRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan`
      );
      expect(readRes.status).toBe(409);
      const body = (await readRes.json()) as { code: string; message: string };
      expect(body).toMatchObject({
        code: 'recovery_required',
        message: 'Current Goal Plan record is contradictory.',
      });
      expect(JSON.stringify(body)).not.toMatch(
        /digest|sqlite|plan_json|Unexpected token|invalid_type/i
      );
    } finally {
      coreDb.sqlite.close();
    }
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

  it('does not regenerate the deterministic draft after a recorded pre-approval revision', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const thread = store.createThread(
      'ws_demo',
      'Revision route thread',
      undefined,
      'conversation',
      {
        visibility: 'workspace',
      }
    );
    const app = createApp({ coreDb, store });

    try {
      const startRes = await app.request(`/api/app/workspaces/ws_demo/threads/${thread.id}/goal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: 'goal-plan-revise-route-start',
          objective: 'Make v0.0.6 ready to publish.',
          title: 'Ship v0.0.6',
        }),
      });
      expect(startRes.status).toBe(200);

      const createRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: 'goal-plan-revise-route-create' }),
        }
      );
      expect(createRes.status).toBe(200);
      const created = (await createRes.json()) as {
        planItemId: string;
        plan: { tasks: readonly unknown[] };
      };
      expect(created.plan.tasks).toHaveLength(1);

      const reviseRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan/revise`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: 'goal-plan-revise-route-revise',
            revision: 'Split this into two bounded worker tasks.',
          }),
        }
      );
      expect(reviseRes.status).toBe(200);

      const retryRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: 'goal-plan-revise-route-retry' }),
        }
      );
      expect(retryRes.status).not.toBe(200);
      const retryBody = (await retryRes.json()) as { code?: string; plan?: { tasks: unknown[] } };
      expect(retryBody.plan).toBeUndefined();
      expect(retryBody.code).toBe('goal_plan_revision_unavailable');

      const currentRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan`
      );
      expect(currentRes.status).toBe(200);
      await expect(currentRes.json()).resolves.toMatchObject({
        goal: { status: 'awaiting_plan_approval' },
        planItemId: created.planItemId,
        plan: { tasks: created.plan.tasks },
      });
    } finally {
      coreDb.sqlite.close();
    }
  });
});
